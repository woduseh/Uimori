import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { invokeHelperSceneTool } from '../server/helper-scene-tools.js';
import { createFixtureChat } from './fixtures/chat.js';

const stores: { store: Store; dir: string }[] = [];
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    store.close();
    const rel = relative(resolve(tmpdir()), resolve(dir));
    if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('uimori-helper-scenes-'))
      throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture(content = 'First paragraph.\nSecond paragraph.') {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-helper-scenes-'));
  const store = new Store(join(dir, 'test.sqlite'));
  stores.push({ store, dir });
  const chatId = createFixtureChat(store, 'Scene tool fixture').id;
  const chat = store.chat(chatId);
  const run = store.createRun(
    chatId,
    {
      request: 'local',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (c) => ({
      chatId,
      parentRevision: c.headRevision,
      settingsRevision: c.settingsRevision,
      settings: c.settings,
      request: 'local',
      history: store.history(c.headRevision),
      resources: [],
    })
  ).run;
  store.startRun(run.id);
  const source = store.source(
    store.completeRun(run.id, content, {
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    }).id
  );
  const call = (name: string, args: Record<string, any>) => {
    if (args.name === 'app.call') {
      expect(args.arguments.name).toBe(name);
      const { chatId: explicitChatId, ...continuation } = args.arguments.arguments;
      expect(explicitChatId).toBe(chatId);
      args = continuation;
    }
    const { chatId: selectedChatId, ...toolArgs } = args;
    if (selectedChatId !== undefined) expect(selectedChatId).toBe(chatId);
    return invokeHelperSceneTool(store, chatId, name, toolArgs) as Record<string, any>;
  };
  const read = (target = 'original') => call('scene.read', { sourceId: source.id, target });
  return { store, chatId, source, call, read };
}

test('literal scene changes save once and fail atomically for ambiguous, overlapping or absent matches', () => {
  const { store, source, call, read } = fixture('One apple. Two pear.');
  const editTarget = read().editTarget;
  expect(() =>
    call('scene.patch', {
      ...editTarget,
      text: 'replacement',
      changes: [{ oldText: 'apple', newText: 'pear' }],
    })
  ).toThrow(/either/);
  for (const changes of [
    [
      { oldText: 'apple', newText: 'plum' },
      { oldText: 'missing', newText: 'x' },
    ],
    [
      { oldText: 'One apple', newText: 'x' },
      { oldText: 'apple', newText: 'y' },
    ],
    [{ oldText: 'e', newText: 'x' }],
  ])
    expect(() => call('scene.patch', { ...editTarget, changes })).toThrow();
  expect(store.source(source.id).text).toBe('One apple. Two pear.');
  expect(store.source(source.id).editRevision).toBe(0);
  const result = call('scene.patch', {
    ...editTarget,
    changes: [
      { oldText: 'apple', newText: 'plum' },
      { oldText: 'pear', newText: 'peach' },
    ],
  });
  expect(result).toMatchObject({ changed: true, revision: 1, translationInvalidated: true });
  expect(store.source(source.id).text).toBe('One plum. Two peach.');
  expect(() => call('scene.patch', { ...editTarget, text: 'Outdated overwrite' })).toThrow(
    /changed/
  );
  const next = read().editTarget;
  expect(() =>
    call('scene.patch', { ...next, expectedSourceHash: '0'.repeat(64), text: 'wrong source' })
  ).toThrow(/changed/);
  expect(call('scene.patch', { ...next, text: 'One plum. Two peach.' })).toMatchObject({
    changed: false,
    revision: 1,
  });
});

test('bounded reads require stable snapshots and reject sources outside the live chat', () => {
  const { store, source, chatId, call } = fixture('abcdefghij');
  const first = call('scene.read', { sourceId: source.id, target: 'original', limit: 4 });
  expect(first).toMatchObject({ text: 'abcd', totalLength: 10, nextOffset: 4 });
  expect(call('scene.read', first.nextRead)).toMatchObject({ text: 'efgh', nextOffset: 8 });
  expect(() => call('scene.read', { sourceId: source.id, target: 'original', offset: 4 })).toThrow(
    /revision/
  );
  call('scene.patch', { ...first.editTarget, text: 'X' });
  expect(() => call('scene.read', first.nextRead)).toThrow(/changed/);
  const other = createFixtureChat(store, 'Other chat').id;
  expect(() =>
    invokeHelperSceneTool(store, other, 'scene.read', { sourceId: source.id, target: 'original' })
  ).toThrow(/ancestry/);
  store.db.prepare('UPDATE chats SET head_revision=NULL WHERE id=?').run(chatId);
  expect(() => call('scene.read', { sourceId: source.id, target: 'original' })).toThrow(/ancestry/);
});

test('literal replacements can normalize whitespace without accepting an empty match', () => {
  const { store, source, call, read } = fixture('First paragraph.\n\n\nLast paragraph.');
  const editTarget = read().editTarget;
  expect(() =>
    call('scene.patch', { ...editTarget, changes: [{ oldText: '', newText: 'unexpected' }] })
  ).toThrow(/old text/);
  expect(
    call('scene.patch', {
      ...editTarget,
      changes: [{ oldText: '\n\n\n', newText: '\n\n' }],
    })
  ).toMatchObject({ changed: true, revision: 1 });
  expect(store.source(source.id).text).toBe('First paragraph.\n\nLast paragraph.');
});

test('scene and retained-version reads reject offsets past the text instead of reporting completion', () => {
  const { source, call, read } = fixture('Short text');
  const editTarget = read().editTarget;
  for (const [name, args] of [
    ['scene.read', editTarget],
    ['scene.versions', { sourceId: source.id, versionRevision: 0 }],
  ] as const) {
    const current = call(name, args);
    const guards = { ...current.editTarget };
    if (name === 'scene.versions') delete guards.target;
    expect(call(name, { ...args, ...guards, offset: 10 })).toMatchObject({
      text: '',
      offset: 10,
      totalLength: 10,
      nextOffset: null,
    });
    expect(() => call(name, { ...args, ...guards, offset: 11 })).toThrow(/offset/);
  }
});

test('retained original versions expose metadata and bounded text, restore as a new edit', () => {
  const { store, source, call, read } = fixture('Initial original');
  for (const content of ['First edit', 'Second edit', 'Third edit'])
    call('scene.patch', { ...read().editTarget, text: content });
  const listing = call('scene.versions', { sourceId: source.id });
  expect(listing.versions.map((v: { revision: number }) => v.revision)).toEqual([3, 2, 0]);
  expect(listing.versions.every((v: object) => !Object.hasOwn(v, 'text'))).toBe(true);
  const first = call('scene.versions', { sourceId: source.id, versionRevision: 0, limit: 7 });
  expect(first.text).toBe('Initial');
  expect(call('scene.versions', first.nextRead).text).toBe(' origin');
  const guards = listing.editTarget;
  expect(() => call('scene.restore', { ...guards, versionRevision: 1 })).toThrow(/retained/);
  expect(call('scene.restore', { ...guards, versionRevision: 0 })).toMatchObject({
    changed: true,
    revision: 4,
  });
  expect(store.source(source.id).text).toBe('Initial original');
  expect(
    call('scene.versions', { sourceId: source.id }).versions.map(
      (v: { revision: number }) => v.revision
    )
  ).toEqual([4, 3, 0]);
  expect(() => call('scene.versions', first.nextRead)).toThrow(/changed/);
  expect(() => call('scene.restore', { ...guards, versionRevision: 0 })).toThrow(/changed/);
});

test('translation editing preserves source, skips no-op writes and invalidates in-flight ownership', () => {
  const { store, source, call, read } = fixture('Original words');
  expect(() => read('translation')).toThrow(/no usable/);
  store.editTranslation(source.id, {
    text: '기존 번역',
    expectedRevision: 0,
    expectedSourceHash: source.hash,
  });
  const first = read('translation');
  expect(first.text).toBe('기존 번역');
  expect(call('scene.patch', { ...first.editTarget, text: '기존 번역' })).toMatchObject({
    changed: false,
    revision: 1,
  });
  expect(read('translation').editTarget.expectedRevision).toBe(1);
  const id = randomUUID();
  const now = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,created_at,updated_at) VALUES(?,?,?,?,'translation','running',2,?,?)"
    )
    .run(id, source.chatId, source.id, source.hash, now, now);
  const pending = read('translation');
  expect(pending).toMatchObject({
    text: '기존 번역',
    editTarget: { expectedRevision: 2 },
    displayedTranslation: { latestJobId: id, latestStatus: 'running', revision: 1 },
  });
  const result = call('scene.patch', {
    ...pending.editTarget,
    changes: [{ oldText: '기존', newText: '수정된' }],
  });
  expect(result).toMatchObject({
    changed: true,
    target: 'translation',
    revision: 3,
    translationInvalidated: false,
  });
  expect(read('translation').text).toBe('수정된 번역');
  expect(store.job(id).status).toBe('cancelled');
  expect(store.source(source.id).text).toBe('Original words');
  call('scene.patch', { ...read().editTarget, text: 'New original' });
  expect(() => read('translation')).toThrow(/no usable/);
});

