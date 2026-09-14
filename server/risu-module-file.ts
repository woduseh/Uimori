import { HttpError } from './request-validation.js';
import { decodeRPack } from './compat/risu/rpack.js';

const jsonLimit = 8 * 1024 * 1024;
const expandedLimit = 64 * 1024 * 1024;
const assetLimit = 2000;
const invalid = (): never => {
  throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};

/** Decode only a CharX embedded module in memory; never execute or resolve its contents. */
export function readEmbeddedRisuModule(bytes: Buffer): {
  module: Record<string, unknown>;
  assets: Buffer[];
} {
  if (bytes.length > expandedLimit) return invalid();
  let cursor = 0;
  const byte = () => {
    if (cursor >= bytes.length) return invalid();
    return bytes[cursor++];
  };
  const payload = (maximum: number) => {
    if (cursor + 4 > bytes.length) return invalid();
    const length = bytes.readUInt32LE(cursor);
    cursor += 4;
    if (length > maximum || length > bytes.length - cursor) return invalid();
    const value = bytes.subarray(cursor, cursor + length);
    cursor += length;
    return decodeRPack(value);
  };
  if (byte() !== 111 || byte() !== 0) return invalid();
  const main = payload(jsonLimit);
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(main));
  } catch {
    return invalid();
  }
  const envelope = object(document);
  if (envelope.type !== 'risuModule') return invalid();
  const module = object(envelope.module);
  const metadata = module.assets === undefined ? [] : module.assets;
  if (
    !Array.isArray(metadata) ||
    metadata.length > assetLimit ||
    metadata.some(
      (asset: unknown) =>
        !Array.isArray(asset) ||
        asset.length < 2 ||
        typeof asset[0] !== 'string' ||
        typeof asset[1] !== 'string'
    )
  )
    return invalid();
  const assets: Buffer[] = [];
  for (;;) {
    const mark = byte();
    if (mark === 0) break;
    if (mark !== 1 || assets.length >= metadata.length) return invalid();
    assets.push(payload(expandedLimit));
  }
  if (cursor !== bytes.length || assets.length !== metadata.length) return invalid();
  return { module, assets };
}
