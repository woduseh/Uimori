import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  RISU_IMPORT_MAX_ASSETS,
  RISU_IMPORT_MAX_ENTRY_BYTES,
  RISU_IMPORT_MAX_JSON_BYTES,
  RISU_IMPORT_MAX_UPLOAD_BYTES,
} from '../core/risu-import.js';
import type { ImportEnvelope } from './import-envelope.js';
import { HttpError, record } from './request-validation.js';
import { base64File, readCardJson } from './risu-card-json.js';
import { readCardModule } from './risu-card-module.js';
import { invalidCard, readCardZip, type CardRangeReader } from './risu-card-zip.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fileReader(path: string) {
  let fd: number | undefined = openSync(path, 'r');
  const read: CardRangeReader = (offset, length) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > RISU_IMPORT_MAX_ENTRY_BYTES * 2
    )
      return invalidCard();
    const own = fd === undefined,
      handle = fd ?? openSync(path, 'r');
    try {
      const bytes = Buffer.alloc(length);
      let n = 0;
      while (n < length) {
        const step = readSync(handle, bytes, n, length - n, offset + n);
        if (!step) return invalidCard();
        n += step;
      }
      return bytes;
    } finally {
      if (own) closeSync(handle);
    }
  };
  return {
    read,
    close() {
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
      }
    },
  };
}

/** Read only the PNG's metadata and attachment chunks; its cover excludes transport chunks. */
function readCardPng(
  size: number,
  read: CardRangeReader,
  directory: string,
  members: Map<string, () => Buffer>
) {
  let cursor = 8,
    document: unknown,
    ended = false,
    assetCount = 0,
    hasV2Card = false;
  const coverPath = join(directory, 'cover.png'),
    cover = openSync(coverPath, 'wx');
  writeSync(cover, pngSignature);
  try {
    while (cursor < size) {
      if (cursor + 12 > size) return invalidCard();
      const header = read(cursor, 8),
        length = header.readUInt32BE(0),
        type = header.toString('ascii', 4, 8);
      if (cursor + 12 + length > size) return invalidCard();
      let key = '',
        payloadOffset = 0;
      if (type === 'tEXt') {
        const first = read(cursor + 8, Math.min(length, 80)),
          separator = first.indexOf(0);
        if (separator < 1 || separator > 79) return invalidCard();
        key = first.toString('latin1', 0, separator);
        payloadOffset = separator + 1;
      }
      const transport = key === 'chara' || key === 'ccv3' || key.startsWith('chara-ext-asset_');
      if (key === 'chara') hasV2Card = true;
      let checksum = crc32(header.subarray(4)),
        output: ReturnType<typeof base64File> | undefined,
        cardText = '';
      const assetIndex = key.replace(/^chara-ext-asset_:?/u, '');
      if (key.startsWith('chara-ext-asset_')) {
        if (
          !/^\d{1,10}$/u.test(assetIndex) ||
          ++assetCount > RISU_IMPORT_MAX_ASSETS ||
          members.has(`__png_asset__/${assetIndex}.bin`)
        )
          return invalidCard();
        output = base64File(join(directory, `png-${assetIndex}.bin`));
      }
      try {
        if (!transport) writeSync(cover, header);
        for (let offset = 0; offset < length; offset += 64 * 1024) {
          const chunk = read(cursor + 8 + offset, Math.min(64 * 1024, length - offset));
          checksum = crc32(chunk, checksum);
          if (!transport) writeSync(cover, chunk);
          else if (key === 'ccv3' || output) {
            const value = chunk.subarray(Math.max(0, payloadOffset - offset)).toString('latin1');
            if (output) output.write(value);
            else {
              cardText += value;
              if (cardText.length > Math.ceil(RISU_IMPORT_MAX_JSON_BYTES / 3) * 4)
                return invalidCard();
            }
          }
        }
        const footer = read(cursor + 8 + length, 4);
        if (footer.readUInt32BE(0) !== checksum) return invalidCard();
        if (!transport) writeSync(cover, footer);
        if (output) {
          output.finish();
          const diskPath = join(directory, `png-${assetIndex}.bin`);
          members.set(`__png_asset__/${assetIndex}.bin`, () => readFileSync(diskPath));
        }
        if (key === 'ccv3') {
          if (document !== undefined) return invalidCard();
          const bytes = Buffer.from(cardText, 'base64');
          if (bytes.toString('base64') !== cardText || bytes.length > RISU_IMPORT_MAX_JSON_BYTES)
            return invalidCard();
          try {
            document = JSON.parse(bytes.toString('utf8'));
          } catch {
            return invalidCard();
          }
        }
      } finally {
        output?.close();
      }
      cursor += length + 12;
      if (type === 'IEND') {
        ended = true;
        break;
      }
    }
  } finally {
    closeSync(cover);
  }
  if (!ended || cursor !== size) return invalidCard();
  if (document === undefined) {
    if (hasV2Card) throw new HttpError(400, 'RISU_IMPORT_V3_REQUIRED');
    return invalidCard();
  }
  if (statSync(coverPath).size > RISU_IMPORT_MAX_ENTRY_BYTES) return invalidCard();
  members.set('__png_cover__.png', () => readFileSync(coverPath));
  const outer = record(document),
    card = record(outer.data);
  if (outer.spec !== 'chara_card_v3') throw new HttpError(400, 'RISU_IMPORT_V3_REQUIRED');
  if (Array.isArray(card.assets))
    for (const value of card.assets) {
      const asset = record(value);
      if (typeof asset.uri !== 'string') continue;
      if (asset.uri === 'ccdefault:') asset.uri = 'embeded://__png_cover__.png';
      else if (/^__asset:\d+$/u.test(asset.uri))
        asset.uri = `embeded://__png_asset__/${asset.uri.slice(8)}.bin`;
    }
  return document;
}

export async function readCardPath(path: string, name: string, workspaceDirectory?: string) {
  const size = statSync(path).size;
  if (size < 2) return invalidCard();
  if (size > RISU_IMPORT_MAX_UPLOAD_BYTES) throw new HttpError(413, 'RISU_IMPORT_TOO_LARGE');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const file = fileReader(path),
    members = new Map<string, () => Buffer>();
  try {
    const signature = file.read(0, Math.min(8, size));
    const envelope: ImportEnvelope = {
      name,
      bytes: signature,
      sha256: hash.digest('hex'),
      staged: true,
      source: { name, uploadId: 'prepared' },
    };
    if (/\.risum$/iu.test(name) || (signature[0] === 111 && signature[1] === 0)) {
      return { envelope, binaryModule: readCardModule(size, file.read) };
    }
    if (signature.equals(pngSignature)) {
      if (!workspaceDirectory)
        throw new Error('PNG preparation requires an owned workspace directory');
      mkdirSync(workspaceDirectory, { recursive: true });
      return {
        envelope,
        members,
        document: readCardPng(size, file.read, workspaceDirectory, members),
        png: true,
      };
    }
    if (
      signature.readUInt16LE(0) === 0x4b50 ||
      signature.readUInt16BE(0) === 0xffd8 ||
      /\.(?:charx|zip)$/iu.test(name)
    )
      return { envelope, members: readCardZip(size, file.read) };
    if (!workspaceDirectory)
      throw new Error('JSON preparation requires an owned workspace directory');
    mkdirSync(workspaceDirectory, { recursive: true });
    const document = await readCardJson(path, workspaceDirectory, members);
    const outer = record(document);
    if (outer.spec === 'chara_card_v2') throw new HttpError(400, 'RISU_IMPORT_V3_REQUIRED');
    return { envelope, members, document };
  } finally {
    file.close();
  }
}
