import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { illustrationDatabases, chatWithSource } from './fixtures/illustration.js';
import { createFixtureChat } from './fixtures/chat.js';
import { readHelperOutline } from '../server/outline-read.js';
import { editSource } from '../server/source-editing.js';
import type { RunSnapshot } from '../core/types.js';

const dbs = illustrationDatabases('uimori-outline-reads-');
afterEach(() => {
  vi.restoreAllMocks();
  dbs.cleanup();
});
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const store = dbs.create(),
    chat = createFixtureChat(store, '구성 부분 조회');
  const created = store.outline.apply(
    chat.id,
    {
      idempotencyKey: 'large-plan',
      operations: [
        { op: 'create', ref: 'root', level: 'arc', title: '1부', intent: '루트 전문'.repeat(9000) },
        ...Array.from({ length: 73 }, (_, i) => ({
          op: 'create',
          parentRef: 'root',
          level: 'episode',
          title: `회차 ${i}`,
          intent: '한글😀\r\n"'.repeat(5000),
        })),
      ],
    },
    'user'
  ).created;
  const read = (args: Record<string, unknown> = {}) =>
    readHelperOutline(store, chat.id, args) as any;
  return { store, chat, root: created[0].id, leaf: created[1].id, read };
}

test('large outline pages contain exact tree coverage, not full prose, without full detail hydration', () => {
  const { store, read, root } = fixture();
  const queries = vi.spyOn(store.db, 'prepare');
  const ids: string[] = [];
  let page = read({ limit: 50 });
  expect(queries.mock.calls.filter(([sql]) => sql.includes('substr(intent'))).toHaveLength(1);
  expect(page.coverage).toMatchObject({
    scopeTotal: 74,
    total: 74,
    excludedByDepth: 0,
    content: 'metadata-and-previews',
  });
  for (;;) {
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(24000);
    expect(page.nodes.every((n: any) => !('intent' in n) && !('writings' in n))).toBe(true);
    ids.push(...page.nodes.map((n: any) => n.id));
    if (!page.nextRead) break;
    expect(page.nextRead).toMatchObject({ name: 'app.call', arguments: { name: 'outline.read' } });
    page = read(page.nextRead.arguments.arguments);
  }
  expect(ids).toHaveLength(74);
  expect(new Set(ids).size).toBe(74);
  const shallow = read({ mode: 'subtree', nodeId: root, depth: 0 });
  expect(shallow.coverage).toMatchObject({
    scopeTotal: 74,
    total: 1,
    returned: 1,
    excludedByDepth: 73,
  });
  expect(shallow.nextOffset).toBeNull();
});

test('long escaped Unicode intent round-trips with resumable UTF-16 ranges and no split surrogate', () => {
  const { store, leaf, read } = fixture();
  const expected = store.outline.node(leaf).intent;
  let page = read({ mode: 'detail', nodeId: leaf, limit: 5999 });
  let joined = '';
  while (true) {
    expect(page.range.start).toBe(joined.length);
    expect(page.range.unit).toBe('utf16-code-unit');
    expect(page.totalChars).toBe(expected.length);
    expect(page.coverage).toMatchObject({ content: 'intent-range', wholeField: false });
    expect(page.coverage).not.toHaveProperty('complete');
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(24000);
    expect(page.text.isWellFormed()).toBe(true);
    joined += page.text;
    if (!page.nextRead) break;
    page = read(page.nextRead.arguments.arguments);
  }
  expect(joined).toBe(expected);
  expect(page.nextOffset).toBeNull(); // Last page, but not the whole field in this one response.
  expect(page.coverage.wholeField).toBe(false);
  expect(read({ mode: 'detail', nodeId: leaf, offset: 10 }).error).toBe('OUTLINE_VERSION_REQUIRED');
});

