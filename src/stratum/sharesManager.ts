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

  async addShare(minerId: string, address: string, hash: string, difficulty: number, nonce: bigint, templates: any) {
    // Critical Section: Check and Add Share
    if (this.contributions.has(nonce)) {
      metrics.updateGaugeInc(minerDuplicatedShares, [minerId, address]);
      throw Error('Duplicate share');
    } else {
      this.contributions.set(nonce, { address, difficulty, timestamp: Date.now(), minerId });
    }

    const timestamp = Date.now();
    let minerData = this.miners.get(address);
    const currentDifficulty = difficulty;

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
      // Atomically update worker stats
      minerData.workerStats.sharesFound++;
      minerData.workerStats.varDiffSharesFound++;
      minerData.workerStats.lastShare = timestamp;
      minerData.workerStats.minDiff = currentDifficulty;

      // Update recentShares with the new share
      minerData.workerStats.recentShares.push({ timestamp: Date.now(), difficulty: currentDifficulty });

      const windowSize = 10 * 60 * 1000; // 10 minutes window
      while (minerData.workerStats.recentShares.length > 0 && Date.now() - minerData.workerStats.recentShares.peekFront()!.timestamp > windowSize) {
        minerData.workerStats.recentShares.shift();
      }
    }

    const state = templates.getPoW(hash);
    if (!state) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Stale header for miner ${minerId} and hash: ${hash}`);
      metrics.updateGaugeInc(minerStaleShares, [minerId, address]);
      throw Error('Stale header');
    }

    const [isBlock, target] = state.checkWork(nonce);
    if (isBlock) {
      this.monitoring.debug(`SharesManager: Work found for ${minerId} and target: ${target}`);
      metrics.updateGaugeInc(minerIsBlockShare, [minerId, address]);
      const report = await templates.submit(minerId, hash, nonce);
      if (report) minerData.workerStats.blocksFound++;
    }

    const validity = target <= calculateTarget(currentDifficulty);
    if (!validity) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Invalid share for target: ${target} for miner ${minerId}`);
      metrics.updateGaugeInc(minerInvalidShares, [minerId, address]);
      // throw Error('Invalid share');
      return
    }

    this.monitoring.debug(`SharesManager: Contributed block added from: ${minerId} with address ${address} for nonce: ${nonce}`);

    const share = { minerId, address, difficulty, timestamp: Date.now() };
    this.shareWindow.push(share);

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
}