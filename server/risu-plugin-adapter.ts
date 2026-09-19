import {
  EXTENSION_PROGRAM_API,
  EXTENSION_PROGRAM_MAX_SOURCE_BYTES,
  extensionProgramSourceBytes,
  type ExtensionProgram,
} from '../core/extension-program.js';
import {
  BEHAVIOR_EDIT_INPUT_SCHEMA,
  BEHAVIOR_EDIT_REQUEST_SCHEMA,
  type BehaviorAction,
  type BehaviorActionHook,
  type BehaviorActionTrigger,
} from '../core/package-behavior.js';
import { HOST_LIST_PAGE_MAX, HOST_TEXT_PAGE_MAX } from '../core/paging.js';
import type { PromptControl } from '../core/prompt-program.js';
import { RISU_PLUGIN_API_SUPPORT, type RisuPluginPreview } from '../core/risu-plugin.js';

/**
 * The five phases a Risu plugin's registrations can reach on the current execution model. A plugin
 * is imported as a module package whose actions wrap the plugin file in a `risuai` shim, exactly as
 * previously stored Lua wrappers: there is no resident instance, so the file re-runs per
 * event and only the registrations made during that run are dispatched for that event.
 */
export const RISU_PLUGIN_EVENTS = [
  'editInput',
  'editRequest',
  'editOutput',
  'editDisplay',
  'output',
] as const;
export type RisuPluginEvent = (typeof RISU_PLUGIN_EVENTS)[number];
export type RisuPluginAdapterFinding = {
  code: string;
  level: 'info' | 'warning' | 'unsupported';
  message: string;
};

/**
 * Branch shared-variable key prefixes. Like Risu, no plugin name separates one plugin's keys, and
 * each Risu store keeps its own prefix: `safeLocalStorage` is localStorage with string values while
 * `getLocalPluginStorage()` is localforage with JSON values, so one prefix cannot serve both.
 */
export const RISU_PLUGIN_STORAGE_PREFIX = 'risu.plugin.storage:';
export const RISU_PLUGIN_LOCAL_PREFIX = 'risu.plugin.local:';
export const RISU_PLUGIN_LOCALSTORAGE_PREFIX = 'risu.plugin.localstorage:';

const EVENT_TRIGGERS: Record<RisuPluginEvent, BehaviorActionTrigger> = {
  editInput: 'before-turn',
  editRequest: 'before-turn',
  editOutput: 'after-turn',
  editDisplay: 'after-turn',
  output: 'after-turn',
};
const EVENT_HOOKS: Partial<Record<RisuPluginEvent, BehaviorActionHook>> = {
  editInput: 'edit-input',
  editRequest: 'edit-request',
  editOutput: 'edit-output',
  editDisplay: 'edit-display',
};
const EVENT_LABELS: Record<RisuPluginEvent, string> = {
  editInput: '플러그인 입력 편집',
  editRequest: '플러그인 요청 편집',
  editOutput: '플러그인 출력 편집',
  editDisplay: '플러그인 표시 편집',
  output: '플러그인 응답 이벤트',
};

/**
 * The `risuai` shim. Every member is async because Risu's own bridge returns a Promise for
 * everything except the two version constants, and a member with no scoped Host contract keeps a
 * named denial instead of silently doing nothing.
 */
