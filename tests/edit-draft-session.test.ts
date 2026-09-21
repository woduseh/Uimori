import { encodeDraftSaveResult } from '../core/edit-draft-save-wire.js';
import { editDraftRevisions } from '../server/edit-draft-revisions.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { EditDraftService, initEditDrafts, type DraftAuthority } from '../server/edit-drafts.js';
import { EditorDraftSession } from '../web/editor-workspace-context.js';
import type { ContentDraftModel, WorkspaceDraftModel } from '../core/edit-drafts.js';
import type { Content } from '../core/product.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeDraftTitle } from './fixtures/native-content.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { HttpError } from '../server/request-validation.js';

let dir: string, store: Store, service: EditDraftService;
let failResponse: 'save' | 'patch' | null;
let holdPatch: (() => Promise<void>) | null;
let holdRead: (() => Promise<void>) | null;
let holdRebase: (() => Promise<void>) | null;
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const authority: DraftAuthority = { requestId: 'direct-user-test', assert: () => {} };
beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'uimori-draft-session-'));
  store = new Store(join(dir, 'test.sqlite'));
  initEditDrafts(store);
  service = new EditDraftService(store);
  failResponse = null;
  holdPatch = null;
  holdRead = null;
  holdRebase = null;
  const cache = new Map<string, string>(),
    events = new EventTarget();
  vi.stubGlobal('window', events);
  vi.stubGlobal('dispatchEvent', events.dispatchEvent.bind(events));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
  });
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    const path = url.replace(/^\/api/, ''),
      method = options?.method ?? 'GET';
    const input = options?.body ? JSON.parse(String(options.body)) : undefined;
    try {
      let result: unknown;
      if (path.startsWith('/edit-drafts?'))
        result = service.list(
          new URLSearchParams(path.split('?')[1]).get('editorKey') ?? undefined
        );
      else if (path === '/edit-drafts') result = service.create(input, authority);
      else {
        const [, , id, action] = path.split('/');
        if (action === 'save') result = encodeDraftSaveResult(service.save(id, input, authority));
        else if (action === 'undo')
          result = encodeDraftSaveResult(service.undo(id, input, authority));
        else if (action === 'revisions') result = editDraftRevisions(store.db, id);
        else if (action === 'saved-target') result = service.savedTarget(id);
        else if (action === 'rebase') {
          if (holdRebase) await holdRebase();
          result = service.rebase(id, input, authority);
        } else if (method === 'PATCH') {
          if (holdPatch) await holdPatch();
          result = service.patch(id, input, authority);
        } else if (method === 'DELETE') result = service.discard(id, input, authority);
        else {
          result = service.get(id);
          if (holdRead) await holdRead();
        }
        if (
          (action === 'save' && failResponse === 'save') ||
          (method === 'PATCH' && failResponse === 'patch')
        ) {
          failResponse = null;
          throw new TypeError('Network response lost after durable write');
        }
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  store.close();
  const target = resolve(dir),
    within = relative(resolve(tmpdir()), target);
  if (
    isAbsolute(within) ||
    within.startsWith('..') ||
    !basename(target).startsWith('uimori-draft-session-')
  )
    throw new Error('Unsafe cleanup');
  rmSync(target, { recursive: true, force: true });
});
const session = () =>
  new EditorDraftSession({
    editorKey: 'new:content:bot',
    kind: 'content',
    targetId: null,
    initialModel: fixtureBotInput('Original', 'Body'),
  });
const title = (editor: EditorDraftSession, value: string) =>
  editor.setModel(nativeDraftTitle(editor.snapshot().local.model, value));

test('a second editor restores exact incomplete text from the common server draft', async () => {
  const first = session();
  await first.open();
  first.setField('package.nativeRisu.card', '{"actions":[');
  first.pendingField('package.nativeRisu.card', true);
  await first.flush();
  const second = session();
  await second.open();
  expect(second.snapshot().draft?.id).toBe(first.snapshot().draft?.id);
  expect(second.snapshot().local.rawFields).toEqual({ 'package.nativeRisu.card': '{"actions":[' });
  expect(second.snapshot().local.unappliedFields).toEqual(['package.nativeRisu.card']);
  expect(store.product.all('content')).toHaveLength(0);
});

