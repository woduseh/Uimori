import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { get_encoding } from 'tiktoken';
import { NATIVE_LUA_LIMITS } from '../server/risu-native-lua-session.js';
import type { RisuContentSource } from '../core/risu-native.js';
import {
  executeRisuNative,
  disposeAllNativeRisuSessions,
  type NativeRisuExecutionInput,
} from '../server/risu-native-runtime.js';
import { readNativeRisuSample } from './fixtures/native-risu.js';

// Runtime permission fixtures exercise already-resolved scripts; canonical card/module grants are
// tested separately before the host combines attachments.
const effectiveFixtures = new WeakMap<RisuContentSource, Record<string, unknown>[]>();
const native = (trigger: Record<string, unknown>[]): RisuContentSource => {
  const content: RisuContentSource = {
    version: 1,
    card: { name: 'Test', first_mes: 'Opening' },
    module: { trigger },
    assets: [],
    sourceHash: 'a'.repeat(64),
  };
  effectiveFixtures.set(content, trigger);
  return content;
};
afterEach(() => disposeAllNativeRisuSessions());

// Opt-in local evidence: originals are read only and never copied into the repository.
describe.skipIf(!process.env.UIMORI_RISU_SAMPLE_ROOT)('local native CHARX button evidence', () => {
  for (const [relative, buttonNames] of [
    ['Reference/Cheongwon High School.charx', ['setLangToEnglish', 'setFirst1']],
    ['Reference/Harper.charx', ['lang1', 'greeting1']],
    ['Fujimiya Hinano/Fujimiya Hinano_v2.4.3-test.charx', ['onLangEn', 'initAff70']],
  ] as const) {
    it(relative, async () => {
      const path = join(process.env.UIMORI_RISU_SAMPLE_ROOT!, relative);
      const sample = readNativeRisuSample(path);
      let state: NativeRisuExecutionInput = {
        ...input(sample.native),
        variables: sample.variables,
        messages: [],
      };
      for (const argument of buttonNames) {
        const before = JSON.stringify(state.variables);
        const result = await executeRisuNative({ ...state, argument });
        expect(JSON.stringify(result.variables)).not.toBe(before);
        expect(result.effects.reloadDisplay).toBe(true);
        state = { ...state, variables: result.variables, messages: result.messages };
      }
    });
  }
});
const lua = (code: string, lowLevelAccess = false) => ({
  type: 'start',
  lowLevelAccess,
  conditions: [],
  effect: [{ type: 'triggerlua', code }],
});
const input = (
  content: RisuContentSource,
  event: NativeRisuExecutionInput['event'] = 'manual'
): NativeRisuExecutionInput => ({
  native: content,
  ...(effectiveFixtures.has(content) ? { effectiveTriggers: effectiveFixtures.get(content) } : {}),
  variables: {},
  messages: [{ id: 'first', role: 'char', data: 'Opening' }],
  charName: 'Test',
  userName: 'User',
  event,
  argument: 'choose',
});

