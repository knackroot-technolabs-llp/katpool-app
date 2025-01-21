CREATE TABLE IF NOT EXISTS block_details (
    block_hash VARCHAR(255) PRIMARY KEY,
    miner_id VARCHAR(255), 
    pool_address VARCHAR(255), 
    wallet VARCHAR(255),
    daa_score VARCHAR(255),
    timestamp TIMESTAMP DEFAULT NOW()
);