import type { Socket } from 'bun';
import { calculateTarget } from "../../wasm/kaspa";
import { Pushgateway } from 'prom-client';
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
  varDiff
} from '../prometheus';
import { metrics } from '../../index';
// Fix the import statement
import Denque from 'denque';
import { Encoding } from './templates/jobs/encoding';

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
  recentShares: Denque<{ timestamp: number, difficulty: number }>;
  hashrate: number; // Added hashrate property
}

type MinerData = {
  sockets: Set<Socket<any>>,
  workerStats: WorkerStats
};

const varDiffThreadSleep: number = 10

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
    this.startHashRateLogging(60000);
    this.startStatsThread(); // Start the stats logging thread
    this.shareWindow = new Denque();
    this.lastAllocationTime = Date.now();
  }

  getOrCreateWorkerStats(workerName: string, minerData: MinerData): WorkerStats {
    let workerStats = minerData.workerStats;
    if (!workerStats) {
      workerStats = {
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
        minDiff: 1, // Set to initial difficulty
        recentShares: new Denque<{ timestamp: number, difficulty: number }>(), // Initialize denque correctly
        hashrate: 0 // Initialize hashrate property
      };
      minerData.workerStats = workerStats;
      if (DEBUG) this.monitoring.debug(`SharesManager: Created new worker stats for ${workerName}`);
    }
    return workerStats;
  }

  startHashRateLogging(interval: number) {
    setInterval(() => {
      this.calcHashRates();
    }, interval);
  }

  async addShare(minerId: string, address: string, hash: string, difficulty: number, nonce: bigint, templates: any, encoding: Encoding) {
    // Critical Section: Check and Add Share
    if (this.contributions.has(nonce)) {
      metrics.updateGaugeInc(minerDuplicatedShares, [minerId, address]);
      // throw Error('Duplicate share');
      console.log('Duplicate share for miner : ', minerId);
      return
    } else {
      this.contributions.set(nonce, { address, difficulty, timestamp: Date.now(), minerId });
    }

    const timestamp = Date.now();
    let minerData = this.miners.get(address);
    const currentDifficulty = minerData ? minerData.workerStats.minDiff : difficulty;

    metrics.updateGaugeInc(minerAddedShares, [minerId, address]);

    if (DEBUG) this.monitoring.debug(`SharesManager: Share added for ${minerId} - Address: ${address} - Nonce: ${nonce} - Hash: ${hash}`);

    // Initial setup for a new miner
    if (!minerData) {
      minerData = {
        sockets: new Set(),
        workerStats: {
          blocksFound: 0,
          sharesFound: 0,
          sharesDiff: 0,
          staleShares: 0,
          invalidShares: 0,
          workerName: minerId,
          startTime: Date.now(),
          lastShare: Date.now(),
          varDiffStartTime: Date.now(),
          varDiffSharesFound: 0,
          varDiffWindow: 0,
          minDiff: currentDifficulty,
          recentShares: new Denque<{ timestamp: number, difficulty: number }>(), // Initialize recentShares
          hashrate: 0 // Initialize hashrate property
        }
      };
      this.miners.set(address, minerData);
    } else {
      // // Atomically update worker stats
      // minerData.workerStats.sharesFound++;
      // minerData.workerStats.varDiffSharesFound++;
      // minerData.workerStats.lastShare = timestamp;
      // minerData.workerStats.minDiff = currentDifficulty;

      // // Update recentShares with the new share
      // minerData.workerStats.recentShares.push({ timestamp: Date.now(), difficulty: currentDifficulty });

      // const windowSize = 10 * 60 * 1000; // 10 minutes window
      // while (minerData.workerStats.recentShares.length > 0 && Date.now() - minerData.workerStats.recentShares.peekFront()!.timestamp > windowSize) {
      //   minerData.workerStats.recentShares.shift();
      // }
    }

    const state = templates.getPoW(hash);
    if (!state) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Stale header for miner ${minerId} and hash: ${hash}`);
      metrics.updateGaugeInc(minerStaleShares, [minerId, address]);
      // throw Error('Stale header');
      return
    }

    const [isBlock, target] = state.checkWork(nonce);
    if (isBlock) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Work found for ${minerId} and target: ${target}`);
      metrics.updateGaugeInc(minerIsBlockShare, [minerId, address]);
      const report = await templates.submit(minerId, hash, nonce);
      if (report) minerData.workerStats.blocksFound++;
    }

    const validity = target <= calculateTarget(currentDifficulty);
    if (!validity) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Invalid share for target: ${target} for miner ${minerId}`);
      metrics.updateGaugeInc(minerInvalidShares, [minerId, address]);
      // throw Error('Invalid share');
      minerData.workerStats.invalidShares++
      return
    }

    if (DEBUG) this.monitoring.debug(`SharesManager: Contributed block added from: ${minerId} with address ${address} for nonce: ${nonce}`);

    const share = { minerId, address, difficulty, timestamp: Date.now() };
    this.shareWindow.push(share);

    minerData.workerStats.sharesFound++;
    minerData.workerStats.varDiffSharesFound++;
    minerData.workerStats.lastShare = timestamp;
    minerData.workerStats.minDiff = currentDifficulty;
    if (encoding === Encoding.Bitmain) {
      minerData.workerStats.minDiff = 4096
    }

    // Update recentShares with the new share
    minerData.workerStats.recentShares.push({ timestamp: Date.now(), difficulty: currentDifficulty });

    const windowSize = 10 * 60 * 1000; // 10 minutes window
    while (minerData.workerStats.recentShares.length > 0 && Date.now() - minerData.workerStats.recentShares.peekFront()!.timestamp > windowSize) {
      minerData.workerStats.recentShares.shift();
    }
    // Implement variable difficulty
    this.updateDifficulty(minerId);
  }

  private updateDifficulty(minerId: string): void {
    const workerStats = this.miners.get(minerId)?.workerStats;
    if (!workerStats) return;

    const now = Date.now();
    const elapsedMs = now - workerStats.varDiffStartTime;

    if (elapsedMs >= 120000) { // 120000ms = 2 minutes
      const shareRate = workerStats.varDiffSharesFound / (elapsedMs / 1000);
      const targetShareRate = 60 / 60; // 60 shares per minute

      let newDifficulty = workerStats.minDiff;

      if (shareRate > targetShareRate * 1.1) {
        newDifficulty *= 1.1;
      } else if (shareRate < targetShareRate * 0.9) {
        newDifficulty /= 1.1;
      }

      newDifficulty = Math.max(newDifficulty, 1);

      if (newDifficulty !== workerStats.minDiff) {
        workerStats.minDiff = newDifficulty;
        this.monitoring.log(`SharesManager: Updated difficulty for ${minerId} to ${newDifficulty}`);
        varDiff.labels(minerId).set(newDifficulty);
      }

      workerStats.varDiffStartTime = now;
      workerStats.varDiffSharesFound = 0;
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
        const stats = minerData.workerStats;
        const rate = getAverageHashrateGHs(stats);
        totalRate += rate;
        const rateStr = stringifyHashrate(rate);
        const ratioStr = `${stats.sharesFound}/${stats.staleShares}/${stats.invalidShares}`;
        lines.push(
          ` ${stats.workerName.padEnd(15)}| ${rateStr.padEnd(14)} | ${ratioStr.padEnd(14)} | ${stats.blocksFound.toString().padEnd(12)} | ${(Date.now() - stats.startTime) / 1000}s`
        );
      });

      lines.sort();
      str += lines.join("\n");
      const rateStr = stringifyHashrate(totalRate);
      const overallStats = Array.from(this.miners.values()).reduce((acc: any, minerData: MinerData) => {
        const stats = minerData.workerStats;
        acc.sharesFound += stats.sharesFound;
        acc.staleShares += stats.staleShares;
        acc.invalidShares += stats.invalidShares;
        return acc;
      }, { sharesFound: 0, staleShares: 0, invalidShares: 0 });
      const ratioStr = `${overallStats.sharesFound}/${overallStats.staleShares}/${overallStats.invalidShares}`;
      str += "\n-------------------------------------------------------------------------------\n";
      str += `                | ${rateStr.padEnd(14)} | ${ratioStr.padEnd(14)} | ${Array.from(this.miners.values()).reduce((acc, minerData) => acc + minerData.workerStats.blocksFound, 0).toString().padEnd(12)} | ${(Date.now() - start) / 1000}s`;
      str += "\n===============================================================================\n";
      console.log(str);
    }, 600000); // 10 minutes
  }

  calcHashRates() {
    let totalHashRate = 0;
    const baseWindowSize = 10 * 60 * 1000; // 10 minutes base window
    const now = Date.now();

    this.miners.forEach((minerData, address) => {
      try {
        const workerStats = minerData.workerStats;
        const recentShares = workerStats.recentShares.toArray();
        
        if (recentShares.length === 0) return;

        // Adjust the window size dynamically based on miner's activity
        const oldestShareTime = recentShares[0].timestamp;
        const windowSize = Math.min(baseWindowSize, now - oldestShareTime);

        // Filter relevant shares
        const relevantShares = recentShares.filter(share => now - share.timestamp <= windowSize);

        if (relevantShares.length === 0) return;

        // Calculate weighted average difficulty
        let totalWeightedDifficulty = 0;
        let totalWeight = 0;
        relevantShares.forEach((share, index) => {
          const age = (now - share.timestamp) / windowSize;
          const weight = Math.exp(-5 * age); // Exponential decay
          totalWeightedDifficulty += share.difficulty * weight;
          totalWeight += weight;
        });

        const avgDifficulty = totalWeightedDifficulty / totalWeight;
        const timeDifference = (now - relevantShares[relevantShares.length - 1].timestamp) / 1000; // in seconds

        const workerHashRate = (avgDifficulty * relevantShares.length) / timeDifference;
        
        metrics.updateGaugeValue(minerHashRateGauge, [workerStats.workerName, address], workerHashRate);
        totalHashRate += workerHashRate;

        // Update worker's hashrate in workerStats
        workerStats.hashrate = workerHashRate;
      } catch (error) {
        this.monitoring.error(`Error calculating hashrate for miner ${address}: ${error}`);
      }
    });

    metrics.updateGaugeValue(poolHashRateGauge, ['pool', this.poolAddress], totalHashRate);
    if (DEBUG) {
      this.monitoring.debug(`SharesManager: Total pool hash rate updated to ${totalHashRate.toFixed(6)} GH/s`);
    }
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

  startVardiffThread(sharesPerMin: number, varDiffStats: boolean, clampPow2: boolean) {
    const intervalMs = 120000; // Run every 2 minutes
    const minElapsedSeconds = 30; // Minimum 30 seconds between adjustments
    const adjustmentFactor = 1.1; // 10% adjustment
    const minDifficulty = 1; // Minimum difficulty

    setInterval(() => {
      const now = Date.now();

      this.miners.forEach((minerData, address) => {
        const stats = minerData.workerStats;
        const elapsedSeconds = (now - stats.varDiffStartTime) / 1000;
        if (elapsedSeconds < minElapsedSeconds) return;

        const sharesFound = stats.varDiffSharesFound;
        const shareRate = (sharesFound / elapsedSeconds) * 60; // Convert to per minute
        const targetRate = sharesPerMin;

        if (DEBUG) this.monitoring.debug(`SharesManager - VarDiff for ${stats.workerName}: sharesFound: ${sharesFound}, elapsedSeconds: ${elapsedSeconds}, shareRate: ${shareRate}, targetRate: ${targetRate}, currentDiff: ${stats.minDiff}`);

        let newDiff = stats.minDiff;

        if (shareRate > targetRate * 1.2) {
          newDiff = stats.minDiff * adjustmentFactor;
        } else if (shareRate < targetRate * 0.8) {
          newDiff = stats.minDiff / adjustmentFactor;
        }

        if (clampPow2) {
          newDiff = Math.pow(2, Math.round(Math.log2(newDiff)));
        }

        newDiff = Math.max(newDiff, minDifficulty);

        if (newDiff !== stats.minDiff) {
          this.monitoring.debug(`SharesManager: VarDiff - Adjusting difficulty for ${stats.workerName} from ${stats.minDiff} to ${newDiff}`);
          stats.minDiff = newDiff;
          this.updateSocketDifficulty(address, newDiff);
        } else {
          this.monitoring.debug(`SharesManager: VarDiff - No change in difficulty for ${stats.workerName} (current difficulty: ${stats.minDiff})`);
        }

        stats.varDiffSharesFound = 0;
        stats.varDiffStartTime = now;

        if (varDiffStats) {
          this.monitoring.log(`SharesManager: VarDiff for ${stats.workerName}: sharesFound: ${sharesFound}, elapsed: ${elapsedSeconds.toFixed(2)}, shareRate: ${shareRate.toFixed(2)}, newDiff: ${stats.minDiff}`);
        }
      });
    }, intervalMs);
  }

  updateSocketDifficulty(address: string, newDifficulty: number) {
    const minerData = this.miners.get(address);
    if (minerData) {
      minerData.sockets.forEach(socket => {
        socket.data.difficulty = newDifficulty;
      });
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

  startVardiffThreadGo(expectedShareRate: number, logStats: boolean, clamp: boolean): void {
    // 20 shares/min allows a ~99% confidence assumption of:
    //   < 100% variation after 1m
    //   < 50% variation after 3m
    //   < 25% variation after 10m
    //   < 15% variation after 30m
    //   < 10% variation after 1h
    //   < 5% variation after 4h
    var windows: number[] = [1, 3, 10, 30, 60, 240, 0]
    var tolerances: number[] = [1, 0.5, 0.25, 0.15, 0.1, 0.05, 0.05]
  
    setInterval(async () => {
      await this.sleep(varDiffThreadSleep * 1000);
  
      // don't like locking entire stats struct - risk should be negligible
      // if mutex is ultimately needed, should move to one per client
      // sh.statsLock.Lock()
  
      var stats: string = "\n=== vardiff ===================================================================\n\n"
      stats += "  worker name  |    diff     |  window  |  elapsed   |    shares   |   rate    \n"
      stats += "-------------------------------------------------------------------------------\n"
  
      var statsLines: string[] = []
      var toleranceErrs: string[] = []
  
      for (const [address, minerData] of this.miners) {
        const workerStats = minerData.workerStats;
        var worker: string = workerStats.workerName
        if (workerStats.varDiffStartTime == 0) {
          // no vardiff sent to client
          toleranceErrs = toleranceErrs.concat(toleranceErrs, `no diff sent to client ${worker}`)
          continue
        }
  
        var diff : number = workerStats.minDiff
        var shares: number = workerStats.varDiffSharesFound
        var duration: number = (Date.now() - workerStats.varDiffStartTime) / 60000
        var shareRate: number = shares / duration
        var shareRateRatio: number = shareRate / expectedShareRate
        var window: number = windows[workerStats.varDiffWindow]
        var tolerance: number = tolerances[workerStats.varDiffWindow]
  
        statsLines = statsLines.concat(statsLines, ` ${worker.padEnd(14)}| ${diff.toFixed(2).padStart(11)} | ${window.toString().padStart(8)} | ${duration.toFixed(2).padStart(10)} | ${shares.toString().padStart(11)} | ${shareRate.toFixed(2).padStart(9)}`)
  
        // check final stage first, as this is where majority of time spent
        if (window == 0) {
          if (Math.abs(1-shareRateRatio) >= tolerance) {
            // final stage submission rate OOB
            toleranceErrs = toleranceErrs.concat(toleranceErrs, `${worker} final share rate ${shareRate} exceeded tolerance (+/- ${tolerance*100}%%)`)
            this.updateVarDiff(workerStats, diff*shareRateRatio, clamp)
            this.updateSocketDifficulty(address, diff*shareRateRatio)
          }
          continue
        }
  
        // check all previously cleared windows
        var i: number = 1
        for (; i < workerStats.varDiffWindow; ) {
          if (Math.abs(1-shareRateRatio) >= tolerances[i]) {
            // breached tolerance of previously cleared window
            toleranceErrs = toleranceErrs.concat(toleranceErrs, `${worker} share rate ${shareRate} exceeded tolerance (+/- ${tolerances[i]*100}%%) for ${windows[i]}m window`)
            this.updateVarDiff(workerStats, diff*shareRateRatio, clamp)
            this.updateSocketDifficulty(address, diff*shareRateRatio)
            break
          }
          i++
        }
        if (i < workerStats.varDiffWindow) {
          // should only happen if we broke previous loop
          continue
        }
  
        // check for current window max exception
        if (shares >= window*expectedShareRate*(1+tolerance)) {
          // submission rate > window max
          toleranceErrs = toleranceErrs.concat(toleranceErrs, `${worker} share rate ${shareRate} exceeded upper tolerance (+/- ${tolerances[i]*100}%%) for ${windows[i]}m window`)
          this.updateVarDiff(workerStats, diff*shareRateRatio, clamp)
          this.updateSocketDifficulty(address, diff*shareRateRatio)
          continue
        }
  
        // check whether we've exceeded window length
        if (duration >= window) {
          // check for current window min exception
          if (shares <= window * expectedShareRate * (1-tolerance)) {
            // submission rate < window min
            toleranceErrs = toleranceErrs.concat(toleranceErrs, `${worker} share rate ${shareRate} exceeded lower tolerance (+/- ${tolerances[i]*100}%%) for ${windows[i]}m window`)
            this.updateVarDiff(workerStats, diff * Math.max(shareRateRatio, 0.1), clamp)
            this.updateSocketDifficulty(address, diff * Math.max(shareRateRatio, 0.1))
            continue
          }
  
          workerStats.varDiffWindow++
        }
      }

      statsLines.sort()
      stats += statsLines + "\n"
      stats += `\n\n========================================================== katpool_app ===\n`
      stats += `\n${toleranceErrs}\n\n\n`
      if (logStats) {
        this.monitoring.log(stats)
      }
  
      // sh.statsLock.Unlock()
    }, varDiffThreadSleep * 1000);
  }

  // (re)start vardiff tracker
  startVarDiff(stats: WorkerStats) {
  	if (stats.varDiffStartTime == 0) {
  		stats.varDiffSharesFound = 0
  		stats.varDiffStartTime = Date.now()
  	}
  }

  // update vardiff with new mindiff, reset counters, and disable tracker until
  // client handler restarts it while sending diff on next block
  updateVarDiff(stats : WorkerStats, minDiff: number, clamp: boolean) : number{
    if (clamp) {
      minDiff = Math.pow(2, Math.floor(Math.log2(minDiff)))
    }

    const now = Date.now();
    
    var previousMinDiff = stats.minDiff
    var newMinDiff = Math.max(0.125, minDiff)
    if (newMinDiff != previousMinDiff) {
      this.monitoring.log(`updating vardiff to ${newMinDiff} for client ${stats.workerName}`)
      stats.varDiffWindow = 0
      stats.varDiffStartTime = now
      stats.minDiff = newMinDiff
    }
    return previousMinDiff
  }

  setClientVardiff(minDiff: number): number[] {    
    // only called for initial diff setting, and clamping is handled during
    // config load
    var previousMinDiffArr: number[] = []
    for (const [address, minerData] of this.miners) {
      const stats = minerData.workerStats;
      var previousMinDiff = this.updateVarDiff(stats, minDiff, false)
      this.updateSocketDifficulty(address, minDiff)
      this.startVarDiff(stats)
      previousMinDiffArr.push(previousMinDiff)
    }
    return previousMinDiffArr
  }

  startClientVardiff() {
  	for (const [address, minerData] of this.miners) {
      const stats = minerData.workerStats;
  	  this.startVarDiff(stats)
    }
  }
  
  getClientVardiff() : number[] {
  	var minDiffArr: number[] = []
    for (const [address, minerData] of this.miners) {
      const stats = minerData.workerStats;
      minDiffArr.push(stats.minDiff)
    }
  	return minDiffArr
  }
}




