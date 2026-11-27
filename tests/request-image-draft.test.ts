import { beforeEach, expect, test, vi } from 'vitest';
import type { RequestDraft } from '../web/request-image-draft.js';
import { storageKeys } from '../web/storage-keys.js';

const state = vi.hoisted(() => ({
  disk: new Map<string, RequestDraft>(),
  session: new Map<string, string>(),
}));
vi.mock('../web/attachment-draft-storage.js', () => ({
  readAttachmentDraft: async (key: string) => state.disk.get(key),
  writeAttachmentDraft: async (key: string, draft: RequestDraft) => {
    state.disk.set(key, structuredClone(draft));
  },
  deleteAttachmentDraft: async () => false,
}));
vi.mock('../web/editor-recovery.js', () => ({ copyRecoveryPrefix: async () => {} }));

beforeEach(() => {
  vi.resetModules();
  state.disk.clear();
  state.session.clear();
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('sessionStorage', {
    getItem: (name: string) => state.session.get(name) ?? null,
    setItem: (name: string, value: string) => state.session.set(name, value),
    removeItem: (name: string) => state.session.delete(name),
  });
});

test('a corrupt draft state left in the tab still saves and restores the request draft', async () => {
  const drafts = await import('../web/request-image-draft.js');
  state.session.set(storageKeys.requestState('chat-1'), '{"token":"old",');
  const draft: RequestDraft = { token: 'new', text: '다음 장면 요청', images: [] };

  await drafts.writeRequestDraft('chat-1', draft);

  expect(await drafts.readRequestDraft('chat-1')).toEqual({ saved: draft });
});
