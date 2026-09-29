import { chatWithSource } from './fixtures/illustration.js';
import { readHelperOutline } from '../server/outline-read.js';
import { editSource } from '../server/source-editing.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { runDataProcess } from '../server/helper-data-tools.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import type { DataOperation, DataRef } from '../server/helper-data-worker.js';
import { fixtureBotInput, createFixtureChat } from './fixtures/chat.js';
import type { HelperTaskSnapshot } from '../core/helper.js';
import type { Content } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  for (const f of owned.splice(0)) {
    f.store.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-data-tools-'));
  const store = new Store(join(path, 'test.sqlite'));
  owned.push({ store, path });
  const connection = store.product.connection({
    title: 'Unused fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Unused fixture',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'library', workId: 'data-tools' });
  const snapshot: HelperTaskSnapshot = {
    scope: conversation.scope,
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { helperCalls: 12, totalCalls: 24, artifacts: 1 },
  };
  const task = workspace.enqueue(conversation.id, 'task', 'Find authored evidence', snapshot);
  const invoke = (name: DataOperation['name'], args: Record<string, unknown>, timeout = 3000) =>
    runDataProcess(
      { path: store.path, taskId: task.id, name, args },
      undefined,
      timeout
    ) as Promise<any>;
  const setSnapshot = (patch: Partial<HelperTaskSnapshot>) =>
    store.db
      .prepare('UPDATE helper_tasks SET snapshot=? WHERE id=?')
      .run(JSON.stringify({ ...snapshot, ...patch }), task.id);
  return { store, task, invoke, setSnapshot };
}
function bot(
  f: ReturnType<typeof fixture>,
  text = 'Name: 하린\n나이: 27세\n직업: 기록관',
  kind: 'bot' | 'persona' | 'module' = 'bot'
) {
  return f.store.product.content({ ...fixtureBotInput('하린 ' + kind, text), kind }) as Content;
}

async function readOne(
  f: ReturnType<typeof fixture>,
  ref: DataRef,
  options: { offset?: number; limit?: number } = {}
) {
  const batch = await f.invoke('data.read', { refs: [ref], ...options });
  expect(batch.items).toHaveLength(1);
  const item = batch.items[0];
  if (item.error) throw new Error(item.error);
  expect(batch.nextIndex).toBeNull();
  return item.read;
}

test('grep returns authored excerpts once, supports two-character Korean queries, and reads exact ranges', async () => {
  const f = fixture(),
    b = bot(
      f,
      'Name: 하린\n나이: 27세\n직업: 기록관\n' + '먼 배경. '.repeat(900) + 'unread-marker'
    );
  const result = await f.invoke('data.search', {
    scope: 'library',
    query: '하린',
    patterns: ['나이'],
  });
  expect(result.complete).toBe(true);
  expect(result.items).toHaveLength(1);
  const hit = result.items[0];
  expect(hit.text).toContain('나이: 27세');
  expect(hit.origin).toBe('live-library-original');
  expect(hit.ref).toMatchObject({ id: b.id, kind: 'bot', field: '/card/description', revision: 1 });
  expect(hit.editTarget).toEqual({
    kind: 'content',
    id: b.id,
    expectedRevision: b.revision,
    path: '/package/nativeRisu/card/description',
  });
  expect(JSON.stringify(result)).not.toContain('unread-marker');
  const read = await readOne(f, hit.ref, {
    offset: hit.matchRange.start,
    limit: 6,
  });
  expect(read.text).toBe('나이: 27');
  expect(read.ref.hash).toBe(hash(b.package.nativeRisu.card.description as string));
  expect(read.range.start).toBe(hit.matchRange.start);
  expect(read.editTarget).toEqual(hit.editTarget);
});

