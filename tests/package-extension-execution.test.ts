import { expect, test, vi } from 'vitest';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import { executePackageExtensionProgram } from '../server/package-extension-execution.js';
import { defaultProfile, type ProfileSnapshot } from '../core/product.js';
import { packageInstanceId } from '../core/execution-context.js';
import {
  projectExtensionVariableMutation,
  validateExtensionVariablePermission,
} from '../server/extension-variables.js';
import type { ContentPackage } from '../core/content-package.js';

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

function variableFixture() {
  const ref = { id: 'shared-values', revision: 1, role: 'bot' as const };
  const pkg: ContentPackage = {
    version: 1,
    id: ref.id,
    revision: ref.revision,
    title: 'Synthetic variables',
    description: '',
    body: 'Original authored text',
    bodyTemplate: [
      { kind: 'value', expression: { op: 'get', args: [{ context: ['variables'] }, 'mood'] } },
    ],
    variableDefaults: { values: { mood: 'calm' } },
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
  };
  const profile: ProfileSnapshot = {
    ...defaultProfile('synthetic'),
    contents: [],
    models: {},
    packages: [pkg],
    packageAttachments: [ref],
    extensionGrants: {
      [packageInstanceId(ref)]: { packageRevision: 1, capabilities: ['variables.write'] },
    },
  };
  const code = (source: string): ExtensionProgram => ({
    api: 'uimori-state-action-v1',
    capabilities: [
      'variables.read',
      'variables.write',
      'materials.read.self',
      'response.read.current',
    ],
    source,
  });
  return {
    ref,
    profile,
    code,
    options: {
      profile,
      attachment: ref,
      assertCurrent: () => {},
      assertVariableWriteAccess: () => {},
    },
  };
}

test('real guest stages reads, empty overrides and removals, and self materials share the same evolving projection', async () => {
  const f = variableFixture(),
    original = structuredClone(f.profile);
  const program = f.code(`
    const first = await api.host.call('variables.read', {key:'mood'});
    await api.host.call('variables.set', {key:'mood', value:''});
    const blank = await api.host.call('variables.read', {key:'mood'});
    await api.host.call('variables.set', {key:'mood', value:'bright'});
    const listed = await api.host.call('materials.list', {});
    const material = await api.host.call('materials.read', {id:listed.items[0].id});
    await api.host.call('variables.delete', {key:'mood'});
    const fallback = await api.host.call('variables.read', {key:'mood'});
    await api.host.call('variables.set', {key:'custom', value:'7'});
    const keys = await api.host.call('variables.list', {});
    return {state: api.state, result:{first:first.value,blank:blank.value,fallback:fallback.value,material:material.text,keys:keys.items}};
  `);
  const result = await executePackageExtensionProgram(program, input, undefined, f.options);
  expect(result.result).toMatchObject({
    first: 'calm',
    blank: '',
    fallback: 'calm',
    material: 'bright',
    keys: [
      { key: 'custom', overridden: true },
      { key: 'mood', overridden: false },
    ],
  });
  expect(result.variables).toMatchObject({
    beforeRevision: 0,
    changes: { mood: null, custom: '7' },
  });
  expect(projectExtensionVariableMutation({ revision: 0, values: {} }, result.variables!)).toEqual({
    revision: 1,
    values: { custom: '7' },
  });
  expect(() =>
    validateExtensionVariablePermission(result.variables!, f.profile, f.ref, program)
  ).not.toThrow();
  expect(f.profile).toEqual(original);
});

test('denied writes can be handled as a read-only fallback but never create staged changes', async () => {
  const f = variableFixture();
  delete f.profile.extensionGrants;
  const result = await executePackageExtensionProgram(
    f.code(`
    const before = await api.host.call('variables.read', {key:'mood'});
    try { await api.host.call('variables.set', {key:'mood',value:'forbidden'}); }
    catch (error) { return {state:api.state,result:before.value}; }
    throw new Error('write should be denied');
  `),
    input,
    undefined,
    f.options
  );
  expect(result.result).toBe('calm');
  expect(result.variables?.changes).toEqual({});
  expect(projectExtensionVariableMutation({ revision: 0, values: {} }, result.variables!)).toEqual({
    revision: 0,
    values: {},
  });
});

test('final write revocation preserves an unadopted Host receipt, and a guest cannot forge variable effects', async () => {
  const f = variableFixture(),
    onExecuted = vi.fn();
  let allowed = true;
  await expect(
    executePackageExtensionProgram(
      f.code(`
    await api.host.call('variables.set',{key:'mood',value:'staged'});
    await api.host.call('response.read',{});
    return {state:api.state,result:'computed'};
  `),
      input,
      undefined,
      {
        ...f.options,
        onExecuted,
        responseHost: async () => {
          allowed = false;
          return null;
        },
        assertVariableWriteAccess: () => {
          if (!allowed) throw new ExtensionProgramError('BEHAVIOR_HOST_VARIABLES_DENIED');
        },
      }
    )
  ).rejects.toThrow('BEHAVIOR_HOST_VARIABLES_DENIED');
  expect(onExecuted).toHaveBeenCalledWith(
    expect.objectContaining({ variables: expect.objectContaining({ changes: { mood: 'staged' } }) })
  );
  expect(f.profile).not.toHaveProperty('variableState');
  await expect(
    executePackageExtensionProgram(
      f.code(`return {state:api.state,result:null,variables:{changes:{mood:'forged'}}};`),
      input,
      undefined,
      f.options
    )
  ).rejects.toThrow();
});

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
