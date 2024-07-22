# KASPA Mining Pool using rusty-kaspa WASM

In the Stratum app for a Kaspa mining pool, several components work together to manage and distribute mining tasks (jobs) to miners, collect their work (shares), and validate and submit completed blocks to the Kaspa network. Here’s a simplified explanation of how these components interact:

1. **Templates**: Templates represent block templates. They are the initial blocks that miners work on. Each template contains information necessary to create a new block.

2. **Jobs**: Jobs are specific tasks derived from templates. Each job instructs a miner on what work needs to be done.

3. **PoW (Proof of Work)**: PoW is a system that miners use to prove they have done the computational work. It involves finding a nonce (a number) that, when hashed with the block template, meets a certain difficulty target.

4. **Shares**: Shares are pieces of work submitted by miners. Each share represents an attempt to find a valid nonce for the given job. Not all shares will be valid blocks, but they show that the miner is working.

5. **Works and Maps**: These are used to track the progress of each miner. The `works` map keeps track of the current difficulty and shares submitted by each miner.

## How to install
To install dependencies:

```bash
bun install
```

## Database
We are using Postgres as our database:
```sql
CREATE TABLE miners_balance (
  id VARCHAR(255) PRIMARY KEY, 
  miner_id VARCHAR(255), 
  wallet VARCHAR(255),
  balance NUMERIC
);
CREATE TABLE wallet_total (
  address VARCHAR(255) PRIMARY KEY,
  total NUMERIC
);
```

To run:

```bash
TREASURY_PRIVATE_KEY=<private_key> DATABASE_URL='postgresql://<psql_user>:<psql_password>@<psql_hostname>:5432/<psql_db>' bun run index.ts
```

## Docker Compose
create .env file

```
TREASURY_PRIVATE_KEY=<private key>
POSTGRES_USER=<db-user>
POSTGRES_PASSWORD=<db-passwd>
POSTGRES_DB=<db-name>
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@kaspool-db:5432/${POSTGRES_DB}"
```

