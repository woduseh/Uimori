import { createCipheriv, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import {
  RISU_IMPORT_MAX_CONTAINER_BYTES,
  RISU_IMPORT_MAX_JSON_BYTES,
  RISU_IMPORT_MAX_ZIP_MEMBERS,
} from '../core/risu-import.js';
import { encodeRPack } from './compat/risu/rpack.js';
import { HttpError } from './request-validation.js';

const { pack } = createRequire(import.meta.url)('msgpackr/index-no-eval') as Pick<
  typeof import('msgpackr'),
  'pack'
>;
export const exportLimit = (size: number) => {
  if (size > RISU_IMPORT_MAX_CONTAINER_BYTES) throw new HttpError(413, 'RISU_EXPORT_TOO_LARGE');
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
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0,
    expanded = 0;
  for (const [name, bytes] of files) {
    assertExportPath(name);
    exportLimit((expanded += bytes.length));
    const path = Buffer.from(name),
      compressed = deflateRawSync(bytes),
      checksum = crc32(bytes);
    const header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(path.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, path, compressed);
    central.push(directory, path);
    offset += header.length + path.length + compressed.length;
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
  return Buffer.concat([
    Buffer.from([111, 0]),
    ...payload(json),
    ...assets.flatMap((bytes) => [Buffer.from([1]), ...payload(bytes)]),
    Buffer.from([0]),
  ]);
}
/** Risu's fixed-key AES-GCM is a file-format codec, not encryption for private storage. */
export function writeRisuPreset(preset: Record<string, unknown>): Buffer {
  exportJson(preset);
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
  return encodeRPack(gzipSync(pack({ presetVersion: 2, type: 'preset', preset: encrypted })));
}