test('translation pagination detects completion that changes displayed text without a new revision', () => {
  const { store, source, call } = fixture();
  store.editTranslation(source.id, {
    text: 'previous result',
    expectedRevision: 0,
    expectedSourceHash: source.hash,
  });
  const id = randomUUID();
  const now = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,created_at,updated_at) VALUES(?,?,?,?,'translation','running',2,?,?)"
    )
    .run(id, source.chatId, source.id, source.hash, now, now);
  const first = call('scene.read', { sourceId: source.id, target: 'translation', limit: 4 });
  store.db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(id);
  store.db.prepare('INSERT INTO job_results VALUES(?,?,?,?)').run(
    id,
    store.job(id).generation,
    JSON.stringify({
      mock: false,
      sourceRevision: source.id,
      sourceHash: source.hash,
      text: 'newly completed text',
    }),
    now
  );
  expect(() => call('scene.read', first.nextRead)).toThrow(/text changed/);
  expect(() => call('scene.patch', { ...first.editTarget, text: 'stale replacement' })).toThrow(
    /text changed/
  );
});

test('escaped pages stay bounded and continuation never splits Unicode characters', () => {
  const content = `😀${'\u0001'.repeat(12000)}終😀`;
  const { call, source, chatId } = fixture(content);
  let page = call('scene.read', { sourceId: source.id, target: 'original', limit: 10000 });
  let combined = '';
  while (true) {
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(24000);
    combined += page.text;
    if (!page.nextRead) break;
    expect(page.nextRead).toMatchObject({
      name: 'app.call',
      arguments: { name: 'scene.read', arguments: { chatId } },
    });
    page = call('scene.read', page.nextRead);
  }
  expect(combined).toBe(content);
  const first = call('scene.read', { sourceId: source.id, target: 'original', limit: 1 });
  expect(first.text).toBe('😀');
  expect(first.nextOffset).toBe(2);
  expect(() => call('scene.read', { ...first.editTarget, offset: 1, limit: 1 })).toThrow(/Unicode/);
});