function prelude(name: string): string {
  return `const __host = (method, args) => api.host.call(method, args);
const __fail = (code) => { throw new Error(code); };
const __end = (value) => value === null || value === undefined;
const __name = ${JSON.stringify(name)};
const __handlers = {input: [], output: [], display: [], process: []};
const __replacers = {beforeRequest: [], afterRequest: []};
const __listeners = {output: []};
const __unloads = [];
const __add = (table, key, callback, code) => {
  if (typeof key !== 'string' || !Object.hasOwn(table, key)) __fail(code + ':' + String(key));
  if (typeof callback !== 'function') __fail('RISU_PLUGIN_CALLBACK_INVALID');
  table[key].push(callback);
};
const __remove = (table, key, callback, code) => {
  if (typeof key !== 'string' || !Object.hasOwn(table, key)) __fail(code + ':' + String(key));
  const at = table[key].indexOf(callback);
  if (at !== -1) table[key].splice(at, 1);
};
let __options = null;
/** The declared arguments are this package's controls, so one frozen read answers every lookup. */
const __readArgument = async (key) => {
  const values = (await (__options ??= __host('options.read', {}))).values;
  return Object.hasOwn(values, key) ? values[key] : undefined;
};
const __readVariable = async (key) => {
  let text = '', offset = 0;
  for (;;) {
    const page = await __host('variables.read', {key, offset, limit: ${HOST_TEXT_PAGE_MAX}});
    if (__end(page.value)) return offset === 0 ? null : text;
    text += page.value;
    if (__end(page.nextOffset)) return text;
    offset = page.nextOffset;
  }
};
const __variableKeys = async (prefix) => {
  const keys = [];
  let offset = 0;
  for (;;) {
    const page = await __host('variables.list', {offset, limit: ${HOST_LIST_PAGE_MAX}});
    for (const item of page.items)
      if (item.key.startsWith(prefix)) keys.push(item.key.slice(prefix.length));
    if (__end(page.nextOffset)) return keys;
    offset = page.nextOffset;
  }
};
const __store = (prefix, json) => ({
  getItem: async (key) => {
    const text = await __readVariable(prefix + String(key));
    if (text === null || !json) return text;
    try { return JSON.parse(text); } catch { return null; }
  },
  setItem: async (key, value) => {
    const text = json ? JSON.stringify(value) : String(value);
    if (typeof text !== 'string') __fail('RISU_PLUGIN_STORAGE_VALUE');
    await __host('variables.set', {key: prefix + String(key), value: text});
  },
  removeItem: async (key) => { await __host('variables.delete', {key: prefix + String(key)}); },
  keys: async () => __variableKeys(prefix),
  length: async () => (await __variableKeys(prefix)).length,
  key: async (index) => { const keys = await __variableKeys(prefix); return keys[index] ?? null; },
  clear: async () => {
    for (const key of await __variableKeys(prefix))
      await __host('variables.delete', {key: prefix + key});
  },
});
const __materialText = async (id) => {
  let text = '', offset = 0;
  for (;;) {
    const page = await __host('materials.read', {id, offset, limit: ${HOST_TEXT_PAGE_MAX}});
    text += page.text;
    if (__end(page.nextOffset)) return text;
    offset = page.nextOffset;
  }
};
const __materials = async (match) => {
  const found = [];
  let offset = 0;
  for (;;) {
    const page = await __host('materials.list', {offset, limit: ${HOST_LIST_PAGE_MAX}});
    for (const item of page.items) if (match(item)) found.push(item);
    if (__end(page.nextOffset)) return found;
    offset = page.nextOffset;
  }
};
const __character = async () => {
  // The package's own body resource. A lore item always reports the "lore" kind instead.
  const body = await __materials((item) => item.kind !== 'lore' && item.id.endsWith(':body'));
  return {
    name: (await __host('identity.read', {})).botName,
    description: body.length ? await __materialText(body[0].id) : '',
  };
};
const __conversation = async () => {
  const message = [];
  try {
    let index = 0, offset = 0;
    for (;;) {
      const page = await __host('conversation.page', {index, offset, limit: ${HOST_TEXT_PAGE_MAX}});
      for (const item of page.items) {
        if (message[item.index] === undefined)
          message[item.index] = {role: item.role === 'assistant' ? 'char' : 'user', data: ''};
        message[item.index].data += item.text;
      }
      if (__end(page.next)) break;
      index = page.next.index;
      offset = page.next.offset;
    }
  } catch {
    // Without this chat's conversation read grant the listener sees an empty history.
    message.length = 0;
  }
  return message;
};
const __members = {
  apiVersion: '3.0',
  apiVersionCompatibleWith: ['3.0'],
  getRuntimeInfo: async () => ({apiVersion: '3.0', platform: 'uimori', saveMethod: 'uimori'}),
  log: async () => {},
  onUnload: async (callback) => {
    if (typeof callback !== 'function') __fail('RISU_PLUGIN_CALLBACK_INVALID');
    __unloads.push(callback);
  },
  addRisuScriptHandler: async (mode, callback) =>
    __add(__handlers, mode, callback, 'RISU_PLUGIN_HOOK_UNSUPPORTED'),
  removeRisuScriptHandler: async (mode, callback) =>
    __remove(__handlers, mode, callback, 'RISU_PLUGIN_HOOK_UNSUPPORTED'),
  addRisuReplacer: async (mode, callback) =>
    __add(__replacers, mode, callback, 'RISU_PLUGIN_HOOK_UNSUPPORTED'),
  removeRisuReplacer: async (mode, callback) =>
    __remove(__replacers, mode, callback, 'RISU_PLUGIN_HOOK_UNSUPPORTED'),
  addRisuChatListener: async (mode, callback) =>
    __add(__listeners, mode, callback, 'RISU_PLUGIN_HOOK_UNSUPPORTED'),
  removeRisuChatListener: async (mode, callback) =>
    __remove(__listeners, mode, callback, 'RISU_PLUGIN_HOOK_UNSUPPORTED'),
  getArgument: async (key) => __readArgument(String(key)),
  getArg: async (key) => {
    // Risu reads any installed plugin's stored arguments here; only this package's own options
    // exist, so another plugin's name is a denial rather than an empty value.
    const parts = String(key).split('::');
    if (parts.length < 2 || parts[0] !== __name) __fail('RISU_PLUGIN_ARG_FOREIGN');
    return __readArgument(parts.slice(1).join('::'));
  },
  pluginStorage: __store(${JSON.stringify(RISU_PLUGIN_STORAGE_PREFIX)}, true),
  safeLocalStorage: __store(${JSON.stringify(RISU_PLUGIN_LOCALSTORAGE_PREFIX)}, false),
  getLocalPluginStorage: async () => __store(${JSON.stringify(RISU_PLUGIN_LOCAL_PREFIX)}, true),
  getCharacter: async () => __character(),
  getChar: async () => __character(),
  getCurrentLorebookEntries: async () => {
    const entries = [];
    for (const item of await __materials((item) => item.kind === 'lore'))
      entries.push({key: '', comment: item.title, content: await __materialText(item.id)});
    return entries;
  },
  runLLMModel: async (options) => {
    if (options === null || typeof options !== 'object' || !Array.isArray(options.messages))
      __fail('RISU_PLUGIN_REQUEST_INVALID');
    // The Host prompt contract is one string, so the ChatML turns are joined as labelled lines.
    const prompt = options.messages
      .map((item) => String(item?.role ?? '') + ': ' + String(item?.content ?? ''))
      .join('\\n');
    const response = await __host('model.generate', {prompt});
    return response.status === 'completed'
      ? {type: 'success', result: response.text}
      : {type: 'fail', result: 'Error: ' + String(response.error)};
  },
};
const risuai = new Proxy(__members, {
  get: (target, member) => {
    if (typeof member !== 'string') return undefined;
    if (Object.hasOwn(target, member)) return target[member];
    // Awaiting the shim itself must not treat a denial stub as a thenable.
    if (member === 'then') return undefined;
    return () => __fail('RISU_PLUGIN_API_UNSUPPORTED:' + member);
  },
});
const Risuai = risuai;`;
}

