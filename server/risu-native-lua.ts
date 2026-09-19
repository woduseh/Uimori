/** Risu API bridge executed inside the existing JSON-only Lua worker sandbox. */
export const RISU_NATIVE_LUA_PRELUDE = String.raw`
local __json, __input, __host = api.json, api.input, api.host.call
local __load, __pcall, __pack, __unpack = load, pcall, table.pack, table.unpack
local __allowed
local function __scoped(allowed, callback, ...)
  local previous = __allowed
  __allowed = allowed and previous ~= false
  local result = __pack(__pcall(callback, ...))
  __allowed = previous
  if not result[1] then error(result[2], 0) end
  return __unpack(result, 2, result.n)
end
local __variables, __messages = __input.variables, __input.messages
local __callbacks = {editRequest={}, editDisplay={}, editInput={}, editOutput={}}
local __effects = {reloadDisplay=false, stopChat=false, notifications=__json.array({})}
local __id = 'uimori-native-risu'
local function __decode(value)
  if value == __json.null then return nil end
  if type(value) ~= 'table' then return value end
  local result = {}
  for key, item in pairs(value) do result[key] = __decode(item) end
  return result
end
local function __encode(value, seen)
  if value == nil then return __json.null end
  if type(value) ~= 'table' then return value end
  if seen[value] then error('RISU_NATIVE_JSON_CYCLE') end
  seen[value] = true
  local result = (next(value) == nil or rawget(value, 1) ~= nil) and __json.array({}) or __json.object({})
  for key, item in pairs(value) do result[key] = __encode(item, seen) end
  seen[value] = nil
  return result
end
json = {
  encode=function(value) return __json.encode(__encode(value, {})) end,
  decode=function(text) return __decode(__json.decode(text)) end
}
function require(name)
  if name == 'json' then return json end
  error('RISU_NATIVE_MODULE_UNSUPPORTED:' .. tostring(name))
end
function async(callback)
  if type(callback) ~= 'function' then error('RISU_NATIVE_CALLBACK_INVALID') end
  return function(...) return callback(...) end
end
local function __key(value)
  if type(value) ~= 'string' or value == '__proto__' or value == 'prototype' or value == 'constructor' then
    error('RISU_NATIVE_VARIABLE_INVALID')
  end
  return value
end
function getChatVar(id, key) return __variables[__key(key)] or 'null' end
function getGlobalVar(id, key) return __input.globalVariables[__key(key)] or 'null' end
function setChatVar(id, key, value)
  if type(value) ~= 'string' and type(value) ~= 'number' and type(value) ~= 'boolean' then
    error('RISU_NATIVE_VARIABLE_VALUE')
  end
  __variables[__key(key)] = tostring(value)
end
function setChatVarChanged(id, key, value)
  if __variables[__key(key)] == tostring(value) then return nil end
  setChatVar(id, key, value)
  return true
end
function getState(id, name) return json.decode(getChatVar(id, '__' .. name)) end
function setState(id, name, value) setChatVar(id, '__' .. name, json.encode(value)) end
function setStateChanged(id, name, value) return setChatVarChanged(id, '__' .. name, json.encode(value)) end
local function __index(index)
  if type(index) ~= 'number' or index ~= index or math.abs(index) == math.huge then error('RISU_NATIVE_CHAT_INDEX') end
  index = index < 0 and math.ceil(index) or math.floor(index)
  if index < 0 then index = #__messages + index end
  return index + 1
end
local function __copy(value) return __decode(__json.decode(__json.encode(value))) end
function getChat(id, index) return __copy(__messages[__index(index)] or __json.null) end
function getChatMain(id, index) return json.encode(getChat(id, index)) end
function getChatData(id, index) local chat = getChat(id, index); return chat and chat.data or '' end
function getChatRole(id, index) local chat = getChat(id, index); return chat and chat.role or '' end
function getChatLength(id) return #__messages end
function getFullChat(id) return __copy(__messages) end
function getFullChatMain(id) return __json.encode(__messages) end
function getRecentChats(id, count)
  local result = {}
  for i = math.max(1, #__messages - math.max(0, math.floor(count or 0)) + 1), #__messages do
    result[#result + 1] = __copy(__messages[i])
  end
  return result
end
function getRecentChatsMain(id, count) return json.encode(getRecentChats(id, count)) end
local function __writeChat()
  if __input.event == 'display' or __input.event == 'editDisplay' then error('RISU_NATIVE_DISPLAY_CHAT_WRITE_DENIED') end
end
function setChat(id, index, value)
  __writeChat()
  local chat = __messages[__index(index)]
  if chat then chat.data = value or '' end
end
function setChatRole(id, index, role)
  __writeChat()
  local chat = __messages[__index(index)]
  if chat then chat.role = role == 'user' and 'user' or 'char' end
end
function addChat(id, role, value)
  __writeChat()
  __messages[#__messages + 1] = {role=role == 'user' and 'user' or 'char', data=value or ''}
end
function insertChat(id, index, role, value)
  __writeChat()
  table.insert(__messages, math.max(1, math.min(#__messages + 1, __index(index))), {role=role == 'user' and 'user' or 'char', data=value or ''})
end
function removeChat(id, index)
  __writeChat()
  local at = __index(index)
  if at >= 1 and at <= #__messages then table.remove(__messages, at) end
end
function cutChat(id, first, last)
  __writeChat()
  local result = __json.array({})
  for i = math.max(1, __index(first)), math.min(#__messages, __index(last) - 1) do result[#result + 1] = __messages[i] end
  __messages = result
end
function setFullChat(id, value)
  __writeChat()
  local result = __json.array({})
  for _, message in ipairs(value) do
    if type(message) ~= 'table' or type(message.data) ~= 'string' or (message.role ~= 'char' and message.role ~= 'user') then error('RISU_NATIVE_CHAT_VALUE') end
    result[#result + 1] = {role=message.role, data=message.data, id=message.id}
  end
  __messages = result
end
function setFullChatMain(id, value) setFullChat(id, json.decode(value)) end
function getUserLastMessage(id)
  for i = #__messages, 1, -1 do if __messages[i].role == 'user' then return __messages[i].data end end
  return ''
end
function getCharacterLastMessage(id)
  for i = #__messages, 1, -1 do if __messages[i].role == 'char' then return __messages[i].data end end
  return __input.firstMessage
end
function getName(id) return __input.charName end
function getPersonaName(id) return __input.userName end
function getDescription(id) return __input.description end
function getCharacterFirstMessage(id) return __input.firstMessage end
function getBackgroundEmbedding(id) return __input.backgroundHTML end
function reloadDisplay(id) __effects.reloadDisplay = true end
function reloadChat(id) __effects.reloadDisplay = true end
function stopChat(id) __effects.stopChat = true end
local function __notify(kind, message)
  if __input.event == 'display' or __input.event == 'editDisplay' then error('RISU_NATIVE_DISPLAY_INTERACTION_DENIED') end
  if type(message) ~= 'string' then error('RISU_NATIVE_INTERACTION_ARGUMENT') end
  __effects.notifications[#__effects.notifications + 1] = {kind=kind, message=message}
end
function alertNormal(id, message) __notify('normal', message) end
function alertError(id, message) __notify('error', message) end
local function __interact(method, value)
  if __input.event == 'display' or __input.event == 'editDisplay' then error('RISU_NATIVE_DISPLAY_INTERACTION_DENIED') end
  local result = __decode(__host(method, {value=__encode(value, {})}))
  return {await=function() return result end}
end
function alertInput(id, value) return __interact('alertInput', value) end
function alertSelect(id, value) return __interact('alertSelect', value) end
function alertConfirm(id, value) return __interact('alertConfirm', value) end
math.random = function(first, last)
  return __host('random', {first=first or __json.null, last=last or __json.null})
end
math.randomseed = function(...) error('RISU_NATIVE_API_UNSUPPORTED:math.randomseed') end
function listenEdit(event, callback)
  if not __callbacks[event] or type(callback) ~= 'function' then error('RISU_NATIVE_CALLBACK_INVALID') end
  table.insert(__callbacks[event], callback)
end
local function __awaitable(value)
  if type(value) ~= 'table' then return value end
  return setmetatable(value, {__index={await=function(self) return self end}})
end
local function __model(method, script, allowed, id, prompt, multimodal, options)
  if not allowed or __allowed == false or __input.event == 'display' or __input.event == 'editDisplay' then error('RISU_NATIVE_MODEL_DENIED') end
  local result = __host(method, {__nativeScript=script, prompt=__encode(prompt, {}), useMultimodal=multimodal or false, options=__encode(options or {}, {})})
  return __awaitable(__decode(result))
end
function cbs(text)
  local result = __host('cbs', {text=text, variables=__variables, messages=__messages})
  __variables = result.variables
  return result.text
end
local __unsupported = {
 'getTokens', 'sleep', 'request', 'generateImage', 'similarity', 'getCharacterImage',
 'getPersonaImage', 'setName', 'setDescription', 'setCharacterFirstMessage', 'setBackgroundEmbedding',
 'getPersonaDescription', 'getAuthorsNote', 'getLoreBooks', 'loadLoreBooks', 'upsertLocalLoreBook',
 'hash', 'log', 'logMain'
}
for _, name in ipairs(__unsupported) do
  _G[name] = function(...) error('RISU_NATIVE_API_UNSUPPORTED:' .. name) end
end
-- Authored chunks have separate lexical scopes. The shared public globals preserve Risu local/global
-- lifetime without exposing this bridge's input, host RPC, permission stack or private loader.
local __globals = {}
for key, value in pairs(_G) do
  if key ~= 'api' and key ~= '_G' and key ~= 'load' and key ~= 'listenEdit' then __globals[key] = value end
end
local function __runScript(source, script, allowed)
  local env = {}
  local function wrap(callback)
    return function(...) return __scoped(allowed, callback, ...) end
  end
  env._G = env
  env.LLM = function(id, prompt, multimodal, options) return __model('LLM', script, allowed, id, prompt, multimodal, options) end
  env.axLLM = function(id, prompt, multimodal, options) return __model('axLLM', script, allowed, id, prompt, multimodal, options) end
  env.simpleLLM = function(id, prompt) return __model('simpleLLM', script, allowed, id, prompt, false, {}) end
  env.listenEdit = function(event, callback)
    if not __callbacks[event] or type(callback) ~= 'function' then error('RISU_NATIVE_CALLBACK_INVALID') end
    table.insert(__callbacks[event], wrap(callback))
  end
  env.load = function(source, name, mode, environment)
    local callback, err = __load(source, name, mode, environment or env)
    if not callback then return nil, err end
    return wrap(callback)
  end
  setmetatable(env, {
    __metatable='native-risu-script',
    __index=__globals,
    __newindex=function(_, key, value) __globals[key] = type(value) == 'function' and wrap(value) or value end,
    __pairs=function() return next, __globals, nil end,
  })
  local callback, err = __load(source, 'native-risu:' .. script, 't', env)
  if not callback then error(err, 0) end
  return __scoped(allowed, callback)
end
`;

