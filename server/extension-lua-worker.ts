import { LuaFactory, LuaLibraries, LuaReturn, LuaType } from 'wasmoon';
import { parentPort, workerData } from 'node:worker_threads';

const MAX_JSON_BYTES = 128 * 1024;
const MAX_HOST_RESULT_BYTES = 512 * 1024;
const LUA_MEMORY_BYTES = 8 * 1024 * 1024;
const CPU_MS = 100;
type Input = { source: string; inputJSON: string; hostErrorCodes: string[] };
type HostReply =
  | { type: 'host-result'; id: number; ok: true; json: string }
  | { type: 'host-result'; id: number; ok: false; code: string };

// wasmoon 1.16.0 does not expose Emscripten instantiate options. Its shipped memory
// section declares 256 initial / 32768 maximum pages. Restrict that declaration
// before instantiation, solely in this fresh Worker, without changing the package.
// A dependency with a different memory contract must be reviewed explicitly.
function fixedMemoryBinary(source: BufferSource): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(
    source instanceof ArrayBuffer ? source : source.buffer,
    source instanceof ArrayBuffer ? 0 : source.byteOffset,
    source.byteLength
  );
  let cursor = 8;
  const integer = () => {
    let value = 0;
    let shift = 0;
    while (cursor < bytes.length && shift < 35) {
      const byte = bytes[cursor++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error('LUA_WASM_MEMORY_CONTRACT');
  };
  while (cursor < bytes.length) {
    const start = cursor;
    const section = bytes[cursor++];
    const size = integer();
    const end = cursor + size;
    if (end > bytes.length) break;
    if (section === 5) {
      const expected = [1, 1, 128, 2, 128, 128, 2];
      if (size !== expected.length || expected.some((value, i) => bytes[cursor + i] !== value))
        break;
      const replacement = new Uint8Array([5, 6, 1, 1, 128, 2, 128, 2]);
      const result = new Uint8Array(start + replacement.length + bytes.length - end);
      result.set(bytes.subarray(0, start));
      result.set(replacement, start);
      result.set(bytes.subarray(end), start + replacement.length);
      return result;
    }
    cursor = end;
  }
  throw new Error('LUA_WASM_MEMORY_CONTRACT');
}

async function createEngine() {
  const original = WebAssembly.instantiate;
  let instantiated = false;
  WebAssembly.instantiate = (async (binary: BufferSource, imports?: WebAssembly.Imports) => {
    if (instantiated || binary instanceof WebAssembly.Module)
      throw new Error('LUA_WASM_MEMORY_CONTRACT');
    instantiated = true;
    return original(fixedMemoryBinary(binary), imports);
  }) as typeof WebAssembly.instantiate;
  try {
    const engine = await new LuaFactory().createEngine({
      openStandardLibs: false,
      enableProxy: false,
      injectObjects: false,
      traceAllocations: true,
    });
    if (!instantiated) throw new Error('LUA_WASM_MEMORY_CONTRACT');
    return engine;
  } finally {
    WebAssembly.instantiate = original;
  }
}

// Original, private Lua codec. JSON crosses the engine boundary only as strings;
// Wasmoon's getValue/assertOk/run helpers must never inspect guest objects/errors.
const HARNESS = String.raw`
local source, inputJSON = ...
local type, next, rawget, rawset = type, next, rawget, rawset
local getmetatable, setmetatable = getmetatable, setmetatable
local pcall, error, load = pcall, error, load
local concat, sort = table.concat, table.sort
local byte, sub, format, match = string.byte, string.sub, string.format, string.match
local utfchar, utfcodes = utf8.char, utf8.codes
local floor, huge, yield = math.floor, math.huge, coroutine.yield
local null, kinds = {}, setmetatable({}, {__mode='k'})
local function tagged(kind, value)
  if value == nil then value = {} end
  if type(value) ~= 'table' or value == null or getmetatable(value) ~= nil then error('JSON_VALUE', 0) end
  kinds[value] = kind
  return value
end
local function object(value) return tagged('object', value) end
local function array(value) return tagged('array', value) end
local function encode(value)
  local chunks, size, nodes, seen = {}, 0, 0, {}
  local function emit(text)
    size = size + #text
    if size > 131072 then error('JSON_SIZE', 0) end
    chunks[#chunks + 1] = text
  end
  local function quote(text)
    if #text > 131072 - size then error('JSON_SIZE', 0) end
    emit('"')
    for _, code in utfcodes(text, true) do
      if code == 34 then emit('\\"')
      elseif code == 92 then emit('\\\\')
      elseif code < 32 or (code >= 0xd800 and code <= 0xdfff) then emit(format('\\u%04x', code))
      elseif code > 0x10ffff then error('JSON_VALUE', 0)
      else emit(utfchar(code)) end
    end
    emit('"')
  end
  local visit
  visit = function(item, depth)
    nodes = nodes + 1
    if depth > 32 or nodes > 30000 then error('JSON_VALUE', 0) end
    local kind = type(item)
    if item == null then emit('null')
    elseif kind == 'string' then quote(item)
    elseif kind == 'boolean' then emit(item and 'true' or 'false')
    elseif kind == 'number' then
      if item ~= item or item == huge or item == -huge then error('JSON_VALUE', 0) end
      emit(format('%.17g', item))
    elseif kind == 'table' then
      if getmetatable(item) ~= nil or seen[item] then error('JSON_VALUE', 0) end
      seen[item] = true
      local count, maximum, numeric = 0, 0, true
      for key in next, item do
        count = count + 1
        if count > 2000 then error('JSON_VALUE', 0) end
        if type(key) ~= 'number' or key < 1 or key ~= floor(key) then numeric = false
        elseif key > maximum then maximum = key end
      end
      local isarray = kinds[item] == 'array' or (kinds[item] == nil and count > 0 and numeric)
      if isarray then
        if not numeric or maximum ~= count then error('JSON_VALUE', 0) end
        emit('[')
        for i = 1, count do
          if i > 1 then emit(',') end
          visit(rawget(item, i), depth + 1)
        end
        emit(']')
      else
        local keys = {}
        for key in next, item do
          if type(key) ~= 'string' then error('JSON_VALUE', 0) end
          keys[#keys + 1] = key
        end
        sort(keys)
        emit('{')
        for i = 1, #keys do
          if i > 1 then emit(',') end
          quote(keys[i]); emit(':'); visit(rawget(item, keys[i]), depth + 1)
        end
        emit('}')
      end
      seen[item] = nil
    else error('JSON_VALUE', 0) end
  end
  visit(value, 0)
  return concat(chunks)
end
local function decode(text)
  if type(text) ~= 'string' or #text > 131072 then error('JSON_VALUE', 0) end
  local at, nodes = 1, 0
  local function bad() error('JSON_VALUE', 0) end
  local function ws()
    while true do
      local c = byte(text, at)
      if c == 32 or c == 9 or c == 10 or c == 13 then at = at + 1 else return end
    end
  end
  local escapes = {['"']='"', ['\\']='\\', ['/']='/', b='\b', f='\f', n='\n', r='\r', t='\t'}
  local function hex()
    local word = sub(text, at, at + 3)
    if #word ~= 4 or not match(word, '^%x%x%x%x$') then bad() end
    at = at + 4
    return tonumber(word, 16)
  end
  local function str()
    at = at + 1
    local parts, begin = {}, at
    while at <= #text do
      local c = byte(text, at)
      if c == 34 then
        parts[#parts + 1] = sub(text, begin, at - 1)
        at = at + 1
        return concat(parts)
      elseif c == 92 then
        parts[#parts + 1] = sub(text, begin, at - 1)
        at = at + 1
        local esc = sub(text, at, at)
        at = at + 1
        if esc == 'u' then
          local code = hex()
          if code >= 0xd800 and code <= 0xdbff and sub(text, at, at + 1) == '\\u' then
            local saved = at
            at = at + 2
            local low = hex()
            if low >= 0xdc00 and low <= 0xdfff then code = 0x10000 + (code - 0xd800) * 1024 + low - 0xdc00
            else at = saved end
          end
          parts[#parts + 1] = utfchar(code)
        elseif escapes[esc] then parts[#parts + 1] = escapes[esc]
        else bad() end
        begin = at
      elseif c < 32 then bad()
      else at = at + 1 end
    end
    bad()
  end
  local parse
  parse = function(depth)
    ws(); nodes = nodes + 1
    if depth > 32 or nodes > 30000 then bad() end
    local c = sub(text, at, at)
    if c == '"' then return str()
    elseif c == '{' or c == '[' then
      local isarray = c == '['
      local value = isarray and array() or object()
      local ending = isarray and ']' or '}'
      at = at + 1; ws()
      if sub(text, at, at) == ending then at = at + 1; return value end
      local count = 0
      while true do
        count = count + 1
        if count > 2000 then bad() end
        local key = count
        if not isarray then
          if sub(text, at, at) ~= '"' then bad() end
          key = str(); ws()
          if sub(text, at, at) ~= ':' or rawget(value, key) ~= nil then bad() end
          at = at + 1
        end
        rawset(value, key, parse(depth + 1)); ws()
        c = sub(text, at, at); at = at + 1
        if c == ending then return value end
        if c ~= ',' then bad() end
        ws()
      end
    elseif sub(text, at, at + 3) == 'null' then at = at + 4; return null
    elseif sub(text, at, at + 3) == 'true' then at = at + 4; return true
    elseif sub(text, at, at + 4) == 'false' then at = at + 5; return false
    else
      local begin = at
      if c == '-' then at = at + 1 end
      c = sub(text, at, at)
      if c == '0' then at = at + 1
      elseif match(c, '^[1-9]$') then
        repeat at = at + 1 until not match(sub(text, at, at), '^%d$')
      else bad() end
      if sub(text, at, at) == '.' then
        at = at + 1
        if not match(sub(text, at, at), '^%d$') then bad() end
        repeat at = at + 1 until not match(sub(text, at, at), '^%d$')
      end
      c = sub(text, at, at)
      if c == 'e' or c == 'E' then
        at = at + 1; c = sub(text, at, at)
        if c == '+' or c == '-' then at = at + 1 end
        if not match(sub(text, at, at), '^%d$') then bad() end
        repeat at = at + 1 until not match(sub(text, at, at), '^%d$')
      end
      local value = tonumber(sub(text, begin, at - 1))
      if not value or value == huge or value == -huge then bad() end
      return value
    end
  end
  local value = parse(0); ws()
  if at <= #text then bad() end
  return value
end
local api = decode(inputJSON)
local calls, resultBytes = 0, 0
api.json = {encode=encode, decode=decode, null=null, object=object, array=array}
api.host = {call=function(method, args)
  if type(method) ~= 'string' or #method == 0 or #method > 80 then error('BEHAVIOR_HOST_ARGUMENTS', 0) end
  calls = calls + 1
  if calls > 32 then error('BEHAVIOR_HOST_CALL_LIMIT', 0) end
  local ok, argsJSON = pcall(encode, args)
  if not ok then error('BEHAVIOR_HOST_ARGUMENTS', 0) end
  local success, text = yield(method, argsJSON)
  if not success then error(text, 0) end
  resultBytes = resultBytes + #text
  if #text > 131072 or resultBytes > 524288 then error('BEHAVIOR_HOST_RESULT_LIMIT', 0) end
  return decode(text)
end}
local env = {
  api=api, _VERSION=_VERSION, assert=assert, error=error, ipairs=ipairs, next=next,
  pairs=pairs, pcall=pcall, xpcall=xpcall, select=select, tonumber=tonumber,
  tostring=tostring, type=type, rawequal=rawequal, rawget=rawget, rawset=rawset,
  rawlen=rawlen, getmetatable=getmetatable, setmetatable=setmetatable,
}
local function copy(value)
  local result = {}
  for key, item in next, value do result[key] = item end
  return result
end
env.table, env.string, env.math, env.utf8 = copy(table), copy(string), copy(math), copy(utf8)
-- The string metatable also references this library; remove the original entry.
string.dump, env.string.dump = nil, nil
env.math.random, env.math.randomseed = nil, nil
env._G = env
env.load = function(text, name, mode, environment)
  if type(text) ~= 'string' or (mode ~= nil and mode ~= 't') then return nil, 'LUA_TEXT_ONLY' end
  return load(text, name or 'extension', 't', environment or env)
end
local fn = load(source, 'extension', 't', env)
if not fn then return 'E' end
local ok, value = pcall(fn)
if not ok then return 'E' end
if type(value) ~= 'table' or value == null or getmetatable(value) ~= nil or kinds[value] == 'array'
  or rawget(value, 'state') == nil or rawget(value, 'result') == nil then return 'V' end
local count = 0
for key in next, value do
  count = count + 1
  if key ~= 'state' and key ~= 'result' then return 'V' end
end
if count ~= 2 then return 'V' end
local valid, encoded = pcall(encode, value)
if not valid then return encoded == 'JSON_SIZE' and 'L' or 'V' end
return 'O' .. encoded
`;

async function run() {
  const input = workerData as Input;
  const port = parentPort;
  if (!port) return;
  const fail = (code: string) => port.postMessage({ type: 'result', ok: false, code });
  if (
    !input ||
    typeof input.source !== 'string' ||
    typeof input.inputJSON !== 'string' ||
    Buffer.byteLength(input.source) > 4 * 1024 * 1024 ||
    Buffer.byteLength(input.inputJSON) > MAX_JSON_BYTES ||
    !Array.isArray(input.hostErrorCodes)
  ) {
    fail('BEHAVIOR_PROGRAM_INPUT_SIZE');
    return;
  }
  const engine = await createEngine();
  const global = engine.global;
  const lua = global.lua;
  global.setMemoryMax(LUA_MEMORY_BYTES);
  for (const library of [
    LuaLibraries.Base,
    LuaLibraries.Coroutine,
    LuaLibraries.Table,
    LuaLibraries.String,
    LuaLibraries.Math,
  ])
    global.loadLibrary(library);
  // wasmoon 1.16.0's loadLibrary(UTF8) accidentally opens string; call Lua directly.
  lua.luaopen_utf8(global.address);
  lua.lua_setglobal(global.address, 'utf8');
  // The engine opens JS userdata metatables internally but no instance, function,
  // proxy, object, or global from that bridge is passed into this guest sandbox.
  const thread = global.newThread();
  let cpuRemaining = CPU_MS;
  let deadline = 0;
  let timedOut = false;
  const hook = lua.module.addFunction((state: number) => {
    if (timedOut || performance.now() > deadline) {
      timedOut = true;
      lua.lua_pushstring(state, 'BEHAVIOR_PROGRAM_TIMEOUT');
      lua.lua_error(state);
    }
  }, 'vii');
  lua.lua_sethook(thread.address, hook, 8, 1000);
  thread.loadString(HARNESS, 'uimori-lua-harness');
  thread.pushValue(input.source);
  thread.pushValue(input.inputJSON);
  let args = 2;
  let phaseSequence = 0;
  let hostId = 0;
  let hostResultBytes = 0;
  const phase = (value: 'active' | 'host-wait', hostIds: number[]) =>
    port.postMessage({ type: 'phase', phase: value, sequence: ++phaseSequence, hostIds });
  while (true) {
    phase('active', []);
    const start = performance.now();
    deadline = start + cpuRemaining;
    const status = thread.resume(args);
    cpuRemaining -= performance.now() - start;
    if (timedOut || cpuRemaining <= 0) {
      fail('BEHAVIOR_PROGRAM_TIMEOUT');
      return;
    }
    if (status.result !== LuaReturn.Ok && status.result !== LuaReturn.Yield) {
      fail('BEHAVIOR_PROGRAM_FAILED');
      return;
    }
    // Only exact primitive strings are read. No Lua tostring/metamethod, userdata,
    // error formatting, or Wasmoon object conversion executes at this boundary.
    const stringAt = (index: number, max: number) => {
      if (
        lua.lua_type(thread.address, index) !== LuaType.String ||
        lua.lua_rawlen(thread.address, index) > max
      )
        throw new Error('LUA_PROTOCOL');
      return lua.lua_tolstring(thread.address, index, null);
    };
    if (status.result === LuaReturn.Ok) {
      if (status.resultCount !== 1) throw new Error('LUA_PROTOCOL');
      const result = stringAt(-1, MAX_JSON_BYTES + 1);
      if (result.startsWith('O'))
        port.postMessage({ type: 'result', ok: true, json: result.slice(1) });
      else
        fail(
          result === 'V'
            ? 'BEHAVIOR_PROGRAM_RESULT_VALUE'
            : result === 'L'
              ? 'BEHAVIOR_PROGRAM_OUTPUT_SIZE'
              : 'BEHAVIOR_PROGRAM_FAILED'
        );
      return;
    }
    if (status.resultCount !== 2 || ++hostId > 32) throw new Error('LUA_PROTOCOL');
    const method = stringAt(-2, 80);
    const argsJson = stringAt(-1, MAX_JSON_BYTES);
    thread.pop(2);
    const id = hostId;
    const response = new Promise<HostReply>((resolve, reject) => {
      port.once('message', (value: HostReply) => {
        if (
          !value ||
          value.type !== 'host-result' ||
          value.id !== id ||
          typeof value.ok !== 'boolean'
        )
          reject(new Error('LUA_PROTOCOL'));
        else resolve(value);
      });
    });
    port.postMessage({ type: 'host-call', id, method, argsJson });
    phase('host-wait', [id]);
    const result = await response;
    if (result.ok) {
      if (typeof result.json !== 'string') throw new Error('LUA_PROTOCOL');
      hostResultBytes += Buffer.byteLength(result.json);
      if (
        Buffer.byteLength(result.json) > MAX_JSON_BYTES ||
        hostResultBytes > MAX_HOST_RESULT_BYTES
      ) {
        thread.pushValue(false);
        thread.pushValue('BEHAVIOR_HOST_RESULT_LIMIT');
      } else {
        thread.pushValue(true);
        thread.pushValue(result.json);
      }
    } else {
      thread.pushValue(false);
      thread.pushValue(
        input.hostErrorCodes.includes(result.code) ? result.code : 'BEHAVIOR_HOST_CALL_FAILED'
      );
    }
    args = 2;
  }
}

void run().catch(() => {
  parentPort?.postMessage({ type: 'result', ok: false, code: 'BEHAVIOR_PROGRAM_RUNTIME_FAILED' });
});
