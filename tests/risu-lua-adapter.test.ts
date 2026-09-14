import { describe, expect, it } from 'vitest';
import { ExtensionProgramError, validateExtensionProgram } from '../core/extension-program.js';
import { defaultProfile, type ProfileSnapshot } from '../core/product.js';
import { createExtensionVariableSession } from '../server/extension-variables.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { executeExtensionProgram, type ExtensionHostHandler } from '../server/extension-runtime.js';
import { adaptRisuLuaTriggers, buildRisuLuaProgram } from '../server/risu-lua-adapter.js';
import {
  BEHAVIOR_EDIT_INPUT_SCHEMA,
  behaviorActionAllowed,
  validatePackageBehavior,
} from '../core/package-behavior.js';
import { extensionEditHookInput } from '../server/extension-request-edit.js';
import type { RuntimeValue } from '../core/prompt-values.js';

const trigger = (code: string, conditions: unknown[] = []) => ({
  type: 'start',
  conditions,
  effect: [{ type: 'triggerlua', code }],
});

describe('pure Risu Lua adaptation', () => {
  it('selects callbacks independently from start metadata and reports missing phases', () => {
    const source = 'function onOutput(id) setChatVar(id, "seen", "yes") end';
    const converted = adaptRisuLuaTriggers([trigger(source)]);
    expect(converted.actions.map((action) => [action.id, action.triggers, action.hook])).toEqual([
      ['risu-lua-0-input', ['before-turn'], 'input'],
      ['risu-lua-0-output', ['after-turn'], undefined],
      ['risu-lua-0-start', ['before-turn'], undefined],
      ['risu-lua-0-onButtonClick', ['user'], undefined],
      ['risu-lua-0-editRequest', ['before-turn'], 'edit-request'],
      ['risu-lua-0-editDisplay', ['after-turn'], 'edit-display'],
      ['risu-lua-0-editInput', ['before-turn'], 'edit-input'],
      ['risu-lua-0-editOutput', ['after-turn'], 'edit-output'],
    ]);
    expect(converted.sources).toEqual([{ triggerIndex: 0, effectIndex: 0, source }]);
    expect(
      converted.findings.filter((finding) => finding.code === 'RISU_LUA_PHASE_UNSUPPORTED')
    ).toEqual([]);
    for (const action of converted.actions)
      expect(validateExtensionProgram(action.program).language).toBe('lua');
  });

  it('does not execute source on import, keeps conditions, and does not reorder mixed effects', () => {
    const source = 'error("IMPORT_MUST_NOT_EXECUTE")';
    const input = [trigger(source, [{ type: 'chatindex', operator: '=', value: '1' }])];
    const before = structuredClone(input);
    const converted = adaptRisuLuaTriggers(input);
    expect(input).toEqual(before);
    // Risu runs edit callbacks from the edit path, which never evaluates trigger conditions.
    expect(converted.actions.map((action) => [action.id, action.hook])).toEqual([
      ['risu-lua-0-onButtonClick', undefined],
      ['risu-lua-0-editRequest', 'edit-request'],
      ['risu-lua-0-editDisplay', 'edit-display'],
      ['risu-lua-0-editInput', 'edit-input'],
      ['risu-lua-0-editOutput', 'edit-output'],
    ]);
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
    // The sibling effect has no operator, so the whole trigger keeps its original declaration.
    expect(mixed.findings.some((f) => f.code === 'RISU_TRIGGER_EFFECTS_UNSUPPORTED')).toBe(true);
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

  it('preserves the input callback conditions and empty automatic input', () => {
    const converted = adaptRisuLuaTriggers([
      trigger('function onInput(id) end', [
        { type: 'value', var: 'disabled', operator: '=', value: 'enabled' },
      ]),
    ]);
    expect(() =>
      validatePackageBehavior({
        revision: 1,
        schemaVersion: 1,
        stateSchema: { type: 'record', properties: {} },
        initialState: {},
        actions: converted.actions,
        outputParsers: [],
      })
    ).not.toThrow();
    const input = converted.actions.find((action) => action.hook === 'input')!;
    expect(input.automaticInput).toEqual({});
    expect(behaviorActionAllowed(input, {}, {}, {})).toBe(false);
  });

  it('accepts the host-owned edit input without a declared value or condition', () => {
    const converted = adaptRisuLuaTriggers([
      trigger('listenEdit("editInput", function(id, value) return value end)', [
        { type: 'value', var: 'ready', operator: '=', value: 'ready' },
      ]),
    ]);
    const edit = converted.actions.find((action) => action.hook === 'edit-input')!;
    expect(edit.inputSchema).toEqual(BEHAVIOR_EDIT_INPUT_SCHEMA);
    expect(edit.automaticInput).toBeUndefined();
    expect(edit.when).toBeUndefined();
    expect(() =>
      validatePackageBehavior({
        revision: 1,
        schemaVersion: 1,
        stateSchema: { type: 'record', properties: {} },
        initialState: {},
        actions: converted.actions,
        outputParsers: [],
      })
    ).not.toThrow();
    expect(behaviorActionAllowed(edit, {}, extensionEditHookInput('요청'), {})).toBe(true);
    expect(() => behaviorActionAllowed(edit, {}, {}, {})).toThrow('BEHAVIOR_RECORD_FIELDS');
    expect(
      converted.findings.some((finding) => finding.code === 'RISU_LUA_EDIT_INPUT_PROJECTION')
    ).toBe(true);
  });

  it('runs edit callbacks over the submitted text and keeps the original for a nil result', async () => {
    const program = buildRisuLuaProgram(
      `listenEdit("editInput", function(id, value, meta) return value .. "[" .. meta.index .. "]" end)`,
      'editInput'
    );
    const edited = await executeExtensionProgram(program, {
      state: {},
      input: extensionEditHookInput('안녕'),
    });
    expect(edited.result).toBe('안녕[-1]');
    const untouched = await executeExtensionProgram(
      buildRisuLuaProgram(
        'listenEdit("editInput", function(id, value) return nil end)',
        'editInput'
      ),
      { state: {}, input: extensionEditHookInput('안녕') }
    );
    expect(untouched.result).toBe('안녕');
  });
});

describe('Risu Lua automatic conditions', () => {
  const source = 'function onStart(id) error("ONLY_AT_EXECUTION") end';
  const automatic = (conditions: unknown[]) => {
    const converted = adaptRisuLuaTriggers([trigger(source, conditions)]);
    const action = converted.actions.find(
      (item) => item.triggers?.includes('before-turn') && item.hook === undefined
    );
    expect(action).toBeDefined();
    return action!;
  };

  it.each([
    ['=', '01', '1', false],
    ['!=', '01', '1', true],
    ['=', '', '', true],
    ['null', '', '', false],
    ['null', 'null', '', true],
    ['true', 'true', '', true],
    ['true', '1', '', true],
    ['true', 'TRUE', '', false],
    ['true', ' 1', '', false],
    ['true', '01', '', false],
    ['>', '', '-1', true],
    ['<', ' ', '1', true],
    ['>=', '0x10', '16', true],
    ['<=', '1e2', '100', true],
    ['>', 'Infinity', '1', true],
    ['<', '-Infinity', '0', true],
    ['>', 'word', '1', true],
    ['<', '1', 'word', true],
    ['>=', 'null', '1', true],
    ['<=', '1', 'NaN', true],
    ['>', '2', '2', false],
    ['<', '2', '2', false],
    ['>=', '2', '2', true],
    ['<=', '2', '2', true],
  ] as const)('preserves %s with %j and %j -> %s', (operator, left, right, expected) => {
    const action = automatic([{ type: 'value', var: left, operator, value: right }]);
    expect(behaviorActionAllowed(action, {}, {}, {})).toBe(expected);
  });

  it('resolves variable missing and empty distinctly and applies every AND condition', () => {
    const action = automatic([
      { type: 'var', var: 'missing', operator: 'null', value: '' },
      { type: 'var', var: 'empty', operator: '=', value: '' },
      { type: 'var', var: 'enabled', operator: 'true', value: '' },
    ]);
    expect(behaviorActionAllowed(action, {}, {}, { variables: { empty: '', enabled: '1' } })).toBe(
      true
    );
    expect(behaviorActionAllowed(action, {}, {}, { variables: { empty: '', enabled: '0' } })).toBe(
      false
    );
    expect(behaviorActionAllowed(action, {}, {}, { variables: { enabled: '1' } })).toBe(false);
  });

  it('uses the existing CBS compiler for text concatenation, nested variables and identities', () => {
    const action = automatic([
      { type: 'value', var: 'hello {{char}}', operator: '=', value: 'hello Bot' },
      { type: 'value', var: '{{getvar::{{getvar::key}}}}', operator: '=', value: '{{user}}' },
      { type: 'value', var: '{{equal::yes::yes}}', operator: 'true', value: '' },
    ]);
    expect(
      behaviorActionAllowed(
        action,
        {},
        {},
        {
          variables: { key: 'person', person: 'User' },
          bot: { name: 'Bot' },
          user: { name: 'User' },
        }
      )
    ).toBe(true);
  });

  it('treats a variable condition key literally and blocks runtime-authored CBS as one whole condition', () => {
    const action = automatic([
      { type: 'var', var: '{{getvar::key}}', operator: '=', value: 'yes' },
    ]);
    expect(
      behaviorActionAllowed(
        action,
        {},
        {},
        { variables: { '{{getvar::key}}': 'yes', key: 'other' } }
      )
    ).toBe(true);
    expect(
      behaviorActionAllowed(action, {}, {}, { variables: { '{{getvar::key}}': '{{getvar::yes}}' } })
    ).toBe(false);
    const nested = automatic([
      { type: 'value', var: '{{equal::{{getvar::text}}::yes}}', operator: 'null', value: '' },
    ]);
    expect(
      behaviorActionAllowed(nested, {}, {}, { variables: { text: '{{getvar::other}}' } })
    ).toBe(false);
    expect(
      adaptRisuLuaTriggers([
        trigger(source, [{ type: 'var', var: 'text', operator: '=', value: 'yes' }]),
      ]).findings.some((finding) => finding.code === 'RISU_LUA_CONDITION_RUNTIME_CBS')
    ).toBe(true);
  });

  it.each([
    { type: 'chatindex', operator: '>', value: '0' },
    { type: 'exists', type2: 'strict', depth: 5, value: 'word' },
    { type: 'value', var: '{{unsupported}}', operator: '=', value: 'word' },
    { type: 'value', var: '1', operator: 'true', value: '{{unsupported}}' },
    { type: 'var', var: 'value', operator: 'unknown', value: '1' },
  ])(
    'does not execute a partial AND or condition-gate the button for unsupported %j',
    (unsupported) => {
      const converted = adaptRisuLuaTriggers([
        trigger(source, [{ type: 'value', var: '1', operator: '=', value: '1' }, unsupported]),
      ]);
      expect(converted.actions.map((action) => [action.id, action.hook])).toEqual([
        ['risu-lua-0-onButtonClick', undefined],
        ['risu-lua-0-editRequest', 'edit-request'],
        ['risu-lua-0-editDisplay', 'edit-display'],
        ['risu-lua-0-editInput', 'edit-input'],
        ['risu-lua-0-editOutput', 'edit-output'],
      ]);
      expect(converted.actions.every((action) => action.when === undefined)).toBe(true);
      expect(
        converted.findings.some((finding) => finding.code === 'RISU_LUA_CONDITIONS_UNSUPPORTED')
      ).toBe(true);
    }
  );

  it('preserves conditions and reports native expression limits instead of trimming', () => {
    const conditions = Array.from({ length: 101 }, () => ({
      type: 'value',
      var: '1',
      operator: '=',
      value: '1',
    }));
    const input = [trigger(source, conditions)],
      before = structuredClone(input);
    const converted = adaptRisuLuaTriggers(input);
    expect(converted.actions.map((item) => [item.id, item.hook])).toEqual([
      ['risu-lua-0-onButtonClick', undefined],
      ['risu-lua-0-editRequest', 'edit-request'],
      ['risu-lua-0-editDisplay', 'edit-display'],
      ['risu-lua-0-editInput', 'edit-input'],
      ['risu-lua-0-editOutput', 'edit-output'],
    ]);
    expect(input).toEqual(before);
    expect(
      converted.findings.some((finding) => finding.code === 'RISU_LUA_CONDITIONS_UNSUPPORTED')
    ).toBe(true);
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

  it('runs onInput independently from onStart without a fabricated value argument', async () => {
    const fixture = variables();
    await executeExtensionProgram(
      buildRisuLuaProgram(
        `function onInput(id, value)
  assert(value == nil)
  setChatVar(id, "phase", "input")
end
function onStart(id) error("WRONG_EVENT") end`,
        'input'
      ),
      { state: {}, input: {} },
      undefined,
      { host: fixture.host }
    );
    expect(fixture.values.phase).toBe('input');
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

describe('Risu conversation readers through the native Host', () => {
  function conversation(messages: { role: 'user' | 'assistant'; text: string }[]) {
    const calls: { method: string; args: unknown }[] = [];
    const host: ExtensionHostHandler = async (method, raw): Promise<RuntimeValue> => {
      const args = raw as { index?: number; offset: number; limit: number };
      calls.push({ method, args });
      if (method === 'conversation.list') {
        const items = messages.slice(args.offset, args.offset + args.limit).map((message, at) => ({
          index: args.offset + at,
          role: message.role,
          totalChars: message.text.length,
        }));
        return {
          items,
          nextOffset:
            args.offset + items.length < messages.length ? args.offset + items.length : null,
          total: messages.length,
        };
      }
      if (method === 'conversation.page') {
        const items: {
          index: number;
          role: 'user' | 'assistant';
          text: string;
          offset: number;
          nextOffset: number | null;
          totalChars: number;
        }[] = [];
        let remaining = args.limit,
          index = args.index ?? 0,
          offset = args.offset;
        while (index < messages.length && remaining > 0 && items.length < 50) {
          const message = messages[index],
            text = message.text.slice(offset, offset + remaining);
          const nextOffset =
            offset + text.length < message.text.length ? offset + text.length : null;
          items.push({
            index,
            role: message.role,
            text,
            offset,
            nextOffset,
            totalChars: message.text.length,
          });
          remaining -= text.length;
          if (nextOffset !== null) {
            offset = nextOffset;
            break;
          }
          index++;
          offset = 0;
        }
        return {
          items,
          next: index < messages.length ? { index, offset } : null,
          total: messages.length,
        };
      }
      if (method !== 'conversation.read') throw new Error('Unexpected Host method');
      const message = messages[args.index!];
      const text = message.text.slice(args.offset, args.offset + args.limit);
      return {
        index: args.index!,
        role: message.role,
        text,
        offset: args.offset,
        nextOffset:
          args.offset + text.length < message.text.length ? args.offset + text.length : null,
        totalChars: message.text.length,
      };
    };
    return { host, calls };
  }

  it('preserves zero-based and negative at indices, Risu shape, strings and cached copies', async () => {
    const fixture = conversation([
      { role: 'assistant', text: 'greeting' },
      { role: 'user', text: '' },
      { role: 'assistant', text: 'x'.repeat(18000) },
      { role: 'user', text: 'latest' },
    ]);
    const program = buildRisuLuaProgram(
      `
function onStart(id)
  assert(getChatLength("foreign-chat") == 4)
  local first = getChat(id, 0)
  assert(first.role == "char" and first.data == "greeting" and first.time == 0)
  first.data = "local-only"
  assert(getChat(id, 0).data == "greeting")
  assert(getChat(id, -1).data == "latest")
  assert(getChatData(id, -1.8) == "latest")
  assert(getChatData(id, 0.8) == "greeting")
  assert(getChatData(id, 0/0) == "greeting")
  assert(getChatData(id, 1) == "")
  assert(getChatRole(id, 1) == "user")
  assert(getChat(id, -5) == nil and getChat(id, 4) == nil)
  assert(getChatMain(id, 4) == "null")
  assert(getChatData(id, 4) == "" and getChatRole(id, 4) == "")
  assert(getChat(id, math.huge) == nil and getChat(id, -math.huge) == nil)
  assert(#getChatData(id, 2) == 18000)
  assert(#getCharacterLastMessage(id) == 18000 and getUserLastMessage(id) == "latest")
  local decoded = json.decode(getChatMain(id, 0))
  assert(decoded.role == "char" and decoded.data == "greeting" and decoded.time == 0)
  assert(#getFullChat(id) == 4 and #json.decode(getFullChatMain(id)) == 4)
end`,
      'start'
    );
    await executeExtensionProgram(program, { state: {}, input: {} }, undefined, {
      host: fixture.host,
    });
    expect(program.capabilities).toContain('conversation.read');
    expect(fixture.calls).toHaveLength(6);
    expect(fixture.calls.filter((call) => call.method === 'conversation.list')).toHaveLength(1);
    expect(fixture.calls.every((call) => !JSON.stringify(call.args).includes('foreign-chat'))).toBe(
      true
    );
  });

  it('matches safe recent count including zero, negative, fractional, NaN and infinity', async () => {
    const fixture = conversation([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'middle' },
      { role: 'user', text: 'last' },
    ]);
    await executeExtensionProgram(
      buildRisuLuaProgram(
        `
function onStart(id)
  assert(#getRecentChats(id, 0) == 0 and #getRecentChats(id, -2) == 0)
  assert(#getRecentChats(id, 0/0) == 0 and #getRecentChats(id) == 0)
  assert(getRecentChatsMain(id, 0) == "[]")
  local recent = getRecentChats(id, 2.9)
  assert(#recent == 2 and recent[1].data == "middle" and recent[2].data == "last")
  assert(#getRecentChats(id, math.huge) == 3 and #getRecentChats(id, -math.huge) == 0)
  assert(#json.decode(getRecentChatsMain(id, 100)) == 3)
end`,
        'start'
      ),
      { state: {}, input: {} },
      undefined,
      { host: fixture.host }
    );
    expect(fixture.calls).toHaveLength(3);
  });

  it('reuses metadata pages while looking backward without reading unrelated message text', async () => {
    const fixture = conversation(
      Array.from({ length: 65 }, (_, index) => ({
        role: index === 49 ? ('assistant' as const) : ('user' as const),
        text: `message-${index}`,
      }))
    );
    await executeExtensionProgram(
      buildRisuLuaProgram(
        `
function onStart(id)
  assert(getCharacterLastMessage(id) == "message-49")
  assert(getUserLastMessage(id) == "message-64")
  assert(getChatData(id, -1) == "message-64")
end`,
        'start'
      ),
      { state: {}, input: {} },
      undefined,
      { host: fixture.host }
    );
    expect(fixture.calls.filter((call) => call.method === 'conversation.list')).toHaveLength(2);
    expect(
      fixture.calls
        .filter((call) => call.method === 'conversation.read')
        .map((call) => (call.args as { index: number }).index)
    ).toEqual([49, 64]);
  });

  it('batches full chat beyond the Host call count and reuses long-message fragments', async () => {
    const fixture = conversation(
      Array.from({ length: 65 }, (_, index) => ({
        role: index % 2 ? ('user' as const) : ('assistant' as const),
        text: index === 51 ? 'x'.repeat(18000) : index === 52 ? '' : `message-${index}`,
      }))
    );
    await executeExtensionProgram(
      buildRisuLuaProgram(
        `
function onStart(id)
  local all = getFullChat(id)
  assert(#all == 65 and all[1].data == "message-0" and all[65].data == "message-64")
  assert(#all[52].data == 18000 and all[53].data == "")
  assert(#getChatData(id, 51) == 18000 and getChatRole(id, 51) == "user")
  assert(#getFullChat(id) == 65)
end`,
        'start'
      ),
      { state: {}, input: {} },
      undefined,
      { host: fixture.host }
    );
    expect(fixture.calls.filter((call) => call.method === 'conversation.page')).toHaveLength(3);
    expect(fixture.calls.filter((call) => call.method === 'conversation.read')).toHaveLength(0);
    expect(fixture.calls).toHaveLength(4);
  });

  it('starts a recent batch at the requested tail without disclosing older message text', async () => {
    const fixture = conversation(
      Array.from({ length: 65 }, (_, index) => ({
        role: 'user' as const,
        text: `message-${index}`,
      }))
    );
    await executeExtensionProgram(
      buildRisuLuaProgram(
        `
function onStart(id)
  local recent = getRecentChats(id, 2)
  assert(#recent == 2 and recent[1].data == "message-63")
  assert(getChatData(id, -1) == "message-64")
end`,
        'start'
      ),
      { state: {}, input: {} },
      undefined,
      { host: fixture.host }
    );
    expect(fixture.calls.filter((call) => call.method === 'conversation.page')).toEqual([
      { method: 'conversation.page', args: { index: 63, offset: 0, limit: 16000 } },
    ]);
    expect(fixture.calls.filter((call) => call.method === 'conversation.read')).toHaveLength(0);
  });

  it('keeps an empty branch empty and fails an unavailable greeting fallback explicitly', async () => {
    const fixture = conversation([]);
    await executeExtensionProgram(
      buildRisuLuaProgram(
        `
function onStart(id)
  assert(getChatLength(id) == 0 and getChat(id, 0) == nil)
  assert(getFullChatMain(id) == "[]" and getUserLastMessage(id) == "")
  local ok, err = pcall(function() getCharacterLastMessage(id) end)
  assert(not ok and string.find(err, "RISU_LUA_FIRST_MESSAGE_UNAVAILABLE", 1, true))
end`,
        'start'
      ),
      { state: {}, input: {} },
      undefined,
      { host: fixture.host }
    );
  });

  it('does not fabricate a result when the conversation grant is denied', async () => {
    const host: ExtensionHostHandler = async () => {
      throw new ExtensionProgramError('BEHAVIOR_HOST_CONVERSATION_DENIED');
    };
    const caught = await executeExtensionProgram(
      buildRisuLuaProgram(
        `
listenEdit("editDisplay", function(id)
  local ok, err = pcall(function() getChat(id, 0) end)
  return {ok=ok, message=err}
end)`,
        'editDisplay'
      ),
      { state: {}, input: { value: '', meta: {} } },
      undefined,
      { host }
    );
    expect(caught.result).toMatchObject({
      ok: false,
      message: expect.stringContaining('BEHAVIOR_HOST_CONVERSATION_DENIED'),
    });
    const source = 'function onStart(id) getChat(id, 0) end';
    await expect(
      executeExtensionProgram(
        buildRisuLuaProgram(source, 'start'),
        { state: {}, input: {} },
        undefined,
        { host }
      )
    ).rejects.toMatchObject({ code: 'BEHAVIOR_PROGRAM_FAILED' });
  });
});

describe('Risu declarative trigger effects', () => {
  const declarative = (type: string, effect: unknown[], conditions: unknown[] = []) =>
    adaptRisuLuaTriggers([{ type, conditions, effect, comment: '수동 실행' }]);

  it('connects setvar effects to one native action with JavaScript number semantics', async () => {
    const converted = declarative('start', [
      { type: 'setvar', operator: '=', var: 'phase', value: 'opening' },
      { type: 'setvar', operator: '+=', var: 'count', value: '2' },
      { type: 'setvar', operator: '=', var: 'copy', value: 'x{{getvar::phase}}' },
    ]);
    expect(converted.actions.map((action) => [action.id, action.triggers, action.hook])).toEqual([
      ['risu-lua-0-effects', ['before-turn'], undefined],
    ]);
    const program = validateExtensionProgram(converted.actions[0].program);
    expect(program.language).toBeUndefined();
    expect(program.capabilities).toEqual(['variables.read', 'variables.write']);
    const values: Record<string, string> = { count: '0.1' };
    const calls: string[] = [];
    const host: ExtensionHostHandler = async (method, raw) => {
      const args = raw as { key: string; value?: string; offset?: number };
      calls.push(method);
      if (method === 'variables.set') {
        values[args.key] = args.value!;
        return null;
      }
      return { value: values[args.key] ?? null, nextOffset: null, overridden: true };
    };
    const result = await executeExtensionProgram(
      converted.actions[0].program!,
      { state: {}, input: {} },
      undefined,
      { host }
    );
    expect(result.result).toBeNull();
    // Risu adds with JavaScript numbers and keeps the resulting string exactly.
    expect(values).toEqual({ phase: 'opening', count: '2.1', copy: 'xopening' });
    expect(calls.filter((method) => method === 'variables.set')).toHaveLength(3);
  });

  it('keeps an unsupported effect, mode or dynamic key declarative instead of guessing', () => {
    const unsupportedEffect = declarative('start', [{ type: 'cutchat', start: '0', end: '1' }]);
    expect(unsupportedEffect.actions).toEqual([]);
    expect(unsupportedEffect.findings[0].code).toBe('RISU_TRIGGER_EFFECTS_UNSUPPORTED');
    const dynamicKey = declarative('start', [
      { type: 'setvar', operator: '=', var: '{{getvar::name}}', value: '1' },
    ]);
    expect(dynamicKey.actions).toEqual([]);
    expect(dynamicKey.findings[0].code).toBe('RISU_TRIGGER_EFFECTS_UNSUPPORTED');
    const unsupportedMode = declarative('display', [
      { type: 'setvar', operator: '=', var: 'phase', value: '1' },
    ]);
    expect(unsupportedMode.actions).toEqual([]);
    expect(unsupportedMode.findings[0].code).toBe('RISU_TRIGGER_MODE_UNSUPPORTED');
  });

  it('keeps the manual name, input phase and conditions of a declarative trigger', () => {
    const manual = declarative('manual', [
      { type: 'setvar', operator: '=', var: 'phase', value: 'clicked' },
    ]);
    expect(manual.actions[0]).toMatchObject({ triggers: ['user'], label: '수동 실행' });
    expect(manual.actions[0].automaticInput).toBeUndefined();
    const input = declarative(
      'input',
      [{ type: 'setvar', operator: '=', var: 'phase', value: 'typed' }],
      [{ type: 'var', var: 'ready', operator: '=', value: 'yes' }]
    );
    expect(input.actions[0]).toMatchObject({ triggers: ['before-turn'], hook: 'input' });
    expect(behaviorActionAllowed(input.actions[0], {}, {}, { variables: { ready: 'yes' } })).toBe(
      true
    );
    expect(behaviorActionAllowed(input.actions[0], {}, {}, { variables: { ready: 'no' } })).toBe(
      false
    );
    expect(() =>
      validatePackageBehavior({
        revision: 1,
        schemaVersion: 1,
        stateSchema: { type: 'record', properties: {} },
        initialState: {},
        actions: [
          ...manual.actions,
          ...input.actions.map((action) => ({ ...action, id: `${action.id}-input` })),
        ],
        outputParsers: [],
      })
    ).not.toThrow();
  });
});

describe('Risu triggers that mix effects with a script', () => {
  const script = 'function onStart(id) setChatVar(id, "phase", "script") end';
  const setvar = (name: string, value: string) => ({
    type: 'setvar',
    operator: '=',
    var: name,
    value,
  });

  it('keeps the declared order of effects around the script inside the trigger mode', () => {
    const converted = adaptRisuLuaTriggers([
      {
        type: 'start',
        conditions: [],
        effect: [setvar('before', '1'), { type: 'triggerlua', code: script }, setvar('after', '2')],
      },
    ]);
    expect(converted.actions.map((action) => [action.id, action.triggers, action.hook])).toEqual([
      ['risu-lua-0-effects-before', ['before-turn'], undefined],
      ['risu-lua-0-start', ['before-turn'], undefined],
      ['risu-lua-0-effects-after', ['before-turn'], undefined],
    ]);
    expect(converted.sources).toEqual([{ triggerIndex: 0, effectIndex: 1, source: script }]);
    expect(
      converted.findings.some((finding) => finding.code === 'RISU_LUA_MIXED_EFFECTS_UNSUPPORTED')
    ).toBe(false);
  });

  it('preserves a trigger whose effects would change its own condition or run in every mode', () => {
    const selfWriting = adaptRisuLuaTriggers([
      {
        type: 'start',
        conditions: [{ type: 'var', var: 'phase', operator: '=', value: 'ready' }],
        effect: [setvar('phase', 'changed'), { type: 'triggerlua', code: script }],
      },
    ]);
    expect(selfWriting.actions).toEqual([]);
    expect(selfWriting.findings.some((f) => f.code === 'RISU_TRIGGER_CONDITION_WRITE')).toBe(true);
    const scriptFirst = adaptRisuLuaTriggers([
      {
        type: 'start',
        conditions: [],
        effect: [{ type: 'triggerlua', code: script }, setvar('after', '1')],
      },
    ]);
    expect(scriptFirst.actions).toEqual([]);
    expect(scriptFirst.findings.some((f) => f.code === 'RISU_LUA_MIXED_EFFECTS_UNSUPPORTED')).toBe(
      true
    );
    const manual = adaptRisuLuaTriggers([
      {
        type: 'manual',
        conditions: [],
        effect: [setvar('before', '1'), { type: 'triggerlua', code: script }],
      },
    ]);
    expect(manual.actions).toEqual([]);
    expect(manual.findings.some((f) => f.code === 'RISU_LUA_MIXED_EFFECTS_UNSUPPORTED')).toBe(true);
  });
});
