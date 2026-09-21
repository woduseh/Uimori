import assert from 'node:assert/strict';
import { test } from 'vitest';
import { encodeDraftSaveResult, decodeDraftSaveResult } from '../core/edit-draft-save-wire.js';
import type { DraftSaveResult, EditDraftKind, EditDraftModel } from '../core/edit-drafts.js';

function receipt(kind: EditDraftKind): DraftSaveResult {
  // Transport fixtures exercise nested ownership, not prompt/content validation.
  const model = (kind === 'prompt-workspace'
    ? { main: { title: 'Main', nested: ['a'] }, translation: { title: 'Translation' } }
    : kind === 'prompt-preset'
      ? { title: 'Preset', role: 'main', program: { nested: ['a'] }, values: {} }
      : {
          kind: 'persona',
          title: 'Persona',
          description: '',
          text: 'A'.repeat(100_000),
          loading: 'pinned',
          relatedIds: [],
          package: { nativeRisu: { card: { name: 'Persona' } } },
        }) as unknown as EditDraftModel;
  const saved =
    kind === 'prompt-workspace'
      ? { ...structuredClone(model), revision: 8, modelRoutes: {} }
      : { ...structuredClone(model), id: 'saved', revision: 8 };
  return {
    status: 'saved',
    operationId: 'op',
    created: false,
    changes: [],
    saved: saved as DraftSaveResult['saved'],
    draft: {
      id: 'draft',
      editorKey: 'editor',
      kind,
      targetId: kind === 'prompt-workspace' ? 'current' : 'saved',
      revision: 12,
      baseRevision: 8,
      baseHash: 'a'.repeat(64),
      model: structuredClone(model),
      baseModel: structuredClone(model),
      rawFields: {},
      unappliedFields: [],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  };
}

for (const kind of ['content', 'prompt-preset', 'prompt-workspace'] as const) {
  test(`single save response round-trips the complete ${kind} receipt`, () => {
    const original = receipt(kind),
      before = structuredClone(original);
    const wire = encodeDraftSaveResult(original);
    assert.ok(!Object.hasOwn(wire.draft, 'model'));
    assert.ok(!Object.hasOwn(wire.draft, 'baseModel'));
    assert.deepEqual(decodeDraftSaveResult(JSON.parse(JSON.stringify(wire))), original);
    assert.deepEqual(original, before);
  });
}

test('expanded saved, editable and baseline models have independent ownership', () => {
  const result = decodeDraftSaveResult(encodeDraftSaveResult(receipt('content')));
  const local = result.draft.model as unknown as {
    package: { nativeRisu: { card: { name: string } } };
  };
  local.package.nativeRisu.card.name = 'Edited locally';
  assert.notDeepEqual(result.draft.model, result.draft.baseModel);
  assert.equal((result.saved as typeof result.saved & { title: string }).title, 'Persona');
  assert.equal(JSON.stringify(result.saved).includes('Edited locally'), false);
  assert.equal(JSON.stringify(result.draft.baseModel).includes('Edited locally'), false);
});

test('large unchanged models cross the save response only once', () => {
  const original = receipt('content');
  const compact = JSON.stringify(encodeDraftSaveResult(original));
  assert.ok(compact.length < JSON.stringify(original).length * 0.4);
});

test('the single response contains neither duplicate models nor a format selector', () => {
  const wire = encodeDraftSaveResult(receipt('content'));
  assert.deepEqual(
    Object.keys(wire).sort(),
    ['status', 'operationId', 'created', 'changes', 'saved', 'draft'].sort()
  );
  assert.equal(Object.hasOwn(wire.draft, 'model'), false);
  assert.equal(Object.hasOwn(wire.draft, 'baseModel'), false);
});
