import {
  EXTENSION_PROGRAM_API,
  EXTENSION_PROGRAM_MAX_SOURCE_CHARS,
  type ExtensionProgram,
} from '../core/extension-program.js';
import {
  BEHAVIOR_EDIT_INPUT_SCHEMA,
  BEHAVIOR_EDIT_REQUEST_SCHEMA,
  type BehaviorAction,
  type BehaviorActionHook,
  type BehaviorActionTrigger,
} from '../core/package-behavior.js';
import {
  validatePromptExpression,
  type PromptExpression,
  type PromptOperation,
} from '../core/prompt-program.js';
import { RisuCbs, UnsupportedCbs } from './risu-cbs.js';

export const RISU_LUA_EVENTS = [
  'input',
  'output',
  'start',
  'onButtonClick',
  'editRequest',
  'editDisplay',
  'editInput',
  'editOutput',
] as const;
export type RisuLuaEvent = (typeof RISU_LUA_EVENTS)[number];
export interface RisuLuaFinding {
  code: string;
  triggerIndex: number;
  effectIndex?: number;
  event?: RisuLuaEvent;
  message: string;
}
export interface RisuLuaSource {
  triggerIndex: number;
  effectIndex: number;
  source: string;
}
export interface RisuLuaAdapterOptions {
  idPrefix?: string;
}

// These APIs have no equivalent scoped Host contract yet. A named denial is preferable to
// silently dropping a mutation, changing an ordered message prompt, or fabricating a result.
const unavailableApis = [
  'getGlobalVar',
  'stopChat',
  'alertError',
  'alertNormal',
  'alertInput',
  'alertSelect',
  'alertConfirm',
  'setChat',
  'setChatRole',
  'cutChat',
  'removeChat',
  'addChat',
  'insertChat',
  'getTokens',
  'sleep',
  'cbs',
  'setFullChat',
  'setFullChatMain',
  'log',
  'logMain',
  'reloadDisplay',
  'reloadChat',
  'similarity',
  'request',
  'generateImage',
  'getCharacterImage',
  'getCharacterImageMain',
  'getPersonaImage',
  'getPersonaImageMain',
  'hash',
  'LLM',
  'LLMMain',
  'axLLM',
  'axLLMMain',
  'getName',
  'setName',
  'getDescription',
  'setDescription',
  'getCharacterFirstMessage',
  'setCharacterFirstMessage',
  'getPersonaName',
  'getPersonaDescription',
  'getAuthorsNote',
  'getBackgroundEmbedding',
  'setBackgroundEmbedding',
  'getLoreBooks',
  'getLoreBooksMain',
  'upsertLocalLoreBook',
  'loadLoreBooks',
  'loadLoreBooksMain',
] as const;

