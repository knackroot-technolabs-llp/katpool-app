export enum Encoding {
  BigHeader,
  Custom
}

export function encodeJob (hash: string, timestamp: bigint, encoding: Encoding, headerHash: string) {
  if (encoding === Encoding.BigHeader) {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(timestamp) // hh
  
    return hash + buffer.toString('hex') 
  } 
  else if(encoding === Encoding.Custom) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(headerHash);
    const bigUint64Array = new BigUint64Array(4);
    const res = [];
    for (let i = 0; i < bigUint64Array.length; i++) {
      const offset = i * 8;
      bigUint64Array[i] = new DataView(bytes.buffer).getBigUint64(offset, true); // true for little-endian
      res.push(Number(BigInt(bigUint64Array[i].toString(16))));
    }
    return res
  } else throw Error('Unknown encoding')
}