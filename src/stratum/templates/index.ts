import type { IBlock, RpcClient, IRawBlock, IRawHeader, HexString } from "../../../wasm/kaspa"
import { calculateTarget, Header, PoW } from "../../../wasm/kaspa"
import Jobs from "./jobs"
import { minedBlocksGauge, paidBlocksGauge } from '../../prometheus';
import Monitoring from '../../monitoring'
import { DEBUG } from '../../../index'
import { metrics } from '../../../index';   
import JsonBig from 'json-bigint';
import redis, { type RedisClientType } from 'redis';

export default class Templates {
  private rpc: RpcClient
  private address: string
  public templates: Map<string, [ IBlock, PoW ]> = new Map()
  private jobs: Jobs = new Jobs()
  private cacheSize: number
  private monitoring: Monitoring
  private subscriber: RedisClientType

  constructor (rpc: RpcClient, address: string, cacheSize: number) {
    this.monitoring = new Monitoring()
    this.rpc = rpc
    this.address = address
    this.cacheSize = cacheSize
    this.subscriber = redis.createClient({
      url: "redis://127.0.0.1:6379",
    })
    this.subscriber.connect()
  }

  getHash (id: string) {
    return this.jobs.getHash(id)
  }
  
  getPoW (hash: string) {
    return this.templates.get(hash)?.[1]
  }

  async submit (minerId: string, hash: string, nonce: bigint) {
    const template = this.templates.get(hash)![0]
    const header = new Header(template.header)

    header.nonce = nonce
    const newHash = header.finalize()

    template.header.nonce = nonce
    template.header.hash = newHash
    
    const report = await this.rpc.submitBlock({
      block: template,
      allowNonDAABlocks: false
    })
    metrics.updateGaugeInc(minedBlocksGauge, [minerId, this.address]);
    
    if (report.report.type == "success") {
      metrics.updateGaugeInc(paidBlocksGauge, [minerId, this.address]);
    }
    if (DEBUG) this.monitoring.debug(`Templates: the block has been ${report.report.type}, reason: ${report.report.reason}`)

    this.templates.delete(hash)
    return report.report.type
  }

  async register (callback: (id: string, hash: string, timestamp: bigint, templateHeader: IRawHeader) => void) {
    this.monitoring.log(`Templates: Registering new template callback`);
    // this.rpc.addEventListener('new-block-template', async () => {
      // const template = (await this.rpc.getBlockTemplate({
      //   payAddress: this.address,
      //   extraData: "Katpool"
      // })).block as IRawBlock;


      this.subscriber.subscribe('templateChannel', (message) => {
      const fetchedTemplate = JSON.parse(message)
      const blockTemplate = {
        header: fetchedTemplate.Block.Header,
      }
      function convertJson(data: any) {
        // Recursively traverse and transform keys
        function transformKeys(obj: any): any {
            if (Array.isArray(obj)) {
                return obj.map((item: any) => transformKeys(item)); // Process arrays
            } else if (obj !== null && typeof obj === 'object') {
                let newObj: any = {};
                for (const key in obj) {
                    if (obj.hasOwnProperty(key)) {
                        const newKey = key.toLowerCase(); // Convert key to lowercase
                        newObj[newKey] = transformKeys(obj[key]); // Recursively call for nested objects
                    }
                }
                return newObj;
            }
            return obj; // Return the value if it's neither an array nor an object
        }
    
        // First, transform all keys to lowercase
        const transformedKeysData = transformKeys(data);
        const parents = transformedKeysData.header.parents
        delete transformedKeysData.header.parents

        let parentsByLevel: any[] = [];
        parents.map((item: any, i: number) => {
          parentsByLevel[i] = item.parenthashes
        })

        transformedKeysData.header["parentsByLevel"] = parentsByLevel
    
        return transformedKeysData;
      }
      const converted = convertJson(blockTemplate)
      const tHeader: IRawHeader = {
        version: converted.header.version,
        parentsByLevel: converted.header.parentsByLevel,
        hashMerkleRoot: converted.header.hashmerkleroot,
        acceptedIdMerkleRoot: converted.header.acceptedidmerkleroot,
        utxoCommitment: converted.header.utxocommitment,
        timestamp: BigInt(converted.header.timestamp),
        bits: converted.header.bits,
        nonce: BigInt(converted.header.nonce),
        daaScore: BigInt(converted.header.daascore),
        blueWork: converted.header.bluework,
        blueScore: BigInt(converted.header.bluescore),
        pruningPoint: converted.header.pruningpoint,
      }
      const template = {
        header: tHeader,
      }
      if ((template.header.blueWork as string).length % 2 !== 0) {
        template.header.blueWork = '0' + template.header.blueWork;
      }

      const header = new Header(template.header);
      const headerHash = header.finalize();

      if (this.templates.has(headerHash)) return

      const proofOfWork = new PoW(header)
      this.templates.set(headerHash, [ template as IBlock, proofOfWork ])
      const id = this.jobs.deriveId(headerHash)

      //if (DEBUG) this.monitoring.debug(`Templates: templates.size: ${this.templates.size}, cacheSize: ${this.cacheSize}`)

      if (this.templates.size > this.cacheSize) {
        this.templates.delete(this.templates.entries().next().value![0])
        this.jobs.expireNext()
      }

    callback(id, proofOfWork.prePoWHash, header.timestamp, template.header)
    })
    // })


    await this.rpc.subscribeNewBlockTemplate()
  }
}