const shim = `local __host = api.host.call
local __json = api.json
local __state = api.state
local __input = api.input
local __null = __json.null
local __callbacks = {editRequest={}, editDisplay={}, editInput={}, editOutput={}}
local __id = "uimori-risu-invocation"
local function __risuDecode(value)
  if value == __null then return nil end
  if type(value) ~= "table" then return value end
  local result = {}
  for key, item in pairs(value) do result[key] = __risuDecode(item) end
  return result
end
local function __risuEncode(value, seen)
  if value == nil then return __null end
  if type(value) ~= "table" then return value end
  if seen[value] then error("RISU_LUA_JSON_CYCLE") end
  seen[value] = true
  local result = (next(value) == nil or rawget(value, 1) ~= nil) and __json.array({}) or __json.object({})
  for key, item in pairs(value) do result[key] = __risuEncode(item, seen) end
  seen[value] = nil
  return result
end
json = {
  encode=function(value) return __json.encode(__risuEncode(value, {})) end,
  decode=function(text) return __risuDecode(__json.decode(text)) end
}
function require(name)
  if name == "json" then return json end
  error("RISU_LUA_MODULE_UNSUPPORTED:" .. tostring(name))
end
function async(callback)
  if type(callback) ~= "function" then error("RISU_LUA_CALLBACK_INVALID") end
  return function(...) return callback(...) end
end
local function __readVariable(key)
  local page = __host("variables.read", {key=key, offset=0, limit=16000})
  local overridden, parts = page.overridden, {}
  if page.value == __null or page.value == nil then return nil, overridden end
  while true do
    parts[#parts + 1] = page.value
    if page.nextOffset == nil or page.nextOffset == __null then break end
    page = __host("variables.read", {key=key, offset=page.nextOffset, limit=16000})
  end
  return table.concat(parts), overridden
end
function getChatVar(id, key)
  local value = __readVariable(key)
  if value == nil then return "null" end
  return value
end
function setChatVar(id, key, value)
  if type(value) ~= "string" then error("RISU_LUA_VARIABLE_VALUE") end
  __host("variables.set", {key=key, value=value})
end
function setChatVarChanged(id, key, value)
  local before, overridden = __readVariable(key)
  if type(overridden) ~= "boolean" then error("RISU_LUA_VARIABLE_METADATA_REQUIRED") end
  -- Risu compares the stored override, not a resolved default with the same value.
  if overridden and before == value then return nil end
  setChatVar(id, key, value)
  return true
end
function getState(id, name) return json.decode(getChatVar(id, "__" .. name)) end
function setState(id, name, value) setChatVar(id, "__" .. name, json.encode(value)) end
function setStateChanged(id, name, value) return setChatVarChanged(id, "__" .. name, json.encode(value)) end
local __conversationTotal = nil
local __conversationPages, __conversationItems, __conversationText, __conversationChunks = {}, {}, {}, {}
local function __conversationPage(offset)
  if not __conversationPages[offset] then
    local page = __host("conversation.list", {offset=offset, limit=50})
    __conversationTotal = page.total
    for _, item in ipairs(page.items) do __conversationItems[item.index] = item end
    __conversationPages[offset] = true
  end
end
local function __conversationLength()
  if __conversationTotal == nil then __conversationPage(0) end
  return __conversationTotal
end
local function __conversationIndex(index)
  -- Array.at uses ToIntegerOrInfinity; the authored API's index domain is numeric.
  if index == nil then index = 0 end
  if type(index) ~= "number" then error("RISU_LUA_CONVERSATION_INDEX") end
  if index ~= index then index = 0 end
  if index == math.huge or index == -math.huge then return nil end
  index = index < 0 and math.ceil(index) or math.floor(index)
  local total = __conversationLength()
  if index < 0 then index = total + index end
  if index < 0 or index >= total then return nil end
  if __conversationItems[index] == nil then __conversationPage(math.floor(index / 50) * 50) end
  return index
end
local function __conversationFragment(fragment)
  local index = fragment.index
  __conversationItems[index] = {index=index, role=fragment.role, totalChars=fragment.totalChars}
  if __conversationText[index] ~= nil then return end
  local pending = __conversationChunks[index] or {parts={}, offset=0}
  if fragment.offset ~= pending.offset then error("RISU_LUA_CONVERSATION_FRAGMENT") end
  pending.parts[#pending.parts + 1] = fragment.text
  if fragment.nextOffset == nil or fragment.nextOffset == __null then
    __conversationText[index] = table.concat(pending.parts)
    __conversationChunks[index] = nil
  else
    pending.offset = fragment.nextOffset
    __conversationChunks[index] = pending
  end
end
local function __conversationRead(index)
  while __conversationText[index] == nil do
    local pending = __conversationChunks[index]
    __conversationFragment(__host("conversation.read", {index=index, offset=pending and pending.offset or 0, limit=16000}))
  end
  return __conversationText[index]
end
local function __conversationBatch(index)
  while __conversationText[index] == nil do
    local pending = __conversationChunks[index]
    local page = __host("conversation.page", {index=index, offset=pending and pending.offset or 0, limit=16000})
    if #page.items == 0 then error("RISU_LUA_CONVERSATION_FRAGMENT") end
    for _, fragment in ipairs(page.items) do __conversationFragment(fragment) end
  end
end
local function __risuChat(index)
  if index == nil then return nil end
  return {role=__conversationItems[index].role == "assistant" and "char" or "user", data=__conversationRead(index), time=0}
end
function getChat(id, index) return __risuChat(__conversationIndex(index)) end
function getChatMain(id, index) return json.encode(getChat(id, index)) end
function getChatData(id, index)
  index = __conversationIndex(index)
  if index == nil then return "" end
  return __conversationRead(index)
end
function getChatRole(id, index)
  index = __conversationIndex(index)
  if index == nil then return "" end
  return __conversationItems[index].role == "assistant" and "char" or "user"
end
function getChatLength(id) return __conversationLength() end
function getRecentChats(id, count)
  if count == nil then count = 0 end
  if type(count) ~= "number" then error("RISU_LUA_CONVERSATION_COUNT") end
  if count ~= count then count = 0 end
  count = math.max(0, math.floor(count))
  local total, result = __conversationLength(), {}
  for index = math.max(0, total - count), total - 1 do
    __conversationBatch(index)
    result[#result + 1] = __risuChat(index)
  end
  return result
end
function getRecentChatsMain(id, count) return json.encode(getRecentChats(id, count)) end
function getFullChat(id) return getRecentChats(id, __conversationLength()) end
function getFullChatMain(id) return json.encode(getFullChat(id)) end
local function __lastConversation(role)
  for index = __conversationLength() - 1, 0, -1 do
    if __conversationItems[index] == nil then __conversationPage(math.floor(index / 50) * 50) end
    if __conversationItems[index].role == role then return __conversationRead(index) end
  end
  if role == "assistant" then error("RISU_LUA_FIRST_MESSAGE_UNAVAILABLE") end
  return ""
end
function getUserLastMessage(id) return __lastConversation("user") end
function getCharacterLastMessage(id) return __lastConversation("assistant") end
function simpleLLM(id, prompt)
  local response = __host("model.generate", {prompt=prompt})
  local value = {success=response.status == "completed", result=response.text}
  if not value.success then value.result = "Error: " .. tostring(response.error) end
  return setmetatable(value, {__index={await=function(self) return self end}})
end
function listenEdit(event, callback)
  if __callbacks[event] == nil then error("RISU_LUA_EVENT_UNSUPPORTED:" .. tostring(event)) end
  if type(callback) ~= "function" then error("RISU_LUA_CALLBACK_INVALID") end
  table.insert(__callbacks[event], callback)
end
`;

