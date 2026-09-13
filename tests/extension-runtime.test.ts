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
              random: typeof Math.random,
              asyncConstructor: typeof Object.getPrototypeOf(async function() {}).constructor,
              generatorConstructor: typeof Object.getPrototypeOf(function*() {}).constructor,
              asyncGeneratorConstructor: typeof Object.getPrototypeOf(async function*() {}).constructor
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
          asyncConstructor: 'undefined',
          generatorConstructor: 'undefined',
          asyncGeneratorConstructor: 'undefined',
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

  it('roundtrips async host reads and excludes bounded host wait from guest CPU time', async () => {
    const calls: { method: string; args: unknown; aborted: boolean }[] = [];
    const started = performance.now();
    const result = await executeExtensionProgram(
      program(`
        const listed = await api.host.call('materials.list', {});
        const material = await api.host.call('materials.read', { id: listed[0].id });
        return {
          state: { count: api.state.count + material.weight },
          result: { title: material.title, apiKeys: Object.keys(api).sort() }
        };
      `),
      { state: { count: 2 }, input: {} },
      undefined,
      {
        host: async (method, args, signal) => {
          calls.push({ method, args, aborted: signal.aborted });
          if (method === 'materials.list') {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return [{ id: 'material-1' }];
          }
          return { title: 'Synthetic material', weight: 3 };
        },
      }
    );

    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect(calls).toEqual([
      { method: 'materials.list', args: {}, aborted: false },
      { method: 'materials.read', args: { id: 'material-1' }, aborted: false },
    ]);
    expect(result).toMatchObject({
      state: { count: 5 },
      result: { title: 'Synthetic material', apiKeys: ['input', 'state'] },
    });
  });

  it('allows host waits beyond the active wall budget when explicitly budgeted', async () => {
    const started = performance.now();
    const result = await executeExtensionProgram(
      program(`
        const value = await api.host.call('model.generate', {});
        return { state: api.state, result: value };
      `),
      { state: { preserved: true }, input: {} },
      undefined,
      {
        hostWaitMs: 1_500,
        host: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_100));
          return { text: 'ready' };
        },
      }
    );

    expect(performance.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(result).toMatchObject({
      state: { preserved: true },
      result: { text: 'ready' },
    });
  });

  it('bounds cumulative host wait and aborts the in-flight broker', async () => {
    let calls = 0;
    let aborted = false;
    const resultCode = code(
      executeExtensionProgram(
        program(`
          await api.host.call('model.generate', { index: 1 });
          await api.host.call('model.generate', { index: 2 });
          return { state: api.state, result: null };
        `),
        { state: {}, input: {} },
        undefined,
        {
          hostWaitMs: 450,
          host: async (_method, _args, signal) => {
            calls++;
            if (calls === 1) {
              await new Promise((resolve) => setTimeout(resolve, 300));
              return null;
            }
            return await new Promise((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  resolve(null);
                },
                { once: true }
              );
            });
          },
        }
      )
    );

    await expect(resultCode).resolves.toBe('BEHAVIOR_PROGRAM_TIMEOUT');
    expect(calls).toBe(2);
    expect(aborted).toBe(true);
  });

  it('does not spend host wait budget on unresolved guest promises or busy guest code', async () => {
    const unresolvedStarted = performance.now();
    expect(
      await code(
        executeExtensionProgram(
          program(`await new Promise(() => {});`),
          { state: {}, input: {} },
          undefined,
          { hostWaitMs: 5_000 }
        )
      )
    ).toBe('BEHAVIOR_PROGRAM_TIMEOUT');
    expect(performance.now() - unresolvedStarted).toBeLessThan(2_500);

    let hostAborted = false;
    expect(
      await code(
        executeExtensionProgram(
          program(`
            void api.host.call('model.generate', {});
            while (true) {}
          `),
          { state: {}, input: {} },
          undefined,
          {
            hostWaitMs: 5_000,
            host: async (_method, _args, signal) =>
              await new Promise((resolve) =>
                signal.addEventListener(
                  'abort',
                  () => {
                    hostAborted = true;
                    resolve(null);
                  },
                  { once: true }
                )
              ),
          }
        )
      )
    ).toBe('BEHAVIOR_PROGRAM_TIMEOUT');
    expect(hostAborted).toBe(true);
  });

  it('exposes only allowlisted host denial codes and cannot let guest code hide host faults', async () => {
    const denied = await executeExtensionProgram(
      program(`
        try {
          await api.host.call('materials.read', { id: 'denied' });
          return { state: api.state, result: null };
        } catch (error) {
          return { state: api.state, result: { code: error.code, message: error.message } };
        }
      `),
      { state: {}, input: {} },
      undefined,
      {
        host: async () => {
          throw new ExtensionProgramError('BEHAVIOR_HOST_DENIED');
        },
      }
    );
    expect(denied.result).toEqual({
      code: 'BEHAVIOR_HOST_DENIED',
      message: 'BEHAVIOR_HOST_DENIED',
    });

    const unavailable = await executeExtensionProgram(
      program(`
        try { await api.host.call('materials.list', {}); }
        catch (error) { return { state: api.state, result: error.code }; }
      `),
      { state: {}, input: {} }
    );
    expect(unavailable.result).toBe('BEHAVIOR_HOST_CALL_FAILED');

    const privateFailure = new Error('PRIVATE_DATABASE_FAILURE');
    const work = executeExtensionProgram(
      program(`
        try { await api.host.call('materials.list', {}); }
        catch (error) { return { state: api.state, result: String(error) }; }
      `),
      { state: {}, input: {} },
      undefined,
      { awaitHostSettlement: true, host: async () => Promise.reject(privateFailure) }
    );
    await expect(work).rejects.toBe(privateFailure);
  });

  it('aborts in-flight host work and rejects its late result', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let hostAborted = false;
    const work = executeExtensionProgram(
      program(`
        const value = await api.host.call('materials.read', { id: 'slow' });
        return { state: api.state, result: value };
      `),
      { state: {}, input: {} },
      controller.signal,
      {
        hostWaitMs: 1_000,
        host: async (_method, _args, signal) => {
          entered();
          return await new Promise((resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                hostAborted = true;
                reject(new Error('PRIVATE_LATE_HOST_RESULT'));
              },
              { once: true }
            );
            setTimeout(() => resolve({ late: true }), 500);
          });
        },
      }
    );
    const resultCode = code(work);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(resultCode).resolves.toBe('BEHAVIOR_PROGRAM_ABORTED');
    expect(hostAborted).toBe(true);
  });

  it('can await aborted host cleanup without allowing the guest to resume', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => (observedAbort = resolve));
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve));
    let cleanupFinished = false;
    const calls: string[] = [];
    const resultCode = code(
      executeExtensionProgram(
        program(`
          const value = await api.host.call('model.generate', {});
          await api.host.call('model.late', value);
          return { state: api.state, result: value };
        `),
        { state: {}, input: {} },
        controller.signal,
        {
          hostWaitMs: 5_000,
          awaitHostSettlement: true,
          host: async (method, _args, signal) => {
            calls.push(method);
            if (method !== 'model.generate') return null;
            const cancelled = new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true })
            );
            entered();
            await cancelled;
            observedAbort();
            await cleanup;
            cleanupFinished = true;
            return { late: true };
          },
        }
      )
    );
    let outerSettled = false;
    void resultCode.then(() => {
      outerSettled = true;
    });

    await started;
    controller.abort();
    await aborted;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outerSettled).toBe(false);
    expect(cleanupFinished).toBe(false);

    releaseCleanup();
    await expect(resultCode).resolves.toBe('BEHAVIOR_PROGRAM_ABORTED');
    expect(cleanupFinished).toBe(true);
    expect(calls).toEqual(['model.generate']);
  });

  it('rejects a fire-and-forget result when aborted host settlement fails fatally', async () => {
    const databaseFailure = new Error('DATABASE_ATTEMPT_FINISH_FAILED');
    let cleanupReached = false;
    let calls = 0;
    const work = executeExtensionProgram(
      program(`
        void api.host.call('model.generate', {});
        return { state: { adopted: true }, result: 'must-not-adopt' };
      `),
      { state: {}, input: {} },
      undefined,
      {
        hostWaitMs: 5_000,
        awaitHostSettlement: true,
        host: async (_method, _args, signal) => {
          calls++;
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true })
            );
          cleanupReached = true;
          throw databaseFailure;
        },
      }
    );

    await expect(work).rejects.toBe(databaseFailure);
    expect(cleanupReached).toBe(true);
    expect(calls).toBe(1);
  });

  it('bounds host method, argument, result and cumulative result sizes', async () => {
    let calls = 0;
    const invalidArguments = await executeExtensionProgram(
      program(`
        const codes = [];
        for (const [method, args] of [
          ['x'.repeat(81), {}],
          ['materials.read', { text: '가'.repeat(50000) }]
        ]) {
          try { await api.host.call(method, args); }
          catch (error) { codes.push(error.code); }
        }
        return { state: api.state, result: codes };
      `),
      { state: {}, input: {} },
      undefined,
      {
        host: async () => {
          calls++;
          return null;
        },
      }
    );
    expect(invalidArguments.result).toEqual(['BEHAVIOR_HOST_ARGUMENTS', 'BEHAVIOR_HOST_ARGUMENTS']);
    expect(calls).toBe(0);

    const singleResult = await executeExtensionProgram(
      program(`
        let code = null;
        try { await api.host.call('materials.read', {}); }
        catch (error) { code = error.code; }
        return { state: api.state, result: code };
      `),
      { state: {}, input: {} },
      undefined,
      { host: async () => ({ text: '가'.repeat(50_000) }) }
    );
    expect(singleResult.result).toBe('BEHAVIOR_HOST_RESULT_LIMIT');

    calls = 0;
    const cumulative = await executeExtensionProgram(
      program(`
        let code = null;
        try {
          for (let index = 0; index < 5; index++) await api.host.call('materials.read', { index });
        } catch (error) { code = error.code; }
        return { state: api.state, result: code };
      `),
      { state: {}, input: {} },
      undefined,
      {
        host: async () => {
          calls++;
          return { text: '가'.repeat(43_000) };
        },
      }
    );
    expect(cumulative.result).toBe('BEHAVIOR_HOST_RESULT_LIMIT');
    expect(calls).toBe(5);
  });

  it('bounds total and concurrently pending host invocations', async () => {
    let sequentialCalls = 0;
    const sequential = await executeExtensionProgram(
      program(`
        let code = null;
        for (let index = 0; index < 33; index++) {
          try { await api.host.call('materials.read', { index }); }
          catch (error) { code = error.code; break; }
        }
        return { state: api.state, result: code };
      `),
      { state: {}, input: {} },
      undefined,
      {
        host: async () => {
          sequentialCalls++;
          return null;
        },
      }
    );
    expect(sequential.result).toBe('BEHAVIOR_HOST_CALL_LIMIT');
    expect(sequentialCalls).toBe(32);

    let pendingCalls = 0;
    const concurrent = await executeExtensionProgram(
      program(`
        let code = null;
        try {
          await Promise.all(Array.from({ length: 9 }, (_, index) =>
            api.host.call('materials.read', { index })
          ));
        } catch (error) { code = error.code; }
        return { state: api.state, result: code };
      `),
      { state: {}, input: {} },
      undefined,
      {
        host: async (_method, _args, signal) => {
          pendingCalls++;
          return await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
          );
        },
      }
    );
    expect(concurrent.result).toBe('BEHAVIOR_HOST_PENDING_LIMIT');
    expect(pendingCalls).toBe(8);
  });
});