test('document discovery and narrow matches edit one age without sending repeated HTML', async () => {
  const f = fixture();
  const input = fixtureBotInput('Fujimiya Hinano', 'Hinano is Age: 14.');
  const { extensions: _old, ...card } = input.package.nativeRisu.card;
  const background = '<section>Hinano recurring background.</section>'.repeat(500);
  input.package.nativeRisu.card = {
    extensions: { risuai: { backgroundHTML: background } },
    ...card,
    ageNumber: 14,
  };
  const saved = f.store.product.content(input) as Content;
  expect(background.length).toBeGreaterThan(20_000);
  const missedTitle = await f.invoke('data.search', {
    scope: 'library',
    output: 'documents',
    query: '히나노',
    patterns: ['Hinano', '히나노'],
  });
  expect(missedTitle.items).toEqual([]);
  const documents = await f.invoke('data.search', {
    scope: 'library',
    output: 'documents',
    patterns: ['Hinano', '히나노'],
  });
  expect(documents.items).toMatchObject([{ id: saved.id, kind: 'bot', revision: saved.revision }]);
  expect(JSON.stringify(documents)).not.toContain('backgroundHTML');
  expect(JSON.stringify(documents).length).toBeLessThan(8_000);

  const broad = await f.invoke('data.search', {
    scope: 'library',
    ids: [saved.id],
    patterns: ['Hinano'],
    limit: 20,
    context: 150,
  });
  expect(broad.items[0].ref.field).toBe('/card/description');
  expect(JSON.stringify(broad).length).toBeLessThanOrEqual(8_000);
  expect(broad.complete).toBe(false);
  expect(broad.nextOffset).toBeGreaterThan(0);
  const narrow = await f.invoke('data.search', {
    scope: 'library',
    ids: [saved.id],
    patterns: ['Hinano'],
    paths: ['/card/description'],
  });
  expect(narrow.items.map((item: any) => item.ref.field)).toEqual(['/card/description']);
  expect(narrow.complete).toBe(true);
  const numberHit = await f.invoke('data.search', {
    scope: 'library',
    ids: [saved.id],
    patterns: ['14'],
    paths: ['/card/ageNumber'],
  });
  expect(numberHit.items[0].ref.field).toBe('/card/ageNumber');
  expect(numberHit.items[0].editTarget).toBeUndefined();
  const htmlOnly = await f.invoke('data.search', {
    scope: 'library',
    ids: [saved.id],
    patterns: ['Hinano'],
    paths: ['/card/extensions'],
    limit: 1,
  });
  expect(htmlOnly.items[0].ref.field).toContain('/card/extensions/');
  expect(htmlOnly.complete).toBe(false);
  await expect(f.invoke('data.search', { paths: ['card/description'] })).rejects.toThrow(
    'DATA_PATH_INVALID'
  );
  await expect(f.invoke('data.search', { paths: ['/'] })).rejects.toThrow('DATA_PATH_INVALID');

  const age = await f.invoke('data.search', {
    scope: 'library',
    ids: [saved.id],
    patterns: ['Age:'],
  });
  expect(age.items).toHaveLength(1);
  expect(age.items[0].text).toContain('Age: 14');
  expect(age.items[0].editTarget).toEqual({
    kind: 'content',
    id: saved.id,
    expectedRevision: saved.revision,
    path: '/package/nativeRisu/card/description',
  });
  const receipt = invokeResourceTool(f.store, 'resource.patch', {
    kind: age.items[0].editTarget.kind,
    id: age.items[0].editTarget.id,
    expectedRevision: age.items[0].editTarget.expectedRevision,
    changes: [
      {
        path: age.items[0].editTarget.path,
        op: 'replaceText',
        oldText: 'Age: 14',
        newText: 'Age: 15',
      },
    ],
  }) as { revision: number; changedPaths: string[] };
  expect(receipt.revision).toBe(saved.revision + 1);
  expect(receipt.changedPaths).toEqual(['/package/nativeRisu/card/description']);
  const after = f.store.product.get<Content>('content', saved.id);
  expect(after.package.nativeRisu.card.description).toBe('Hinano is Age: 15.');
  expect((after.package.nativeRisu.card.extensions as any).risuai.backgroundHTML).toBe(background);
});