test('continuations detect changes to their scope without blocking unrelated detail reads', () => {
  const { store, chat, leaf, read } = fixture();
  const detail = read({ mode: 'detail', nodeId: leaf, offset: 0, limit: 20 });
  const detailNext = detail.nextRead.arguments.arguments;
  store.outline.applyReceipt(
    chat.id,
    {
      idempotencyKey: 'unrelated',
      operations: [{ op: 'create', level: 'arc', title: '별개의 부', intent: '' }],
    },
    'user'
  );
  expect(read(detailNext).error).toBeUndefined();
  expect(read(detailNext).range.start).toBe(detail.range.end);
  // The full overview changed; start that scope again, while the selected intent stays valid.
  const overviewNext = read({ limit: 1 }).nextRead.arguments.arguments;

  const other = createFixtureChat(store, '다른 구성');
  store.outline.apply(
    other.id,
    {
      idempotencyKey: 'other',
      operations: [{ op: 'create', level: 'beat', title: '별개', intent: '' }],
    },
    'user'
  );
  expect(read(overviewNext).error).toBeUndefined();
  store.outline.apply(
    chat.id,
    {
      idempotencyKey: 'change',
      operations: [{ op: 'update', id: leaf, expectedRevision: 1, intent: '바뀐 방향' }],
    },
    'user'
  );
  expect(read(detailNext).error).toBe('OUTLINE_CHANGED');
  const changed = read(overviewNext);
  expect(changed).toMatchObject({ error: 'OUTLINE_CHANGED', returned: false });
  expect(changed.nodes).toBeUndefined();
  expect(changed.nextRead.arguments.arguments.offset).toBe(0);
  const version = read().version;
  store.outline.apply(
    chat.id,
    {
      idempotencyKey: 'move',
      operations: [{ op: 'move', id: leaf, expectedRevision: 2, parentId: null, position: 0 }],
    },
    'user'
  );
  expect(read({ expectedVersion: version }).error).toBe('OUTLINE_CHANGED');
});

test('writings point at the exact frozen source or explicit live reference and detect source edits', () => {
  const store = dbs.create(),
    { chat, source } = chatWithSource(store, '본문 연결');
  const id = store.outline.apply(
    chat.id,
    {
      idempotencyKey: 'one',
      operations: [{ op: 'create', level: 'episode', title: '부두', intent: '기다린다' }],
    },
    'user'
  ).created[0].id;
  store.db
    .prepare('INSERT INTO outline_writings(id,node_id,source_id,created_at) VALUES(?,?,?,?)')
    .run('written', id, source.id, new Date().toISOString());
  const writing = {
    chatId: chat.id,
    history: [{ revision: source.id, text: source.text, contentHash: source.hash }],
  } as RunSnapshot;
  const args = { mode: 'detail', nodeId: id, section: 'writings' };
  const page = readHelperOutline(store, chat.id, args, writing) as any;
  expect(page.items[0]).toMatchObject({
    sourceRevision: source.id,
    sourceHash: source.hash,
    origin: 'reserved-chat-source',
  });
  expect(page.items[0].nextRead).toMatchObject({
    name: 'data.read',
    arguments: {
      refs: [
        {
          scope: 'current',
          chatId: chat.id,
          id: source.id,
          revision: source.hash,
          field: '/text',
          hash: source.hash,
        },
      ],
    },
  });
  const edited = editSource(store, source.id, {
    text: '수정된 실제 원문',
    expectedRevision: source.editRevision,
  });
  expect(
    (readHelperOutline(store, chat.id, { ...args, expectedVersion: page.version }, writing) as any)
      .error
  ).toBe('OUTLINE_CHANGED');
  const live = readHelperOutline(store, chat.id, args, writing) as any;
  expect(live.items[0]).toMatchObject({
    sourceHash: edited.hash,
    origin: 'live-chat-source',
    changedSinceTaskStart: true,
  });
  expect(live.items[0].nextRead.arguments.refs[0]).toMatchObject({
    scope: 'chats',
    revision: sha(edited.text),
    hash: edited.hash,
  });
});

