import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import Server, { type Miner, type Worker } from './server';
import { type Request, type Response, type Event, errors } from './server/protocol';
import type Templates from './templates/index.ts';
import { calculateTarget, Address } from "../../wasm/kaspa";
import { Encoding, encodeJob } from './templates/jobs/encoding.ts';
import { Gauge } from 'prom-client';

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



export default class Stratum extends EventEmitter {
  server: Server;
  private templates: Templates;
  private difficulty: number;
  private contributions: Map<bigint, Contribution> = new Map();
  private subscriptors: Set<Socket<Miner>> = new Set();
  miners: Map<string, { sockets: Set<Socket<Miner>>, shares: number, hashRate: number, lastShareTime: number, difficulty: number }> = new Map();

  constructor(templates: Templates, port: number, initialDifficulty: number) {
    super();
    this.server = new Server(port, initialDifficulty, this.onMessage.bind(this));
    this.difficulty = initialDifficulty;
    this.templates = templates;
    this.templates.register((id, hash, timestamp) => this.announceTemplate(id, hash, timestamp));
    this.startHashRateLogging(60000);
  }

  dumpContributions() {
    const contributions = Array.from(this.contributions.values());
    this.contributions.clear();
    return contributions;
  }

  async addShare(minerId: string, address: string, hash: string, difficulty: number, nonce: bigint) {
    const timestamp = Date.now();
    if (this.contributions.has(nonce)) throw Error('Duplicate share');
    const state = this.templates.getPoW(hash);
    if (!state) throw Error('Stale header');
    const [isBlock, target] = state.checkWork(nonce);
    if (isBlock) await this.templates.submit(hash, nonce);
    const validity = target <= calculateTarget(difficulty);
    if (!validity) throw Error('Invalid share');
    this.contributions.set(nonce, { address, difficulty, timestamp, minerId });
    const minerData = this.miners.get(address) || { sockets: new Set(), shares: 0, hashRate: 0, lastShareTime: timestamp, difficulty };
    minerData.shares++;
    minerData.lastShareTime = timestamp;
    minerData.difficulty = difficulty;
    this.miners.set(address, minerData);
    sharesGauge.labels(address).inc();
  }

  resetHashRates() {
    this.miners.forEach((minerData, address) => {
      const timeDifference = Date.now() - minerData.lastShareTime;
      if (timeDifference > 0) {
        const hashRate = (minerData.shares * minerData.difficulty * 1e3) / timeDifference;
        minerData.hashRate = hashRate;
        minerData.shares = 0;
        minerData.lastShareTime = Date.now();
      }
    });
  }

  startHashRateLogging(interval: number) {
    setInterval(() => {
      this.resetHashRates();
    }, interval);
  }

  getOverallHashRate() {
    let totalHashRate = 0;
    for (const miner of this.miners.values()) {
      totalHashRate += miner.hashRate;
    }
    return totalHashRate;
  }

  getMinerHashRate(address: string) {
    const minerData = this.miners.get(address);
    return minerData ? minerData.hashRate : 0;
  }

  announceTemplate(id: string, hash: string, timestamp: bigint) {
    const tasksData: { [key in Encoding]?: string } = {};
    Object.values(Encoding).filter(value => typeof value !== 'number').forEach(value => {
      const encoding = Encoding[value as keyof typeof Encoding];
      const task: Event<'mining.notify'> = {
        method: 'mining.notify',
        params: [id, ...encodeJob(hash, timestamp, encoding)]
      };
      tasksData[encoding] = JSON.stringify(task);
    });
    this.subscriptors.forEach((socket) => {
      if (socket.readyState === "closed") {
        this.subscriptors.delete(socket);
      } else {
        socket.write(tasksData[socket.data.encoding] + '\n');
      }
    });
  }

  reflectDifficulty(socket: Socket<Miner>) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [socket.data.difficulty]
    };
    socket.write(JSON.stringify(event) + '\n');
  }

  private async onMessage(socket: Socket<Miner>, request: Request) {
    let response: Response = {
      id: request.id,
      result: true,
      error: null
    };
    switch (request.method) {
      case 'mining.subscribe': {
        if (this.subscriptors.has(socket)) throw Error('Already subscribed');
        this.subscriptors.add(socket);
        response.result = [true, 'EthereumStratum/1.0.0'];
        this.emit('subscription', socket.remoteAddress, request.params[0]);
        break;
      }
      case 'mining.authorize': {
        const [address, name] = request.params[0].split('.');
        if (!Address.validate(address)) throw Error('Invalid address');
        const worker: Worker = { address, name };
        if (socket.data.workers.has(worker.name)) throw Error('Worker with duplicate name');
        const sockets = this.miners.get(worker.address)?.sockets || new Set();
        socket.data.workers.set(worker.name, worker);
        sockets.add(socket);
        this.miners.set(worker.address, { sockets, shares: 0, hashRate: 0, lastShareTime: Date.now(), difficulty: this.difficulty });
        const event: Event<'set_extranonce'> = {
          method: 'set_extranonce',
          params: [randomBytes(4).toString('hex')]
        };
        socket.write(JSON.stringify(event) + '\n');
        this.reflectDifficulty(socket);
        break;
      }
      case 'mining.submit': {
        const [address, name] = request.params[0].split('.');
        const worker = socket.data.workers.get(name);
        if (!worker || worker.address !== address) throw Error('Mismatching worker details');
        const hash = this.templates.getHash(request.params[1]);
        if (!hash) {
          response.error = errors['JOB_NOT_FOUND'];
          response.result = false;
        } else {
          const minerId = name; // Use the worker name as minerId or define your minerId extraction logic
          await this.addShare(minerId, worker.address, hash, socket.data.difficulty, BigInt('0x' + request.params[2])).catch(err => {
            if (!(err instanceof Error)) throw err;
            switch (err.message) {
              case 'Duplicate share':
                response.error = errors['DUPLICATE_SHARE'];
                break;
              case 'Stale header':
                response.error = errors['JOB_NOT_FOUND'];
                break;
              case 'Invalid share':
                response.error = errors['LOW_DIFFICULTY_SHARE'];
                break;
              default:
                throw err;
            }
            response.result = false;
          });
        }
        break;
      }
      default:
        throw errors['UNKNOWN'];
    }
    return response;
  }
}