test('module string excerpts can be patched while protected native paths remain readable', async () => {
  const f = fixture();
  const input = fixtureBotInput('Harbor module');
  input.package.nativeRisu.card = {};
  const protectedFields = Object.fromEntries(
    ['id', 'sourceHash', 'assets', 'imageId', '__proto__', 'constructor', 'prototype'].map(
      (key) => [key, `protected sentinel ${key}`]
    )
  );
  input.package.nativeRisu.module = {
    name: 'Harbor module',
    lorebook: [{ comment: 'Harbor', key: 'dock', content: 'The west harbor opens at dawn.' }],
    extensions: { vendor: protectedFields },
  };
  const saved = f.store.product.content({ ...input, kind: 'module' }) as Content;
  const found = await f.invoke('data.search', {
    scope: 'library',
    ids: [saved.id],
    patterns: ['west harbor'],
    paths: ['/module/lorebook'],
  });
  expect(found.items).toHaveLength(1);
  const hit = found.items[0];
  expect(hit.editTarget).toEqual({
    kind: 'content',
    id: saved.id,
    expectedRevision: saved.revision,
    path: '/package/nativeRisu/module/lorebook/0/content',
  });
  const protectedHits = await f.invoke('data.search', {
    scope: 'library',
    ids: [saved.id],
    patterns: ['protected sentinel'],
    paths: ['/module/extensions/vendor'],
    limit: 20,
  });
  expect(protectedHits.items).toHaveLength(Object.keys(protectedFields).length);
  expect(protectedHits.items.every((item: any) => item.editTarget === undefined)).toBe(true);
  const protectedRead = await readOne(f, protectedHits.items[0].ref);
  expect(protectedRead.text).toContain('protected sentinel');
  expect(protectedRead.editTarget).toBeUndefined();

  const { path, ...target } = hit.editTarget;
  invokeResourceTool(f.store, 'resource.patch', {
    ...target,
    changes: [
      {
        path,
        op: 'replaceText',
        oldText: 'west harbor',
        newText: 'north harbor',
      },
    ],
  });
  const after = f.store.product.get<Content>('content', saved.id);
  expect(after.package.nativeRisu.module?.lorebook).toMatchObject([
    { content: 'The north harbor opens at dawn.' },
  ]);
  expect(after.package.nativeRisu.module?.extensions).toMatchObject({ vendor: protectedFields });
});

test('matches later occurrences in one long field, with deterministic search pagination and exact original offsets', async () => {
  const f = fixture();
  bot(
    f,
    '나이: 27세\n' +
      '평범한 배경. '.repeat(300) +
      '\n나이: 다른 인물은 35세\n' +
      '뒷부분. '.repeat(300) +
      '\n나이: 미상'
  );
  let offset = 0;
  const hits: any[] = [];
  for (let page = 0; page < 3; page++) {
    const result = await f.invoke('data.search', {
      patterns: ['나이'],
      limit: 1,
      offset,
      context: 20,
    });
    expect(result.items).toHaveLength(1);
    hits.push(result.items[0]);
    if (page < 2) {
      expect(result.complete).toBe(false);
      offset = result.nextOffset;
    } else {
      expect(result.complete).toBe(true);
      expect(result.nextOffset).toBeNull();
    }
  }
  expect(hits[0].text).toContain('27세');
  expect(hits[1].text).toContain('35세');
  expect(hits[2].text).toContain('미상');
  expect(new Set(hits.map((h) => h.matchRange.start)).size).toBe(3);
});

test('literal metacharacters stay literal, regex and AND search work, and no matches are not fabricated facts', async () => {
  const f = fixture();
  bot(f, '우이 [A.1]\nAge: unknown.\nBirth year: not specified.');
  expect((await f.invoke('data.search', { patterns: ['[A.1]'] })).items).toHaveLength(1);
  expect(
    (await f.invoke('data.search', { patterns: ['Age', 'Birth'], match: 'all' })).items
  ).toHaveLength(1);
  expect(
    (await f.invoke('data.search', { patterns: ['Age:\\s+unknown'], regex: true })).items
  ).toHaveLength(1);
  const absent = await f.invoke('data.search', { patterns: ['27세'] });
  expect(absent.items).toEqual([]);
  expect(absent.semantics).toContain('No-match is not proof');
  await expect(f.invoke('data.search', { patterns: ['['], regex: true })).rejects.toThrow();
});

