import {
  NATIVE_LUA_LIMITS,
  runNativeRisuLua,
  disposeNativeRisuSession,
} from './risu-native-lua-session.js';
export {
  disposeNativeRisuSession,
  disposeAllNativeRisuSessions,
} from './risu-native-lua-session.js';
import { nativeRisuTriggers, type RisuContentSource } from '../core/risu-native.js';

import { RISU_NATIVE_LUA_DISPATCH, RISU_NATIVE_LUA_PRELUDE } from './risu-native-lua.js';
import { evaluateRisuNativeCbs } from './risu-native-cbs.js';

export interface NativeRisuMessage {
  id?: string;
  role: 'user' | 'char';
  data: string;
  time?: number;
}
export interface NativeRisuRequestMessage {
  role: string;
  content: string;
}
export interface NativeRisuExecutionInput {
  /** Host-resolved grants for each original card/module, before namespaces are merged. */
  effectiveTriggers?: Record<string, unknown>[];
  native: RisuContentSource;
  variables: Record<string, string>;
  messages: NativeRisuMessage[];
  charName: string;
  userName: string;
  event:
    | 'manual'
    | 'button'
    | 'input'
    | 'output'
    | 'display'
    | 'request'
    | 'start'
    | 'editInput'
    | 'editOutput'
    | 'editDisplay'
    | 'editRequest';
  argument?: string;
  text?: string;
  request?: NativeRisuRequestMessage[];
  meta?: Record<string, unknown>;
  globalVariables?: Record<string, string>;
  assetUrls?: Record<string, string>;
}
export interface NativeRisuExecutionResult {
  variables: Record<string, string>;
  messages: NativeRisuMessage[];
  text?: string;
  request?: NativeRisuRequestMessage[];
  effects: {
    reloadDisplay: boolean;
    stopChat: boolean;
    notifications?: { kind: 'normal' | 'error'; message: string }[];
  };
  warnings: string[];
}
export interface NativeRisuExecutionOptions {
  sessionKey?: string;
  signal?: AbortSignal;
  /** External calls preserve Risu's method and arguments; the caller owns model selection. */
  host?: (method: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
  /** Run CBS in an isolated evaluator. No authored CBS is evaluated on the server thread. */
  cbs?: (text: string, context: NativeRisuExecutionInput) => Promise<string>;
}

export class NativeRisuRuntimeError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: string,
    readonly detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'NativeRisuRuntimeError';
  }
}
const fail = (code: string, detail?: string): never => {
  throw new NativeRisuRuntimeError(code, detail);
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : String(value ?? ''));
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const limits = NATIVE_LUA_LIMITS;
const luaSourceLiteral = (source: string) => {
  let marker = '=';
  while (source.includes(`]${marker}]`)) marker += '=';
  return `[${marker}[${source}]${marker}]`;
};

function variables(value: unknown): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RISU_NATIVE_VARIABLES');
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key) || typeof item !== 'string') fail('RISU_NATIVE_VARIABLES');
    result[key] = item as string;
  }
  return result;
}
function messages(value: unknown): NativeRisuMessage[] {
  if (!Array.isArray(value) || value.length > limits.valueEntries) fail('RISU_NATIVE_MESSAGES');
  return (value as unknown[]).map((item) => {
    const message = record(item);
    if ((message.role !== 'char' && message.role !== 'user') || typeof message.data !== 'string')
      fail('RISU_NATIVE_MESSAGES');
    return {
      role: message.role as 'user' | 'char',
      data: message.data as string,
      ...(typeof message.id === 'string' ? { id: message.id } : {}),
      ...(typeof message.time === 'number' ? { time: message.time } : {}),
    };
  });
}
function requestMessages(value: unknown): NativeRisuRequestMessage[] {
  if (!Array.isArray(value) || value.length > limits.valueEntries) fail('RISU_NATIVE_REQUEST');
  return (value as unknown[]).map((item) => {
    const message = record(item);
    if (typeof message.role !== 'string' || typeof message.content !== 'string')
      fail('RISU_NATIVE_REQUEST');
    return { role: message.role as string, content: message.content as string };
  });
}

function compare(left: string, right: string, operator: string, numericEquality: boolean): boolean {
  const numeric = numericEquality && !Number.isNaN(Number(left)) && !Number.isNaN(Number(right));
  switch (operator) {
    case '=':
      return numeric ? Number(left) === Number(right) : left === right;
    case '!=':
      return numeric ? Number(left) !== Number(right) : left !== right;
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    case 'true':
      return left === '1' || left === 'true';
    case 'null':
      return left === 'null';
    default:
      return fail('RISU_NATIVE_CONDITION_UNSUPPORTED', operator);
  }
}

