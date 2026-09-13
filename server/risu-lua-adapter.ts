import {
  EXTENSION_PROGRAM_API,
  EXTENSION_PROGRAM_MAX_SOURCE_CHARS,
  type ExtensionProgram,
} from '../core/extension-program.js';
import type { BehaviorAction, BehaviorActionTrigger } from '../core/package-behavior.js';

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
  'getChat',
  'getChatMain',
  'getChatData',
  'getChatRole',
  'getRecentChats',
  'getRecentChatsMain',
  'setChat',
  'setChatRole',
  'cutChat',
  'removeChat',
  'addChat',
  'insertChat',
  'getTokens',
  'getChatLength',
  'getFullChat',
  'getFullChatMain',
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
  'getCharacterLastMessage',
  'getUserLastMessage',
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
return {state=__state, result=value == nil and __null or value}`
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
    capabilities: ['variables.read', 'variables.write', 'model.generate'],
    source: body,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
    start: 'before-turn',
    output: 'after-turn',
    onButtonClick: 'user',
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
        '채팅 변수와 simpleLLM은 허용된 범위에서 실행해요. 나머지 Risu API는 아직 지원하지 않아 호출하면 오류를 표시해요.'
      );
      report(
        'RISU_LUA_FRESH_INVOCATION',
        'Lua 전역값은 호출마다 초기화돼요. 호출 사이에 유지할 값은 getState/setState로 저장해야 해요.'
      );
      const hasConditions = !Array.isArray(trigger.conditions) || trigger.conditions.length > 0;
      if (hasConditions)
        report(
          'RISU_LUA_CONDITIONS_UNSUPPORTED',
          '트리거 조건을 아직 재현하지 못해 자동 콜백을 연결하지 않았어요.'
        );
      for (const event of RISU_LUA_EVENTS) {
        if (event.startsWith('edit')) {
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
        if (event !== 'onButtonClick' && hasConditions) continue;
        try {
          const button = event === 'onButtonClick';
          actions.push({
            id: `${prefix}-${triggerIndex}-${event}`,
            label: `Lua ${event}`,
            inputSchema: button
              ? { type: 'string', maxLength: 8000 }
              : { type: 'record', properties: {} },
            triggers: [nativeTrigger],
            ...(button ? {} : { automaticInput: {} }),
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
