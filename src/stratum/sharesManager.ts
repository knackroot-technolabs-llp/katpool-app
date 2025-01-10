import type { Socket } from 'bun';
import { calculateTarget } from "../../wasm/kaspa";
import { Pushgateway } from 'prom-client';
import { type Worker } from './server';
import type { RegistryContentType } from 'prom-client';
import { stringifyHashrate, getAverageHashrateGHs } from './utils';
import Monitoring from '../monitoring';
import { DEBUG } from '../../index';
import {
  minerHashRateGauge,
  poolHashRateGauge,
  minerAddedShares,
  minerIsBlockShare,
  minerInvalidShares,
  minerStaleShares,
  minerDuplicatedShares,
  varDiff,
  workerHashRateGauge,
  activeMinerGuage
} from '../prometheus';
import { metrics } from '../../index';
// Fix the import statement
import Denque from 'denque';
import { Encoding } from './templates/jobs/encoding';
import config from '../../config/config.json'

export interface WorkerStats {
  blocksFound: number;
  sharesFound: number;
  sharesDiff: number;
  staleShares: number;
  invalidShares: number;
  workerName: string;
  startTime: number;
  lastShare: number;
  varDiffStartTime: number;
  varDiffSharesFound: number;
  varDiffWindow: number;
  minDiff: number;
  recentShares: Denque<{ timestamp: number, difficulty: number}>;
  hashrate: number; // Added hashrate property
  asicType: string;
}

type MinerData = {
  sockets: Set<Socket<any>>,
  workerStats: Map<string, WorkerStats>
};

const varDiffThreadSleep: number = 10
const zeroDateMillS: number = new Date(0).getMilliseconds()

type Contribution = {
  address: string;
  difficulty: number;
  timestamp: number;
  minerId: string;
};

export class SharesManager {
  private contributions: Map<bigint, Contribution> = new Map();
  private miners: Map<string, MinerData> = new Map();
  private poolAddress: string;
  private pushGateway: Pushgateway<RegistryContentType>;
  private monitoring: Monitoring;
  private shareWindow: Denque<Contribution>;
  private lastAllocationTime: number;

  constructor(poolAddress: string, pushGatewayUrl: string) {
    this.poolAddress = poolAddress;
    this.monitoring = new Monitoring();
    this.pushGateway = new Pushgateway<RegistryContentType>(pushGatewayUrl);
    this.startStatsThread(); // Start the stats logging thread
    this.shareWindow = new Denque();
    this.lastAllocationTime = Date.now();
  }

  getOrCreateWorkerStats(workerName: string, minerData: MinerData): WorkerStats {
    if (!minerData.workerStats.has(workerName)) {
      const workerStats: WorkerStats = {
        blocksFound: 0,
        sharesFound: 0,
        sharesDiff: 0,
        staleShares: 0,
        invalidShares: 0,
        workerName,
        startTime: Date.now(),
        lastShare: Date.now(),
        varDiffStartTime: Date.now(),
        varDiffSharesFound: 0,
        varDiffWindow: 0,
        minDiff: 128, // Initial difficulty
        recentShares: new Denque<{ timestamp: number, difficulty: number, workerName: string }>(),
        hashrate: 0,
        asicType: "",
      };
      minerData.workerStats.set(workerName, workerStats);
      if (DEBUG) this.monitoring.debug(`SharesManager: Created new worker stats for ${workerName}`);
    }
    return minerData.workerStats.get(workerName)!;
  }

