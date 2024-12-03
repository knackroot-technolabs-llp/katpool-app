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
  public templates: Map<string, [ IBlock, PoW ]> = new Map()
  private jobs: Jobs = new Jobs()
  private cacheSize: number
  private monitoring: Monitoring
  private currentJobId = 0 // Initialize if not already set

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

  async register (callback: (id: string, hash: string, timestamp: bigint, templateHeader: IRawHeader, headerHash: string, bits: number) => void) {
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
      // const id = this.jobs.deriveId(headerHash)
      // Increment the ID and wrap around using modulo
      const id = (this.currentJobId % this.cacheSize) + 1;
      this.currentJobId++;  // Increment for the next job ID
      this.jobs.setHash(id.toString(), headerHash)

      //if (DEBUG) this.monitoring.debug(`Templates: templates.size: ${this.templates.size}, cacheSize: ${this.cacheSize}`)

      if (this.templates.size > this.cacheSize) {
        this.templates.delete(this.templates.entries().next().value![0])
        this.jobs.expireNext()
      }

      callback(id.toString(), proofOfWork.prePoWHash, header.timestamp, template.header, headerHash, template.header.bits)
    })

    await this.rpc.subscribeNewBlockTemplate()
  }
}