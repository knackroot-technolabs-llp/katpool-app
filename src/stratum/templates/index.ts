import type { IBlock, RpcClient, IRawBlock, IRawHeader, HexString } from "../../../wasm/kaspa"
import { calculateTarget, Header, PoW } from "../../../wasm/kaspa"
import Jobs from "./jobs"
import { minedBlocksGauge, paidBlocksGauge } from '../../prometheus';
import Monitoring from '../../monitoring'
import { DEBUG } from '../../../index'
import { metrics } from '../../../index';   
import { BigDiffToTarget } from "../utils";
import JsonBig from 'json-bigint';
import redis, { type RedisClientType } from 'redis';

export default class Templates {
  private rpc: RpcClient
  private address: string
  public templates: Map<string, [ IBlock, PoW ]> = new Map()
  private jobs: Jobs = new Jobs()
  private cacheSize: number
  private monitoring: Monitoring
  private idCounter: number
  private subscriber: RedisClientType

  constructor (rpc: RpcClient, address: string, cacheSize: number) {
    this.monitoring = new Monitoring()
    this.rpc = rpc
    this.address = address
    this.cacheSize = cacheSize
    this.idCounter = 0
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

      // console.log("🚀 ~ file: index.ts:121 ~ Templates ~ this.subscriber.subscribe ~ converted:", tHeader)

      // const fethcedTemplate = { ...template.header, "parentsByLevel": undefined}
      // console.log(`fetched template : ${JsonBig.stringify(fethcedTemplate)} and template transactions : ${JsonBig.stringify(template.transactions)}`)
      // const template = {
      //   header: {
      //     version: 1,
      //     parentsByLevel: [
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["7ed8c622d3a04733e24252c51d7b7752537327ca5396424aed078f86bad23c77", "79ba15c28ce790476bb0566eb01bb29b28b71529b6e3c8da0e72fd4acb55e254"],
      //       ["66267d6b66808660ef7380bd86d54049562a16367d7522c39526ac7cf801ae76", "d4b1350b5ba39a5738f03bcce3b76ab1f2b392c044993467da294cfd60e4e2b1"],
      //       ["66267d6b66808660ef7380bd86d54049562a16367d7522c39526ac7cf801ae76", "d4b1350b5ba39a5738f03bcce3b76ab1f2b392c044993467da294cfd60e4e2b1"],
      //       ["66267d6b66808660ef7380bd86d54049562a16367d7522c39526ac7cf801ae76", "d4b1350b5ba39a5738f03bcce3b76ab1f2b392c044993467da294cfd60e4e2b1"],
      //       ["d4b1350b5ba39a5738f03bcce3b76ab1f2b392c044993467da294cfd60e4e2b1"],
      //       ["d4b1350b5ba39a5738f03bcce3b76ab1f2b392c044993467da294cfd60e4e2b1"],
      //       ["4a84e476d82140020c4e091707fc877c6b368a5c62f8ee9bc10e01e95e85ac48"],
      //       ["4a84e476d82140020c4e091707fc877c6b368a5c62f8ee9bc10e01e95e85ac48"],
      //       ["4e80bfcc48853d4fa94ba06259827d88abecebe29cc699fb1f578fd83c99f6f8"],
      //       ["4e80bfcc48853d4fa94ba06259827d88abecebe29cc699fb1f578fd83c99f6f8"],
      //       ["4e80bfcc48853d4fa94ba06259827d88abecebe29cc699fb1f578fd83c99f6f8"],
      //       ["4e80bfcc48853d4fa94ba06259827d88abecebe29cc699fb1f578fd83c99f6f8"],
      //       ["8aac15ef24ee68eb50dc2f89d8cc6276f074bbb88e807d3bf1cc1598a50d33f6"],
      //       ["8aac15ef24ee68eb50dc2f89d8cc6276f074bbb88e807d3bf1cc1598a50d33f6"],
      //       ["8aac15ef24ee68eb50dc2f89d8cc6276f074bbb88e807d3bf1cc1598a50d33f6"],
      //       ["b34cba7200353c5d688d312eb2d5418980bc1b78565f13f555d5ec9e8d7274bd"],
      //       ["b34cba7200353c5d688d312eb2d5418980bc1b78565f13f555d5ec9e8d7274bd"],
      //       ["b34cba7200353c5d688d312eb2d5418980bc1b78565f13f555d5ec9e8d7274bd"],
      //       ["b3de735c7c6af074e6393f8b8b3f5a0cc6ac979db375a7fa9eae17fa3c6df74e"],
      //       ["e650667d62105810606b6ced16409c2017a3b8cbfc21a475dca504858bade95d"],
      //       ["0532961f310411aec18c96d04a6d8521b91f03fed1cd17c58a5b85c0761143cb"],
      //       ["0532961f310411aec18c96d04a6d8521b91f03fed1cd17c58a5b85c0761143cb"],
      //       ["7419e24109cbb4765026d650138023017cbeaed5f5368a74dc5f478f2cc4e52d"],
      //       ["9c7c5b2e0cb234c81cf3983fe866ef45d3425b68d577bc5cadb8f33b96d8c7df"],
      //       ["9c7c5b2e0cb234c81cf3983fe866ef45d3425b68d577bc5cadb8f33b96d8c7df"],
      //     ],
      //     hashMerkleRoot: "94fe25a4cbc003af1f5d5360feabb76d71a2ecc66960d0789ea8ce20ea0c5345",
      //     acceptedIdMerkleRoot: "85e4eef9fc946d0553afa5dad7e2e342fc22e753e47b2834de72869743c3447f",
      //     utxoCommitment: "249d689255442606309b367d93b8f16510cbfb0abe4e49c0af71a68a6d027d88",
      //     timestamp: 1733807511486n,
      //     bits: 420366853,
      //     nonce: 0n,
      //     daaScore: 97488826n,
      //     blueWork: "0e9ef75d6b67b0eee9b099",
      //     blueScore: 95879331n,
      //     pruningPoint: "fc239a9d84a1e20bbe8232e9133c57229634f2c2ad11800bf4ef4e7f8f6b6a4b",
      //   },
      // }
      const header = new Header(template.header as IRawHeader);
      const headerHash = header.finalize();

      // if (this.templates.has(headerHash)) return

      const proofOfWork = new PoW(header)
      // const stateTarget = proofOfWork.target;
      // console.log("🚀 ~ file: index.ts:164 ~ Templates ~ this.rpc.addEventListener ~ stateTarget:", stateTarget)
      // const checkWork = proofOfWork.checkWork(BigInt("7710163160205612556"))
      // console.log("🚀 ~ file: index.ts:145 ~ Templates ~ this.rpc.addEventListener ~ checkWork:", checkWork)
      // const bigDiffTarget = BigDiffToTarget(BigInt(4096))
      // console.log("🚀 ~ file: index.ts:147 ~ Templates ~ this.rpc.addEventListener ~ bigDiffTarget:", bigDiffTarget)
      this.templates.set(headerHash, [ template as IBlock, proofOfWork ])
      // const id = this.jobs.deriveId(headerHash)
      this.idCounter += 1;
      this.jobs.setHash((this.idCounter).toString(), headerHash)
      // console.log("saved job ids : ", Object.entries(this.jobs))

      //if (DEBUG) this.monitoring.debug(`Templates: templates.size: ${this.templates.size}, cacheSize: ${this.cacheSize}`)

      if (this.templates.size > this.cacheSize) {
        this.templates.delete(this.templates.entries().next().value![0])
        this.jobs.expireNext()
      }

    callback((this.idCounter).toString(), headerHash, header.timestamp, template.header)
    })
    // })


    await this.rpc.subscribeNewBlockTemplate()
  }
}