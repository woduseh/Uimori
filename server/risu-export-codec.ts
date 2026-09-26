import { createCipheriv, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import {
  RISU_IMPORT_MAX_BYTES,
  RISU_IMPORT_MAX_ENTRY_BYTES,
  RISU_IMPORT_MAX_JSON_BYTES,
  RISU_IMPORT_MAX_UPLOAD_BYTES,
  RISU_IMPORT_MAX_ZIP_MEMBERS,
  risuImportExpandedLimit,
} from '../core/risu-import.js';
import { encodeRPack } from './compat/risu/rpack.js';
import { HttpError } from './request-validation.js';

const { pack } = createRequire(import.meta.url)('msgpackr/index-no-eval') as Pick<
  typeof import('msgpackr'),
  'pack'
>;
export const exportLimit = (size: number, maximum = RISU_IMPORT_MAX_UPLOAD_BYTES) => {
  if (size > maximum) throw new HttpError(413, 'RISU_EXPORT_TOO_LARGE');
};
export function exportJson(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > RISU_IMPORT_MAX_JSON_BYTES) throw new HttpError(413, 'RISU_EXPORT_TOO_LARGE');
  return bytes;
}
export function assertExportPath(path: string): void {
  if (
    !path ||
    path.length > 4000 ||
    /[\\:\p{Cc}]/u.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new HttpError(409, 'RISU_EXPORT_ASSET_PATH');
}
/** Bounded ZIP with UTF-8 member names, CRCs and no filesystem extraction. */
export function writeRisuZip(files: Map<string, Buffer>): Buffer {
  if (files.size > RISU_IMPORT_MAX_ZIP_MEMBERS) throw new HttpError(413, 'RISU_EXPORT_TOO_LARGE');
  let expanded = 0;
  const entries = [...files].map(([name, bytes]) => {
    assertExportPath(name);
    exportLimit(bytes.length, RISU_IMPORT_MAX_ENTRY_BYTES);
    exportLimit((expanded += bytes.length), risuImportExpandedLimit(RISU_IMPORT_MAX_UPLOAD_BYTES));
    const compressed = deflateRawSync(bytes);
    return {
      path: Buffer.from(name),
      bytes,
      compressed,
      checksum: crc32(bytes),
      stored: compressed.length >= bytes.length,
    };
  });
  let size = entries.reduce(
    (size, entry) =>
      size +
      76 +
      entry.path.length * 2 +
      (entry.stored ? entry.bytes.length : entry.compressed.length),
    22
  );
  exportLimit(size);
  // Highly compressible authored files must also pass the importer's expansion protection.
  // Store only enough entries to meet that boundary, preserving compression for the rest.
  const candidates = entries
    .filter((entry) => !entry.stored)
    .sort((a, b) => b.bytes.length - b.compressed.length - (a.bytes.length - a.compressed.length));
  for (const entry of candidates) {
    if (expanded <= risuImportExpandedLimit(size)) break;
    const increase = entry.bytes.length - entry.compressed.length;
    if (size + increase > RISU_IMPORT_MAX_UPLOAD_BYTES) continue;
    entry.stored = true;
    size += increase;
  }
  if (expanded > risuImportExpandedLimit(size)) throw new HttpError(413, 'RISU_EXPORT_TOO_LARGE');
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const { path, bytes, compressed, checksum, stored } of entries) {
    const payload = stored ? bytes : compressed;
    const method = stored ? 0 : 8;
    const header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(path.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(payload.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, path, payload);
    central.push(directory, path);
    offset += header.length + path.length + payload.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  exportLimit(offset + directory.length + end.length);
  return Buffer.concat([...local, directory, end]);
}
/** RisuAI/RisuToki module envelope: magic, RPack JSON, length-prefixed RPack assets, terminator. */
export function writeEmbeddedRisuModule(module: Record<string, unknown>, assets: Buffer[]): Buffer {
  const json = exportJson({ type: 'risuModule', module });
  exportLimit(7 + json.length + assets.reduce((sum, bytes) => sum + 5 + bytes.length, 0));
  const payload = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return [length, encodeRPack(bytes)];
  };
  for (const bytes of assets) exportLimit(bytes.length, RISU_IMPORT_MAX_ENTRY_BYTES);
  return Buffer.concat([
    Buffer.from([111, 0]),
    ...payload(json),
    ...assets.flatMap((bytes) => [Buffer.from([1]), ...payload(bytes)]),
    Buffer.from([0]),
  ]);
}
/** Risu's fixed-key AES-GCM is a file-format codec, not encryption for private storage. */
export function writeRisuPreset(preset: Record<string, unknown>): Buffer {
  exportLimit(Buffer.byteLength(JSON.stringify(preset)), RISU_IMPORT_MAX_BYTES);
  const cipher = createCipheriv(
    'aes-256-gcm',
    createHash('sha256').update('risupreset').digest(),
    Buffer.alloc(12)
  );
  const encrypted = Buffer.concat([
    cipher.update(pack(preset)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const bytes = encodeRPack(
    gzipSync(pack({ presetVersion: 2, type: 'preset', preset: encrypted }))
  );
  exportLimit(bytes.length, RISU_IMPORT_MAX_BYTES);
  return bytes;
}
