import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import type { Content, Library } from '../core/product.js';

test('library summary omits bodies and unrelated assets; exact revision editing and historical reads remain intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-library-loading-'));
  const target = resolve(directory);
  const inside = relative(resolve(tmpdir()), target);
  if (
    isAbsolute(inside) ||
    inside.startsWith('..') ||
    !basename(target).startsWith('uimori-library-loading-')
  )
    throw new Error('Unsafe cleanup path');
  const app = await createApp({
    dbPath: join(directory, 'test.sqlite'),
    buildId: 'library-loading',
    testMode: true,
  });
  try {
    const product = app.store.product;
    const botText = 'Synthetic bot history and personality. '.repeat(2000);
    const loreText = 'Synthetic lore record for an imaginary world. '.repeat(2000);
    const items: Content[] = [];
    for (let i = 0; i < 4; i++)
      items.push(
        product.content({
          kind: i < 2 ? 'bot' : 'module',
          title: `Synthetic ${i}`,
          description: 'Local synthetic measurement',
          text: i < 2 ? botText : loreText,
          loading: i < 2 ? 'pinned' : 'discoverable',
          relatedIds: [],
        }) as Content
      );
    const chat = createFixtureChat(app.store, 'Synthetic asset archive', 'calm', {
      botId: items[0].id,
    });
    for (let i = 0; i < 3; i++)
      product.createAsset(chat.id, {
        title: `Synthetic image ${i}`,
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
        description: 'Synthetic metadata only',
        actor: '',
        outfit: '',
        location: '',
        allowedUse: 'both',
      });
    const bytes: Record<string, number> = {};
    let full!: Library;
    let summary!: Library;
    for (const [name, url] of [
      ['full', '/api/library'],
      ['summary', '/api/library?view=summary'],
    ]) {
      const response = await injectWithFixtureBot(app, { method: 'GET', url });
      expect(response.statusCode).toBe(200);
      bytes[name] = Buffer.byteLength(response.body);
      if (name === 'full') full = response.json();
      else summary = response.json();
    }
    expect(summary.contentBodiesOmitted).toBe(true);
    expect(summary.assetsOmitted).toBe(true);
    expect(summary.contents).toHaveLength(4);
    expect(summary.assets).toHaveLength(0);
    expect(full.assets).toHaveLength(3);
    expect(summary.contents).toEqual(full.contents.map((item) => ({ ...item, text: '' })));
    expect(bytes.summary).toBeLessThan(bytes.full / 100);
    const original = items[0];
    const { id, revision, ...body } = original;
    const changed = product.content(
      { ...body, text: 'Changed exact revision', expectedRevision: revision },
      id
    );
    const oldResponse = await injectWithFixtureBot(app, {
      method: 'GET',
      url: `/api/revisions/content/${id}/${revision}`,
    });
    expect(oldResponse.json()).toEqual(original);
    expect(product.library(true).contents.find((item) => item.id === id)?.revision).toBe(
      changed.revision
    );
    expect(() => product.content({ ...body, expectedRevision: revision }, id)).toThrow();
    expect(
      (await injectWithFixtureBot(app, { method: 'GET', url: '/api/library?view=invalid' }))
        .statusCode
    ).toBe(400);
  } finally {
    await app.close();
    await rm(target, { recursive: true, force: true });
  }
}, 30000);