/** Risu keeps a handler's return only when it is neither null nor undefined. */
const FOLD = (list: string) => `for (const __callback of ${list}) {
  const __next = await __callback(__value);
  if (__next !== null && __next !== undefined) __value = __next;
}`;
const TEXT_RESULT = `if (typeof __value !== 'string') __fail('RISU_PLUGIN_RESULT_INVALID');
return {state: api.state, result: __value};`;

function dispatcher(event: RisuPluginEvent): string {
  if (event === 'editRequest')
    return `let __messages = api.input.value;
for (const __callback of __replacers.beforeRequest)
  __messages = await __callback(__messages, 'uimori');
return {state: api.state, result: __messages};`;
  if (event === 'output')
    return `if (__listeners.output.length) {
  const __message = await __conversation();
  const __event = {
    char: {name: (await __host('identity.read', {})).botName},
    chat: {message: __message},
    characterIndex: 0,
    chatIndex: 0,
    messageIndex: __message.length - 1,
  };
  for (const __callback of __listeners.output) await __callback(__event);
}
return {state: api.state, result: null};`;
  // Risu assigns an afterRequest replacer's result unconditionally, unlike a script handler.
  const replacers =
    event === 'editOutput'
      ? `for (const __callback of __replacers.afterRequest) {
  __value = await __callback(__value, 'uimori');
  if (typeof __value !== 'string') __fail('RISU_PLUGIN_RESULT_INVALID');
}\n`
      : '';
  const handlers =
    event === 'editInput'
      ? '__handlers.input'
      : event === 'editOutput'
        ? '__handlers.output'
        : '__handlers.display';
  return `let __value = api.input.value;\n${replacers}${FOLD(handlers)}\n${TEXT_RESULT}`;
}