test('library title filters preserve normalized matches, distinct same-name resources and paging', async () => {
  const f = fixture();
  const sameName = ['bot', 'persona'].map(
    (kind, index) =>
      f.store.product.content({
        ...fixtureBotInput('하린 Beacon', `나이: ${27 + index}세`),
        kind,
      }) as Content
  );
  const unrelated = f.store.product.content(
    fixtureBotInput(
      '다른 인물',
      'Beacon은 본문에만 있다. 나이: 40세\n' + '배경 자료. '.repeat(6000)
    )
  ) as Content;
  const hidden = f.store.product.content(fixtureBotInput('하린 Beacon', '나이: 99세')) as Content;
  f.store.db.prepare('INSERT INTO library_hidden VALUES(?,?)').run('content', hidden.id);

  const normalized = await f.invoke('data.search', {
    query: 'ｂｅａｃｏｎ',
    patterns: ['나이'],
    limit: 1,
  });
  expect(normalized.items).toHaveLength(1);
  expect(normalized.complete).toBe(false);
  const next = await f.invoke('data.search', {
    query: 'ｂｅａｃｏｎ',
    patterns: ['나이'],
    limit: 1,
    offset: normalized.nextOffset,
  });
  expect(next.complete).toBe(true);
  expect([...normalized.items, ...next.items].map((item: any) => item.ref.id)).toEqual(
    sameName.map((content) => content.id)
  );
  expect(next.items[0].text).toContain('28세');

  for (const query of ['하린', sameName[0]!.id.toUpperCase()]) {
    const selected = await f.invoke('data.search', { query, kinds: ['bot'], patterns: ['나이'] });
    expect(selected.items).toHaveLength(1);
    expect(selected.items[0].ref.id).toBe(sameName[0]!.id);
    expect(selected.items[0].text).toContain('27세');
  }
  const kindMatched = await f.invoke('data.search', { query: 'ＢＯＴ', patterns: ['나이'] });
  expect(kindMatched.items.map((item: any) => item.ref.id).sort()).toEqual(
    [sameName[0]!.id, unrelated.id].sort()
  );
  expect(f.store.product.get<Content>('content', unrelated.id)).toEqual(unrelated);
});

test('library filters distinguish bot/persona/module, hide retired library entries, and directory/batch reading is bounded', async () => {
  const f = fixture();
  const b = bot(f),
    p = bot(f, '페르소나의 나이: 29세', 'persona'),
    m = bot(f, '모듈의 나이 규칙', 'module');
  expect(
    (await f.invoke('data.search', { kinds: ['persona'], patterns: ['나이'] })).items[0].ref.id
  ).toBe(p.id);
  f.store.db.prepare('INSERT INTO library_hidden VALUES(?,?)').run('content', m.id);
  const list = await f.invoke('data.search', {});
  expect(list.items).toHaveLength(2);
  const directory = await readOne(f, list.items.find((i: any) => i.ref.id === b.id).ref, {
    limit: 1,
  });
  expect(directory.fields).toHaveLength(1);
  expect(directory.nextOffset).toBe(1);
  const found = await f.invoke('data.search', { patterns: ['나이'] });
  const refs = found.items.map((i: any) => i.ref);
  const batch = await f.invoke('data.read', {
    refs: [...refs, { ...refs[0], hash: '0'.repeat(64) }],
    limit: 20,
  });
  expect(batch.items).toHaveLength(3);
  expect(batch.items[0].read.text).toContain('나이');
  expect(batch.items[2].error).toContain('DATA_SOURCE_CHANGED');
  expect(batch.nextIndex).toBeNull();
  const sixteen = await f.invoke('data.read', {
    refs: Array.from({ length: 16 }, () => refs[0]),
    limit: 1,
  });
  expect(sixteen.items).toHaveLength(16);
  expect(sixteen.nextIndex).toBeNull();
  await expect(
    f.invoke('data.read', { refs: Array.from({ length: 17 }, () => refs[0]), limit: 1 })
  ).rejects.toThrow('DATA_LIST_INVALID');
  await expect(f.invoke('data.read', { ref: refs[0], refs })).rejects.toThrow();
});

