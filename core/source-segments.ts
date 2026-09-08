import {
  evaluatePromptExpression,
  resolvePromptValues,
  validatePromptExpression,
  type PromptControl,
  type PromptExpression,
  type PromptValue,
} from './prompt-program.js';

export type SegmentRange = { start: number; end: number };
export type SegmentSource = { sourceRevision: string; sourceHash: string; text: string };
export type SegmentDiagnostic = {
  code: string;
  severity: 'warning' | 'error';
  range?: SegmentRange;
};
export type SegmentKnowledge = {
  status: 'unknown';
  mode: 'unspecified';
  perspectiveActorIds: null;
  knownByActorIds: null;
  evidence: SegmentRange[];
};
/** Literal delimiters are package data. No package name, prompt instruction, or content theme is interpreted here. */
export type SourceSegmentRule = {
  id: string;
  kind: 'aside' | 'annotation';
  open: string;
  close: string;
  match: 'line' | 'inline';
  title?: boolean;
  label: string;
  expanded?: boolean;
  exclude?: boolean;
  keepLastMessages?: number;
  scene?: { open: string; close: string; separator: string };
  portrait?: { open: string; close: string };
  when?: PromptExpression;
  excludeWhen?: PromptExpression;
  expandedWhen?: PromptExpression;
};
export type SourceSegmentPolicy = { version: 1; rules: SourceSegmentRule[] };
export type SourceSegment = {
  id: string;
  kind: 'main' | 'aside' | 'annotation';
  ruleId?: string;
  range: SegmentRange;
  bodyRange: SegmentRange;
  title?: string;
  titleRange?: SegmentRange;
  markers?: { open: SegmentRange; close: SegmentRange };
  scene?: { range: SegmentRange; place: string; time: string; subjectLabel?: string };
  portrait?: { range: SegmentRange; raw: string };
  knowledge: SegmentKnowledge;
};
export type SegmentDocument = {
  sourceRevision: string;
  sourceHash: string;
  segments: SourceSegment[];
  diagnostics: SegmentDiagnostic[];
};
export class SourceSegmentError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
    this.name = 'SourceSegmentError';
  }
}
const fail = (code: string): never => {
  throw new SourceSegmentError(code);
};
function object(value: unknown, keys: string[]): Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !('value' in Object.getOwnPropertyDescriptor(value, key)!)
    )
  )
    fail('SEGMENT_FIELDS');
  return value as Record<string, any>;
}
function literal(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\r\n]/u.test(value))
    fail('SEGMENT_DELIMITER');
}
export function validateSourceSegmentPolicy(
  value: unknown,
  controls: PromptControl[] = []
): SourceSegmentPolicy {
  const p = object(value, ['version', 'rules']);
  if (p.version !== 1 || !Array.isArray(p.rules) || p.rules.length > 32) fail('SEGMENT_POLICY');
  const ids = new Set<string>(),
    markers = new Set<string>();
  for (const raw of p.rules) {
    const r = object(raw, [
      'id',
      'kind',
      'open',
      'close',
      'match',
      'title',
      'label',
      'expanded',
      'exclude',
      'keepLastMessages',
      'scene',
      'portrait',
      'when',
      'excludeWhen',
      'expandedWhen',
    ]);
    if (
      typeof r.id !== 'string' ||
      !/^[A-Za-z0-9_-][A-Za-z0-9_.:@-]{0,199}$/u.test(r.id) ||
      ids.has(r.id)
    )
      fail('SEGMENT_ID');
    ids.add(r.id);
    literal(r.open);
    literal(r.close);
    if (r.open === r.close || markers.has(r.open) || markers.has(r.close))
      fail('SEGMENT_DELIMITER_CONFLICT');
    markers.add(r.open);
    markers.add(r.close);
    if (
      !['aside', 'annotation'].includes(r.kind) ||
      !['line', 'inline'].includes(r.match) ||
      typeof r.label !== 'string' ||
      !r.label.trim() ||
      r.label.length > 200
    )
      fail('SEGMENT_RULE');
    for (const key of ['title', 'expanded', 'exclude'])
      if (r[key] !== undefined && typeof r[key] !== 'boolean') fail('SEGMENT_BOOLEAN');
    if (r.title && r.match !== 'line') fail('SEGMENT_TITLE_REQUIRES_LINE');
    if (
      r.keepLastMessages !== undefined &&
      (!Number.isSafeInteger(r.keepLastMessages) ||
        r.keepLastMessages < 0 ||
        r.keepLastMessages > 10000)
    )
      fail('SEGMENT_RETENTION');
    for (const key of ['scene', 'portrait'])
      if (r[key] !== undefined) {
        const m = object(
          r[key],
          key === 'scene' ? ['open', 'close', 'separator'] : ['open', 'close']
        );
        literal(m.open);
        literal(m.close);
        if (key === 'scene') literal(m.separator);
      }
    for (const key of ['when', 'excludeWhen', 'expandedWhen'])
      if (r[key] !== undefined)
        validatePromptExpression(
          r[key],
          controls.map((c) => c.id)
        );
  }
  return structuredClone(p) as SourceSegmentPolicy;
}
/** Only selected package controls are evaluated. A frozen policy has no executable expressions. */
export function resolveSourceSegmentPolicy(
  policy: SourceSegmentPolicy,
  controls: PromptControl[],
  overrides?: Record<string, PromptValue>
): SourceSegmentPolicy {
  const checked = validateSourceSegmentPolicy(policy, controls),
    values = resolvePromptValues({ version: 1, blocks: [], controls }, overrides);
  const bool = (expression: PromptExpression): boolean => {
    const value = evaluatePromptExpression(expression, values);
    if (typeof value !== 'boolean') return fail('SEGMENT_CONDITION_BOOLEAN');
    return value;
  };
  return {
    version: 1,
    rules: checked.rules.flatMap(({ when, excludeWhen, expandedWhen, ...rule }) =>
      when !== undefined && !bool(when)
        ? []
        : [
            {
              ...rule,
              ...(excludeWhen !== undefined ? { exclude: bool(excludeWhen) } : {}),
              ...(expandedWhen !== undefined ? { expanded: bool(expandedWhen) } : {}),
            },
          ]
    ),
  };
}
type Line = SegmentRange & { text: string; contentEnd: number };
function lines(text: string): Line[] {
  const result: Line[] = [];
  let start = 0;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    if (!match[0]) continue;
    const value = match[0].replace(/(?:\r\n|\r|\n)$/u, '');
    result.push({
      start,
      end: start + match[0].length,
      contentEnd: start + value.length,
      text: value,
    });
    start += match[0].length;
  }
  return result;
}
type Marker = SegmentRange & {
  rule: SourceSegmentRule;
  side: 'open' | 'close';
  tokenRange: SegmentRange;
  title?: string;
  titleRange?: SegmentRange;
};
/** Bounded literal scanner. Invalid/nested blocks stay readable original text. */
export function parseSourceSegments(
  source: SegmentSource,
  policy?: SourceSegmentPolicy
): SegmentDocument {
  if (
    !source ||
    typeof source.sourceRevision !== 'string' ||
    !source.sourceRevision ||
    source.sourceRevision.length > 200 ||
    !/^[a-f0-9]{64}$/u.test(source.sourceHash) ||
    typeof source.text !== 'string' ||
    source.text.length > 1_000_000
  )
    fail('SEGMENT_SOURCE');
  const rules = policy ? validateSourceSegmentPolicy(policy).rules : [],
    diagnostics: SegmentDiagnostic[] = [],
    tokens: Marker[] = [];
  let fence: { symbol: string; length: number } | null = null;
  for (const line of lines(source.text)) {
    const fenced = line.text.match(/^\s*(`{3,}|~{3,})/u);
    if (fenced) {
      if (!fence) fence = { symbol: fenced[1][0], length: fenced[1].length };
      else if (fenced[1][0] === fence.symbol && fenced[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    for (const rule of rules)
      for (const side of ['open', 'close'] as const) {
        const token = rule[side],
          trimmed = line.text.trim();
        if (rule.match === 'line') {
          const titled = side === 'open' && rule.title;
          if (!(titled ? trimmed.startsWith(token) : trimmed === token)) continue;
          const start = line.start + line.text.indexOf(token),
            title = titled ? trimmed.slice(token.length).trim() : undefined;
          if (titled && (!title || title.length > 512))
            diagnostics.push({
              code: 'SEGMENT_TITLE',
              severity: 'error',
              range: { start, end: line.contentEnd },
            });
          const titleStart =
            start +
            token.length +
            line.text.slice(line.text.indexOf(token) + token.length).search(/\S|$/u);
          tokens.push({
            ...line,
            rule,
            side,
            tokenRange: { start, end: start + token.length },
            ...(title !== undefined
              ? { title, titleRange: { start: titleStart, end: titleStart + title.length } }
              : {}),
          });
        } else {
          let offset = 0;
          while (offset < line.text.length) {
            const found = line.text.indexOf(token, offset);
            if (found < 0) break;
            const start = line.start + found,
              end = start + token.length;
            tokens.push({ start, end, rule, side, tokenRange: { start, end } });
            offset = found + token.length;
            if (tokens.length > 2000) fail('SEGMENT_LIMIT');
          }
        }
      }
    if (tokens.length > 2000) fail('SEGMENT_LIMIT');
  }
  tokens.sort((a, b) => a.start - b.start);
  const pairs: { open: Marker; close: Marker }[] = [];
  let stack: Marker[] = [],
    corrupt = false;
  for (const token of tokens) {
    if (token.side === 'open') {
      if (stack.length) {
        corrupt = true;
        diagnostics.push({ code: 'SEGMENT_NESTED', severity: 'error', range: token.tokenRange });
      }
      stack.push(token);
      continue;
    }
    const opening = stack.pop();
    if (!opening) {
      diagnostics.push({
        code: 'SEGMENT_ORPHAN_CLOSE',
        severity: 'error',
        range: token.tokenRange,
      });
      continue;
    }
    if (opening.rule.id !== token.rule.id) {
      corrupt = true;
      diagnostics.push({
        code: 'SEGMENT_MISMATCHED_CLOSE',
        severity: 'error',
        range: token.tokenRange,
      });
    }
    if (!stack.length) {
      if (!corrupt && (!opening.rule.title || opening.title))
        pairs.push({ open: opening, close: token });
      corrupt = false;
    }
  }
  if (stack.length)
    diagnostics.push({
      code: 'SEGMENT_UNCLOSED',
      severity: 'error',
      range: { start: stack[0].start, end: source.text.length },
    });
  const segments: SourceSegment[] = [];
  const make = (kind: SourceSegment['kind'], start: number, end: number): SourceSegment => ({
    id: `segment-${source.sourceHash.slice(0, 24)}-${start}-${end}`,
    kind,
    range: { start, end },
    bodyRange: { start, end },
    knowledge: {
      status: 'unknown',
      mode: 'unspecified',
      perspectiveActorIds: null,
      knownByActorIds: null,
      evidence: [],
    },
  });
  let cursor = 0;
  for (const { open, close } of pairs) {
    if (open.start > cursor) segments.push(make('main', cursor, open.start));
    const segment = make(open.rule.kind, open.start, close.end);
    segment.ruleId = open.rule.id;
    segment.bodyRange = { start: open.end, end: close.start };
    segment.markers = { open: open.tokenRange, close: close.tokenRange };
    if (open.title !== undefined) {
      segment.title = open.title;
      segment.titleRange = open.titleRange;
    }
    for (const line of lines(source.text.slice(open.end, close.start))) {
      const value = line.text.trim();
      if (!value) continue;
      const range = { start: open.end + line.start, end: open.end + line.end },
        scene = open.rule.scene,
        portrait = open.rule.portrait;
      if (
        scene &&
        !segment.scene &&
        !segment.portrait &&
        value.startsWith(scene.open) &&
        value.endsWith(scene.close)
      ) {
        const fields = value
          .slice(scene.open.length, -scene.close.length)
          .split(scene.separator)
          .map((v) => v.trim());
        if (![2, 3].includes(fields.length) || fields.some((v) => !v || v.length > 512)) {
          diagnostics.push({ code: 'SEGMENT_SCENE', severity: 'warning', range });
          break;
        }
        segment.scene = {
          range,
          place: fields[0],
          time: fields[1],
          ...(fields[2] ? { subjectLabel: fields[2] } : {}),
        };
        segment.bodyRange.start = range.end;
        continue;
      }
      if (
        portrait &&
        !segment.portrait &&
        value.startsWith(portrait.open) &&
        value.endsWith(portrait.close)
      ) {
        segment.portrait = {
          range,
          raw: value.slice(portrait.open.length, -portrait.close.length).trim(),
        };
        segment.bodyRange.start = range.end;
        continue;
      }
      break;
    }
    if (!source.text.slice(segment.bodyRange.start, segment.bodyRange.end).trim())
      diagnostics.push({ code: 'SEGMENT_EMPTY', severity: 'error', range: segment.bodyRange });
    segments.push(segment);
    cursor = close.end;
  }
  if (cursor < source.text.length) segments.push(make('main', cursor, source.text.length));
  return {
    sourceRevision: source.sourceRevision,
    sourceHash: source.sourceHash,
    segments,
    diagnostics,
  };
}
export type SegmentRequestView = {
  ok: boolean;
  text: string;
  sourceRevision: string;
  sourceHash: string;
  keptRanges: SegmentRange[];
  excluded: {
    segmentId: string;
    kind: 'aside' | 'annotation';
    range: SegmentRange;
    sourceHash: string;
  }[];
  diagnostics: SegmentDiagnostic[];
};
export function filterSourceSegments(
  source: SegmentSource,
  policy: SourceSegmentPolicy,
  context: { messageIndex?: number; lastMessageIndex?: number } = {}
): SegmentRequestView {
  const checked = validateSourceSegmentPolicy(policy),
    document = parseSourceSegments(source, checked);
  const result: SegmentRequestView = {
    ok: true,
    text: '',
    sourceRevision: source.sourceRevision,
    sourceHash: source.sourceHash,
    keptRanges: [],
    excluded: [],
    diagnostics: [...document.diagnostics],
  };
  if (
    document.segments.some(
      (s) => checked.rules.find((r) => r.id === s.ruleId)?.keepLastMessages !== undefined
    ) &&
    (![context.messageIndex, context.lastMessageIndex].every(
      (v) => Number.isSafeInteger(v) && Number(v) >= 0
    ) ||
      Number(context.messageIndex) > Number(context.lastMessageIndex))
  )
    result.diagnostics.push({ code: 'SEGMENT_MESSAGE_INDEX', severity: 'error' });
  if (
    result.diagnostics.some((d) => d.severity === 'error') &&
    checked.rules.some((r) => r.exclude || r.keepLastMessages !== undefined)
  )
    return { ...result, ok: false };
  for (const segment of document.segments) {
    const rule = checked.rules.find((r) => r.id === segment.ruleId),
      exclude =
        rule &&
        (rule.exclude ||
          (rule.keepLastMessages !== undefined &&
            Number(context.lastMessageIndex) - Number(context.messageIndex) >
              rule.keepLastMessages));
    if (exclude && segment.kind !== 'main')
      result.excluded.push({
        segmentId: segment.id,
        kind: segment.kind,
        range: { ...segment.range },
        sourceHash: source.sourceHash,
      });
    else {
      result.keptRanges.push({ ...segment.range });
      result.text += source.text.slice(segment.range.start, segment.range.end);
    }
  }
  return result;
}
