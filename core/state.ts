import { createHash } from 'node:crypto';

export type StateMode = 'annotation' | 'continuity' | 'authoritative';
export type StateValue = string | number | boolean;
export type StateValues = Record<string, StateValue>;
type FieldMeaning = { description?: string };
export type StateField = FieldMeaning &
  (
    | { type: 'number'; initial: number; min: number; max: number }
    | { type: 'text'; initial: string; maxLength: number }
    | { type: 'enum'; initial: string; values: string[] }
    | { type: 'boolean'; initial: boolean }
  );
export type StateModule = {
  id: string;
  revision: number;
  name: string;
  mode: StateMode;
  fields: Record<string, StateField>;
  /** This mapping is immutable within a module revision. Models select events, never deltas. */
  rules: Record<string, { field: string; delta: number }>;
};
export type StateSource = { revision: string; hash: string; text: string };
export type StateEvidence = { start: number; end: number; quote: string };
export type StateOperation =
  | { id: string; kind: 'set'; field: string; value: string | boolean; evidence: StateEvidence }
  | { id: string; kind: 'event'; event: string; evidence: StateEvidence };
export type StateProposal = {
  sourceRevision: string;
  sourceHash: string;
  moduleRevision: number;
  operations: StateOperation[];
};

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function fail(reason: string): never {
  throw new Error(`STATE_${reason}`);
}
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail('OBJECT_INVALID');
  const result = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(result)) {
    if (
      typeof key !== 'string' ||
      forbidden.has(key) ||
      !Object.getOwnPropertyDescriptor(result, key)?.enumerable ||
      !('value' in Object.getOwnPropertyDescriptor(result, key)!)
    )
      fail('KEY_INVALID');
  }
  return result;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail('FIELDS_INVALID');
}
function string(value: unknown, max = 1000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('STRING_INVALID');
}
function identifier(value: unknown): asserts value is string {
  string(value, 160);
  if (forbidden.has(value)) fail('KEY_INVALID');
}
function finite(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('NUMBER_INVALID');
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('REVISION_INVALID');
}
function fieldValue(field: StateField, value: unknown): asserts value is StateValue {
  switch (field.type) {
    case 'number':
      finite(value);
      if (value < field.min || value > field.max) fail('VALUE_OUT_OF_RANGE');
      break;
    case 'text':
      if (typeof value !== 'string' || value.length > field.maxLength) fail('TEXT_INVALID');
      break;
    case 'enum':
      if (typeof value !== 'string' || !field.values.includes(value)) fail('ENUM_INVALID');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('BOOLEAN_INVALID');
      break;
  }
}

/** Accept only serializable, allowlisted definitions; persistence assigns revision. */
export function validateStateModule(input: unknown): StateModule {
  const module = record(input);
  keys(module, ['id', 'revision', 'name', 'mode', 'fields', 'rules']);
  identifier(module.id);
  revision(module.revision);
  string(module.name);
  if (!['annotation', 'continuity', 'authoritative'].includes(module.mode as string))
    fail('MODE_INVALID');
  const fields = record(module.fields);
  const rules = record(module.rules);
  if (
    !Object.keys(fields).length ||
    Object.keys(fields).length > 100 ||
    Object.keys(rules).length > 500
  )
    fail('MODULE_SIZE_INVALID');
  for (const [name, raw] of Object.entries(fields)) {
    identifier(name);
    const field = record(raw);
    if (Object.hasOwn(field, 'description')) string(field.description, 4000);
    switch (field.type) {
      case 'number':
        keys(field, ['type', 'initial', 'min', 'max'], ['description']);
        finite(field.min);
        finite(field.max);
        if (field.min > field.max) fail('BOUNDS_INVALID');
        break;
      case 'text':
        keys(field, ['type', 'initial', 'maxLength'], ['description']);
        if (
          !Number.isSafeInteger(field.maxLength) ||
          (field.maxLength as number) < 1 ||
          (field.maxLength as number) > 100000
        )
          fail('TEXT_BOUND_INVALID');
        break;
      case 'enum':
        keys(field, ['type', 'initial', 'values'], ['description']);
        if (!Array.isArray(field.values) || !field.values.length || field.values.length > 100)
          fail('ENUM_INVALID');
        field.values.forEach((value) => {
          string(value);
        });
        if (new Set(field.values).size !== field.values.length) fail('ENUM_INVALID');
        break;
      case 'boolean':
        keys(field, ['type', 'initial'], ['description']);
        break;
      default:
        fail('FIELD_TYPE_INVALID');
    }
    fieldValue(field as StateField, field.initial);
  }
  for (const [name, raw] of Object.entries(rules)) {
    identifier(name);
    const rule = record(raw);
    keys(rule, ['field', 'delta']);
    identifier(rule.field);
    finite(rule.delta);
    if (
      !Object.hasOwn(fields, rule.field) ||
      (fields[rule.field] as StateField).type !== 'number' ||
      rule.delta === 0
    )
      fail('RULE_INVALID');
  }
  return structuredClone(module) as StateModule;
}

export function initialState(module: StateModule): StateValues {
  return Object.fromEntries(
    Object.entries(validateStateModule(module).fields).map(([name, field]) => [name, field.initial])
  );
}

