import { crc32, inflateRawSync } from 'node:zlib';
import {
  RISU_IMPORT_MAX_ASSETS,
  RISU_IMPORT_MAX_BYTES,
  RISU_IMPORT_MAX_CONTAINER_BYTES,
  RISU_IMPORT_MAX_ENTRY_BYTES,
  RISU_IMPORT_MAX_JSON_BYTES,
  RISU_IMPORT_MAX_ZIP_MEMBERS,
  type RisuImportSource,
  type RisuImportStagedSource,
  type RisuImportKind,
} from '../core/risu-import.js';
import { readImportEnvelope } from './import-envelope.js';
import { HttpError, record } from './request-validation.js';
import { moduleJsonDocument, moduleLoreEntries } from './risu-module-json.js';
import { readEmbeddedRisuModule } from './risu-module-file.js';

const invalid = (): never => {
  throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
};

/** Read bounded ZIP members in memory. No extraction, code execution, or remote assets. */
export function cardZip(bytes: Buffer): Map<string, () => Buffer> {
  // A big container may declare its own contents; an expansion far beyond its size stays refused.
  const totalLimit = Math.max(RISU_IMPORT_MAX_CONTAINER_BYTES, bytes.length * 4);
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
    count > RISU_IMPORT_MAX_ZIP_MEMBERS ||
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
      length > RISU_IMPORT_MAX_ENTRY_BYTES ||
      expanded > totalLimit ||
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

export function readCharacterCard(
  value: unknown,
  kind?: RisuImportKind,
  /** Reads a file the app staged for this import; a large container never enters the body. */
  readStaged?: (uploadId: string) => Buffer
) {
  if (kind !== undefined && kind !== 'bot' && kind !== 'module')
    throw new HttpError(400, 'RISU_IMPORT_KIND');
  const envelope = readImportEnvelope(value, {
    maxBytes: RISU_IMPORT_MAX_BYTES,
    // A card declares its format in its bytes, so every name the shared rule allows is read.
    extensions: /./u,
    invalid: 'RISU_IMPORT_INVALID_FILE',
    tooLarge: 'RISU_IMPORT_TOO_LARGE',
    minBytes: 2,
    staged: readStaged,
  });
  const { name, bytes, sha256: hash } = envelope;
  const source: RisuImportSource | RisuImportStagedSource = envelope.source;
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
  if (!cardBytes || cardBytes.length > RISU_IMPORT_MAX_JSON_BYTES) return invalid();
  let document: unknown;
  try {
    document = JSON.parse(cardBytes.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return invalid();
  }
  const outer = record(document);
  if ((format === 'character-card-json' || moduleProject) && outer.type === 'risuModule') {
    if (kind === 'bot') throw new HttpError(400, 'RISU_IMPORT_KIND');
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
          if (
            !Array.isArray(marker.risumAssetFiles) ||
            marker.risumAssetFiles.length > RISU_IMPORT_MAX_ASSETS
          )
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
  let card = outer.data === undefined ? outer : record(outer.data);
  if (typeof card.name !== 'string' || !card.name.trim() || typeof card.description !== 'string')
    return invalid();
  const embeddedBytes = members.get('module.risum')?.();
  let embeddedModule: { assetCount: number } | undefined;
  if (embeddedBytes) {
    const { module, assets } = readEmbeddedRisuModule(embeddedBytes);
    const extensions = card.extensions == null ? {} : record(card.extensions);
    const risu = extensions.risuai == null ? {} : record(extensions.risuai);
    // This is the card's serialized script/lore section, not another attached package.
    // Empty arrays deliberately replace inline data; only absent/null lore falls back.
    card = {
      ...card,
      extensions: {
        ...extensions,
        risuai: {
          ...risu,
          customScripts: module.regex ?? [],
          triggerscript: module.trigger ?? [],
        },
      },
    };
    if (module.lorebook != null)
      card.character_book = {
        ...(card.character_book == null ? {} : record(card.character_book)),
        entries: moduleLoreEntries(module.lorebook),
      };
    embeddedModule = { assetCount: assets.length };
  }
  return { source, hash, format, kind: kind ?? 'bot', card, members, embeddedModule };
}
