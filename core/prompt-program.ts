/** A data-only prompt language. Content cannot create tools, wire objects or executable code. */
import { validateAgentCollaboration } from './agent-collaboration.js';
import {
  PromptBudget,
  evaluationFail,
  inspectRuntimeValue,
  jsonStringSize,
  UNSAFE_PROMPT_KEYS,
  type RuntimeValue,
  type PromptEvaluationLimits,
} from './prompt-values.js';
export type { RuntimeValue, PromptEvaluationLimits } from './prompt-values.js';
export type PromptValue = string | number | boolean | null;
export type PromptRoleName = 'system' | 'user' | 'assistant';
export const PROMPT_OPERATION_ARITY = {
  all: [0, 100],
  any: [0, 100],
  not: [1, 1],
  equal: [2, 2],
  notEqual: [2, 2],
  greater: [2, 2],
  greaterEqual: [2, 2],
  length: [1, 1],
  replace: [3, 3],
  add: [2, 2],
  subtract: [2, 2],
  multiply: [2, 2],
  divide: [2, 2],
  mod: [2, 2],
  pow: [2, 2],
  clamp: [3, 3],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  abs: [1, 1],
  min: [1, 100],
  max: [1, 100],
  sum: [1, 100],
  average: [1, 100],
  contains: [2, 2],
  startsWith: [2, 2],
  endsWith: [2, 2],
  trim: [1, 1],
  lower: [1, 1],
  upper: [1, 1],
  split: [2, 2],
  join: [2, 2],
  get: [2, 2],
  size: [1, 1],
  slice: [2, 3],
  range: [1, 3],
  unique: [1, 1],
  exists: [1, 1],
  coalesce: [1, 100],
  typedIf: [3, 3],
  typedEqual: [2, 2],
  gt: [2, 2],
  gte: [2, 2],
  lt: [2, 2],
  lte: [2, 2],
  array: [0, 100],
  object: [0, 100],
  map: [2, 2],
  filter: [2, 2],
  append: [2, 2],
  concatArrays: [0, 100],
  setAt: [3, 3],
  merge: [2, 2],
  datePart: [2, 2],
  dateAddDays: [2, 2],
  dateFormat: [2, 2],
} as const;
export type PromptOperation = keyof typeof PROMPT_OPERATION_ARITY;
export type PromptExpression =
  | PromptValue
  | { control: string }
  | { context: string[] }
  | { local: string; path?: string[] }
  | { literal: RuntimeValue }
  | { op: PromptOperation; args: PromptExpression[]; as?: string; index?: string };
export type PromptTemplate = (
  | { kind: 'text'; text: string }
  | { kind: 'value'; expression: PromptExpression }
  | { kind: 'slot'; name: string }
  | {
      kind: 'if';
      condition: PromptExpression;
      then: PromptTemplate;
      else?: PromptTemplate;
      trimLines?: boolean;
    }
  | {
      kind: 'each';
      source: PromptExpression;
      as: string;
      index?: string;
      body: PromptTemplate;
      else?: PromptTemplate;
    }
  | { kind: 'let'; name: string; value: PromptExpression; body: PromptTemplate }
)[];
export type PromptControl = {
  id: string;
  label: string;
  type: 'select' | 'boolean' | 'number' | 'text';
  default: PromptValue;
  options?: { label: string; value: PromptValue }[];
  min?: number;
  max?: number;
  description?: string;
  group?: string;
  visibleWhen?: PromptExpression;
};
export type PromptBlock = {
  id: string;
  title: string;
  enabled?: boolean;
  when?: PromptExpression;
} & (
  | {
      kind: 'message';
      role: PromptRoleName;
      template: PromptTemplate;
      completion?: 'complete' | 'prefill';
    }
  | { kind: 'slot'; role: PromptRoleName; slot: string; template?: PromptTemplate }
  | { kind: 'history'; from: number; to: number | 'end' }
  | { kind: 'current' }
  | {
      kind: 'cache';
      depth: number;
      role: 'all' | 'user' | 'assistant';
      policy: 'prefer' | 'require';
    }
);
/** Opt in to a host-defined final submission tool; prompt data cannot define new tool implementations. */
export type PromptExecution = { storySubmission?: { when?: PromptExpression } };
export type PromptProgram = {
  version: 1;
  controls: PromptControl[];
  blocks: PromptBlock[];
  execution?: PromptExecution;
  collaboration?: import('./agent-collaboration.js').AgentCollaboration;
  provenance?: { sourceHash: string; variant: string; conversionVersion: string; notes: string[] };
};
export type PromptCombination = { id: string; title: string; values: Record<string, PromptValue> };
export type ChatPromptControls = {
  values: Record<string, PromptValue>;
  combinations: PromptCombination[];
  selectedCombinationId?: string;
};
export type LogicalMessage = {
  id: string;
  role: PromptRoleName;
  content: { type: 'text'; text: string }[];
  completion: 'complete' | 'prefill';
  provenance: {
    blockId: string;
    origin: 'prompt' | 'history' | 'current';
    sourceRevision?: string;
    sourceHash?: string;
    runId?: string;
  };
};
export type PromptCacheAnchor = {
  blockId: string;
  afterMessageId: string;
  policy: 'prefer' | 'require';
};
export type PromptCompilation = {
  usedSlots?: string[];
  execution?: { storySubmission: boolean };
  compilerVersion: 'uimori-prompt-1';
  values: Record<string, PromptValue>;
  messages: LogicalMessage[];
  cachePlan: PromptCacheAnchor[];
  trace: { blockId: string; included: boolean; messageIds: string[]; reason?: string }[];
  historyScope: 'm2-recent-or-full';
  warnings: string[];
};
/** sourceKind is host provenance for a directly authored start, never a provider message field. */
export type PromptHistoryMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sourceRevision?: string;
  sourceHash?: string;
  runId?: string;
  sourceKind?: 'authored-start';
  current?: boolean;
};
export type ProviderPrompt = Pick<
  PromptCompilation,
  'compilerVersion' | 'messages' | 'cachePlan' | 'values'