/** Pure source construction. No Lua, callback, template, condition or model is evaluated here. */
export function buildRisuLuaProgram(source: string, event: RisuLuaEvent): ExtensionProgram {
  if (typeof source !== 'string' || !source.trim()) throw new Error('RISU_LUA_SOURCE_INVALID');
  if (!RISU_LUA_EVENTS.includes(event)) throw new Error('RISU_LUA_EVENT_UNSUPPORTED');
  const denials = unavailableApis
    .map((name) => `${name} = function(...) error("RISU_LUA_API_UNSUPPORTED:${name}") end`)
    .join('\n');
  const callback =
    event === 'input'
      ? 'onInput'
      : event === 'output'
        ? 'onOutput'
        : event === 'start'
          ? 'onStart'
          : event;
  const dispatcher = event.startsWith('edit')
    ? `local value = __input.value
for _, callback in ipairs(__callbacks["${event}"]) do value = callback(__id, value, __input.meta) end
if value == nil then value = __input.value end
return {state=__state, result=value}`
    : `local callback = ${callback}
if callback ~= nil then
  if type(callback) ~= "function" then error("RISU_LUA_CALLBACK_INVALID") end
  callback(__id${event === 'onButtonClick' ? ', __input' : ''})
end
return {state=__state, result=__null}`;
  const body = `${shim}\n${denials}\ndo\nlocal function __initialize()\n${source}\nend\n__initialize()\nend\n${dispatcher}`;
  if (body.length > EXTENSION_PROGRAM_MAX_SOURCE_CHARS) throw new Error('RISU_LUA_SOURCE_LIMIT');
  return {
    api: EXTENSION_PROGRAM_API,
    language: 'lua',
    capabilities: ['variables.read', 'variables.write', 'model.generate', 'conversation.read'],
    source: body,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const operation = (op: PromptOperation, ...args: PromptExpression[]): PromptExpression => ({
  op,
  args,
});
const displayed = (value: PromptExpression) => operation('replace', value, '', '');

/** Reuses CBS compilation; runtime-authored CBS needs a separate, bounded evaluation phase. */
function compileLuaConditions(raw: unknown): { when?: PromptExpression; runtimeCbsGuard: boolean } {
  if (!Array.isArray(raw)) throw new UnsupportedCbs('트리거 조건 목록이 올바르지 않아요.');
  if (!raw.length) return { runtimeCbsGuard: false };
  if (raw.length > 100)
    throw new UnsupportedCbs('트리거 조건이 네이티브 조건 개수 한도를 넘었어요.');
  const cbs = new RisuCbs(new Map(), { names: 'context' });
  let runtimeCbsGuard = false;
  const parsedText = (text: string): PromptExpression => {
    const nodes = cbs.template(text);
    const parts = nodes.map((node): PromptExpression => {
      if (node.kind === 'text') return node.text;
      if (node.kind === 'value') return displayed(node.expression);
      throw new UnsupportedCbs('조건 안의 CBS 블록은 아직 지원하지 않아요.');
    });
    return parts.length === 1 ? parts[0] : operation('join', operation('array', ...parts), '');
  };
  const conditions = raw.map((item): PromptExpression => {
    const condition = record(item);
    if (!condition || !['var', 'value'].includes(String(condition.type))) {
      if (condition?.type === 'chatindex' || condition?.type === 'exists')
        throw new UnsupportedCbs(
          '대화 개수·기록 검색 조건은 조회 범위가 정해질 때까지 연결하지 않아요.'
        );
      throw new UnsupportedCbs('지원하지 않는 트리거 조건 종류가 있어요.');
    }
    if (typeof condition.var !== 'string' || typeof condition.value !== 'string')
      throw new UnsupportedCbs('트리거 조건의 비교값이 문자열이 아니에요.');
    const left =
      condition.type === 'var'
        ? operation('coalesce', operation('get', { context: ['variables'] }, condition.var), 'null')
        : parsedText(condition.var);
    // Risu parses both operands even for unary operators; reject unsupported RHS CBS too.
    const right = parsedText(condition.value);
    let comparison: PromptExpression;
    switch (condition.operator) {
      case '=':
        comparison = operation('equal', left, right);
        break;
      case '!=':
        comparison = operation('notEqual', left, right);
        break;
      case 'true':
        comparison = operation(
          'any',
          operation('equal', left, 'true'),
          operation('equal', left, '1')
        );
        break;
      case 'null':
        comparison = operation('equal', left, 'null');
        break;
      // Risu rejects the inverse comparison. Preserve JS Number coercion and NaN passing.
      case '>':
        comparison = operation('not', operation('greaterEqual', right, left));
        break;
      case '<':
        comparison = operation('not', operation('greaterEqual', left, right));
        break;
      case '>=':
        comparison = operation('not', operation('greater', right, left));
        break;
      case '<=':
        comparison = operation('not', operation('greater', left, right));
        break;
      default:
        throw new UnsupportedCbs('지원하지 않는 트리거 비교 연산자가 있어요.');
    }
    const dynamicReads = new Map<string, PromptExpression>();
    const inspect = (expression: PromptExpression) => {
      if (!expression || typeof expression !== 'object' || !('op' in expression)) return;
      const collection = expression.args[0];
      if (
        expression.op === 'get' &&
        collection !== null &&
        typeof collection === 'object' &&
        'context' in collection &&
        collection.context.length === 1 &&
        collection.context[0] === 'variables'
      )
        dynamicReads.set(JSON.stringify(expression), operation('coalesce', expression, 'null'));
      expression.args.forEach(inspect);
    };
    inspect(left);
    inspect(right);
    if (!dynamicReads.size) return comparison;
    runtimeCbsGuard = true;
    return operation(
      'all',
      ...[...dynamicReads.values()].map((value) =>
        operation('not', operation('contains', displayed(value), '{{'))
      ),
      comparison
    );
  });
  return { when: validatePromptExpression(operation('all', ...conditions)), runtimeCbsGuard };
}

/** Import adapter for independent Lua triggers. Mixed effects are preserved, never reordered. */
export function adaptRisuLuaTriggers(
  triggers: unknown,
  options: RisuLuaAdapterOptions = {}
): {
  actions: BehaviorAction[];
  findings: RisuLuaFinding[];
  sources: RisuLuaSource[];
} {
  const actions: BehaviorAction[] = [],
    findings: RisuLuaFinding[] = [],
    sources: RisuLuaSource[] = [];
  const prefix = options.idPrefix ?? 'risu-lua';
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,49}$/u.test(prefix)) throw new Error('RISU_LUA_ID_PREFIX');
  if (!Array.isArray(triggers)) return { actions, findings, sources };
  const mapping: Partial<Record<RisuLuaEvent, BehaviorActionTrigger>> = {
    input: 'before-turn',
    editInput: 'before-turn',
    start: 'before-turn',
    editRequest: 'before-turn',
    output: 'after-turn',
    onButtonClick: 'user',
  };
  const hooks: Partial<Record<RisuLuaEvent, BehaviorActionHook>> = {
    input: 'input',
    editInput: 'edit-input',
    editRequest: 'edit-request',
  };
  triggers.forEach((value, triggerIndex) => {
    const trigger = record(value);
    if (!trigger || !Array.isArray(trigger.effect)) return;
    const effects = trigger.effect;
    effects.forEach((rawEffect, effectIndex) => {
      const effect = record(rawEffect);
      if (effect?.type !== 'triggerlua') return;
      const report = (code: string, message: string, event?: RisuLuaEvent) => {
        findings.push({ code, triggerIndex, effectIndex, ...(event ? { event } : {}), message });
      };
      if (typeof effect.code !== 'string' || !effect.code.trim()) {
        report('RISU_LUA_SOURCE_INVALID', 'Lua 소스가 없거나 비어 있어요.');
        return;
      }
      sources.push({ triggerIndex, effectIndex, source: effect.code });
      if (effectIndex !== 0 || effects.length !== 1) {
        report(
          'RISU_LUA_MIXED_EFFECTS_UNSUPPORTED',
          '여러 효과가 섞인 트리거는 원래 순서와 조건을 유지할 실행 경로가 필요해요. 소스만 보존했어요.'
        );
        return;
      }
      report(
        'RISU_LUA_PARTIAL_HOST',
        '채팅 변수·대화 읽기·simpleLLM은 허용된 범위에서 실행해요. 나머지 Risu API는 아직 지원하지 않아 호출하면 오류를 표시해요.'
      );
      report(
        'RISU_LUA_FRESH_INVOCATION',
        'Lua 전역값은 호출마다 초기화돼요. 호출 사이에 유지할 값은 getState/setState로 저장해야 해요.'
      );
      report(
        'RISU_LUA_CONVERSATION_PROJECTION',
        '대화 읽기는 현재 분기에 저장된 대화를 사용해요. 시간 정보가 없으면 0을 반환하며, 저장되지 않은 첫 인사 대체값은 지원하지 않아요. 전체 조회가 실행 한도를 넘으면 일부만 반환하지 않고 오류를 표시해요.'
      );
      let conditionPlan: ReturnType<typeof compileLuaConditions> | undefined;
      try {
        conditionPlan = compileLuaConditions(trigger.conditions);
        if (conditionPlan.runtimeCbsGuard)
          report(
            'RISU_LUA_CONDITION_RUNTIME_CBS',
            '조건에서 읽은 변수값 안에 CBS가 있으면 자동 실행을 보류해요. 일반 문자열 값과 가져올 때 해석 가능한 CBS 조건은 지원해요.'
          );
      } catch (error) {
        report(
          'RISU_LUA_CONDITIONS_UNSUPPORTED',
          `${error instanceof UnsupportedCbs ? error.message : '트리거 조건이 네이티브 실행 한도를 넘었어요.'} 조건 전체를 유지하기 위해 자동 콜백을 연결하지 않았어요.`
        );
      }
      for (const event of RISU_LUA_EVENTS) {
        if (event === 'editDisplay' || event === 'editOutput') {
          report(
            'RISU_LUA_PHASE_UNSUPPORTED',
            `${event} 변환은 원문이나 표시 결과를 안전하게 반영할 공통 실행 단계가 필요해 아직 연결하지 않았어요.`,
            event
          );
          continue;
        }
        const nativeTrigger = mapping[event];
        if (!nativeTrigger) {
          report(
            'RISU_LUA_PHASE_UNSUPPORTED',
            `${event} 콜백은 같은 실행 시점의 공통 훅이 없어 아직 연결하지 않았어요.`,
            event
          );
          continue;
        }
        // Risu runs listenEdit callbacks from the edit path itself, which ignores trigger conditions.
        const edit = event === 'editInput' || event === 'editRequest';
        if (event === 'editInput')
          report(
            'RISU_LUA_EDIT_INPUT_PROJECTION',
            'editInput은 저장한 요청 원문을 바꾸지 않고 이번 전송 사본에만 적용해요. 원문과 전송문은 Reader에서 비교할 수 있어요. Risu와 같이 트리거 조건은 이 콜백에 적용하지 않고, 대화 읽기에는 이번 입력을 덧붙이지 않아요.',
            event
          );
        if (event === 'editRequest')
          report(
            'RISU_LUA_EDIT_REQUEST_SCOPE',
            'editRequest는 전송용 원문 대화와 이번 요청만 {role,content} 목록으로 받아요. 시스템 프롬프트·로어·다른 자료의 지침은 넘기지 않고 메시지 수와 역할도 바꿀 수 없어요. 이 채팅에서 해당 자료 개정에 대화 읽기를 허용해야 실행하며, 대화가 실행 한도를 넘으면 편집을 건너뛰고 원문 그대로 보내요.',
            event
          );
        if (!edit && event !== 'onButtonClick' && !conditionPlan) continue;
        try {
          const button = event === 'onButtonClick';
          actions.push({
            id: `${prefix}-${triggerIndex}-${event}`,
            label: `Lua ${event}`,
            inputSchema: button
              ? { type: 'string', maxLength: 8000 }
              : event === 'editInput'
                ? structuredClone(BEHAVIOR_EDIT_INPUT_SCHEMA)
                : event === 'editRequest'
                  ? structuredClone(BEHAVIOR_EDIT_REQUEST_SCHEMA)
                  : { type: 'record', properties: {} },
            triggers: [nativeTrigger],
            ...(hooks[event] ? { hook: hooks[event]! } : {}),
            ...(button || edit ? {} : { automaticInput: {} }),
            ...(!button && !edit && conditionPlan?.when ? { when: conditionPlan.when } : {}),
            effects: [],
            program: buildRisuLuaProgram(effect.code, event),
          });
        } catch (error) {
          report(
            error instanceof Error ? error.message : 'RISU_LUA_SOURCE_INVALID',
            'Lua 소스를 네이티브 실행 한도 안에서 구성할 수 없어 해당 콜백을 연결하지 않았어요.',
            event
          );
        }
      }
    });
  });
  return { actions, findings, sources };
}
