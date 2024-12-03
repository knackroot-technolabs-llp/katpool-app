import blake2b, { type Blake2b } from 'blake2b';
import type { IRawHeader } from '../../../../wasm/kaspa/kaspa';

export enum Encoding {
  BigHeader,
  Custom
}

function write16(hasher: Blake2b, value: number) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  hasher.update(Uint8Array.from(buf));
}

function write64(hasher: Blake2b, value: number) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  hasher.update(Uint8Array.from(buf));
}

function writeHexString(hasher: Blake2b, hexString: string) {
  const buf = Buffer.from(hexString, 'hex');
  hasher.update(Uint8Array.from(buf));
}

function serializeBlockHeader(header:any) {
  const key = Uint8Array.from(Buffer.from('BlockHash'))
  const hasher = blake2b(32, key, undefined, undefined, true); 

  const padding = (bw:any) => {
      let len = bw.length + (bw.length % 2);
      while (bw.length < len) {
          bw = "0" + bw;
      }
      return bw;
  };

  write16(hasher, header.version);  
  write64(hasher, header.parentsByLevel.length);  
  
  header.parentsByLevel.forEach((level: string[]) => {
      write64(hasher, level.length);  
      level.forEach(hash => {
          writeHexString(hasher, hash);  
      });
  });

  writeHexString(hasher, header.hashMerkleRoot);
  writeHexString(hasher, header.acceptedIdMerkleRoot);
  writeHexString(hasher, header.utxoCommitment);

  const data = {
      TS: 0n,   
      Bits: header.bits,      
      Nonce: 0n,    
      DAAScore: header.daaScore,  
      BlueScore: header.blueScore 
  };

  const detailsBuff = Buffer.alloc(36);
  detailsBuff.writeBigUInt64LE(data.TS, 0);  
  detailsBuff.writeUInt32LE(data.Bits, 8);   
  detailsBuff.writeBigUInt64LE(data.Nonce, 12); 
  detailsBuff.writeBigUInt64LE(data.DAAScore, 20); 
  detailsBuff.writeBigUInt64LE(data.BlueScore, 28); 

  hasher.update(Uint8Array.from(detailsBuff));

  let bw = header.blueWork;
  bw = padding(bw);
  const bwBuffer = Buffer.from(bw, 'hex');
  write64(hasher, bwBuffer.length); 
  writeHexString(hasher, bw);  
  writeHexString(hasher, header.pruningPoint); 

  const final = hasher.digest();
  return final;
}

function generateJobHeader(headerData: Uint8Array): number[] {
  const ids: BigInt[] = [];
  // Loop to read 8 bytes at a time
  for (let i = 0; i < headerData.length; i += 8) {
      let value = BigInt(0);
      // Read each byte and combine into a 64-bit integer (little-endian)
      for (let j = 0; j < 8; j++) {
          value |= BigInt(headerData[i + j]) << BigInt(j * 8);
      }
      // Push the value to ids as BigInt
      ids.push(value);
  }
  const final: number[] = [];
  // Process each value in ids (convert to hex and back to BigInt)
  for (const v of ids) {
      const asHex = v.toString(16);
      // Convert hex string back to BigInt
      const bb = BigInt('0x' + asHex);  // Prefix '0x' for valid hex format
      final.push(Number(bb));
  }
  return final;
}

export function calculateTarget (bits: bigint) {
  const unshiftedExpt = bits >> 24n
  let mant = bits & BigInt('0xFFFFFF')
  let expt

  if (unshiftedExpt <= 3n) {
    mant = mant >> (8n * (3n - unshiftedExpt))
    expt = 0n
  } else {
    expt = 8n * ((bits >> 24n) - 3n)
  }

  return mant << expt
}

export function encodeJob (hash: string, timestamp: bigint, encoding: Encoding, templateHeader: IRawHeader, headerHash: string) {
  if (encoding === Encoding.BigHeader) {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(timestamp) // hh
  
    return hash + buffer.toString('hex') 
  } 
  else if(encoding === Encoding.Custom) {
    const serializedHeader = serializeBlockHeader(templateHeader);
    const jobParams = generateJobHeader(serializedHeader);
    return jobParams
    // const encoder = new TextEncoder();
    // const bytes = encoder.encode(headerHash);
    // const bigUint64Array = new BigUint64Array(4);
    // const res = [];
    // for (let i = 0; i < bigUint64Array.length; i++) {
    //   const offset = i * 8;
    //   bigUint64Array[i] = new DataView(bytes.buffer).getBigUint64(offset, true); // true for little-endian
    //   res.push(Number(BigInt(bigUint64Array[i].toString(16))));
    // }
    // return res
  } else throw Error('Unknown encoding')
}