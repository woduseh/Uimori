import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../server/store.js';
import {
  assertRequestFiles,
  prepareRequestFiles,
  readRequestFile,
  releaseRequestFileUploads,
  requestFileRoutes,
  requestFileUploads,
  storeRequestFiles,
} from '../server/request-files.js';
import { readRequestFileBlob } from '../server/request-file-storage.js';
import { readUpload, storeUpload } from '../server/uploads.js';
import type { RequestFileUpload } from '../core/request-files.js';

const stores: { directory: string; store: Store }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-file-storage-'));
  const store = new Store(join(directory, 'story.sqlite'));
  stores.push({ directory, store });
  return store;
}
afterEach(() => {
  for (const { directory, store } of stores.splice(0)) {
    store.close();
    const target = resolve(directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-file-storage-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
async function stage(store: Store, name: string, bytes: Buffer): Promise<RequestFileUpload> {
  const upload = await storeUpload(store.path, Readable.from([bytes]));
  return { uploadId: upload.uploadId, sha256: upload.sha256, name };
}

test('file admission preserves original bytes and names, estimates text only, and stores no unowned blobs', async () => {
  const store = fixture();
  const original = Buffer.from('원래 작성한 자료\nA literal <tag> is still source text.\n', 'utf8');
  const txt = await stage(store, '원문.txt', original);
  const md = await stage(store, '참고.md', original);
  const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const pdf = await stage(store, '도표.pdf', pdfBytes);
  const prepared = prepareRequestFiles(store, [txt, md, pdf]);
  expect(prepared.files.map((file) => file.name)).toEqual(['원문.txt', '참고.md', '도표.pdf']);
  expect(prepared.files[0].hash).toBe(txt.sha256);
  expect(prepared.files[1].hash).toBe(txt.sha256);
  expect(prepared.files[0].tokenEstimate).toBeGreaterThan(0);
  expect(prepared.files[2].tokenEstimate).toBeUndefined();
  expect(store.db.prepare('SELECT count(*) AS n FROM attachment_blobs').get()!.n).toBe(0);
  expect(() =>
    store.transaction(() => {
      storeRequestFiles(store, prepared);
      throw new Error('synthetic admission rejection');
    })
  ).toThrow('synthetic admission rejection');
  expect(store.db.prepare('SELECT count(*) AS n FROM attachment_blobs').get()!.n).toBe(0);
  store.transaction(() => storeRequestFiles(store, prepared));
  expect(store.db.prepare('SELECT count(*) AS n FROM attachment_blobs').get()!.n).toBe(2);
  expect(Buffer.from(readRequestFile(store, prepared.files[0]).base64, 'base64')).toEqual(original);
  expect(readRequestFileBlob(store.db, prepared.files[2].hash).bytes).toEqual(pdfBytes);
  assertRequestFiles(store, prepared.files);
  releaseRequestFileUploads(store, [txt, md, pdf]);
  expect(() => readUpload(store.path, txt.uploadId)).toThrow('UPLOAD_NOT_FOUND');
  expect(Buffer.from(readRequestFile(store, prepared.files[1]).base64, 'base64')).toEqual(original);
});

test('untrusted receipts, changed staging, disguised binaries, and metadata length mismatches are refused', async () => {
  const store = fixture();
  const upload = await stage(store, 'reference.txt', Buffer.from('legitimate UTF-8 input'));
  expect(() => requestFileUploads([{ ...upload, extra: true }])).toThrow('Unknown request field');
  expect(() => requestFileUploads([{ ...upload, name: '../reference.txt' }])).toThrow(
    'REQUEST_FILE_NAME_INVALID'
  );
  expect(() => requestFileUploads([{ ...upload, name: 'program.exe' }])).toThrow(
    'REQUEST_FILE_FORMAT_INVALID'
  );
  expect(() => prepareRequestFiles(store, [{ ...upload, sha256: 'f'.repeat(64) }])).toThrow(
    'REQUEST_FILE_CHANGED'
  );
  const disguised = await stage(store, 'malformed.pdf', Buffer.from('this is ordinary text'));
  expect(() => prepareRequestFiles(store, [disguised])).toThrow('REQUEST_FILE_FORMAT_INVALID');
  const invalidUtf8 = await stage(store, 'invalid.txt', Buffer.from([0xff, 0xfe, 0x00]));
  expect(() => prepareRequestFiles(store, [invalidUtf8])).toThrow('REQUEST_FILE_FORMAT_INVALID');
  const nul = await stage(store, 'binary.json', Buffer.from('text\0binary'));
  expect(() => prepareRequestFiles(store, [nul])).toThrow('REQUEST_FILE_FORMAT_INVALID');
  const prepared = prepareRequestFiles(store, [upload]);
  store.transaction(() => storeRequestFiles(store, prepared));
  const changed = { ...prepared.files[0], bytes: prepared.files[0].bytes + 1 };
  expect(() => assertRequestFiles(store, [changed])).toThrow('REQUEST_FILE_CHANGED');
  expect(() => readRequestFile(store, changed)).toThrow('REQUEST_FILE_CHANGED');
  store.db
    .prepare('UPDATE attachment_blobs SET bytes=? WHERE hash=?')
    .run(Buffer.from('altered bytes'), prepared.files[0].hash);
  expect(() => readRequestFile(store, prepared.files[0])).toThrow('REQUEST_FILE_CHANGED');
});

test('download returns original bytes as an attachment, safely encodes the Unicode name, and rejects missing blobs', async () => {
  const store = fixture();
  const original = Buffer.from('<script>authored reference text</script>');
  const prepared = prepareRequestFiles(store, [await stage(store, '참고 자료.html', original)]);
  store.transaction(() => storeRequestFiles(store, prepared));
  const app = Fastify();
  requestFileRoutes(app, store);
  try {
    const result = await app.inject({
      method: 'GET',
      url: `/api/request-files/${prepared.files[0].hash}?name=${encodeURIComponent('참고 자료.html')}`,
    });
    expect(result.statusCode).toBe(200);
    expect(result.rawPayload).toEqual(original);
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['content-disposition']).toBe(
      'attachment; filename="attachment"; filename*=UTF-8\'\'%EC%B0%B8%EA%B3%A0%20%EC%9E%90%EB%A3%8C.html'
    );
    expect(result.headers['content-type']).toContain('text/html');
    expect((await app.inject(`/api/request-files/${'f'.repeat(64)}`)).statusCode).toBe(404);
    expect(
      (await app.inject(`/api/request-files/${prepared.files[0].hash}?name=bad%0A.txt`)).statusCode
    ).toBe(400);
  } finally {
    await app.close();
  }
});
