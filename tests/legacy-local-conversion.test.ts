import { expect, test } from 'vitest';
import { convertLegacyLocalState } from '../web/legacy-local-conversion.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const chatId = 'chat-a';
const oldScope = 'main:chat-a';
const pending = {
  id: 'same-admission-key',
  startedAt: '2026-09-28T00:00:00.000Z',
  payload: JSON.stringify({
    request: '보존할 요청',
    expectedRevision: null,
    expectedSettingsRevision: 3,
    branchId: oldScope,
  }),
};

test('converts a pending request and drafts once without resending or changing admission identity', () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  session.setItem(`command:${chatId}:${oldScope}`, JSON.stringify(pending));
  session.setItem(`draft:${chatId}:${oldScope}`, '다음 장면 초안');
  session.setItem(`input-translation:draft:${chatId}:${oldScope}`, '{"id":"undo","text":"원문"}');
  session.setItem(`reading:${chatId}:`, '{"source":"scene"}');
  const warnings = convertLegacyLocalState([chatId], session, local);
  expect(warnings).toEqual([]);
  const command = JSON.parse(session.getItem(`command:${chatId}`)!);
  expect(command.id).toBe(pending.id);
  expect(JSON.parse(command.payload)).toEqual({
    request: '보존할 요청',
    expectedRevision: null,
    expectedSettingsRevision: 3,
  });
  expect(session.getItem(`command:${chatId}:${oldScope}`)).toBeNull();
  expect(session.getItem(`draft:${chatId}`)).toBe('다음 장면 초안');
  expect(session.getItem(`input-translation:draft:${chatId}`)).toBe('{"id":"undo","text":"원문"}');
  expect(session.getItem(`reading:${chatId}`)).toBe('{"source":"scene"}');
  expect(convertLegacyLocalState([chatId], session, local)).toEqual([]);
});

test('keeps both independent drafts and pending admissions when destinations already contain data', () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const oldCommandKey = `command:${chatId}:${oldScope}`;
  const oldDraftKey = `draft:${chatId}:${oldScope}`;
  session.setItem(oldCommandKey, JSON.stringify(pending));
  session.setItem(`command:${chatId}`, JSON.stringify({ ...pending, id: 'another-key' }));
  session.setItem(oldDraftKey, '이전 초안');
  session.setItem(`draft:${chatId}`, '현재 초안');
  expect(convertLegacyLocalState([chatId], session, local)).toEqual(
    expect.arrayContaining([
      { storage: 'session', key: oldCommandKey, reason: 'conflict' },
      { storage: 'session', key: oldDraftKey, reason: 'conflict' },
    ])
  );
  expect(session.getItem(oldCommandKey)).toBe(JSON.stringify(pending));
  expect(session.getItem(oldDraftKey)).toBe('이전 초안');
  expect(session.getItem(`draft:${chatId}`)).toBe('현재 초안');
});

test('a colliding draft never adopts another scope’s lore reset or translation undo', () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const oldDraft = `draft:${chatId}:${oldScope}`;
  session.setItem(`draft:${chatId}`, '현재 초안');
  session.setItem(oldDraft, '이전 초안');
  session.setItem(`lore-reset:${oldDraft}`, 'true');
  session.setItem(`input-translation:${oldDraft}`, '{"id":"prior","text":"이전 원문"}');
  const warnings = convertLegacyLocalState([chatId], session, local);
  expect(warnings.map((item) => item.key)).toEqual([
    oldDraft,
    `lore-reset:${oldDraft}`,
    `input-translation:${oldDraft}`,
  ]);
  expect(session.getItem(`draft:${chatId}`)).toBe('현재 초안');
  expect(session.getItem(`lore-reset:draft:${chatId}`)).toBeNull();
  expect(session.getItem(`input-translation:draft:${chatId}`)).toBeNull();
  expect(session.getItem(`lore-reset:${oldDraft}`)).toBe('true');
  expect(session.getItem(`input-translation:${oldDraft}`)).toContain('이전 원문');
});

test('converts variable, outline and helper receipts with their original request keys', () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  session.setItem(
    `uimori:chat-variable-draft:${chatId}:${oldScope}`,
    JSON.stringify({
      text: '{"mood":"bright"}',
      revision: 2,
      sourceHash: null,
      pending: {
        branchId: oldScope,
        expectedRevision: 2,
        expectedSourceHash: null,
        idempotencyKey: 'variable-key',
        values: { mood: 'bright' },
      },
    })
  );
  session.setItem(
    `outline-pending:${chatId}:${oldScope}`,
    JSON.stringify({
      kind: 'apply',
      body: { branchId: oldScope, idempotencyKey: 'outline-key', operations: [] },
    })
  );
  const previousScope = { kind: 'chat', chatId, branchId: oldScope };
  local.setItem(
    `uimori:helper-create:${JSON.stringify(previousScope)}`,
    JSON.stringify({ scope: previousScope, requestKey: 'helper-key' })
  );
  expect(convertLegacyLocalState([chatId], session, local)).toEqual([]);
  expect(
    JSON.parse(session.getItem(`uimori:chat-variable-draft:${chatId}`)!).pending
  ).toMatchObject({ idempotencyKey: 'variable-key' });
  expect(
    JSON.parse(session.getItem(`uimori:chat-variable-draft:${chatId}`)!).pending
  ).not.toHaveProperty('branchId');
  expect(JSON.parse(session.getItem(`outline-pending:${chatId}`)!).body).toEqual({
    idempotencyKey: 'outline-key',
    operations: [],
  });
  expect(
    JSON.parse(local.getItem(`uimori:helper-create:${JSON.stringify({ kind: 'chat', chatId })}`)!)
  ).toEqual({ scope: { kind: 'chat', chatId }, requestKey: 'helper-key' });
});

test('unreadable records remain untouched and visible as conversion warnings', () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const key = `command:${chatId}:${oldScope}`;
  session.setItem(key, '{broken');
  expect(convertLegacyLocalState([chatId], session, local)).toContainEqual({
    storage: 'session',
    key,
    reason: 'invalid',
  });
  expect(session.getItem(key)).toBe('{broken');
  expect(session.getItem(`command:${chatId}`)).toBeNull();
});

test('an unavailable browser store reports a warning without blocking the app', () => {
  const blocked = new MemoryStorage();
  Object.defineProperty(blocked, 'length', {
    get() {
      throw new DOMException('Storage blocked', 'SecurityError');
    },
  });
  expect(convertLegacyLocalState([chatId], blocked, new MemoryStorage())).toEqual([
    { storage: 'session', key: '*', reason: 'unavailable' },
  ]);
});

test('a cleanup failure after one old key was removed keeps each draft value somewhere', () => {
  class FailingCleanup extends MemoryStorage {
    private removals = 0;
    override removeItem(key: string) {
      if (++this.removals === 2) throw new Error('Storage cleanup failed');
      super.removeItem(key);
    }
  }
  const session = new FailingCleanup();
  const local = new MemoryStorage();
  const oldDraft = `draft:${chatId}:${oldScope}`;
  const oldReset = `lore-reset:${oldDraft}`;
  session.setItem(oldDraft, '살아 있는 초안');
  session.setItem(oldReset, 'true');
  expect(convertLegacyLocalState([chatId], session, local)).toContainEqual({
    storage: 'session',
    key: oldDraft,
    reason: 'unavailable',
  });
  expect(session.getItem(oldDraft) ?? session.getItem(`draft:${chatId}`)).toBe('살아 있는 초안');
  expect(session.getItem(oldReset) ?? session.getItem(`lore-reset:draft:${chatId}`)).toBe('true');
});
