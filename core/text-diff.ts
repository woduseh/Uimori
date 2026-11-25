export type TextDiffMode = 'prose' | 'code';
export type TextDiffUnit = 'word' | 'line';
export type TextDiffSegment = { op: 'equal' | 'insert' | 'delete'; text: string };
export type TextDiffHunk = {
  beforeOffset: number;
  afterOffset: number;
  segments: TextDiffSegment[];
};
export type TextDiffOmission = 'size' | 'time';
export type TextDiff =
  | {
      mode: TextDiffMode;
      unit: TextDiffUnit;
      added: number;
      removed: number;
      hunks: TextDiffHunk[];
    }
  | { mode: TextDiffMode; unit: TextDiffUnit; omitted: TextDiffOmission };
export type TextDiffLimits = {
  maxInputLength: number;
  maxEdits: number;
  maxOutputLength: number;
  timeoutMs: number;
  context?: number;
  now?: () => number;
};

export const TEXT_DIFF_LIMITS: Readonly<TextDiffLimits> = {
  maxInputLength: 400_000,
  maxEdits: 2_000,
  maxOutputLength: 40_000,
  timeoutMs: 50,
};
const DEFAULT_CONTEXT: Record<TextDiffMode, number> = { prose: 8, code: 2 };

class DiffTimeout extends Error {}
type Step = TextDiffSegment['op'];
type Op = { op: Step; text: string; units: number };

const whitespace = (char: string | undefined) => char !== undefined && /\s/u.test(char);
const paragraphs = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
const words = (text: string) => text.match(/\s+|\S+/gu) ?? [];
const wordCount = (text: string) => text.match(/\S+/gu)?.length ?? 0;

function intern(a: readonly string[], b: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const id = (token: string) => {
    let value = ids.get(token);
    if (value === undefined) ids.set(token, (value = ids.size));
    return value;
  };
  return [Int32Array.from(a, id), Int32Array.from(b, id)];
}

function diffTokens(
  before: readonly string[],
  after: readonly string[],
  maxEdits: number,
  deadline: number,
  now: () => number
): Step[] | null {
  const [a, b] = intern(before, after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  const middle = myers(
    a.subarray(prefix, prefix + n),
    b.subarray(prefix, prefix + m),
    maxEdits,
    deadline,
    now
  );
  if (!middle) return null;
  return [...Array<Step>(prefix).fill('equal'), ...middle, ...Array<Step>(suffix).fill('equal')];
}

function myers(
  a: Int32Array,
  b: Int32Array,
  maxEdits: number,
  deadline: number,
  now: () => number
): Step[] | null {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return Array<Step>(m).fill('insert');
  if (!m) return Array<Step>(n).fill('delete');
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    if ((d & 15) === 15 && now() > deadline) throw new DiffTimeout();
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Step[] {
  const script: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const at = (k: number) => v[k + d + 1]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      script.push('equal');
      x--;
      y--;
    }
    if (d > 0) {
      script.push(x === previousX ? 'insert' : 'delete');
      x = previousX;
      y = previousY;
    }
  }
  return script.reverse();
}

function scriptOps(
  before: readonly string[],
  after: readonly string[],
  script: readonly Step[],
  unitsOf: (token: string) => number
): Op[] {
  const ops: Op[] = [];
  let x = 0;
  let y = 0;
  for (const op of script) {
    const token = op === 'insert' ? after[y++]! : before[x++]!;
    if (op === 'equal') y++;
    const last = ops.at(-1);
    if (last?.op === op) {
      last.text += token;
      last.units += unitsOf(token);
    } else ops.push({ op, text: token, units: unitsOf(token) });
  }
  return ops;
}

