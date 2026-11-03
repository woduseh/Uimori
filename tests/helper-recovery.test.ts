import { beforeEach, expect, test, vi } from 'vitest';
import type { RecoveryBuffer } from '../web/editor-recovery.js';

const state = vi.hoisted(() => ({
  disk: new Map<string, RecoveryBuffer<string>>(),
  readFailure: '',
  writeFailure: '',
}));
vi.mock('../web/editor-recovery.js', () => ({
  readRecovery: async (key: string) => {
    if (state.readFailure === key) throw new Error('Synthetic read failure');
    return state.disk.get(key);
  },
  writeRecovery: async (key: string, value?: RecoveryBuffer<string>) => {
    if (state.writeFailure === key) throw new Error('Synthetic write failure');
    if (value) state.disk.set(key, value);
    else state.disk.delete(key);
  },
  deleteRecoveryIfModel: async (key: string, expected: string) => {
    const value = state.disk.get(key);
    if (value?.model === expected) state.disk.delete(key);
    else return value;
  },
}));
vi.mock('../web/helper-attachment-draft.js', () => ({
  deleteHelperAttachmentRecovery: async () => {},
}));

beforeEach(() => {
  vi.resetModules();
  state.disk.clear();
  state.readFailure = '';
  state.writeFailure = '';
});

test('failed session hydration preserves the saved draft and outbox until a successful read', async () => {
  const recovery = await import('../web/helper-recovery.js');
  const draft = 'helper:helper-input:one';
  const outbox = 'helper:helper-outbox:one';
  state.disk.set(draft, { revision: null, model: '보존할 초안', rawFields: {} });
  state.disk.set(outbox, { revision: null, model: '{"requestKey":"kept"}', rawFields: {} });
  state.readFailure = draft;
  await expect(recovery.loadHelperSessionRecovery('one')).rejects.toThrow();
  expect(state.disk.get(draft)?.model).toBe('보존할 초안');
  expect(state.disk.get(outbox)?.model).toBe('{"requestKey":"kept"}');
  state.readFailure = '';
  await recovery.loadHelperSessionRecovery('one');
  expect(recovery.cachedHelperRecovery('helper-input:one')).toBe('보존할 초안');
  expect(recovery.cachedHelperRecovery('helper-outbox:one')).toBe('{"requestKey":"kept"}');
});

test('failed text writes remain reported across subscribers and retry the latest in-memory value', async () => {
  const recovery = await import('../web/helper-recovery.js');
  const key = 'helper-input:one';
  await recovery.loadHelperSessionRecovery('one');
  state.writeFailure = `helper:${key}`;
  await expect(recovery.writeHelperRecovery(key, '첫 번째 입력')).rejects.toThrow();
  expect(recovery.failedHelperRecoveryKeys('one')).toEqual([key]);
  await expect(recovery.writeHelperRecovery(key, '수정한 최신 입력')).rejects.toThrow();
  expect(recovery.cachedHelperRecovery(key)).toBe('수정한 최신 입력');
  state.writeFailure = '';
  await recovery.retryHelperRecoveryWrite(key);
  expect(state.disk.get(`helper:${key}`)?.model).toBe('수정한 최신 입력');
  expect(recovery.failedHelperRecoveryKeys('one')).toEqual([]);
});

test('acknowledging a request clears its failed-write warning without overwriting a different saved draft', async () => {
  const recovery = await import('../web/helper-recovery.js');
  const key = 'helper-input:one';
  state.disk.set(`helper:${key}`, { revision: null, model: '다른 창의 초안', rawFields: {} });
  await recovery.loadHelperSessionRecovery('one');
  state.writeFailure = `helper:${key}`;
  await expect(recovery.writeHelperRecovery(key, '접수된 요청')).rejects.toThrow();
  await recovery.clearHelperRecoveryIf(key, '접수된 요청');
  expect(recovery.failedHelperRecoveryKeys('one')).toEqual([]);
  expect(state.disk.get(`helper:${key}`)?.model).toBe('다른 창의 초안');
});
