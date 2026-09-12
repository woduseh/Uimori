import { crc32, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { RISU_IMPORT_MAX_BYTES, type RisuImportSource } from '../core/risu-import.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { moduleJsonDocument } from './risu-module-json.js';

const invalid = (): never => {
  throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
};
const expandedLimit = 64 * 1024 * 1024;

/** Read bounded ZIP members in memory. No extraction, code execution, or remote assets. */
export function cardZip(bytes: Buffer): Map<string, () => Buffer> {
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65_557); end--)
    if (
      bytes.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + bytes.readUInt16LE(end + 20) === bytes.length
    )
      break;
  if (end < Math.max(0, bytes.length - 65_557)) return invalid();
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const central = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt32LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    count > 4096 ||
    central + centralSize !== end
  )
    return invalid();
  const members = new Map<string, () => Buffer>();
  let cursor = central,
    expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) return invalid();
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const size = bytes.readUInt32LE(cursor + 20),
      length = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const next =
      cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    expanded += length;
    if (
      next > end ||
      expanded > expandedLimit ||
      flags & 0x41 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(cursor + 34) !== 0 ||
      offset + 30 > central
    )
      return invalid();
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = rawName.toString('utf8');
    if (
      !name ||
      name.includes('\0') ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      members.has(name)
    )
      return invalid();
    if (
      bytes.readUInt32LE(offset) !== 0x04034b50 ||
      bytes.readUInt16LE(offset + 6) !== flags ||
      bytes.readUInt16LE(offset + 8) !== method
    )
      return invalid();
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + localNameLength + bytes.readUInt16LE(offset + 28);
    if (
      !rawName.equals(bytes.subarray(offset + 30, offset + 30 + localNameLength)) ||
      start + size > central
    )
      return invalid();
    members.set(name, () => {
      let value: Buffer;
      try {
        value =
          method === 0
            ? bytes.subarray(start, start + size)
            : inflateRawSync(bytes.subarray(start, start + size), {
                maxOutputLength: Math.max(1, length),
              });
      } catch {
        return invalid();
      }
      if (value.length !== length || crc32(value) !== checksum) return invalid();
      return value;
    });
    cursor = next;
  }
  if (cursor !== end) return invalid();
  return members;
}

export function readCharacterCard(value: unknown) {
  const input = record(value);
  fields(input, ['name', 'base64']);
  const name = text(input.name, 'file name', 255);
  const base64 = text(input.base64, 'file bytes', Math.ceil(RISU_IMPORT_MAX_BYTES / 3) * 4);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > RISU_IMPORT_MAX_BYTES) throw new HttpError(413, 'RISU_IMPORT_TOO_LARGE');
  if (bytes.toString('base64') !== base64 || bytes.length < 2) return invalid();
  const source: RisuImportSource = { name, base64 };
  const hash = createHash('sha256').update(bytes).digest('hex');
  const zipped = /\.(?:charx|zip)$/iu.test(name) || bytes.readUInt16LE(0) === 0x4b50;
  let members = zipped ? cardZip(bytes) : new Map<string, () => Buffer>();
  const projectFiles = [...members.keys()].filter((path) => /(?:^|\/)module\.json$/u.test(path));
  if (members.has('card.json') && projectFiles.length) return invalid();
  const moduleProject = zipped && !members.has('card.json') && projectFiles.length > 0;
  if (moduleProject && projectFiles.length !== 1) return invalid();
  if (moduleProject) {
    const prefix = projectFiles[0].slice(0, -'module.json'.length);
    members = new Map(
      [...members]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, read]) => [path.slice(prefix.length), read])
    );
  }
  const format = moduleProject
    ? ('risu-module-project-zip' as const)
    : zipped
      ? ('charx' as const)
      : ('character-card-json' as const);
  const cardBytes = zipped ? members.get(moduleProject ? 'module.json' : 'card.json')?.() : bytes;
  if (!cardBytes || cardBytes.length > 8 * 1024 * 1024) return invalid();
  let document: unknown;
  try {
    document = JSON.parse(cardBytes.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return invalid();
  }
  const outer = record(document);
  if ((format === 'character-card-json' || moduleProject) && outer.type === 'risuModule') {
    let assetFiles: string[] = [];
    if (moduleProject) {
      const markerBytes = members.get('.risutoki/workspace.json')?.();
      if (markerBytes) {
        if (markerBytes.length > 256 * 1024) return invalid();
        let marker: ReturnType<typeof record>;
        try {
          marker = record(JSON.parse(markerBytes.toString('utf8').replace(/^\uFEFF/u, '')));
        } catch {
          return invalid();
        }
        if (marker.sourceFileType !== undefined && marker.sourceFileType !== 'risum')
          return invalid();
        if (marker.risumAssetFiles !== undefined) {
          if (!Array.isArray(marker.risumAssetFiles) || marker.risumAssetFiles.length > 2000)
            return invalid();
          assetFiles = marker.risumAssetFiles;
        }
      }
      if (!assetFiles.length)
        assetFiles = [...members.keys()]
          .filter((path) => /^\.risutoki\/risum-assets\/[^/]+\.bin$/u.test(path))
          .sort();
      if (
        assetFiles.some(
          (path) =>
            typeof path !== 'string' ||
            !path ||
            path.startsWith('/') ||
            path.includes('\\') ||
            path.includes('\0') ||
            path.split('/').some((part) => part === '..' || part === '.')
        )
      )
        return invalid();
    }
    return {
      source,
      hash,
      format: moduleProject ? ('risu-module-project-zip' as const) : ('risu-module-json' as const),
      kind: 'module' as const,
      card: moduleJsonDocument(
        outer,
        members,
        assetFiles.map((path) => members.get(path))
      ),
      members,
    };
  }
  if (moduleProject) return invalid();
  if (outer.type !== undefined || outer.lorebook !== undefined || outer.regex !== undefined)
    return invalid();
  if (outer.spec !== undefined && !['chara_card_v2', 'chara_card_v3'].includes(String(outer.spec)))
    return invalid();
  const card = outer.data === undefined ? outer : record(outer.data);
  if (typeof card.name !== 'string' || !card.name.trim() || typeof card.description !== 'string')
    return invalid();
  return { source, hash, format, kind: 'bot' as const, card, members };
}