/** Pure source construction. No plugin code, callback or model is evaluated here. */
export function buildRisuPluginProgram(
  plugin: RisuPluginPreview,
  source: string,
  event: RisuPluginEvent
): ExtensionProgram {
  if (typeof source !== 'string' || !source.trim()) throw new Error('RISU_PLUGIN_SOURCE_INVALID');
  if (!RISU_PLUGIN_EVENTS.includes(event)) throw new Error('RISU_PLUGIN_EVENT_UNSUPPORTED');
  // The worker body is an async function, so the plugin keeps Risu's tolerance for top-level
  // await while its own const/let stay inside the wrapper instead of colliding with the prelude.
  const body = `${prelude(plugin.name)}\nawait (async () => {\n${source}\n})();\n${dispatcher(event)}`;
  if (extensionProgramSourceBytes(body) > EXTENSION_PROGRAM_MAX_SOURCE_BYTES)
    throw new Error('RISU_PLUGIN_SOURCE_LIMIT');
  return {
    api: EXTENSION_PROGRAM_API,
    capabilities: [
      'materials.read.self',
      'variables.read',
      'variables.write',
      'model.generate',
      'conversation.read',
      'response.read.current',
    ],
    source: body,
  };
}

const HANDLER_EVENTS: Record<string, RisuPluginEvent | undefined> = {
  input: 'editInput',
  output: 'editOutput',
  display: 'editDisplay',
  process: undefined,
};
const REPLACER_EVENTS: Record<string, RisuPluginEvent> = {
  beforeRequest: 'editRequest',
  afterRequest: 'editOutput',
};
// The shim may be reached as `risuai.addRisuScriptHandler(` or through a destructured name, so a
// preceding dot is allowed; only a longer identifier ending in the same letters is excluded.
const HANDLER_CALLS = /(?:^|[^\w$])addRisuScriptHandler\s*\(/gu;
const HANDLER_MODES =
  /(?:^|[^\w$])addRisuScriptHandler\s*\(\s*['"](input|output|display|process)['"]/gu;
const REPLACER_CALLS = /(?:^|[^\w$])addRisuReplacer\s*\(/gu;
const REPLACER_NAMES = /(?:^|[^\w$])addRisuReplacer\s*\(\s*['"](beforeRequest|afterRequest)['"]/gu;
/** Prompt control ids accept a narrower alphabet than a Risu argument key. */
const CONTROL_KEY = /^[a-zA-Z0-9_.:-]+$/u;

const literalNames = (source: string, modes: RegExp) =>
  [...source.matchAll(modes)].map((match) => match[1]);
/**
 * The literal modes a registration names, but only when every call site is literal: a computed
 * mode means the adapter cannot narrow the phases and keeps all of them connected.
 */
function literalModes(source: string, calls: RegExp, modes: RegExp): string[] | undefined {
  const total = [...source.matchAll(calls)].length;
  const found = literalNames(source, modes);
  return total > 0 && found.length === total ? [...new Set(found)] : undefined;
}

/**
 * Import adapter for a Risu plugin file. Nothing executes here: the file becomes one module
 * package whose behavior actions re-run it per event, and every semantic difference is a finding.
 */
export function adaptRisuPlugin(
  plugin: RisuPluginPreview,
  source: string,
  /** The API object's other bindings, as readRisuPluginFile detects them. */
  aliases: readonly string[] = []
): {
  controls: PromptControl[];
  actions: BehaviorAction[];
  findings: RisuPluginAdapterFinding[];
} {
  const findings: RisuPluginAdapterFinding[] = [];
  const report = (code: string, level: RisuPluginAdapterFinding['level'], message: string) => {
    if (!findings.some((item) => item.code === code)) findings.push({ code, level, message });
  };
  const controls: PromptControl[] = [];
  for (const argument of plugin.arguments) {
    if (!CONTROL_KEY.test(argument.key) || controls.some((item) => item.id === argument.key)) {
      report(
        `RISU_PLUGIN_ARGUMENT_UNSUPPORTED:${argument.key}`,
        'unsupported',
        `//@arg ${argument.key}는 자료 옵션 이름 규칙(영숫자와 _ . : -)에 맞지 않거나 이미 있는 이름이라 옵션으로 만들지 않았어요. 이 인자를 읽으면 값이 없어요.`
      );
      continue;
    }
    controls.push({
      id: argument.key,
      label: argument.key,
      type: argument.type === 'int' ? 'number' : 'text',
      default: argument.type === 'int' ? 0 : '',
      ...(argument.description ? { description: argument.description.slice(0, 4000) } : {}),
    });
  }

  const used = new Set([...plugin.apis.map((api) => api.name), ...plugin.unknownApis]);
  const events = new Set<RisuPluginEvent>();
  if (used.has('addRisuScriptHandler')) {
    const modes = literalModes(source, HANDLER_CALLS, HANDLER_MODES);
    for (const mode of modes ?? ['input', 'output', 'display']) {
      const event = HANDLER_EVENTS[mode];
      if (event) events.add(event);
    }
  }
  if (used.has('addRisuReplacer')) {
    const names = literalModes(source, REPLACER_CALLS, REPLACER_NAMES);
    for (const name of names ?? ['beforeRequest', 'afterRequest'])
      events.add(REPLACER_EVENTS[name]);
  }
  if (used.has('addRisuChatListener')) events.add('output');
  // An alias hides which members the file calls, so every phase connects rather than none. A phase
  // that turns out to register nothing runs its dispatcher over an empty list and changes nothing.
  if (aliases.length) for (const event of RISU_PLUGIN_EVENTS) events.add(event);

  const actions: BehaviorAction[] = [];
  for (const event of RISU_PLUGIN_EVENTS) {
    if (!events.has(event)) continue;
    const hook = EVENT_HOOKS[event];
    try {
      actions.push({
        id: `risu-plugin-${event}`,
        label: EVENT_LABELS[event],
        inputSchema:
          event === 'editRequest'
            ? structuredClone(BEHAVIOR_EDIT_REQUEST_SCHEMA)
            : hook
              ? structuredClone(BEHAVIOR_EDIT_INPUT_SCHEMA)
              : { type: 'record', properties: {} },
        triggers: [EVENT_TRIGGERS[event]],
        ...(hook ? { hook } : { automaticInput: {} }),
        effects: [],
        program: buildRisuPluginProgram(plugin, source, event),
      });
    } catch (error) {
      report(
        error instanceof Error ? error.message : 'RISU_PLUGIN_SOURCE_INVALID',
        'unsupported',
        '플러그인 소스를 네이티브 실행 한도 안에서 구성할 수 없어 행동을 연결하지 않았어요. 원본 파일은 보존해요.'
      );
      return { controls, actions: [], findings };
    }
  }

  report(
    'RISU_PLUGIN_FRESH_INVOCATION',
    'warning',
    '상주 인스턴스가 없어서 플러그인 파일은 이벤트마다 새로 실행해요. 모듈 최상위에 둔 값은 이벤트 사이에 남지 않으니 유지할 값은 pluginStorage에 저장해야 해요.'
  );
  if (aliases.length)
    report(
      'RISU_PLUGIN_ALIAS_ALL_PHASES',
      'info',
      'risuai를 다른 이름으로 받아 쓰는 코드가 있어 등록 시점을 정적으로 알 수 없어요. 모든 단계에 연결하고 등록되지 않은 단계는 아무것도 바꾸지 않아요.'
    );
  if (
    used.has('pluginStorage') ||
    used.has('safeLocalStorage') ||
    used.has('getLocalPluginStorage')
  )
    report(
      'RISU_PLUGIN_STORAGE_SCOPE',
      'warning',
      '플러그인 저장소는 앱 전역이 아니라 이 채팅 분기의 공유 변수를 사용해요. 쓰려면 채팅에서 이 자료 개정에 공유 변수 변경을 허용해야 하고, 허용이 없으면 저장이 실패해요. Risu처럼 플러그인 사이에 키를 공유하고, 세 저장소는 Risu와 같이 각각 따로 보관해요.'
    );
  if (events.has('editRequest'))
    report(
      'RISU_PLUGIN_REQUEST_SHAPE',
      'warning',
      'beforeRequest 교체기는 전송용 원문 대화와 이번 요청만 {role, content} 목록으로 받아요. 메시지 수와 역할은 바꿀 수 없고 시스템 프롬프트·로어는 넘기지 않으며, 채팅에서 대화 읽기를 허용해야 실행해요.'
    );
  if (events.has('editOutput') || events.has('editDisplay'))
    report(
      'RISU_PLUGIN_OUTPUT_COPY',
      'info',
      '출력·표시 편집과 afterRequest 교체기는 저장 원문을 바꾸지 않고 이 응답의 표시 사본에만 적용해요. 다음 턴의 문맥과 대화 읽기는 원문을 읽어요.'
    );
  if (used.has('setArgument') || used.has('setArg'))
    report(
      'RISU_PLUGIN_ARGUMENTS_READONLY',
      'info',
      '플러그인 인자는 자료 옵션으로 읽기만 해요. setArgument·setArg를 부르면 지원하지 않는다는 오류를 표시해요.'
    );
  // A named process mode is reported even when a sibling call site computes its own mode.
  if (literalNames(source, HANDLER_MODES).includes('process'))
    report(
      'RISU_PLUGIN_HOOK_UNSUPPORTED:process',
      'unsupported',
      "addRisuScriptHandler('process')는 같은 실행 시점의 공통 훅이 없어 연결하지 않았어요. 등록은 받지만 어떤 이벤트에서도 호출하지 않아요."
    );
  for (const member of [...used].sort())
    if (RISU_PLUGIN_API_SUPPORT[member]?.support !== 'mapped')
      report(
        `RISU_PLUGIN_API_UNSUPPORTED:${member}`,
        'unsupported',
        `${member}는 아직 연결하지 않았어요. 실행 중에 부르면 성공한 것처럼 처리하지 않고 오류를 표시해요.`
      );
  return { controls, actions, findings };
}
