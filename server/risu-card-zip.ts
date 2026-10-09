import { crc32, inflateRawSync } from 'node:zlib';
import {
  RISU_IMPORT_MAX_ENTRY_BYTES,
  RISU_IMPORT_MAX_ZIP_MEMBERS,
  risuImportExpandedLimit,
} from '../core/risu-import.js';
import { HttpError } from './request-validation.js';

export const invalidCard = (): never => {
  throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
};
export type CardRangeReader = (offset: number, length: number) => Buffer;

/** ZIP offsets are relative to the archive, including archives appended to JPEG covers. */
export function readCardZip(fileSize: number, read: CardRangeReader): Map<string, () => Buffer> {
  const tailStart = Math.max(0, fileSize - 65_557),
    tail = read(tailStart, fileSize - tailStart);
  let end = tail.length - 22;
  for (; end >= 0; end--)
    if (
      tail.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + tail.readUInt16LE(end + 20) === tail.length
    )
      break;
  if (end < 0) return invalidCard();
  const count = tail.readUInt16LE(end + 10),
    centralSize = tail.readUInt32LE(end + 12);
  const central = tailStart + end - centralSize,
    base = central - tail.readUInt32LE(end + 16);
  if (
    tail.readUInt32LE(end + 4) !== 0 ||
    tail.readUInt16LE(end + 8) !== count ||
    count > RISU_IMPORT_MAX_ZIP_MEMBERS ||
    central < 0 ||
    base < 0
  )
    return invalidCard();
  const members = new Map<string, () => Buffer>();
  let cursor = central,
    expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > tailStart + end) return invalidCard();
    const header = read(cursor, 46);
    if (header.readUInt32LE(0) !== 0x02014b50) return invalidCard();
    const flags = header.readUInt16LE(8),
      method = header.readUInt16LE(10),
      checksum = header.readUInt32LE(16);
    const size = header.readUInt32LE(20),
      length = header.readUInt32LE(24),
      nameLength = header.readUInt16LE(28);
    const next = cursor + 46 + nameLength + header.readUInt16LE(30) + header.readUInt16LE(32);
    const offset = base + header.readUInt32LE(42);
    expanded += length;
    if (
      next > tailStart + end ||
      length > RISU_IMPORT_MAX_ENTRY_BYTES ||
      size > RISU_IMPORT_MAX_ENTRY_BYTES ||
      expanded > risuImportExpandedLimit(fileSize) ||
      flags & 0x41 ||
      ![0, 8].includes(method) ||
      header.readUInt16LE(34) !== 0 ||
      offset + 30 > central
    )
      return invalidCard();
    const rawName = read(cursor + 46, nameLength),
      name = rawName.toString('utf8');
    if (
      !name ||
      name.includes('\0') ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      members.has(name)
    )
      return invalidCard();
    const local = read(offset, 30),
      localNameLength = local.readUInt16LE(26);
    const start = offset + 30 + localNameLength + local.readUInt16LE(28);
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      local.readUInt16LE(6) !== flags ||
      local.readUInt16LE(8) !== method ||
      !rawName.equals(read(offset + 30, localNameLength)) ||
      start + size > central
    )
      return invalidCard();
    members.set(name, () => {
      let value: Buffer;
      try {
        const compressed = read(start, size);
        value =
          method === 0
            ? compressed
            : inflateRawSync(compressed, { maxOutputLength: Math.max(1, length) });
      } catch {
        return invalidCard();
      }
      if (value.length !== length || crc32(value) !== checksum) return invalidCard();
      return value;
    });
    cursor = next;
  }
  if (cursor !== tailStart + end) return invalidCard();
  return members;
}
