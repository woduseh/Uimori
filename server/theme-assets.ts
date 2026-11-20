import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { BUILTIN_THEME_ASSET_FILES } from '../core/builtin-theme-assets.js';
import { MAX_FONT_BYTES } from '../core/fonts.js';
import type { ThemeAsset, ThemeAssetKind } from '../core/themes.js';
import { fontFileFormat } from './fonts.js';
import { processImage, MAX_IMAGE_INPUT_BYTES } from './image-processing.js';
import { HttpError, fields, record, text } from './request-validation.js';
import type { Store } from './store.js';

const MAX_STORED_BYTES = 200 * 1024 * 1024;
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

export function initThemeAssets(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS theme_assets(
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('font','image')),
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

export type StoredThemeAsset = {
  hash: string;
  kind: ThemeAssetKind;
  mime: string;
  byteLength: number;
};

async function normalizedBytes(kind: ThemeAssetKind, bytes: Buffer) {
  if (kind === 'image') {
    const image = await processImage(bytes);
    return { bytes: image.bytes, mime: image.mime };
  }
  return { bytes, mime: `font/${fontFileFormat(bytes)}` };
}

export async function storeThemeAsset(
  db: DatabaseSync,
  kind: ThemeAssetKind,
  input: Buffer
): Promise<StoredThemeAsset> {
  const { bytes, mime } = await normalizedBytes(kind, input);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const existing = db.prepare('SELECT kind,mime FROM theme_assets WHERE hash=?').get(hash);
  if (existing) {
    if (existing.kind !== kind)
      throw new HttpError(400, '같은 파일이 다른 종류로 이미 등록돼 있어요.');
    return { hash, kind, mime: String(existing.mime), byteLength: bytes.length };
  }
  const total = Number(
    db.prepare('SELECT coalesce(sum(length(bytes)),0) AS total FROM theme_assets').get()!.total
  );
  if (total + bytes.length > MAX_STORED_BYTES)
    throw new HttpError(400, '테마 자료 파일 보관 한도(200 MiB)에 도달했어요.');
  db.prepare('INSERT INTO theme_assets(hash,kind,mime,bytes,created_at) VALUES(?,?,?,?,?)').run(
    hash,
    kind,
    mime,
    bytes,
    new Date().toISOString()
  );
  return { hash, kind, mime, byteLength: bytes.length };
}

const builtinRoot = resolve('third_party/theme-assets');
const builtinBytes = new Map<string, Buffer>();
function builtinThemeAsset(hash: string) {
  const entry = BUILTIN_THEME_ASSET_FILES.find((item) => item.hash === hash);
  if (!entry) return null;
  let bytes = builtinBytes.get(hash);
  if (!bytes) {
    bytes = readFileSync(join(builtinRoot, entry.file));
    builtinBytes.set(hash, bytes);
  }
  return { kind: entry.kind, mime: entry.mime, bytes };
}

export function readThemeAsset(db: DatabaseSync, hash: string) {
  const builtin = builtinThemeAsset(hash);
  if (builtin) return builtin;
  const row = db.prepare('SELECT kind,mime,bytes FROM theme_assets WHERE hash=?').get(hash);
  if (!row) throw new HttpError(404, '테마 자료 파일을 찾을 수 없어요.');
  return {
    kind: String(row.kind) as ThemeAssetKind,
    mime: String(row.mime),
    bytes: Buffer.from(row.bytes as Uint8Array),
  };
}

export function assertThemeAssetsStored(db: DatabaseSync, assets: ThemeAsset[] = []) {
  const read = db.prepare('SELECT kind FROM theme_assets WHERE hash=?');
  const copy = db.prepare(
    'INSERT INTO theme_assets(hash,kind,mime,bytes,created_at) VALUES(?,?,?,?,?)'
  );
  for (const asset of assets) {
    let row = read.get(asset.hash);
    const builtin = row ? null : builtinThemeAsset(asset.hash);
    if (builtin) {
      copy.run(asset.hash, builtin.kind, builtin.mime, builtin.bytes, new Date().toISOString());
      row = { kind: builtin.kind };
    }
    if (!row) throw new HttpError(400, `${asset.name}: 자료 파일을 먼저 업로드해 주세요.`);
    if (row.kind !== asset.kind)
      throw new HttpError(400, `${asset.name}: 자료 파일 종류가 업로드한 파일과 달라요.`);
  }
}

export function themeAssetHashes(body: unknown): string[] {
  const assets = (body as { assets?: unknown } | null)?.assets;
  return Array.isArray(assets)
    ? assets.flatMap((asset) =>
        typeof asset?.hash === 'string' && /^[a-f0-9]{64}$/u.test(asset.hash) ? [asset.hash] : []
      )
    : [];
}

export function pruneThemeAssets(db: DatabaseSync, candidates: Iterable<string> | 'abandoned') {
  const referenced = new Set<string>();
  for (const row of db.prepare("SELECT body FROM versions WHERE kind='theme'").all())
    for (const hash of themeAssetHashes(JSON.parse(String(row.body)))) referenced.add(hash);
  for (const row of db.prepare("SELECT model FROM resource_undo WHERE kind='theme'").all())
    for (const hash of themeAssetHashes(JSON.parse(String(row.model)))) referenced.add(hash);
  const remove = db.prepare('DELETE FROM theme_assets WHERE hash=?');
  const pending =
    candidates === 'abandoned'
      ? db
          .prepare('SELECT hash FROM theme_assets WHERE created_at < ?')
          .all(new Date(Date.now() - ABANDONED_AFTER_MS).toISOString())
          .map((row) => String(row.hash))
      : candidates;
  for (const hash of pending) if (!referenced.has(hash)) remove.run(hash);
}

export function themeAssetRoutes(app: FastifyInstance, store: Store) {
  const limit = Math.ceil(Math.max(MAX_FONT_BYTES, MAX_IMAGE_INPUT_BYTES) / 3) * 4;
  app.post('/api/theme-assets', { bodyLimit: limit + 10_000 }, async (request) => {
    const body = record(request.body);
    fields(body, ['kind', 'data']);
    const kind = text(body.kind, 'kind', 10);
    if (kind !== 'font' && kind !== 'image')
      throw new HttpError(400, '글꼴 또는 이미지 자료만 올릴 수 있어요.');
    const data = text(body.data, 'data', limit);
    if (/[^A-Za-z0-9+/=]/.test(data))
      throw new HttpError(400, '자료 파일 데이터가 올바르지 않아요.');
    const bytes = Buffer.from(data, 'base64');
    if (kind === 'font' && bytes.length > MAX_FONT_BYTES)
      throw new HttpError(400, '글꼴 파일은 20 MiB 이하여야 해요.');
    return storeThemeAsset(store.db, kind, bytes);
  });
  app.get<{ Params: { hash: string } }>('/api/theme-assets/:hash', (request, reply) => {
    if (!/^[a-f0-9]{64}$/u.test(request.params.hash))
      throw new HttpError(404, '테마 자료 파일을 찾을 수 없어요.');
    const asset = readThemeAsset(store.db, request.params.hash);
    return reply
      .type(asset.mime)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .send(asset.bytes);
  });
}