test('library document search lists current resources by title, ID, category and prompt role', async () => {
  const f = fixture();
  const original = bot(f);
  const current = f.store.product.content(
    {
      ...fixtureBotInput('Revised Archive Beacon', 'PRIVATE_CARD_BODY ' + 'body '.repeat(270_000)),
      expectedRevision: original.revision,
    },
    original.id
  ) as Content;
  const main = f.store.product.promptPreset({
    title: 'Main Archive',
    role: 'main',
    text: 'PRIVATE_PROMPT_BODY ' + 'prompt '.repeat(25_000),
  });
  f.store.product.promptPreset({
    title: 'Translation Archive',
    role: 'translation',
    text: 'Translation prompt body',
  });
  const content = await f.invoke('data.search', {
    scope: 'library',
    output: 'documents',
    query: `ＢＥＡＣＯＮ ${current.id.toUpperCase()} bot`,
  });
  expect(content.items).toMatchObject([
    { id: current.id, revision: current.revision, metadata: { category: 'bot' } },
  ]);
  expect(content.items[0].title).toBe('Revised Archive Beacon');
  expect(content.items[0]).not.toHaveProperty('text');
  expect(JSON.stringify(content)).not.toContain('PRIVATE_CARD_BODY');
  const prompts = await f.invoke('data.search', {
    scope: 'library',
    output: 'documents',
    query: 'archive MAIN prompt',
  });
  expect(prompts.items).toMatchObject([
    { id: main.id, kind: 'prompt', metadata: { category: 'main' } },
  ]);
  expect(JSON.stringify(prompts)).not.toContain('PRIVATE_PROMPT_BODY');
  const listed = await f.invoke('data.search', {
    scope: 'library',
    output: 'documents',
    limit: 5,
  });
  expect(listed.items).toHaveLength(3);
  expect(JSON.stringify(listed)).not.toContain('PRIVATE_CARD_BODY');
  expect(JSON.stringify(listed)).not.toContain('PRIVATE_PROMPT_BODY');
  expect(
    (
      await f.invoke('data.search', {
        scope: 'library',
        output: 'documents',
        query: 'Archive translation bot',
      })
    ).items
  ).toEqual([]);
});

test('live references detect a later revision while unsaved editor input is separate and not written to the library', async () => {
  const f = fixture(),
    b = bot(f);
  const found = await f.invoke('data.search', { patterns: ['나이'] });
  f.setSnapshot({
    editor: {
      kind: 'content',
      targetId: b.id,
      revision: b.revision,
      title: b.title,
      model: { ...fixtureBotInput(b.title, '나이: 29세') },
    },
  });
  const unsaved = await f.invoke('data.search', { patterns: ['나이'] });
  expect(unsaved.scope).toBe('editor');
  expect(unsaved.items[0].text).toContain('29세');
  expect(unsaved.items[0].origin).toBe('unsaved-device-editor');
  expect(unsaved.items[0].editTarget).toBeUndefined();
  expect(
    (await f.invoke('data.search', { scope: 'library', patterns: ['나이'] })).items[0].text
  ).toContain('27세');
  f.store.product.content(
    { ...fixtureBotInput(b.title, '나이: 31세'), expectedRevision: b.revision },
    b.id
  );
  await expect(readOne(f, found.items[0].ref)).rejects.toThrow('DATA_SOURCE_CHANGED');
  expect((await readOne(f, unsaved.items[0].ref)).text).toContain('29세');
});

test('current scope retains reservation facts, complete old prose, source roles, imported claims and conflicting chat overrides', async () => {
  const f = fixture(),
    b = bot(f),
    text = '과거 인물의 나이는 알려지지 않았다.';
  const writing: RunSnapshot = {
    chatId: 'chat-A',
    parentRevision: 'scene-A',
    settingsRevision: 1,
    settings: { status: false, maxCalls: 16 },
    request: 'inspect',
    history: [{ revision: 'scene-A', text, contentHash: hash(text) }],
    resources: [],
    logicalHistory: [
      {
        id: 'request-A',
        role: 'user',
        text: '사용자 요청: 나이를 함부로 정하지 마.',
        sourceRevision: 'scene-A',
      },
      { id: 'source-A', role: 'assistant', text, sourceRevision: 'scene-A' },
    ],
    profile: {
      packages: [b.package],
      packageAttachments: [{ id: b.package.id, revision: b.package.revision, role: 'bot' }],
      chatOverrides: {
        entries: [
          {
            id: 'override-A',
            revision: 2,
            selector: { loreId: 'age' },
            value: '채팅 수정 나이: 29세',
            atSource: 'scene-A',
          },
        ],
        conflicts: [{ overrideId: 'override-A' }],
      },
    } as any,
    story: {
      notes: [
        {
          id: 'note-A',
          chatId: 'chat-A',
          kind: 'imported-memory',
          origin: { fileHash: 'a'.repeat(64), entryId: 'memory-A', title: 'Imported claim' },
          text: '전해 들은 나이: 30세',
          atRevision: null,
          atHash: null,
          declaration: { author: 'import', text: '전해 들은 나이: 30세' },
        },
      ],
    } as any,
  };
  f.setSnapshot({ writing });
  f.store.product.content(
    { ...fixtureBotInput(b.title, '나이: 31세'), expectedRevision: b.revision },
    b.id
  );
  const result = await f.invoke('data.search', { patterns: ['나이'], limit: 30 });
  expect(result.scope).toBe('current');
  expect(result.chatId).toBe('chat-A');
  expect(result.items.some((i: any) => i.ref.kind === 'bot' && i.text.includes('27세'))).toBe(true);
  expect(result.items.some((i: any) => i.ref.kind === 'chat' && i.ref.field === '/request')).toBe(
    true
  );
  expect(result.items.find((i: any) => i.ref.kind === 'note').metadata.kind).toBe(
    'imported-memory'
  );
  expect(result.items.find((i: any) => i.ref.kind === 'override').origin).toContain('conflicting');
  const source = result.items.find((i: any) => i.ref.field === '/text' && i.ref.kind === 'chat');
  expect(source.metadata.sceneNumber).toBe(1);
  expect((await readOne(f, source.ref)).text).toBe(text);
});