## Additonal notes
This project was created using `bun init` in bun v1.0.31. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
Special thanks to [KaffinPX](https://github.com/KaffinPX) for providing the foundation of this project.

# App Components Description

### The Mining Cycle: Step-by-Step

1. **Starting the Server**:
   - The Stratum server starts and begins listening for connections from miners.
   - The server connects to the Kaspa network via the RPC client to fetch block templates.

2. **Fetching Block Templates**:
   - The server fetches a new block template from the Kaspa network.
   - It creates a PoW object from the template to help miners validate their work.
   - The block template and PoW object are stored in the `templates` map.

3. **Distributing Jobs to Miners**:
   - A job is created from the block template, encoding the necessary data.
   - The job is sent to all connected miners, instructing them on what work to perform.

4. **Miners Start Working**:
   - Each miner starts working on the job by trying to find a valid nonce.
   - A valid nonce, when combined with the block template and hashed, must meet the difficulty target.

5. **Submitting Shares**:
   - When a miner finds a nonce, they submit a share back to the server.
   - The server checks if the share is valid:
     - It retrieves the PoW object from the `templates` map.
     - It validates the nonce against the difficulty target.
   
6. **Accepting or Rejecting Shares**:
   - **Valid Share**: If the nonce is valid and meets the target, the server:
     - Adds the share to the `works` map for tracking.
     - If the share completes a valid block, it submits the block to the Kaspa network.
     - Notifies the miner of the successful submission.
   - **Invalid Share**: If the nonce is invalid or duplicated:
     - The share is rejected.
     - The miner is notified of the rejection.

7. **Handling New Templates**:
   - As new block templates are created (typically when a new block is added to the blockchain), the server fetches the new templates.
   - The server sends the new job to all miners, starting the cycle again.

### Example Cycle

1. **Server Starts**: The server starts and listens for miners.
2. **Fetch Template**: The server gets a block template from Kaspa.
3. **Create Job**: The server creates a job from the template.
4. **Distribute Job**: The job is sent to miners.
5. **Miners Work**: Miners start finding a valid nonce.
6. **Submit Share**: A miner submits a share.
7. **Validate Share**:
   - **If Valid**:
     - The share is added to `works`.
     - If it's a valid block, it's submitted to Kaspa.
     - Miner is notified of success.
   - **If Invalid**:
     - The share is rejected.
     - Miner is notified of rejection.
8. **New Template**: A new block is added to the blockchain.
9. **Fetch New Template**: The server fetches a new block template, and the cycle repeats.

### Summary

The Stratum app manages the entire lifecycle of mining jobs, from distributing tasks to miners, validating their work, and submitting completed blocks to the Kaspa network. This ensures a smooth and efficient mining operation, with miners continuously working on up-to-date templates and the pool efficiently handling their contributions.

## Stratum

Explanation of the TypeScript Code for the Stratum Part of a Mining Pool in Kaspa
This TypeScript code defines a Stratum class that handles the stratum protocol for a Kaspa mining pool. Stratum is a communication protocol for mining pools, which allows miners to connect to the pool and submit their work. The Stratum class extends EventEmitter to handle various events and includes methods for managing miner connections, contributions, and communication with the mining pool server.

### Detailed Breakdown

#### Imports

- **`Socket`**: Represents a network socket used for communication.
- **`EventEmitter`**: Base class for creating event-driven applications.
- **`randomBytes`**: Used to generate random bytes, typically for extra nonces.
- **`Server`**, **`Miner`**, **`Worker`**: Import server-related entities.
- **`Request`**, **`Response`**, **`Event`**, **`errors`**: Protocol definitions for requests, responses, and errors.
- **`Templates`**: Manages job templates.
- **`calculateTarget`**, **`Address`**: Utilities for target calculation and address validation.
- **`Encoding`**, **`encodeJob`**: Job encoding utilities.

#### Class `Stratum`

##### Properties

- **`server`**: An instance of the `Server` class, handling the mining pool server.
- **`templates`**: Manages job templates.
- **`contributions`**: Tracks contributions from miners.
- **`subscriptors`**: Keeps track of subscribed miners' sockets.
- **`miners`**: Maps miner addresses to their associated sockets.

##### Constructor

- **`templates`**: Templates manager.
- **`port`**: Server port.
- **`initialDifficulty`**: Initial mining difficulty.

Sets up the server, templates, and registers template announcements.

##### Methods

- **`dumpContributions()`**:
  - Clears and returns the current contributions.
  
- **`addShare(address: string, hash: string, difficulty: number, nonce: bigint)`**:
  - Checks for duplicate shares.
  - Validates the work against the target difficulty.
  - Submits the valid block to the templates.
  - Adds the contribution to the map.

- **`announceTemplate(id: string, hash: string, timestamp: bigint)`**:
  - Encodes the job and sends it to all subscribed miners.

- **`reflectDifficulty(socket: Socket<Miner>)`**:
  - Sends the current mining difficulty to a miner.

- **`onMessage(socket: Socket<Miner>, request: Request)`**:
  - Handles various stratum protocol messages (`mining.subscribe`, `mining.authorize`, `mining.submit`).
  - Manages subscriptions, authorizations, and share submissions.

#### `onMessage` Method

- **`mining.subscribe`**:
  - Adds the socket to the subscribers set and emits a subscription event.

- **`mining.authorize`**:
  - Validates the address and manages worker registration.
  - Sets the extra nonce and sends difficulty information.

- **`mining.submit`**:
  - Validates and processes submitted shares.
  - Handles errors and sends appropriate responses.

## Stratum server

This code defines a Server class that sets up and manages TCP socket connections for a stratum server, which is a part of a mining pool infrastructure. It listens for incoming connections, handles incoming data, and processes messages according to the stratum protocol.

### Detailed Breakdown

#### Constructor
- **Parameters**: `port`, `difficulty`, `onMessage`.
- **Function**: 
  - Sets the initial difficulty.
  - Binds the `onMessage` callback.
  - Configures the TCP socket listener to handle connections on the specified port.

#### `onConnect(socket: Socket<Miner>)`
- **Purpose**: Initializes the `data` property of the socket with default miner settings.
- **Function**:
  - Sets the initial difficulty, an empty map for workers, the default encoding, and an empty string for cached bytes.

#### `onData(socket: Socket<Miner>, data: Buffer)`
- **Purpose**: Processes incoming data, splits it into messages, and handles each message.
- **Function**:
  - Appends incoming data to `cachedBytes`.
  - Splits the concatenated string by newline characters to separate messages.
  - Processes each complete message:
    - Parses the message.
    - Invokes the `onMessage` callback with the parsed message.
    - Sends the response back to the miner.
  - Updates `cachedBytes` with any remaining partial message.
  - Ends the connection if `cachedBytes` exceeds 512 characters to prevent potential overflow issues.

This class effectively manages the lifecycle of miner connections, from establishing a connection, receiving and processing data, to responding to requests and handling errors.

## Stratum templates

This TypeScript code defines a Templates class responsible for managing mining job templates for a Kaspa mining pool. The class interfaces with a RpcClient to retrieve new block templates, manage proof-of-work (PoW) computations, and handle job submissions.

### Key Components

1. **Imports**:
   - `IBlock`, `RpcClient`, `Header`, `PoW`: Types and classes from the Kaspa WebAssembly module.
   - `Jobs`: A class handling job-related operations.

2. **Templates Class**:
   - Manages block templates and proof-of-work data.
   - Interacts with the Kaspa RPC client to get new block templates and submit completed work.

### Class Properties

- **`rpc`**: An instance of `RpcClient` to communicate with the Kaspa node.
- **`address`**: The mining pool's payout address.
- **`templates`**: A map storing block templates and their corresponding PoW data.
- **`jobs`**: An instance of the `Jobs` class to manage job-related operations.
- **`cacheSize`**: The maximum number of templates to cache.

### Constructor

- **Parameters**: `rpc`, `address`, `cacheSize`.
- **Function**: Initializes the `rpc` client, payout address, cache size, and sets up the `templates` and `jobs`.

### Methods

#### `getHash(id: string)`

- **Purpose**: Retrieves the hash for a given job ID.
- **Function**: Delegates to the `jobs` instance to get the hash.

#### `getPoW(hash: string)`

- **Purpose**: Retrieves the PoW object for a given block hash.
- **Function**: Looks up the PoW object in the `templates` map.

#### `submit(hash: string, nonce: bigint)`

- **Purpose**: Submits a completed block to the Kaspa node.
- **Function**:
  - Retrieves the block template and header for the given hash.
  - Sets the nonce and finalizes the header.
  - Updates the block template with the new hash.
  - Submits the block via the RPC client.
  - Deletes the template from the cache.

#### `register(callback: (id: string, hash: string, timestamp: bigint) => void)`

- **Purpose**: Registers a callback to handle new block templates.
- **Function**:
  - Adds an event listener for new block templates from the RPC client.
  - Retrieves and processes the new block template.
  - Creates a PoW object for the template.
  - Adds the template and PoW to the `templates` map.
  - Derives a job ID and invokes the callback.
  - Ensures the cache does not exceed the specified size.
  - Subscribes to new block template events via the RPC client.

### Usage

This `Templates` class is integral to managing the lifecycle of mining job templates in the pool. It handles:
- Retrieving new block templates from the Kaspa node.
- Managing the cache of templates and corresponding PoW data.
- Submitting completed blocks back to the node.
- Notifying the mining pool of new job templates.

By efficiently managing these tasks, the `Templates` class ensures that miners always have up-to-date job templates to work on, and completed work is promptly submitted to the Kaspa network.

## Pool

The `Pool` class is designed to manage the interactions between the mining pool's components, such as treasury, stratum, database, and monitoring systems. Here's a breakdown of its components and methods:

### Imports
- **`Treasury`** and **`Stratum`**: Type imports for interacting with the pool's treasury and stratum components.
- **`Database`**: Handles database operations.
- **`Monitoring`**: Manages logging and monitoring of pool activities.
- **`sompiToKaspaStringWithSuffix`, **`IPaymentOutput`**: Utility functions and types from the Kaspa WebAssembly module.

### Class `Pool`

#### Properties
- **`treasury`**: Instance of the `Treasury` class, managing the pool's funds.
- **`stratum`**: Instance of the `Stratum` class, handling miner connections and contributions.
- **`database`**: Instance of the `Database` class, managing miner balances.
- **`monitoring`**: Instance of the `Monitoring` class, logging pool activities.

#### Constructor
- **Parameters**: `treasury`, `stratum`
- **Function**:
  - Initializes the `treasury`, `stratum`, `database`, and `monitoring` properties.
  - Sets up event listeners for miner subscriptions (`subscription`), coinbase transactions (`coinbase`), and revenue (`revenue`).

#### Methods

1. **`revenuize(amount: bigint)`**:
   - Adds the generated revenue to the treasury's address balance.
   - Logs the revenue generation event.

2. **`distribute(amount: bigint)`**:
   - **Purpose**: Distributes rewards to miners based on their contributions.
   - **Process**:
     - Collects contributions from the `stratum`.
     - Calculates the total work done by miners.
     - Logs the distribution event.
     - Distributes the rewards proportionally based on the miners' contributions.
     - Resets the balance for miners who have reached a certain threshold (`1e8`).
     - Sends the payments and logs the successful distribution.

3. **`allocate(amount: bigint)`**:
   - **Purpose**: Allocates rewards to miners based on their contributions (similar to `distribute` but without resetting balances).
   - **Process**:
     - Collects contributions from the `stratum`.
     - Calculates the total work done by miners.
     - Logs the allocation event.
     - Allocates the rewards proportionally based on the miners' contributions.