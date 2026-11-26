import { countTextTokens } from '../core/text-tokens.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../server/store.js';
import { invokeHelperSceneTool } from '../server/helper-scene-tools.js';
import { latestTranslation } from '../server/source-editing.js';
import { invokeSceneRegexSearch } from '../server/helper-data-tools.js';
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
    [{ oldText: '', newText: 'unexpected' }],
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
  expect(result.editTarget).toEqual(next);
  expect(() =>
    call('scene.patch', { ...next, expectedSourceHash: '0'.repeat(64), text: 'wrong source' })
  ).toThrow(/changed/);
  expect(call('scene.patch', { ...next, text: 'One plum. Two peach.' })).toMatchObject({
    changed: false,
    revision: 1,
  });
});

test('scene changes tolerate CRLF and line-end whitespace once and keep curved quotes byte-identical', () => {
  const text = '“가지 마,” 그가 말했다.  \r\n‘알았어’ — 그녀가 답했다.\r\n다음 줄 \n다음 줄\t\n끝';
  const { store, source, call, read } = fixture(text);
  const editTarget = read().editTarget;
  expect(() =>
    call('scene.patch', { ...editTarget, changes: [{ oldText: '다음 줄\n', newText: 'x\n' }] })
  ).toThrow(/count mismatch/);
  expect(() =>
    call('scene.patch', {
      ...editTarget,
      changes: [{ oldText: '다음 줄\n', newText: 'x\n', expectedCount: 2 }],
    })
  ).toThrow(/count mismatch/);
  expect(store.source(source.id).text).toBe(text);
  const result = call('scene.patch', {
    ...editTarget,
    changes: [{ oldText: '말했다.\n‘알았어’', newText: '외쳤다.\n‘알았어’' }],
  });
  expect(result).toMatchObject({
    changed: true,
    matches: [{ changeIndex: 0, normalization: 'line-end-whitespace' }],
  });
  const saved = store.source(source.id).text;
  expect(saved).toBe(text.replace('말했다.  \r\n‘알았어’', '외쳤다.\n‘알았어’'));
  expect(saved.slice(0, saved.indexOf('그가'))).toBe('“가지 마,” ');
  expect(saved).toContain('‘알았어’ — 그녀가');
});

test('exact-count replacements are atomic and reject overlap, mismatch and stale guards', () => {
  const { store, source, call, read } = fixture('Chihiro-han, my lord! Chihiro-han, my lord!');
  const editTarget = read().editTarget;
  const changes = [
    { oldText: 'Chihiro-han', newText: 'Chihiro-san', expectedCount: 2 },
    { oldText: 'my lord', newText: 'Producer', expectedCount: 2 },
  ];
  for (const invalid of [
    [{ ...changes[0], expectedCount: 3 }, changes[1]],
    [changes[0], { oldText: 'my lord', newText: 'Producer' }],
    [{ oldText: 'Chihiro', newText: 'M', expectedCount: 2 }, changes[0]],
    [changes[0], { ...changes[0] }],
    [{ ...changes[0], expectedCount: 0 }],
    [{ ...changes[0], expectedCount: 1.5 }],
  ]) {
    expect(() => call('scene.patch', { ...editTarget, changes: invalid })).toThrow();
    expect(store.source(source.id).editRevision).toBe(0);
  }
  expect(call('scene.patch', { ...editTarget, changes })).toMatchObject({
    changed: true,
    revision: 1,
    translationInvalidated: true,
  });
  expect(store.source(source.id).text).toBe('Chihiro-san, Producer! Chihiro-san, Producer!');
  expect(() => call('scene.patch', { ...editTarget, changes })).toThrow(/changed/);
});

