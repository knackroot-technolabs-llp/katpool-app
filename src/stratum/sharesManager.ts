import type { Socket } from 'bun';
import { calculateTarget } from "../../wasm/kaspa";
import { Pushgateway, Gauge } from 'prom-client';
import type { RegistryContentType } from 'prom-client';
import { stringifyHashrate, getAverageHashrateGHs } from './utils';
import Monitoring from '../pool/monitoring'
import { DEBUG } from '../../index'
import { minerHashRateGauge, poolHashRateGauge , minerAddedShares, minerIsBlockShare, minerInvalidShares, minerStaleShares, minerDuplicatedShares } from '../prometheus'

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

  constructor(poolAddress: string, pushGatewayUrl: string) {
    this.poolAddress = poolAddress;
    this.monitoring = new Monitoring();
    this.pushGateway = new Pushgateway<RegistryContentType>(pushGatewayUrl);
    this.startHashRateLogging(60000);
    this.startStatsThread(); // Start the stats logging thread
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
        minDiff: 1 // Set to initial difficulty
      };
      minerData.workerStats = workerStats;
      if (DEBUG) this.monitoring.debug(`SharesManager: Created new worker stats for ${workerName}`);
    }
    return workerStats;
  }

  async pushMetrics() {
    try {
      await this.pushGateway.pushAdd({ jobName: 'mining_metrics' });
      this.monitoring.log(`SharesManager: Metrics pushed to Pushgateway`);
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
    minerAddedShares.labels(minerId, address).inc();
    if (DEBUG) this.monitoring.debug(`SharesManager: Share added for ${minerId} - Address: ${address} - once: ${nonce} - hash: ${hash}`)
    const timestamp = Date.now();
    let report
    let minerData = this.miners.get(address);
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
          minDiff: difficulty
        }
      };
      this.miners.set(address, minerData);
    }    
    minerData.workerStats.sharesFound++;
    minerData.workerStats.varDiffSharesFound++;
    minerData.workerStats.lastShare = timestamp;
    minerData.workerStats.minDiff = difficulty;


    if (this.contributions.has(nonce)){
      minerDuplicatedShares.labels(minerId, address).inc();
      throw Error('Duplicate share');
    }
    const state = templates.getPoW(hash);
    if (!state){
      if (DEBUG) this.monitoring.debug(`SharesManager: Stale header for miner ${minerId} and hash: ${hash}`);
      minerStaleShares.labels(minerId, address).inc();
      throw Error('Stale header');
    }
    const [isBlock, target] = state.checkWork(nonce);
    if (isBlock) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Work found for ${minerId} and target: ${target}`);
      minerIsBlockShare.labels(minerId, address).inc();
      report = await templates.submit(minerId, hash, nonce);
    }  
    const validity = target <= calculateTarget(difficulty);
    
    if (!validity){
      if (DEBUG) this.monitoring.debug(`SharesManager: Invalid share for target: ${target} for miner ${minerId}`);
      minerInvalidShares.labels(minerId, address).inc();
      throw Error('Invalid share');
    } 

    this.contributions.set(nonce, { address, difficulty, timestamp, minerId });
    if (DEBUG) this.monitoring.debug(`SharesManager: Contributed block added from: ${minerId} with address ${address} for nonce: ${nonce}`);

    if (report) minerData.workerStats.blocksFound++;

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
      const overallStats = Array.from(this.miners.values()).reduce((acc, minerData) => {
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
    this.miners.forEach((minerData, address) => {
      const timeDifference = (Date.now() - minerData.workerStats.startTime) / 1000; // Convert to seconds
      const workerStats = minerData.workerStats;
      const workerHashRate = (workerStats.minDiff * workerStats.varDiffSharesFound) / timeDifference;
      minerHashRateGauge.labels(minerData.workerStats.workerName , address).set(workerHashRate);
      totalHashRate += workerHashRate;
      if (DEBUG) this.monitoring.debug(`SharesManager: Worker ${workerStats.workerName} stats - Time: ${timeDifference}s, Difficulty: ${workerStats.minDiff}, HashRate: ${workerHashRate}H/s, SharesFound: ${workerStats.sharesFound}, StaleShares: ${workerStats.staleShares}, InvalidShares: ${workerStats.invalidShares}`);
    });
    poolHashRateGauge.labels(this.poolAddress).set(totalHashRate);
    if (DEBUG) this.monitoring.debug(`SharesManager: Total pool hash rate updated to ${totalHashRate} GH/s`);
  }

  getMiners() {
    return this.miners;
  }

  resetContributions() {
    this.contributions.clear();
  }

  dumpContributions() {
    const contributions = Array.from(this.contributions.values());
    if (DEBUG) this.monitoring.debug(`SharesManager: Amount of contributions per miner for this cycle ${contributions.length}`);
    this.contributions.clear();
    return contributions;
  }
}
