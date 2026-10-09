import {
  RISU_IMPORT_MAX_ASSETS,
  RISU_IMPORT_MAX_ENTRY_BYTES,
  RISU_IMPORT_MAX_JSON_BYTES,
  risuImportExpandedLimit,
} from '../core/risu-import.js';
import { decodeRPack } from './compat/risu/rpack.js';
import { record } from './request-validation.js';
import { invalidCard, type CardRangeReader } from './risu-card-zip.js';

/** RISUM length records permit indexing each attachment without loading the whole module. */
export function readCardModule(size: number, read: CardRangeReader) {
  let cursor = 0,
    expanded = 0;
  const byte = () => {
    if (cursor >= size) return invalidCard();
    return read(cursor++, 1)[0];
  };
  const payload = (limit: number) => {
    if (cursor + 4 > size) return invalidCard();
    const length = read(cursor, 4).readUInt32LE(0);
    cursor += 4;
    expanded += length;
    if (length > limit || cursor + length > size || expanded > risuImportExpandedLimit(size))
      return invalidCard();
    const offset = cursor;
    cursor += length;
    return () => decodeRPack(read(offset, length));
  };
  if (byte() !== 111 || byte() !== 0) return invalidCard();
  let envelope: ReturnType<typeof record>;
  try {
    envelope = record(
      JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(payload(RISU_IMPORT_MAX_JSON_BYTES)())
      )
    );
  } catch {
    return invalidCard();
  }
  if (envelope.type !== 'risuModule') return invalidCard();
  const module = record(envelope.module),
    metadata = module.assets === undefined ? [] : module.assets;
  if (
    !Array.isArray(metadata) ||
    metadata.length > RISU_IMPORT_MAX_ASSETS ||
    metadata.some(
      (asset) =>
        !Array.isArray(asset) ||
        asset.length < 2 ||
        typeof asset[0] !== 'string' ||
        typeof asset[1] !== 'string'
    )
  )
    return invalidCard();
  const assets: (() => Buffer)[] = [];
  for (;;) {
    const mark = byte();
    if (mark === 0) break;
    if (mark !== 1 || assets.length >= metadata.length) return invalidCard();
    assets.push(payload(RISU_IMPORT_MAX_ENTRY_BYTES));
  }
  if (cursor !== size || assets.length !== metadata.length) return invalidCard();
  return { module, assets };
}
