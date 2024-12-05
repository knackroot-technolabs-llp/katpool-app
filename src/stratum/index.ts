import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import Server, { type Miner, type Worker } from './server';
import { type Request, type Response, type Event, errors } from './server/protocol';
import type Templates from './templates/index.ts';
import { Address, type IRawHeader } from "../../wasm/kaspa";
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
  extraNonce : string;

  constructor(templates: Templates, port: number, initialDifficulty: number, pushGatewayUrl: string, poolAddress: string, sharesPerMin: number) {
    super();
    this.monitoring = new Monitoring
    this.sharesManager = new SharesManager(poolAddress, pushGatewayUrl);
    this.server = new Server(port, initialDifficulty, this.onMessage.bind(this));
    this.difficulty = initialDifficulty;
    this.templates = templates;
    this.templates.register((id, hash, timestamp, templateHeader) => this.announceTemplate(id, hash, timestamp, templateHeader));
    this.monitoring.log(`Stratum: Initialized with difficulty ${this.difficulty}`);
    this.extraNonce = "";

    // Start the VarDiff thread
    const varDiffStats = true; // Enable logging of VarDiff stats
    const clampPow2 = true; // Enable clamping difficulty to powers of 2
    this.sharesManager.startVardiffThread(sharesPerMin, varDiffStats, clampPow2);

    this.getExtraNonce();
  }

  getExtraNonce() {
    if (!process.env.EXTRANONCE_SIZE) {
      console.error("Extranonce size is not set in env.")
      process.exit(1);
    }
    var extranonceSize = Number(process.env.EXTRANONCE_SIZE);
    var maxExtranonce = Math.pow(2, 8 * Math.min(extranonceSize, 3)) - 1;
    var nextExtranonce = 0;
          
    var lExtranonce = 0;
    if (extranonceSize > 0) {
      lExtranonce = nextExtranonce;

      if (nextExtranonce < maxExtranonce) {
        nextExtranonce++;
      } else {
        nextExtranonce = 0;
        this.monitoring.log(
          "WARN : Wrapped extranonce! New clients may be duplicating work..."
        );
      }
    }

    // Format extranonce as a hexadecimal string with padding
    if (extranonceSize > 0) {
      this.extraNonce = lExtranonce.toString(16).padStart(extranonceSize * 2, "0");
    }    
  }

  announceTemplate(id: string, hash: string, timestamp: bigint, templateHeader: IRawHeader) {
    this.monitoring.log(`Stratum: Announcing new template ${id}`);
    const tasksData: { [key in Encoding]?: string } = {};
    Object.values(Encoding).filter(value => typeof value !== 'number').forEach(value => {
      const encoding = Encoding[value as keyof typeof Encoding];
      const encodedParams = encodeJob(hash, timestamp, encoding, templateHeader)
      const task: Event<'mining.notify'> = {
        method: 'mining.notify',
        params: [id, encodedParams]
      };
      if(encoding === Encoding.Bitmain) {
        task.params.push(Number(timestamp));
      }
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
          const minerType = request.params[0].toLowerCase();
          socket.data.encoding = Encoding.Bitmain;
          this.subscriptors.add(socket);
          response.result = [true, this.extraNonce, 8 - Math.floor(this.extraNonce.length / 2)];
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
          const result: any[] = [
            this.extraNonce, 
            8 - Math.floor(this.extraNonce.length / 2)
          ];
          
          const event: Event<'mining.set_extranonce'> = {
            method: 'mining.set_extranonce',
            params: [result]
          };
          if (this.extraNonce != "") {
            socket.write(JSON.stringify(event) + '\n');
          }          
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
          console.log("mining.submit ~ request.params :", request.params[1], hash)
          if (!hash) {
            if (DEBUG) this.monitoring.debug(`Stratum: Job not found - Address: ${address}, Worker Name: ${name}`);
            metrics.updateGaugeInc(jobsNotFound, [name, address]);
            response.result = false
            response.error = errors["JOB_NOT_FOUND"]
            return response
            // throw Error("Hash not found")
          }
          else {
            const minerId = name;
            const minerData = this.sharesManager.getMiners().get(worker.address);
            const workerDiff = minerData?.workerStats.minDiff;
            const socketDiff = socket.data.difficulty;
            if (DEBUG) this.monitoring.debug(`Stratum: Current difficulties - Worker: ${workerDiff}, Socket: ${socketDiff}`);
            const currentDifficulty = workerDiff || socketDiff;
            if (DEBUG) this.monitoring.debug(`Stratum: Adding Share - Address: ${address}, Worker Name: ${name}, Hash: ${hash}, Difficulty: ${currentDifficulty}`);
            // Add extranonce to noncestr if enabled and submitted nonce is shorter than
            // expected (16 - <extranonce length> characters)
            if (this.extraNonce !== "") {
              const extranonce2Len = 16 - this.extraNonce.length;

              if (request.params[2].length <= extranonce2Len) {
                request.params[2] =
                this.extraNonce + request.params[2].padStart(extranonce2Len, "0");
              }
            }
            try{
              // console.log("this templates : ", this.templates);
              this.sharesManager.addShare(minerId, worker.address, hash, currentDifficulty, BigInt(request.params[2]), this.templates)
            }
            catch(err: any) {
              console.log("error thrown : ", err);
              // if (!(err instanceof Error)) throw err;
              // switch (err.message) {
              //   case 'Duplicate share':
              //     console.log("DUPLICATE_SHARE")
              //     response.error = errors['DUPLICATE_SHARE'];
              //     break;
              //   case 'Stale header':
              //     console.log("Stale Header : JOB_NOT_FOUND")
              //     response.error = errors['JOB_NOT_FOUND'];
              //     break;
              //   case 'Invalid share':
              //     console.log("LOW_DIFFICULTY_SHARE")
              //     response.error = errors['LOW_DIFFICULTY_SHARE'];
              //     break;
              //   default:
              //     throw err;
              // }
              // response.result = false;
            }
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