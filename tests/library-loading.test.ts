import { afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { writeChatVariables } from '../server/chat-variables.js';
import { describe } from 'vitest';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import type { Content, Library } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';

test('library summary omits bodies and unrelated assets; current editing rejects stale revisions without retaining old bodies', async () => {
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
    const chat = createFixtureChat(app.store, 'Synthetic asset archive', {
      botId: items[0].id,
    });
    for (let i = 0; i < 3; i++)
      product.createAsset(chat.id, {
        title: `Synthetic image ${i}`,
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPY3RH6HwAGMgKYxcNPSgAAAABJRU5ErkJggg==',
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
    expect(summary.contents).toEqual(
      full.contents.map(({ package: _source, ...metadata }) => ({
        ...metadata,
        text: '',
        hasPackage: true,
      }))
    );
    expect(bytes.summary).toBeLessThan(bytes.full / 100);
    const original = items[0];
    const { id, revision, ...body } = original;
    const changed = product.content(
      {
        ...body,
        package: nativeContent(
          {
            ...body.package.nativeRisu.card,
            description: 'Changed exact revision',
          },
          body.package
        ),
        expectedRevision: revision,
      },
      id
    );
    const oldResponse = await injectWithFixtureBot(app, {
      method: 'GET',
      url: `/api/revisions/content/${id}/${revision}`,
    });
    expect(oldResponse.statusCode).toBe(404);
    expect(oldResponse.json()).toEqual({ error: 'content revision not found' });
    expect(changed.text).toBe('Changed exact revision');
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

describe('Small library summaries and option receipts', () => {
  const owners: { store: Store; path: string }[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const { store, path } of owners.splice(0)) {
      store.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  function database() {
    const path = mkdtempSync(join(tmpdir(), 'uimori-retention-'));
    const owner = { store: new Store(join(path, 'app.sqlite')), path };
    owners.push(owner);
    return owner.store;
  }

  function fixture(count = 4) {
    const store = database();
    const bot = store.product.content(fixtureBotInput()) as Content;
    const chat = importChatTranscript(store, {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: 'Current summary',
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: Array.from({ length: count }, (_, i) => ({
          request: 'Request ' + i,
          text: ('Scene ' + i + '. ' + 'river '.repeat(600)).slice(0, 3000),
          translation: null,
        })),
      },
    }).chat;
    const branch = store.product.branch(chat.id);
    return { store, chat, branch };
  }

  test('library summary never contains preset programs and variable retries never overwrite current values', () => {
    const { store, chat, branch } = fixture();
    const presets = Array.from({ length: 8 }, (_, i) =>
      store.product.promptPreset({
        title: 'Preset ' + i,
        role: 'main',
        text: 'Long prompt. '.repeat(3000),
      })
    );
    const summary = store.product.library(true);
    expect(summary.promptPresets).toHaveLength(8);
    expect(summary.promptPresets!.every((p) => !('program' in p))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(16000);
    expect(store.product.get('prompt-preset', presets[0].id)).toHaveProperty('program');
    const source = store.source(branch.headRevision!);
    let first: Parameters<typeof writeChatVariables>[3] | undefined;
    for (let i = 0; i < 10; i++) {
      const command = {
        expectedRevision: i,
        expectedSourceHash: source.hash,
        idempotencyKey: randomUUID(),
        values: { large: 'v'.repeat(32000), iteration: String(i) },
      };
      first ??= command;
      writeChatVariables(store, chat.id, branch.id, command);
    }
    expect(writeChatVariables(store, chat.id, branch.id, first!).values.iteration).toBe('9');
    expect(
      Buffer.byteLength(
        JSON.stringify(store.db.prepare('SELECT * FROM chat_variable_journal').all())
      )
    ).toBeLessThan(5000);
  });
});
