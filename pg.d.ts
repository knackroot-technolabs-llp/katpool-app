declare module 'pg' {
  export class Pool {
    constructor(config: any);
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }

  export class Client {
    constructor(config: any);
    connect(): Promise<void>;
    query(queryText: string, values?: any[]): Promise<QueryResult>;
    end(): Promise<void>;
  }

  export interface PoolClient {
    query(queryText: string, values?: any[]): Promise<QueryResult>;
    release(): void;
  }

  export interface QueryResult {
    rows: any[];
    rowCount: number;
  }
}
