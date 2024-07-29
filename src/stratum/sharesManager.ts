import type { Socket } from 'bun';
import { calculateTarget } from "../../wasm/kaspa";
import { Pushgateway, Gauge } from 'prom-client';
import type { RegistryContentType } from 'prom-client';

type MinerData = {
  sockets: Set<Socket<any>>,
  shares: number,
  hashRate: number,
  lastShareTime: number,
  difficulty: number,
  firstShareTime: number,
  accumulatedWork: number
};

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

    const minerHashRateGauge = new Gauge({
      name: 'miner_hash_rate',
      help: 'Hash rate of individual miners',
      labelNames: ['wallet_address'],
    });

    const poolHashRateGauge = new Gauge({
      name: 'pool_hash_rate',
      help: 'Overall hash rate of the pool',
      labelNames: ['pool_address'],
    });
    this.minerHashRateGauge = minerHashRateGauge;
    this.poolHashRateGauge = poolHashRateGauge;
    this.pushGateway = new Pushgateway<RegistryContentType>(pushGatewayUrl);
    this.startHashRateLogging(60000);

  }

  async pushMetrics() {
    try {
      await this.pushGateway.pushAdd({ jobName: 'mining_metrics' });
      console.log('Metrics pushed to Pushgateway');
    } catch (err) {
      console.error('ERROR: Error pushing metrics to Pushgateway:', err);
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

    const minerData = this.miners.get(address) || {
      sockets: new Set(),
      shares: 0,
      hashRate: 0,
      lastShareTime: timestamp,
      difficulty,
      firstShareTime: timestamp,
      accumulatedWork: 0
    };

    // Retain the first share time
    if (!this.miners.has(address)) {
      minerData.firstShareTime = timestamp;
    }

    minerData.accumulatedWork += difficulty;
    minerData.shares++;
    minerData.lastShareTime = timestamp;
    minerData.difficulty = difficulty;
    this.miners.set(address, minerData);
  }

  calcHashRates() {
    let totalHashRate = 0;
    this.miners.forEach((minerData, address) => {
      const timeDifference = Date.now() - minerData.firstShareTime;
      console.log(`Stratum: time difference ${timeDifference} of first time share ${minerData.firstShareTime} and now ${Date.now()}`);
      console.log(`Stratum: hash rate for ${address}: timeDifference=${timeDifference}, shares=${minerData.shares}, difficulty=${minerData.difficulty}, accumulated work: ${minerData.accumulatedWork}`);
      
      const hashRate = (minerData.accumulatedWork * minerData.shares) / (timeDifference / 1000);

      console.log(`Stratum: the accumulated hash rate for ${address} is: `, hashRate);
      this.minerHashRateGauge.labels(address).set(hashRate);
      totalHashRate += hashRate;
    });
    console.log("Stratum: the accumulated overall pool hash rate is: ", totalHashRate);
    // Update the pool hash rate gauge
    this.poolHashRateGauge.labels(this.poolAddress).set(totalHashRate);
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

