import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ContentEditModel, ResourceSaveResult } from '../core/resource-editing.js';
import { api, ApiError } from '../web/api.js';
import {
  readRecovery,
  writeRecovery,
  deleteRecoveryIfToken,
  type RecoveryBuffer,
} from '../web/editor-recovery.js';
import { ResourceEditorSession } from '../web/resource-editor-session.js';
import { nativeContentDraft } from '../web/native-content-draft.js';

vi.mock('../web/api.js', async (original) => ({
  ...(await original<typeof import('../web/api.js')>()),
  api: vi.fn(),
}));
vi.mock('../web/editor-recovery.js', () => ({
  readRecovery: vi.fn(),
  writeRecovery: vi.fn(),
  deleteRecoveryIfToken: vi.fn(),
}));

const model: ContentEditModel = {
  kind: 'bot',
  title: 'Original',
  description: '',
  text: 'Body',
  loading: 'pinned',
  relatedIds: [],
  package: nativeContentDraft('bot'),
};
const saved = (value = model, revision = 1, id = 'one') => ({ ...value, id, revision });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const sessions: ResourceEditorSession[] = [];
const disk = new Map<string, RecoveryBuffer<unknown>>();
function editor(targetId: string | null = 'one') {
  const session = new ResourceEditorSession({
    editorKey: targetId ? `content:${targetId}` : 'new:content:bot',
    kind: 'content',
    targetId,
    initialModel: model,
  });
  sessions.push(session);
  return session;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api).mockReset().mockResolvedValue(saved());
  disk.clear();
  vi.mocked(readRecovery)
    .mockReset()
    .mockImplementation(async (key) => structuredClone(disk.get(key)));
  vi.mocked(writeRecovery)
    .mockReset()
    .mockImplementation(async (key, value) => {
      if (value) disk.set(key, structuredClone(value));
      else disk.delete(key);
    });
  vi.mocked(deleteRecoveryIfToken)
    .mockReset()
    .mockImplementation(async (key, token) => {
      if (disk.get(key)?.token === token) disk.delete(key);
      return structuredClone(disk.get(key));
    });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
});
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('one owner applies consecutive updates and recognizes both form and raw-input reverts', async () => {
  const session = editor();
  await session.open();
  session.setModel((current) => ({ ...current, title: 'Edited' }));
  session.setModel((current) => ({ ...current, description: 'Latest' }));
  expect(session.snapshot().local.model).toMatchObject({ title: 'Edited', description: 'Latest' });
  expect(session.snapshot()).toMatchObject({ dirty: true, autosavePending: true });
  await session.flush();
  const token = disk.get('content:one')?.token;
  expect(token).toEqual(expect.any(String));
  session.setModel(model);
  expect(session.snapshot().dirty).toBe(false);
  session.setField('raw', '[unfinished');
  expect(session.snapshot().dirty).toBe(true);
  session.setField('raw', undefined);
  expect(session.snapshot()).toMatchObject({ dirty: false, autosavePending: false });
  await session.flush();
  expect(deleteRecoveryIfToken).toHaveBeenLastCalledWith('content:one', token);
  expect(disk.has('content:one')).toBe(false);
});

test('save acknowledges only sent input and preserves later edits with the accepted revision', async () => {
  const session = editor();
  await session.open();
  const first = { ...model, title: 'First' };
  const later = { ...first, description: 'Typed while saving' };
  session.setModel(first);
  const response = deferred<ResourceSaveResult>();
  const started = deferred<void>();
  vi.mocked(api).mockImplementationOnce(() => {
    started.resolve();
    return response.promise as ReturnType<typeof api>;
  });
  const saving = session.save();
  await started.promise;
  session.setModel(later);
  response.resolve({ saved: saved(first, 2), created: false });
  await saving;
  expect(session.snapshot()).toMatchObject({
    local: { model: later },
    document: { baseRevision: 2, baseModel: first },
    dirty: true,
    saving: false,
    autosavePending: true,
  });
  expect(writeRecovery).toHaveBeenLastCalledWith('content:one', {
    token: expect.any(String),
    revision: 2,
    model: later,
    rawFields: {},
  });
  vi.mocked(api).mockResolvedValueOnce({ saved: saved(later, 3), created: false });
  await session.save();
  expect(api).toHaveBeenLastCalledWith(
    '/resources/save',
    expect.objectContaining({
      id: 'one',
      expectedRevision: 2,
      model: later,
    })
  );
  expect(session.snapshot()).toMatchObject({ dirty: false, autosavePending: false });
});

