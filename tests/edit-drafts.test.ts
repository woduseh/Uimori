import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import {
  EditDraftService,
  initEditDrafts,
  validateEditDraftArchive,
  type DraftAuthority,
} from '../server/edit-drafts.js';
import type { ContentDraftModel, EditDraft } from '../core/edit-drafts.js';
import type { Content } from '../core/product.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { promptWorkspace } from '../server/prompt-workspace.js';

const owned: { dir: string; store: Store }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    const dir = resolve(item.dir),
      within = relative(resolve(tmpdir()), dir);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(dir).startsWith('uimori-edit-drafts-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-edit-drafts-')),
    store = new Store(join(dir, 'story.sqlite'));
  owned.push({ dir, store });
  initEditDrafts(store);
  return { store, service: new EditDraftService(store) };
}
const authority: DraftAuthority = { requestId: 'explicit-user-request', assert: () => {} };
function create(service: EditDraftService, targetId: string | null = null) {
  return service.create(
    {
      editorKey: targetId ? `content:${targetId}` : 'new:content:bot',
      kind: 'content',
      targetId,
      model: fixtureBotInput('New draft', 'Original body'),
      operationId: randomUUID(),
    },
    authority
  );
}
function patch(service: EditDraftService, draft: EditDraft, title: string) {
  return service.patch(
    draft.id,
    {
      expectedRevision: draft.revision,
      operationId: randomUUID(),
      model: { ...draft.model, title },
      rawFields: {},
      unappliedFields: [],
    },
    authority
  );
}

test('shared drafts restore exact incomplete buffers, keep a late proposal and never overwrite a second editor', () => {
  const { service } = fixture(),
    original = create(service);
  const incomplete = service.patch(
    original.id,
    {
      expectedRevision: original.revision,
      operationId: randomUUID(),
      model: { ...original.model, title: 'Typed in another device' },
      rawFields: { 'package.behavior': '{"actions":[' },
      unappliedFields: ['package.behavior'],
    },
    authority
  );
  expect(incomplete.status).toBe('applied');
  const restored = new EditDraftService(service.store).list('new:content:bot')[0];
  expect(restored.rawFields['package.behavior']).toBe('{"actions":[');
  expect(service.validate(restored.id).valid).toBe(false);
  const late = patch(service, original, 'Late helper edit');
  expect(late.status).toBe('conflict');
  expect(service.get(original.id).model).toEqual(restored.model);
  expect(service.proposals(original.id)[0].model).toEqual({
    ...original.model,
    title: 'Late helper edit',
  });
});

test('validation does not save; a repeated new-item save returns the receipt and creates exactly one content', () => {
  const { store, service } = fixture(),
    draft = create(service);
  const before = store.product.all('content').length;
  expect(service.validate(draft.id)).toEqual({ valid: true, errors: [] });
  expect(store.product.all('content')).toHaveLength(before);
  const input = { expectedRevision: draft.revision, operationId: randomUUID() };
  const saved = service.save(draft.id, input, authority);
  expect(saved.status).toBe('saved');
  expect(saved.created).toBe(true);
  expect(service.save(draft.id, input, authority)).toEqual(saved);
  expect(store.product.all('content')).toHaveLength(before + 1);
  expect(() =>
    service.save(draft.id, { ...input, expectedRevision: saved.draft.revision }, authority)
  ).toThrow(/another request/);
});

test('a stale stored revision rolls back the draft and operation receipt while retaining user text', () => {
  const { store, service } = fixture();
  const content = store.product.content(fixtureBotInput('Saved', 'Original')) as Content;
  const draft = patch(service, create(service, content.id), 'My pending edit').draft;
  store.product.content(
    { ...fixtureBotInput('Other user', 'Changed'), expectedRevision: content.revision },
    content.id
  );
  expect(() =>
    service.save(
      draft.id,
      { expectedRevision: draft.revision, operationId: 'stale-save' },
      authority
    )
  ).toThrow(/Revision conflict/);
  expect(service.get(draft.id)).toEqual(draft);
  expect(
    store.db.prepare('SELECT 1 FROM edit_draft_operations WHERE operation_id=?').get('stale-save')
  ).toBeUndefined();
});

