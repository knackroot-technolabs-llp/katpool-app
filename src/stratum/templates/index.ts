import type { IBlock, RpcClient, IRawBlock, IRawHeader } from "../../../wasm/kaspa"
import { Header, PoW } from "../../../wasm/kaspa"
import Jobs from "./jobs"
import { minedBlocksGauge, paidBlocksGauge } from '../../prometheus';
import Monitoring from '../../monitoring'
import { DEBUG } from '../../../index'
import { metrics } from '../../../index';   

export default class Templates {
  private rpc: RpcClient
  private address: string
  private templates: Map<string, [ IBlock, PoW ]> = new Map()
  private jobs: Jobs = new Jobs()
  private cacheSize: number
  private monitoring: Monitoring

  constructor (rpc: RpcClient, address: string, cacheSize: number) {
    this.monitoring = new Monitoring()
    this.rpc = rpc
    this.address = address
    this.cacheSize = cacheSize
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

  async register (callback: (id: string, hash: string, timestamp: bigint) => void) {
    this.monitoring.log(`Templates: Registering new template callback`);
    this.rpc.addEventListener('new-block-template', async () => {
      const template = (await this.rpc.getBlockTemplate({
        payAddress: this.address,
        extraData: "Katpool"
      })).block as IRawBlock;

      // Convert IRawHeader to IHeader
      const header = new Header(template.header);
      const headerHash = header.finalize();

      if (this.templates.has(headerHash)) return

      const proofOfWork = new PoW(header)
      this.templates.set(headerHash, [ template as IBlock, proofOfWork ])
      const id = this.jobs.deriveId(headerHash)

      //if (DEBUG) this.monitoring.debug(`Templates: templates.size: ${this.templates.size}, cacheSize: ${this.cacheSize}`)

      if (this.templates.size > this.cacheSize) {
        this.templates.delete(this.templates.entries().next().value[0])
        this.jobs.expireNext()
      }

      callback(id, proofOfWork.prePoWHash, header.timestamp)
    })

    await this.rpc.subscribeNewBlockTemplate()
  }
}