import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { runDataProcess } from '../server/helper-data-tools.js';
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

test('grep returns authored excerpts once, supports two-character Korean queries, and reads exact ranges', async () => {
  const f = fixture(),
    b = bot(f);
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
  expect(JSON.stringify(result)).not.toContain('nativeRisu');
  const read = await f.invoke('data.read', {
    ref: hit.ref,
    offset: hit.matchRange.start,
    limit: 6,
  });
  expect(read.text).toBe('나이: 27');
  expect(read.ref.hash).toBe(hash(b.package.nativeRisu.card.description as string));
  expect(read.range.start).toBe(hit.matchRange.start);
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
  const directory = await f.invoke('data.read', {
    ref: list.items.find((i: any) => i.ref.id === b.id).ref,
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
  await expect(f.invoke('data.read', { ref: refs[0], refs })).rejects.toThrow();
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
  expect(
    (await f.invoke('data.search', { scope: 'library', patterns: ['나이'] })).items[0].text
  ).toContain('27세');
  f.store.product.content(
    { ...fixtureBotInput(b.title, '나이: 31세'), expectedRevision: b.revision },
    b.id
  );
  await expect(f.invoke('data.read', { ref: found.items[0].ref })).rejects.toThrow(
    'DATA_SOURCE_CHANGED'
  );
  expect((await f.invoke('data.read', { ref: unsaved.items[0].ref })).text).toContain('29세');
});

test('current scope retains reservation facts, complete old prose, source roles, imported claims and conflicting chat overrides', async () => {
  const f = fixture(),
    b = bot(f),
    text = '과거 인물의 나이는 알려지지 않았다.';
  const writing: RunSnapshot = {
    chatId: 'chat-A',
    branchId: 'branch-A',
    parentRevision: 'scene-A',
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 16 },
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
  expect((await f.invoke('data.read', { ref: source.ref })).text).toBe(text);
});

test('SQL views support schema discovery, aggregate queries, params, JSON and cross-view joins without mutation', async () => {
  const f = fixture(),
    b = bot(f),
    chat = createFixtureChat(f.store, 'SQL view chat', 'calm', { botId: b.id });
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
  const read = await f.invoke('data.read', { ref, offset: 1, limit: 1 });
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
  const read = await f.invoke('data.read', { ref: found.items[2].ref });
  expect(read.text).toContain('0-2');
  const counts = await f.invoke('db.query', {
    sql: 'SELECT chat_id,COUNT(*) n FROM agent_messages GROUP BY chat_id ORDER BY chat_id',
  });
  expect(counts.rows.map((row: any) => row.n)).toEqual([3, 3]);
});