>;
export class PromptProgramError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: string,
    readonly blockId?: string,
    readonly slotName?: string
  ) {
    super(`${code}${blockId ? ` (${blockId})` : ''}`);
    this.name = 'PromptProgramError';
  }
}
function fail(code: string, blockId?: string): never {
  throw new PromptProgramError(code, blockId);
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    return fail('PROMPT_INVALID_FIELDS');
  return value;
}
function str(value: unknown, max = 200): asserts value is string {
  if (typeof value !== 'string' || value.length > max) fail('PROMPT_INVALID_STRING');
}
function id(value: unknown): asserts value is string {
  str(value, 160);
  if (!value || !/^[a-zA-Z0-9_.:-]+$/u.test(value)) fail('PROMPT_INVALID_ID');
}
function primitive(value: unknown): asserts value is PromptValue {
  if (
    (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
    (typeof value === 'number' && !Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 200_000)
  )
    fail('PROMPT_INVALID_VALUE');
}
/** Check serialized bounds before JSON.stringify/structuredClone can allocate an oversized AST. */
function inspectAst(value: unknown, limit = 1_000_000): void {
  const pending: { value: unknown; leave?: boolean }[] = [{ value }],
    active = new Set<object>();
  let size = 0,
    nodes = 0;
  const started = performance.now();
  while (pending.length) {
    if (++nodes % 128 === 0 && performance.now() - started > 1000) fail('PROMPT_TIME_LIMIT');
    if (nodes > 500_000) fail('PROMPT_PROGRAM_LIMIT');
    const item = pending.pop()!,
      v = item.value;
    if (item.leave) {
      active.delete(v as object);
      continue;
    }
    if (v === undefined) continue;
    if (v === null) size += 4;
    else if (typeof v === 'string') {
      if (v.length > limit) fail('PROMPT_PROGRAM_LIMIT');
      size += jsonStringSize(v);
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('PROMPT_INVALID_VALUE');
      size += String(v).length;
    } else if (typeof v === 'boolean') size += v ? 4 : 5;
    else if (typeof v === 'object') {
      if (active.has(v)) fail('PROMPT_CYCLIC_VALUE');
      const array = Array.isArray(v),
        prototype = Object.getPrototypeOf(v);
      if (
        (!array && prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(v).length
      )
        fail('PROMPT_INVALID_FIELDS');
      const keys = Object.keys(v);
      if (keys.length > 5000) fail('PROMPT_PROGRAM_LIMIT');
      active.add(v);
      pending.push({ value: v, leave: true });
      size += 2;
      let entries = 0;
      for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        if (!Object.hasOwn(d, 'value')) fail('PROMPT_INVALID_FIELDS');
        if (d.value === undefined && !array) continue;
        if (entries++) size++;
        if (!array) {
          if (key.length > limit) fail('PROMPT_PROGRAM_LIMIT');
          size += jsonStringSize(key) + 1;
        }
        pending.push({ value: d.value });
      }
    } else fail('PROMPT_INVALID_FIELDS');
    if (size > limit) fail('PROMPT_PROGRAM_LIMIT');
  }
}
export function validateProviderPrompt(value: unknown): ProviderPrompt {
  inspectAst(value, 1_500_000);
  const p = object(value, ['compilerVersion', 'messages', 'cachePlan', 'values']);
  if (
    p.compilerVersion !== 'uimori-prompt-1' ||
    !Array.isArray(p.messages) ||
    p.messages.length < 1 ||
    p.messages.length > 1000 ||
    !Array.isArray(p.cachePlan) ||
    p.cachePlan.length > 100 ||
    !isObject(p.values)
  )
    fail('PROMPT_INVALID_COMPILED');
  const ids = new Set<string>();
  for (const raw of p.messages) {
    const m = object(raw, ['id', 'role', 'content', 'completion', 'provenance']);
    id(m.id);
    if (ids.has(m.id)) fail('PROMPT_DUPLICATE_MESSAGE');
    ids.add(m.id);
    if (
      !['system', 'user', 'assistant'].includes(String(m.role)) ||
      !['complete', 'prefill'].includes(String(m.completion)) ||
      !Array.isArray(m.content) ||
      m.content.length < 1 ||
      m.content.length > 100
    )
      fail('PROMPT_INVALID_MESSAGE');
    for (const part of m.content) {
      const c = object(part, ['type', 'text']);
      if (c.type !== 'text') fail('PROMPT_TEXT_ONLY');
      str(c.text, 500_000);
    }
    const provenance = object(m.provenance, [
      'blockId',
      'origin',
      'sourceRevision',
      'sourceHash',
      'runId',
    ]);
    id(provenance.blockId);
    if (!['prompt', 'history', 'current'].includes(String(provenance.origin)))
      fail('PROMPT_INVALID_PROVENANCE');
    for (const key of ['sourceRevision', 'sourceHash', 'runId'])
      if (provenance[key] !== undefined) str(provenance[key]);
  }
  for (const raw of p.cachePlan) {
    const a = object(raw, ['blockId', 'afterMessageId', 'policy']);
    id(a.blockId);
    id(a.afterMessageId);
    if (!ids.has(a.afterMessageId) || !['prefer', 'require'].includes(String(a.policy)))
      fail('PROMPT_INVALID_CACHE');
  }
  for (const [key, value] of Object.entries(p.values)) {
    id(key);
    primitive(value);
  }
  if (JSON.stringify(value).length > 1_500_000) fail('PROMPT_COMPILED_LIMIT');
  return structuredClone(value) as ProviderPrompt;
}
function localName(value: unknown): asserts value is string {
  str(value, 80);
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/u.test(value) || UNSAFE_PROMPT_KEYS.has(value))
    fail('PROMPT_INVALID_LOCAL');
}
function pathParts(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 32) fail('PROMPT_INVALID_PATH');
  for (const part of value) {
    str(part, 200);
    if (UNSAFE_PROMPT_KEYS.has(part)) fail('PROMPT_UNSAFE_PATH');
  }
}
function expression(
  value: unknown,
  controls: Set<string> | null,
  depth = 0,
  locals = new Set<string>(),
  budget = new PromptBudget()
): void {
  budget.step();
  if (depth > 32) fail('PROMPT_NESTING_LIMIT');
  if (!isObject(value)) {
    primitive(value);
    return;
  }
  if ('control' in value) {
    object(value, ['control']);
    id(value.control);
    if (controls && !controls.has(value.control)) fail('PROMPT_UNKNOWN_CONTROL');
    return;
  }
  if ('context' in value) {
    object(value, ['context']);
    pathParts(value.context);
    return;
  }
  if ('local' in value) {
    object(value, ['local', 'path']);
    localName(value.local);
    if (!locals.has(value.local)) fail('PROMPT_UNKNOWN_LOCAL');
    if (value.path !== undefined) pathParts(value.path);
    return;
  }
  if ('literal' in value) {
    object(value, ['literal']);
    inspectRuntimeValue(value.literal, budget);
    return;
  }
  object(value, ['op', 'args', 'as', 'index']);
  if (
    typeof value.op !== 'string' ||
    !Object.hasOwn(PROMPT_OPERATION_ARITY, value.op) ||
    !Array.isArray(value.args)
  )
    fail('PROMPT_INVALID_EXPRESSION');
  const [min, max] = PROMPT_OPERATION_ARITY[value.op as PromptOperation];
  if (
    value.args.length < min ||
    value.args.length > max ||
    (value.op === 'object' && value.args.length % 2)
  )
    fail('PROMPT_EXPRESSION_ARITY');
  if (value.op === 'map' || value.op === 'filter') {
    localName(value.as);
    if (value.index !== undefined) {
      localName(value.index);
      if (value.index === value.as) fail('PROMPT_DUPLICATE_LOCAL');
    }
    expression(value.args[0], controls, depth + 1, locals, budget);
    const bound = new Set(locals);
    bound.add(value.as);
    if (value.index !== undefined) bound.add(value.index);
    expression(value.args[1], controls, depth + 1, bound, budget);
    return;
  }
  if (value.as !== undefined || value.index !== undefined) fail('PROMPT_INVALID_FIELDS');
  value.args.forEach((arg) => {
    expression(arg, controls, depth + 1, locals, budget);
  });
}
export function validatePromptExpression(
  value: unknown,
  controlIds: Iterable<string> = [],
  localNames: Iterable<string> = []
): PromptExpression {
  inspectAst(value);
  expression(value, new Set(controlIds), 0, new Set(localNames));
  return structuredClone(value) as PromptExpression;
}
function template(
  value: unknown,
  controls: Set<string>,
  depth = 0,
  locals = new Set<string>(),
  budget = new PromptBudget()
): void {
  if (depth > 32 || !Array.isArray(value) || value.length > 5000) fail('PROMPT_TEMPLATE_LIMIT');
  for (const raw of value) {
    budget.step();
    if (!isObject(raw)) fail('PROMPT_INVALID_TEMPLATE');
    if (raw.kind === 'text') {
      object(raw, ['kind', 'text']);
      str(raw.text, 200_000);
    } else if (raw.kind === 'value') {
      object(raw, ['kind', 'expression']);
      expression(raw.expression, controls, 0, locals, budget);
    } else if (raw.kind === 'slot') {
      object(raw, ['kind', 'name']);
      id(raw.name);
    } else if (raw.kind === 'if') {
      object(raw, ['kind', 'condition', 'then', 'else', 'trimLines']);
      if (raw.trimLines !== undefined && typeof raw.trimLines !== 'boolean')
        fail('PROMPT_INVALID_TEMPLATE');
      expression(raw.condition, controls, 0, locals, budget);
      template(raw.then, controls, depth + 1, locals, budget);
      if (raw.else !== undefined) template(raw.else, controls, depth + 1, locals, budget);
    } else if (raw.kind === 'each') {
      object(raw, ['kind', 'source', 'as', 'index', 'body', 'else']);
      localName(raw.as);
      if (raw.index !== undefined) {
        localName(raw.index);
        if (raw.index === raw.as) fail('PROMPT_DUPLICATE_LOCAL');
      }
      expression(raw.source, controls, 0, locals, budget);
      const bound = new Set(locals);
      bound.add(raw.as);
      if (raw.index !== undefined) bound.add(raw.index);
      template(raw.body, controls, depth + 1, bound, budget);
      if (raw.else !== undefined) template(raw.else, controls, depth + 1, locals, budget);
    } else if (raw.kind === 'let') {
      object(raw, ['kind', 'name', 'value', 'body']);
      localName(raw.name);
      expression(raw.value, controls, 0, locals, budget);
      const bound = new Set(locals);
      bound.add(raw.name);
      template(raw.body, controls, depth + 1, bound, budget);
    } else fail('PROMPT_INVALID_TEMPLATE');
  }
}
export function validatePromptTemplate(
  value: unknown,
  controlIds: Iterable<string> = [],
  localNames: Iterable<string> = []
): PromptTemplate {
  inspectAst(value);
  template(value, new Set(controlIds), 0, new Set(localNames));
  return structuredClone(value) as PromptTemplate;
}
export function validatePromptProgram(value: unknown): PromptProgram {
  inspectAst(value);
  const raw = object(value, [
    'version',
    'controls',
    'blocks',
    'execution',
    'collaboration',
    'provenance',
  ]);
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.controls) ||
    raw.controls.length > 150 ||
    !Array.isArray(raw.blocks) ||
    raw.blocks.length > 300
  )
    fail('PROMPT_PROGRAM_LIMIT');
  const controls = new Set<string>();
  for (const item of raw.controls) {
    const c = object(item, [
      'id',
      'label',
      'type',
      'default',
      'options',
      'min',
      'max',
      'description',
      'group',
      'visibleWhen',
    ]);
    id(c.id);
    str(c.label);
    primitive(c.default);
    if (controls.has(c.id) || !['select', 'boolean', 'number', 'text'].includes(String(c.type)))
      fail('PROMPT_INVALID_CONTROL');
    controls.add(c.id);
    if (c.description !== undefined) str(c.description, 4000);
    if (c.group !== undefined) str(c.group, 200);
    if (c.options !== undefined) {
      if (!Array.isArray(c.options) || c.options.length > 100) fail('PROMPT_INVALID_OPTIONS');
      for (const option of c.options) {
        const o = object(option, ['label', 'value']);
        str(o.label);
        primitive(o.value);
      }
    }
    for (const key of ['min', 'max'])
      if (c[key] !== undefined && (typeof c[key] !== 'number' || !Number.isFinite(c[key])))
        fail('PROMPT_INVALID_RANGE');
    if (c.min !== undefined && c.max !== undefined && Number(c.min) > Number(c.max))
      fail('PROMPT_INVALID_RANGE');
    validateControlValue(c as PromptControl, c.default);
  }
  // Presentation conditions can refer to controls declared later in the list.
  if (raw.collaboration !== undefined) {
    try {
      validateAgentCollaboration(raw.collaboration, [...controls]);
    } catch {
      fail('PROMPT_INVALID_COLLABORATION');
    }
  }
  for (const c of raw.controls as PromptControl[])
    if (c.visibleWhen !== undefined) expression(c.visibleWhen, controls);
  if (raw.execution !== undefined) {
    const execution = object(raw.execution, ['storySubmission']);
    if (execution.storySubmission !== undefined) {
      const submission = object(execution.storySubmission, ['when']);
      if (submission.when !== undefined) expression(submission.when, controls);
    }
  }
  const ids = new Set<string>();
  for (const item of raw.blocks) {
    const b = object(item, [
      'id',
      'title',
      'enabled',
      'when',
      'kind',
      'role',
      'template',
      'completion',
      'slot',
      'from',
      'to',
      'depth',
      'policy',
    ]);
    id(b.id);
    str(b.title);
    if (ids.has(b.id)) fail('PROMPT_DUPLICATE_BLOCK', b.id);
    ids.add(b.id);
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean')
      fail('PROMPT_INVALID_ENABLED', b.id);
    if (b.when !== undefined) expression(b.when, controls);
    if (b.kind === 'message' || b.kind === 'slot') {
      if (!['system', 'user', 'assistant'].includes(String(b.role)))
        fail('PROMPT_INVALID_ROLE', b.id);
    }
    if (b.kind === 'message') {
      template(b.template, controls);
      if (b.completion !== undefined && !['complete', 'prefill'].includes(String(b.completion)))
        fail('PROMPT_INVALID_COMPLETION', b.id);
      if (b.completion === 'prefill' && b.role !== 'assistant') fail('PROMPT_PREFILL_ROLE', b.id);
    } else if (b.kind === 'slot') {
      id(b.slot);
      if (b.template !== undefined) template(b.template, controls);
    } else if (b.kind === 'history') {
      if (!Number.isSafeInteger(b.from) || (b.to !== 'end' && !Number.isSafeInteger(b.to)))
        fail('PROMPT_INVALID_HISTORY_RANGE', b.id);
    } else if (b.kind === 'cache') {
      if (
        !Number.isSafeInteger(b.depth) ||
        Number(b.depth) < 1 ||
        Number(b.depth) > 4 ||
        !['all', 'user', 'assistant'].includes(String(b.role)) ||
        !['prefer', 'require'].includes(String(b.policy))
      )
        fail('PROMPT_INVALID_CACHE', b.id);
    } else if (b.kind !== 'current') fail('PROMPT_INVALID_BLOCK', b.id);
  }
  if (raw.provenance !== undefined) {
    const p = object(raw.provenance, ['sourceHash', 'variant', 'conversionVersion', 'notes']);
    str(p.sourceHash, 64);
    str(p.variant);
    str(p.conversionVersion);
    if (!Array.isArray(p.notes) || p.notes.length > 100) fail('PROMPT_INVALID_PROVENANCE');
    p.notes.forEach((n) => {
      str(n, 4000);
    });
  }
  if (JSON.stringify(value).length > 1_000_000) fail('PROMPT_PROGRAM_LIMIT');
  return structuredClone(value) as PromptProgram;
}
function validateControlValue(
  control: PromptControl,
  value: unknown
): asserts value is PromptValue {
  primitive(value);
  // null records an unset imported global toggle; it is not silently coerced to option zero.
  if (value === null) return;
  if (
    (control.type === 'select' && !control.options?.some((o) => o.value === value)) ||
    (control.type === 'boolean' && typeof value !== 'boolean') ||
    (control.type === 'text' && typeof value !== 'string') ||
    (control.type === 'number' &&
      (typeof value !== 'number' ||
        (control.min !== undefined && value < control.min) ||
        (control.max !== undefined && value > control.max)))
  )
    fail('PROMPT_INVALID_CONTROL_VALUE', control.id);
}
export function resolvePromptValues(
  program: PromptProgram,
  values: Record<string, PromptValue> = {}
): Record<string, PromptValue> {
  if (
    !isObject(values) ||
    Object.keys(values).some((key) => !program.controls.some((c) => c.id === key))
  )
    fail('PROMPT_UNKNOWN_CONTROL');
  return Object.fromEntries(
    program.controls.map((c) => {
      const value = Object.hasOwn(values, c.id) ? values[c.id] : c.default;
      validateControlValue(c, value);
      return [c.id, value];
    })
  );
}
/** Reconcile live saved options with the current definition; frozen inputs remain strict. */
export function reconcilePromptValues(
  program: PromptProgram,
  values: Record<string, PromptValue> = {}
): { values: Record<string, PromptValue>; resetKeys: string[] } {
  const resetKeys = Object.keys(values).filter(
    (key) => !program.controls.some((c) => c.id === key)
  );
  const resolved = Object.fromEntries(
    program.controls.map((control) => {
      if (!Object.hasOwn(values, control.id)) return [control.id, control.default];
      try {
        validateControlValue(control, values[control.id]);
        return [control.id, values[control.id]];
      } catch {
        resetKeys.push(control.id);
        return [control.id, control.default];
      }
    })
  );
  return { values: resolved, resetKeys };
}
export function validateChatPromptControls(value: unknown): ChatPromptControls {
  const raw = object(value, ['values', 'combinations', 'selectedCombinationId']);
  const values = (v: unknown) => {
    if (!isObject(v) || Object.keys(v).length > 150) fail('PROMPT_INVALID_VALUES');
    for (const [key, item] of Object.entries(v)) {
      id(key);
      primitive(item);
    }
    return structuredClone(v) as Record<string, PromptValue>;
  };
  const current = values(raw.values);
  if (!Array.isArray(raw.combinations) || raw.combinations.length > 50)
    fail('PROMPT_COMBINATION_LIMIT');
  const ids = new Set<string>();
  const combinations = raw.combinations.map((item) => {
    const c = object(item, ['id', 'title', 'values']);
    id(c.id);
    str(c.title);
    if (ids.has(c.id)) fail('PROMPT_DUPLICATE_COMBINATION');
    ids.add(c.id);
    return { id: c.id, title: c.title, values: values(c.values) };
  });
  if (raw.selectedCombinationId !== undefined) {
    id(raw.selectedCombinationId);
    if (!ids.has(raw.selectedCombinationId)) fail('PROMPT_UNKNOWN_COMBINATION');
  }
  return {
    values: current,
    combinations,
    ...(raw.selectedCombinationId !== undefined
      ? { selectedCombinationId: raw.selectedCombinationId as string }
      : {}),
  };
}
const truth = (v: RuntimeValue) =>
  v !== null && v !== false && v !== 0 && v !== '' && v !== '0' && v !== 'false' && v !== 'null';