test('compact write receipts stay atomic and replayable without generating a full detail response', () => {
  const { store, chat, leaf } = fixture();
  vi.spyOn(store.outline, 'detail').mockImplementation(() => {
    throw new Error('full detail not allowed');
  });
  const input = {
    idempotencyKey: 'receipt',
    operations: [
      { op: 'update', id: leaf, expectedRevision: 1, intent: '변경 완료' },
      { op: 'create', ref: 'new', level: 'beat', title: '새 항목', intent: '큰 내용'.repeat(9000) },
    ],
  };
  const receipt = store.outline.applyReceipt(chat.id, input, 'user');
  expect(receipt).toMatchObject({ operationId: 'receipt', applied: true, atomic: true });
  expect(receipt.created).toHaveLength(1);
  expect(JSON.stringify(receipt).length).toBeLessThan(2000);
  expect(store.outline.applyReceipt(chat.id, input, 'user')).toEqual(receipt);
  expect(() =>
    store.outline.applyReceipt(
      chat.id,
      {
        idempotencyKey: 'rollback',
        operations: [
          { op: 'update', id: leaf, expectedRevision: 2, intent: '저장되면 안 됨' },
          { op: 'move', id: leaf, expectedRevision: 999, parentId: null, position: 0 },
        ],
      },
      'user'
    )
  ).toThrow();
  expect(store.outline.node(leaf).intent).toBe('변경 완료');
});

test('empty outline is readable and invalid foreign targets are not silently treated as empty', () => {
  const store = dbs.create(),
    chat = createFixtureChat(store, '빈 구성'),
    other = createFixtureChat(store, '다른 구성');
  const page = readHelperOutline(store, chat.id, {}) as any;
  expect(page).toMatchObject({ nodes: [], nextOffset: null, coverage: { total: 0, returned: 0 } });
  const id = store.outline.apply(
    other.id,
    {
      idempotencyKey: 'other',
      operations: [{ op: 'create', level: 'beat', title: '범위 밖', intent: '' }],
    },
    'user'
  ).created[0].id;
  expect(() => readHelperOutline(store, chat.id, { mode: 'subtree', nodeId: id })).toThrow(
    'OUTLINE_NODE_UNAVAILABLE'
  );
});

test('large initial selection and linked-reference pages do not become an unbounded prompt', () => {
  const { store, chat, root, leaf, read } = fixture();
  const seed = store.outline.helperContext(
    chat.id,
    { nodeId: root, expectedRevision: 1, purpose: 'compose' },
    8192
  );
  expect(JSON.stringify(seed).length).toBeLessThan(12000);
  expect(seed.partial).toBe(true);
  const ids = read({ limit: 50 })
    .nodes.map((node: any) => node.id)
    .filter((id: string) => id !== leaf)
    .slice(0, 30);
  store.outline.applyReceipt(
    chat.id,
    {
      idempotencyKey: 'links',
      operations: [{ op: 'update', id: leaf, expectedRevision: 1, relatedIds: ids }],
    },
    'user'
  );
  const page = read({ mode: 'detail', nodeId: leaf, section: 'related', limit: 2 });
  expect(page.items).toHaveLength(2);
  expect(page.coverage.total).toBe(ids.length);
  expect(read(page.nextRead.arguments.arguments).offset).toBe(2);
  const old = read({ mode: 'subtree', nodeId: leaf });
  store.outline.applyReceipt(
    chat.id,
    {
      idempotencyKey: 'unrelated-subtree',
      operations: [{ op: 'create', level: 'arc', title: '관계없는 부', intent: '' }],
    },
    'user'
  );
  expect(
    read({ mode: 'subtree', nodeId: leaf, expectedVersion: old.version }).error
  ).toBeUndefined();
  store.outline.applyReceipt(
    chat.id,
    { idempotencyKey: 'remove', operations: [{ op: 'remove', id: leaf, expectedRevision: 2 }] },
    'user'
  );
  const missing = read({ mode: 'subtree', nodeId: leaf, expectedVersion: old.version });
  expect(missing.error).toBe('OUTLINE_CHANGED');
  expect(missing.nextRead.arguments.arguments.mode).toBe('overview');
});