export function validateStateValues(module: StateModule, input: unknown): StateValues {
  const checked = validateStateModule(module);
  const values = record(input);
  keys(values, Object.keys(checked.fields));
  for (const [name, field] of Object.entries(checked.fields)) fieldValue(field, values[name]);
  return { ...values } as StateValues;
}

function evidence(input: unknown, source: StateSource): StateEvidence {
  const span = record(input);
  keys(span, ['start', 'end', 'quote']);
  if (
    !Number.isSafeInteger(span.start) ||
    !Number.isSafeInteger(span.end) ||
    (span.start as number) < 0 ||
    (span.end as number) <= (span.start as number) ||
    (span.end as number) > source.text.length
  )
    fail('EVIDENCE_RANGE_INVALID');
  string(span.quote, source.text.length);
  // JavaScript offsets are UTF-16; do not accept a boundary inside a surrogate pair.
  const splitPair = (offset: number) =>
    offset > 0 &&
    /[\uD800-\uDBFF]/u.test(source.text[offset - 1]) &&
    /[\uDC00-\uDFFF]/u.test(source.text[offset] ?? '');
  if (
    splitPair(span.start as number) ||
    splitPair(span.end as number) ||
    source.text.slice(span.start as number, span.end as number) !== span.quote
  )
    fail('EVIDENCE_QUOTE_INVALID');
  return { ...span } as StateEvidence;
}

/** Evidence proves an exact source reference, not semantic truth of a model's interpretation. */
export function validateStateProposal(
  input: unknown,
  module: StateModule,
  source: StateSource
): StateProposal {
  const checked = validateStateModule(module);
  const rawSource = record(source);
  keys(rawSource, ['revision', 'hash', 'text']);
  identifier(source.revision);
  string(source.text, Number.MAX_SAFE_INTEGER);
  if (
    typeof source.hash !== 'string' ||
    createHash('sha256').update(source.text).digest('hex') !== source.hash
  )
    fail('SOURCE_IDENTITY_INVALID');
  const proposal = record(input);
  keys(proposal, ['sourceRevision', 'sourceHash', 'moduleRevision', 'operations']);
  if (proposal.sourceRevision !== source.revision || proposal.sourceHash !== source.hash)
    fail('SOURCE_MISMATCH');
  if (proposal.moduleRevision !== checked.revision) fail('RULE_REVISION_MISMATCH');
  if (!Array.isArray(proposal.operations) || proposal.operations.length > 500)
    fail('OPERATIONS_INVALID');
  const ids = new Set<string>();
  const numericEvidence = new Map<string, StateEvidence[]>();
  const assignedEvidence = new Set<string>();
  for (const raw of proposal.operations) {
    const op = record(raw);
    identifier(op.id);
    if (ids.has(op.id)) fail('DUPLICATE_OPERATION');
    ids.add(op.id);
    if (op.kind === 'set') {
      keys(op, ['id', 'kind', 'field', 'value', 'evidence']);
      identifier(op.field);
      if (!Object.hasOwn(checked.fields, op.field)) fail('FIELD_UNKNOWN');
      const field = checked.fields[op.field];
      if (field.type === 'number') fail('NUMERIC_SET_DENIED');
      fieldValue(field, op.value);
    } else if (op.kind === 'event') {
      keys(op, ['id', 'kind', 'event', 'evidence']);
      identifier(op.event);
      if (!Object.hasOwn(checked.rules, op.event)) fail('EVENT_UNKNOWN');
    } else fail('OPERATION_INVALID');
    const span = evidence(op.evidence, source);
    if (op.kind === 'event') {
      const target = checked.rules[op.event as string].field;
      const prior = numericEvidence.get(target) ?? [];
      // One source span cannot pay for the same numeric field twice, even via
      // different operation IDs or rule aliases. Ambiguous overlap fails closed;
      // disjoint events and changes to different fields remain independent.
      if (prior.some((item) => item.start < span.end && span.start < item.end))
        fail('EVIDENCE_REUSED');
      prior.push(span);
      numericEvidence.set(target, prior);
    } else {
      const key = JSON.stringify([op.field, span.start, span.end]);
      if (assignedEvidence.has(key)) fail('EVIDENCE_REUSED');
      assignedEvidence.add(key);
    }
  }
  return structuredClone(proposal) as StateProposal;
}

/** Pure calculation only. Host commits lineage/dependency checks and logical-effect uniqueness atomically. */
export function reduceStateProposal(
  module: StateModule,
  previous: StateValues,
  proposal: unknown,
  source: StateSource
): { values: StateValues; canonical: boolean } {
  const checked = validateStateModule(module);
  const values = validateStateValues(checked, previous);
  const valid = validateStateProposal(proposal, checked, source);
  for (const op of valid.operations) {
    if (op.kind === 'set') values[op.field] = op.value;
    else {
      const rule = checked.rules[op.event];
      const next = (values[rule.field] as number) + rule.delta;
      fieldValue(checked.fields[rule.field], next);
      values[rule.field] = next;
    }
  }
  return { values, canonical: checked.mode !== 'annotation' };
}