test('live literal search pages matches, preserves counts and provides patch guards', () => {
  const { store, source, call } = fixture('😀 Chihiro-han A Chihiro-han B Chihiro-han');
  const args = {
    sourceId: source.id,
    target: 'original',
    patterns: ['Chihiro-han', 'chihiro-han', '😀'],
    context: 2,
    limit: 2,
  };
  const first = call('scene.search', args);
  expect(first).toMatchObject({
    totalMatches: 4,
    counts: [{ count: 3 }, { count: 0 }, { count: 1 }],
    matches: [{ patternIndex: 0, start: 3, match: 'Chihiro-han' }, { patternIndex: 0 }],
    nextOffset: 2,
  });
  expect(call('scene.search', first.nextSearch)).toMatchObject({
    offset: 2,
    nextOffset: null,
    matches: [{ patternIndex: 0 }, { patternIndex: 2, start: 0, end: 2 }],
  });
  expect(call('scene.search', { ...args, offset: 2 })).toMatchObject({
    offset: 2,
    nextOffset: null,
  });
  const prior = first.nextSearch;
  call('scene.patch', {
    ...first.editTarget,
    changes: [{ oldText: 'Chihiro-han', newText: 'Chihiro-san', expectedCount: 3 }],
  });
  expect(() => call('scene.search', prior)).toThrow(/changed/);
  expect(call('scene.search', args).counts[0].count).toBe(0);
  expect(store.source(source.id).text).toContain('Chihiro-san');
});

