import { expect, test } from 'vitest';
import { sameEditorValue } from '../web/editor-values.js';

test('editor changes and reverts compare authored values without changing either document', () => {
  const original = {
    title: 'Card',
    native: { description: 'Original', lore: [{ content: 'Preserved lore' }] },
  };
  const changed = { ...original, native: { ...original.native, description: 'Edited' } };
  const reverted = { ...changed, native: { ...changed.native, description: 'Original' } };
  expect(sameEditorValue(original, changed)).toBe(false);
  expect(sameEditorValue(original, reverted)).toBe(true);
  expect(original.native.description).toBe('Original');
  expect(sameEditorValue(original, structuredClone(original))).toBe(true);
});

test('optional absent fields remain clean and object key order does not create an edit', () => {
  expect(
    sameEditorValue(
      { native: { title: 'Card' } },
      {
        native: { imageHandoff: undefined, title: 'Card' },
      }
    )
  ).toBe(true);
  expect(sameEditorValue({ title: 'Card', values: {} }, { values: {}, title: 'Card' })).toBe(true);
  expect(sameEditorValue({ title: 'Card' }, { title: 'Card', native: null })).toBe(false);
});

test('lore order, primitive types and newly added fields still count as changes', () => {
  expect(sameEditorValue({ lore: ['First', 'Second'] }, { lore: ['Second', 'First'] })).toBe(false);
  expect(sameEditorValue({ values: { enabled: false } }, { values: { enabled: 'false' } })).toBe(
    false
  );
  expect(sameEditorValue({ lore: [] }, { lore: [{ content: 'New' }] })).toBe(false);
  expect(sameEditorValue({ lore: [] }, { lore: {} })).toBe(false);
});
