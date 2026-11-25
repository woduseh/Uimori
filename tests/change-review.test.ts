import { expect, test } from 'vitest';
import { diffText } from '../core/text-diff.js';
import {
  canRevert,
  changeTarget,
  codeFieldBases,
  reviewSections,
  reviewTotals,
} from '../web/change-review.js';
import { editorFieldChanges, revertEditorChange } from '../web/editor-values.js';
import { contentChangeSection, type ChangedSection } from '../web/studio-sections.js';
import {
  changedLineMarks,
  hunkGaps,
  hunkStarts,
  splitRows,
  unifiedLines,
} from '../web/text-diff-rows.js';

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

test('unrelated fields edited to the same text stay separate cards', () => {
  const sections = reviewSections(
    changed(['basic']),
    editorFieldChanges(
      model({ description: '같은 글', creator_notes: '같은 글' }),
      model({ description: '새 글', creator_notes: '새 글' })
    ),
    sectionOf
  );
  expect(sections[0]!.cards.map((card) => [card.change.path, card.related.length])).toEqual([
    ['/package/nativeRisu/card/description', 0],
    ['/package/nativeRisu/card/creator_notes', 0],
  ]);
});

test('saved projections of the greetings and the card text stay with the field they come from', () => {
  const saved = (first: string, notes: string, body: string) => ({
    title: 'Card',
    description: notes,
    text: body,
    package: {
      starts: [{ id: 'start-0', title: '기본 첫 메시지', mode: 'authored', text: first }],
      nativeRisu: {
        card: { name: 'Card', first_mes: first, creator_notes: notes, description: body },
      },
    },
  });
  const sections = reviewSections(
    changed(['basic', 'greetings']),
    editorFieldChanges(saved('안녕', '메모', '본문'), saved('반가워', '새 메모', '새 본문')),
    sectionOf
  );
  expect(
    sections.map((section) => [
      section.id,
      section.cards.map((card) => [card.change.path, card.related.map((change) => change.path)]),
    ])
  ).toEqual([
    [
      'basic',
      [
        ['/package/nativeRisu/card/creator_notes', ['/description']],
        ['/package/nativeRisu/card/description', ['/text']],
      ],
    ],
    ['greetings', [['/package/nativeRisu/card/first_mes', ['/package/starts']]]],
  ]);
});

test('change targets pick the editor item and code field each kind uses', () => {
  const target = (before: unknown, after: unknown) =>
    reviewSections(
      changed(['basic', 'greetings', 'lore', 'regex', 'triggers']),
      editorFieldChanges(before, after),
      sectionOf
    )
      .flatMap((section) => section.cards)
      .map((card) => {
        const { section, item, field } = changeTarget(card);
        return [section, item, field];
      });
  expect(
    target(
      model({ first_mes: 'a', alternate_greetings: ['b', 'c'], description: 'd' }),
      model({ first_mes: 'a2', alternate_greetings: ['b', 'c2'], description: 'd2' })
    )
  ).toEqual([
    ['basic', null, 'description'],
    ['greetings', 0, 'first_mes'],
    ['greetings', 2, 'alternate_greetings'],
  ]);
  expect(
    target(
      model(lore([{ comment: '등대', content: 'a', key: 'x' }])),
      model(lore([{ comment: '등대', content: 'b', key: 'y' }]))
    )
  ).toEqual([
    ['lore', 0, 'content'],
    ['lore', 0, null],
  ]);
  const scripts = (customScripts: unknown[], triggerscript: unknown[]) =>
    model({ extensions: { risuai: { customScripts, triggerscript } } });
  expect(
    target(
      scripts(
        [{ comment: 's', find: 'a', replace: 'b' }],
        [{ comment: 't', effect: [{ type: 'triggerlua', code: 'a()' }] }]
      ),
      scripts(
        [{ comment: 's', find: 'a2', replace: 'b' }],
        [{ comment: 't', effect: [{ type: 'triggerlua', code: 'b()' }] }]
      )
    )
  ).toEqual([
    ['regex', 0, 'in'],
    ['triggers', 0, 'effect.0'],
  ]);
  expect(
    target(
      model(
        lore([
          { comment: '등대', content: 'a' },
          { comment: '항구', content: 'b' },
        ])
      ),
      model(lore([{ comment: '등대', content: 'a' }]))
    )
  ).toEqual([['lore', null, null]]);
});

test('moving to a changed trigger script puts the cursor at the change inside its Lua code', () => {
  const triggers = (code: string) =>
    model({
      extensions: {
        risuai: { triggerscript: [{ comment: 't', effect: [{ type: 'triggerlua', code }] }] },
      },
    });
  const [card] = reviewSections(
    changed(['triggers']),
    editorFieldChanges(triggers('local hp = 80\nfoo()'), triggers('local hp = 80\nbar()')),
    sectionOf
  )[0]!.cards;
  expect(changeTarget(card!)).toEqual({
    section: 'triggers',
    item: 0,
    field: 'effect.0',
    offset: 14,
  });
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

test('code field bases map changed and added code fields to their saved text', () => {
  const before = model({
    description: '처음',
    ...lore([{ comment: '등대', content: '등대 로어' }]),
  });
  const after = model({
    description: '고침',
    character_book: {
      entries: [
        { id: 0, comment: '등대', content: '등대 로어', key: 'x' },
        { id: 1, comment: '새 로어', content: '새 본문' },
      ],
    },
  });
  expect(Object.fromEntries(codeFieldBases(editorFieldChanges(before, after), sectionOf))).toEqual({
    'basic::description': '처음',
    'lore:1:content': '',
  });
});

const code = (before: string, after: string) => {
  const diff = diffText(before, after, 'code');
  if ('omitted' in diff) throw new Error('omitted');
  return diff;
};

test('line rows pair a changed line, emphasise its words and number both sides', () => {
  const before = ['a', 'b', 'c', 'hp = 80', 'd', 'e', 'f', 'g', ''].join('\n');
  const after = ['a', 'b', 'c', 'hp = 65', 'new line', 'd', 'e', 'f', 'g', ''].join('\n');
  const diff = code(before, after);
  const [start] = hunkStarts(diff.hunks, before, after);
  expect(start).toEqual({ before: 2, after: 2 });
  const rows = splitRows(diff.hunks[0]!, start);
  const changedRow = rows.find((row) => row.before?.op === 'delete')!;
  expect(changedRow.before).toMatchObject({ text: 'hp = 80', number: 4 });
  expect(changedRow.after).toMatchObject({ text: 'hp = 65', number: 4 });
  expect(changedRow.after!.marks!.filter((mark) => mark.op === 'insert')).toEqual([
    { op: 'insert', text: '65' },
  ]);
  expect(rows.find((row) => row.after?.text === 'new line')!.before).toBeNull();
  const unified = unifiedLines(diff.hunks[0]!, start);
  expect(unified.map((line) => [line.op, line.before, line.after])).toEqual([
    ['equal', 2, 2],
    ['equal', 3, 3],
    ['delete', 4, null],
    ['insert', null, 4],
    ['insert', null, 5],
    ['equal', 5, 6],
    ['equal', 6, 7],
  ]);
  expect(hunkGaps(diff.hunks, before, after)).toEqual([
    { lines: ['a'], before: 1, after: 1 },
    { lines: ['f', 'g'], before: 7, after: 8 },
  ]);
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
