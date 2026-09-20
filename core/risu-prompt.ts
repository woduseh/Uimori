/** Risu prompt source and host-owned execution receipts; no alternate authoring language. */
import { validateAgentCollaboration } from './agent-collaboration.js';
import {
  validateNativeRisuPreset,
  nativeRisuPresetControls,
  nativeRisuBlockEnabled,
  type NativeRisuPreset,
} from './risu-native-preset.js';
import { nativeChatMlMessages, type NativePromptMessage } from './risu-native-messages.js';
import {
  PromptBudget,
  jsonStringSize,
  type RuntimeValue,
  type PromptEvaluationLimits,
} from './prompt-values.js';
export type { RuntimeValue, PromptEvaluationLimits } from './prompt-values.js';
export type PromptValue = string | number | boolean | null;
export type PromptRoleName = 'system' | 'user' | 'assistant';
/** A UI projection of the preset's native toggle declarations, never an authored AST. */
export type PromptControl = {
  id: string;
  nativeKey?: string;
  label: string;
  type: 'select' | 'text' | 'number' | 'boolean';
  input?: 'text' | 'textarea' | 'switch';
  default: PromptValue;
  options?: { label: string; value: PromptValue }[];
  min?: number;
  max?: number;
  description?: string;
  group?: string;
};
export type RisuPrompt = {
  version: 1;
  nativeRisuPreset: NativeRisuPreset;
  execution?: { storySubmission: boolean };
  collaboration?: import('./agent-collaboration.js').AgentCollaboration;
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
export type PromptCompilerVersion = 'risu-native-prompt-1' | 'risu-native-prompt-2';
export const PROMPT_COMPILER_VERSION: PromptCompilerVersion = 'risu-native-prompt-2';
export const PROMPT_COMPILER_VERSIONS: ReadonlySet<unknown> = new Set([
  'risu-native-prompt-1',
  PROMPT_COMPILER_VERSION,
]);
export type PromptCompilation = {
  usedSlots?: string[];
  execution?: { storySubmission: boolean };
  compilerVersion: PromptCompilerVersion;
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
export class RisuPromptError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: string,
    readonly blockId?: string,
    readonly slotName?: string
  ) {
    super(`${code}${blockId ? ` (${blockId})` : ''}`);
    this.name = 'RisuPromptError';
  }
}
function fail(code: string, blockId?: string): never {
  throw new RisuPromptError(code, blockId);
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
function controlKey(value: unknown): asserts value is string {
  str(value, 1500);
  if (!value || /\p{Cc}/u.test(value)) fail('PROMPT_INVALID_ID');
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
function inspectPromptData(value: unknown, limit = 1_000_000, budget?: PromptBudget): void {
  const pending: { value: unknown; leave?: boolean }[] = [{ value }],
    active = new Set<object>();
  let size = 0,
    nodes = 0;
  const started = performance.now();
  const deterministic = budget?.timing === 'deterministic' ? budget : undefined;
  while (pending.length) {
    deterministic?.step();
    if (++nodes % 128 === 0 && !deterministic && performance.now() - started > 1000)
      fail('PROMPT_TIME_LIMIT');
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
      size += jsonStringSize(v, deterministic);
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
          size += jsonStringSize(key, deterministic) + 1;
        }
        pending.push({ value: d.value });
      }
    } else fail('PROMPT_INVALID_FIELDS');
    if (size > limit) fail('PROMPT_PROGRAM_LIMIT');
  }
}
export function validateProviderPrompt(value: unknown): ProviderPrompt {
  inspectPromptData(value, 1_500_000);
  const p = object(value, ['compilerVersion', 'messages', 'cachePlan', 'values']);
  if (
    !PROMPT_COMPILER_VERSIONS.has(p.compilerVersion) ||
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
    controlKey(key);
    primitive(value);
  }
  if (JSON.stringify(value).length > 1_500_000) fail('PROMPT_COMPILED_LIMIT');
  return structuredClone(value) as ProviderPrompt;
}

