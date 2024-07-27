import type { Socket } from 'bun';
import { calculateTarget } from "../../wasm/kaspa";
import { Pushgateway, Gauge } from 'prom-client';
import type { RegistryContentType } from 'prom-client';
import { stringifyHashrate, getAverageHashrateGHs } from './utils'; // Import the helper functions

type MinerData = {
  sockets: Set<Socket<any>>,
  shares: number,
  hashRate: number,
  lastShareTime: number,
  difficulty: number,
  firstShareTime: number,
  accumulatedWork: number,
  workerStats: Map<string, WorkerStats> // Add worker stats to MinerData
};

export interface WorkerStats { // Add export here
  sharesFound: number;
  staleShares: number;
  invalidShares: number;
  workerName: string;
  startTime: number;
  lastShare: number;
  varDiffSharesFound: number;
  minDiff: number;
}

type Contribution = {
  address: string;
  difficulty: number;
  timestamp: number;
  minerId: string;
};

export const sharesGauge = new Gauge({
  name: 'shares',
  help: 'Total number of shares',
  labelNames: ['pool_address'],
});

export class SharesManager {
  private contributions: Map<bigint, Contribution> = new Map();
  private miners: Map<string, MinerData> = new Map();
  private minerHashRateGauge: Gauge<string>;
  private poolHashRateGauge: Gauge<string>;
  private poolAddress: string;
  private pushGateway: Pushgateway<RegistryContentType>;

  constructor(poolAddress: string, pushGatewayUrl: string) {
    this.poolAddress = poolAddress;

    this.minerHashRateGauge = new Gauge({
      name: 'miner_hash_rate',
      help: 'Hash rate of individual miners',
      labelNames: ['wallet_address'],
    });

    this.poolHashRateGauge = new Gauge({
      name: 'pool_hash_rate',
      help: 'Overall hash rate of the pool',
      labelNames: ['pool_address'],
    });

    this.pushGateway = new Pushgateway<RegistryContentType>(pushGatewayUrl);
    this.startHashRateLogging(60000);
    this.startStatsThread(); // Start the stats logging thread
  }

  // Add a method to create or get existing worker stats
  getOrCreateWorkerStats(workerName: string, minerData: MinerData): WorkerStats {
    let workerStats = minerData.workerStats.get(workerName);
    if (!workerStats) {
      workerStats = {
        sharesFound: 0,
        staleShares: 0,
        invalidShares: 0,
        workerName,
        startTime: Date.now(),
        lastShare: Date.now(),
        varDiffSharesFound: 0,
        minDiff: minerData.difficulty
      };
      minerData.workerStats.set(workerName, workerStats);
      console.log(`[${new Date().toISOString()}] SharesManager: Created new worker stats for ${workerName}`);
    }
    return workerStats;
  }

