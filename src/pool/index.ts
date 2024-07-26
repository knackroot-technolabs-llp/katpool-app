import type Treasury from '../treasury';
import type Stratum from '../stratum';
import Database from './database';
import Monitoring from './monitoring';
import { schedule } from 'node-cron';
import { sompiToKaspaStringWithSuffix, type IPaymentOutput } from '../../wasm/kaspa';
import { SharesManager } from '../stratum/sharesManager'; // Import SharesManager


export default class Pool {
  private treasury: Treasury;
  private stratum: Stratum;
  private database: Database;
  private monitoring: Monitoring;
  private sharesManager: SharesManager; // Add SharesManager property  

  constructor(treasury: Treasury, stratum: Stratum, sharesManager: SharesManager) {
    this.treasury = treasury;
    this.stratum = stratum;

    const databaseUrl = process.env.DATABASE_URL; // Add this line
    if (!databaseUrl) { // Add this line
      throw new Error('Environment variable DATABASE_URL is not set.'); // Add this line
    }
    
    this.database = new Database(databaseUrl); // Change this line
    this.monitoring = new Monitoring();
    this.sharesManager = sharesManager; // Initialize SharesManager

    this.stratum.on('subscription', (ip: string, agent: string) => this.monitoring.log(`Pool: Miner ${ip} subscribed into notifications with ${agent}.`));
    this.treasury.on('coinbase', (amount: bigint) => this.allocate(amount));
    //this.treasury.on('coinbase', (amount: bigint) => this.distribute(amount));
    this.treasury.on('revenue', (amount: bigint) => this.revenuize(amount));

    this.monitoring.log(`Pool: Pool is active on port ${this.stratum.server.socket.port}.`);
    // Schedule the distribute function to run at 12 PM and 12 AM
    //schedule('0 0,12 * * *', async () => {
    schedule('0 * * * *', async () => {      
      await this.distribute();
    });

  }

  private async revenuize(amount: bigint) {
    const address = this.treasury.address; // Use the treasury address
    const minerId = 'pool'; // Use a fixed ID for the pool itself
    await this.database.addBalance(minerId, address, amount); // Use the total amount as the share
    this.monitoring.log(`Pool: Treasury generated ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)} revenue over last coinbase.`);
  }
  

  private async distribute() {

    this.monitoring.log(`Pool: Starting distribution of rewards`);
    const balances = await this.database.getAllBalances();
    let payments: IPaymentOutput[] = [];
  
    for (const { minerId, address, balance } of balances) {
      this.monitoring.log(`Pool: payment ${balance} for ${minerId} to wallet ${address}`);
      if (balance >= BigInt(1e8)) {
        payments.push({
          address,
          amount: balance
        });
      }
    }
  
    if (payments.length === 0) {
      return this.monitoring.log(`Pool: No payments found for current distribution cycle.`);
    }
  
    for (const payment of payments) {
      const hash = await this.treasury.send([payment]);
      this.monitoring.log(`Pool: Reward sent: ${hash}.`);
      if (typeof payment.address === 'string') {
        await this.database.resetBalanceByAddress(payment.address);
      } else {
        console.error(`Invalid address type: ${payment.address}`);
      }
      console.error(`Pool: Waiting 10 seconds for payment to ${payment.address}`);
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 1 second between transactions
    }
  }
  
  

  private async allocate(amount: bigint) {
    let works = new Map<string, { minerId: string, difficulty: number }>();
    let totalWork = 0;
  
    for (const contribution of this.sharesManager.dumpContributions()) {
      const { address, difficulty, minerId } = contribution;
      const currentWork = works.get(address) ?? { minerId, difficulty: 0 };
      
      works.set(address, { minerId, difficulty: currentWork.difficulty + difficulty });
      totalWork += difficulty;
    }  
    this.monitoring.log(`Pool: Reward with ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)} is getting ALLOCATED into ${works.size} miners.`);
  
    const scaledTotal = BigInt(totalWork * 100);
  
    for (const [address, work] of works) {
      const scaledWork = BigInt(work.difficulty * 100);
      const share = (scaledWork * amount) / scaledTotal;
  
      const user = await this.database.getUser(work.minerId, address);
  
      await this.database.addBalance(work.minerId, address, share);
    }
  }
  
  
}