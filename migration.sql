ALTER TABLE block_details RENAME COLUMN block_hash TO mined_block_hash;
ALTER TABLE block_details ADD reward_block_hash VARCHAR(255) DEFAULT '';
ALTER TABLE block_details ADD miner_reward BIGINT NOT NULL DEFAULT 0;