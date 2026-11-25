import { expect, test } from 'vitest';
import { TEXT_DIFF_LIMITS } from '../core/text-diff.js';
import {
  editorChangeView,
  editorFieldChanges,
  revertEditorChange,
  sameEditorValue,
  type EditorFieldChange,
} from '../web/editor-values.js';

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
  const [bracketed] = view(
    card({ first_mes: '[Start New Session]' }),
    card({ first_mes: '[Start New Session] 덧붙인 글' })
  );
  expect(bracketed).toMatchObject({ type: 'text', diff: { mode: 'prose', added: 2, removed: 0 } });
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
    {
      type: 'text',
      diff: { mode: 'prose', unit: 'word', omitted: 'size' },
      before: long,
      after: 'short',
    },
  ]);
});

const revertAll = (base: unknown, model: unknown, pick: (change: EditorFieldChange) => boolean) =>
  editorFieldChanges(base, model)
    .filter(pick)
    .reduce((current, change) => revertEditorChange(current, base, change), model);

test('reverting one change restores that field and leaves the other edits', () => {
  const base = card({ description: '처음 설명', first_mes: '처음 인사', creator: '' });
  const model = card({ description: '고친 설명', first_mes: '고친 인사', creator: '' });
  const reverted = revertAll(base, model, (change) => change.path.endsWith('/description'));
  expect(reverted).toEqual(card({ description: '처음 설명', first_mes: '고친 인사', creator: '' }));
  const added = card({ description: '처음 설명', first_mes: '처음 인사', creator: '', extra: 1 });
  expect(revertAll(base, added, () => true)).toEqual(base);
  expect(base).toEqual(card({ description: '처음 설명', first_mes: '처음 인사', creator: '' }));
});

test('reverting list items removes an addition, restores a deletion in place and undoes a move', () => {
  const list = (entries: unknown[]) => card({ character_book: { entries } });
  const lore = ['등대', '항구', '숲', '바다'].map((name, id) => ({
    id,
    comment: name,
    content: name,
  }));
  const [lighthouse, harbour, forest, sea] = lore;
  const base = list(lore);
  const inserted = { id: 9, comment: '새 로어', content: '새 로어' };
  expect(revertAll(base, list([lighthouse, inserted, harbour, forest, sea]), () => true)).toEqual(
    base
  );
  expect(revertAll(base, list([lighthouse, forest, sea]), () => true)).toEqual(base);
  expect(revertAll(base, list([harbour, forest, sea, lighthouse]), () => true)).toEqual(base);
  const edited = list([lighthouse, { ...harbour, content: '안개 낀 항구' }, forest]);
  const restored = revertAll(base, edited, (change) => change.kind === 'removed');
  expect(restored).toEqual(
    list([lighthouse, { ...harbour, content: '안개 낀 항구' }, forest, sea])
  );
  const unnamed = (items: string[]) => card({ alternate_greetings: items });
  expect(revertAll(unnamed(['하나', '둘', '셋']), unnamed(['하나', '셋']), () => true)).toEqual(
    unnamed(['하나', '둘', '셋'])
  );
  expect(revertAll(unnamed(['하나', '둘']), unnamed(['하나', '고친 둘']), () => true)).toEqual(
    unnamed(['하나', '둘'])
  );
});

test('reverting preset blocks, regex scripts and triggers restores each kind', () => {
  const preset = (promptTemplate: unknown[], regex: unknown[]) => ({
    program: { nativeRisuPreset: { preset: { promptTemplate, regex } } },
  });
  const blocks = [
    { type: 'plain', text: '시스템', role: 'system' },
    { type: 'chat', rangeStart: 0 },
  ];
  const scripts = [{ comment: '상태창', in: 'a', out: 'b', type: 'editdisplay' }];
  const base = preset(blocks, scripts);
  const model = preset(
    [{ ...blocks[0], text: '고친 시스템' }, blocks[1], { type: 'plain', text: '새 블록' }],
    [{ ...scripts[0], out: 'c' }]
  );
  expect(revertAll(base, model, (change) => change.path.includes('/regex/'))).toEqual(
    preset(model.program.nativeRisuPreset.preset.promptTemplate, scripts)
  );
  expect(revertAll(base, model, () => true)).toEqual(base);
  const triggers = (items: unknown[]) => card({ extensions: { risuai: { triggerscript: items } } });
  const trigger = { comment: '시작', type: 'start', effect: [{ type: 'triggerlua', code: 'a()' }] };
  expect(
    revertAll(
      triggers([trigger]),
      triggers([{ ...trigger, effect: [{ type: 'triggerlua', code: 'b()' }] }]),
      () => true
    )
  ).toEqual(triggers([trigger]));
});