/** Executes original trigger records. No imported BehaviorAction representation is involved. */
async function executeNativeRisuInvocation(
  input: NativeRisuExecutionInput,
  options: NativeRisuExecutionOptions = {}
): Promise<NativeRisuExecutionResult> {
  const state: NativeRisuExecutionInput = {
    ...input,
    variables: variables(input.variables),
    messages: messages(input.messages),
  };
  const evaluate = options.cbs ?? evaluateRisuNativeCbs;
  const output: NativeRisuExecutionResult = {
    variables: state.variables,
    messages: state.messages,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.request === undefined ? {} : { request: requestMessages(input.request) }),
    effects: { reloadDisplay: false, stopChat: false },
    warnings: [],
  };
  const parse = async (value: unknown) => {
    const source = text(value);
    if (!source.includes('{{')) return source;
    return evaluate(source, state);
  };
  const readValue = async (value: unknown, type: unknown) => {
    const parsed = await parse(value);
    return type === 'var' ? (state.variables[parsed] ?? 'null') : parsed;
  };
  const sources: { code: string; lowLevelAccess: boolean }[] = [];
  let manualHandled = false;
  for (const trigger of input.effectiveTriggers ?? nativeRisuTriggers(input.native)) {
    const effects = Array.isArray(trigger.effect) ? trigger.effect.map(record) : [];
    const lua = effects.filter((effect) => effect.type === 'triggerlua');
    if (lua.length && lua.length !== effects.length) fail('RISU_NATIVE_MIXED_TRIGGER_UNSUPPORTED');
    if (
      !lua.length &&
      (input.event === 'manual' ? trigger.comment !== input.argument : trigger.type !== input.event)
    )
      continue;
    let pass = true;
    // Upstream edit and risu-btn paths ignore trigger conditions.
    if (
      ![
        'display',
        'request',
        'editInput',
        'editOutput',
        'editDisplay',
        'editRequest',
        'button',
      ].includes(input.event)
    ) {
      for (const raw of Array.isArray(trigger.conditions) ? trigger.conditions : []) {
        const condition = record(raw);
        let left = '';
        if (condition.type === 'var') left = state.variables[text(condition.var)] ?? 'null';
        else if (condition.type === 'value') left = text(condition.var);
        else if (condition.type === 'chatindex') left = String(state.messages.length);
        else fail('RISU_NATIVE_CONDITION_UNSUPPORTED', text(condition.type));
        if (
          !compare(await parse(left), await parse(condition.value), text(condition.operator), false)
        ) {
          pass = false;
          break;
        }
      }
    }
    if (!pass) continue;
    if (lua.length) {
      for (const effect of lua) {
        if (typeof effect.code !== 'string') fail('RISU_NATIVE_LUA_SOURCE');
        sources.push({
          code: effect.code as string,
          lowLevelAccess: trigger.lowLevelAccess === true,
        });
      }
      continue;
    }
    if (input.event === 'manual') manualHandled = true;
    const blocks: { indent: number; pass: boolean; parent: boolean }[] = [];
    for (const effect of effects) {
      const indent = Number(effect.indent ?? 0);
      if (!Number.isSafeInteger(indent) || indent < 0 || indent > 64)
        fail('RISU_NATIVE_TRIGGER_INDENT');
      while (blocks.length && blocks[blocks.length - 1].indent > indent) blocks.pop();
      if (effect.type === 'v2EndIndent') {
        while (blocks.length && blocks[blocks.length - 1].indent >= indent) blocks.pop();
        continue;
      }
      if (effect.type === 'v2Else') {
        const block = blocks[blocks.length - 1];
        if (!block || block.indent !== indent) fail('RISU_NATIVE_TRIGGER_INDENT');
        block.pass = !block.pass;
        continue;
      }
      const enabled = blocks.every((block) => block.parent && block.pass);
      if (effect.type === 'v2If' || effect.type === 'v2IfAdvanced') {
        const source = await readValue(
          effect.source,
          effect.type === 'v2If' ? 'var' : effect.sourceType
        );
        const target = await readValue(effect.target, effect.targetType);
        blocks.push({
          indent,
          parent: enabled,
          pass: enabled && compare(source, target, text(effect.condition), true),
        });
        continue;
      }
      if (!enabled) continue;
      switch (effect.type) {
        case 'v2Header':
          break;
        case 'v2SetVar':
        case 'setvar': {
          const key = await parse(effect.var);
          if (forbidden.has(key)) fail('RISU_NATIVE_VARIABLES');
          const value = await readValue(effect.value, effect.valueType);
          const before = Number(state.variables[key]) || 0;
          let next = value;
          switch (effect.operator) {
            case '=':
              break;
            case '+=':
              next = String(before + Number(value));
              break;
            case '-=':
              next = String(before - Number(value));
              break;
            case '*=':
              next = String(before * Number(value));
              break;
            case '/=':
              next = String(before / Number(value));
              break;
            case '%=':
              next = String(before % Number(value));
              break;
            default:
              fail('RISU_NATIVE_OPERATOR_UNSUPPORTED', text(effect.operator));
          }
          state.variables[key] = next;
          output.effects.reloadDisplay = true;
          break;
        }
        case 'v2Impersonate':
        case 'impersonate': {
          if (effect.role !== 'user' && effect.role !== 'char') fail('RISU_NATIVE_MESSAGES');
          state.messages.push({
            role: effect.role as 'user' | 'char',
            data: await readValue(effect.value, effect.valueType),
          });
          output.effects.reloadDisplay = true;
          break;
        }
        case 'v2ModifyChat': {
          const index = Number(await readValue(effect.index, effect.indexType));
          if (state.messages[index])
            state.messages[index].data = await readValue(effect.value, effect.valueType);
          break;
        }
        case 'v2StopPrompt':
        case 'stop':
          output.effects.stopChat = true;
          break;
        default:
          fail('RISU_NATIVE_EFFECT_UNSUPPORTED', text(effect.type));
      }
    }
  }
  if (!sources.length) {
    if (input.event === 'manual' && !manualHandled) fail('RISU_NATIVE_TRIGGER_NOT_FOUND');
    return output;
  }
  const card = record(input.native.card.data ?? input.native.card);
  const risu = record(record(card.extensions).risuai);
  const source = `${RISU_NATIVE_LUA_PRELUDE}\nlocal function __initialize()\n${sources.map(({ code, lowLevelAccess }, index) => `__runScript(${luaSourceLiteral(code)}, ${index + 1}, ${lowLevelAccess})`).join('\n')}\nend\n${RISU_NATIVE_LUA_DISPATCH}`;
  const value = record(
    await runNativeRisuLua(
      source,
      {
        variables: state.variables,
        messages: state.messages,
        event: input.event,
        argument: input.argument ?? '',
        text: input.text ?? null,
        request: input.request ?? null,
        meta: input.meta ?? {},
        charName: input.charName,
        userName: input.userName,
        description: text(card.description),
        firstMessage: text(card.first_mes),
        backgroundHTML: text(risu.backgroundHTML),
        manualHandled,
        globalVariables: input.globalVariables ?? {},
      },
      options,
      async (method, args, signal) => {
        if (method === 'random') {
          const payload = record(args);
          if (payload.first === null) return Math.random();
          const first = payload.last === null ? 1 : Number(payload.first);
          const last = payload.last === null ? Number(payload.first) : Number(payload.last);
          if (
            !Number.isSafeInteger(first) ||
            !Number.isSafeInteger(last) ||
            last < first ||
            last - first > 2 ** 48
          )
            fail('RISU_NATIVE_RANDOM_ARGUMENT');
          return first + Math.floor(Math.random() * (last - first + 1));
        }
        if (method === 'cbs') {
          const payload = record(args);
          state.variables = variables(payload.variables);
          state.messages = messages(payload.messages);
          return { text: await evaluate(text(payload.text), state), variables: state.variables };
        }
        if (['alertInput', 'alertSelect', 'alertConfirm'].includes(method)) {
          if (['display', 'editDisplay'].includes(input.event))
            fail('RISU_NATIVE_DISPLAY_INTERACTION_DENIED');
          if (!options.host) fail('RISU_NATIVE_HOST_UNAVAILABLE', method);
          return options.host!(method, args, signal);
        }
        if (!['LLM', 'axLLM', 'simpleLLM'].includes(method))
          fail('RISU_NATIVE_HOST_UNSUPPORTED', method);
        const payload = record(args),
          scriptIndex = Number(payload.__nativeScript);
        if (
          !Number.isSafeInteger(scriptIndex) ||
          !sources[scriptIndex - 1]?.lowLevelAccess ||
          ['display', 'editDisplay'].includes(input.event)
        )
          fail('RISU_NATIVE_MODEL_DENIED');
        if (!options.host) fail('RISU_NATIVE_HOST_UNAVAILABLE', method);
        const { __nativeScript: _owner, ...authored } = payload;
        return options.host!(method, authored, signal);
      }
    )
  );
  output.variables = variables(value.variables);
  output.messages = messages(value.messages);
  if (Object.hasOwn(value, 'text')) {
    if (typeof value.text !== 'string') fail('RISU_NATIVE_EDIT_RESULT');
    output.text = value.text as string;
  }
  if (Object.hasOwn(value, 'request')) output.request = requestMessages(value.request);
  const effects = record(value.effects);
  if (typeof effects.reloadDisplay !== 'boolean' || typeof effects.stopChat !== 'boolean')
    fail('RISU_NATIVE_EFFECTS');
  output.effects.reloadDisplay ||= effects.reloadDisplay as boolean;
  output.effects.stopChat ||= effects.stopChat as boolean;
  if (Array.isArray(effects.notifications) && effects.notifications.length) {
    output.effects.notifications = effects.notifications.map((item) => {
      const notification = record(item);
      if (
        !['normal', 'error'].includes(text(notification.kind)) ||
        typeof notification.message !== 'string'
      )
        fail('RISU_NATIVE_EFFECTS');
      return {
        kind: notification.kind as 'normal' | 'error',
        message: notification.message as string,
      };
    });
  }
  return output;
}

export async function executeRisuNative(
  input: NativeRisuExecutionInput,
  options: NativeRisuExecutionOptions = {}
): Promise<NativeRisuExecutionResult> {
  try {
    return await executeNativeRisuInvocation(input, options);
  } catch (error) {
    if (options.sessionKey) disposeNativeRisuSession(options.sessionKey);
    throw error;
  }
}