test('bounded reads require stable snapshots and reject sources outside the live chat', () => {
  const { store, source, chatId, call } = fixture('abcdefghij');
  const first = call('scene.read', { sourceId: source.id, target: 'original', limit: 4 });
  expect(first).toMatchObject({ text: 'abcd', totalLength: 10, nextOffset: 4 });
  expect(call('scene.read', first.nextRead)).toMatchObject({ text: 'efgh', nextOffset: 8 });
  expect(
    call('scene.read', { sourceId: source.id, target: 'original', offset: 4, limit: 4 })
  ).toMatchObject({ text: 'efgh', nextOffset: 8 });
  expect(call('scene.read', { ...first.editTarget, offset: 8, limit: 2 })).toMatchObject({
    text: 'ij',
    nextOffset: null,
  });
  call('scene.patch', { ...first.editTarget, text: 'X' });
  expect(() => call('scene.read', first.nextRead)).toThrow(/changed/);
  const other = createFixtureChat(store, 'Other chat').id;
  expect(() =>
    invokeHelperSceneTool(store, other, 'scene.read', { sourceId: source.id, target: 'original' })
  ).toThrow(/ancestry/);
  store.db.prepare('UPDATE chats SET head_revision=NULL WHERE id=?').run(chatId);
  expect(() => call('scene.read', { sourceId: source.id, target: 'original' })).toThrow(/ancestry/);
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
  expect(first.textHash).not.toBe(first.editTarget.expectedTextHash);
  const historicalPage = { sourceId: source.id, versionRevision: 0, offset: 7 };
  const { target: _target, ...versionGuards } = first.editTarget;
  expect(call('scene.versions', historicalPage)).toMatchObject({ text: ' original' });
  expect(() => call('scene.versions', { ...historicalPage, ...versionGuards })).toThrow(
    /text changed/
  );
  expect(
    call('scene.versions', {
      ...historicalPage,
      ...versionGuards,
      expectedTextHash: first.textHash,
    })
  ).toMatchObject({
    text: ' original',
    nextOffset: null,
  });
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
    expect(countTextTokens(JSON.stringify(page))).toBeLessThanOrEqual(12_000);
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

function appendScene(store: Store, chatId: string, content: string) {
  const chat = store.chat(chatId);
  const run = store.createRun(
    chatId,
    {
      request: 'test',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'test',
      history: store.history(current.headRevision),
      resources: [],
    })
  ).run;
  store.startRun(run.id);
  return store.source(
    store.completeRun(run.id, content, {
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    }).id
  );
}

test('chat-wide scene search pages editable matches and invalidates a changed continuation', () => {
  const { store, chatId, source, call } = fixture('ruby 0');
  const later = appendScene(store, chatId, 'ruby 1 ruby 2');
  const history = vi.spyOn(store, 'history');
  const query = { target: 'original', patterns: ['ruby'], limit: 2 };
  const first = call('scene.search', query);
  expect(history).toHaveBeenCalledTimes(1);
  expect(first).toMatchObject({
    scannedScenes: 2,
    matchedScenes: 2,
    totalMatches: 3,
    matches: [{ editTarget: { sourceId: source.id } }, { editTarget: { sourceId: later.id } }],
    nextOffset: 2,
  });
  expect(call('scene.search', first.nextSearch)).toMatchObject({
    matches: [{ editTarget: { sourceId: later.id }, start: 7 }],
    nextOffset: null,
  });
  expect(() => call('scene.search', { ...query, offset: 2 })).toThrow(/GUARDS_REQUIRED/);
  expect(() =>
    call('scene.search', { ...first.nextSearch.arguments.arguments, patterns: ['other'] })
  ).toThrow(/changed/);
  store.editSource(later.id, { text: 'updated', expectedRevision: 0 });
  expect(() => call('scene.search', first.nextSearch)).toThrow(/changed/);
});

test('scene.patchMany applies distinct scene edits atomically with per-item guards', () => {
  const { store, source, chatId, call, read } = fixture('ruby first');
  const other = appendScene(store, chatId, 'ruby second');
  const original = read().editTarget;
  const second = call('scene.read', { sourceId: other.id, target: 'original' }).editTarget;
  const items = [
    { ...original, changes: [{ oldText: 'ruby', newText: 'tag' }] },
    { ...second, changes: [{ oldText: 'ruby', newText: 'tag' }] },
  ];
  expect(() => call('scene.patchMany', { items: [items[0], items[0]] })).toThrow(/Duplicate/);
  expect(() =>
    call('scene.patchMany', {
      items: [
        items[0],
        {
          ...items[1],
          changes: [{ oldText: 'absent', newText: 'tag' }],
        },
      ],
    })
  ).toThrow(/item 1.*count mismatch/);
  expect(store.source(source.id).text).toBe('ruby first');
  expect(store.source(other.id).text).toBe('ruby second');
  expect(call('scene.patchMany', { items })).toMatchObject({
    changed: true,
    sourceIds: [source.id, other.id],
    items: [
      { changed: true, revision: 1 },
      { changed: true, revision: 1 },
    ],
  });
  expect(store.source(source.id).text).toBe('tag first');
  expect(store.source(other.id).text).toBe('tag second');
  expect(() => call('scene.patchMany', { items })).toThrow(/changed/);
});

test('guarded original and translation co-edit keeps a new valid manual translation', () => {
  const { store, source, call, read } = fixture('`<ruby>moon</ruby>`');
  store.editTranslation(source.id, {
    text: '`<ruby>달</ruby>`',
    expectedRevision: 0,
    expectedSourceHash: source.hash,
  });
  const original = read().editTarget;
  const translation = read('translation').editTarget;
  const patch = {
    ...original,
    changes: [{ oldText: '`<ruby>moon</ruby>`', newText: '<ruby>moon</ruby>' }],
    translation: {
      ...translation,
      changes: [{ oldText: '`<ruby>달</ruby>`', newText: '<ruby>달</ruby>' }],
    },
  };
  expect(() =>
    call('scene.patch', {
      ...patch,
      translation: { ...patch.translation, expectedTextHash: '0'.repeat(64) },
    })
  ).toThrow(/translation changed/);
  expect(store.source(source.id).text).toBe('`<ruby>moon</ruby>`');
  expect(read('translation').text).toBe('`<ruby>달</ruby>`');
  const receipt = call('scene.patch', patch);
  expect(receipt).toMatchObject({
    changed: true,
    revision: 1,
    translationRevision: 2,
    translationInvalidated: false,
  });
  const edited = store.source(source.id);
  expect(edited.text).toBe('<ruby>moon</ruby>');
  expect(read('translation').text).toBe('<ruby>달</ruby>');
  expect(receipt.editTarget).toEqual(read().editTarget);
  expect(receipt.translationEditTarget).toEqual(read('translation').editTarget);
  expect(latestTranslation(store, source.id)).toMatchObject({
    status: 'completed',
    sourceHash: edited.hash,
    result: { sourceHash: edited.hash, manual: true },
  });
  expect(() => call('scene.patch', patch)).toThrow(/changed/);
});

test('original and translation co-edit preserves existing translation when text unchanged', () => {
  const { store, source, call, read } = fixture('original typo');
  store.editTranslation(source.id, {
    text: '번역 그대로',
    expectedRevision: 0,
    expectedSourceHash: source.hash,
  });
  const original = read().editTarget;
  const translation = read('translation').editTarget;
  const result = call('scene.patch', {
    ...original,
    changes: [{ oldText: 'typo', newText: 'fixed' }],
    translation: { ...translation, text: '번역 그대로' },
  });
  expect(result).toMatchObject({
    changed: true,
    translationInvalidated: false,
    translationRevision: 2,
  });
  expect(store.source(source.id).text).toBe('original fixed');
  expect(read('translation').text).toBe('번역 그대로');
});

test('batch containing translation co-edit rolls back original, translated text and other scenes', () => {
  const { store, source, chatId, call, read } = fixture('apple');
  const second = appendScene(store, chatId, 'pear');
  store.editTranslation(source.id, {
    text: '사과',
    expectedRevision: 0,
    expectedSourceHash: source.hash,
  });
  const firstPatch = {
    ...read().editTarget,
    changes: [{ oldText: 'apple', newText: 'banana' }],
    translation: { ...read('translation').editTarget, text: '바나나' },
  };
  const otherPatch = {
    ...call('scene.read', { sourceId: second.id, target: 'original' }).editTarget,
    changes: [{ oldText: 'missing', newText: 'something' }],
  };
  expect(() => call('scene.patchMany', { items: [firstPatch, otherPatch] })).toThrow(/item 1/);
  expect(store.source(source.id)).toMatchObject({ text: 'apple', editRevision: 0 });
  expect(store.source(second.id)).toMatchObject({ text: 'pear', editRevision: 0 });
  expect(read('translation').text).toBe('사과');
});

test('isolated regex returns full ruby literal matches with guards across scenes', async () => {
  const { store, source, chatId, call } = fixture('`<ruby>first</ruby>`');
  const second = appendScene(store, chatId, 'prefix `<ruby>second</ruby>`');
  const query = { target: 'original', patterns: ['`<ruby>[^`]+?</ruby>`'], regex: true, limit: 1 };
  const first = (await invokeSceneRegexSearch(store, chatId, query)) as Record<string, any>;
  expect(first).toMatchObject({
    scannedScenes: 2,
    matchedScenes: 2,
    totalMatches: 2,
    nextOffset: 1,
    matches: [
      {
        match: '`<ruby>first</ruby>`',
        truncated: false,
        editTarget: { sourceId: source.id, target: 'original' },
      },
    ],
  });
  const { chatId: _chatId, ...continuation } = first.nextSearch.arguments.arguments;
  const next = (await invokeSceneRegexSearch(store, chatId, continuation)) as Record<string, any>;
  expect(next).toMatchObject({
    nextOffset: null,
    matches: [{ match: '`<ruby>second</ruby>`', editTarget: { sourceId: second.id } }],
  });
  expect(
    call('scene.patch', {
      ...first.matches[0].editTarget,
      changes: [{ oldText: first.matches[0].match, newText: '<ruby>first</ruby>' }],
    })
  ).toMatchObject({ changed: true });
  await expect(invokeSceneRegexSearch(store, chatId, continuation)).rejects.toThrow(/changed/);
});

test('isolated regex bounds matched text and rejects unsafe regex without touching source', async () => {
  const { store, source, chatId } = fixture('`<ruby>' + 'a'.repeat(1500) + '</ruby>`');
  const found = (await invokeSceneRegexSearch(store, chatId, {
    sourceId: source.id,
    target: 'original',
    patterns: ['`<ruby>[^`]+</ruby>`'],
    regex: true,
  })) as Record<string, any>;
  expect(found.matches[0]).toMatchObject({ start: 0, truncated: true });
  expect(found.matches[0].match).toHaveLength(1000);
  await expect(
    invokeSceneRegexSearch(store, chatId, {
      target: 'original',
      patterns: ['(a+)+$'],
      regex: true,
    })
  ).rejects.toThrow(/DATA_QUERY_TIMEOUT/);
  expect(store.source(source.id).editRevision).toBe(0);
});
