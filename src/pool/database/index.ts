import { Client } from 'pg';

type Miner = {
  balance: bigint;
};

type MinerBalanceRow = {
  miner_id: string;
  wallet: string;
  balance: string;
};

const defaultMiner: Miner = {
  balance: 0n,
};

export default class Database {
  client: Client;

  constructor(connectionString: string) {
    this.client = new Client({
      connectionString: connectionString,
    });
    this.client.connect();
  }

  async addBalance(minerId: string, wallet: string, balance: bigint) {
    const key = `${minerId}_${wallet}`;

    await this.client.query('BEGIN');
    try {
      // Update miners_balance table
      const res = await this.client.query('SELECT balance FROM miners_balance WHERE id = $1', [key]);
      let minerBalance = res.rows[0] ? BigInt(res.rows[0].balance) : 0n;
      minerBalance += balance;

      await this.client.query('INSERT INTO miners_balance (id, miner_id, wallet, balance) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET balance = EXCLUDED.balance', [
        key,
        minerId,
        wallet,
        minerBalance,
      ]);

      // Update wallet_total table
      const resTotal = await this.client.query('SELECT total FROM wallet_total WHERE address = $1', [wallet]);
      let walletTotal = resTotal.rows[0] ? BigInt(resTotal.rows[0].total) : 0n;
      walletTotal += balance;

      await this.client.query('INSERT INTO wallet_total (address, total) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET total = EXCLUDED.total', [
        wallet,
        walletTotal,
      ]);

      await this.client.query('COMMIT');
      return true;
    } catch (e) {
      await this.client.query('ROLLBACK');
      throw e;
    }
  }

  async resetBalanceByAddress(wallet: string) {
    await this.client.query('UPDATE miners_balance SET balance = $1 WHERE wallet = $2', [0n, wallet]);
  }

  async getAllBalances() {
    const res = await this.client.query('SELECT miner_id, wallet, balance FROM miners_balance');
    return res.rows.map((row: MinerBalanceRow) => ({
      minerId: row.miner_id,
      address: row.wallet,
      balance: BigInt(row.balance)
    }));
  }

  async getUser(minerId: string, wallet: string) {
    const key = `${minerId}_${wallet}`;
    const res = await this.client.query('SELECT balance FROM miners_balance WHERE id = $1', [key]);
    if (res.rows.length === 0) {
      return { balance: 0n };
    }
    return { balance: BigInt(res.rows[0].balance) };
  }
}
