import { collectDefaultMetrics, register, Gauge } from 'prom-client';

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
  labelNames: ['pool_address'],
});

export const minerShares = new Gauge({
  name: 'miner_shares',
  help: 'Shares per miner',
  labelNames: ['miner_id', 'wallet_address'],
});

export const minerAddedShares = new Gauge({
  name: 'added_miner_shares',
  help: 'Added shares per miner',
  labelNames: ['miner_id', 'wallet_address'],
});

export const minerInvalidShares = new Gauge({
  name: 'miner_invalid_shares',
  help: 'Invalid shares per miner',
  labelNames: ['miner_id', 'wallet_address'],
});

export const minerDuplicatedShares = new Gauge({
  name: 'miner_duplicated_shares',
  help: 'Duplicated shares per miner',
  labelNames: ['miner_id', 'wallet_address'],
});

export const minerIsBlockShare = new Gauge({
  name: 'miner_isblock_shares',
  help: 'Is Block shares per miner',
  labelNames: ['miner_id', 'wallet_address'],
});

export const minerStaleShares = new Gauge({
  name: 'miner_stale_shares',
  help: 'Stale shares per miner',
  labelNames: ['miner_id', 'wallet_address'],
});

export const minedBlocksGauge = new Gauge({
  name: 'mined_blocks',
  help: 'Total number of mined blocks',
  labelNames: ['miner_id', 'pool_address'],
});

export const paidBlocksGauge = new Gauge({
  name: 'paid_blocks',
  help: 'Total number of paid blocks',
  labelNames: ['miner_id', 'pool_address'],
});