import { expect, test, vi } from 'vitest';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import { executePackageExtensionProgram } from '../server/package-extension-execution.js';

const input = { state: { count: 0 }, input: {} };
const base = {
  profile: undefined,
  attachment: { id: 'synthetic', revision: 1, role: 'module' as const },
  assertCurrent: () => {},
};
function program(source: string): ExtensionProgram {
  return { api: 'uimori-state-action-v1', capabilities: ['model.generate'], source };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('real guest computation is retained before final model authorization fails', async () => {
  let available = true;
  const onExecuted = vi.fn();
  const modelGenerate = vi.fn(async () => ({ text: 'synthetic result' }));
  const assertModelAccess = vi.fn(() => {
    if (!available) throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_UNAVAILABLE');
  });
  const responseHost = vi.fn(async () => {
    // The guest has already received the model result when this separate Host call occurs.
    available = false;
    return null;
  });
  const execution = executePackageExtensionProgram(
    program(`
      const generated = await api.host.call('model.generate', {prompt: 'synthetic'});
      await api.host.call('response.read', {});
      return {state: {count: 1}, result: generated.text};
    `),
    input,
    undefined,
    {
      ...base,
      modelServices: { modelGenerate, assertModelAccess, hostWaitMs: 1000 },
      responseHost,
      onExecuted,
    }
  );
  await expect(execution).rejects.toThrow('BEHAVIOR_HOST_MODEL_UNAVAILABLE');
  expect(modelGenerate).toHaveBeenCalledOnce();
  expect(responseHost).toHaveBeenCalledOnce();
  expect(assertModelAccess).toHaveBeenCalledOnce();
  expect(onExecuted).toHaveBeenCalledWith(
    expect.objectContaining({ state: { count: 1 }, result: 'synthetic result' })
  );
});

test.each(['BEHAVIOR_HOST_MODEL_UNAVAILABLE', 'BEHAVIOR_HOST_MODEL_DENIED'])(
  'a caught %s with no received model result preserves fallback state',
  async (code) => {
    const assertModelAccess = vi.fn(() => {
      throw new Error('No model result was received');
    });
    const output = await executePackageExtensionProgram(
      program(`
        try { await api.host.call('model.generate', {prompt: 'synthetic'}); }
        catch (error) { return {state: {count: 2}, result: 'fallback'}; }
        return {state: api.state, result: 'unexpected'};
      `),
      input,
      undefined,
      {
        ...base,
        modelServices: {
          modelGenerate: async () => {
            throw new ExtensionProgramError(code);
          },
          assertModelAccess,
          hostWaitMs: 1000,
        },
      }
    );
    expect(output).toMatchObject({ state: { count: 2 }, result: 'fallback' });
    expect(assertModelAccess).not.toHaveBeenCalled();
  }
);

test('missing capability denies model dispatch even when the caller supplies a service', async () => {
  const modelGenerate = vi.fn(async () => null);
  const assertModelAccess = vi.fn();
  const output = await executePackageExtensionProgram(
    {
      ...program(`
      try { await api.host.call('model.generate', {}); }
      catch (error) { return {state: api.state, result: 'denied'}; }
      return {state: api.state, result: 'unexpected'};
    `),
      capabilities: [],
    },
    input,
    undefined,
    { ...base, modelServices: { modelGenerate, assertModelAccess, hostWaitMs: 1000 } }
  );
  expect(output.result).toBe('denied');
  expect(modelGenerate).not.toHaveBeenCalled();
  expect(assertModelAccess).not.toHaveBeenCalled();
});

test('cancellation waits for controlled model Host settlement and never exposes late output', async () => {
  const started = deferred();
  const aborted = deferred();
  const gate = deferred();
  const controller = new AbortController();
  let settled = false;
  let completed = false;
  const onExecuted = vi.fn();
  const assertModelAccess = vi.fn();
  const execution = executePackageExtensionProgram(
    program(`
      const generated = await api.host.call('model.generate', {prompt: 'synthetic'});
      return {state: {count: 1}, result: generated};
    `),
    input,
    controller.signal,
    {
      ...base,
      modelServices: {
        modelGenerate: async (_args, signal) => {
          signal.addEventListener('abort', () => aborted.resolve(), { once: true });
          started.resolve();
          await gate.promise;
          settled = true;
          return 'late result';
        },
        assertModelAccess,
        hostWaitMs: 1000,
      },
      onExecuted,
    }
  );
  const observed = execution.then(
    () => {
      completed = true;
      return 'unexpected';
    },
    (error: Error) => {
      completed = true;
      return error.message;
    }
  );
  try {
    await started.promise;
    controller.abort();
    await aborted.promise;
    expect(completed).toBe(false);
    expect(settled).toBe(false);
  } finally {
    gate.resolve();
  }
  expect(await observed).toBe('BEHAVIOR_PROGRAM_ABORTED');
  expect(settled).toBe(true);
  expect(onExecuted).not.toHaveBeenCalled();
  expect(assertModelAccess).not.toHaveBeenCalled();
});
