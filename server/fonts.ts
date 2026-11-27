import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { appearanceEndpoints } from '#contracts';
import { appearanceOperations, fontTitle, type SelectFonts } from '#contracts/operations';
import {
  MAX_FONT_BYTES,
  type FontAsset,
  type FontCatalog,
  type FontFormat,
  type FontPreferences,
} from '../core/fonts.js';
import type { Store } from './store.js';
import { AppError, assertRevision, HelperToolError } from './app-errors.js';
import { parseInput, registerEndpoint } from './endpoint.js';

const key = 'font-preferences';
const MAX_STORED_FONTS = 100;
const MAX_STORED_BYTES = 200 * 1024 * 1024;
const initialized = new WeakSet<Store>();
export function initFonts(store: Store) {
  if (initialized.has(store)) return;
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS font_assets(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, bytes BLOB NOT NULL)'
  );
  initialized.add(store);
}
export function fontPreferences(store: Store): FontPreferences {
  const row = store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key);
  return row ? JSON.parse(String(row.value)) : { revision: 0, appFontId: null, readerFontId: null };
}
export function fontCatalog(store: Store): FontCatalog {
  initFonts(store);
  return {
    fonts: store.db
      .prepare('SELECT metadata FROM font_assets ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(String(row.metadata)) as FontAsset),
    preferences: fontPreferences(store),
  };
}
function readFont(store: Store, id: string) {
  initFonts(store);
  const row = store.db.prepare('SELECT metadata,bytes FROM font_assets WHERE id=?').get(id);
  if (!row) throw new AppError(404, 'FONT_NOT_FOUND');
  return {
    asset: JSON.parse(String(row.metadata)) as FontAsset,
    bytes: Buffer.from(row.bytes as Uint8Array),
  };
}
export function fontFileFormat(bytes: Buffer): FontFormat {
  if (bytes.length > MAX_FONT_BYTES)
    throw new AppError(400, 'FONT_TOO_LARGE', { maxBytes: MAX_FONT_BYTES });
  if (bytes.length < 12) throw new AppError(400, 'FONT_INVALID');
  const signature = bytes.toString('ascii', 0, 4);
  if (signature === 'wOF2' || signature === 'wOFF') {
    const header = signature === 'wOF2' ? 48 : 44;
    if (
      bytes.length < header ||
      bytes.readUInt32BE(8) !== bytes.length ||
      !bytes.readUInt16BE(12) ||
      bytes.readUInt16BE(14) !== 0 ||
      bytes.readUInt32BE(16) > 100 * 1024 * 1024
    )
      throw new AppError(400, 'FONT_INVALID');
    return signature === 'wOF2' ? 'woff2' : 'woff';
  }
  if (signature !== 'OTTO' && bytes.readUInt32BE(0) !== 0x00010000)
    throw new AppError(400, 'FONT_FORMAT_UNSUPPORTED');
  const tables = bytes.readUInt16BE(4);
  if (!tables || 12 + tables * 16 > bytes.length) throw new AppError(400, 'FONT_INVALID');
  for (let index = 0; index < tables; index++) {
    const offset = 12 + index * 16;
    if (bytes.readUInt32BE(offset + 8) + bytes.readUInt32BE(offset + 12) > bytes.length)
      throw new AppError(400, 'FONT_INVALID');
  }
  return signature === 'OTTO' ? 'otf' : 'ttf';
}
export function registerFont(store: Store, input: { title: string; bytes: Uint8Array }): FontAsset {
  initFonts(store);
  const title = parseInput(fontTitle, input.title);
  const bytes = Buffer.from(input.bytes);
  const fontFormat = fontFileFormat(bytes);
  const id = createHash('sha256').update(bytes).digest('hex');
  const existing = store.db.prepare('SELECT metadata FROM font_assets WHERE id=?').get(id);
  if (existing) return JSON.parse(String(existing.metadata));
  const totals = store.db
    .prepare('SELECT count(*) AS count, coalesce(sum(length(bytes)),0) AS total FROM font_assets')
    .get()!;
  if (
    Number(totals.count) >= MAX_STORED_FONTS ||
    Number(totals.total) + bytes.length > MAX_STORED_BYTES
  )
    throw new AppError(400, 'FONT_STORAGE_FULL', {
      maxCount: MAX_STORED_FONTS,
      maxBytes: MAX_STORED_BYTES,
    });
  const asset: FontAsset = {
    id,
    title,
    format: fontFormat,
    mimeType: `font/${fontFormat}`,
    byteLength: bytes.length,
    createdAt: new Date().toISOString(),
  };
  store.db
    .prepare('INSERT INTO font_assets(id,metadata,bytes) VALUES(?,?,?)')
    .run(id, JSON.stringify(asset), bytes);
  store.invalidated('fonts');
  return asset;
}
function writePreferences(store: Store, preferences: FontPreferences) {
  store.db
    .prepare(
      'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
    .run(key, JSON.stringify(preferences));
  store.invalidated('fonts');
  return preferences;
}
export function selectFonts(
  store: Store,
  { expectedRevision, appFontId, readerFontId }: SelectFonts
): FontPreferences {
  return store.transaction(() => {
    assertRevision(fontPreferences(store).revision, expectedRevision);
    for (const id of [appFontId, readerFontId]) if (id !== null) readFont(store, id);
    return writePreferences(store, { revision: expectedRevision + 1, appFontId, readerFontId });
  });
}
export function deleteFont(store: Store, id: string): FontCatalog {
  readFont(store, id);
  return store.transaction(() => {
    store.db.prepare('DELETE FROM font_assets WHERE id=?').run(id);
    store.invalidated('fonts');
    const preferences = fontPreferences(store);
    if (preferences.appFontId === id || preferences.readerFontId === id)
      writePreferences(store, {
        revision: preferences.revision + 1,
        appFontId: preferences.appFontId === id ? null : preferences.appFontId,
        readerFontId: preferences.readerFontId === id ? null : preferences.readerFontId,
      });
    return fontCatalog(store);
  });
}
function publicAddress(address: string) {
  if (isIP(address) === 6)
    return (
      /^[23][0-9a-f]{3}:/i.test(address) &&
      !/^2001:(?:0:|db8:|10:|20:)/i.test(address) &&
      !/^2002:/i.test(address)
    );
  const [a, b] = address.split('.').map(Number);
  return (
    isIP(address) === 4 &&
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19))
  );
}
export async function downloadFont(
  raw: string,
  signal: AbortSignal,
  redirects = 0
): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HelperToolError(400, 'FONT_URL_INVALID');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new HelperToolError(
      400,
      'FONT_URL_NOT_PUBLIC_HTTPS',
      'Use a public HTTPS URL on port 443 without credentials.'
    );
  signal.throwIfAborted();
  const timeout = () => new HelperToolError(400, 'FONT_DOWNLOAD_TIMEOUT');
  const addresses = await new Promise<Awaited<ReturnType<typeof lookup>>[]>((resolve, reject) => {
    const aborted = () => reject(timeout());
    signal.addEventListener('abort', aborted, { once: true });
    void lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
  if (signal.aborted) throw timeout();
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
    throw new HelperToolError(400, 'FONT_URL_PRIVATE_NETWORK');
  const target = addresses[0];
  return new Promise<Buffer>((resolve, reject) => {
    const request = get(
      url,
      {
        signal,
        family: target.family,
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          response.destroy();
          if (!response.headers.location || redirects >= 3) {
            reject(new HelperToolError(400, 'FONT_DOWNLOAD_REDIRECTS'));
            return;
          }
          try {
            void downloadFont(
              new URL(response.headers.location, url).href,
              signal,
              redirects + 1
            ).then(resolve, reject);
          } catch {
            reject(new HelperToolError(400, 'FONT_URL_INVALID'));
          }
          return;
        }
        const tooLarge = () => new AppError(400, 'FONT_TOO_LARGE', { maxBytes: MAX_FONT_BYTES });
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new HelperToolError(400, 'FONT_DOWNLOAD_FAILED', `HTTP ${response.statusCode}`));
          return;
        }
        if (Number(response.headers['content-length']) > MAX_FONT_BYTES) {
          response.destroy();
          reject(tooLarge());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_FONT_BYTES) {
            response.destroy(tooLarge());
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }
    );
    request.on('error', reject);
  });
}
export function fontRoutes(app: FastifyInstance, store: Store) {
  initFonts(store);
  registerEndpoint(app, appearanceEndpoints.listFonts, appearanceOperations.listFonts, () =>
    fontCatalog(store)
  );
  registerEndpoint(
    app,
    appearanceEndpoints.readFontPreferences,
    appearanceOperations.readFontPreferences,
    () => fontPreferences(store)
  );
  registerEndpoint(
    app,
    appearanceEndpoints.selectFonts,
    appearanceOperations.selectFonts,
    (input) => selectFonts(store, input)
  );
  registerEndpoint(
    app,
    appearanceEndpoints.uploadFont,
    appearanceOperations.uploadFont,
    ({ title, data }) => registerFont(store, { title, bytes: Buffer.from(data, 'base64') })
  );
  registerEndpoint(app, appearanceEndpoints.deleteFont, appearanceOperations.deleteFont, ({ id }) =>
    deleteFont(store, id)
  );
  app.get<{ Params: { id: string } }>('/api/fonts/:id/file', (request, reply) => {
    const { asset, bytes } = readFont(store, request.params.id);
    return reply
      .type(asset.mimeType)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .send(bytes);
  });
}
