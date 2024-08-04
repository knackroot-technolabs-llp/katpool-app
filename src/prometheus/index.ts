import { collectDefaultMetrics, Pushgateway , register, Gauge } from 'prom-client';
import PQueue from 'p-queue';
import type { RegistryContentType } from 'prom-client';
import Monitoring from '../monitoring';
const queue = new PQueue({ concurrency: 1 });

collectDefaultMetrics();
export { register };

export const minerHashRateGauge = new Gauge({
  name: 'miner_hash_rate',
  help: 'Hash rate of each miner',
  labelNames: ['miner_id', 'wallet_address']
});

export const poolHashRateGauge = new Gauge({
  name: 'pool_hash_rate',
  help: 'Overall hash rate of the pool',
  labelNames: ['miner_id', 'pool_address']
});

export const minerjobSubmissions = new Gauge({
  name: 'miner_job_submissions_10min',
  help: 'Job submitted per miner',
  labelNames: ['miner_id', 'wallet_address']
});

export const minerAddedShares = new Gauge({
  name: 'added_miner_shares_10min',
  help: 'Added shares per miner',
  labelNames: ['miner_id', 'wallet_address']
});

export const minerInvalidShares = new Gauge({
  name: 'miner_invalid_shares_10min',
  help: 'Invalid shares per miner',
  labelNames: ['miner_id', 'wallet_address']
});

export const minerDuplicatedShares = new Gauge({
  name: 'miner_duplicated_shares_10min',
  help: 'Duplicated shares per miner',
  labelNames: ['miner_id', 'wallet_address']
});

export const minerIsBlockShare = new Gauge({
  name: 'miner_isblock_shares_10min',
  help: 'Is Block shares per miner',
  labelNames: ['miner_id', 'wallet_address']
});

export const minerStaleShares = new Gauge({
  name: 'miner_stale_shares_10min',
  help: 'Stale shares per miner',
  labelNames: ['miner_id', 'wallet_address']
});

export const minedBlocksGauge = new Gauge({
  name: 'mined_blocks_10min',
  help: 'Total number of mined blocks',
  labelNames: ['miner_id', 'pool_address']
});

export const paidBlocksGauge = new Gauge({
  name: 'paid_blocks_10min',
  help: 'Total number of paid blocks',
  labelNames: ['miner_id', 'pool_address']
});

export const jobsNotFound = new Gauge({
  name: 'jobs_not_found_10min',
  help: 'Total jobs not Found for registered template',
  labelNames: ['miner_id', 'pool_address']
});

export const varDiff = new Gauge({
  name: 'variable_difficulty',
  help: 'show the difficulty per miner over time',
  labelNames: ['miner_id', 'pool_address']
});

export class PushMetrics {
  private pushGateway: Pushgateway<RegistryContentType>;
  private monitoring: Monitoring;
  private pushGatewayUrl: string;

  constructor(pushGatewayUrl: string) {
    this.pushGatewayUrl = pushGatewayUrl;
    this.pushGateway = new Pushgateway<RegistryContentType>(pushGatewayUrl);
    this.monitoring = new Monitoring();
    setInterval(() => this.pushMetrics(), 600000); // Push metrics every 10 minutes
  }

  async pushMetrics() {
    try {
      await this.pushGateway.pushAdd({ jobName: 'mining_metrics' });
      this.monitoring.log(`PushMetrics: Metrics pushed to Pushgateway`);
      this.resetGauges(); // Reset the gauges after pushing
    } catch (err) {
      console.error(`[${new Date().toISOString()}] PushMetrics: ERROR: Error pushing metrics to Pushgateway:`, err);
    }
  }

  updateGaugeValue(gauge: Gauge, labels: string[], value: number) {
    queue.add(() => gauge.labels(...labels).set(value));
  }
  updateGaugeInc(gauge: Gauge, labels: string[]) {
      queue.add(() => gauge.labels(...labels).inc(1));  

  }

  private resetGauges() {
    // Reset the values of the gauges to zero
    minerjobSubmissions.reset();
    minerAddedShares.reset();
    minerInvalidShares.reset();
    minerDuplicatedShares.reset();
    minerIsBlockShare.reset();
    minerStaleShares.reset();
    jobsNotFound.reset();
    minedBlocksGauge.reset();
    paidBlocksGauge.reset();

    this.monitoring.log(`PushMetrics: Reset minerjobSubmissions and minerAddedShares gauges to zero`);
  }
}


