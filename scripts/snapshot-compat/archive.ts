import { createHash } from 'node:crypto';
import { readNativeArchive } from '#dist/server/native-transfer-archive-codec.js';

export function unpack(bytes: Buffer) {
  const members = readNativeArchive(bytes.length, (start, length) =>
    bytes.subarray(start, start + length)
  );
  const manifest = JSON.parse(members.get('manifest.json')!().toString());
  const images = Object.fromEntries(
    [...members]
      .filter(([name]) => name !== 'manifest.json')
      .map(([name, read]) => [name, createHash('sha256').update(read()).digest('hex')])
  );
  return { manifest, images };
}
