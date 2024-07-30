import type { Socket } from 'bun';
import { calculateTarget } from "../../wasm/kaspa";
import { Pushgateway } from 'prom-client';
import type { RegistryContentType } from 'prom-client';
import { stringifyHashrate, getAverageHashrateGHs } from './utils';
import Monitoring from '../monitoring'
import { DEBUG } from '../../index'
import {
  minerHashRateGauge, 
  poolHashRateGauge , 
  minerAddedShares, 
  minerIsBlockShare, 
  minerInvalidShares, 
  minerStaleShares, 
  minerDuplicatedShares, 
  varDiff } from '../prometheus'
import { metrics } from '../../index';  

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

  startHashRateLogging(interval: number) {
    setInterval(() => {
      this.calcHashRates();
    }, interval);
  }

  async addShare(minerId: string, address: string, hash: string, difficulty: number, nonce: bigint, templates: any) {
    const minerData = this.miners.get(address);
    const currentDifficulty = minerData ? minerData.workerStats.minDiff : difficulty;
    metrics.updateGaugeInc(minerAddedShares, [minerId ,address]);
    if (DEBUG) this.monitoring.debug(`SharesManager: Share added for ${minerId} - Address: ${address} - Nonce: ${nonce} - Hash: ${hash}`);
    const timestamp = Date.now();
    let report;
  
    if (!minerData) {
      this.miners.set(address, {
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
          minDiff: currentDifficulty
        }
      });
    } else {
      minerData.workerStats.sharesFound++;
      minerData.workerStats.varDiffSharesFound++;
      minerData.workerStats.lastShare = timestamp;
      minerData.workerStats.minDiff = currentDifficulty;
    }
  
    if (this.contributions.has(nonce)){
      metrics.updateGaugeInc(minerDuplicatedShares, [minerId, address]);
      throw Error('Duplicate share');
    }
    const state = templates.getPoW(hash);
    if (!state){
      if (DEBUG) this.monitoring.debug(`SharesManager: Stale header for miner ${minerId} and hash: ${hash}`);
      metrics.updateGaugeInc(minerStaleShares, [minerId, address]);
      throw Error('Stale header');
    }
    const [isBlock, target] = state.checkWork(nonce);
    if (isBlock) {
      if (DEBUG) this.monitoring.debug(`SharesManager: Work found for ${minerId} and target: ${target}`);
      metrics.updateGaugeInc(minerIsBlockShare, [minerId, address]);
      report = await templates.submit(minerId, hash, nonce);
    }  
    const validity = target <= calculateTarget(currentDifficulty);
    
    if (!validity){
      if (DEBUG) this.monitoring.debug(`SharesManager: Invalid share for target: ${target} for miner ${minerId}`);
      metrics.updateGaugeInc(minerInvalidShares, [minerId, address]);
      throw Error('Invalid share');
    } 
  
    this.contributions.set(nonce, { address, difficulty: currentDifficulty, timestamp, minerId });
    if (DEBUG) this.monitoring.debug(`SharesManager: Contributed block added from: ${minerId} with address ${address} for nonce: ${nonce}`);
  
    if (report && minerData) minerData.workerStats.blocksFound++;
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
      metrics.updateGaugeValue(minerHashRateGauge, [minerData.workerStats.workerName, address], workerHashRate);
      totalHashRate += workerHashRate;
      if (DEBUG) this.monitoring.debug(`SharesManager: Worker ${workerStats.workerName} stats - Time: ${timeDifference}s, Difficulty: ${workerStats.minDiff}, HashRate: ${workerHashRate}H/s, SharesFound: ${workerStats.sharesFound}, StaleShares: ${workerStats.staleShares}, InvalidShares: ${workerStats.invalidShares}`);
    });
    metrics.updateGaugeValue(poolHashRateGauge, ['pool',this.poolAddress], totalHashRate);
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

  startVardiffThread(sharesPerMin: number, varDiffStats: boolean, clampPow2: boolean) {
    setInterval(() => {
      const now = Date.now();
  
      this.miners.forEach(minerData => {
        const stats = minerData.workerStats;
        const elapsedMinutes = (now - stats.varDiffStartTime) / 60000; // Convert ms to minutes
        if (elapsedMinutes < 1) return;
  
        const sharesFound = stats.varDiffSharesFound;
        const shareRate = sharesFound / elapsedMinutes;
        const targetRate = sharesPerMin;
  
        if (DEBUG) this.monitoring.debug(`shareManager - VarDiff for ${stats.workerName}: sharesFound: ${sharesFound}, elapsedMinutes: ${elapsedMinutes}, shareRate: ${shareRate}, targetRate: ${targetRate}`);
  
        if (shareRate > targetRate * 1.2) {
          let newDiff = stats.minDiff * 1.5;
          if (clampPow2) {
            newDiff = Math.pow(2, Math.floor(Math.log2(newDiff)));
          }
          stats.minDiff = newDiff;
          if (DEBUG) this.monitoring.debug(`shareManager: VarDiff - Increasing difficulty for ${stats.workerName} to ${newDiff}`);
        } else if (shareRate < targetRate * 0.8) {
          let newDiff = stats.minDiff / 1.5;
          if (clampPow2) {
            newDiff = Math.pow(2, Math.ceil(Math.log2(newDiff)));
          }
          if (newDiff < 1) {
            newDiff = 1;
          }
          stats.minDiff = newDiff;
          if (DEBUG) this.monitoring.debug(`shareManager: VarDiff - Decreasing difficulty for ${stats.workerName} to ${newDiff}`);
        }
  
        stats.varDiffSharesFound = 0;
        stats.varDiffStartTime = now;
  
        if (varDiffStats) {
          this.monitoring.log(`shareManager: VarDiff for ${stats.workerName}: sharesFound: ${sharesFound}, elapsed: ${elapsedMinutes.toFixed(2)}, shareRate: ${shareRate.toFixed(2)}, newDiff: ${stats.minDiff}`);
        }
      });
    }, 600000); // Run every 10 minute
  }
  

}
