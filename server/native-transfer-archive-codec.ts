import { crc32 } from 'node:zlib';
import { Readable } from 'node:stream';
import { HttpError } from './request-validation.js';
import {
  NATIVE_ARCHIVE_MAX_BYTES,
  NATIVE_ARCHIVE_METADATA_MAX_BYTES,
} from '../core/native-archive.js';
export {
  NATIVE_ARCHIVE_MAX_BYTES,
  NATIVE_ARCHIVE_METADATA_MAX_BYTES,
} from '../core/native-archive.js';
const invalid = (): never => {
  throw new HttpError(400, '자료 백업 파일을 확인해 주세요.');
};

/** Stored ZIP members: image bytes are already compressed, so recompression only wastes CPU. */
export function nativeArchiveStream(
  entries: Iterable<{ name: string; read: () => Buffer }>
): Readable {
  return Readable.from(
    (async function* () {
      const central: Buffer[] = [];
      let offset = 0;
      for (const entry of entries) {
        const name = Buffer.from(entry.name),
          bytes = entry.read(),
          checksum = crc32(bytes);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x800, 6);
        header.writeUInt32LE(checksum, 14);
        header.writeUInt32LE(bytes.length, 18);
        header.writeUInt32LE(bytes.length, 22);
        header.writeUInt16LE(name.length, 26);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50);
        record.writeUInt16LE(20, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt16LE(0x800, 8);
        record.writeUInt32LE(checksum, 16);
        record.writeUInt32LE(bytes.length, 20);
        record.writeUInt32LE(bytes.length, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([record, name]));
        offset += header.length + name.length + bytes.length;
        if (offset > NATIVE_ARCHIVE_MAX_BYTES || central.length > 65_535) invalid();
        yield header;
        yield name;
        yield bytes;
      }
      const size = central.reduce((sum, entry) => sum + entry.length, 0),
        end = Buffer.alloc(22);
      if (offset + size + end.length > NATIVE_ARCHIVE_MAX_BYTES) invalid();
      end.writeUInt32LE(0x06054b50);
      end.writeUInt16LE(central.length, 8);
      end.writeUInt16LE(central.length, 10);
      end.writeUInt32LE(size, 12);
      end.writeUInt32LE(offset, 16);
      for (const record of central) yield record;
      yield end;
    })()
  );
}

/** Our archive deliberately accepts only bounded stored entries, not arbitrary ZIP compression. */
export function readNativeArchive(size: number, read: (offset: number, length: number) => Buffer) {
  if (size < 22 || size > NATIVE_ARCHIVE_MAX_BYTES) invalid();
  const end = read(size - 22, 22);
  if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt32LE(4) || end.readUInt16LE(20)) invalid();
  const count = end.readUInt16LE(10),
    centralSize = end.readUInt32LE(12),
    start = end.readUInt32LE(16);
  if (count !== end.readUInt16LE(8) || start + centralSize !== size - 22) invalid();
  const members = new Map<string, () => Buffer>();
  let cursor = start,
    lastEnd = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size - 22) invalid();
    const header = read(cursor, 46),
      length = header.readUInt32LE(24),
      compressed = header.readUInt32LE(20);
    const nameLength = header.readUInt16LE(28),
      offset = header.readUInt32LE(42),
      flags = header.readUInt16LE(8);
    const next = cursor + 46 + nameLength;
    if (
      header.readUInt32LE(0) !== 0x02014b50 ||
      flags !== 0x800 ||
      header.readUInt16LE(10) ||
      header.readUInt16LE(30) ||
      header.readUInt16LE(32) ||
      header.readUInt16LE(34) ||
      compressed !== length ||
      next > size - 22 ||
      offset !== lastEnd ||
      offset + 30 > start
    )
      invalid();
    const rawName = read(cursor + 46, nameLength),
      name = rawName.toString('utf8');
    if (name !== 'manifest.json' && !/^images\/[a-f0-9]{64}\.bin$/u.test(name)) invalid();
    if (
      members.has(name) ||
      length > (name === 'manifest.json' ? NATIVE_ARCHIVE_METADATA_MAX_BYTES : 64 * 1024 * 1024)
    )
      invalid();
    const local = read(offset, 30),
      dataOffset = offset + 30 + nameLength;
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      local.readUInt16LE(6) !== flags ||
      local.readUInt16LE(8) ||
      local.readUInt16LE(26) !== nameLength ||
      local.readUInt16LE(28) ||
      local.readUInt32LE(18) !== length ||
      local.readUInt32LE(22) !== length ||
      local.readUInt32LE(14) !== header.readUInt32LE(16) ||
      !rawName.equals(read(offset + 30, nameLength)) ||
      dataOffset + length > start
    )
      invalid();
    members.set(name, () => {
      const bytes = read(dataOffset, length);
      if (crc32(bytes) !== header.readUInt32LE(16)) invalid();
      return bytes;
    });
    lastEnd = dataOffset + length;
    cursor = next;
  }
  if (cursor !== size - 22 || lastEnd !== start || !members.has('manifest.json')) invalid();
  return members;
}