  async addShare(minerId: string, address: string, hash: string, difficulty: number, nonce: bigint, templates: any, encoding: Encoding) {
    // Critical Section: Check and Add Share
    if (this.contributions.has(nonce)) {
      metrics.updateGaugeInc(minerDuplicatedShares, [minerId, address]);
      console.log('Duplicate share for miner : ', minerId);
      return;
    } else {
      this.contributions.set(nonce, { address, difficulty, timestamp: Date.now(), minerId });
    }

    const timestamp = Date.now();
    let minerData = this.miners.get(address);
    if (!minerData) {
      minerData = {
        sockets: new Set(),
        workerStats: new Map()
      };
      this.miners.set(address, minerData);
    }
    
    const workerStats = this.getOrCreateWorkerStats(minerId, minerData);
    const currentDifficulty = workerStats.minDiff || difficulty;

    if (DEBUG) this.monitoring.debug(`SharesManager: Share added for ${minerId} - Address: ${address} - Nonce: ${nonce}`);

    const state = templates.getPoW(hash);
    if (!state) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Stale header for miner ${minerId} and hash: ${hash}`);
      metrics.updateGaugeInc(minerStaleShares, [minerId, address]);
      workerStats.staleShares++; // Add this to track stale shares in worker stats
      return;
    }

    const [isBlock, target] = state.checkWork(nonce);
    const validity = target <= calculateTarget(currentDifficulty);
    if (!validity) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Invalid share for target: ${target} for miner ${minerId}`);
      metrics.updateGaugeInc(minerInvalidShares, [minerId, address]);
      workerStats.invalidShares++;
      return;
    }

    // Share is valid at this point, increment the valid share metric
    metrics.updateGaugeInc(minerAddedShares, [minerId, address]);

    if (isBlock) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Work found for ${minerId} and target: ${target}`);
      metrics.updateGaugeInc(minerIsBlockShare, [minerId, address]);
      const report = await templates.submit(minerId, hash, nonce);
      if (report === "success") workerStats.blocksFound++;
    }

    if (DEBUG) this.monitoring.debug(`SharesManager: Contributed block share added from: ${minerId} with address ${address} for nonce: ${nonce}`);

    const share = { minerId, address, difficulty, timestamp: Date.now() };
    this.shareWindow.push(share);

    workerStats.sharesFound++;
    workerStats.varDiffSharesFound++;
    workerStats.lastShare = timestamp;
    workerStats.minDiff = currentDifficulty;

    // Update recentShares with the new share
    workerStats.recentShares.push({ timestamp: Date.now(), difficulty: currentDifficulty});

    const windowSize = 10 * 60 * 1000; // 10 minutes window
    while (workerStats.recentShares.length > 0 && Date.now() - workerStats.recentShares.peekFront()!.timestamp > windowSize) {
      workerStats.recentShares.shift();
    }
  }

  startStatsThread() {
    const start = Date.now();

    setInterval(() => {
      let str = "\n===============================================================================\n";
      str += "  worker name   |  avg hashrate  |   acc/stl/inv  |    blocks    |    uptime   \n";
      str += "-------------------------------------------------------------------------------\n";
      const lines: string[] = [];
      let totalRate = 0;

      this.miners.forEach((minerData, address) => {
        let rate = 0;
        minerData.workerStats.forEach((stats, workerName) => {
          const workerRate = getAverageHashrateGHs(stats);
          rate += workerRate;
          metrics.updateGaugeValue(workerHashRateGauge, [workerName, address], workerRate);
          totalRate += rate;
          const rateStr = stringifyHashrate(workerRate);
          const ratioStr = `${stats.sharesFound}/${stats.staleShares}/${stats.invalidShares}`;
          lines.push(
            ` ${stats.workerName.padEnd(15)}| ${rateStr.padEnd(14)} | ${ratioStr.padEnd(14)} | ${stats.blocksFound.toString().padEnd(12)} | ${(Date.now() - stats.startTime) / 1000}s`
          );

          // Update worker's hashrate in workerStats
          stats.hashrate = workerRate;
          const status = Date.now() - 600000 >= stats.lastShare ? Math.floor(stats.lastShare / 1000) : 0; // Submission within last 10 minutes                 
          metrics.updateGaugeValue(activeMinerGuage, [workerName, address, stats.asicType], status);
        });
        metrics.updateGaugeValue(minerHashRateGauge, [address], rate);
      });

      lines.sort();
      str += lines.join("\n");
      const rateStr = stringifyHashrate(totalRate);
      metrics.updateGaugeValue(poolHashRateGauge, ['pool', this.poolAddress], totalRate);
      if (DEBUG) {
        this.monitoring.debug(`SharesManager: Total pool hash rate updated to ${rateStr}`);
      }

      const overallStats = Array.from(this.miners.values()).reduce((acc: any, minerData: MinerData) => {
        minerData.workerStats.forEach((stats) => {
          acc.sharesFound += stats.sharesFound;
          acc.staleShares += stats.staleShares;
          acc.invalidShares += stats.invalidShares;
        });
        return acc;
      }, { sharesFound: 0, staleShares: 0, invalidShares: 0 });

      const ratioStr = `${overallStats.sharesFound}/${overallStats.staleShares}/${overallStats.invalidShares}`;
      str += "\n-------------------------------------------------------------------------------\n";
      str += `                | ${rateStr.padEnd(14)} | ${ratioStr.padEnd(14)} | ${Array.from(this.miners.values()).reduce((acc, minerData) => {
        let total = 0;
        minerData.workerStats.forEach(stats => total += stats.blocksFound);
        return acc + total;
      }, 0).toString().padEnd(12)} | ${(Date.now() - start) / 1000}s`;
      str += "\n===============================================================================\n";
      console.log(str);
    }, 600000); // 10 minutes
  }

  getMiners() {
    return this.miners;
  }

  private getRecentContributions(windowMillis: number): Contribution[] {
    const now = Date.now();
    return Array.from(this.contributions.values()).filter(contribution => {
      return now - contribution.timestamp <= windowMillis;
    });
  }

  // Updated dumpContributions method
  dumpContributions(windowMillis: number = 10000): Contribution[] {
    const contributions = this.getRecentContributions(windowMillis);
    if (DEBUG) this.monitoring.debug(`SharesManager: Amount of contributions within the last ${windowMillis}ms: ${contributions.length}`);
    this.contributions.clear();
    return contributions;
  }

  resetContributions() {
    this.contributions.clear();
  }

  updateSocketDifficulty(address: string, workerName: string, newDifficulty: number) {
    const minerData = this.miners.get(address);
    if (minerData) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Updating difficulty for worker ${workerName} to ${newDifficulty}`);
      minerData.sockets.forEach(socket => {
        if (socket.data.workers.has(workerName)) {
          const oldDiff = socket.data.difficulty;
          socket.data.difficulty = newDifficulty;
          if (DEBUG) this.monitoring.debug(`SharesManager: Socket difficulty updated for worker ${workerName} from ${oldDiff} to ${newDifficulty}`);
        }
      });
    } else {
      if (DEBUG) this.monitoring.debug(`SharesManager: No miner data found for address ${address} when updating difficulty`);
    }
  }

  getSharesSinceLastAllocation(): Contribution[] {
    const currentTime = Date.now();
    const shares = [];
    while (this.shareWindow.length > 0 && (this.shareWindow.peekFront()?.timestamp ?? 0) >= this.lastAllocationTime) {
      shares.push(this.shareWindow.shift()!);
    }
    this.monitoring.debug(`SharesManager: Retrieved ${shares.length} shares. Last allocation time: ${this.lastAllocationTime}, Current time: ${currentTime}`);
    this.lastAllocationTime = currentTime;
    return shares;
  }

  async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  startVardiffThread(expectedShareRate: number, clamp: boolean): void {
    var windows: number[] = [1, 3, 10, 30, 60, 240, 0];
    var tolerances: number[] = [1, 0.5, 0.25, 0.15, 0.1, 0.1, 0.1];

    setInterval(async () => {
      await this.sleep(varDiffThreadSleep * 1000);

      var stats: string = "\n=== vardiff ===================================================================\n\n";
      stats += "  worker name  |    diff     |  window  |  elapsed   |    shares   |   rate    \n";
      stats += "-------------------------------------------------------------------------------\n";

      var statsLines: string[] = [];
      var toleranceErrs: string[] = [];

      for (const [address, minerData] of this.miners) {
        if (!minerData || !minerData.workerStats) {
          if (DEBUG) this.monitoring.debug(`SharesManager: Invalid miner data for address ${address}`);
          continue;
        }

        for (const [workerName, workerStats] of minerData.workerStats) {
          if (!workerStats) {
            if (DEBUG) this.monitoring.debug(`SharesManager: Invalid worker stats for worker ${workerName}`);
            continue;
          }

          if (workerStats.varDiffStartTime == zeroDateMillS) {
            toleranceErrs = toleranceErrs.concat(toleranceErrs, `no diff sent to client ${workerName}`);
            continue;
          }

          var diff: number = workerStats.minDiff;
          var shares: number = workerStats.varDiffSharesFound;
          var duration: number = (Date.now() - workerStats.varDiffStartTime) / 60000;
          var shareRate: number = shares / duration;
          var shareRateRatio: number = shareRate / expectedShareRate;
          var windowIndex: number = workerStats.varDiffWindow % windows.length;
          var window: number = windows[windowIndex];
          var tolerance: number = tolerances[windowIndex]; 

          statsLines = statsLines.concat(
            ` ${workerName.padEnd(14)}| ${diff.toFixed(2).padStart(11)} | ${window.toString().padStart(8)} | ${duration.toFixed(2).padStart(10)} | ${shares.toString().padStart(11)} | ${shareRate.toFixed(2).padStart(9)}\n`
          );

          // check final stage first, as this is where majority of time spent
          if (window == 0) {
            if (Math.abs(1 - shareRateRatio) >= tolerance) {
              toleranceErrs = toleranceErrs.concat(toleranceErrs, `${workerName} final share rate ${shareRate} exceeded tolerance (+/- ${tolerance * 100}%)`);
              this.updateVarDiff(workerStats, diff * shareRateRatio, clamp);
            }
            continue;
          }

          // check all previously cleared windows
          var i: number = 1;
          for (; i < workerStats.varDiffWindow;) {
            if (Math.abs(1 - shareRateRatio) >= tolerances[i]) {
              toleranceErrs = toleranceErrs.concat(toleranceErrs, `${workerName} share rate ${shareRate} exceeded tolerance (+/- ${tolerances[i] * 100}%) for ${windows[i]}m window`);
              this.updateVarDiff(workerStats, diff * shareRateRatio, clamp);
              break;
            }
            i++;
          }
          if (i < workerStats.varDiffWindow) {
            continue;
          }

          // check for current window max exception
          if (shares >= window * expectedShareRate * (1 + tolerance)) {
            toleranceErrs = toleranceErrs.concat(toleranceErrs, `${workerName} share rate ${shareRate} exceeded upper tolerance (+/- ${tolerances[i] * 100}%) for ${windows[i]}m window`);
            this.updateVarDiff(workerStats, diff * shareRateRatio, clamp);
            continue;
          }

          // check whether we've exceeded window length
          if (duration >= window) {
            // check for current window min exception
            if (shares <= window * expectedShareRate * (1 - tolerance)) {
              toleranceErrs = toleranceErrs.concat(toleranceErrs, `${workerName} share rate ${shareRate} exceeded lower tolerance (+/- ${tolerances[i] * 100}%) for ${windows[i]}m window`);
              this.updateVarDiff(workerStats, diff * Math.max(shareRateRatio, 0.1), clamp);
              continue;
            }
            workerStats.varDiffWindow++;
          }
        }
      }

      statsLines.sort();
      stats += statsLines + "\n";
      stats += `\n\n===============================================================================\n`;
      stats += `\n${toleranceErrs}\n\n\n`;
      if (DEBUG) {
        this.monitoring.debug(stats);
      }
    }, varDiffThreadSleep * 1000);
  }

  // (re)start vardiff tracker
  startVarDiff(stats: WorkerStats) {
    if (stats.varDiffStartTime  == zeroDateMillS) {
      stats.varDiffSharesFound = 0
      stats.varDiffStartTime = Date.now()
    }
  }

  // update vardiff with new mindiff, reset counters, and disable tracker until
  // client handler restarts it while sending diff on next block
  updateVarDiff(stats : WorkerStats, minDiff: number, clamp: boolean): number {
    if (clamp) {
      minDiff = Math.pow(2, Math.floor(Math.log2(minDiff)))
    }

    var previousMinDiff = stats.minDiff
    var newMinDiff = Math.max(config.stratum.minDiff, Math.min(config.stratum.maxDiff, minDiff))
    if (newMinDiff != previousMinDiff) {
      this.monitoring.log(`updating vardiff to ${newMinDiff} for client ${stats.workerName}`)
      stats.varDiffStartTime = zeroDateMillS
      stats.varDiffWindow = 0
      stats.minDiff = newMinDiff
      varDiff.labels(stats.workerName).set(stats.minDiff);
    }
    return previousMinDiff
  }

  startClientVardiff(worker: Worker) {
    const stats = this.getOrCreateWorkerStats(worker.name, this.miners.get(worker.address)!);
    this.startVarDiff(stats)
  }

  getClientVardiff(worker: Worker): number {
    const minerData = this.miners.get(worker.address);
    if (!minerData) {
      if (DEBUG) this.monitoring.debug(`SharesManager: No miner data found for address ${worker.address}, returning default difficulty`);
      return 128; // Return default difficulty if no miner data exists
    }
    const stats = this.getOrCreateWorkerStats(worker.name, minerData);
    return stats.minDiff;
  }
}