import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { defaultProfile } from '../core/product.js';
import { afterEach, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { packagePresentationRoutes } from '../server/package-presentation-routes.js';
import type { ContentPackage } from '../core/content-package.js';
import { editTranslation } from '../server/source-editing.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackageStateCards } from '../web/PackagePresentation.js';

const owned: { app: FastifyInstance; store: Store; dir: string }[] = [];
afterEach(async () => {
  for (const { app, store, dir } of owned.splice(0)) {
    await app.close();
    store.close();
    const within = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-package-display-')
    )
      throw Error('Unsafe fixture cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-package-display-'));
  const store = new Store(join(dir, 'test.sqlite'));
  const app = Fastify();
  packagePresentationRoutes(app, store);
  owned.push({ app, store, dir });
  return { app, store };
}
function source(store: Store, withPackage = true) {
  const chat = createFixtureChat(store, 'Synthetic');
  const pkg: ContentPackage = {
    version: 1,
    id: 'style',
    revision: 1,
    title: 'State',
    description: '',
    lore: [],
    instructions: [],
    controls: [],
    stateView: { title: 'Status', fields: [{ key: 'hp', label: 'HP', format: 'number' }] },
    transforms: [
      { id: 'display', target: 'source', pattern: 'Original', flags: 'g', replacement: 'DISPLAY' },
    ],
  };
  const profile = store.product.snapshot(chat.id) ?? {
    ...defaultProfile(chat.id),
    contents: [],
    models: {},
  };
  const run = store.createRun(
    chat.id,
    {
      request: 'Synthetic',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (c) => ({
      chatId: c.id,
      parentRevision: null,
      settingsRevision: c.settingsRevision,
      settings: c.settings,
      request: 'Synthetic',
      history: [],
      resources: [],
      profile: {
        ...profile,
        ...(withPackage
          ? {
              packageAttachments: [{ id: 'style', revision: 1, role: 'module' as const }],
              packages: [pkg],
            }
          : {}),
      },
    })
  ).run;
  store.startRun(run.id);
  const saved = store.source(
    store.completeRun(
      run.id,
      'Original',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    ).id
  );
  return { chat, run, source: saved };
}
test('presentation API rejects a source owned by another chat and returns frozen display without changing raw', async () => {
  const { app, store } = fixture(),
    a = source(store),
    b = source(store, false);
  const wrong = await injectWithFixtureBot(app, {
    method: 'GET',
    url: `/api/chats/${b.chat.id}/sources/${a.source.id}/presentation`,
  });
  expect(wrong.statusCode).toBe(404);
  const before = store.source(a.source.id);
  const response = await injectWithFixtureBot(app, {
    method: 'GET',
    url: `/api/chats/${a.chat.id}/sources/${a.source.id}/presentation`,
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json();
  expect(body.original.text).toBe('DISPLAY');
  expect(body.stateViews[0].fields[0].missing).toBe(true);
  expect(body.translation).toBeUndefined();
  expect(store.source(a.source.id)).toEqual(before);
});
test('legacy source with no package returns unchanged text and no cards', async () => {
  const { app, store } = fixture(),
    a = source(store, false);
  const response = await injectWithFixtureBot(app, {
    method: 'GET',
    url: `/api/chats/${a.chat.id}/sources/${a.source.id}/presentation`,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().original.changed).toBe(false);
  expect(response.json().stateViews).toEqual([]);
});
test('hidden-story sources preserve their stored body and report disabled transforms', async () => {
  const { app, store } = fixture(),
    a = source(store);
  const snapshot = structuredClone(a.run.snapshot);
  snapshot.sourceSegments = createSourceSegmentFixture();
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), a.run.id);
  const response = await injectWithFixtureBot(app, {
    method: 'GET',
    url: `/api/chats/${a.chat.id}/sources/${a.source.id}/presentation`,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().original.text).toBe('Original');
  expect(response.json().issues).toHaveLength(1);
});
test('manual translation projection uses the latest verified revision and never changes its saved text', async () => {
  const { app, store } = fixture(),
    a = source(store);
  const frozen = structuredClone(a.run.snapshot);
  frozen.profile!.packages![0].transforms.push({
    id: 'tr',
    target: 'translation',
    pattern: '번역',
    flags: 'g',
    replacement: '표시',
  });
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(frozen), a.run.id);
  const first = editTranslation(store, a.source.id, {
    text: '첫 번역',
    expectedRevision: 0,
    expectedSourceHash: a.source.hash,
  });
  const latest = editTranslation(store, a.source.id, {
    text: '새 번역',
    expectedRevision: first.revision ?? 0,
    expectedSourceHash: a.source.hash,
  });
  const response = await injectWithFixtureBot(app, {
    method: 'GET',
    url: `/api/chats/${a.chat.id}/sources/${a.source.id}/presentation`,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().translation.text).toBe('새 표시');
  expect(response.json().translationRevision).toBe(latest.revision);
  expect(store.job(latest.id).result!.text).toBe('새 번역');
});
test('state cards render package text without executing HTML and label missing values explicitly', () => {
  const markup = renderToStaticMarkup(
    createElement(PackageStateCards, {
      data: {
        sourceRevision: 's',
        sourceHash: 'h',
        format: 'plain-text',
        original: { text: '', changed: false, applied: [] },
        translationId: null,
        translationRevision: null,
        issues: [],
        stateViews: [
          {
            packageId: 'p',
            revision: 1,
            role: 'module',
            title: '<script>alert(1)</script>',
            fields: [
              { key: 'a', label: 'Value', text: '<img src=x onerror=alert(1)>', missing: false },
              { key: 'b', label: 'Missing', text: '—', missing: true },
            ],
          },
        ],
      },
    })
  );
  expect(markup).toContain('&lt;script&gt;');
  expect(markup).not.toContain('<script>');
  expect(markup).not.toContain('<img');
  expect(markup).toContain('아직 상태가 없어요');
});