test('SQL views support schema discovery, aggregate queries, params, JSON and cross-view joins without mutation', async () => {
  const f = fixture(),
    b = bot(f),
    chat = createFixtureChat(f.store, 'SQL view chat', { botId: b.id });
  const schema = await f.invoke('db.query', {});
  expect(schema.views.map((v: any) => v.name)).toEqual([
    'agent_resources',
    'agent_chats',
    'agent_messages',
    'agent_usage',
    'agent_helper_inputs',
  ]);
  for (const name of [
    'agent_resources',
    'agent_chats',
    'agent_messages',
    'agent_usage',
    'agent_helper_inputs',
  ]) {
    const count = await f.invoke('db.query', { sql: `SELECT COUNT(*) n FROM ${name}` });
    expect(count.rows[0].n).toBeTypeOf('number');
  }
  const rows = await f.invoke('db.query', {
    sql: "WITH selected AS (SELECT id,title,document FROM agent_resources WHERE kind=?) SELECT id,title,json_extract(document,'$.card.description') description FROM selected",
    params: ['bot'],
  });
  expect(rows.rows).toEqual([
    { id: b.id, title: b.title, description: b.package.nativeRisu.card.description },
  ]);
  const joined = await f.invoke('db.query', {
    sql: 'SELECT c.title,r.title bot FROM agent_chats c JOIN agent_resources r ON r.id=? WHERE c.id=?',
    params: [b.id, chat.id],
  });
  expect(joined.rows).toEqual([{ title: chat.title, bot: b.title }]);
});

test('SQL rejects writes, multiple statements, application credential tables and a CTE impersonating an allowed view', async () => {
  const f = fixture();
  bot(f);
  f.store.db.exec(
    "CREATE TABLE private_test_secret(value TEXT); INSERT INTO private_test_secret VALUES('must-not-return')"
  );
  for (const sql of [
    'DELETE FROM versions',
    'SELECT 1); DELETE FROM versions; SELECT (1',
    'SELECT value FROM private_test_secret',
    'WITH agent_resources AS (SELECT value FROM private_test_secret) SELECT * FROM agent_resources',
    "SELECT load_extension('x')",
    'PRAGMA user_version',
  ]) {
    await expect(f.invoke('db.query', { sql })).rejects.toThrow();
  }
  expect(f.store.db.prepare('SELECT value FROM private_test_secret').get()).toEqual({
    value: 'must-not-return',
  });
  expect(
    (await f.invoke('db.query', { sql: 'SELECT COUNT(*) n FROM agent_resources' })).rows[0].n
  ).toBe(1);
});

test('SQL marks bounded rows/cells, interrupts runaway native queries, and preserves application responsiveness', async () => {
  const f = fixture();
  bot(f, 'long '.repeat(3000));
  const cells = await f.invoke('db.query', { sql: 'SELECT document FROM agent_resources' });
  expect(cells.truncatedCells).toBe(1);
  expect(cells.rows[0].document.truncated).toBe(true);
  const rows = await f.invoke('db.query', {
    sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100) SELECT x FROM n',
    limit: 3,
  });
  expect(rows.rows).toHaveLength(3);
  expect(rows.truncated).toBe(true);
  await expect(
    f.invoke(
      'db.query',
      { sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n' },
      250
    )
  ).rejects.toThrow('DATA_QUERY_TIMEOUT');
  expect((await f.invoke('db.query', { sql: 'SELECT 1 ok' })).rows).toEqual([{ ok: 1 }]);
});

