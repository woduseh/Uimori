import {
  alignSequences,
  intralineDiff,
  pairChangedLines,
  rewriteAsBlocks,
  type TextDiffHunk,
  type TextDiffSegment,
} from '../core/text-diff.js';

export type DiffLineOp = TextDiffSegment['op'];
export type DiffCell = {
  op: DiffLineOp;
  text: string;
  number: number | null;
  marks: TextDiffSegment[] | null;
};
export type UnifiedLine = {
  op: DiffLineOp;
  text: string;
  before: number | null;
  after: number | null;
  marks: TextDiffSegment[] | null;
};
export type SplitRow = { before: DiffCell | null; after: DiffCell | null };
export type LineStart = { before: number | null; after: number | null };
export type DiffGap = { lines: string[]; before: number; after: number };

const MARKED_LINE_LIMIT = 2_000;
const UNNUMBERED: LineStart = { before: null, after: null };

export function diffLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

type Block = { equal: string[] } | { removed: string[]; added: string[] };

function blocks(hunk: TextDiffHunk): Block[] {
  const result: Block[] = [];
  for (const segment of hunk.segments) {
    const lines = diffLines(segment.text);
    if (segment.op === 'equal') {
      result.push({ equal: lines });
      continue;
    }
    let last = result.at(-1);
    if (!last || 'equal' in last) result.push((last = { removed: [], added: [] }));
    (segment.op === 'delete' ? last.removed : last.added).push(...lines);
  }
  return result;
}

function pairedMarks(removed: readonly string[], added: readonly string[]) {
  const before = new Map<number, TextDiffSegment[] | null>();
  const after = new Map<number, TextDiffSegment[] | null>();
  const pairs = pairChangedLines(removed, added);
  for (const [left, right] of pairs) {
    const a = removed[left]!;
    const b = added[right]!;
    const found =
      a.length > MARKED_LINE_LIMIT || b.length > MARKED_LINE_LIMIT ? null : intralineDiff(a, b);
    before.set(left, found?.before ?? null);
    after.set(right, found?.after ?? null);
  }
  return { pairs, before, after };
}

function counter(start: number | null) {
  let value = start;
  return () => (value === null ? null : value++);
}

export function unifiedLines(hunk: TextDiffHunk, start: LineStart = UNNUMBERED): UnifiedLine[] {
  const before = counter(start.before);
  const after = counter(start.after);
  const lines: UnifiedLine[] = [];
  for (const block of blocks(hunk)) {
    if ('equal' in block) {
      for (const text of block.equal)
        lines.push({ op: 'equal', text, before: before(), after: after(), marks: null });
      continue;
    }
    const marks = pairedMarks(block.removed, block.added);
    for (const [index, text] of block.removed.entries())
      lines.push({
        op: 'delete',
        text,
        before: before(),
        after: null,
        marks: marks.before.get(index) ?? null,
      });
    for (const [index, text] of block.added.entries())
      lines.push({
        op: 'insert',
        text,
        before: null,
        after: after(),
        marks: marks.after.get(index) ?? null,
      });
  }
  return lines;
}

export function splitRows(hunk: TextDiffHunk, start: LineStart = UNNUMBERED): SplitRow[] {
  const before = counter(start.before);
  const after = counter(start.after);
  const rows: SplitRow[] = [];
  for (const block of blocks(hunk)) {
    if ('equal' in block) {
      for (const text of block.equal)
        rows.push({
          before: { op: 'equal', text, number: before(), marks: null },
          after: { op: 'equal', text, number: after(), marks: null },
        });
      continue;
    }
    const { removed, added } = block;
    const marks = pairedMarks(removed, added);
    const left = (index: number): DiffCell => ({
      op: 'delete',
      text: removed[index]!,
      number: before(),
      marks: marks.before.get(index) ?? null,
    });
    const right = (index: number): DiffCell => ({
      op: 'insert',
      text: added[index]!,
      number: after(),
      marks: marks.after.get(index) ?? null,
    });
    let x = 0;
    let y = 0;
    for (const [pairX, pairY] of [...marks.pairs, [removed.length, added.length] as const]) {
      while (x < pairX || y < pairY) {
        rows.push({ before: x < pairX ? left(x) : null, after: y < pairY ? right(y) : null });
        if (x < pairX) x++;
        if (y < pairY) y++;
      }
      if (pairX >= removed.length && pairY >= added.length) break;
      rows.push({ before: left(pairX), after: right(pairY) });
      x = pairX + 1;
      y = pairY + 1;
    }
  }
  return rows;
}

