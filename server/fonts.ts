import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  MAX_FONT_BYTES,
  type FontAsset,
  type FontCatalog,
  type FontFormat,
  type FontPreferences,
} from '../core/fonts.js';
import type { Store } from './store.js';
import { fields, HttpError, number, record, text } from './request-validation.js';

const key = 'font-preferences';
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
  if (!row) throw new HttpError(404, '글꼴을 찾을 수 없어요.');
  return {
    asset: JSON.parse(String(row.metadata)) as FontAsset,
    bytes: Buffer.from(row.bytes as Uint8Array),
  };
}
function format(bytes: Buffer): FontFormat {
  if (bytes.length < 12 || bytes.length > MAX_FONT_BYTES)
    throw new HttpError(400, '글꼴 파일은 20 MiB 이하여야 해요.');
  const signature = bytes.toString('ascii', 0, 4);
  if (signature === 'wOF2' || signature === 'wOFF') {
    const header = signature === 'wOF2' ? 48 : 44;
    if (bytes.length < header) throw new HttpError(400, '글꼴 헤더가 잘렸어요.');
    const tables = bytes.readUInt16BE(12);
    if (
      bytes.length < header ||
      bytes.readUInt32BE(8) !== bytes.length ||
      !tables ||
      bytes.readUInt16BE(14) !== 0 ||
      bytes.readUInt32BE(16) > 100 * 1024 * 1024
    )
      throw new HttpError(400, '올바른 WOFF 글꼴 파일이 아니에요.');
    return signature === 'wOF2' ? 'woff2' : 'woff';
  }
  if (signature !== 'OTTO' && bytes.readUInt32BE(0) !== 0x00010000)
    throw new HttpError(400, 'WOFF2, WOFF, TTF, OTF 글꼴 파일을 선택해 주세요.');
  const tables = bytes.readUInt16BE(4);
  if (!tables || 12 + tables * 16 > bytes.length)
    throw new HttpError(400, '글꼴 테이블이 올바르지 않아요.');
  for (let index = 0; index < tables; index++) {
    const offset = 12 + index * 16;
    if (bytes.readUInt32BE(offset + 8) + bytes.readUInt32BE(offset + 12) > bytes.length)
      throw new HttpError(400, '글꼴 테이블이 파일 범위를 벗어났어요.');
  }
  return signature === 'OTTO' ? 'otf' : 'ttf';
}
export function registerFont(
  store: Store,
  input: { title: string; bytes: Uint8Array; sourceUrl?: string; license?: string }
): FontAsset {
  initFonts(store);
  const title = text(input.title, 'title', 200).trim();
  const bytes = Buffer.from(input.bytes);
  const fontFormat = format(bytes);
  const sourceUrl =
    input.sourceUrl === undefined ? undefined : text(input.sourceUrl, 'source URL', 2000);
  if (sourceUrl) {
    let url: URL;
    try {
      url = new URL(sourceUrl);
    } catch {
      throw new HttpError(400, '글꼴 출처 URL을 확인해 주세요.');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new HttpError(400, '글꼴 출처 URL을 확인해 주세요.');
  }
  const license = input.license === undefined ? undefined : text(input.license, 'license', 4000);
  const id = createHash('sha256').update(bytes).digest('hex');
  const existing = store.db.prepare('SELECT metadata FROM font_assets WHERE id=?').get(id);
  if (existing) return JSON.parse(String(existing.metadata));
  const totals = store.db
    .prepare('SELECT count(*) AS count, coalesce(sum(length(bytes)),0) AS total FROM font_assets')
    .get()!;
  if (Number(totals.count) >= 100 || Number(totals.total) + bytes.length > 200 * 1024 * 1024)
    throw new HttpError(400, '글꼴 보관 한도(100개, 200 MiB)에 도달했어요.');
  const asset: FontAsset = {
    id,
    title,
    format: fontFormat,
    mimeType: `font/${fontFormat}`,
    byteLength: bytes.length,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(license ? { license } : {}),
    createdAt: new Date().toISOString(),
  };
  store.db
    .prepare('INSERT INTO font_assets(id,metadata,bytes) VALUES(?,?,?)')
    .run(id, JSON.stringify(asset), bytes);
  return asset;
}
function writePreferences(store: Store, preferences: FontPreferences) {
  store.db
    .prepare(
      'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
    .run(key, JSON.stringify(preferences));
  return preferences;
}
export function selectFonts(store: Store, input: unknown): FontPreferences {
  const body = record(input);
  fields(body, ['expectedRevision', 'appFontId', 'readerFontId']);
  const revision = number(body.expectedRevision, 'revision', 0);
  const selected = (value: unknown) => {
    if (value === null) return null;
    const id = text(value, 'font ID', 64);
    readFont(store, id);
    return id;
  };
  const appFontId = selected(body.appFontId);
  const readerFontId = selected(body.readerFontId);
  return store.transaction(() => {
    if (fontPreferences(store).revision !== revision)
      throw new HttpError(409, '다른 창에서 글꼴 선택을 바꿨어요. 다시 불러와 주세요.');
    return writePreferences(store, { revision: revision + 1, appFontId, readerFontId });
  });
}
export function deleteFont(store: Store, id: string): FontCatalog {
  readFont(store, id);
  return store.transaction(() => {
    store.db.prepare('DELETE FROM font_assets WHERE id=?').run(id);
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
    throw new HttpError(400, '글꼴 URL을 확인해 주세요.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new HttpError(400, '공개 HTTPS 글꼴 URL만 사용할 수 있어요.');
  signal.throwIfAborted();
  const addresses = await new Promise<Awaited<ReturnType<typeof lookup>>[]>((resolve, reject) => {
    const aborted = () => reject(new HttpError(400, '글꼴 다운로드 시간이 초과됐어요.'));
    signal.addEventListener('abort', aborted, { once: true });
    void lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
  if (signal.aborted) throw new HttpError(400, '글꼴 다운로드 시간이 초과됐어요.');
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
    throw new HttpError(400, '사설 네트워크 주소에서는 글꼴을 가져올 수 없어요.');
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
            reject(new HttpError(400, '글꼴 다운로드 리디렉션이 너무 많아요.'));
            return;
          }
          try {
            void downloadFont(
              new URL(response.headers.location, url).href,
              signal,
              redirects + 1
            ).then(resolve, reject);
          } catch {
            reject(new HttpError(400, '글꼴 다운로드 주소를 확인해 주세요.'));
          }
          return;
        }
        if (
          response.statusCode !== 200 ||
          Number(response.headers['content-length']) > MAX_FONT_BYTES
        ) {
          response.destroy();
          reject(new HttpError(400, '글꼴 파일을 다운로드할 수 없어요.'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_FONT_BYTES) {
            response.destroy(new HttpError(400, '글꼴 파일은 20 MiB 이하여야 해요.'));
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
export async function importFontFromUrl(
  store: Store,
  input: { title: string; url: string; license?: string }
): Promise<FontAsset> {
  const bytes = await downloadFont(input.url, AbortSignal.timeout(15000));
  return registerFont(store, { ...input, sourceUrl: input.url, bytes });
}
export function fontRoutes(app: FastifyInstance, store: Store) {
  initFonts(store);
  app.get('/api/fonts', () => fontCatalog(store));
  app.get('/api/font-preferences', () => fontPreferences(store));
  app.put('/api/font-preferences', (request) => selectFonts(store, request.body));
  app.post('/api/fonts', { bodyLimit: Math.ceil((MAX_FONT_BYTES * 4) / 3) + 10000 }, (request) => {
    const body = record(request.body);
    fields(body, ['title', 'data', 'sourceUrl', 'license']);
    const data = text(body.data, 'font data', Math.ceil((MAX_FONT_BYTES * 4) / 3));
    if (/[^A-Za-z0-9+/=]/.test(data) || Buffer.from(data, 'base64').toString('base64') !== data)
      throw new HttpError(400, '글꼴 데이터가 올바르지 않아요.');
    return registerFont(store, {
      title: body.title,
      bytes: Buffer.from(data, 'base64'),
      sourceUrl: body.sourceUrl,
      license: body.license,
    });
  });
  app.delete<{ Params: { id: string } }>('/api/fonts/:id', (request) =>
    deleteFont(store, request.params.id)
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
