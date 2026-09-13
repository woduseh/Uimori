import { describe, expect, it } from 'vitest';
import { validateExtensionProgram } from '../core/extension-program.js';
import { defaultProfile, type ProfileSnapshot } from '../core/product.js';
import { createExtensionVariableSession } from '../server/extension-variables.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { executeExtensionProgram, type ExtensionHostHandler } from '../server/extension-runtime.js';
import { adaptRisuLuaTriggers, buildRisuLuaProgram } from '../server/risu-lua-adapter.js';

const trigger = (code: string, conditions: unknown[] = []) => ({
  type: 'start',
  conditions,
  effect: [{ type: 'triggerlua', code }],
});

describe('pure Risu Lua adaptation', () => {
  it('selects callbacks independently from start metadata and reports missing phases', () => {
    const source = 'function onOutput(id) setChatVar(id, "seen", "yes") end';
    const converted = adaptRisuLuaTriggers([trigger(source)]);
    expect(converted.actions.map((action) => [action.id, action.triggers])).toEqual([
      ['risu-lua-0-output', ['after-turn']],
      ['risu-lua-0-start', ['before-turn']],
      ['risu-lua-0-onButtonClick', ['user']],
    ]);
    expect(converted.sources).toEqual([{ triggerIndex: 0, effectIndex: 0, source }]);
    expect(
      converted.findings
        .filter((finding) => finding.code === 'RISU_LUA_PHASE_UNSUPPORTED')
        .map((finding) => finding.event)
    ).toEqual(['input', 'editRequest', 'editDisplay', 'editInput', 'editOutput']);
    for (const action of converted.actions)
      expect(validateExtensionProgram(action.program).language).toBe('lua');
  });

  it('does not execute source on import, keeps conditions, and does not reorder mixed effects', () => {
    const source = 'error("IMPORT_MUST_NOT_EXECUTE")';
    const input = [trigger(source, [{ type: 'var', var: 'x', operator: '=', value: '1' }])];
    const before = structuredClone(input);
    const converted = adaptRisuLuaTriggers(input);
    expect(input).toEqual(before);
    expect(converted.actions.map((action) => action.triggers)).toEqual([['user']]);
    expect(
      converted.findings.some((finding) => finding.code === 'RISU_LUA_CONDITIONS_UNSUPPORTED')
    ).toBe(true);
    const mixed = adaptRisuLuaTriggers([
      {
        ...trigger(source),
        effect: [
          { type: 'setvar', var: 'x', value: '1' },
          { type: 'triggerlua', code: source },
        ],
      },
    ]);
    expect(mixed.actions).toEqual([]);
    expect(mixed.sources[0].source).toBe(source);
    expect(mixed.findings[0].code).toBe('RISU_LUA_MIXED_EFFECTS_UNSUPPORTED');
  });

  it('preserves oversized source and reports the bounded program failure', () => {
    const source = '--' + 'x'.repeat(512 * 1024);
    const converted = adaptRisuLuaTriggers([trigger(source)]);
    expect(converted.actions).toEqual([]);
    expect(converted.sources[0].source).toBe(source);
    expect(converted.findings.some((finding) => finding.code === 'RISU_LUA_SOURCE_LIMIT')).toBe(
      true
    );
  });
});