function proseOps(
  before: string,
  after: string,
  maxEdits: number,
  deadline: number,
  now: () => number
): Op[] | null {
  const a = paragraphs(before);
  const b = paragraphs(after);
  const script = diffTokens(a, b, maxEdits, deadline, now);
  if (!script) return null;
  const ops: Op[] = [];
  const push = (op: Op) => {
    if (!op.text) return;
    const last = ops.at(-1);
    if (last?.op === op.op) {
      last.text += op.text;
      last.units += op.units;
    } else ops.push({ ...op });
  };
  let x = 0;
  let y = 0;
  for (let index = 0; index < script.length; ) {
    if (script[index] === 'equal') {
      push({ op: 'equal', text: a[x++]!, units: 0 });
      y++;
      index++;
      continue;
    }
    let removed = '';
    let added = '';
    while (index < script.length && script[index] !== 'equal') {
      if (script[index] === 'delete') removed += a[x++]!;
      else added += b[y++]!;
      index++;
    }
    const left = words(removed);
    const right = words(added);
    const refined = diffTokens(left, right, maxEdits, deadline, now);
    if (refined)
      for (const op of scriptOps(left, right, refined, (token) => wordCount(token))) push(op);
    else {
      push({ op: 'delete', text: removed, units: wordCount(removed) });
      push({ op: 'insert', text: added, units: wordCount(added) });
    }
  }
  return ops;
}

function headLength(text: string, units: number, mode: TextDiffMode): number {
  let index = 0;
  for (let count = 0; count < units; count++) {
    if (mode === 'code') {
      const newline = text.indexOf('\n', index);
      if (newline < 0) return text.length;
      index = newline + 1;
      continue;
    }
    while (index < text.length && whitespace(text[index])) index++;
    if (index >= text.length) return text.length;
    while (index < text.length && !whitespace(text[index])) index++;
  }
  return index;
}

function tailStart(text: string, units: number, mode: TextDiffMode): number {
  let index = text.length;
  for (let count = 0; count < units; count++) {
    if (index === 0) return 0;
    if (mode === 'code') {
      index = text.lastIndexOf('\n', index - 2) + 1;
      continue;
    }
    while (index > 0 && whitespace(text[index - 1])) index--;
    if (index === 0) return 0;
    while (index > 0 && !whitespace(text[index - 1])) index--;
  }
  return index;
}

function hunks(ops: readonly Op[], mode: TextDiffMode, context: number): TextDiffHunk[] {
  const result: TextDiffHunk[] = [];
  let current: TextDiffHunk | null = null;
  let beforeOffset = 0;
  let afterOffset = 0;
  const lastChange = ops.findLastIndex((op) => op.op !== 'equal');
  for (const [index, op] of ops.entries()) {
    if (op.op !== 'equal') {
      current ??= { beforeOffset, afterOffset, segments: [] };
      current.segments.push({ op: op.op, text: op.text });
      if (op.op === 'delete') beforeOffset += op.text.length;
      else afterOffset += op.text.length;
      continue;
    }
    const text = op.text;
    if (current && index < lastChange) {
      const head = headLength(text, context, mode);
      const tail = Math.max(head, tailStart(text, context, mode));
      if (tail - head > 0 && /\S/u.test(text.slice(head, tail))) {
        if (head > 0) current.segments.push({ op: 'equal', text: text.slice(0, head) });
        result.push(current);
        current = null;
      } else {
        current.segments.push({ op: 'equal', text });
        beforeOffset += text.length;
        afterOffset += text.length;
        continue;
      }
    } else if (current) {
      const head = headLength(text, context, mode);
      if (head > 0) current.segments.push({ op: 'equal', text: text.slice(0, head) });
      result.push(current);
      current = null;
      beforeOffset += text.length;
      afterOffset += text.length;
      continue;
    }
    if (index < lastChange) {
      const start = tailStart(text, context, mode);
      current = {
        beforeOffset: beforeOffset + start,
        afterOffset: afterOffset + start,
        segments: start < text.length ? [{ op: 'equal', text: text.slice(start) }] : [],
      };
    }
    beforeOffset += text.length;
    afterOffset += text.length;
  }
  if (current) result.push(current);
  return result;
}

