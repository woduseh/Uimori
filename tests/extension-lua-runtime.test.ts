import { describe, expect, it } from 'vitest';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import { executeExtensionProgram } from '../server/extension-runtime.js';

const program = (source: string): ExtensionProgram => ({
  api: 'uimori-state-action-v1',
  language: 'lua',
  source,
});
const empty = () => ({ state: {}, input: {} });

describe('isolated native Lua extension runtime', () => {
  it('runs Lua 5.4 source with lexical scopes, functions, loops, and text-only load', async () => {
    const output = await executeExtensionProgram(
      program(`
      local function sum(n)
        local result = 0
        for i = 1, n do result = result + i end
        return result
      end
      local fn = assert(load('return api.state.count + 1'))
      return {state={count=fn()}, result={sum=sum(api.input.amount), version=_VERSION}}
    `),
      { state: { count: 2 }, input: { amount: 5 } }
    );
    expect(output).toEqual({
      state: { count: 3 },
      result: { sum: 15, version: 'Lua 5.4' },
      engine: 'wasmoon@1.16.0',
    });
  });

  it('preserves JSON null, arrays, objects, escaping, Unicode, and arbitrary object keys', async () => {
    const input = {
      nil: null,
      arrays: [[], [null, false, 0]],
      object: {},
      text: '가😀\u0000\n\\"\ud800',
      ['odd.key']: { quoted: 'value' },
    };
    const output = await executeExtensionProgram(
      program(`
      assert(api.input['nil'] == api.json.null)
      return {state=api.state, result={
        copied=api.json.decode(api.json.encode(api.input)),
        emptyArray=api.json.array(), emptyObject=api.json.object(), inferred={1,2},
        nilValue=api.json.null
      }}
    `),
      { state: [null, {}, []], input }
    );
    expect(output.state).toEqual([null, {}, []]);
    expect(output.result).toEqual({
      copied: input,
      emptyArray: [],
      emptyObject: {},
      inferred: [1, 2],
      nilValue: null,
    });
  });

  it('uses the common JSON Host broker sequentially and preserves safe error codes', async () => {
    const calls: unknown[] = [];
    const output = await executeExtensionProgram(
      program(`
      local first = api.host.call('variables.read', {key='count', value=api.json.null})
      local ok, err = pcall(api.host.call, 'variables.write', {value=first})
      return {state=api.state, result={first=first, ok=ok, error=err}}
    `),
      empty(),
      undefined,
      {
        host: async (method, args) => {
          calls.push({ method, args });
          if (method === 'variables.write') throw new ExtensionProgramError('BEHAVIOR_HOST_DENIED');
          return { nested: [null, [], {}] };
        },
      }
    );
    expect(calls).toEqual([
      { method: 'variables.read', args: { key: 'count', value: null } },
      { method: 'variables.write', args: { value: { nested: [null, [], {}] } } },
    ]);
    expect(output.result).toEqual({
      first: { nested: [null, [], {}] },
      ok: false,
      error: 'BEHAVIOR_HOST_DENIED',
    });
  });

  it('has no ambient Node, filesystem, network, debug, loaders, or JS userdata bridge', async () => {
    const output = await executeExtensionProgram(
      program(`
      for _, key in ipairs({'os','io','package','debug','require','dofile','loadfile','print','warn',
        'process','fetch','console','window','document','js','Promise','null','coroutine'}) do
        assert(_G[key] == nil, key)
      end
      assert(math.random == nil and math.randomseed == nil)
      assert(string.dump == nil and getmetatable('').__index.dump == nil)
      assert(load('return os')() == nil)
      assert(load(string.char(27)..'Lua') == nil)
      assert(load('return 1', 'binary', 'b') == nil)
      assert(load(function() return 'return 1' end) == nil)
      return {state=api.state, result=true}
    `),
      empty()
    );
    expect(output.result).toBe(true);
  });

  it.each([
    ['cycle', 'local a = {}; a.self = a; return {state={}, result=a}'],
    [
      'metatable',
      'return {state={}, result=setmetatable({}, {__index=function() while true do end end})}',
    ],
    ['function', 'return {state={}, result=function() end}'],
    ['sparse array', 'return {state={}, result={[1]=1,[3]=3}}'],
    ['mixed keys', 'return {state={}, result={[1]=1,name="x"}}'],
    ['non-finite', 'return {state={}, result=0/0}'],
    ['missing result', 'return {state={}}'],
    ['extra root field', 'return {state={}, result=true, effects={}}'],
    ['invalid UTF-8', 'return {state={}, result=string.char(255)}'],
  ])('rejects invalid results: %s', async (_, source) => {
    await expect(executeExtensionProgram(program(source), empty())).rejects.toMatchObject({
      code: 'BEHAVIOR_PROGRAM_RESULT_VALUE',
    });
  });

  it('bounds output bytes and guest memory without exposing private errors', async () => {
    await expect(
      executeExtensionProgram(program('return {state={}, result=string.rep("가",50000)}'), empty())
    ).rejects.toMatchObject({ code: 'BEHAVIOR_PROGRAM_OUTPUT_SIZE' });
    await expect(
      executeExtensionProgram(
        program('local s=string.rep("x", 32*1024*1024); return {state={},result=s}'),
        empty()
      )
    ).rejects.toMatchObject({ code: 'BEHAVIOR_PROGRAM_FAILED' });
    await expect(
      executeExtensionProgram(
        program(
          'error(setmetatable({}, {__tostring=function() error("private guest detail") end}))'
        ),
        empty()
      )
    ).rejects.toMatchObject({
      code: 'BEHAVIOR_PROGRAM_FAILED',
      message: 'BEHAVIOR_PROGRAM_FAILED',
    });
  });

  it('bounds CPU loops even when guest code catches hook errors', async () => {
    for (const source of [
      'while true do end',
      'while true do pcall(function() while true do end end) end',
    ]) {
      await expect(executeExtensionProgram(program(source), empty())).rejects.toMatchObject({
        code: 'BEHAVIOR_PROGRAM_TIMEOUT',
      });
    }
  });

  it('uses host-wait budget for delayed Host work then resumes active CPU enforcement', async () => {
    const source = `local value=api.host.call('variables.read', {}); return {state={},result=value}`;
    const output = await executeExtensionProgram(program(source), empty(), undefined, {
      hostWaitMs: 3000,
      host: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return 'done';
      },
    });
    expect(output.result).toBe('done');
    await expect(
      executeExtensionProgram(
        program(`api.host.call('variables.read', {}); while true do end`),
        empty(),
        undefined,
        {
          hostWaitMs: 3000,
          host: async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return null;
          },
        }
      )
    ).rejects.toMatchObject({ code: 'BEHAVIOR_PROGRAM_TIMEOUT' });
  });

  it('cancels a pending Host call and does not adopt its late result', async () => {
    const controller = new AbortController();
    let hostSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const work = executeExtensionProgram(
      program(`local x=api.host.call('variables.read', {}); return {state={saved=true},result=x}`),
      empty(),
      controller.signal,
      {
        hostWaitMs: 3000,
        host: async (_, __, signal) => {
          hostSignal = signal;
          controller.abort();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return 'late';
        },
      }
    );
    await expect(work).rejects.toMatchObject({ code: 'BEHAVIOR_PROGRAM_ABORTED' });
    expect(hostSignal?.aborted).toBe(true);
    release?.();
  });

  it('enforces Host call and argument limits in the guest bridge', async () => {
    let calls = 0;
    const output = await executeExtensionProgram(
      program(`
      local ok, err
      for i=1,33 do ok,err=pcall(api.host.call,'variables.read',{}) end
      return {state={},result={ok=ok,error=err}}
    `),
      empty(),
      undefined,
      {
        host: async () => {
          calls++;
          return null;
        },
        hostWaitMs: 3000,
      }
    );
    expect(calls).toBe(32);
    expect(output.result).toEqual({ ok: false, error: 'BEHAVIOR_HOST_CALL_LIMIT' });
    const invalid = await executeExtensionProgram(
      program(`
      local a={}; a.self=a
      local ok, err=pcall(api.host.call,'variables.read',a)
      return {state={},result={ok=ok,error=err}}
    `),
      empty(),
      undefined,
      {
        host: async () => {
          throw new Error('must not dispatch');
        },
      }
    );
    expect(invalid.result).toEqual({ ok: false, error: 'BEHAVIOR_HOST_ARGUMENTS' });
  });
});
