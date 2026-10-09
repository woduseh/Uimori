import { readCardZip } from './risu-card-zip.js';
import { readCardPath } from './risu-card-path.js';
import type { ImportEnvelope } from './import-envelope.js';
import {
  RISU_IMPORT_MAX_ASSETS,
  RISU_IMPORT_MAX_BYTES,
  RISU_IMPORT_MAX_JSON_BYTES,
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

export function cardZip(bytes: Buffer): Map<string, () => Buffer> {
  return readCardZip(bytes.length, (offset, length) => bytes.subarray(offset, offset + length));
}

export async function readCharacterCardPath(
  path: string,
  name: string,
  kind?: RisuImportKind,
  workspaceDirectory?: string
) {
  if (kind !== undefined && kind !== 'bot' && kind !== 'persona' && kind !== 'module')
    throw new HttpError(400, 'RISU_IMPORT_KIND');
  const input = await readCardPath(path, name, workspaceDirectory);
  const result = finishCharacterCard(
    input.envelope,
    kind,
    input.members,
    input.document,
    input.binaryModule,
    true
  );
  return input.png ? { ...result, format: 'character-card-png' as const } : result;
}

export function readCharacterCard(
  value: unknown,
  kind?: RisuImportKind,
  /** Reads a file the app staged for this import; a large container never enters the body. */
  readStaged?: (uploadId: string) => Buffer
) {
  if (kind !== undefined && kind !== 'bot' && kind !== 'persona' && kind !== 'module')
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
  return finishCharacterCard(envelope, kind);
}

function finishCharacterCard(
  envelope: ImportEnvelope,
  kind?: RisuImportKind,
  preparedMembers?: Map<string, () => Buffer>,
  preparedDocument?: unknown,
  preparedModule?: { module: Record<string, unknown>; assets: (() => Buffer)[] },
  requireV3 = false
) {
  const { name, bytes, sha256: hash } = envelope;
  const source: RisuImportSource | RisuImportStagedSource = envelope.source;
  if (/\.risum$/iu.test(name) || (bytes[0] === 111 && bytes[1] === 0)) {
    if (kind === 'bot' || kind === 'persona') throw new HttpError(400, 'RISU_IMPORT_KIND');
    const moduleData = preparedModule ?? readEmbeddedRisuModule(bytes);
    const { module } = moduleData;
    const assets = moduleData.assets.map((asset) =>
      typeof asset === 'function' ? asset : () => asset
    );
    const members = new Map<string, () => Buffer>();
    const card = moduleJsonDocument({ type: 'risuModule', module }, members, assets);
    return {
      source,
      hash,
      format: 'risu-module-binary' as const,
      kind: 'module' as const,
      card,
      nativeCard: {},
      nativeModule: module,
      members,
    };
  }
  const zipped =
    preparedDocument === undefined &&
    (preparedMembers !== undefined ||
      /\.(?:charx|zip|jpg|jpeg)$/iu.test(name) ||
      bytes.readUInt16LE(0) === 0x4b50);
  let members = preparedMembers ?? (zipped ? cardZip(bytes) : new Map<string, () => Buffer>());
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
  if (
    preparedDocument === undefined &&
    (!cardBytes || cardBytes.length > RISU_IMPORT_MAX_JSON_BYTES)
  )
    return invalid();
  let document: unknown = preparedDocument;
  try {
    if (preparedDocument === undefined)
      document = JSON.parse(cardBytes!.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return invalid();
  }
  const outer = record(document);
  if ((format === 'character-card-json' || moduleProject) && outer.type === 'risuModule') {
    if (kind === 'bot' || kind === 'persona') throw new HttpError(400, 'RISU_IMPORT_KIND');
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
      nativeCard: {},
      nativeModule: record(outer.module),
      card: moduleJsonDocument(
        outer,
        members,
        assetFiles.map((path) => members.get(path))
      ),
      members,
    };
  }
  if (moduleProject) return invalid();
  if (requireV3 && outer.spec !== 'chara_card_v3')
    throw new HttpError(400, 'RISU_IMPORT_V3_REQUIRED');
  if (outer.type !== undefined || outer.lorebook !== undefined || outer.regex !== undefined)
    return invalid();
  if (outer.spec !== undefined && !['chara_card_v2', 'chara_card_v3'].includes(String(outer.spec)))
    return invalid();
  let card = outer.data === undefined ? outer : record(outer.data);
  if (Array.isArray(card.assets) && card.assets.length > RISU_IMPORT_MAX_ASSETS) return invalid();
  const nativeCard = structuredClone(card);
  if (typeof card.name !== 'string' || !card.name.trim() || typeof card.description !== 'string')
    return invalid();
  const embeddedBytes = members.get('module.risum')?.();
  let embeddedModule: { assetCount: number } | undefined;
  let nativeModule: Record<string, unknown> | undefined;
  if (embeddedBytes) {
    const { module, assets } = readEmbeddedRisuModule(embeddedBytes);
    nativeModule = module;
    const moduleMembers = new Map<string, () => Buffer>();
    const assetCard = moduleJsonDocument(
      { type: 'risuModule', module: { ...module, name: module.name || card.name } },
      moduleMembers,
      assets.map((asset) => () => asset)
    );
    const moduleAssets = (assetCard.assets as { name: string; uri: string; type: string }[]).map(
      (asset) => {
        const path = asset.uri.replace(/^embeded:\/\//u, '');
        const read = moduleMembers.get(path);
        if (!read) return asset;
        const target = `__risu_module__/${path}`;
        if (members.has(target)) return invalid();
        members.set(target, read);
        return { ...asset, uri: `embeded://${target}` };
      }
    );
    const extensions = card.extensions == null ? {} : record(card.extensions);
    const risu = extensions.risuai == null ? {} : record(extensions.risuai);
    // This is the card's serialized script/lore section, not another attached package.
    // Empty arrays deliberately replace inline data; only absent/null lore falls back.
    card = {
      ...card,
      assets: [...(Array.isArray(card.assets) ? card.assets : []), ...moduleAssets],
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
  if (Array.isArray(card.assets) && card.assets.length > RISU_IMPORT_MAX_ASSETS) return invalid();
  return {
    source,
    hash,
    format,
    kind: kind ?? 'bot',
    card,
    nativeCard,
    nativeModule,
    members,
    embeddedModule,
  };
}
