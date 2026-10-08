import { describe, expect, test } from 'vitest';
import { createCandidateSearch, type CandidateSearchDocument } from '../core/candidate-search.js';

describe('local text candidate retrieval', () => {
  test('finds a rare entity in late paragraphs of a long lore entry', () => {
    const search = createCandidateSearch([
      { id: 'a-town', title: 'Town records', text: 'The river runs through the town.' },
      {
        id: 'z-secret',
        title: 'Old records',
        text: `${'The river runs through the town.\n\n'.repeat(2_000)}The Asterion seal is hidden below.`,
      },
    ]);
    expect(search.rank([{ text: 'Asterion seal', weight: 1 }])).toEqual(['z-secret', 'a-town']);
  });

  test.each([
    ['미나를 만나러 가요', '미나'],
    ['미나', '미나에게 비밀을 말해요'],
    ['静かな庭で美咲に会いました', '美咲'],
    ['美咲', '夜が深まり美咲は庭へ歩いた'],
  ])('retrieves short CJK names between %s and %s', (body, query) => {
    const search = createCandidateSearch([
      { id: 'a-unrelated', title: 'Harbor', text: 'Ships returned at dawn.' },
      { id: 'z-name', title: 'Character', text: body },
    ]);
    expect(search.rank([{ text: query, weight: 1 }])[0]).toBe('z-name');
  });

  test('normalizes composed and decomposed Unicode and letter casing', () => {
    const search = createCandidateSearch([
      { id: 'a-unrelated', title: 'Warehouse', text: 'A locked gate.' },
      { id: 'z-unicode', title: 'CAFÉ', text: '\u1106\u1175\u1102\u1161 waits here.' },
    ]);
    expect(search.rank([{ text: 'cafe\u0301', weight: 1 }])[0]).toBe('z-unicode');
    expect(search.rank([{ text: '미나', weight: 1 }])[0]).toBe('z-unicode');
  });

  test('prioritizes title matches over incidental mentions in the body', () => {
    const search = createCandidateSearch([
      { id: 'a-mention', title: 'Market', text: 'Asterion is mentioned in passing.' },
      { id: 'z-entity', title: 'Asterion', text: 'The ancient seal and its origin.' },
    ]);
    expect(search.rank([{ text: 'Asterion', weight: 1 }])[0]).toBe('z-entity');
  });

  test('rare details outweigh repeated filler and each block retains its own minority topic', () => {
    const documents: CandidateSearchDocument[] = [
      { id: 'a-filler', title: 'General scene', text: 'garden '.repeat(1_000) },
      { id: 'z-minority', title: 'Hidden scene', text: 'garden meteorite' },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `garden-${index}`,
        title: 'Garden view',
        text: 'garden trees path',
      })),
    ];
    const search = createCandidateSearch(documents);
    expect(search.rank([{ text: `${'garden '.repeat(500)}meteorite`, weight: 1 }])[0]).toBe(
      'z-minority'
    );
    expect(search.rank([{ text: 'meteorite', weight: 1 }])[0]).toBe('z-minority');
    expect(search.rank([{ text: 'garden', weight: 1 }])[0]).not.toBe('z-minority');
  });

  test('current request weight outweighs a repetitive historical topic', () => {
    const search = createCandidateSearch([
      { id: 'a-old', title: 'Harbor', text: 'harbor ships pier waves' },
      { id: 'z-current', title: 'Mountain', text: 'mountain snow summit' },
    ]);
    expect(
      search.rank([
        { text: 'harbor ships pier waves '.repeat(1_000), weight: 1 },
        { text: 'mountain', weight: 3 },
      ])[0]
    ).toBe('z-current');
    expect(
      search.rank([
        { text: 'harbor', weight: 3 },
        { text: 'mountain', weight: 1 },
      ])[0]
    ).toBe('a-old');
  });

  test('returns every ID with deterministic ties independent of document order and repeated calls', () => {
    const documents = [
      { id: 'z', title: 'Same', text: 'shared detail' },
      { id: 'b', title: 'Same', text: 'shared detail' },
      { id: 'a', title: 'Other', text: 'unmatched detail' },
    ];
    const search = createCandidateSearch(documents);
    const query = [{ text: 'shared', weight: 1 }];
    expect(search.rank(query)).toEqual(['b', 'z', 'a']);
    expect(createCandidateSearch([...documents].reverse()).rank(query)).toEqual(['b', 'z', 'a']);
    expect(search.rank([{ text: 'unknown', weight: 1 }])).toEqual(['a', 'b', 'z']);
    expect(search.rank([])).toEqual(['a', 'b', 'z']);
    expect(search.rank(query)).toEqual(['b', 'z', 'a']);
    expect(createCandidateSearch([]).rank(query)).toEqual([]);
  });
});
