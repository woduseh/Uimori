import { expect, test } from 'vitest';
import {
  TEXT_DIFF_LIMITS,
  applyTextDiff,
  diffText,
  intralineDiff,
  pairChangedLines,
  rewriteAsBlocks,
  type TextDiff,
} from '../core/text-diff.js';

const changes = (diff: TextDiff) => {
  if ('omitted' in diff) throw new Error(`omitted: ${diff.omitted}`);
  return diff;
};
const changed = (diff: TextDiff) =>
  changes(diff).hunks.flatMap((hunk) =>
    hunk.segments.filter((segment) => segment.op !== 'equal').map((s) => [s.op, s.text])
  );

test('a one-particle change in a long Korean paragraph is one small word change', () => {
  const sentence =
    '그는 오래된 다리를 건너 마을로 돌아왔고, 사람들은 아무 말 없이 그를 바라보았다. ';
  const paragraph = sentence.repeat(12);
  const before = `첫 문단이에요.\n${paragraph}사람이 웃었다.\n마지막 문단.\n`;
  const after = `첫 문단이에요.\n${paragraph}사람은 웃었다.\n마지막 문단.\n`;
  expect(paragraph.length).toBeGreaterThan(500);
  const diff = changes(diffText(before, after, 'prose'));
  expect(diff).toMatchObject({ unit: 'word', added: 1, removed: 1 });
  expect(changed(diff)).toEqual([
    ['delete', '사람이'],
    ['insert', '사람은'],
  ]);
  const [hunk] = diff.hunks;
  const contextWords = hunk!.segments
    .filter((segment) => segment.op === 'equal')
    .map((segment) => segment.text.match(/\S+/gu)?.length ?? 0);
  expect(contextWords.every((count) => count <= 8)).toBe(true);
  expect(applyTextDiff(before, diff.hunks)).toBe(after);
});

test('a rewritten paragraph reads as one deleted block and one inserted block', () => {
  const before =
    '비가 그치자 항구의 불빛이 하나둘 켜졌어요. 리아는 낡은 우산을 접고 부두 끝까지 천천히 걸어갔어요.\n';
  const after =
    '항구에 다시 불이 들어온 건 비가 그친 뒤였어요. 리아는 젖은 우산을 털며 부두 끝으로 서둘러 걸어갔어요.\n';
  const diff = changes(diffText(before, after, 'prose'));
  const [hunk] = diff.hunks;
  expect(hunk!.segments.filter((segment) => segment.op !== 'equal').length).toBeGreaterThan(10);
  const blocks = rewriteAsBlocks(hunk!.segments);
  expect(blocks.map((segment) => segment.op)).toEqual(['delete', 'insert', 'equal']);
  expect(applyTextDiff(before, [{ ...hunk!, segments: blocks }])).toBe(after);

  const sentence = '그 문장은 리아가 우산을 접고 부두 끝까지 걸어가는 장면을 차분하게 그려요.';
  const light = changes(
    diffText(sentence, sentence.replace('우산을', '양산을').replace('차분하게', '조용히'), 'prose')
  );
  for (const item of light.hunks) expect(rewriteAsBlocks(item.segments)).toEqual(item.segments);
  const swap = changes(diffText('그는 다리를 건넜다.', '그는 강을 헤엄쳤다.', 'prose'));
  expect(rewriteAsBlocks(swap.hunks[0]!.segments)).toEqual(swap.hunks[0]!.segments);
});

test('separate prose changes become separate hunks and inserted paragraphs count their words', () => {
  const filler = Array.from({ length: 40 }, (_, index) => `단어${index}`).join(' ');
  const before = `앞 문장 하나.\n${filler}\n뒤 문장 하나.\n`;
  const after = `앞 문장 둘.\n${filler}\n새로 넣은 문단이에요.\n뒤 문장 하나.\n`;
  const diff = changes(diffText(before, after, 'prose'));
  expect(diff.hunks).toHaveLength(2);
  expect(diff).toMatchObject({ added: 4, removed: 1 });
  expect(applyTextDiff(before, diff.hunks)).toBe(after);
});

test('JSON and regular expressions compare by line', () => {
  const before = JSON.stringify(
    { name: '마을', keys: ['다리', '강'], regex: '^(\\S+)님$', order: 3 },
    null,
    2
  );
  const after = JSON.stringify(
    { name: '마을', keys: ['다리', '강', '숲'], regex: '^(\\S+)씨$', order: 3 },
    null,
    2
  );
  const diff = changes(diffText(before, after, 'code'));
  expect(diff).toMatchObject({ unit: 'line', added: 3, removed: 2 });
  expect(changed(diff)).toEqual([
    ['delete', '    "강"\n'],
    ['insert', '    "강",\n    "숲"\n'],
    ['delete', '  "regex": "^(\\\\S+)님$",\n'],
    ['insert', '  "regex": "^(\\\\S+)씨$",\n'],
  ]);
  expect(applyTextDiff(before, diff.hunks)).toBe(after);
});

