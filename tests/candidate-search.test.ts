import { describe, expect, test } from 'vitest';
import { createCandidateSearch } from '../core/candidate-search.js';

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
    ['静かな庭で美咲に会いました', '美咲'],
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

  test('matched ranking excludes unrelated documents without changing exhaustive ranking', () => {
    const search = createCandidateSearch([
      { id: 'unrelated', title: 'Harbor', text: 'Ships return at dawn.' },
      { id: 'keeper', title: 'Asterion', text: 'An ancient seal.' },
      { id: 'mention', title: 'Market', text: 'Asterion is mentioned here.' },
    ]);
    expect(search.rankMatched([{ text: 'Asterion', weight: 1 }])).toEqual(['keeper', 'mention']);
    expect(search.rankMatched([{ text: 'meteorite', weight: 1 }])).toEqual([]);
    expect(search.rankMatched([])).toEqual([]);
    expect(search.rank([{ text: 'meteorite', weight: 1 }])).toEqual([
      'keeper',
      'mention',
      'unrelated',
    ]);
  });
});
