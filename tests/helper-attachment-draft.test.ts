import { beforeEach, expect, test, vi } from 'vitest';
import type { RecoveryBuffer } from '../web/editor-recovery.js';
import type { HelperAttachmentDraft } from '../web/helper-attachment-draft.js';

const state = vi.hoisted(() => ({
  disk: new Map<string, RecoveryBuffer<HelperAttachmentDraft>>(),
  session: new Map<string, string>(),
  uploads: vi.fn(),
  cleanupFails: false,
  writeFails: false,
}));
vi.mock('../web/editor-recovery.js', () => ({
  readRecovery: async (key: string) => state.disk.get(key),
  writeRecovery: async (key: string, value?: RecoveryBuffer<HelperAttachmentDraft>) => {
    if (state.writeFails) throw new Error('disk unavailable');
    if (value) state.disk.set(key, structuredClone(value));
    else state.disk.delete(key);
  },
  deleteRecoveryIfToken: async (key: string, token: string) => {
    if (state.cleanupFails) throw new Error('disk unavailable');
    const found = state.disk.get(key);
    if (found?.token === token) state.disk.delete(key);
    else return found;
  },
}));
vi.mock('../web/request-image-draft.js', () => ({
  requestDraftKey: async (key: string) => `tab:${key}`,
}));
vi.mock('../web/api.js', () => ({ apiBinary: state.uploads }));
const model = { protocol: 'openai-responses-v1', modelId: 'gpt-6' } as const;
const key = (id: string) => `tab:helper-attachments:${id}`;
const document = () => new File(['manuscript reference'], '참고 자료.txt', { type: 'text/plain' });

beforeEach(() => {
  vi.resetModules();
  state.disk.clear();
  state.session.clear();
  state.cleanupFails = false;
  state.writeFails = false;
  state.uploads.mockReset();
  state.uploads.mockResolvedValue({ uploadId: 'upload-1', sha256: 'a'.repeat(64) });
  vi.stubGlobal('sessionStorage', {
    getItem: (name: string) => state.session.get(name) ?? null,
    setItem: (name: string, value: string) => state.session.set(name, value),
    removeItem: (name: string) => state.session.delete(name),
  });
});

test('conversation drafts preserve original blobs and hydrate without attaching another conversation', async () => {
  const saved: HelperAttachmentDraft = {
    token: 'reloaded-draft',
    images: [],
    files: [
      { id: 'file-1', name: '참고 자료.txt', mime: 'text/plain', kind: 'text', blob: document() },
    ],
  };
  state.disk.set(key('first'), { token: saved.token, revision: null, rawFields: {}, model: saved });
  const drafts = await import('../web/helper-attachment-draft.js');
  await Promise.all([
    drafts.loadHelperAttachments('first'),
    drafts.loadHelperAttachments('second'),
  ]);
  expect(await drafts.freezeHelperAttachments('second', model)).toEqual({
    draftToken: expect.any(String),
  });
  expect(state.uploads).not.toHaveBeenCalled();
  const frozen = await drafts.freezeHelperAttachments('first', model);
  expect(frozen).toEqual({
    draftToken: 'reloaded-draft',
    files: [{ uploadId: 'upload-1', sha256: 'a'.repeat(64), name: '참고 자료.txt' }],
  });
  expect(await (state.uploads.mock.calls[0][1] as Blob).text()).toBe('manuscript reference');
  expect(JSON.parse(JSON.stringify(frozen))).toEqual(frozen);
});

test('late admission keeps a newer draft even when the user retypes identical text', async () => {
  const drafts = await import('../web/helper-attachment-draft.js');
  await drafts.loadHelperAttachments('first');
  await drafts.addHelperAttachmentFiles('first', [document()], model);
  const sent = await drafts.freezeHelperAttachments('first', model);
  drafts.touchHelperAttachments('first');
  expect(drafts.helperAttachmentDraftMatches('first', sent.draftToken)).toBe(false);
  expect(await drafts.acceptHelperAttachments('first', sent.draftToken)).toBe(false);
  expect(state.disk.get(key('first'))?.model.files).toHaveLength(1);
  const next = await drafts.freezeHelperAttachments('first', model);
  expect(next.draftToken).not.toBe(sent.draftToken);
  expect(next.files).toEqual(sent.files);
  expect(await drafts.acceptHelperAttachments('first', next.draftToken)).toBe(true);
  expect(state.disk.has(key('first'))).toBe(false);
  expect((await drafts.freezeHelperAttachments('first', model)).files).toBeUndefined();
});

