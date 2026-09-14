import { createDecipheriv, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { RISU_IMPORT_MAX_BYTES, type RisuImportSource } from '../core/risu-import.js';
import { cardZip } from './character-card-file.js';
import { hasControl, readImportEnvelope } from './import-envelope.js';
import { HttpError, record } from './request-validation.js';
import { decodeRPack } from './compat/risu/rpack.js';

// The no-eval export ships without its own TypeScript declaration.
const { unpack } = createRequire(import.meta.url)('msgpackr/index-no-eval') as Pick<
  typeof import('msgpackr'),
  'unpack'
>;

const invalid = (): never => {
  throw new HttpError(400, 'RISU_PRESET_INVALID_FILE');
};
const scalarBytes = new Map([
  [0xca, 4],
  [0xcb, 8],
  [0xcc, 1],
  [0xcd, 2],
  [0xce, 4],
  [0xcf, 8],
  [0xd0, 1],
  [0xd1, 2],
  [0xd2, 4],
  [0xd3, 8],
]);
const textFields = new Map([
  ['mainPrompt.md', 'mainPrompt'],
  ['jailbreak.md', 'jailbreak'],
  ['globalNote.md', 'globalNote'],
  ['instructChatTemplate.md', 'instructChatTemplate'],
  ['JinjaTemplate.md', 'JinjaTemplate'],
  ['autoSuggestPrompt.md', 'autoSuggestPrompt'],
  ['groupTemplate.md', 'groupTemplate'],
  ['systemContentReplacement.md', 'systemContentReplacement'],
]);

function utf8(bytes: Buffer): string {
  if (bytes.length > RISU_IMPORT_MAX_BYTES) throw new HttpError(413, 'RISU_IMPORT_TOO_LARGE');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
}

function json(bytes: Buffer): Record<string, unknown> {
  try {
    return record(JSON.parse(utf8(bytes)));
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 413) throw error;
    return invalid();
  }
}

function presetDocument(value: Record<string, unknown>): Record<string, unknown> {
  const preset = value._fileType === 'risup' ? value._presetData : value;
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return invalid();
  const result = preset as Record<string, unknown>;
  if (
    ['spec', 'type', 'data', 'module', 'lorebook', '_fileType', '_presetData'].some(
      (key) => result[key] !== undefined
    ) ||
    (typeof result.name !== 'string' && !Array.isArray(result.promptTemplate)) ||
    (result.name !== undefined &&
      (typeof result.name !== 'string' || !result.name.trim() || result.name.length > 200)) ||
    (result.promptTemplate !== undefined &&
      (!Array.isArray(result.promptTemplate) ||
        result.promptTemplate.some(
          (item) => !item || typeof item !== 'object' || Array.isArray(item)
        ))) ||
    (result.regex !== undefined && !Array.isArray(result.regex)) ||
    ['customPromptTemplateToggle', 'templateDefaultVariables', ...textFields.values()].some(
      (key) => result[key] !== undefined && typeof result[key] !== 'string'
    )
  )
    return invalid();
  return result;
}

/** Bound MessagePack lengths before its decoder allocates arrays or follows nested values. */
function unpackPresetData(bytes: Buffer): unknown {
  let offset = 0,
    nodes = 0;
  const take = (length: number) => {
    if (length > bytes.length - offset) return invalid();
    const start = offset;
    offset += length;
    return start;
  };
  const length = (size: number) => bytes.readUIntBE(take(size), size);
  const visit = (depth: number, key = false): void => {
    if (depth > 128 || ++nodes > 200_000) invalid();
    const token = bytes[take(1)];
    if ((token >= 0xa0 && token <= 0xbf) || [0xd9, 0xda, 0xdb].includes(token)) {
      const size = token < 0xc0 ? token - 0xa0 : length(2 ** (token - 0xd9));
      const start = take(size);
      utf8(bytes.subarray(start, start + size));
      return;
    }
    if (key) invalid();
    if (token < 0x80 || token >= 0xe0 || [0xc0, 0xc2, 0xc3].includes(token)) return;
    if ((token >= 0x90 && token <= 0x9f) || token === 0xdc || token === 0xdd) {
      const count = token < 0xa0 ? token - 0x90 : length(token === 0xdc ? 2 : 4);
      if (count > bytes.length - offset || count > 200_000 - nodes) invalid();
      for (let index = 0; index < count; index++) visit(depth + 1);
      return;
    }
    if ((token >= 0x80 && token <= 0x8f) || token === 0xde || token === 0xdf) {
      const count = token < 0x90 ? token - 0x80 : length(token === 0xde ? 2 : 4);
      if (count * 2 > bytes.length - offset || count * 2 > 200_000 - nodes) invalid();
      for (let index = 0; index < count; index++) {
        visit(depth + 1, true);
        visit(depth + 1);
      }
      return;
    }
    if (token >= 0xc4 && token <= 0xc6) {
      take(length(2 ** (token - 0xc4)));
      return;
    }
    const scalarSize = scalarBytes.get(token);
    if (scalarSize !== undefined) {
      take(scalarSize);
      return;
    }
    // Risu's preset export uses ordinary maps; executable/record/reference extensions are not JSON.
    invalid();
  };
  visit(0);
  if (offset !== bytes.length) return invalid();
  return unpack(bytes);
}

