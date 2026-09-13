import { describe, expect, it } from 'vitest';
import { type ExtensionProgram, ExtensionProgramError } from '../core/extension-program.js';
import { executeExtensionProgram, EXTENSION_RUNTIME_ENGINE } from '../server/extension-runtime.js';

const program = (source: string): ExtensionProgram => ({
  api: 'uimori-state-action-v1',
  source,
});

async function code(work: Promise<unknown>) {
  try {
    await work;
    return 'OK';
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionProgramError);
    return (error as ExtensionProgramError).code;
  }
}

describe('fixed-memory QuickJS extension runtime', () => {
  it('runs a function body with copied JSON only and exposes no host globals', async () => {
    const result = await executeExtensionProgram(
      program(`
        return {
          state: { count: api.state.count + api.input.amount },
          result: {
            label: api.input.label.toUpperCase(),
            ambient: {
              process: typeof process,
              require: typeof require,
              fetch: typeof fetch,
              console: typeof console,
              webAssembly: typeof WebAssembly,
              date: typeof Date,
              random: typeof Math.random
            }
          }
        };
      `),
      { state: { count: 2 }, input: { amount: 3, label: 'next' } }
    );

    expect(result).toEqual({
      state: { count: 5 },
      result: {
        label: 'NEXT',
        ambient: {
          process: 'undefined',
          require: 'undefined',
          fetch: 'undefined',
          console: 'undefined',
          webAssembly: 'undefined',
          date: 'undefined',
          random: 'undefined',
        },
      },
      engine: EXTENSION_RUNTIME_ENGINE,
    });
  });

  it('returns only stable failure codes and rejects accessors and oversized UTF-8 output', async () => {
    expect(
      await code(
        executeExtensionProgram(program(`throw new Error('private guest detail');`), {
          state: {},
          input: {},
        })
      )
    ).toBe('BEHAVIOR_PROGRAM_FAILED');
    expect(
      await code(
        executeExtensionProgram(
          program(`
            const result = {};
            Object.defineProperty(result, 'value', { enumerable: true, get() { return 1; } });
            return { state: api.state, result };
          `),
          { state: {}, input: {} }
        )
      )
    ).toBe('BEHAVIOR_PROGRAM_RESULT_VALUE');
    expect(
      await code(
        executeExtensionProgram(
          program(`return { state: api.state, result: { text: '가'.repeat(50000) } };`),
          { state: {}, input: {} }
        )
      )
    ).toBe('BEHAVIOR_PROGRAM_OUTPUT_SIZE');
  });

  it('interrupts infinite computation and can run cleanly afterward', async () => {
    expect(
      await code(executeExtensionProgram(program(`while (true) {}`), { state: {}, input: {} }))
    ).toBe('BEHAVIOR_PROGRAM_TIMEOUT');

    await expect(
      executeExtensionProgram(program(`return { state: { ok: true }, result: null };`), {
        state: {},
        input: {},
      })
    ).resolves.toMatchObject({ state: { ok: true }, result: null });
  });

  it('contains allocation failure in the invocation and can run cleanly afterward', async () => {
    expect(
      await code(
        executeExtensionProgram(
          program(`
            const blocks = [];
            while (true) blocks.push(new Array(100000).fill(1));
          `),
          { state: {}, input: {} }
        )
      )
    ).toBe('BEHAVIOR_PROGRAM_FAILED');

    await expect(
      executeExtensionProgram(program(`return { state: api.state, result: 'alive' };`), {
        state: { preserved: true },
        input: {},
      })
    ).resolves.toMatchObject({ state: { preserved: true }, result: 'alive' });
  });

  it('terminates on abort and rejects excess concurrent work without a queue', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const firstWork = executeExtensionProgram(
      program(`while (true) {}`),
      { state: {}, input: {} },
      first.signal
    );
    const secondWork = executeExtensionProgram(
      program(`while (true) {}`),
      { state: {}, input: {} },
      second.signal
    );
    const firstCode = code(firstWork);
    const secondCode = code(secondWork);

    expect(
      await code(
        executeExtensionProgram(program(`return { state: {}, result: null };`), {
          state: {},
          input: {},
        })
      )
    ).toBe('BEHAVIOR_PROGRAM_BUSY');
    first.abort();
    second.abort();
    await expect(firstCode).resolves.toBe('BEHAVIOR_PROGRAM_ABORTED');
    await expect(secondCode).resolves.toBe('BEHAVIOR_PROGRAM_ABORTED');
  });

  it('rejects input before creating a worker when encoded JSON exceeds the boundary', async () => {
    expect(
      await code(
        executeExtensionProgram(program(`return { state: api.state, result: null };`), {
          state: {},
          input: { text: '가'.repeat(50000) },
        })
      )
    ).toBe('BEHAVIOR_PROGRAM_INPUT_SIZE');
  });
  it('automatic preparation can wait for capacity and cancellation removes a queued invocation', async () => {
    const a = new AbortController(),
      b = new AbortController(),
      queued = new AbortController();
    const first = code(
      executeExtensionProgram(program('while(true){}'), { state: {}, input: {} }, a.signal)
    );
    const second = code(
      executeExtensionProgram(program('while(true){}'), { state: {}, input: {} }, b.signal)
    );
    const cancelled = code(
      executeExtensionProgram(
        program('return {state:{},result:null};'),
        { state: {}, input: {} },
        queued.signal,
        { waitForSlot: true }
      )
    );
    const waiting = executeExtensionProgram(
      program('return {state:api.state,result:"ready"};'),
      { state: { ok: true }, input: {} },
      undefined,
      { waitForSlot: true }
    );
    queued.abort();
    a.abort();
    b.abort();
    expect(await cancelled).toBe('BEHAVIOR_PROGRAM_ABORTED');
    await Promise.all([first, second]);
    await expect(waiting).resolves.toMatchObject({ state: { ok: true }, result: 'ready' });
  });
});
