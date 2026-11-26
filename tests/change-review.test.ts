import { expect, test } from 'vitest';
import { canRevert, reviewSections, reviewTotals } from '../web/change-review.js';
import { editorFieldChanges, revertEditorChange } from '../web/editor-values.js';
import { contentChangeSection, type ChangedSection } from '../web/studio-sections.js';
import { changedLineMarks } from '../web/text-diff-rows.js';

type Section = 'basic' | 'greetings' | 'lore' | 'regex' | 'triggers' | 'assets';
const shown = (['basic', 'greetings', 'lore', 'regex', 'triggers', 'assets'] as const).map(
  (id) => ({ id, title: id })
);
const sectionOf = contentChangeSection(shown);
const changed = (ids: Section[], pending: Section[] = []): ChangedSection<Section>[] =>
  ids.map((id) => ({ id, title: id, pending: pending.includes(id) }));
const model = (card: Record<string, unknown>, title = 'Card') => ({
  title,
  package: { nativeRisu: { card: { name: title, ...card } } },
});
const lore = (entries: { comment: string; content: string; key?: string }[]) => ({
  character_book: { entries: entries.map((entry, id) => ({ id, ...entry })) },
});

test('review sections hold one open card per change, fold duplicate title paths and total the stats', () => {
  const before = model({
    description: '처음 설명',
    ...lore([
      { comment: '등대', content: '등대 로어' },
      { comment: '항구', content: '항구 로어' },
    ]),
  });
  const after = model(
    {
      description: '고친 설명',
      ...lore([
        { comment: '등대', content: '등대 로어' },
        { comment: '항구', content: '안개 낀 항구 로어' },
      ]),
    },
    'Renamed'
  );
  const sections = reviewSections(
    changed(['basic', 'lore']),
    editorFieldChanges(before, after),
    sectionOf
  );
  expect(sections.map((section) => [section.id, section.cards.map((card) => card.name)])).toEqual([
    ['basic', ['이름', '카드 설명']],
    ['lore', ['항구 / 로어 본문']],
  ]);
  const [name] = sections[0]!.cards;
  expect(name!.change.path).toBe('/package/nativeRisu/card/name');
  expect(name!.related.map((change) => change.path)).toEqual(['/title']);
  expect(new Set(sections.flatMap((section) => section.cards.map((card) => card.id))).size).toBe(3);
  expect(reviewTotals(sections)).toEqual({ sections: 2, items: 3, added: 4, removed: 2 });
});

test('a renamed card folds every title mirror into the name card and reverting it restores them all', () => {
  const before = {
    title: 'Card',
    package: { title: 'Card', identity: { name: 'Card' }, nativeRisu: { card: { name: 'Card' } } },
  };
  const after = {
    title: 'Renamed',
    package: {
      title: 'Renamed',
      identity: { name: 'Renamed' },
      nativeRisu: { card: { name: 'Renamed' } },
    },
  };
  const [basic] = reviewSections(changed(['basic']), editorFieldChanges(before, after), sectionOf);
  expect(basic!.cards.map((card) => card.change.path)).toEqual(['/package/nativeRisu/card/name']);
  const [name] = basic!.cards;
  expect(name!.related.map((change) => change.path).toSorted()).toEqual([
    '/package/identity/name',
    '/package/title',
    '/title',
  ]);
  expect(
    [name!.change, ...name!.related].reduce(
      (current, change) => revertEditorChange(current, before, change),
      after as unknown
    )
  ).toEqual(before);
});

test('reverts are offered except for pending sections and image or asset references', () => {
  const sections = reviewSections(
    changed(['basic', 'assets'], ['basic']),
    editorFieldChanges(
      model({ description: 'a', assets: [] }),
      model({ description: 'b', assets: [{ uri: 'embeded://a.png' }] })
    ),
    sectionOf
  );
  const [basic, assets] = sections;
  expect(canRevert(basic!.cards[0]!, basic!)).toBe(false);
  expect(canRevert(basic!.cards[0]!, { ...basic!, pending: false })).toBe(true);
  expect(canRevert(assets!.cards[0]!, assets!)).toBe(false);
});

test('gutter marks name changed, added and deleted lines against the saved text', () => {
  expect(changedLineMarks('a\nb\nc', 'a\nB\nc\nd')).toEqual([
    { line: 2, kind: 'changed' },
    { line: 4, kind: 'added' },
  ]);
  expect(changedLineMarks('a\nb\nc', 'a\nc')).toEqual([{ line: 1, kind: 'deleted-below' }]);
  expect(changedLineMarks('a\nb', 'b')).toEqual([{ line: 1, kind: 'deleted-above' }]);
  expect(changedLineMarks('a\r\nb', 'a\nb')).toEqual([]);
  expect(changedLineMarks('same', 'same')).toEqual([]);
});