test('typing during an in-flight patch is sent as the next revision without being replaced by its acknowledgement', async () => {
  const editor = session();
  await editor.open();
  title(editor, 'First');
  const entered = latch(),
    release = latch();
  holdPatch = async () => {
    entered.resolve();
    await release.promise;
    holdPatch = null;
  };
  const flushing = editor.flush();
  await entered.promise;
  title(editor, 'Typed while synchronizing');
  release.resolve();
  await flushing;
  expect((service.get(editor.snapshot().draft!.id).model as ContentDraftModel).title).toBe(
    'Typed while synchronizing'
  );
  expect(editor.snapshot().dirty).toBe(false);
});

test('a helper race preserves local typing and an intervening second edit still requires a fresh comparison', async () => {
  const editor = session();
  await editor.open();
  const original = editor.snapshot().draft!;
  title(editor, 'My typing');
  const remote = service.patch(
    original.id,
    {
      expectedRevision: original.revision,
      operationId: randomUUID(),
      model: nativeDraftTitle(original.model, 'Helper proposal'),
      rawFields: {},
      unappliedFields: [],
    },
    authority
  ).draft;
  await expect(editor.flush()).rejects.toThrow(/먼저 반영/);
  expect((editor.snapshot().local.model as ContentDraftModel).title).toBe('My typing');
  service.patch(
    remote.id,
    {
      expectedRevision: remote.revision,
      operationId: randomUUID(),
      model: nativeDraftTitle(remote.model, 'Another user'),
      rawFields: {},
      unappliedFields: [],
    },
    authority
  );
  await expect(editor.reapply()).rejects.toThrow(/먼저 반영/);
  expect((service.get(original.id).model as ContentDraftModel).title).toBe('Another user');
  await editor.reapply();
  expect((service.get(original.id).model as ContentDraftModel).title).toBe('My typing');
});

test('a lost save response is replayed without duplicate content and later typing stays local until the receipt is known', async () => {
  const editor = session();
  await editor.open();
  title(editor, 'Saved title');
  failResponse = 'save';
  await expect(editor.save()).rejects.toThrow(/response lost/);
  title(editor, 'Typed after uncertain save');
  await expect(editor.flush()).rejects.toThrow(/이전 저장/);
  const result = await editor.save();
  expect((result.saved as ContentDraftModel).title).toBe('Saved title');
  expect(store.product.all('content')).toHaveLength(1);
  expect((editor.snapshot().local.model as ContentDraftModel).title).toBe(
    'Typed after uncertain save'
  );
  await editor.flush();
  expect((service.get(result.draft.id).model as ContentDraftModel).title).toBe(
    'Typed after uncertain save'
  );
});

test('reload after an uncertain patch replays its cached operation before sending newer text', async () => {
  const editor = session();
  await editor.open();
  title(editor, 'First');
  failResponse = 'patch';
  await expect(editor.flush()).rejects.toThrow(/response lost/);
  title(editor, 'Second');
  const restored = session();
  await restored.open();
  await restored.flush();
  expect((service.get(restored.snapshot().draft!.id).model as ContentDraftModel).title).toBe(
    'Second'
  );
  expect(service.proposals(restored.snapshot().draft!.id)).toHaveLength(0);
});

function contentEditor(content: Content) {
  return new EditorDraftSession({
    editorKey: `content:${content.id}`,
    kind: 'content',
    targetId: content.id,
    initialModel: fixtureBotInput(content.title, content.text),
  });
}
function updateContent(content: Content, nextTitle = 'Latest saved') {
  return store.product.content(
    { ...fixtureBotInput(nextTitle, 'Changed saved body'), expectedRevision: content.revision },
    content.id
  ) as Content;
}

test('opening and refreshing a pristine workspace draft follows newer saved settings', async () => {
  const initial = promptWorkspace(store);
  const draft = service.create(
    {
      editorKey: 'prompt-workspace:current',
      kind: 'prompt-workspace',
      targetId: 'current',
      model: { main: initial.main, translation: initial.translation },
      operationId: randomUUID(),
    },
    authority
  );
  const newer = updatePromptWorkspace(store, {
    expectedRevision: initial.revision,
    main: { ...initial.main, title: 'New current prompt' },
  });
  const editor = new EditorDraftSession({
    editorKey: draft.editorKey,
    kind: draft.kind,
    targetId: draft.targetId,
    initialModel: draft.model,
  });
  await editor.open();
  expect(editor.snapshot().draft?.baseRevision).toBe(newer.revision);
  expect((editor.snapshot().local.model as WorkspaceDraftModel).main.title).toBe(
    'New current prompt'
  );
  const latest = updatePromptWorkspace(store, {
    expectedRevision: newer.revision,
    main: { ...newer.main, title: 'Updated from another device' },
  });
  await editor.refresh();
  expect(editor.snapshot().draft?.baseRevision).toBe(latest.revision);
  expect((editor.snapshot().local.model as WorkspaceDraftModel).main.title).toBe(
    'Updated from another device'
  );
  expect(editor.snapshot().dirty).toBe(false);
  expect(promptWorkspace(store)).toEqual(latest);
});