test('new resources migrate ordered recovery writes to their saved ID without losing later input', async () => {
  const session = editor(null);
  await session.open();
  const first = { ...model, title: 'New card' };
  const later = { ...first, text: 'Still writing' };
  session.setModel(first);
  const stored = deferred<void>();
  vi.mocked(writeRecovery).mockReturnValueOnce(stored.promise);
  const oldWrite = session.flush();
  await Promise.resolve();
  await Promise.resolve();
  const response = deferred<ResourceSaveResult>();
  const started = deferred<void>();
  vi.mocked(api).mockImplementationOnce(() => {
    started.resolve();
    return response.promise as ReturnType<typeof api>;
  });
  const saving = session.save();
  await started.promise;
  session.setModel(later);
  response.resolve({ saved: saved(first, 1, 'created'), created: true });
  await Promise.resolve();
  expect(writeRecovery).toHaveBeenCalledTimes(1);
  stored.resolve();
  await oldWrite;
  await saving;
  expect(session.editorKey).toBe('content:created');
  expect(vi.mocked(writeRecovery).mock.calls).toEqual([
    ['new:content:bot', { token: expect.any(String), revision: null, model: first, rawFields: {} }],
    ['content:created', { token: expect.any(String), revision: 1, model: later, rawFields: {} }],
  ]);
  expect(deleteRecoveryIfToken).toHaveBeenCalledWith(
    'new:content:bot',
    vi.mocked(writeRecovery).mock.calls[0][1]?.token
  );
});

test('invalid recovered input stays local, waits for explicit save, and blocks helper capture', async () => {
  vi.mocked(readRecovery).mockResolvedValueOnce({
    revision: 1,
    model,
    rawFields: { raw: '[unfinished' },
  });
  const session = editor();
  await session.open();
  expect(session.snapshot()).toMatchObject({
    dirty: true,
    autosavePending: false,
    recovery: 'saved',
  });
  session.pendingField('raw', true);
  session.prepareOnSave('raw', () => {
    throw new Error('Invalid JSON');
  });
  expect(() => session.captureForHelper()).toThrow('Invalid JSON');
  await expect(session.save()).rejects.toThrow('Invalid JSON');
  expect(api).toHaveBeenCalledTimes(1);
  expect(session.snapshot().local.rawFields.raw).toBe('[unfinished');
  expect(session.snapshot().saving).toBe(false);
});

test('helper capture is detached from later edits and clean resources send only their revision', async () => {
  const session = editor();
  await session.open();
  expect(session.captureForHelper()).toMatchObject({
    source: 'saved',
    targetId: 'one',
    revision: 1,
  });
  expect(session.captureForHelper()).not.toHaveProperty('model');
  session.setModel({ ...model, title: 'Captured' });
  session.prepareOnSave('raw', (current) => ({ ...current, text: 'Prepared input' }));
  const capture = session.captureForHelper();
  session.setModel({ ...model, title: 'Later' });
  expect(capture).toMatchObject({
    source: 'unsaved',
    model: { title: 'Captured', text: 'Prepared input' },
  });
});

test('closing during initial recovery loading never deletes the unread buffer', async () => {
  const recovery = deferred<RecoveryBuffer<ContentEditModel> | undefined>();
  vi.mocked(readRecovery).mockReturnValueOnce(recovery.promise);
  const session = editor();
  const opening = session.open();
  await Promise.resolve();
  expect(readRecovery).toHaveBeenCalled();
  expect(session.snapshot().ready).toBe(false);
  session.dispose();
  recovery.resolve({ revision: 1, model: { ...model, title: 'Recovered' }, rawFields: {} });
  await opening;
  expect(writeRecovery).not.toHaveBeenCalled();
  expect(session.snapshot().ready).toBe(false);
});

