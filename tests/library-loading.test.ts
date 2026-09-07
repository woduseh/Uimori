import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import type { Content, Library } from '../core/product.js';

test('large library summary omits bodies and unrelated assets; exact revision editing and legacy reads remain intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-library-loading-'));
  const app = await createApp({ dbPath: join(directory, 'test.sqlite'), buildId: 'library-loading', testMode: true });
  try {
    const product = app.store.product;
    const botText = 'Synthetic bot history and personality. '.repeat(2000);
    const loreText = 'Synthetic lore record for an imaginary world. '.repeat(2000);
    const items: Content[] = [];
      for (let i = 0; i < 110; i++) items.push(product.content({ kind: i < 100 ? 'bot' : 'lore', title: `Synthetic ${i}`, description: 'Local synthetic measurement', text: i < 100 ? botText : loreText, loading: i < 100 ? 'pinned' : 'discoverable', relatedIds: [] }) as Content);
      const chat = app.store.createChat('Synthetic asset archive');
      for (let i = 0; i < 1000; i++) product.createAsset(chat.id, { title: `Synthetic image ${i}`, mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', description: 'Synthetic metadata only', actor: '', outfit: '', location: '', allowedUse: 'both' });
    const measurements: Record<string, { bytes: number; elapsedMs: number }> = {};
    let full!: Library; let summary!: Library;
    for (const [name, url] of [['full', '/api/library'], ['summary', '/api/library?view=summary']]) {
      const start = performance.now(); const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      measurements[name] = { bytes: Buffer.byteLength(response.body), elapsedMs: performance.now() - start };
      if (name === 'full') full = response.json(); else summary = response.json();
    }
    expect(summary.contentBodiesOmitted).toBe(true); expect(summary.assetsOmitted).toBe(true);
    expect(summary.contents).toHaveLength(110); expect(summary.assets).toHaveLength(0);
    expect(full.assets).toHaveLength(1000);
    expect(summary.contents).toEqual(full.contents.map(item => ({ ...item, text: '' })));
    expect(measurements.summary.bytes).toBeLessThan(measurements.full.bytes / 100);
    const original = items[0];
    const { id, revision, ...body } = original;
    const changed = product.content({ ...body, text: 'Changed exact revision', expectedRevision: revision }, id);
    const oldResponse = await app.inject({ method: 'GET', url: `/api/revisions/content/${id}/${revision}` });
    expect(oldResponse.json()).toEqual(original);
    expect(product.library(true).contents.find(item => item.id === id)?.revision).toBe(changed.revision);
    expect(() => product.content({ ...body, expectedRevision: revision }, id)).toThrow();
    expect((await app.inject({ method: 'GET', url: '/api/library?view=invalid' })).statusCode).toBe(400);
    const evidence = { libraryLoading: measurements, fixture: { bots: 100, loreEntries: 10, assets: 1000, contentCharacters: 100 * botText.length + 10 * loreText.length, tokenization: 'not performed; character and UTF-8 response byte counts only' } };
    await mkdir('output/library-loading', { recursive: true });
    await writeFile('output/library-loading/summary.json', JSON.stringify(evidence, null, 2));
  } finally {
    await app.close();
    const target = resolve(directory); const inside = relative(resolve(tmpdir()), target);
    if (isAbsolute(inside) || inside.startsWith('..') || !basename(target).startsWith('uimori-library-loading-')) throw new Error('Unsafe cleanup path');
    await rm(target, { recursive: true, force: true });
  }
}, 30000);