test('a saved-target update preserves cached typing and synced incomplete raw fields', async () => {
  const content = store.product.content(fixtureBotInput('Saved', 'Original body')) as Content;
  const editor = contentEditor(content);
  await editor.open();
  editor.setField('package.nativeRisu.card', '{"actions":[');
  const newer = updateContent(content);
  const restored = contentEditor(newer);
  await restored.open();
  expect(restored.snapshot().local.rawFields).toEqual({
    'package.nativeRisu.card': '{"actions":[',
  });
  expect(restored.snapshot().draft?.baseRevision).toBe(content.revision);
  await restored.flush();
  expect(restored.snapshot().dirty).toBe(false);
  await restored.refresh();
  expect(restored.snapshot().local.rawFields).toEqual({
    'package.nativeRisu.card': '{"actions":[',
  });
  expect(restored.snapshot().draft?.baseRevision).toBe(content.revision);
  const nextDevice = contentEditor(newer);
  await nextDevice.open();
  expect(nextDevice.snapshot().local.rawFields).toEqual({
    'package.nativeRisu.card': '{"actions":[',
  });
  expect(nextDevice.snapshot().draft?.baseRevision).toBe(content.revision);
  expect(store.product.get<Content>('content', content.id)).toEqual(newer);
});

test('a late draft refresh does not replace typing entered while its response waited', async () => {
  const editor = session();
  await editor.open();
  const initial = editor.snapshot().draft!;
  service.patch(
    initial.id,
    {
      expectedRevision: initial.revision,
      operationId: randomUUID(),
      model: nativeDraftTitle(initial.model, 'Remote synced draft'),
      rawFields: {},
      unappliedFields: [],
    },
    authority
  );
  const entered = latch(),
    release = latch();
  holdRead = async () => {
    entered.resolve();
    await release.promise;
    holdRead = null;
  };
  const refreshing = editor.refresh();
  await entered.promise;
  title(editor, 'Typed during refresh');
  release.resolve();
  await refreshing;
  expect((editor.snapshot().local.model as ContentDraftModel).title).toBe('Typed during refresh');
  expect(editor.snapshot().draft?.revision).toBe(initial.revision);
  await expect(editor.flush()).rejects.toThrow(/먼저 반영/);
  expect(service.proposals(initial.id)).toHaveLength(1);
  expect((service.get(initial.id).model as ContentDraftModel).title).toBe('Remote synced draft');
});

test('a concurrent server edit rejects automatic pristine rebase without losing its raw draft', async () => {
  const content = store.product.content(fixtureBotInput('Saved', 'Original body')) as Content;
  const editor = contentEditor(content);
  await editor.open();
  const initial = editor.snapshot().draft!;
  const newer = updateContent(content);
  const entered = latch(),
    release = latch();
  holdRebase = async () => {
    entered.resolve();
    await release.promise;
    holdRebase = null;
  };
  const refreshing = editor.refresh();
  await entered.promise;
  const remote = service.patch(
    initial.id,
    {
      expectedRevision: initial.revision,
      operationId: randomUUID(),
      model: initial.model,
      rawFields: { json: '{"remote":' },
      unappliedFields: ['json'],
    },
    authority
  ).draft;
  release.resolve();
  await refreshing;
  expect(editor.snapshot().error).toMatch(/먼저 반영/);
  expect(service.get(initial.id)).toEqual(remote);
  await editor.refresh();
  expect(editor.snapshot().local.rawFields).toEqual(remote.rawFields);
  expect(editor.snapshot().draft?.baseRevision).toBe(content.revision);
  expect(store.product.get<Content>('content', content.id)).toEqual(newer);
});

