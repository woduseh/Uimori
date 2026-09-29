import { afterEach, expect, test, vi } from 'vitest';
import { executeRisuNative, type NativeRisuExecutionInput } from '../server/risu-native-runtime.js';

const state = vi.hoisted(() => ({
  sessions: [] as { calls: string[]; closed: number }[],
  fail: false,
  controller: undefined as AbortController | undefined,
}));
vi.mock('../server/risu-native-cbs.js', () => ({
  createNativeRisuCbsSession: (signal?: AbortSignal) => {
    const session = { calls: [] as string[], closed: 0 };
    state.sessions.push(session);
    return {
      evaluate: async (text: string) => {
        session.calls.push(text);
        if (session.calls.length === 2) {
          if (state.fail) throw new Error('CBS failed');
          state.controller?.abort(new Error('CANCELLED'));
        }
        signal?.throwIfAborted();
        return text.slice(2, -2);
      },
      close: async () => {
        session.closed++;
      },
    };
  },
}));
afterEach(() => {
  state.sessions.length = 0;
  state.fail = false;
  state.controller = undefined;
});

function input(): NativeRisuExecutionInput {
  return {
    native: {
      version: 1,
      card: { name: 'Guide' },
      assets: [],
      sourceHash: 'a'.repeat(64),
    },
    effectiveTriggers: [
      {
        type: 'manual',
        comment: 'choose',
        effect: ['one', 'two', 'three'].map((value) => ({
          type: 'v2Impersonate',
          role: 'char',
          value: `{{${value}}}`,
          valueType: 'value',
        })),
      },
    ],
    variables: {},
    messages: [],
    charName: 'Guide',
    userName: 'User',
    event: 'manual',
    argument: 'choose',
  };
}

test.each(['completed', 'failed', 'cancelled'] as const)(
  'native invocation owns one serial CBS session and closes after %s',
  async (outcome) => {
    state.fail = outcome === 'failed';
    const controller = new AbortController();
    if (outcome === 'cancelled') state.controller = controller;
    const pending = executeRisuNative(input(), { signal: controller.signal });
    if (outcome === 'completed')
      expect((await pending).messages.map((message) => message.data)).toEqual([
        'one',
        'two',
        'three',
      ]);
    else await expect(pending).rejects.toThrow(outcome === 'failed' ? 'CBS failed' : 'CANCELLED');
    expect(state.sessions).toEqual([
      {
        calls:
          outcome === 'completed' ? ['{{one}}', '{{two}}', '{{three}}'] : ['{{one}}', '{{two}}'],
        closed: 1,
      },
    ]);
    state.fail = false;
    state.controller = undefined;
    await executeRisuNative(input());
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[1]).toEqual({ calls: ['{{one}}', '{{two}}', '{{three}}'], closed: 1 });
  }
);

test('an injected CBS evaluator keeps ownership of its own lifetime', async () => {
  await executeRisuNative(input(), { cbs: async () => 'provided' });
  expect(state.sessions).toEqual([]);
});