describe('native Risu execution', () => {
  it('round-trips long native history within unchanged JSON and Lua memory limits', async () => {
    const tokenizer = get_encoding('o200k_base');
    let text: string;
    try {
      const paragraph =
        '미라는 비가 그친 부두에서 오래된 장부를 펼쳤다. 선장이 약속한 날짜와 창고지기가 기억하는 날짜는 달랐다. 그녀는 어느 쪽도 지우지 않고 두 진술 옆에 물음표를 남겼다.\n\n';
      text = paragraph.repeat(Math.ceil(7500 / tokenizer.encode(paragraph, [], []).length));
      const tokens = tokenizer.encode(text, [], []).length;
      expect(tokens).toBeGreaterThanOrEqual(7350);
      expect(tokens).toBeLessThanOrEqual(7800);
    } finally {
      tokenizer.free();
    }
    const escapes = '"\\\n\t\b\f\r\u0000\u001f한글🌊\ud800끝\udfff';
    const messages = Array.from({ length: 30 }, (_, index) => ({
      id: `long-scene-${index}`,
      role: 'char' as const,
      data: `장면 ${index}: ${escapes}\n${text}${escapes}`,
    }));
    expect(messages.reduce((sum, message) => sum + message.data.length, 0)).toBeGreaterThan(300000);
    const invocation = {
      ...input(
        native([
          lua(`listenEdit('editDisplay', function(id, value)
        return value .. ':' .. tostring(getChatLength(id))
      end)`),
        ]),
        'display'
      ),
      messages,
      text: 'Visible',
    };
    expect(Buffer.byteLength(JSON.stringify(invocation))).toBeLessThan(
      NATIVE_LUA_LIMITS.guestJsonBytes
    );
    const result = await executeRisuNative(invocation, { sessionKey: 'long-native-history' });
    expect(result.text).toBe('Visible:30');
    expect(result.messages).toEqual(messages);
    expect(result.variables).toEqual({});
  });

  it('rejects guest JSON that exceeds the byte limit after escaping', async () => {
    const count = 400000;
    expect(count).toBeLessThan(NATIVE_LUA_LIMITS.guestJsonBytes);
    expect(count * 6).toBeGreaterThan(NATIVE_LUA_LIMITS.guestJsonBytes);
    await expect(
      executeRisuNative(
        input(
          native([
            lua(`function choose(id)
        setChatVar(id, 'escaped', string.rep(string.char(0), ${count}))
      end`),
          ])
        )
      )
    ).rejects.toThrow(/RISU_LUA_PROGRAM_/);
  });

  it.each(['128', '192, 175', '226, 130', '244, 144, 128, 128'])(
    'rejects invalid UTF-8 bytes returned from Lua (%s)',
    async (bytes) => {
      await expect(
        executeRisuNative(
          input(
            native([
              lua(`function choose(id)
          setChatVar(id, 'invalid', string.char(${bytes}))
        end`),
            ])
          )
        )
      ).rejects.toThrow(/RISU_LUA_PROGRAM_/);
    }
  );
  it('preserves script locals across redraws with fresh snapshots and isolated chat sessions', async () => {
    const content = native([
      lua(`local count = 0
      function choose(id)
        count = count + 1
        setChatVar(id, 'count', count)
        setChatVar(id, 'fresh', getChatVar(id, 'caller'))
        if getChatLength(id) > 0 then setChat(id, 0, 'Count ' .. count) end
      end
      listenEdit('editDisplay', function(id, value) return value .. ':' .. count end)`),
    ]);
    const first = await executeRisuNative(input(content), { sessionKey: 'chat-a:main:rev1' });
    expect(first.variables.count).toBe('1');
    const rendered = await executeRisuNative(
      { ...input(content, 'display'), text: 'View' },
      { sessionKey: 'chat-a:main:rev1' }
    );
    expect(rendered.text).toBe('View:1');
    const second = await executeRisuNative(
      {
        ...input(content),
        variables: { caller: 'new' },
        messages: [{ id: 'new-message', role: 'user', data: 'New snapshot' }],
      },
      { sessionKey: 'chat-a:main:rev1' }
    );
    expect(second.variables).toEqual({ caller: 'new', count: '2', fresh: 'new' });
    expect(second.messages).toEqual([{ id: 'new-message', role: 'user', data: 'Count 2' }]);
    const other = await executeRisuNative(input(content), { sessionKey: 'chat-b:main:rev1' });
    expect(other.variables.count).toBe('1');
  });
  it('resets host and CPU budgets each invocation and discards failed or changed sessions', async () => {
    const content = native([
      lua(`local count = 0
      function choose(id)
        count = count + 1
        if getChatVar(id,'fail') == '1' then error('intentional') end
        setChatVar(id,'count',count)
      end`),
    ]);
    for (let n = 1; n <= 135; n++) {
      const result = await executeRisuNative(input(content), { sessionKey: 'persistent-budget' });
      expect(result.variables.count).toBe(String(n));
    }
    await expect(
      executeRisuNative(
        { ...input(content), variables: { fail: '1' } },
        { sessionKey: 'persistent-budget' }
      )
    ).rejects.toThrow('intentional');
    expect(
      (await executeRisuNative(input(content), { sessionKey: 'persistent-budget' })).variables.count
    ).toBe('1');
    const revised = native([lua(`function choose(id) setChatVar(id,'revision','2') end`)]);
    expect(
      (await executeRisuNative(input(revised), { sessionKey: 'persistent-budget' })).variables
    ).toEqual({ revision: '2' });
  });
  it('runs original Lua button functions, preserves state, message ids and explicit reload', async () => {
    const content = native([
      lua(`function choose(id)
      local count = getState(id, 'count') or 0
      setState(id, 'count', count + 1)
      setChatVar(id, 'choice', 'selected')
      setChat(id, 0, 'Chosen')
      addChat(id, 'user', 'Continue')
      reloadDisplay(id)
    end`),
    ]);
    const first = await executeRisuNative(input(content));
    expect(first.variables).toEqual({ __count: '1', choice: 'selected' });
    expect(first.messages).toEqual([
      { id: 'first', role: 'char', data: 'Chosen' },
      { role: 'user', data: 'Continue' },
    ]);
    expect(first.effects.reloadDisplay).toBe(true);
    const second = await executeRisuNative({
      ...input(content),
      variables: first.variables,
      messages: first.messages,
    });
    expect(second.variables.__count).toBe('2');
  });
  it('dispatches risu-btn separately and composes edit callbacks over strings and requests', async () => {
    const content = native([
      lua(`function onButtonClick(id, data) setChatVar(id, 'button', data) end
      listenEdit('editDisplay', function(id, value) return value .. '!' end)
      listenEdit('editDisplay', function(id, value) return value .. '?' end)
      listenEdit('editRequest', function(id, value) value[1].content = 'Edited'; return value end)`),
    ]);
    expect(
      (await executeRisuNative({ ...input(content, 'button'), argument: 'x' })).variables.button
    ).toBe('x');
    expect((await executeRisuNative({ ...input(content, 'display'), text: 'Text' })).text).toBe(
      'Text!?'
    );
    expect(
      (
        await executeRisuNative({
          ...input(content, 'request'),
          request: [{ role: 'system', content: 'Original' }],
        })
      ).request
    ).toEqual([{ role: 'system', content: 'Edited' }]);
  });
  it('executes Harper-style V2 named triggers and real CBS without translating records', async () => {
    const content = native([
      {
        type: 'manual',
        comment: 'choose',
        conditions: [],
        effect: [
          {
            type: 'v2SetVar',
            var: 'choice',
            value: '2',
            valueType: 'value',
            operator: '=',
            indent: 0,
          },
          {
            type: 'v2IfAdvanced',
            source: 'choice',
            sourceType: 'var',
            target: '2.0',
            targetType: 'value',
            condition: '=',
            indent: 0,
          },
          {
            type: 'v2Impersonate',
            role: 'user',
            value: 'Selected {{getvar::choice}}',
            valueType: 'value',
            indent: 1,
          },
          { type: 'v2EndIndent', indent: 0 },
        ],
      },
    ]);
    const result = await executeRisuNative(input(content));
    expect(result.variables.choice).toBe('2');
    expect(result.messages.at(-1)).toEqual({ role: 'user', data: 'Selected 2' });
  });
  it('routes original LLM arguments through an explicit async host and never invents a result', async () => {
    const content = native([
      lua(
        `function choose(id)
      local result = LLM(id, {{role='user',content='Prompt'}}, false, {temperature=0.5})
      setChatVar(id, 'result', result.result)
    end`,
        true
      ),
    ]);
    const calls: unknown[] = [];
    const result = await executeRisuNative(input(content), {
      host: async (method, args) => {
        calls.push({ method, args });
        return { success: true, result: 'Answer' };
      },
    });
    expect(calls).toEqual([
      {
        method: 'LLM',
        args: {
          prompt: [{ role: 'user', content: 'Prompt' }],
          useMultimodal: false,
          options: { temperature: 0.5 },
        },
      },
    ]);
    expect(result.variables.result).toBe('Answer');
    await expect(executeRisuNative(input(content))).rejects.toThrow('RISU_NATIVE_HOST_UNAVAILABLE');
  });
  it('rejects unavailable APIs, unsupported trigger effects and prototype keys', async () => {
    await expect(
      executeRisuNative(input(native([lua('function choose(id) request(id, "url") end')])))
    ).rejects.toThrow('RISU_NATIVE_API_UNSUPPORTED:request');
    await expect(
      executeRisuNative(
        input(native([{ type: 'manual', comment: 'choose', effect: [{ type: 'v2Unknown' }] }]))
      )
    ).rejects.toThrow('RISU_NATIVE_EFFECT_UNSUPPORTED');
    await expect(
      executeRisuNative(
        input(native([lua('function choose(id) setChatVar(id,"__proto__","x") end')]))
      )
    ).rejects.toThrow('RISU_NATIVE_VARIABLE_INVALID');
  });
  it.each([
    [
      "function allowed(id) return LLM(id, 'allowed') end",
      "function choose(id) LLM(id, 'denied') end",
      'manual',
    ],
    [
      "function allowed(id) return LLM(id, 'allowed') end",
      'function choose(id) allowed(id) end',
      'manual',
    ],
    ['function choose(id) denied(id) end', "function denied(id) LLM(id, 'denied') end", 'manual'],
    [
      "function allowed(id) return LLM(id, 'allowed') end",
      "listenEdit('editInput', function(id, text) LLM(id, 'denied'); return text end)",
      'editInput',
    ],
    [
      "function allowed(id) return LLM(id, 'allowed') end",
      "function choose(id) load(\"return simpleLLM('id', 'denied')\")() end",
      'manual',
    ],
  ] as const)(
    'keeps source permissions when privileged and unprivileged scripts share a VM (%s)',
    async (allowed, denied, event) => {
      let calls = 0;
      const content = native([lua(allowed, true), lua(denied, false)]);
      await expect(
        executeRisuNative(
          { ...input(content, event), text: 'Input' },
          {
            host: async () => {
              calls++;
              return { success: true, result: 'Must not run' };
            },
          }
        )
      ).rejects.toThrow('RISU_NATIVE_MODEL_DENIED');
      expect(calls).toBe(0);
    }
  );
  it('restores caller permissions after a denied nested callback and hides private RPC from authored loads', async () => {
    const content = native([
      lua("function denied(id) LLM(id, 'denied') end", false),
      lua(
        `local count = 0
        function choose(id)
          assert(api == nil and __host == nil and __input == nil)
          assert(load('return api or __host or __input')() == nil)
          local ok = pcall(denied, id)
          assert(not ok)
          local value = LLM(id, 'allowed')
          count = count + 1
          setChatVar(id, 'count', count)
          setChatVar(id, 'result', value.result)
        end`,
        true
      ),
    ]);
    let calls = 0;
    const options = {
      sessionKey: 'permissions-persist',
      host: async () => {
        calls++;
        return { success: true, result: 'Allowed' };
      },
    };
    expect((await executeRisuNative(input(content), options)).variables).toMatchObject({
      count: '1',
      result: 'Allowed',
    });
    expect((await executeRisuNative(input(content), options)).variables).toMatchObject({
      count: '2',
      result: 'Allowed',
    });
    expect(calls).toBe(2);
  });
  it('keeps Lua sandboxed and terminates infinite execution', async () => {
    const content = native([
      lua(`function choose(id)
      assert(io == nil and os == nil and debug == nil and package == nil)
      setChatVar(id, 'isolated', 'yes')
    end`),
    ]);
    expect((await executeRisuNative(input(content))).variables.isolated).toBe('yes');
    await expect(
      executeRisuNative(input(native([lua('function choose(id) while true do end end')])))
    ).rejects.toThrow(/TIMEOUT/);
  });
  it('waits for explicit UI input, reports authored alerts, and provides bounded random values', async () => {
    const content = native([
      lua(`function choose(id)
      local value = alertInput(id, 'Value'):await()
      setChatVar(id, 'input', value)
      local number = math.random(3, 3)
      setChatVar(id, 'random', number)
      alertNormal(id, 'Done')
    end`),
    ]);
    const result = await executeRisuNative(input(content), {
      host: async (method, args) => {
        expect(method).toBe('alertInput');
        expect(args).toEqual({ value: 'Value' });
        return '55';
      },
    });
    expect(result.variables).toEqual({ input: '55', random: '3' });
    expect(result.effects.notifications).toEqual([{ kind: 'normal', message: 'Done' }]);
    await expect(executeRisuNative(input(content))).rejects.toThrow('RISU_NATIVE_HOST_UNAVAILABLE');
  });
});