  async pushMetrics() {
    try {
      await this.pushGateway.pushAdd({ jobName: 'mining_metrics' });
      console.log(`[${new Date().toISOString()}] SharesManager: Metrics pushed to Pushgateway`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] SharesManager: ERROR: Error pushing metrics to Pushgateway:`, err);
    }
  }

  startHashRateLogging(interval: number) {
    setInterval(() => {
      this.calcHashRates();
      this.pushMetrics();
    }, interval);
  }

  async addShare(minerId: string, address: string, hash: string, difficulty: number, nonce: bigint, templates: any) {
    sharesGauge.labels(address).inc();
    const timestamp = Date.now();
    if (this.contributions.has(nonce)) throw Error('Duplicate share');
    const state = templates.getPoW(hash);
    if (!state) throw Error('Stale header');
    const [isBlock, target] = state.checkWork(nonce);
    if (isBlock) await templates.submit(hash, nonce);
    const validity = target <= calculateTarget(difficulty);
    if (!validity) throw Error('Invalid share');
    this.contributions.set(nonce, { address, difficulty, timestamp, minerId });

    let minerData = this.miners.get(address);
    if (!minerData) {
      minerData = {
        sockets: new Set(),
        shares: 0,
        hashRate: 0,
        lastShareTime: timestamp,
        difficulty,
        firstShareTime: timestamp,
        accumulatedWork: 0,
        workerStats: new Map()
      };
      this.miners.set(address, minerData);
    }

    // Retain the first share time
    if (!this.miners.has(address)) {
      minerData.firstShareTime = timestamp;
    }

    minerData.accumulatedWork += difficulty;
    minerData.shares++;
    minerData.lastShareTime = timestamp;
    minerData.difficulty = difficulty;
    this.miners.set(address, minerData);

    // Update worker stats
    const workerStats = this.getOrCreateWorkerStats(minerId, minerData);
    workerStats.sharesFound++;
    workerStats.varDiffSharesFound++;
    workerStats.lastShare = timestamp;

    console.log(`[${new Date().toISOString()}] SharesManager: Share added for ${minerId} - Address: ${address}`);
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
        minerData.workerStats.forEach((stats, workerName) => {
          const rate = getAverageHashrateGHs(stats);
          totalRate += rate;
          const rateStr = stringifyHashrate(rate);
          const ratioStr = `${stats.sharesFound}/${stats.staleShares}/${stats.invalidShares}`;
          lines.push(
            ` ${workerName.padEnd(15)}| ${rateStr.padEnd(14)} | ${ratioStr.padEnd(14)} | ${minerData.shares.toString().padEnd(12)} | ${(Date.now() - stats.startTime) / 1000}s`
          );
        });
      });

      lines.sort();
      str += lines.join("\n");
      const rateStr = stringifyHashrate(totalRate);
      const overallStats = Array.from(this.miners.values()).reduce((acc, minerData) => {
        minerData.workerStats.forEach(stats => {
          acc.sharesFound += stats.sharesFound;
          acc.staleShares += stats.staleShares;
          acc.invalidShares += stats.invalidShares;
        });
        return acc;
      }, { sharesFound: 0, staleShares: 0, invalidShares: 0 });
      const ratioStr = `${overallStats.sharesFound}/${overallStats.staleShares}/${overallStats.invalidShares}`;
      str += "\n-------------------------------------------------------------------------------\n";
      str += `                | ${rateStr.padEnd(14)} | ${ratioStr.padEnd(14)} | ${Array.from(this.miners.values()).reduce((acc, minerData) => acc + minerData.shares, 0).toString().padEnd(12)} | ${(Date.now() - start) / 1000}s`;
      str += "\n==========================================================\n";
      console.log(str);
    }, 600000); // 10 minutes
  }

  calcHashRates() {
    let totalHashRate = 0;
    this.miners.forEach((minerData, address) => {
      const timeDifference = (Date.now() - minerData.firstShareTime) / 1000; // Convert to seconds
      let minerHashRate = 0;
      minerData.workerStats.forEach((stats, workerName) => {
        const workerTimeDifference = (Date.now() - stats.startTime) / 1000; // Convert to seconds
        const workerHashRate = (stats.minDiff * stats.varDiffSharesFound) / workerTimeDifference;
        minerHashRate += workerHashRate;
        console.log(`[${new Date().toISOString()}] SharesManager: Worker ${workerName} stats - Time: ${workerTimeDifference}s, HashRate: ${workerHashRate}H/s, SharesFound: ${stats.sharesFound}, StaleShares: ${stats.staleShares}, InvalidShares: ${stats.invalidShares}`);
      });
      this.minerHashRateGauge.labels(address).set(minerHashRate);
      totalHashRate += minerHashRate;
      console.log(`[${new Date().toISOString()}] SharesManager: Miner ${address} hash rate updated to ${minerHashRate}H/s`);
    });
    this.poolHashRateGauge.labels(this.poolAddress).set(totalHashRate);
    console.log(`[${new Date().toISOString()}] SharesManager: Total pool hash rate updated to ${totalHashRate}H/s`);
  }

  getMiners() {
    return this.miners;
  }

  resetContributions() {
    this.contributions.clear();
  }

  dumpContributions() {
    const contributions = Array.from(this.contributions.values());
    this.contributions.clear();
    return contributions;
  }
}
