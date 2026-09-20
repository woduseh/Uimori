import { decodeRPack } from '../../../third_party/risuai/cad8595a/rpack.js';
export { decodeRPack };

// RPack is a byte permutation; invert the pinned decoder instead of maintaining another table.
const encodeMap = Buffer.alloc(256);
for (const [encoded, decoded] of decodeRPack(
  Buffer.from(Array.from({ length: 256 }, (_, i) => i))
).entries())
  encodeMap[decoded] = encoded;
export function encodeRPack(bytes: Uint8Array): Buffer {
  const encoded = Buffer.alloc(bytes.length);
  for (let index = 0; index < bytes.length; index++) encoded[index] = encodeMap[bytes[index]];
  return encoded;
}