export function diffText(
  before: string,
  after: string,
  mode: TextDiffMode,
  limits: TextDiffLimits = TEXT_DIFF_LIMITS
): TextDiff {
  const unit: TextDiffUnit = mode === 'prose' ? 'word' : 'line';
  if (before === after) return { mode, unit, added: 0, removed: 0, hunks: [] };
  if (before.length > limits.maxInputLength || after.length > limits.maxInputLength)
    return { mode, unit, omitted: 'size' };
  const now = limits.now ?? (() => performance.now());
  const deadline = now() + limits.timeoutMs;
  let ops: Op[] | null;
  try {
    if (mode === 'prose') ops = proseOps(before, after, limits.maxEdits, deadline, now);
    else {
      const a = paragraphs(before);
      const b = paragraphs(after);
      const script = diffTokens(a, b, limits.maxEdits, deadline, now);
      ops = script && scriptOps(a, b, script, () => 1);
    }
  } catch (error) {
    if (error instanceof DiffTimeout) return { mode, unit, omitted: 'time' };
    throw error;
  }
  if (!ops) return { mode, unit, omitted: 'size' };
  let added = 0;
  let removed = 0;
  for (const op of ops)
    if (op.op === 'insert') added += op.units;
    else if (op.op === 'delete') removed += op.units;
  const result = hunks(ops, mode, limits.context ?? DEFAULT_CONTEXT[mode]);
  let size = 0;
  for (const hunk of result) for (const segment of hunk.segments) size += segment.text.length;
  if (size > limits.maxOutputLength) return { mode, unit, omitted: 'size' };
  return { mode, unit, added, removed, hunks: result };
}

export function alignSequences(
  before: readonly string[],
  after: readonly string[],
  limits: TextDiffLimits = TEXT_DIFF_LIMITS
): ('equal' | 'insert' | 'delete')[] | null {
  const now = limits.now ?? (() => performance.now());
  try {
    return diffTokens(before, after, limits.maxEdits, now() + limits.timeoutMs, now);
  } catch (error) {
    if (error instanceof DiffTimeout) return null;
    throw error;
  }
}

const REWRITE_SHARE = 0.5;
const REWRITE_MIN_WORDS = 3;

export function rewriteAsBlocks(segments: readonly TextDiffSegment[]): TextDiffSegment[] {
  const first = segments.findIndex((segment) => segment.op !== 'equal');
  const last = segments.findLastIndex((segment) => segment.op !== 'equal');
  const span = segments.slice(first, last + 1);
  const count = (op: Step) =>
    span.reduce((sum, segment) => sum + (segment.op === op ? wordCount(segment.text) : 0), 0);
  const removed = count('delete');
  const added = count('insert');
  const kept = count('equal');
  if (
    first < 0 ||
    Math.max(removed, added) < REWRITE_MIN_WORDS ||
    (removed + added) / (removed + added + 2 * kept) <= REWRITE_SHARE
  )
    return [...segments];
  const before = span
    .flatMap((segment) => (segment.op === 'insert' ? [] : [segment.text]))
    .join('');
  const after = span.flatMap((segment) => (segment.op === 'delete' ? [] : [segment.text])).join('');
  return [
    ...segments.slice(0, first),
    ...(before ? [{ op: 'delete' as const, text: before }] : []),
    ...(after ? [{ op: 'insert' as const, text: after }] : []),
    ...segments.slice(last + 1),
  ];
}

const INTRALINE_TOKENS = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const INTRALINE_MAX_EDITS = 200;
const INTRALINE_TIMEOUT_MS = 5;
const INTRALINE_MAX_SHARE = 0.7;
const LINE_PAIR_SIMILARITY = 0.4;
const LINE_PAIR_WINDOW = 8;

export type IntralineDiff = { before: TextDiffSegment[]; after: TextDiffSegment[] };

function pushSegment(segments: TextDiffSegment[], op: Step, text: string) {
  if (!text) return;
  const last = segments.at(-1);
  if (last?.op === op) last.text += text;
  else segments.push({ op, text });
}

