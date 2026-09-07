import {
  evaluatePromptExpression,
  evaluatePromptExpressions,
  validatePromptExpression,
  type PromptExpression,
  type RuntimeValue,
} from './prompt-program.js';
import { inspectRuntimeValue, PromptBudget } from './prompt-values.js';

export type BehaviorSchema = (
  | { type: 'number'; min: number; max: number; integer?: boolean }
  | { type: 'string'; maxLength: number }
  | { type: 'boolean' }
  | { type: 'enum'; values: (string | number | boolean)[] }
  | { type: 'list'; items: BehaviorSchema; maxItems: number }
  | { type: 'record'; properties: Record<string, BehaviorSchema> }
) & { label?: string; description?: string };
export type BehaviorEffect = { path: string[]; value: PromptExpression };
export type BehaviorDraw = { id: string } & (
  | { type: 'integer'; min: number; max: number }
  | { type: 'choice' | 'shuffle'; values: RuntimeValue[] }
);
export type BehaviorActionTrigger = 'user' | 'before-turn' | 'model';
export interface BehaviorAction {
  id: string;
  label?: string;
  description?: string;
  inputSchema: BehaviorSchema;
  /** Omitted actions remain explicit user actions. An empty list disables every entry point. */
  triggers?: BehaviorActionTrigger[];
  automaticInput?: RuntimeValue;
  when?: PromptExpression;
  draws?: BehaviorDraw[];
  effects: BehaviorEffect[];
  /** A bounded projection for callers; nextState is available only here. */
  result?: PromptExpression;
  /** Explicit user action proposal. The host reserves the resulting text for one future Run. */
  nextRequest?: PromptExpression;
}
export interface BehaviorOutputParser {
  id: string;
  required?: boolean;
  when?: PromptExpression;
  format: 'json' | 'delimited';
  start?: string;
  end?: string;
  delimiter?: string;
  fields: {
    path: string[];
    from: string[];
    valueType?: 'string' | 'number' | 'boolean' | 'json';
  }[];
}
export interface PackageBehavior {
  revision: number;
  schemaVersion: number;
  mode?: 'annotation' | 'authoritative';
  stateSchema: BehaviorSchema;
  initialState: RuntimeValue;
  actions: BehaviorAction[];
  outputParsers: BehaviorOutputParser[];
}
export class BehaviorError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}
export const BEHAVIOR_RESULT_MAX_CHARS = 8_000;
function bad(message: string): never {
  throw new BehaviorError(400, message);
}
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function behaviorRecord(value: unknown): Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    bad('BEHAVIOR_EXPECTED_RECORD');
  if (Object.getOwnPropertySymbols(value).length) bad('BEHAVIOR_UNSAFE_KEY');
  for (const key of Object.getOwnPropertyNames(value)) {
    if (forbidden.has(key)) bad('BEHAVIOR_UNSAFE_KEY');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) bad('BEHAVIOR_ACCESSOR');
  }
  return value as Record<string, any>;
}
function keys(value: unknown, allowed: string[]) {
  const r = behaviorRecord(value);
  if (Object.keys(r).some((k) => !allowed.includes(k))) bad('BEHAVIOR_UNKNOWN_FIELD');
  return r;
}
function schemaKeys(value: unknown, allowed: string[]) {
  return keys(value, [...allowed, 'label', 'description']);
}
function boundedInt(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) bad('BEHAVIOR_INTEGER_LIMIT');
}
function identifier(v: unknown) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u.test(v) || forbidden.has(v))
    bad('BEHAVIOR_INVALID_ID');
}
export function validateBehaviorPath(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 12) bad('BEHAVIOR_INVALID_PATH');
  for (const part of value) identifier(part);
  return value as string[];
}
export function validateBehaviorSchema(value: unknown, depth = 0): BehaviorSchema {
  if (depth > 10) bad('BEHAVIOR_SCHEMA_DEPTH');
  const r = behaviorRecord(value);
  for (const text of [r.label, r.description])
    if (text !== undefined && (typeof text !== 'string' || text.length > 2000))
      bad('BEHAVIOR_SCHEMA_TEXT');
  switch (r.type) {
    case 'number':
      schemaKeys(r, ['type', 'min', 'max', 'integer']);
      if (
        !Number.isFinite(r.min) ||
        !Number.isFinite(r.max) ||
        r.min > r.max ||
        (r.integer !== undefined && typeof r.integer !== 'boolean')
      )
        bad('BEHAVIOR_NUMBER_SCHEMA');
      break;
    case 'string':
      schemaKeys(r, ['type', 'maxLength']);
      boundedInt(r.maxLength, 0, 100_000);
      break;
    case 'boolean':
      schemaKeys(r, ['type']);
      break;
    case 'enum':
      schemaKeys(r, ['type', 'values']);
      if (
        !Array.isArray(r.values) ||
        !r.values.length ||
        r.values.length > 100 ||
        r.values.some(
          (v: unknown) =>
            !['string', 'number', 'boolean'].includes(typeof v) ||
            (typeof v === 'number' && !Number.isFinite(v))
        ) ||
        new Set(r.values).size !== r.values.length
      )
        bad('BEHAVIOR_ENUM_SCHEMA');
      break;
    case 'list':
      schemaKeys(r, ['type', 'items', 'maxItems']);
      boundedInt(r.maxItems, 0, 1000);
      validateBehaviorSchema(r.items, depth + 1);
      break;
    case 'record':
      schemaKeys(r, ['type', 'properties']);
      behaviorRecord(r.properties);
      if (Object.keys(r.properties).length > 200) bad('BEHAVIOR_RECORD_LIMIT');
      for (const [key, child] of Object.entries(r.properties)) {
        identifier(key);
        validateBehaviorSchema(child, depth + 1);
      }
      break;
    default:
      bad('BEHAVIOR_SCHEMA_TYPE');
  }
  return structuredClone(r) as BehaviorSchema;
}
export function validateBehaviorValue(
  schema: BehaviorSchema,
  value: unknown,
  depth = 0
): RuntimeValue {
  if (depth > 12) bad('BEHAVIOR_VALUE_DEPTH');
  switch (schema.type) {
    case 'number':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < schema.min ||
        value > schema.max ||
        (schema.integer && !Number.isSafeInteger(value))
      )
        bad('BEHAVIOR_NUMBER_VALUE');
      break;
    case 'string':
      if (typeof value !== 'string' || value.length > schema.maxLength)
        bad('BEHAVIOR_STRING_VALUE');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') bad('BEHAVIOR_BOOLEAN_VALUE');
      break;
    case 'enum':
      if (!schema.values.includes(value as any)) bad('BEHAVIOR_ENUM_VALUE');
      break;
    case 'list':
      if (!Array.isArray(value) || value.length > schema.maxItems) bad('BEHAVIOR_LIST_VALUE');
      for (const item of value as unknown[]) validateBehaviorValue(schema.items, item, depth + 1);
      break;
    case 'record': {
      const r = behaviorRecord(value);
      if (Object.keys(r).length !== Object.keys(schema.properties).length)
        bad('BEHAVIOR_RECORD_FIELDS');
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(r, key)) bad('BEHAVIOR_MISSING_FIELD');
        validateBehaviorValue(child, r[key], depth + 1);
      }
      break;
    }
  }
  if (JSON.stringify(value).length > 250_000) bad('BEHAVIOR_VALUE_SIZE');
  return structuredClone(value) as RuntimeValue;
}
function atSchema(schema: BehaviorSchema, path: string[]): BehaviorSchema {
  let current = schema;
  for (const key of path) {
    if (current.type === 'record' && Object.hasOwn(current.properties, key))
      current = current.properties[key];
    else bad('BEHAVIOR_UNKNOWN_STATE_PATH');
  }
  return current;
}
function uniqueIds(items: { id: string }[]) {
  const seen = new Set<string>();
  for (const item of items) {
    identifier(item.id);
    if (seen.has(item.id)) bad('BEHAVIOR_DUPLICATE_ID');
    seen.add(item.id);
  }
}
function pathsDisjoint(paths: string[][]) {
  const text = paths.map((p) => p.join('/'));
  for (let i = 0; i < text.length; i++)
    for (let j = i + 1; j < text.length; j++)
      if (
        text[i] === text[j] ||
        text[i].startsWith(text[j] + '/') ||
        text[j].startsWith(text[i] + '/')
      )
        bad('BEHAVIOR_OVERLAPPING_EFFECTS');
}
export function behaviorActionTriggers(action: BehaviorAction): BehaviorActionTrigger[] {
  return action.triggers === undefined ? ['user'] : [...action.triggers];
}
export function validatePackageBehavior(value: unknown): PackageBehavior {
  const b = keys(value, [
    'revision',
    'schemaVersion',
    'mode',
    'stateSchema',
    'initialState',
    'actions',
    'outputParsers',
  ]);
  inspectRuntimeValue(b);
  if (b.mode !== undefined && !['annotation', 'authoritative'].includes(b.mode))
    bad('BEHAVIOR_MODE');
  boundedInt(b.revision, 1, 1_000_000);
  boundedInt(b.schemaVersion, 1, 1_000_000);
  validateBehaviorSchema(b.stateSchema);
  if (b.stateSchema.type !== 'record') bad('BEHAVIOR_STATE_ROOT');
  validateBehaviorValue(b.stateSchema, b.initialState);
  if (
    !Array.isArray(b.actions) ||
    b.actions.length > 100 ||
    !Array.isArray(b.outputParsers) ||
    b.outputParsers.length > 30
  )
    bad('BEHAVIOR_COLLECTION_LIMIT');
  uniqueIds(b.actions);
  uniqueIds(b.outputParsers);
  for (const a of b.actions) {
    keys(a, [
      'id',
      'label',
      'description',
      'inputSchema',
      'triggers',
      'automaticInput',
      'when',
      'draws',
      'effects',
      'result',
      'nextRequest',
    ]);
    for (const text of [a.label, a.description])
      if (text !== undefined && (typeof text !== 'string' || text.length > 2000))
        bad('BEHAVIOR_ACTION_TEXT');
    validateBehaviorSchema(a.inputSchema);
    if (a.when !== undefined) validatePromptExpression(a.when);
    if (
      a.triggers !== undefined &&
      (!Array.isArray(a.triggers) ||
        a.triggers.length > 3 ||
        a.triggers.some((v: unknown) => !['user', 'before-turn', 'model'].includes(v as string)) ||
        new Set(a.triggers).size !== a.triggers.length)
    )
      bad('BEHAVIOR_ACTION_TRIGGERS');
    const triggers = behaviorActionTriggers(a);
    if (a.nextRequest !== undefined) {
      validatePromptExpression(a.nextRequest);
      if (triggers.length !== 1 || triggers[0] !== 'user')
        bad('BEHAVIOR_REQUEST_REQUIRES_USER_ACTION');
    }
    if (triggers.includes('model') && a.inputSchema.type !== 'record')
      bad('BEHAVIOR_MODEL_INPUT_ROOT');
    if (Object.hasOwn(a, 'automaticInput') && !triggers.includes('before-turn'))
      bad('BEHAVIOR_AUTOMATIC_INPUT_TRIGGER');
    if (triggers.includes('before-turn'))
      validateBehaviorValue(
        a.inputSchema,
        Object.hasOwn(a, 'automaticInput') ? a.automaticInput : {}
      );
    if (a.result !== undefined) validatePromptExpression(a.result);
    if (!Array.isArray(a.effects) || a.effects.length > 100) bad('BEHAVIOR_EFFECT_LIMIT');
    for (const e of a.effects) {
      keys(e, ['path', 'value']);
      atSchema(b.stateSchema, validateBehaviorPath(e.path));
      validatePromptExpression(e.value);
    }
    pathsDisjoint(a.effects.map((e: BehaviorEffect) => e.path));
    if (a.draws !== undefined) {
      if (!Array.isArray(a.draws) || a.draws.length > 50) bad('BEHAVIOR_DRAW_LIMIT');
      uniqueIds(a.draws);
      for (const d of a.draws) {
        if (d.type === 'integer') {
          keys(d, ['id', 'type', 'min', 'max']);
          boundedInt(d.min, -1_000_000_000, 1_000_000_000);
          boundedInt(d.max, d.min, 1_000_000_000);
        } else if (d.type === 'choice' || d.type === 'shuffle') {
          keys(d, ['id', 'type', 'values']);
          if (
            !Array.isArray(d.values) ||
            !d.values.length ||
            d.values.length > 1000 ||
            JSON.stringify(d.values).length > 100_000
          )
            bad('BEHAVIOR_DRAW_VALUES');
          inspectData(d.values);
        } else bad('BEHAVIOR_DRAW_TYPE');
      }
    }
  }
  for (const p of b.outputParsers) {
    keys(p, ['id', 'required', 'when', 'format', 'start', 'end', 'delimiter', 'fields']);
    if (p.required !== undefined && typeof p.required !== 'boolean')
      bad('BEHAVIOR_PARSER_REQUIRED');
    if (p.when !== undefined) validatePromptExpression(p.when);
    if (!['json', 'delimited'].includes(p.format)) bad('BEHAVIOR_PARSER_FORMAT');
    for (const marker of [p.start, p.end, p.delimiter])
      if (
        marker !== undefined &&
        (typeof marker !== 'string' || !marker.length || marker.length > 200)
      )
        bad('BEHAVIOR_PARSER_MARKER');
    if (
      (p.start === undefined) !== (p.end === undefined) ||
      (p.format === 'delimited' && !p.delimiter)
    )
      bad('BEHAVIOR_PARSER_MARKER');
    if (!Array.isArray(p.fields) || !p.fields.length || p.fields.length > 100)
      bad('BEHAVIOR_PARSER_FIELDS');
    for (const f of p.fields) {
      keys(f, ['path', 'from', 'valueType']);
      atSchema(b.stateSchema, validateBehaviorPath(f.path));
      validateBehaviorPath(f.from);
      if (
        f.valueType !== undefined &&
        !['string', 'number', 'boolean', 'json'].includes(f.valueType)
      )
        bad('BEHAVIOR_PARSER_VALUE_TYPE');
    }
    pathsDisjoint(p.fields.map((f: { path: string[] }) => f.path));
  }
  return structuredClone(b) as PackageBehavior;
}
function inspectData(value: unknown, depth = 0): void {
  if (depth > 12) bad('BEHAVIOR_DATA_DEPTH');
  if (Array.isArray(value)) {
    for (const item of value) inspectData(item, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(behaviorRecord(value))) inspectData(item, depth + 1);
  } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null)
    bad('BEHAVIOR_DATA_VALUE');
  else if (typeof value === 'number' && !Number.isFinite(value)) bad('BEHAVIOR_DATA_VALUE');
}
export function behaviorActionAllowed(
  action: BehaviorAction,
  state: RuntimeValue,
  input: RuntimeValue,
  hostRuntime: Record<string, RuntimeValue> = {}
): boolean {
  validateBehaviorValue(action.inputSchema, input);
  if (action.when === undefined) return true;
  const result = evaluatePromptExpression(
    action.when,
    {},
    { runtime: { ...hostRuntime, state, input, draws: {}, nextState: null } }
  );
  if (typeof result !== 'boolean') bad('BEHAVIOR_CONDITION_NOT_BOOLEAN');
  return result;
}
export function applyBehaviorEffects(
  behavior: PackageBehavior,
  state: RuntimeValue,
  input: RuntimeValue,
  draws: Record<string, RuntimeValue>,
  effects: BehaviorEffect[],
  hostRuntime: Record<string, RuntimeValue> = {}
): RuntimeValue {
  const next = structuredClone(state);
  const values = evaluatePromptExpressions(
    effects.map((effect) => effect.value),
    {},
    { runtime: { ...hostRuntime, state, input, draws } }
  );
  effects.forEach((effect, index) => {
    setPath(next, effect.path, values[index]);
  });
  return validateBehaviorValue(behavior.stateSchema, next);
}
/** Deterministic calculation only. The host owns authorization, opportunity IDs, draws and persistence. */
export function evaluateBehaviorAction(
  behavior: PackageBehavior,
  action: BehaviorAction,
  state: RuntimeValue,
  input: RuntimeValue,
  draws: Record<string, RuntimeValue>,
  hostRuntime: Record<string, RuntimeValue> = {}
): { state: RuntimeValue; result: RuntimeValue } {
  const budget = new PromptBudget();
  behaviorRecord(hostRuntime);
  behaviorRecord(draws);
  inspectRuntimeValue({ hostRuntime, state, input, draws }, budget);
  const before = validateBehaviorValue(behavior.stateSchema, state),
    actionInput = validateBehaviorValue(action.inputSchema, input);
  const runtime = { ...hostRuntime, state: before, input: actionInput, draws, nextState: null };
  if (action.when !== undefined) {
    const allowed = evaluatePromptExpression(
      action.when,
      {},
      { runtime: { ...runtime, draws: {} }, budget }
    );
    if (typeof allowed !== 'boolean') bad('BEHAVIOR_CONDITION_NOT_BOOLEAN');
    if (!allowed) throw new BehaviorError(409, 'BEHAVIOR_ACTION_DISABLED');
  }
  const next = structuredClone(before);
  const values = evaluatePromptExpressions(
    action.effects.map((effect) => effect.value),
    {},
    { runtime, budget }
  );
  action.effects.forEach((effect, index) => {
    setPath(next, effect.path, values[index]);
  });
  const nextState = validateBehaviorValue(behavior.stateSchema, next);
  const result =
    action.result === undefined
      ? { applied: true, draws: structuredClone(draws) }
      : evaluatePromptExpression(action.result, {}, { runtime: { ...runtime, nextState }, budget });
  inspectRuntimeValue(result, budget);
  if (JSON.stringify(result).length > BEHAVIOR_RESULT_MAX_CHARS) bad('BEHAVIOR_RESULT_SIZE');
  budget.step();
  return { state: nextState, result };
}
function setPath(root: RuntimeValue, path: string[], value: RuntimeValue) {
  let at = behaviorRecord(root);
  for (const key of path.slice(0, -1)) at = behaviorRecord(at[key]);
  at[path.at(-1)!] = structuredClone(value);
}
export function parseBehaviorOutput(
  behavior: PackageBehavior,
  parser: BehaviorOutputParser,
  state: RuntimeValue,
  text: string
): RuntimeValue {
  if (typeof text !== 'string' || text.length > 500_000) bad('BEHAVIOR_OUTPUT_SIZE');
  let body = text;
  if (
    parser.required === false &&
    parser.start &&
    parser.end &&
    !text.includes(parser.start) &&
    !text.includes(parser.end)
  )
    return structuredClone(state);
  if (parser.start && parser.end) {
    const start = text.indexOf(parser.start);
    if (start < 0 || text.indexOf(parser.start, start + parser.start.length) >= 0)
      bad('BEHAVIOR_OUTPUT_MARKER');
    const end = text.indexOf(parser.end, start + parser.start.length);
    if (end < 0 || text.indexOf(parser.end, end + parser.end.length) >= 0)
      bad('BEHAVIOR_OUTPUT_MARKER');
    body = text.slice(start + parser.start.length, end);
  }
  let data: unknown;
  if (parser.format === 'json') {
    try {
      data = JSON.parse(body);
    } catch {
      bad('BEHAVIOR_OUTPUT_JSON');
    }
    inspectData(data);
  } else data = body.split(parser.delimiter!).map((v) => v.trim());
  const next = structuredClone(state);
  for (const field of parser.fields) {
    let value: any = data;
    for (const key of field.from) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
        bad('BEHAVIOR_OUTPUT_FIELD');
      value = value[key];
    }
    if (field.valueType === 'number') {
      if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim()))
        bad('BEHAVIOR_OUTPUT_NUMBER');
      value = Number(value);
    } else if (field.valueType === 'boolean') {
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (typeof value !== 'boolean') bad('BEHAVIOR_OUTPUT_BOOLEAN');
    } else if (field.valueType === 'json' && typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        bad('BEHAVIOR_OUTPUT_JSON');
      }
      inspectData(value);
    }
    validateBehaviorValue(atSchema(behavior.stateSchema, field.path), value);
    setPath(next, field.path, value);
  }
  return validateBehaviorValue(behavior.stateSchema, next);
}