test('discarded draft identities are not reused and a late helper cannot mutate a recreated draft', () => {
  const { service } = fixture(),
    old = create(service);
  service.discard(old.id, { expectedRevision: old.revision, operationId: randomUUID() }, authority);
  const replacement = create(service);
  expect(replacement.id).not.toBe(old.id);
  expect(() => patch(service, old, 'Late write')).toThrow(/폐기/);
  expect(service.get(replacement.id).model).toEqual(replacement.model);
});

test('an authority rejection applies before any write, including receipt replay', () => {
  const { service } = fixture(),
    draft = create(service);
  const denied: DraftAuthority = {
    requestId: authority.requestId,
    assert: () => {
      throw new Error('Not authorized for shared original');
    },
  };
  const input = { expectedRevision: draft.revision, operationId: randomUUID() };
  expect(() => service.save(draft.id, input, denied)).toThrow(/Not authorized/);
  expect(service.get(draft.id)).toEqual(draft);
  service.save(draft.id, input, authority);
  expect(() => service.save(draft.id, input, denied)).toThrow(/Not authorized/);
});

test('undo creates a new content revision and refuses subsequent user changes', () => {
  const { store, service } = fixture();
  const content = store.product.content(fixtureBotInput('Original title', 'Original')) as Content;
  let draft = patch(service, create(service, content.id), 'Helper title').draft;
  const saved = service.save(
    draft.id,
    { expectedRevision: draft.revision, operationId: randomUUID() },
    authority
  );
  const undone = service.undo(
    draft.id,
    {
      expectedRevision: saved.draft.revision,
      operationId: randomUUID(),
      savedOperationId: saved.operationId,
    },
    authority
  );
  expect((undone.saved as Content).title).toBe('Original title');
  expect(undone.saved.revision).toBe(content.revision + 2);
  expect(store.product.get<Content>('content', content.id, saved.saved.revision).title).toBe(
    'Helper title'
  );
  draft = patch(service, undone.draft, 'More edits').draft;
  expect(() =>
    service.undo(
      draft.id,
      {
        expectedRevision: draft.revision,
        operationId: randomUUID(),
        savedOperationId: undone.operationId,
      },
      authority
    )
  ).toThrow(/편집/);
});

test('shared impact follows parent modules to chat attachment roles', () => {
  const { store, service } = fixture();
  const module = store.product.content({
    ...fixtureBotInput('Shared module', 'Lore'),
    kind: 'module',
  }) as Content;
  const input = fixtureBotInput('Parent bot', 'Bot');
  input.package.modules = [{ id: module.id, revision: module.revision }];
  const bot = store.product.content(input) as Content;
  const chat = store.createChat('Attached story', 'calm', { botId: bot.id });
  const impact = service.impact(create(service, module.id).id);
  expect(impact.contents).toEqual(
    expect.arrayContaining([{ id: bot.id, title: 'Parent bot', indirect: true }])
  );
  expect(impact.chats).toEqual([{ id: chat.id, title: chat.title, roles: ['bot'] }]);
});

test('prompt workspace drafts share the current save validator and preserve model settings', () => {
  const { store, service } = fixture(),
    workspace = promptWorkspace(store);
  const draft = service.create(
    {
      editorKey: 'prompt-workspace:current',
      kind: 'prompt-workspace',
      targetId: 'current',
      operationId: randomUUID(),
    },
    authority
  );
  const result = service.patch(
    draft.id,
    {
      expectedRevision: draft.revision,
      operationId: randomUUID(),
      model: {
        main: { ...workspace.main, title: 'Edited writer' },
        translation: workspace.translation,
      },
      rawFields: {},
      unappliedFields: [],
    },
    authority
  );
  expect(service.validate(draft.id).valid).toBe(true);
  expect(promptWorkspace(store)).toEqual(workspace);
  service.save(
    draft.id,
    { expectedRevision: result.draft.revision, operationId: randomUUID() },
    authority
  );
  expect(promptWorkspace(store).main.title).toBe('Edited writer');
  expect(promptWorkspace(store).modelRoutes).toEqual(workspace.modelRoutes);
});

