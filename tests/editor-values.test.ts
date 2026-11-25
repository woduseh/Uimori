import { expect, test } from 'vitest';
import { TEXT_DIFF_LIMITS } from '../core/text-diff.js';
import { editorChangeView, editorFieldChanges, sameEditorValue } from '../web/editor-values.js';

const card = (card: Record<string, unknown>) => ({ package: { nativeRisu: { card } } });
const summary = (before: unknown, after: unknown) =>
  editorFieldChanges(before, after).map(({ path, kind, field, before, after }) => ({
    path,
    kind,
    field: field.join('/'),
    before,
    after,
  }));

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

test('field changes match lore entries by id so an entry inserted at the top changes nothing else', () => {
  const entries = [
    { id: 0, name: '등대', content: '등대 로어' },
    { id: 1, name: '항구', content: '항구 로어' },
  ];
  const inserted = { id: 2, name: '새 로어', content: '처음 쓴 로어' };
  const before = card({ character_book: { entries } });
  const after = card({
    character_book: { entries: [inserted, { ...entries[0], name: '낡은 등대' }, entries[1]] },
  });
  const list = '/package/nativeRisu/card/character_book/entries';
  expect(summary(before, after)).toEqual([
    { path: `${list}/0`, kind: 'added', field: '', before: undefined, after: inserted },
    { path: `${list}/1/name`, kind: 'changed', field: 'name', before: '등대', after: '낡은 등대' },
  ]);
});

test('field changes align lists without ids by content and report removed, moved and edited items', () => {
  const [tone, sound, weather, ending] = [
    { comment: '말투', in: 'a', out: 'b' },
    { comment: '효과음', in: 'c', out: 'd' },
    { comment: '날씨', in: 'e', out: 'f' },
    { comment: '엔딩', in: 'g', out: 'h' },
  ];
  const regex = (items: unknown[]) => ({ package: { nativeRisu: { module: { regex: items } } } });
  const changes = summary(
    regex([tone, sound, weather, ending]),
    regex([sound, tone, { ...weather, out: '맑음' }])
  );
  const list = '/package/nativeRisu/module/regex';
  expect(changes.map(({ kind }) => kind)).toEqual(['moved', 'changed', 'removed']);
  expect(changes.slice(1)).toEqual([
    { path: `${list}/2/out`, kind: 'changed', field: 'out', before: 'f', after: '맑음' },
    { path: `${list}/3`, kind: 'removed', field: '', before: ending, after: undefined },
  ]);
  expect(
    summary(regex([tone, weather]), regex([{ ...weather, in: 'E' }, tone])).map(
      ({ path, kind }) => `${kind} ${path}`
    )
  ).toEqual([`changed ${list}/0/in`]);
});

test('field changes keep scalar values and nested settings as leaves with their old and new values', () => {
  expect(
    summary(
      {
        program: {
          nativeRisuPreset: {
            preset: {
              temperature: 80,
              promptTemplate: [{ type: 'plain', text: '본문', role: 'system' }],
            },
          },
        },
      },
      {
        program: {
          nativeRisuPreset: {
            preset: {
              temperature: 95,
              promptTemplate: [{ type: 'plain', text: '본문', role: 'user' }],
            },
          },
        },
      }
    )
  ).toEqual([
    {
      path: '/program/nativeRisuPreset/preset/temperature',
      kind: 'changed',
      field: 'program/nativeRisuPreset/preset/temperature',
      before: 80,
      after: 95,
    },
    {
      path: '/program/nativeRisuPreset/preset/promptTemplate/0/role',
      kind: 'changed',
      field: 'role',
      before: 'system',
      after: 'user',
    },
  ]);
});

test('change views diff text, keep scalars as values, summarize images and report omitted diffs', () => {
  const view = (before: unknown, after: unknown) =>
    editorFieldChanges(before, after).map((change) => editorChangeView(change));
  const [description] = view(
    card({ description: '처음 설명' }),
    card({ description: '고친 설명' })
  );
  expect(description).toMatchObject({
    type: 'text',
    diff: { mode: 'prose', added: 1, removed: 1 },
  });
  expect(view({ preset: { temperature: 80 } }, { preset: { temperature: 95 } })).toEqual([
    { type: 'value', before: 80, after: 95 },
  ]);
  expect(
    view(
      { package: { images: [{ id: 'a', title: '표정' }] } },
      {
        package: {
          images: [
            { id: 'a', title: '웃는 표정' },
            { id: 'b', title: '새 이미지' },
          ],
        },
      }
    ).map(({ type }) => type)
  ).toEqual(['text', 'none']);
  expect(view(card({ assets: [] }), card({ assets: [{ uri: 'embeded://a.png' }] }))).toEqual([
    { type: 'summary', before: 0, after: 1 },
  ]);
  const long = 'x'.repeat(TEXT_DIFF_LIMITS.maxInputLength + 1);
  expect(view(card({ description: long }), card({ description: 'short' }))).toEqual([
    { type: 'text', diff: { mode: 'prose', unit: 'word', omitted: 'size' } },
  ]);
});
