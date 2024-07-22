import { collectDefaultMetrics, register, Gauge } from 'prom-client';

collectDefaultMetrics();

const minerHashRateGauge = new Gauge({
  name: 'miner_hash_rate',
  help: 'Hash rate of each miner',
  labelNames: ['miner_id', 'wallet_address']
});

export { register, minerHashRateGauge };