test('new models remain editable while unsupported save fields and incomplete buffers are rejected', () => {
  const { service } = fixture(),
    draft = create(service);
  const model = { ...draft.model, kind: 'unsupported' } as unknown as ContentDraftModel;
  const updated = service.patch(
    draft.id,
    {
      expectedRevision: draft.revision,
      operationId: randomUUID(),
      model,
      rawFields: {},
      unappliedFields: [],
    },
    authority
  );
  expect(updated.status).toBe('applied');
  expect(service.validate(draft.id).valid).toBe(false);
  expect(() =>
    service.save(
      draft.id,
      { expectedRevision: updated.draft.revision, operationId: randomUUID(), authorization: true },
      authority
    )
  ).toThrow();
});

test('rebase uses the reviewed source revision and retains incomplete buffers until explicitly restored', () => {
  const { store, service } = fixture();
  const content = store.product.content(fixtureBotInput('Saved', 'Original')) as Content;
  const initial = create(service, content.id);
  const draft = service.patch(
    initial.id,
    {
      expectedRevision: initial.revision,
      operationId: randomUUID(),
      model: { ...initial.model, title: 'Local title' },
      rawFields: { json: '{' },
      unappliedFields: ['json'],
    },
    authority
  ).draft;
  const newer = store.product.content(
    { ...fixtureBotInput('Remote title', 'Changed'), expectedRevision: content.revision },
    content.id
  ) as Content;
  expect(() =>
    service.rebase(
      draft.id,
      {
        expectedRevision: draft.revision,
        expectedTargetRevision: content.revision,
        mode: 'keep-draft',
        operationId: randomUUID(),
      },
      authority
    )
  ).toThrow(/다시 변경/);
  const kept = service.rebase(
    draft.id,
    {
      expectedRevision: draft.revision,
      expectedTargetRevision: newer.revision,
      mode: 'keep-draft',
      operationId: randomUUID(),
    },
    authority
  );
  expect(kept.rawFields).toEqual({ json: '{' });
  expect((kept.baseModel as ContentDraftModel).title).toBe('Remote title');
  expect((kept.model as ContentDraftModel).title).toBe('Local title');
  const restored = service.rebase(
    draft.id,
    {
      expectedRevision: kept.revision,
      expectedTargetRevision: newer.revision,
      mode: 'saved',
      operationId: randomUUID(),
    },
    authority
  );
  expect(restored.model).toEqual(restored.baseModel);
  expect(restored.rawFields).toEqual({});
  expect(service.savedTarget(draft.id)).toEqual({
    revision: newer.revision,
    model: restored.model,
  });
});

test('saved operation review exposes forward and undo differences without mutating source', () => {
  const { store, service } = fixture();
  const content = store.product.content(fixtureBotInput('Original', 'Body')) as Content;
  const draft = patch(service, create(service, content.id), 'Updated').draft;
  const saved = service.save(
    draft.id,
    { expectedRevision: draft.revision, operationId: randomUUID() },
    authority
  );
  const history = service.savedOperations(draft.id);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    operationId: saved.operationId,
    savedRevision: saved.saved.revision,
    changes: expect.arrayContaining([{ path: '/title', before: 'Original', after: 'Updated' }]),
    undoChanges: expect.arrayContaining([{ path: '/title', before: 'Updated', after: 'Original' }]),
  });
  expect(store.product.get<Content>('content', content.id).title).toBe('Updated');
});

test('pristine rebases adopt a newer saved source once and retain archive replay identity', () => {
  const { store, service } = fixture();
  const content = store.product.content(fixtureBotInput('Original', 'Original body')) as Content;
  const draft = create(service, content.id);
  const newer = store.product.content(
    { ...fixtureBotInput('Latest saved', 'Latest body'), expectedRevision: content.revision },
    content.id
  ) as Content;
  const command = {
    expectedRevision: draft.revision,
    expectedTargetRevision: newer.revision,
    mode: 'pristine',
    operationId: randomUUID(),
  };
  const result = service.rebase(draft.id, command, authority);
  expect(result.baseRevision).toBe(newer.revision);
  expect(result.model).toEqual(result.baseModel);
  expect((result.model as ContentDraftModel).title).toBe('Latest saved');
  expect(service.rebase(draft.id, command, authority)).toEqual(result);
  expect(() => service.rebase(draft.id, { ...command, mode: 'saved' }, authority)).toThrow(
    /already belongs/
  );
  expect(() => service.rebase(draft.id, { ...command, mode: ['pristine'] }, authority)).toThrow(
    /Invalid draft rebase mode/
  );
  expect(store.product.get<Content>('content', content.id)).toEqual(newer);
  expect(store.product.get<Content>('content', content.id, content.revision)).toEqual(content);
  validateEditDraftArchive(store);
  const restored = fixture();
  restored.store.product.import(store.product.export());
  validateEditDraftArchive(restored.store);
  expect(restored.service.rebase(draft.id, command, authority)).toEqual(result);
  expect(restored.service.get(draft.id)).toEqual(result);
});