export const RISU_NATIVE_LUA_DISPATCH = String.raw`
local function __dispatch()
  local event = __input.event
  local edit = ({display='editDisplay', request='editRequest'})[event] or event
  local value = __input.text
  if edit == 'editRequest' then value = __decode(__input.request) end
  if __callbacks[edit] then
    for _, callback in ipairs(__callbacks[edit]) do value = callback(__id, value, __decode(__input.meta)) end
  else
    local name = ({input='onInput', output='onOutput', start='onStart', button='onButtonClick'})[event]
    if event == 'manual' then name = __input.argument end
    local callback = name and __globals[name]
    if callback ~= nil then
      if type(callback) ~= 'function' then error('RISU_NATIVE_CALLBACK_INVALID') end
      local result = callback(__id, __input.argument)
      if result == false then __effects.stopChat = true end
    elseif event == 'manual' and not __input.manualHandled then error('RISU_NATIVE_TRIGGER_NOT_FOUND') end
  end
  local result = {ok=true, variables=__variables, messages=__messages, effects=__effects}
  if edit == 'editRequest' then result.request=__encode(value, {})
  elseif value ~= __json.null and value ~= nil then result.text=value end
  return result
end
local initialized, initializeError = pcall(__initialize)
while true do
  local ok, result
  if initialized then ok, result = pcall(__dispatch)
  else ok, result = false, initializeError end
  if not ok then result = {ok=false, error=type(result) == 'string' and result or 'RISU_NATIVE_LUA_FAILED'} end
  __input = __host('__native.next', result)
  __variables, __messages = __input.variables, __input.messages
  __effects = {reloadDisplay=false, stopChat=false, notifications=__json.array({})}
end
`;