describe('Risu callbacks through the native Lua Host bridge', () => {
  function variables(initial: Record<string, string> = {}, defaults: Record<string, string> = {}) {
    const values = { ...initial };
    const calls: { method: string; args: unknown }[] = [];
    const host: ExtensionHostHandler = async (method, input) => {
      const args = input as { key: string; offset?: number; limit?: number; value?: string };
      calls.push({ method, args });
      if (method === 'variables.set') {
        values[args.key] = args.value!;
        return null;
      }
      if (method !== 'variables.read') throw new Error('Unexpected Host method');
      const value = values[args.key] ?? defaults[args.key],
        offset = args.offset ?? 0,
        limit = args.limit ?? 16000;
      return {
        value: value === undefined ? null : value.slice(offset, offset + limit),
        offset,
        nextOffset: value !== undefined && offset + limit < value.length ? offset + limit : null,
        totalChars: value?.length ?? 0,
        overridden: Object.hasOwn(values, args.key),
      };
    };
    return { values, calls, host };
  }

  it('preserves missing, empty, paged strings and JSON state without passing guest IDs', async () => {
    const fixture = variables({ empty: '', long: 'x'.repeat(18000) });
    const source = `
function onStart(id)
  assert(getChatVar("foreign-chat", "missing") == "null")
  assert(getChatVar(id, "empty") == "")
  assert(#getChatVar(id, "long") == 18000)
  setState("foreign-chat", "bag", {items={}, enabled=false})
  local bag = getState(id, "bag")
  assert(bag.enabled == false and #bag.items == 0)
  setChatVar(id, "done", "yes")
end`;
    const result = await executeExtensionProgram(
      buildRisuLuaProgram(source, 'start'),
      { state: {}, input: {} },
      undefined,
      { host: fixture.host }
    );
    expect(result.state).toEqual({});
    expect(result.result).toBeNull();
    expect(fixture.values.done).toBe('yes');
    expect(JSON.parse(fixture.values.__bag)).toEqual({ items: [], enabled: false });
    expect(fixture.calls.every(({ args }) => !JSON.stringify(args).includes('foreign-chat'))).toBe(
      true
    );
  });

  it('runs dynamic and async button callbacks and does not invoke another event', async () => {
    const fixture = variables();
    const source = `
_G["on" .. "ButtonClick"] = async(function(id, data)
  setChatVar(id, "clicked", data)
end)
function onStart(id) error("WRONG_EVENT") end`;
    await executeExtensionProgram(
      buildRisuLuaProgram(source, 'onButtonClick'),
      { state: {}, input: 'open-menu' },
      undefined,
      { host: fixture.host }
    );
    expect(fixture.values.clicked).toBe('open-menu');
  });

  it('chains edit listeners in registration order and keeps JSON values', async () => {
    const source = `
listenEdit("editDisplay", function(id, value, meta) return value .. meta.suffix end)
listenEdit("editDisplay", function(id, value) return value .. "!" end)`;
    const result = await executeExtensionProgram(buildRisuLuaProgram(source, 'editDisplay'), {
      state: {},
      input: { value: 'text', meta: { suffix: '?' } },
    });
    expect(result.result).toBe('text?!');
  });

  it('Changed compares stored overrides and distinguishes nil, literal null, empty and JSON null', async () => {
    const fixture = variables({ empty: '', same: 'kept' }, { fallback: 'default' });
    const source = `
function onStart(id)
  assert(setChatVarChanged(id, "empty", "") == nil)
  assert(setChatVarChanged(id, "same", "kept") == nil)
  assert(setChatVarChanged(id, "missing", "null") == true)
  assert(setChatVarChanged(id, "missing", "null") == nil)
  assert(setChatVarChanged(id, "fallback", "default") == true)
  assert(getState(id, "absent") == nil)
  assert(json.encode({}) == "[]")
  assert(json.encode(nil) == "null")
  assert(json.decode('{"gone":null,"keep":false}').gone == nil)
  assert(json.decode('{"gone":null,"keep":false}').keep == false)
  assert(json.encode(json.decode('{"gone":null}')) == "[]")
  local holes = json.decode('[1,null,3]')
  assert(holes[1] == 1 and holes[2] == nil and holes[3] == 3)
  assert(not pcall(function() json.encode(holes) end))
  assert(json.encode(json.decode('[1,null]')) == "[1]")
  local fallback = getState(id, "absent") or {}
  assert(type(fallback) == "table")
  assert(setStateChanged(id, "nilState", nil) == true)
  assert(getState(id, "nilState") == nil)
end`;
    await executeExtensionProgram(
      buildRisuLuaProgram(source, 'start'),
      { state: {}, input: {} },
      undefined,
      { host: fixture.host }
    );
    expect(fixture.values).toEqual({
      empty: '',
      same: 'kept',
      missing: 'null',
      fallback: 'default',
      __nilState: 'null',
    });
    expect(
      fixture.calls.filter(
        (call) => call.method === 'variables.read' && (call.args as { key: string }).key === 'same'
      )
    ).toHaveLength(1);
  });

  it('delegates simpleLLM to the common Host and supports the Risu await result shape', async () => {
    const calls: unknown[] = [];
    const source = `
listenEdit("editDisplay", async(function(id, value)
  local result = simpleLLM("foreign-scope", value):await()
  assert(result.success)
  return result.result
end))`;
    const result = await executeExtensionProgram(
      buildRisuLuaProgram(source, 'editDisplay'),
      { state: {}, input: { value: 'prompt', meta: {} } },
      undefined,
      {
        host: async (method, args) => {
          calls.push({ method, args });
          return { status: 'completed', text: 'answer', error: null, truncated: false };
        },
      }
    );
    expect(result.result).toBe('answer');
    expect(calls).toEqual([{ method: 'model.generate', args: { prompt: 'prompt' } }]);
  });

  it('stages Changed through the real variable broker with defaults and exact revision grants', async () => {
    const pkg = fixtureBotInput().package;
    pkg.variableDefaults = { values: { inherited: 'same' } };
    const ref = { id: pkg.id, revision: pkg.revision, role: 'bot' as const };
    const profile: ProfileSnapshot = {
      ...defaultProfile('synthetic-chat'),
      contents: [],
      models: {},
      packages: [pkg],
      packageAttachments: [ref],
      extensionGrants: {
        [`${pkg.id}:bot`]: { packageRevision: pkg.revision, capabilities: ['variables.write'] },
      },
    };
    const program = buildRisuLuaProgram(
      `
function onStart(id)
  assert(getChatVar(id, "inherited") == "same")
  assert(setChatVarChanged(id, "inherited", "same") == true)
  assert(setChatVarChanged(id, "inherited", "same") == nil)
end`,
      'start'
    );
    const broker = createExtensionVariableSession(
      program,
      profile,
      ref,
      () => {},
      () => {}
    );
    await executeExtensionProgram(program, { state: {}, input: {} }, undefined, {
      host: broker.host,
    });
    expect(broker.receipt()?.changes).toEqual({ inherited: 'same' });
    expect(broker.generation).toBe(1);
    expect(profile.variableState).toBeUndefined();
  });

  it('fails unsupported Risu APIs explicitly and only provides the JSON module', async () => {
    const source = `
listenEdit("editDisplay", function(id, value)
  local allowed, err = pcall(function() setChat(id, 0, "replacement") end)
  assert(not allowed and string.find(err, "RISU_LUA_API_UNSUPPORTED:setChat", 1, true))
  local loaded, failure = pcall(function() require("socket") end)
  assert(not loaded and string.find(failure, "RISU_LUA_MODULE_UNSUPPORTED:socket", 1, true))
  assert(require("json") == json)
  return value
end)`;
    const result = await executeExtensionProgram(buildRisuLuaProgram(source, 'editDisplay'), {
      state: {},
      input: { value: 'unchanged', meta: {} },
    });
    expect(result.result).toBe('unchanged');
  });
});
