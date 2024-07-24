import { RpcClient, Encoding, Resolver } from "./wasm/kaspa";
import Treasury from "./src/treasury";
import Templates from "./src/stratum/templates";
import Stratum from "./src/stratum";
import Pool from "./src/pool";
import { Pushgateway, Gauge } from 'prom-client';
import config from "./config.json";
import dotenv from 'dotenv';
import { sharesGauge } from './src/stratum';
import { minedBlocksGauge, paidBlocksGauge } from './src/stratum/templates';

dotenv.config();

const rpc = new RpcClient({
  resolver: new Resolver(),
  encoding: Encoding.Borsh,
  networkId: config.network
});
await rpc.connect();

const serverInfo = await rpc.getServerInfo();
if (!serverInfo.isSynced || !serverInfo.hasUtxoIndex) throw Error('Provided node is either not synchronized or lacks the UTXO index.');

const treasuryPrivateKey = process.env.TREASURY_PRIVATE_KEY;
if (!treasuryPrivateKey) {
  throw new Error('Environment variable TREASURY_PRIVATE_KEY is not set.');
}

const kaspoolPshGw = process.env.PUSHGATEWAY;
if (!kaspoolPshGw) {
  throw new Error('Environment variable PUSHGATEWAY is not set.');
}

const treasury = new Treasury(rpc, serverInfo.networkId, treasuryPrivateKey, config.treasury.fee);
const templates = new Templates(rpc, treasury.address, config.stratum.templates.cacheSize);

// Setup Prometheus Pushgateway
const gateway = new Pushgateway(kaspoolPshGw);

// Create Gauges for the hash rate
const minerHashRateGauge = new Gauge({
  name: 'miner_hash_rate',
  help: 'Hash rate of individual miners',
  labelNames: ['miner_id', 'wallet_address'],
});

const poolHashRateGauge = new Gauge({
  name: 'pool_hash_rate',
  help: 'Overall hash rate of the pool',
  labelNames: ['pool_address'],
});

// Create a function to push all metrics under a single job name
async function pushMetrics() {
  // Push all metrics to the Pushgateway under the same job name
  try {
    await gateway.pushAdd({ jobName: 'mining_metrics' });
    console.log('Metrics pushed to Pushgateway');
  } catch (err) {
    console.error('ERROR: Error pushing metrics to Pushgateway:', err);
  }
}

const stratum = new Stratum(templates, config.stratum.port, config.stratum.difficulty, minerHashRateGauge, poolHashRateGauge, treasury.address);
const pool = new Pool(treasury, stratum);

// Schedule metrics push every minute
setInterval(() => {
  stratum.resetHashRates();
  pushMetrics();
}, 60000); // every minute
