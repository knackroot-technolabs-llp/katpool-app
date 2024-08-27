import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import Server, { type Miner, type Worker } from './server';
import { type Request, type Response, type Event, errors } from './server/protocol';
import type Templates from './templates/index.ts';
import { Address } from "../../wasm/kaspa";
import { Encoding, encodeJob } from './templates/jobs/encoding.ts';
import { SharesManager } from './sharesManager';
import { minerjobSubmissions, jobsNotFound } from '../prometheus'
import Monitoring from '../monitoring/index.ts';
import { DEBUG } from '../../index'
import { Mutex } from 'async-mutex';
import { metrics } from '../../index';
import Denque from 'denque';


export default class Stratum extends EventEmitter {
  server: Server;
  private templates: Templates;
  private difficulty: number;
  private subscriptors: Set<Socket<Miner>> = new Set();
  private monitoring: Monitoring
  sharesManager: SharesManager;
  private minerDataLock = new Mutex();

  constructor(templates: Templates, port: number, initialDifficulty: number, pushGatewayUrl: string, poolAddress: string, sharesPerMin: number) {
    super();
    this.monitoring = new Monitoring
    this.sharesManager = new SharesManager(poolAddress, pushGatewayUrl);
    this.server = new Server(port, initialDifficulty, this.onMessage.bind(this));
    this.difficulty = initialDifficulty;
    this.templates = templates;
    this.templates.register((id, hash, timestamp) => this.announceTemplate(id, hash, timestamp));
    this.monitoring.log(`Stratum: Initialized with difficulty ${this.difficulty}`);

    // Start the VarDiff thread
    const varDiffStats = true; // Enable logging of VarDiff stats
    const clampPow2 = true; // Enable clamping difficulty to powers of 2
    this.sharesManager.startVardiffThread(sharesPerMin, varDiffStats, clampPow2);

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
    const release = await this.minerDataLock.acquire();
    try {
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
          this.monitoring.log(`Stratum: Miner subscribed from ${socket.remoteAddress}`);
          break;
        }
        case 'mining.authorize': {
          const [address, name] = request.params[0].split('.');
          if (!Address.validate(address)) throw Error('Invalid address');
          const worker: Worker = { address, name };
          if (socket.data.workers.has(worker.name)) throw Error('Worker with duplicate name');
          const sockets = this.sharesManager.getMiners().get(worker.address)?.sockets || new Set();
          socket.data.workers.set(worker.name, worker);
          sockets.add(socket);

          if (!this.sharesManager.getMiners().has(worker.address)) {
            this.sharesManager.getMiners().set(worker.address, {
              sockets,
              workerStats: {
                blocksFound: 0,
                sharesFound: 0,
                sharesDiff: 0,
                staleShares: 0,
                invalidShares: 0,
                workerName: worker.name,
                startTime: Date.now(),
                lastShare: Date.now(),
                varDiffStartTime: Date.now(),
                varDiffSharesFound: 0,
                varDiffWindow: 0,
                minDiff: this.difficulty,
                recentShares: new Denque<{ timestamp: number, difficulty: number }>(),
                hashrate: 0,
              }
            });
          } else {
            const existingMinerData = this.sharesManager.getMiners().get(worker.address);
            existingMinerData!.sockets = sockets;
            this.sharesManager.getMiners().set(worker.address, existingMinerData!);
          }

          const event: Event<'set_extranonce'> = {
            method: 'set_extranonce',
            params: [randomBytes(4).toString('hex')]
          };
          socket.write(JSON.stringify(event) + '\n');
          this.reflectDifficulty(socket);
          if (DEBUG) this.monitoring.debug(`Stratum: Authorizing worker - Address: ${address}, Worker Name: ${name}`);
          break;
        }
        case 'mining.submit': {
          const [address, name] = request.params[0].split('.');
          metrics.updateGaugeInc(minerjobSubmissions, [name, address]);
          if (DEBUG) this.monitoring.debug(`Stratum: Submitting job for Worker Name: ${name}`);
          const worker = socket.data.workers.get(name);
          if (DEBUG) this.monitoring.debug(`Stratum: Checking worker data on socket for : ${name}`);
          if (!worker || worker.address !== address) {
            if (DEBUG) this.monitoring.debug(`Stratum: Mismatching worker details - Address: ${address}, Worker Name: ${name}`);
            throw Error('Mismatching worker details');
          }
          const hash = this.templates.getHash(request.params[1]);
          if (!hash) {
            if (DEBUG) this.monitoring.debug(`Stratum: Job not found - Address: ${address}, Worker Name: ${name}`);
            metrics.updateGaugeInc(jobsNotFound, [name, address]);
          }
          else {
            const minerId = name;
            const minerData = this.sharesManager.getMiners().get(worker.address);
            const workerDiff = minerData?.workerStats.minDiff;
            const socketDiff = socket.data.difficulty;
            if (DEBUG) this.monitoring.debug(`Stratum: Current difficulties - Worker: ${workerDiff}, Socket: ${socketDiff}`);
            const currentDifficulty = workerDiff || socketDiff;
            if (DEBUG) this.monitoring.debug(`Stratum: Adding Share - Address: ${address}, Worker Name: ${name}, Hash: ${hash}, Difficulty: ${currentDifficulty}`);
            await this.sharesManager.addShare(minerId, worker.address, hash, currentDifficulty, BigInt('0x' + request.params[2]), this.templates).catch(err => {
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
    } finally {
      release();
    }
  }
}