export function promptControls(program: RisuPrompt): PromptControl[] {
  return nativeRisuPresetControls(program.nativeRisuPreset);
}
export function validateRisuPrompt(value: unknown): RisuPrompt {
  inspectPromptData(value);
  const input = object(value, ['version', 'nativeRisuPreset', 'execution', 'collaboration']);
  if (input.version !== 1 || !input.nativeRisuPreset) fail('RISU_NATIVE_PRESET_REQUIRED');
  const source = validateNativeRisuPreset(input.nativeRisuPreset);
  if (input.execution !== undefined) {
    const execution = object(input.execution, ['storySubmission']);
    if (typeof execution.storySubmission !== 'boolean') fail('PROMPT_INVALID_EXECUTION');
  }
  if (input.collaboration !== undefined)
    validateAgentCollaboration(
      input.collaboration,
      nativeRisuPresetControls(source).map((c) => c.id)
    );
  return structuredClone(value) as RisuPrompt;
}
export const validateEditableRisuPrompt = validateRisuPrompt;
export function validateControlValue(control: PromptControl, value: PromptValue): void {
  primitive(value);
  if (value === null) return;
  if (control.type === 'select' && !control.options?.some((option) => option.value === value))
    fail('PROMPT_INVALID_CONTROL_VALUE', control.id);
  if (control.type === 'text' && typeof value !== 'string')
    fail('PROMPT_INVALID_CONTROL_VALUE', control.id);
  if (control.type === 'boolean' && typeof value !== 'boolean')
    fail('PROMPT_INVALID_CONTROL_VALUE', control.id);
  if (
    control.type === 'number' &&
    (typeof value !== 'number' ||
      (control.min !== undefined && value < control.min) ||
      (control.max !== undefined && value > control.max))
  )
    fail('PROMPT_INVALID_CONTROL_VALUE', control.id);
}
/** Validate frozen native-toggle UI metadata used by option delegation receipts. */
export function validateControlDefinitions(value: unknown): PromptControl[] {
  inspectPromptData(value, 200_000);
  if (!Array.isArray(value) || value.length > 150) fail('PROMPT_INVALID_CONTROLS');
  const ids = new Set<string>();
  for (const raw of value) {
    const c = object(raw, ['id', 'nativeKey', 'label', 'type', 'default', 'options', 'group']);
    controlKey(c.id);
    if (c.nativeKey !== undefined) str(c.nativeKey, 120);
    str(c.label, 200);
    if (ids.has(c.id)) fail('PROMPT_DUPLICATE_CONTROL');
    ids.add(c.id);
    if (c.type !== 'select' && c.type !== 'text') fail('PROMPT_INVALID_CONTROL');
    if (c.group !== undefined) str(c.group, 200);
    if (c.type === 'select') {
      if (!Array.isArray(c.options) || c.options.length > 200) fail('PROMPT_INVALID_CONTROL');
      for (const option of c.options) {
        const o = object(option, ['label', 'value']);
        str(o.label, 200);
        primitive(o.value);
      }
    } else if (c.options !== undefined) fail('PROMPT_INVALID_CONTROL');
    validateControlValue(raw, c.default as PromptValue);
  }
  return structuredClone(value) as PromptControl[];
}
export function resolveControlValues(
  controls: PromptControl[],
  values: Record<string, PromptValue> = {}
): Record<string, PromptValue> {
  if (!isObject(values) || Object.keys(values).some((key) => !controls.some((c) => c.id === key)))
    fail('PROMPT_UNKNOWN_CONTROL');
  return Object.fromEntries(
    controls.map((c) => {
      const value = Object.hasOwn(values, c.id) ? values[c.id] : c.default;
      validateControlValue(c, value);
      return [c.id, value];
    })
  );
}
export function resolvePromptValues(
  program: RisuPrompt,
  values: Record<string, PromptValue> = {}
): Record<string, PromptValue> {
  return resolveControlValues(promptControls(program), values);
}
export const resolveEditablePromptValues = resolvePromptValues;
export function reconcilePromptValues(
  program: RisuPrompt | PromptControl[],
  values: Record<string, PromptValue> = {}
): { values: Record<string, PromptValue>; resetKeys: string[] } {
  const controls = Array.isArray(program) ? program : promptControls(program);
  const resetKeys = Object.keys(values).filter((key) => !controls.some((c) => c.id === key));
  const resolved = Object.fromEntries(
    controls.map((control) => {
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
export function visiblePromptControls(
  controls: PromptControl[],
  _values?: Record<string, PromptValue>
): PromptControl[] {
  return controls;
}
/** Compose native RISUP blocks after server CBS evaluation. Slot insertion is host data plumbing. */
export function compileRisuPrompt(
  program: RisuPrompt,
  context: {
    values?: Record<string, PromptValue>;
    slots: Record<string, string>;
    history: PromptHistoryMessage[];
    examples?: NativePromptMessage[];
    names?: { char: string; user: string };
    controls?: PromptControl[];
    runtime?: Record<string, RuntimeValue>;
    limits?: PromptEvaluationLimits;
    budget?: PromptBudget;
    compilerVersion?: PromptCompilerVersion;
  }
): PromptCompilation {
  validateRisuPrompt(program);
  for (const message of context.history) {
    if (
      message.sourceKind !== undefined &&
      (message.sourceKind !== 'authored-start' || message.role !== 'assistant' || message.current)
    )
      fail('PROMPT_INVALID_HISTORY_SOURCE');
  }
  if (
    context.compilerVersion !== undefined &&
    !PROMPT_COMPILER_VERSIONS.has(context.compilerVersion)
  )
    fail('PROMPT_INVALID_COMPILED');
  const legacy = context.compilerVersion === 'risu-native-prompt-1';
  const values = resolveControlValues(context.controls ?? promptControls(program), context.values),
    messages: LogicalMessage[] = [],
    cachePlan: PromptCacheAnchor[] = [],
    trace: PromptCompilation['trace'] = [],
    warnings: string[] = [],
    usedSlots = new Set<string>(),
    usedHistory = new Set<string>();
  const preset = program.nativeRisuPreset.preset;
  const settings = isObject(preset.promptSettings) ? preset.promptSettings : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const role = (v: unknown): PromptRoleName =>
    v === 'user' ? 'user' : v === 'assistant' || v === 'bot' ? 'assistant' : 'system';
  const add = (
    id: string,
    content: string,
    messageRole: PromptRoleName,
    completion: 'complete' | 'prefill' = 'complete'
  ) => {
    if (content)
      messages.push({
        id,
        role: messageRole,
        content: [{ type: 'text', text: content }],
        completion,
        provenance: { blockId: id, origin: 'prompt' },
      });
  };
  const legacyInsert = (format: string, slot: string) => {
    if (!Object.hasOwn(context.slots, slot)) fail('PROMPT_UNKNOWN_SLOT', slot);
    const content = context.slots[slot];
    if (content) usedSlots.add(slot);
    return format ? format.replace('{{slot}}', () => content) : content;
  };
  for (const [index, raw] of (preset.promptTemplate as Record<string, unknown>[]).entries()) {
    const id = `risu-block-${index + 1}`,
      type = text(raw.type),
      start = messages.length;
    const included = legacy
      ? type === 'jailbreak'
        ? preset.jailbreakToggle !== false
        : type === 'cot'
          ? preset.chainOfThought !== false
          : type !== 'memory'
      : nativeRisuBlockEnabled(program.nativeRisuPreset, type);
    if (!included) {
      trace.push({ blockId: id, included: false, messageIds: [], reason: 'disabled' });
      continue;
    }
    if (['plain', 'jailbreak', 'cot'].includes(type)) {
      const content = text(raw.text);
      add(
        id,
        legacy && raw.type2 === 'globalNote' ? legacyInsert(content, 'globalNote') : content,
        role(raw.role)
      );
    } else if (type === 'chatML' && !legacy) {
      for (const [part, message] of nativeChatMlMessages(text(raw.text)).entries())
        add(`${id}:chatml-${part}`, message.text, message.role);
    } else if (type === 'chat') {
      const history: (
        | PromptHistoryMessage
        | (NativePromptMessage & { id: string; example: true })
      )[] = [
        ...(legacy ? [] : (context.examples ?? [])).map((item, i) => ({
          ...item,
          id: `example-${i}`,
          example: true as const,
        })),
        ...context.history,
      ];
      const size = history.length,
        offset = (n: number) => Math.min(size, Math.max(0, n < 0 ? size + n : n));
      const from =
        raw.rangeStart === -1000
          ? 0
          : offset(Number.isSafeInteger(raw.rangeStart) ? Number(raw.rangeStart) : 0);
      const to =
        raw.rangeStart === -1000 || raw.rangeEnd === 'end' || raw.rangeEnd === undefined
          ? size
          : offset(Number(raw.rangeEnd));
      if (!Number.isSafeInteger(to) || from > to) fail('PROMPT_REVERSED_HISTORY', id);
      for (const item of history.slice(from, to)) {
        if (usedHistory.has(item.id)) fail('PROMPT_DUPLICATE_HISTORY', id);
        usedHistory.add(item.id);
        if ('example' in item) {
          add(
            `${id}:${item.id}`,
            item.text,
            settings.sendChatAsSystem && !raw.chatAsOriginalOnSystem ? 'system' : item.role
          );
          continue;
        }
        const name = item.role === 'user' ? context.names?.user : context.names?.char;
        const content =
          !legacy && settings.sendName && name
            ? item.sourceKind === 'authored-start'
              ? `${name}: ${item.text}`
              : `<${name}'s Message>\n${item.text}\n</${name}'s Message>`
            : item.text;
        messages.push({
          id: `${id}:${item.id}`,
          role: settings.sendChatAsSystem && !raw.chatAsOriginalOnSystem ? 'system' : item.role,
          content: [{ type: 'text', text: content }],
          completion: 'complete',
          provenance: {
            blockId: id,
            origin: item.current ? 'current' : 'history',
            ...(item.sourceRevision ? { sourceRevision: item.sourceRevision } : {}),
            ...(item.sourceHash ? { sourceHash: item.sourceHash } : {}),
            ...(item.runId ? { runId: item.runId } : {}),
          },
        });
      }
    } else if (type === 'cache') {
      const depth = Math.max(1, Math.min(4, Number(raw.depth) || 1));
      const anchors = messages
        .filter(
          (m) => !['user', 'assistant', 'system'].includes(text(raw.role)) || m.role === raw.role
        )
        .slice(-depth);
      if (!anchors.length) warnings.push(`PROMPT_EMPTY_CACHE_ANCHOR (${id})`);
      for (const message of anchors)
        cachePlan.push({ blockId: id, afterMessageId: message.id, policy: 'prefer' });
    } else if (
      ['persona', 'description', 'lorebook', 'authornote', 'postEverything'].includes(type)
    ) {
      const slot = type === 'authornote' ? 'authorNote' : type;
      const content = context.slots[slot] || (type === 'authornote' ? text(raw.defaultText) : '');
      if (content) {
        usedSlots.add(slot);
        const formatted = legacy || ['persona', 'description', 'authornote'].includes(type);
        add(
          id,
          formatted && text(raw.innerFormat)
            ? text(raw.innerFormat).replace('{{slot}}', () => content)
            : content,
          formatted ? role(raw.role2) : 'system'
        );
      }
      if (!legacy && type === 'postEverything' && settings.postEndInnerFormat)
        add(`${id}:post-end`, text(settings.postEndInnerFormat), 'system');
    } else fail('RISU_NATIVE_PRESET_BLOCK', type);
    trace.push({ blockId: id, included: true, messageIds: messages.slice(start).map((m) => m.id) });
  }
  if (legacy && settings.postEndInnerFormat)
    add(
      'risu-post-end',
      legacyInsert(text(settings.postEndInnerFormat), 'postEverything'),
      'system'
    );
  if (settings.assistantPrefill)
    add('risu-assistant-prefill', text(settings.assistantPrefill), 'assistant', 'prefill');
  if (messages.some((m, i) => m.completion === 'prefill' && i !== messages.length - 1))
    fail('PROMPT_PREFILL_MUST_BE_LAST');
  inspectPromptData(messages, 1_500_000);
  if (messages.length > 1000) fail('PROMPT_COMPILED_LIMIT');
  return {
    usedSlots: [...usedSlots],
    ...(program.execution ? { execution: { ...program.execution } } : {}),
    compilerVersion: context.compilerVersion ?? PROMPT_COMPILER_VERSION,
    values,
    messages,
    cachePlan,
    trace,
    historyScope: 'm2-recent-or-full',
    warnings,
  };
}
export function validateChatPromptControls(value: unknown): ChatPromptControls {
  const raw = object(value, ['values', 'combinations', 'selectedCombinationId']);
  const values = (v: unknown) => {
    if (!isObject(v) || Object.keys(v).length > 150) fail('PROMPT_INVALID_VALUES');
    for (const [key, item] of Object.entries(v)) {
      controlKey(key);
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