test('the limits return an explicit omission instead of a partial diff', () => {
  const long = 'a'.repeat(TEXT_DIFF_LIMITS.maxInputLength + 1);
  expect(diffText(long, 'b', 'prose')).toEqual({ mode: 'prose', unit: 'word', omitted: 'size' });
  const lines = (prefix: string) =>
    Array.from({ length: 50 }, (_, index) => `${prefix}${index}\n`).join('');
  expect(diffText(lines('x'), lines('y'), 'code', { ...TEXT_DIFF_LIMITS, maxEdits: 20 })).toEqual({
    mode: 'code',
    unit: 'line',
    omitted: 'size',
  });
  expect(
    diffText(lines('x'), lines('y'), 'code', { ...TEXT_DIFF_LIMITS, maxOutputLength: 10 })
  ).toEqual({ mode: 'code', unit: 'line', omitted: 'size' });
  let clock = 0;
  expect(
    diffText(lines('x'), lines('y'), 'code', {
      ...TEXT_DIFF_LIMITS,
      now: () => (clock += 100),
    })
  ).toEqual({ mode: 'code', unit: 'line', omitted: 'time' });
});

test('a prose region too different for word alignment falls back to replaced paragraphs', () => {
  const before = Array.from({ length: 30 }, (_, index) => `가${index}`).join(' ');
  const after = Array.from({ length: 30 }, (_, index) => `나${index}`).join(' ');
  const diff = changes(diffText(before, after, 'prose', { ...TEXT_DIFF_LIMITS, maxEdits: 10 }));
  expect(changed(diff)).toEqual([
    ['delete', before],
    ['insert', after],
  ]);
  expect(diff).toMatchObject({ added: 30, removed: 30 });
});

test('applying the hunks of random edits reproduces the edited text', () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const vocabulary = [
    '그는',
    '사람이',
    '“안녕”',
    '‘그래’',
    '—',
    '마을',
    '😀',
    'a',
    ' ',
    '  ',
    '\n',
    '\r\n',
    '\t',
  ];
  for (let round = 0; round < 300; round++) {
    const before = Array.from({ length: Math.floor(random() * 60) }, () => pick(vocabulary)).join(
      ''
    );
    let after = before;
    for (let edit = Math.floor(random() * 6); edit > 0; edit--) {
      const at = Math.floor(random() * (after.length + 1));
      const safe = at > 0 && /[\uDC00-\uDFFF]/u.test(after[at] ?? '') ? at - 1 : at;
      const removed = Math.floor(random() * 4);
      let end = Math.min(after.length, safe + removed);
      if (/[\uDC00-\uDFFF]/u.test(after[end] ?? '')) end++;
      after = after.slice(0, safe) + (random() < 0.7 ? pick(vocabulary) : '') + after.slice(end);
    }
    for (const mode of ['prose', 'code'] as const) {
      const diff = changes(diffText(before, after, mode, { ...TEXT_DIFF_LIMITS, context: 1 }));
      expect(applyTextDiff(before, diff.hunks), JSON.stringify({ before, after, mode })).toBe(
        after
      );
      if (before === after) expect(diff.hunks).toEqual([]);
    }
  }
});

test('intraline emphasis marks only the changed words of a paired line', () => {
  const found = intralineDiff('  <span>날씨: 맑음</span>', '  <span>날씨: 흐림</span>');
  expect(found?.before.filter((segment) => segment.op !== 'equal').map((s) => s.text)).toEqual([
    '맑음',
  ]);
  expect(found?.after.filter((segment) => segment.op !== 'equal').map((s) => s.text)).toEqual([
    '흐림',
  ]);
  expect(found?.before.map((segment) => segment.text).join('')).toBe('  <span>날씨: 맑음</span>');
  const spaced = intralineDiff('local hp = max_hp - 10', 'local mp = max_mp - 10');
  expect(spaced?.after.filter((segment) => segment.op === 'insert').map((s) => s.text)).toEqual([
    'mp',
    'max_mp',
  ]);
});

test('intraline emphasis steps aside when a line is mostly rewritten', () => {
  expect(intralineDiff('return a', 'print(b, c)')).toBeNull();
  expect(intralineDiff('same', 'same')).toBeNull();
  const now = (() => {
    let time = 0;
    return () => (time += 10);
  })();
  const slow = intralineDiff('alpha beta gamma delta', 'alpha beta gamma omega', now);
  expect(slow?.after.filter((segment) => segment.op === 'insert').map((s) => s.text)).toEqual([
    'omega',
  ]);
});

test('changed lines pair by similarity in order and leave unrelated lines unpaired', () => {
  expect(
    pairChangedLines(
      ['  <span>날씨: 맑음</span>', '  <span>체력: 80</span>'],
      ['  <span>새 줄</span>', '  <span>날씨: 흐림</span>', '  <span>체력: 65</span>']
    )
  ).toEqual([
    [0, 1],
    [1, 2],
  ]);
  expect(pairChangedLines(['alpha beta'], ['totally different words'])).toEqual([]);
  expect(pairChangedLines([], ['added'])).toEqual([]);
});