function binaryPreset(bytes: Buffer, rpack: boolean): Record<string, unknown> {
  try {
    const compressed = rpack ? decodeRPack(bytes) : bytes;
    const options = { maxOutputLength: RISU_IMPORT_MAX_BYTES };
    const expanded =
      compressed[0] === 0x1f && compressed[1] === 0x8b
        ? gunzipSync(compressed, options)
        : compressed[0] === 0x78 && (compressed[0] * 256 + compressed[1]) % 31 === 0
          ? inflateSync(compressed, options)
          : inflateRawSync(compressed, options);
    const envelope = record(unpackPresetData(expanded));
    if (envelope.type !== 'preset') return invalid();
    if (envelope.presetVersion !== 0 && envelope.presetVersion !== 2)
      throw new HttpError(400, 'RISU_PRESET_VERSION_UNSUPPORTED');
    const encrypted = envelope.preset ?? envelope.pres;
    if (!(encrypted instanceof Uint8Array) || encrypted.length < 16) return invalid();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      createHash('sha256').update('risupreset', 'utf8').digest(),
      Buffer.alloc(12)
    );
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    const decoded = Buffer.concat([
      decipher.update(encrypted.subarray(0, encrypted.length - 16)),
      decipher.final(),
    ]);
    const preset = presetDocument(record(unpackPresetData(decoded)));
    // A preset is JSON data; reject extension objects, cycles, and excessive nesting.
    const seen = new Set<object>();
    const pending: { value: unknown; depth: number }[] = [{ value: preset, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      if (++nodes > 200_000 || depth > 128) return invalid();
      if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
      if (typeof value === 'number' && Number.isFinite(value)) continue;
      if (!value || typeof value !== 'object' || seen.has(value)) return invalid();
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
        return invalid();
      seen.add(value);
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
    return preset;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE')
      throw new HttpError(413, 'RISU_IMPORT_TOO_LARGE');
    return invalid();
  }
}

/** Read a bounded preset document without writing files or adopting model settings. */
export function readRisuPresetFile(value: unknown): {
  preset: Record<string, unknown>;
  source: RisuImportSource;
  hash: string;
  format: 'risu-preset-json' | 'risu-preset-project-zip' | 'risu-preset-binary';
} {
  const {
    name,
    bytes,
    sha256: hash,
    source,
  } = readImportEnvelope(value, {
    maxBytes: RISU_IMPORT_MAX_BYTES,
    extensions: /\.(?:risup(?:reset)?|zip|json|preset)$/iu,
    invalid: 'RISU_PRESET_INVALID_FILE',
    tooLarge: 'RISU_IMPORT_TOO_LARGE',
    minBytes: 2,
  });
  if (/\.risup(?:reset)?$/iu.test(name))
    return {
      preset: binaryPreset(bytes, /\.risup$/iu.test(name)),
      source,
      hash,
      format: 'risu-preset-binary',
    };
  // The envelope already limited the name to this reader's extensions, so JSON is what is left.
  if (!/\.zip$/iu.test(name))
    return { preset: presetDocument(json(bytes)), source, hash, format: 'risu-preset-json' };
  const members = cardZip(bytes);
  const paths = [...members.keys()];
  if (paths.some((path) => hasControl(path) || /[:\ufffd]/u.test(path))) return invalid();
  const presets = paths.filter((path) => /(?:^|\/)preset\.json$/u.test(path));
  if (presets.length !== 1 || paths.some((path) => /(?:^|\/)(?:card|module)\.json$/u.test(path)))
    return invalid();
  const prefix = presets[0].slice(0, -'preset.json'.length);
  const manifestBytes = members.get(`${prefix}manifest.json`)?.();
  if (!manifestBytes) return invalid();
  const manifest = json(manifestBytes);
  const markerBytes = members.get(`${prefix}.risutoki/workspace.json`)?.();
  if (markerBytes) {
    const marker = json(markerBytes);
    if (marker.version !== 1 || marker.sourceFileType !== 'risup') return invalid();
  }
  const preset = presetDocument(json(members.get(presets[0])!()));
  let expanded = 0;
  for (const [path, field] of Object.entries(manifest)) {
    if (typeof field !== 'string' || textFields.get(path) !== field) return invalid();
    const read = members.get(`${prefix}${path}`);
    if (!read) return invalid();
    const bytes = read();
    expanded += bytes.length;
    if (expanded > RISU_IMPORT_MAX_BYTES) throw new HttpError(413, 'RISU_IMPORT_TOO_LARGE');
    preset[field] = utf8(bytes);
  }
  return { preset, source, hash, format: 'risu-preset-project-zip' };
}