function absorbSpaces(segments: readonly TextDiffSegment[]): TextDiffSegment[] {
  const result: TextDiffSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    const between =
      segment.op === 'equal' &&
      !/\S/u.test(segment.text) &&
      segments[index - 1] &&
      segments[index + 1] &&
      segments[index - 1]!.op !== 'equal' &&
      segments[index + 1]!.op !== 'equal';
    pushSegment(result, between ? segments[index - 1]!.op : segment.op, segment.text);
  }
  return result;
}

function affixDiff(before: string, after: string): IntralineDiff {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  if (prefix > 0 && /[\uD800-\uDBFF]/u.test(before[prefix - 1]!)) prefix--;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  if (suffix > 0 && /[\uDC00-\uDFFF]/u.test(before[before.length - suffix]!)) suffix--;
  const side = (text: string, op: Step) => {
    const segments: TextDiffSegment[] = [];
    pushSegment(segments, 'equal', text.slice(0, prefix));
    pushSegment(segments, op, text.slice(prefix, text.length - suffix));
    pushSegment(segments, 'equal', text.slice(text.length - suffix));
    return segments;
  };
  return { before: side(before, 'delete'), after: side(after, 'insert') };
}

const changedShare = (segments: readonly TextDiffSegment[], length: number) =>
  length
    ? segments.reduce(
        (sum, segment) => sum + (segment.op === 'equal' ? 0 : segment.text.length),
        0
      ) / length
    : 1;

export function intralineDiff(
  before: string,
  after: string,
  now: () => number = () => performance.now()
): IntralineDiff | null {
  if (before === after) return null;
  const a = before.match(INTRALINE_TOKENS) ?? [];
  const b = after.match(INTRALINE_TOKENS) ?? [];
  let script: Step[] | null = null;
  try {
    script = diffTokens(a, b, INTRALINE_MAX_EDITS, now() + INTRALINE_TIMEOUT_MS, now);
  } catch (error) {
    if (!(error instanceof DiffTimeout)) throw error;
  }
  let result: IntralineDiff;
  if (!script) result = affixDiff(before, after);
  else {
    const left: TextDiffSegment[] = [];
    const right: TextDiffSegment[] = [];
    let x = 0;
    let y = 0;
    for (const step of script) {
      if (step !== 'insert') pushSegment(left, step, a[x++]!);
      if (step !== 'delete') pushSegment(right, step, b[y++]!);
    }
    result = { before: absorbSpaces(left), after: absorbSpaces(right) };
  }
  if (
    changedShare(result.before, before.length) > INTRALINE_MAX_SHARE &&
    changedShare(result.after, after.length) > INTRALINE_MAX_SHARE
  )
    return null;
  return result;
}

function lineSimilarity(left: string, right: string): number {
  const a = left.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const b = right.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of b) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      shared++;
      counts.set(token, count - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

export function pairChangedLines(
  removed: readonly string[],
  added: readonly string[]
): [number, number][] {
  const pairs: [number, number][] = [];
  let start = 0;
  for (let index = 0; index < removed.length && start < added.length; index++) {
    let best = -1;
    let score = LINE_PAIR_SIMILARITY;
    for (let candidate = start; candidate < added.length; candidate++) {
      if (candidate >= start + LINE_PAIR_WINDOW) break;
      const similarity = lineSimilarity(removed[index]!, added[candidate]!);
      if (similarity > score) {
        best = candidate;
        score = similarity;
      }
    }
    if (best < 0) continue;
    pairs.push([index, best]);
    start = best + 1;
  }
  return pairs;
}

export function applyTextDiff(before: string, hunks: readonly TextDiffHunk[]): string {
  let result = '';
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.beforeOffset < cursor) throw new Error('TEXT_DIFF_HUNKS_OVERLAP');
    result += before.slice(cursor, hunk.beforeOffset);
    cursor = hunk.beforeOffset;
    for (const segment of hunk.segments) {
      if (segment.op === 'insert') {
        result += segment.text;
        continue;
      }
      if (before.slice(cursor, cursor + segment.text.length) !== segment.text)
        throw new Error('TEXT_DIFF_BASE_MISMATCH');
      if (segment.op === 'equal') result += segment.text;
      cursor += segment.text.length;
    }
  }
  return result + before.slice(cursor);
}