export type PromptEvaluationOptions = {
  runtime?: Record<string, RuntimeValue>;
  locals?: Record<string, RuntimeValue>;
  limits?: PromptEvaluationLimits;
  budget?: PromptBudget;
};
const numberValue = (v: RuntimeValue): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : evaluationFail('PROMPT_NUMBER_REQUIRED');
const integerValue = (v: RuntimeValue): number =>
  Number.isSafeInteger(numberValue(v)) ? (v as number) : evaluationFail('PROMPT_INTEGER_REQUIRED');
const stringValue = (v: RuntimeValue): string =>
  typeof v === 'string' ? v : evaluationFail('PROMPT_STRING_REQUIRED');
const arrayValue = (v: RuntimeValue): RuntimeValue[] =>
  Array.isArray(v) ? v : evaluationFail('PROMPT_ARRAY_REQUIRED');
const booleanValue = (v: RuntimeValue): boolean =>
  v === null ? false : typeof v === 'boolean' ? v : evaluationFail('PROMPT_BOOLEAN_REQUIRED');
function dateValue(value: RuntimeValue): Date {
  const text = stringValue(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(text))
    return evaluationFail('PROMPT_ISO_DATE_REQUIRED');
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return evaluationFail('PROMPT_INVALID_DATE');
  const normalized = text.includes('.')
    ? text.replace(/\.(\d{1,3})Z$/u, (_, digits: string) => '.' + digits.padEnd(3, '0') + 'Z')
    : text.slice(0, -1) + '.000Z';
  if (date.toISOString() !== normalized) return evaluationFail('PROMPT_INVALID_DATE');
  return date;
}