test('cancellation stops the isolated process and zero-width regex/surrogate reads make forward progress', async () => {
  const f = fixture();
  bot(f, '😀 나이: 27세\n끝');
  const found = await f.invoke('data.search', { patterns: ['^'], regex: true });
  expect(found.items.filter((item: any) => item.ref.field === '/card/description')).toHaveLength(1);
  expect(found.complete).toBe(true);
  const ref: DataRef = (await f.invoke('data.search', { patterns: ['나이'] })).items[0].ref;
  const read = await readOne(f, ref, { offset: 1, limit: 1 });
  expect(read.text).toBe('😀');
  expect(read.nextOffset).toBe(2);
  const controller = new AbortController();
  controller.abort();
  await expect(
    runDataProcess(
      { path: f.store.path, taskId: f.task.id, name: 'db.query', args: {} },
      controller.signal
    )
  ).rejects.toThrow('CANCELLED');
});

test('live chat grep and SQL follow each actual ancestry and preserve scene numbers when another chat is excluded', async () => {
  const f = fixture();
  const chats = [createFixtureChat(f.store, 'Chat A'), createFixtureChat(f.store, 'Chat B')];
  for (const [chatIndex, chat] of chats.entries()) {
    for (let index = 0; index < 3; index++) {
      const current = f.store.chat(chat.id),
        request = `Request ${chatIndex}-${index}`;
      const run = f.store.createRun(
        chat.id,
        {
          request,
          expectedRevision: current.headRevision,
          expectedSettingsRevision: current.settingsRevision,
          idempotencyKey: `seed-${index}`,
        },
        (captured) => ({
          chatId: chat.id,
          parentRevision: captured.headRevision,
          settingsRevision: captured.settingsRevision,
          settings: captured.settings,
          request,
          history: f.store.history(captured.headRevision),
          resources: [],
        })
      ).run;
      f.store.startRun(run.id);
      f.store.completeRun(
        run.id,
        `나이 기록 ${chatIndex}-${index}: 27세`,
        { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        run.snapshot.settings
      );
    }
  }
  const found = await f.invoke('data.search', {
    scope: 'chats',
    chatId: chats[0].id,
    patterns: ['나이'],
  });
  expect(found.items).toHaveLength(3);
  expect(found.items.map((item: any) => item.metadata.sceneNumber)).toEqual([1, 2, 3]);
  expect(
    found.items.every(
      (item: any) => item.ref.chatId === chats[0].id && !item.text.includes('기록 1-')
    )
  ).toBe(true);
  const read = await readOne(f, found.items[2].ref);
  expect(read.text).toContain('0-2');
  const discovered = await f.invoke('data.search', {
    scope: 'chats',
    output: 'documents',
    patterns: ['나이'],
    limit: 10,
  });
  expect(discovered.items).toHaveLength(6);
  const selected = discovered.items.find(
    (item: any) => item.chatId === chats[1].id && item.metadata.sceneNumber === 2
  );
  expect(selected).toMatchObject({ scope: 'chats', chatId: chats[1].id });
  const narrowed = await f.invoke('data.search', {
    scope: selected.scope,
    chatId: selected.chatId,
    ids: [selected.id],
    patterns: ['나이'],
  });
  expect(narrowed.items).toHaveLength(1);
  expect(narrowed.items[0].ref).toMatchObject({
    id: selected.id,
    chatId: selected.chatId,
  });
  expect(narrowed.items[0].metadata.sceneNumber).toBe(2);
  expect(await readOne(f, narrowed.items[0].ref)).toMatchObject({
    text: '나이 기록 1-1: 27세',
    metadata: { sceneNumber: 2 },
  });
  const counts = await f.invoke('db.query', {
    sql: 'SELECT chat_id,COUNT(*) n FROM agent_messages GROUP BY chat_id ORDER BY chat_id',
  });
  expect(counts.rows.map((row: any) => row.n)).toEqual([3, 3]);
});

test('batch reads use one documented default for text and directory pages', async () => {
  const f = fixture();
  const input = fixtureBotInput('Batch defaults', 'source '.repeat(900));
  input.package.nativeRisu.card.extensions = {
    toolTest: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, `value${i}`])),
  };
  const saved = f.store.product.content(input) as Content;
  const found = await f.invoke('data.search', { ids: [saved.id], patterns: ['source'], limit: 1 });
  const ref = found.items[0].ref as DataRef;
  const text = await readOne(f, ref);
  expect(text.text).toHaveLength(4000);
  expect(text.nextOffset).toBe(4000);
  const listed = await f.invoke('data.search', { ids: [saved.id] });
  const directory = await readOne(f, listed.items[0].ref);
  expect(directory.fields).toHaveLength(20);
  expect(directory.nextOffset).toBe(20);
  const mixed = await f.invoke('data.read', { refs: [ref, listed.items[0].ref] });
  expect(mixed.items.map((item: any) => item.read)).toEqual([text, directory]);
  expect(mixed.nextIndex).toBeNull();

  let remaining = Array.from({ length: 5 }, () => ref);
  let returned = 0;
  while (remaining.length) {
    const batch = await f.invoke('data.read', { refs: remaining });
    expect(batch.items.length).toBeGreaterThan(0);
    for (const item of batch.items) expect(item.read.nextOffset).toBe(4000);
    returned += batch.items.length;
    remaining = batch.nextIndex === null ? [] : remaining.slice(batch.nextIndex);
  }
  expect(returned).toBe(5);
});