function consumed(hunk: TextDiffHunk, side: 'before' | 'after') {
  const skip = side === 'before' ? 'insert' : 'delete';
  let length = 0;
  for (const segment of hunk.segments) if (segment.op !== skip) length += segment.text.length;
  return length;
}

function lineCounter(text: string) {
  let offset = 0;
  let line = 1;
  return (target: number) => {
    for (; offset < target && offset < text.length; offset++) if (text[offset] === '\n') line++;
    return line;
  };
}

export function hunkStarts(hunks: readonly TextDiffHunk[], before: string, after: string) {
  const beforeLine = lineCounter(before);
  const afterLine = lineCounter(after);
  return hunks.map(
    (hunk): LineStart => ({
      before: beforeLine(hunk.beforeOffset),
      after: afterLine(hunk.afterOffset),
    })
  );
}

export function hunkGaps(hunks: readonly TextDiffHunk[], before: string, after: string): DiffGap[] {
  const beforeLine = lineCounter(before);
  const afterLine = lineCounter(after);
  const gaps: DiffGap[] = [];
  let beforeOffset = 0;
  let afterOffset = 0;
  for (const hunk of [...hunks, null]) {
    const end = hunk ? hunk.beforeOffset : before.length;
    gaps.push({
      lines: diffLines(before.slice(beforeOffset, end)),
      before: beforeLine(beforeOffset),
      after: afterLine(afterOffset),
    });
    if (!hunk) break;
    beforeOffset = hunk.beforeOffset + consumed(hunk, 'before');
    afterOffset = hunk.afterOffset + consumed(hunk, 'after');
  }
  return gaps;
}

export function proseSides(hunk: TextDiffHunk) {
  const segments = rewriteAsBlocks(hunk.segments);
  return {
    before: segments.filter((segment) => segment.op !== 'insert'),
    after: segments.filter((segment) => segment.op !== 'delete'),
  };
}

export type LineMark = {
  line: number;
  kind: 'added' | 'changed' | 'deleted-above' | 'deleted-below';
};

export function changedLineMarks(base: string, text: string): LineMark[] | null {
  if (base === text) return [];
  const before = base.replaceAll('\r\n', '\n').split('\n');
  const after = text.split('\n');
  const script = alignSequences(before, after);
  if (!script) return null;
  const marks: LineMark[] = [];
  let line = 0;
  for (let index = 0; index < script.length; ) {
    if (script[index] === 'equal') {
      line++;
      index++;
      continue;
    }
    let removed = 0;
    let added = 0;
    while (index < script.length && script[index] !== 'equal') {
      if (script[index] === 'delete') removed++;
      else added++;
      index++;
    }
    for (let offset = 0; offset < added; offset++)
      marks.push({ line: line + offset + 1, kind: offset < removed ? 'changed' : 'added' });
    if (!added)
      marks.push(line ? { line, kind: 'deleted-below' } : { line: 1, kind: 'deleted-above' });
    line += added;
  }
  return marks;
}

export function firstChangeOffset(hunks: readonly TextDiffHunk[]): number | null {
  const hunk = hunks[0];
  if (!hunk) return null;
  let offset = hunk.afterOffset;
  for (const segment of hunk.segments) {
    if (segment.op !== 'equal') return offset;
    offset += segment.text.length;
  }
  return offset;
}