test('late refreshes cannot replace a newer save, and external revisions preserve dirty input', async () => {
  const session = editor();
  await session.open();
  const response = deferred<ReturnType<typeof saved>>();
  const started = deferred<void>();
  vi.mocked(api).mockImplementationOnce(() => {
    started.resolve();
    return response.promise as ReturnType<typeof api>;
  });
  const refreshing = session.refresh();
  await started.promise;
  const local = { ...model, title: 'Local' };
  session.setModel(local);
  vi.mocked(api).mockResolvedValueOnce({ saved: saved(local, 3), created: false });
  await session.save();
  response.resolve(saved({ ...model, title: 'Old response' }, 2));
  await refreshing;
  expect(session.snapshot()).toMatchObject({
    local: { model: local },
    document: { baseRevision: 3 },
  });
  session.setModel({ ...local, text: 'Unsaved' });
  vi.mocked(api).mockResolvedValueOnce(saved({ ...model, title: 'External' }, 4));
  await session.refresh();
  expect(session.snapshot()).toMatchObject({
    conflict: true,
    local: { model: { text: 'Unsaved' } },
  });
  await expect(session.save()).rejects.toThrow('저장된 자료가 바뀌었어요');
});

test('save conflicts preserve local input and clean reload restores the latest baseline', async () => {
  const session = editor();
  await session.open();
  session.setModel({ ...model, title: 'Keep me' });
  vi.mocked(api).mockRejectedValueOnce(new ApiError('Revision changed', 409));
  await expect(session.save()).rejects.toThrow('Revision changed');
  expect(session.snapshot()).toMatchObject({
    dirty: true,
    conflict: true,
    local: { model: { title: 'Keep me' } },
  });
  const latest = { ...model, title: 'External' };
  vi.mocked(api).mockResolvedValueOnce(saved(latest, 2));
  await session.reloadSaved();
  expect(session.snapshot()).toMatchObject({
    dirty: false,
    conflict: false,
    local: { model: latest },
    document: { baseRevision: 2 },
  });
});

test('closing after a recovery read failure does not erase unread input', async () => {
  vi.mocked(readRecovery).mockRejectedValueOnce(new Error('Temporary read failure'));
  const session = editor();
  await session.open();
  expect(session.snapshot()).toMatchObject({ ready: true, dirty: false, recovery: 'failed' });
  session.dispose();
  await vi.runAllTimersAsync();
  expect(writeRecovery).not.toHaveBeenCalled();
});

test.each(['save', 'discard', 'revert', 'copy'] as const)(
  '%s only clears its own recovery write, preserving another tab across reopen',
  async (action) => {
    const a = editor();
    const b = editor();
    await a.open();
    await b.open();
    const own = { ...model, title: 'B saved input' };
    const newer = { ...model, title: 'A newer unsaved input' };
    b.setModel(own);
    await b.flush();
    const ownToken = disk.get('content:one')?.token;
    a.setModel(newer);
    await a.flush();
    const newerToken = disk.get('content:one')?.token;
    expect(newerToken).not.toBe(ownToken);
    if (action === 'save' || action === 'copy') {
      vi.mocked(api).mockResolvedValueOnce({
        saved: saved(own, 2, action === 'copy' ? 'copy' : 'one'),
        created: action === 'copy',
      });
      await b.save(undefined, { copy: action === 'copy' });
    } else if (action === 'discard') await b.discard();
    else {
      b.setModel(model);
      await b.flush();
    }
    expect(deleteRecoveryIfToken).toHaveBeenCalledWith('content:one', ownToken);
    expect(disk.get('content:one')).toMatchObject({ token: newerToken, model: newer });
    const reopened = editor();
    await reopened.open();
    expect(reopened.snapshot()).toMatchObject({ local: { model: newer }, recovery: 'saved' });
  }
);

test.each([undefined, 'existing-token'])(
  'discard removes a loaded recovery buffer with token %s',
  async (token) => {
    disk.set('content:one', {
      token,
      revision: 1,
      model: { ...model, title: 'Recovered' },
      rawFields: {},
    });
    const session = editor();
    await session.open();
    await session.discard();
    expect(deleteRecoveryIfToken).toHaveBeenCalledWith('content:one', token);
    expect(disk.has('content:one')).toBe(false);
  }
);

test('a clean session with no loaded buffer cannot clear another tab recovery', async () => {
  const clean = editor();
  const dirty = editor();
  await clean.open();
  await dirty.open();
  dirty.setModel({ ...model, title: 'Other tab' });
  await dirty.flush();
  await clean.flush();
  expect(deleteRecoveryIfToken).not.toHaveBeenCalled();
  expect(disk.get('content:one')?.model).toMatchObject({ title: 'Other tab' });
});