test('malformed and stale refs do not discard valid batch reads', async () => {
  const f = fixture();
  bot(f);
  const found = await f.invoke('data.search', { patterns: ['27세'] });
  const ref = found.items[0].ref as DataRef;
  const batch = await f.invoke('data.read', {
    refs: [
      null,
      { ...ref, hash: '0'.repeat(64) },
      ref,
      { ...ref, revision: Number(ref.revision) + 1 },
      { ...ref, chatId: null },
      ref,
    ],
  });
  expect(batch.items).toHaveLength(6);
  expect(batch.items[0]).toMatchObject({ ref: null, error: 'DATA_OBJECT_REQUIRED' });
  expect(batch.items[1].error).toContain('DATA_SOURCE_CHANGED');
  expect(batch.items[2].read.text).toContain('27세');
  expect(batch.items[3].error).toContain('DATA_SOURCE_CHANGED');
  expect(batch.items[4].error).toBe('DATA_RESOURCE_UNAVAILABLE');
  expect(batch.items[5].read).toEqual(batch.items[2].read);
  expect(batch.nextIndex).toBeNull();
});

test('outline source nextRead works in the real data worker across frozen and edited live text', async () => {
  const f = fixture();
  const { chat, source } = chatWithSource(f.store, '연결 원문');
  const id = f.store.outline.applyReceipt(
    chat.id,
    {
      idempotencyKey: 'linked',
      operations: [
        { op: 'create', level: 'episode', title: '원문 연결', intent: '실제 본문과 대조' },
      ],
    },
    'user'
  ).created[0].id;
  f.store.db
    .prepare('INSERT INTO outline_writings(id,node_id,source_id,created_at) VALUES(?,?,?,?)')
    .run('ref', id, source.id, new Date().toISOString());
  const writing = {
    chatId: chat.id,
    history: [{ revision: source.id, contentHash: source.hash, text: source.text }],
  } as RunSnapshot;
  f.setSnapshot({ writing });
  const args = { mode: 'detail', nodeId: id, section: 'writings' };
  const frozen = readHelperOutline(f.store, chat.id, args, writing) as any;
  const frozenRef = frozen.items[0].nextRead.arguments.refs[0];
  expect((await readOne(f, frozenRef)).text).toBe(source.text);
  const changed = editSource(f.store, source.id, {
    expectedRevision: source.editRevision,
    text: '새로 편집된 원문😀',
  });
  const live = readHelperOutline(f.store, chat.id, args, writing) as any;
  const liveRef = live.items[0].nextRead.arguments.refs[0];
  expect(liveRef.scope).toBe('chats');
  expect((await readOne(f, liveRef)).text).toBe(changed.text);
  expect((await readOne(f, frozenRef)).text).toBe(source.text);
  const queried = await f.invoke('db.query', {
    sql: 'SELECT hash FROM agent_messages WHERE id=?',
    params: [source.id],
  });
  expect(JSON.stringify(queried)).toContain(changed.hash);
  editSource(f.store, source.id, {
    expectedRevision: changed.editRevision,
    text: '다시 편집된 원문',
  });
  await expect(readOne(f, liveRef)).rejects.toThrow('DATA_SOURCE_CHANGED');
});