test('pristine rebases preserve synced edits and require current draft and saved-target revisions', () => {
  const { store, service } = fixture();
  for (const change of [
    { title: 'Unsaved title', rawFields: {}, unappliedFields: [] },
    { rawFields: { json: '{"incomplete":' }, unappliedFields: [] },
    { rawFields: {}, unappliedFields: ['json'] },
  ]) {
    const content = store.product.content(fixtureBotInput('Saved', 'Body')) as Content;
    const initial = create(service, content.id);
    const draft = service.patch(
      initial.id,
      {
        expectedRevision: initial.revision,
        operationId: randomUUID(),
        model: { ...initial.model, ...('title' in change ? { title: change.title } : {}) },
        rawFields: change.rawFields,
        unappliedFields: change.unappliedFields,
      },
      authority
    ).draft;
    expect(() =>
      service.rebase(
        draft.id,
        {
          expectedRevision: draft.revision,
          expectedTargetRevision: content.revision,
          mode: 'pristine',
          operationId: randomUUID(),
        },
        authority
      )
    ).toThrow(/자동으로 바꾸지/);
    expect(service.get(draft.id)).toEqual(draft);
  }
  const content = store.product.content(fixtureBotInput('Saved', 'Body')) as Content;
  const initial = create(service, content.id);
  const newer = store.product.content(
    { ...fixtureBotInput('New saved', 'Body'), expectedRevision: content.revision },
    content.id
  ) as Content;
  expect(() =>
    service.rebase(
      initial.id,
      {
        expectedRevision: initial.revision,
        expectedTargetRevision: content.revision,
        mode: 'pristine',
        operationId: randomUUID(),
      },
      authority
    )
  ).toThrow(/저장본이 다시 변경/);
  const changed = patch(service, initial, 'Remote draft').draft;
  expect(() =>
    service.rebase(
      initial.id,
      {
        expectedRevision: initial.revision,
        expectedTargetRevision: newer.revision,
        mode: 'pristine',
        operationId: randomUUID(),
      },
      authority
    )
  ).toThrow(/초안이 변경/);
  expect(service.get(initial.id)).toEqual(changed);
});

test('drafts, conflict proposals and save receipts roundtrip through the v15 archive', () => {
  const { store, service } = fixture();
  const first = create(service);
  const changed = patch(service, first, 'Draft for archive').draft;
  patch(service, first, 'Late proposal');
  const saved = service.save(
    first.id,
    { expectedRevision: changed.revision, operationId: randomUUID() },
    authority
  );
  const latest = service.patch(
    first.id,
    {
      expectedRevision: saved.draft.revision,
      operationId: randomUUID(),
      model: saved.draft.model,
      rawFields: { json: '{"incomplete":' },
      unappliedFields: ['json'],
    },
    authority
  ).draft;
  validateEditDraftArchive(store);
  const restored = fixture();
  restored.store.product.import(store.product.export());
  validateEditDraftArchive(restored.store);
  expect(restored.service.get(first.id)).toEqual(latest);
  expect(restored.service.proposals(first.id)).toEqual(service.proposals(first.id));
  expect(restored.service.savedOperations(first.id)).toEqual(service.savedOperations(first.id));
  expect(
    restored.service.save(
      first.id,
      { expectedRevision: changed.revision, operationId: saved.operationId },
      authority
    )
  ).toEqual(saved);
  const corrupt = { ...latest, baseHash: '0'.repeat(64) };
  restored.store.db
    .prepare('UPDATE edit_drafts SET body=? WHERE id=?')
    .run(JSON.stringify(corrupt), first.id);
  expect(() => validateEditDraftArchive(restored.store)).toThrow(/base hash/);
});
