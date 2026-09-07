import {
  behaviorActionTriggers,
  validateBehaviorValue,
  type PackageBehavior,
} from './package-behavior.js';
import {
  evaluatePromptExpression,
  resolvePromptValues,
  validatePromptExpression,
  type PromptControl,
  type PromptExpression,
  type PromptValue,
  type RuntimeValue,
} from './prompt-program.js';

/** One explicitly selected opening; the text remains the author's exact text. */
export type PackageStart = {
  id: string;
  title: string;
  description?: string;
  mode: 'authored' | 'generate';
  text: string;
  values?: Record<string, PromptValue>;
  initialAction?: { actionId: string; input: PromptExpression };
};
export type PackageStartRef = { packageId: string; packageRevision: number; startId: string };
export type PackageStartSnapshot = PackageStartRef & {
  mode: PackageStart['mode'];
  title: string;
  text: string;
  values: Record<string, PromptValue>;
  initialAction?: { actionId: string; input: RuntimeValue };
};
type StartPackage = {
  id: string;
  revision: number;
  controls: PromptControl[];
  behavior?: PackageBehavior;
  starts?: PackageStart[];
};
export class PackageStartError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PackageStartError';
  }
}
function fail(message: string): never {
  throw new PackageStartError(message);
}
function record(value: unknown, allowed?: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        (allowed && !allowed.includes(key))
    )
  )
    fail('PACKAGE_START_INVALID_FIELDS');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    fail('PACKAGE_START_INVALID_ID');
}
function text(value: unknown, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()))
    fail('PACKAGE_START_INVALID_TEXT');
}
function controlsOnly(expression: PromptExpression): void {
  const pending: unknown[] = [expression];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value) && Object.hasOwn(value, 'context'))
      fail('PACKAGE_START_INPUT_CONTEXT');
    // Literal data is data, including objects with a field named context.
    if (!Array.isArray(value) && Object.hasOwn(value, 'literal')) continue;
    pending.push(...Object.values(value));
  }
}

export function validatePackageStartRef(value: unknown): PackageStartRef {
  const ref = record(value, ['packageId', 'packageRevision', 'startId']);
  identifier(ref.packageId);
  identifier(ref.startId);
  if (!Number.isSafeInteger(ref.packageRevision) || Number(ref.packageRevision) < 1)
    fail('PACKAGE_START_INVALID_REVISION');
  return structuredClone(ref) as PackageStartRef;
}

export function validatePackageStarts(
  value: unknown,
  context: { controls: PromptControl[]; behavior?: PackageBehavior }
): PackageStart[] {
  if (!Array.isArray(value) || value.length > 20) fail('PACKAGE_START_LIST_LIMIT');
  const ids = new Set<string>();
  for (const raw of value) {
    const start = record(raw, [
      'id',
      'title',
      'description',
      'mode',
      'text',
      'values',
      'initialAction',
    ]);
    identifier(start.id);
    if (ids.has(start.id)) fail('PACKAGE_START_DUPLICATE_ID');
    ids.add(start.id);
    text(start.title, 200);
    text(start.text, start.mode === 'generate' ? 4000 : 100_000);
    if (start.description !== undefined) text(start.description, 2000, true);
    if (start.mode !== 'authored' && start.mode !== 'generate') fail('PACKAGE_START_INVALID_MODE');
    const values = resolvePromptValues(
      { version: 1, controls: context.controls, blocks: [] },
      start.values === undefined ? {} : (record(start.values) as Record<string, PromptValue>)
    );
    if (start.initialAction !== undefined) {
      const initial = record(start.initialAction, ['actionId', 'input']);
      identifier(initial.actionId);
      const action = context.behavior?.actions.find((item) => item.id === initial.actionId);
      if (!action || !behaviorActionTriggers(action).includes('user'))
        fail('PACKAGE_START_INITIAL_ACTION');
      const input = validatePromptExpression(
        initial.input,
        context.controls.map((control) => control.id)
      );
      controlsOnly(input);
      validateBehaviorValue(action.inputSchema, evaluatePromptExpression(input, values));
    }
  }
  if (JSON.stringify(value).length > 2_000_000) fail('PACKAGE_START_SIZE_LIMIT');
  return structuredClone(value) as PackageStart[];
}

/** Pure preview: no state writes, random draws, provider work or prompt-side mutation. */
export function resolvePackageStart(
  pkg: StartPackage,
  startId: string,
  overrides: Record<string, PromptValue> = {}
): PackageStartSnapshot {
  const start = validatePackageStarts(pkg.starts ?? [], pkg).find((item) => item.id === startId);
  if (!start) fail('PACKAGE_START_NOT_FOUND');
  const values = resolvePromptValues(
    { version: 1, controls: pkg.controls, blocks: [] },
    { ...start.values, ...overrides }
  );
  let initialAction: PackageStartSnapshot['initialAction'];
  if (start.initialAction) {
    const action = pkg.behavior!.actions.find((item) => item.id === start.initialAction!.actionId)!;
    initialAction = {
      actionId: action.id,
      input: validateBehaviorValue(
        action.inputSchema,
        evaluatePromptExpression(start.initialAction.input, values)
      ),
    };
  }
  return {
    packageId: pkg.id,
    packageRevision: pkg.revision,
    startId,
    mode: start.mode,
    title: start.title,
    text: start.text,
    values,
    ...(initialAction ? { initialAction } : {}),
  };
}
