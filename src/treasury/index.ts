import { EventEmitter } from 'events'
import Monitoring from '../pool/monitoring';
import Database from '../pool/database'
import { PrivateKey, UtxoProcessor, UtxoContext, type RpcClient, type IPaymentOutput, createTransactions } from "../../wasm/kaspa"

export default class Treasury extends EventEmitter {
  privateKey: PrivateKey
  address: string
  processor: UtxoProcessor
  context: UtxoContext
  fee: number
  private monitoring: Monitoring;
  
  constructor (rpc: RpcClient, networkId: string, privateKey: string, fee: number) {
    super()
    
    this.privateKey = new PrivateKey(privateKey)
    this.address = (this.privateKey.toAddress(networkId)).toString()
    this.processor = new UtxoProcessor({ rpc, networkId })
    this.context = new UtxoContext({ processor: this.processor })
    this.fee = fee
    this.monitoring = new Monitoring();
    this.monitoring.log(`Treasury: Pool Wallet Address: " ${this.address}`)

    this.registerProcessor()
  }
  
  async send (outputs: IPaymentOutput[]) {
    const { transactions, summary } = await createTransactions({
      entries: this.context,
      outputs,
      changeAddress: this.address,
      priorityFee: 0n
    })
    this.monitoring.log(`Treasury: Signing and Submitting Transaction`)
    for (const transaction of transactions) {
      await transaction.sign([ this.privateKey ])
      await transaction.submit(this.processor.rpc)
    }

    this.monitoring.log(`Treasury: Transaction ID: " ${summary.finalTransactionId}`)
    return summary.finalTransactionId
  }
  
  private registerProcessor () {
    this.processor.addEventListener("utxo-proc-start", async () => {
      await this.context.clear()
      await this.context.trackAddresses([ this.address ])
    })

    this.processor.addEventListener('maturity', (e) => {
      // @ts-ignore
      const reward = e.data.value
      this.monitoring.log(`Treasury: Total Reward:  ${reward}.`);
      const poolFee = (reward * BigInt(this.fee * 100)) / 10000n
      this.monitoring.log(`Treasury: Pool Fee:  ${poolFee}.`);
      this.emit('coinbase', reward - poolFee)     
      this.emit('revenue', poolFee)
    })

    this.processor.start()
  }
}