test('typing during automatic saved-target rebase requires comparison with the new base', async () => {
  const content = store.product.content(fixtureBotInput('Saved', 'Original body')) as Content;
  const editor = contentEditor(content);
  await editor.open();
  const newer = updateContent(content);
  const entered = latch(),
    release = latch();
  holdRebase = async () => {
    entered.resolve();
    await release.promise;
    holdRebase = null;
  };
  const refreshing = editor.refresh();
  await entered.promise;
  editor.setField('package.nativeRisu.card', '{"local":');
  title(editor, 'Typed against original source');
  release.resolve();
  await refreshing;
  expect(editor.snapshot().local.rawFields).toEqual({ 'package.nativeRisu.card': '{"local":' });
  expect((editor.snapshot().local.model as ContentDraftModel).title).toBe(
    'Typed against original source'
  );
  expect(editor.snapshot().draft?.baseRevision).toBe(newer.revision);
  expect(editor.snapshot().conflict).toBe(true);
  await expect(editor.flush()).rejects.toThrow(/다른 곳에서 초안이 바뀌/);
  expect((service.get(editor.snapshot().draft!.id).model as ContentDraftModel).title).toBe(
    newer.title
  );
  expect(store.product.get<Content>('content', content.id)).toEqual(newer);
});

test('unchanged saved content refreshes only revision metadata', async () => {
  const content = store.product.content(fixtureBotInput('Probe target', 'Body')) as Content;
  const editor = contentEditor(content);
  await editor.open();
  const requests = vi.spyOn(globalThis, 'fetch');
  requests.mockClear();
  await editor.refresh();
  await editor.refresh();
  expect(requests.mock.calls.map(([url]) => String(url))).toEqual([
    `/api/edit-drafts/${editor.snapshot().draft!.id}/revisions`,
    `/api/edit-drafts/${editor.snapshot().draft!.id}/revisions`,
  ]);
});

test('a delayed revision probe cannot replace newer local typing', async () => {
  const content = store.product.content(fixtureBotInput('Probe race', 'Body')) as Content;
  const editor = contentEditor(content);
  await editor.open();
  updateContent(content, 'Changed on another device');
  const entered = latch(),
    release = latch();
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    const response = await originalFetch(url, options);
    if (String(url).endsWith('/revisions')) {
      entered.resolve();
      await release.promise;
    }
    return response;
  });
  const refreshing = editor.refresh();
  await entered.promise;
  title(editor, 'My local typing');
  release.resolve();
  await refreshing;
  expect((editor.snapshot().local.model as ContentDraftModel).title).toBe('My local typing');
  expect(editor.snapshot().draft!.baseRevision).toBe(content.revision);
});

test('copy uses the single save contract and replays a lost receipt without another item', async () => {
  const editor = session();
  await editor.open();
  const original = structuredClone(editor.snapshot().local.model);
  const copiedModel = nativeDraftTitle(original, 'Copied once');
  failResponse = 'save';
  await expect(editor.copy('content', copiedModel)).rejects.toThrow(/response lost/);
  expect(store.product.all('content')).toHaveLength(1);
  const requests = vi.spyOn(globalThis, 'fetch');
  requests.mockClear();
  const result = await editor.copy('content', copiedModel);
  expect(store.product.all('content')).toHaveLength(1);
  expect(result.draft.model).toEqual(result.draft.baseModel);
  expect(result.draft.model).not.toBe(result.draft.baseModel);
  expect((result.saved as Content).title).toBe('Copied once');
  expect(editor.snapshot().local.model).toEqual(original);
  expect(requests.mock.calls.map(([url]) => String(url))).toEqual([
    `/api/edit-drafts/${result.draft.id}/save`,
  ]);
});

test('undo decodes the single save contract before adopting editable and baseline models', async () => {
  const content = store.product.content(fixtureBotInput('Before undo', 'Body')) as Content;
  const editor = contentEditor(content);
  await editor.open();
  title(editor, 'Changed before undo');
  const saved = await editor.save();
  await editor.undo(saved.operationId);
  const restored = editor.snapshot();
  expect((restored.local.model as ContentDraftModel).title).toBe(content.title);
  expect(restored.draft!.model).toEqual(restored.draft!.baseModel);
  expect(restored.draft!.model).not.toBe(restored.draft!.baseModel);
  expect(restored.dirty).toBe(false);
  expect(store.product.get<Content>('content', content.id).revision).toBe(content.revision + 2);
});