class PromptEvaluator {
  readonly usedSlots = new Set<string>();
  readonly budget: PromptBudget;
  readonly runtime: Record<string, RuntimeValue>;
  readonly locals: Record<string, RuntimeValue>;
  private outputChars = 0;
  constructor(
    readonly values: Record<string, PromptValue>,
    options: PromptEvaluationOptions = {}
  ) {
    if (options.budget && options.limits) evaluationFail('PROMPT_INVALID_BUDGET');
    this.budget = options.budget ?? new PromptBudget(options.limits);
    if (!isObject(options.runtime ?? {}) || !isObject(options.locals ?? {}) || !isObject(values))
      evaluationFail('PROMPT_INVALID_RUNTIME_VALUE');
    for (const name of Object.keys(values)) {
      const descriptor = Object.getOwnPropertyDescriptor(values, name)!;
      if (!Object.hasOwn(descriptor, 'value')) evaluationFail('PROMPT_INVALID_RUNTIME_VALUE');
      primitive(descriptor.value);
    }
    inspectRuntimeValue(options.runtime ?? {}, this.budget);
    inspectRuntimeValue(options.locals ?? {}, this.budget);
    this.runtime = structuredClone(options.runtime ?? {});
    this.locals = structuredClone(options.locals ?? {});
  }
  claimOutput(length: number): void {
    this.outputChars += length;
    this.budget.textLength(this.outputChars, true);
  }
  display(value: RuntimeValue): string {
    if (value !== null && typeof value === 'object') {
      inspectRuntimeValue(value, this.budget);
      const text = JSON.stringify(value);
      this.budget.textLength(text.length);
      return text;
    }
    const text =
      value === null ? 'null' : typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    this.budget.textLength(text.length);
    return text;
  }
  private get(value: RuntimeValue, key: RuntimeValue): RuntimeValue {
    if (Array.isArray(value)) {
      const index =
        typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key) ? Number(key) : integerValue(key);
      return index >= 0 && index < value.length ? value[index] : null;
    }
    if (value !== null && typeof value === 'object') {
      const name = stringValue(key);
      if (UNSAFE_PROMPT_KEYS.has(name)) evaluationFail('PROMPT_UNSAFE_PATH');
      return Object.hasOwn(value, name) ? value[name] : null;
    }
    if (value === null) return null;
    return evaluationFail('PROMPT_COLLECTION_REQUIRED');
  }
  private path(value: RuntimeValue, parts: string[]): RuntimeValue {
    for (const part of parts) {
      this.budget.step();
      if (UNSAFE_PROMPT_KEYS.has(part)) evaluationFail('PROMPT_UNSAFE_PATH');
      value = this.get(value, part);
    }
    return value;
  }
  private bounded(value: RuntimeValue): RuntimeValue {
    inspectRuntimeValue(value, this.budget);
    return value;
  }
  private canonical(value: RuntimeValue): string {
    this.budget.step();
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    const parts = Array.isArray(value)
      ? value.map((v) => this.canonical(v))
      : Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + this.canonical(value[key]));
    let length = 2;
    for (const part of parts) {
      length += part.length + 1;
      this.budget.textLength(length);
    }
    return (
      (Array.isArray(value) ? '[' : '{') + parts.join(',') + (Array.isArray(value) ? ']' : '}')
    );
  }
  evaluate(expression: PromptExpression, locals = this.locals, depth = 0): RuntimeValue {
    this.budget.step();
    if (depth > 32) evaluationFail('PROMPT_NESTING_LIMIT');
    if (expression === null || typeof expression !== 'object') return expression;
    if ('control' in expression)
      return Object.hasOwn(this.values, expression.control)
        ? (this.values[expression.control] ?? null)
        : null;
    if ('context' in expression) return this.path(this.runtime, expression.context);
    if ('local' in expression) {
      if (!Object.hasOwn(locals, expression.local)) evaluationFail('PROMPT_UNKNOWN_LOCAL');
      return this.path(locals[expression.local], expression.path ?? []);
    }
    if ('literal' in expression) return expression.literal;
    const op = expression.op,
      read = (arg: PromptExpression) => this.evaluate(arg, locals, depth + 1);
    if (op === 'all') return expression.args.every((arg) => truth(read(arg)));
    if (op === 'any') return expression.args.some((arg) => truth(read(arg)));
    if (op === 'coalesce') {
      for (const arg of expression.args) {
        const value = read(arg);
        if (value !== null) return value;
      }
      return null;
    }
    if (op === 'typedIf')
      return read(expression.args[booleanValue(read(expression.args[0])) ? 1 : 2]);
    if (op === 'map' || op === 'filter') {
      const source = arrayValue(read(expression.args[0])),
        result: RuntimeValue[] = [];
      this.budget.collection(source.length);
      let nodes = 1,
        chars = 2;
      for (let i = 0; i < source.length; i++) {
        this.budget.step();
        const scope = {
          ...locals,
          [expression.as!]: source[i],
          ...(expression.index ? { [expression.index]: i } : {}),
        };
        const computed = this.evaluate(expression.args[1], scope, depth + 1);
        if (op === 'filter' && !booleanValue(computed)) continue;
        const value = op === 'map' ? computed : source[i],
          size = inspectRuntimeValue(value, this.budget);
        nodes += size.nodes;
        chars += size.chars + 1;
        if (nodes > this.budget.limits.maxValueNodes) evaluationFail('PROMPT_VALUE_LIMIT');
        this.budget.textLength(chars);
        result.push(value);
      }
      return result;
    }
    const args = expression.args.map(read),
      a = args[0],
      b = args[1];
    const finite = (value: number): number =>
      Number.isFinite(value) ? value : evaluationFail('PROMPT_NONFINITE_RESULT');
    switch (op) {
      case 'not':
        return !truth(a);
      case 'equal':
        return this.display(a) === this.display(b);
      case 'notEqual':
        return this.display(a) !== this.display(b);
      case 'greater':
        return Number(this.display(a)) > Number(this.display(b));
      case 'greaterEqual':
        return Number(this.display(a)) >= Number(this.display(b));
      case 'length':
        return this.display(a).length;
      case 'replace': {
        const source = this.display(a),
          find = this.display(b),
          replacement = this.display(args[2]);
        let literals = 0,
          matches = 0,
          prefixes = 0,
          suffixes = 0;
        for (let i = 0; i < replacement.length; i++) {
          if (i % 256 === 0) this.budget.step();
          if (replacement[i] === '$' && i + 1 < replacement.length) {
            const next = replacement[i + 1];
            if (next === '$') {
              literals++;
              i++;
              continue;
            }
            if (next === '&') {
              matches++;
              i++;
              continue;
            }
            if (next === '`') {
              prefixes++;
              i++;
              continue;
            }
            if (next === "'") {
              suffixes++;
              i++;
              continue;
            }
          }
          literals++;
        }
        let size = source.length,
          cursor = 0,
          iterations = 0;
        for (;;) {
          if (iterations++ % 128 === 0) this.budget.step();
          const at = find ? source.indexOf(find, cursor) : cursor;
          if (at < 0 || at > source.length) break;
          size +=
            literals +
            matches * find.length +
            prefixes * at +
            suffixes * (source.length - at - find.length) -
            find.length;
          this.budget.textLength(size);
          cursor = at + (find.length || 1);
        }
        return source.replaceAll(find, replacement);
      }
      case 'add':
        return finite(numberValue(a) + numberValue(b));
      case 'subtract':
        return finite(numberValue(a) - numberValue(b));
      case 'multiply':
        return finite(numberValue(a) * numberValue(b));
      case 'divide':
        if (numberValue(b) === 0) evaluationFail('PROMPT_DIVISION_BY_ZERO');
        return finite(numberValue(a) / numberValue(b));
      case 'mod':
        if (numberValue(b) === 0) evaluationFail('PROMPT_DIVISION_BY_ZERO');
        return finite(numberValue(a) % numberValue(b));
      case 'pow':
        return finite(numberValue(a) ** numberValue(b));
      case 'clamp': {
        const low = numberValue(b),
          high = numberValue(args[2]);
        if (low > high) evaluationFail('PROMPT_INVALID_RANGE');
        return Math.min(high, Math.max(low, numberValue(a)));
      }
      case 'round': {
        const digits = args.length === 1 ? 0 : integerValue(b);
        if (digits < 0 || digits > 12) evaluationFail('PROMPT_INVALID_PRECISION');
        const scale = 10 ** digits;
        return finite(Math.round(numberValue(a) * scale) / scale);
      }
      case 'floor':
        return Math.floor(numberValue(a));
      case 'ceil':
        return Math.ceil(numberValue(a));
      case 'abs':
        return Math.abs(numberValue(a));
      case 'gt':
        return numberValue(a) > numberValue(b);
      case 'gte':
        return numberValue(a) >= numberValue(b);
      case 'lt':
        return numberValue(a) < numberValue(b);
      case 'lte':
        return numberValue(a) <= numberValue(b);
      case 'min':
      case 'max':
      case 'sum':
      case 'average': {
        const items = args.length === 1 && Array.isArray(a) ? a : args;
        this.budget.collection(items.length);
        let total = 0,
          smallest = Infinity,
          largest = -Infinity;
        for (const item of items) {
          this.budget.step();
          const n = numberValue(item);
          if (op === 'sum' || op === 'average')
            total = finite(total + (op === 'average' ? n / items.length : n));
          smallest = Math.min(smallest, n);
          largest = Math.max(largest, n);
        }
        if (op === 'sum') return total;
        if (!items.length) return null;
        return op === 'average' ? total : op === 'min' ? smallest : largest;
      }
      case 'contains':
        return stringValue(a).includes(stringValue(b));
      case 'startsWith':
        return stringValue(a).startsWith(stringValue(b));
      case 'endsWith':
        return stringValue(a).endsWith(stringValue(b));
      case 'trim':
        return stringValue(a).trim();
      case 'lower':
      case 'upper': {
        const source = stringValue(a);
        let length = 0,
          index = 0;
        for (const character of source) {
          if (index++ % 128 === 0) this.budget.step();
          length += (op === 'lower' ? character.toLowerCase() : character.toUpperCase()).length;
          this.budget.textLength(length);
        }
        return op === 'lower' ? source.toLowerCase() : source.toUpperCase();
      }
      case 'split': {
        const source = stringValue(a),
          delimiter = stringValue(b),
          result: string[] = [];
        if (!delimiter) {
          this.budget.collection(source.length);
          return source.split('');
        }
        let cursor = 0;
        for (;;) {
          this.budget.step();
          this.budget.collection(result.length + 1);
          const at = source.indexOf(delimiter, cursor);
          if (at < 0) {
            result.push(source.slice(cursor));
            break;
          }
          result.push(source.slice(cursor, at));
          cursor = at + delimiter.length;
        }
        return this.bounded(result);
      }
      case 'join': {
        const items = arrayValue(a),
          separator = stringValue(b);
        let size = 0;
        for (const item of items) {
          this.budget.step();
          size += stringValue(item).length;
        }
        size += Math.max(0, items.length - 1) * separator.length;
        this.budget.textLength(size);
        return items.join(separator);
      }
      case 'get':
        return this.get(a, b);
      case 'append': {
        const items = arrayValue(a);
        this.budget.collection(items.length + 1);
        return this.bounded([...items, b]);
      }
      case 'concatArrays': {
        const arrays = args.map(arrayValue);
        let length = 0;
        for (const items of arrays) {
          this.budget.step();
          length += items.length;
          this.budget.collection(length);
        }
        return this.bounded(arrays.flat());
      }
      case 'setAt': {
        const items = arrayValue(a),
          index = integerValue(b);
        if (index < 0 || index >= items.length) evaluationFail('PROMPT_INVALID_INDEX');
        const result = items.slice();
        result[index] = args[2];
        return this.bounded(result);
      }
      case 'merge': {
        if (!isObject(a) || !isObject(b)) evaluationFail('PROMPT_RECORD_REQUIRED');
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        this.budget.collection(keys.size);
        return this.bounded({ ...a, ...b });
      }
      case 'size':
        return typeof a === 'string' || Array.isArray(a)
          ? a.length
          : a !== null && typeof a === 'object'
            ? Object.keys(a).length
            : evaluationFail('PROMPT_COLLECTION_REQUIRED');
      case 'slice': {
        const from = integerValue(b),
          to = args.length === 3 ? integerValue(args[2]) : undefined;
        if (typeof a === 'string') return a.slice(from, to);
        return arrayValue(a).slice(from, to);
      }
      case 'range': {
        const start = args.length === 1 ? 0 : numberValue(a),
          end = args.length === 1 ? numberValue(a) : numberValue(b),
          step = args.length === 3 ? numberValue(args[2]) : 1;
        if (step === 0) evaluationFail('PROMPT_INVALID_RANGE');
        const size = Math.max(0, Math.ceil((end - start) / step));
        this.budget.collection(size);
        const result: number[] = [];
        for (let i = 0; i < size; i++) {
          this.budget.step();
          result.push(finite(start + i * step));
        }
        return result;
      }
      case 'unique': {
        const result: RuntimeValue[] = [],
          seen = new Set<string>();
        let chars = 0;
        for (const item of arrayValue(a)) {
          this.budget.step();
          const key = this.canonical(item);
          if (!seen.has(key)) {
            chars += key.length;
            this.budget.textLength(chars);
            seen.add(key);
            result.push(item);
          }
        }
        return result;
      }
      case 'exists':
        return a !== null;
      case 'typedEqual':
        return this.canonical(a) === this.canonical(b);
      case 'array':
        return this.bounded(args);
      case 'object': {
        const entries: [string, RuntimeValue][] = [];
        const keys = new Set<string>();
        for (let i = 0; i < args.length; i += 2) {
          const key = stringValue(args[i]);
          if (UNSAFE_PROMPT_KEYS.has(key)) evaluationFail('PROMPT_UNSAFE_PATH');
          if (keys.has(key)) evaluationFail('PROMPT_DUPLICATE_KEY');
          keys.add(key);
          entries.push([key, args[i + 1]]);
        }
        return this.bounded(Object.fromEntries(entries));
      }
      case 'datePart': {
        const date = dateValue(a);
        switch (stringValue(b)) {
          case 'year':
            return date.getUTCFullYear();
          case 'month':
            return date.getUTCMonth() + 1;
          case 'day':
            return date.getUTCDate();
          case 'weekday':
            return date.getUTCDay();
          case 'hour':
            return date.getUTCHours();
          case 'minute':
            return date.getUTCMinutes();
          default:
            return evaluationFail('PROMPT_INVALID_DATE_PART');
        }
      }
      case 'dateAddDays': {
        const date = dateValue(a),
          days = integerValue(b);
        if (Math.abs(days) > 365_000) evaluationFail('PROMPT_DATE_RANGE');
        date.setUTCDate(date.getUTCDate() + days);
        if (
          !Number.isFinite(date.getTime()) ||
          date.getUTCFullYear() < 0 ||
          date.getUTCFullYear() > 9999
        )
          evaluationFail('PROMPT_DATE_RANGE');
        return date.toISOString();
      }
      case 'dateFormat': {
        const iso = dateValue(a).toISOString();
        switch (stringValue(b)) {
          case 'date':
            return iso.slice(0, 10);
          case 'time':
            return iso.slice(11, 19);
          case 'iso':
            return iso;
          default:
            return evaluationFail('PROMPT_INVALID_DATE_FORMAT');
        }
      }
    }
  }
  render(
    nodes: PromptTemplate,
    slots: Record<string, string>,
    locals = this.locals,
    depth = 0
  ): string {
    if (depth > 32) evaluationFail('PROMPT_NESTING_LIMIT');
    const parts: string[] = [];
    let length = 0;
    const append = (text: string) => {
      length += text.length;
      this.budget.textLength(length, true);
      parts.push(text);
    };
    for (const node of nodes) {
      this.budget.step();
      if (node.kind === 'text') append(node.text);
      else if (node.kind === 'value') append(this.display(this.evaluate(node.expression, locals)));
      else if (node.kind === 'slot') {
        if (!Object.hasOwn(slots, node.name))
          throw new PromptProgramError('PROMPT_UNKNOWN_SLOT', undefined, node.name);
        if (slots[node.name].length) this.usedSlots.add(node.name);
        append(slots[node.name]);
      } else if (node.kind === 'if') {
        let value = this.render(
          truth(this.evaluate(node.condition, locals)) ? node.then : (node.else ?? []),
          slots,
          locals,
          depth + 1
        );
        if (node.trimLines) {
          const lines = value.split('\n');
          let from = 0,
            to = lines.length;
          while (from < to && lines[from].trim() === '') from++;
          while (to > from && lines[to - 1].trim() === '') to--;
          value = lines.slice(from, to).join('\n');
        }
        append(value);
      } else if (node.kind === 'let')
        append(
          this.render(
            node.body,
            slots,
            { ...locals, [node.name]: this.evaluate(node.value, locals) },
            depth + 1
          )
        );
      else {
        const source = arrayValue(this.evaluate(node.source, locals));
        this.budget.collection(source.length);
        if (!source.length && node.else) append(this.render(node.else, slots, locals, depth + 1));
        for (let i = 0; i < source.length; i++) {
          this.budget.step();
          append(
            this.render(
              node.body,
              slots,
              { ...locals, [node.as]: source[i], ...(node.index ? { [node.index]: i } : {}) },
              depth + 1
            )
          );
        }
      }
    }
    return parts.join('');
  }
}
export function evaluatePromptExpression(
  value: PromptExpression,
  values: Record<string, PromptValue> = {},
  options: PromptEvaluationOptions = {}
): RuntimeValue {
  inspectAst(value);
  expression(value, null, 0, new Set(Object.keys(options.locals ?? {})));
  const evaluator = new PromptEvaluator(values, options),
    result = evaluator.evaluate(value);
  inspectRuntimeValue(result, evaluator.budget);
  return structuredClone(result);
}
/** One evaluation budget and one aggregate result bound for an entire host action. */
export function evaluatePromptExpressions(
  expressions: PromptExpression[],
  values: Record<string, PromptValue> = {},
  options: PromptEvaluationOptions = {}
): RuntimeValue[] {
  const evaluator = new PromptEvaluator(values, options);
  if (!Array.isArray(expressions)) evaluationFail('PROMPT_INVALID_EXPRESSIONS');
  evaluator.budget.collection(expressions.length);
  inspectAst(expressions);
  const locals = new Set(Object.keys(options.locals ?? {}));
  for (const value of expressions) {
    evaluator.budget.step();
    expression(value, null, 0, locals);
  }
  const results: RuntimeValue[] = [];
  let nodes = 1,
    chars = 2;
  for (const value of expressions) {
    const result = evaluator.evaluate(value),
      size = inspectRuntimeValue(result, evaluator.budget);
    nodes += size.nodes;
    chars += size.chars + 1;
    if (nodes > evaluator.budget.limits.maxValueNodes) evaluationFail('PROMPT_VALUE_LIMIT');
    evaluator.budget.textLength(chars);
    results.push(result);
  }
  evaluator.budget.step();
  return structuredClone(results);
}
/** UI visibility only. Hidden controls retain their resolved values and runtime effects. */
export function visiblePromptControls(
  controls: PromptControl[],
  values: Record<string, PromptValue> = {},
  options: PromptEvaluationOptions = {}
): PromptControl[] {
  const program = validatePromptProgram({ version: 1, controls, blocks: [] });
  const resolved = resolvePromptValues(program, values);
  const visible = evaluatePromptExpressions(
    program.controls.map((control) =>
      control.visibleWhen === undefined ? true : control.visibleWhen
    ),
    resolved,
    options
  );
  return program.controls.filter((_, index) => truth(visible[index]));
}
export function renderPromptTemplate(
  nodes: PromptTemplate,
  values: Record<string, PromptValue> = {},
  slots: Record<string, string> = {},
  options: PromptEvaluationOptions = {}
): string {
  inspectAst(nodes);
  template(nodes, new Set(Object.keys(values)), 0, new Set(Object.keys(options.locals ?? {})));
  return new PromptEvaluator(values, options).render(nodes, slots);
}
/** History includes the current user turn. Slices are half-open with clamped negative offsets. */
export function compilePromptProgram(
  program: PromptProgram,
  context: {
    values?: Record<string, PromptValue>;
    slots: Record<string, string>;
    history: PromptHistoryMessage[];
    runtime?: Record<string, RuntimeValue>;
    limits?: PromptEvaluationLimits;
  }
): PromptCompilation {
  validatePromptProgram(program);
  const values = resolvePromptValues(program, context.values);
  const messages: LogicalMessage[] = [];
  const cachePlan: PromptCacheAnchor[] = [];
  const trace: PromptCompilation['trace'] = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  for (const item of context.history)
    if (
      item.sourceKind !== undefined &&
      (item.sourceKind !== 'authored-start' || item.role !== 'assistant' || item.current)
    )
      fail('PROMPT_INVALID_HISTORY_SOURCE');
  const evaluator = new PromptEvaluator(values, {
    runtime: context.runtime,
    limits: context.limits,
  });
  const submission = program.execution?.storySubmission;
  const execution =
    submission === undefined
      ? undefined
      : {
          storySubmission:
            submission.when === undefined || truth(evaluator.evaluate(submission.when)),
        };
  const appendHistory = (item: PromptHistoryMessage, blockId: string) => {
    if (used.has(item.id)) fail('PROMPT_DUPLICATE_HISTORY', blockId);
    evaluator.claimOutput(item.text.length);
    used.add(item.id);
    messages.push({
      id: `${blockId}:${item.id}`,
      role: item.role,
      content: [{ type: 'text', text: item.text }],
      completion: 'complete',
      provenance: {
        blockId,
        origin: item.current ? 'current' : 'history',
        ...(item.sourceRevision ? { sourceRevision: item.sourceRevision } : {}),
        ...(item.sourceHash ? { sourceHash: item.sourceHash } : {}),
        ...(item.runId ? { runId: item.runId } : {}),
      },
    });
  };
  for (const block of program.blocks) {
    evaluator.budget.step();
    const start = messages.length;
    const included =
      block.enabled !== false &&
      (block.when === undefined || truth(evaluator.evaluate(block.when)));
    if (!included) {
      trace.push({
        blockId: block.id,
        included: false,
        messageIds: [],
        reason: block.enabled === false ? 'disabled' : 'condition',
      });
      continue;
    }
    if (block.kind === 'message' || block.kind === 'slot') {
      if (block.kind === 'slot' && !Object.hasOwn(context.slots, block.slot))
        throw new PromptProgramError('PROMPT_UNKNOWN_SLOT', block.id, block.slot);
      const slot = block.kind === 'slot' ? context.slots[block.slot] : '';
      const render = (nodes: PromptTemplate, slots: Record<string, string>) => {
        try {
          return evaluator.render(nodes, slots);
        } catch (error) {
          if (error instanceof PromptProgramError && error.code === 'PROMPT_UNKNOWN_SLOT')
            throw new PromptProgramError(error.code, block.id, error.slotName);
          throw error;
        }
      };
      const text =
        block.kind === 'message'
          ? render(block.template, context.slots)
          : slot.length
            ? block.template
              ? render(block.template, { ...context.slots, slot })
              : slot
            : '';
      if (
        block.kind === 'slot' &&
        text.length &&
        (!block.template || evaluator.usedSlots.has('slot'))
      )
        evaluator.usedSlots.add(block.slot);
      evaluator.usedSlots.delete('slot');
      evaluator.claimOutput(text.length);
      if (text.length)
        messages.push({
          id: block.id,
          role: block.role,
          content: [{ type: 'text', text }],
          completion: block.kind === 'message' ? (block.completion ?? 'complete') : 'complete',
          provenance: { blockId: block.id, origin: 'prompt' },
        });
    } else if (block.kind === 'history') {
      const size = context.history.length;
      const offset = (n: number) => Math.min(size, Math.max(0, n < 0 ? size + n : n));
      const from = offset(block.from),
        to = block.to === 'end' ? size : offset(block.to);
      if (from > to) fail('PROMPT_REVERSED_HISTORY', block.id);
      context.history.slice(from, to).forEach((item) => {
        appendHistory(item, block.id);
      });
    } else if (block.kind === 'current')
      context.history
        .filter((h) => h.current)
        .forEach((item) => {
          appendHistory(item, block.id);
        });
    else {
      const anchors = messages
        .filter((m) => block.role === 'all' || m.role === block.role)
        .slice(-block.depth);
      if (!anchors.length) {
        if (block.policy === 'require') fail('PROMPT_EMPTY_CACHE_ANCHOR', block.id);
        warnings.push(`PROMPT_EMPTY_CACHE_ANCHOR (${block.id})`);
      }
      anchors.forEach((m) => {
        cachePlan.push({ blockId: block.id, afterMessageId: m.id, policy: block.policy });
      });
    }
    trace.push({
      blockId: block.id,
      included: true,
      messageIds: messages.slice(start).map((m) => m.id),
    });
  }
  if (context.history.filter((h) => h.current).length !== 1) fail('PROMPT_CURRENT_INPUT_REQUIRED');
  if (context.history.some((h) => !used.has(h.id))) fail('PROMPT_HISTORY_OMITTED');
  if (messages.some((m, i) => m.completion === 'prefill' && i !== messages.length - 1))
    fail('PROMPT_PREFILL_MUST_BE_LAST');
  inspectAst(messages, 1_500_000);
  if (messages.length > 1000 || JSON.stringify(messages).length > 1_500_000)
    fail('PROMPT_COMPILED_LIMIT');
  return {
    usedSlots: [...evaluator.usedSlots],
    ...(execution ? { execution } : {}),
    compilerVersion: 'uimori-prompt-1',
    values,
    messages,
    cachePlan,
    trace,
    historyScope: 'm2-recent-or-full',
    warnings,
  };
}
