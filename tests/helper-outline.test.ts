import { countTextTokens } from '../core/text-tokens.js';
import { afterEach, expect, test, vi } from 'vitest';
import { illustrationDatabases } from './fixtures/illustration.js';
import { createFixtureChat } from './fixtures/chat.js';
import { readHelperOutline } from '../server/outline-read.js';

const dbs = illustrationDatabases('uimori-outline-reads-');
afterEach(() => {
  vi.restoreAllMocks();
  dbs.cleanup();
});

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
  for (const method of ['detail', 'node'] as const)
    vi.spyOn(store.outline, method).mockImplementation(() => {
      throw new Error('full detail not allowed');
    });
  const ids: string[] = [];
  let page = read({ limit: 50 });
  expect(page.coverage).toMatchObject({
    scopeTotal: 74,
    total: 74,
    excludedByDepth: 0,
    content: 'metadata-and-previews',
  });
  for (;;) {
    expect(countTextTokens(JSON.stringify(page))).toBeLessThanOrEqual(12_000);
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

test.each([undefined, 5999])(
  'long escaped Unicode intent round-trips with resumable UTF-16 ranges (limit %s)',
  (limit) => {
    const { store, leaf, read } = fixture();
    const expected = store.outline.node(leaf).intent;
    let page = read({ mode: 'detail', nodeId: leaf, ...(limit === undefined ? {} : { limit }) });
    let joined = '';
    while (true) {
      expect(page.range.start).toBe(joined.length);
      expect(page.range.unit).toBe('utf16-code-unit');
      expect(page.totalChars).toBe(expected.length);
      expect(page.coverage).toMatchObject({ content: 'intent-range', wholeField: false });
      expect(page.coverage).not.toHaveProperty('complete');
      expect(countTextTokens(JSON.stringify(page))).toBeLessThanOrEqual(12_000);
      expect(page.text.isWellFormed()).toBe(true);
      if (limit === undefined) expect(countTextTokens(page.text)).toBeLessThanOrEqual(3000);
      joined += page.text;
      if (!page.nextRead) break;
      page = read(page.nextRead.arguments.arguments);
    }
    expect(joined).toBe(expected);
    expect(page.nextOffset).toBeNull();
    expect(page.coverage.wholeField).toBe(false);
    expect(read({ mode: 'detail', nodeId: leaf, offset: 10 }).error).toBe(
      'OUTLINE_VERSION_REQUIRED'
    );
  }
);

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