test('an accepted draft cannot resurrect after cleanup failure and a fresh page load', async () => {
  let drafts = await import('../web/helper-attachment-draft.js');
  await drafts.loadHelperAttachments('first');
  await drafts.addHelperAttachmentFiles('first', [document()], model);
  const frozen = await drafts.freezeHelperAttachments('first', model);
  state.cleanupFails = true;
  await expect(drafts.acceptHelperAttachments('first', frozen.draftToken)).rejects.toThrow(
    'disk unavailable'
  );
  expect(state.disk.has(key('first'))).toBe(true);
  vi.resetModules();
  drafts = await import('../web/helper-attachment-draft.js');
  state.cleanupFails = false;
  await drafts.loadHelperAttachments('first');
  expect((await drafts.freezeHelperAttachments('first', model)).files).toBeUndefined();
  expect(state.disk.has(key('first'))).toBe(false);
});

test('failed identity writes followed by reload cannot let an old receipt erase a retyped draft', async () => {
  let drafts = await import('../web/helper-attachment-draft.js');
  await drafts.loadHelperAttachments('first');
  await drafts.addHelperAttachmentFiles('first', [document()], model);
  const sent = await drafts.freezeHelperAttachments('first', model);
  state.writeFails = true;
  drafts.touchHelperAttachments('first');
  // Let the real queued persistence attempt settle before simulating a new page module.
  await expect(drafts.freezeHelperAttachments('first', model)).rejects.toThrow('disk unavailable');
  vi.resetModules();
  state.writeFails = false;
  drafts = await import('../web/helper-attachment-draft.js');
  await drafts.loadHelperAttachments('first');
  expect(drafts.helperAttachmentDraftMatches('first', sent.draftToken)).toBe(false);
  expect(await drafts.acceptHelperAttachments('first', sent.draftToken)).toBe(false);
  expect(state.disk.get(key('first'))?.model.files).toHaveLength(1);
  const recovered = await drafts.freezeHelperAttachments('first', model);
  expect(recovered.draftToken).not.toBe(sent.draftToken);
  expect(recovered.files).toEqual(sent.files);
});

test('unsupported selections are atomic and a later model change blocks sending retained files', async () => {
  const drafts = await import('../web/helper-attachment-draft.js');
  await drafts.loadHelperAttachments('first');
  await drafts.addHelperAttachmentFiles(
    'first',
    [document(), new File(['binary'], 'unknown.exe')],
    model
  );
  expect((await drafts.freezeHelperAttachments('first', model)).files).toBeUndefined();
  await drafts.addHelperAttachmentFiles('first', [document()], model);
  await expect(
    drafts.freezeHelperAttachments('first', {
      protocol: 'deepseek-chat-v1',
      modelId: 'deepseek-chat',
    })
  ).rejects.toThrow();
  expect(state.disk.get(key('first'))?.model.files).toHaveLength(1);
  expect((await drafts.freezeHelperAttachments('first', model)).files).toHaveLength(1);
});

test('deleting a conversation removes its retained local blobs', async () => {
  const drafts = await import('../web/helper-attachment-draft.js');
  await drafts.loadHelperAttachments('first');
  await drafts.addHelperAttachmentFiles('first', [document()], model);
  expect(state.disk.has(key('first'))).toBe(true);
  await drafts.deleteHelperAttachmentRecovery('first');
  expect(state.disk.has(key('first'))).toBe(false);
  expect((await drafts.freezeHelperAttachments('first', model)).files).toBeUndefined();
});

test('an image decoded after conversation deletion cannot recreate its saved draft', async () => {
  const drafts = await import('../web/helper-attachment-draft.js');
  let finish!: (bitmap: { width: number; height: number; close: () => void }) => void;
  vi.stubGlobal(
    'createImageBitmap',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await drafts.loadHelperAttachments('first');
  const adding = drafts.addHelperAttachmentFiles(
    'first',
    [new File(['synthetic image'], '늦은 이미지.png', { type: 'image/png' })],
    model
  );
  await drafts.deleteHelperAttachmentRecovery('first');
  finish({ width: 64, height: 48, close: () => {} });
  await adding;
  expect(state.disk.has(key('first'))).toBe(false);
  expect((await drafts.freezeHelperAttachments('first', model)).images).toBeUndefined();
});
