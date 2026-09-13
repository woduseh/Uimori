import { afterEach, expect, test, vi } from 'vitest';
import type { ContentPackage } from '../core/content-package.js';
import {
  extensionModelTarget,
  validateExtensionModelAttribution,
} from '../core/extension-model.js';
import { ExtensionProgramError } from '../core/extension-program.js';
import type { Connection, ModelSnapshot } from '../core/product.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import type { WireRecord, ProviderResult } from '../core/transport.js';
import type { RunSnapshot, Usage } from '../core/types.js';
import { createExtensionModelService } from '../server/extension-model.js';
import type { MainHooks } from '../server/model-runner.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const binding = { instanceId: 'extension-model:module', actionId: 'generate' };

function model(endpoint: string, timeoutMs?: number): ModelSnapshot {
  const connection: Connection = {
    id: 'extension-connection',
    revision: 1,
    title: 'Frozen extension connection',
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
    catalog: [],
    catalogError: null,
  };
  return {
    id: 'extension-model',
    revision: 1,
    title: 'Frozen extension model',
    connectionId: connection.id,
    modelId: 'frozen-model-id',
    maxOutputTokens: 321,
    temperature: 0.4,
    inputTokenLimit: 32_000,
    enabled: true,
    ...(timeoutMs ? { timeoutMs } : {}),
    connection,
  };
}

function snapshot(
  target: ModelSnapshot,
  maxCalls = 6,
  options: {
    trigger?: 'model' | 'before-turn' | 'after-turn';
    deferredAutomatic?: boolean;
    behaviorExecution?: boolean;
  } = {}
): RunSnapshot {
  const pkg: ContentPackage = {
    version: 1,
    id: 'extension-model',
    revision: 1,
    title: 'Extension model fixture',
    description: 'Synthetic fixture',
    lore: [],
    controls: [],
    transforms: [],
    instructions: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      mode: 'authoritative',
      stateSchema: { type: 'record', properties: {} },
      initialState: {},
      actions: [
        {
          id: binding.actionId,
          triggers: [options.trigger ?? 'model'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: 'uimori-state-action-v1',
            capabilities: ['model.generate'],
            source: 'return {state: api.state, result: null};',
          },
        },
      ],
      outputParsers: [],
    },
  };
  return {
    settings: { maxCalls },
    ...(options.deferredAutomatic || options.behaviorExecution
      ? {
          behaviorExecution: {
            ...(options.deferredAutomatic ? { deferredAutomatic: true } : {}),
            automaticResults: [],
          },
        }
      : {}),
    profile: {
      packageAttachments: [{ id: pkg.id, revision: pkg.revision, role: 'module' }],
      packages: [pkg],
      extensionGrants: {
        [binding.instanceId]: { packageRevision: pkg.revision, capabilities: ['model.generate'] },
      },
      extensionModel: target,
    },
  } as unknown as RunSnapshot;
}

type Observed = {
  attempts: WireRecord[];
  finished: { id: string; result: ProviderResult }[];
  authorizeExtensionModel: ReturnType<typeof vi.fn>;
};

function hooks(target: ModelSnapshot, observed: Observed): MainHooks {
  return {
    signal: new AbortController().signal,
    approvedOrigins: [new URL(target.connection.endpoint).origin],
    authorize: (connection) => structuredClone(connection),
    authorizeExtensionModel: observed.authorizeExtensionModel as NonNullable<
      MainHooks['authorizeExtensionModel']
    >,
    onAttemptStart: (wire) => {
      observed.attempts.push(structuredClone(wire));
      return `attempt-${observed.attempts.length}`;
    },
    onAttemptFinish: (id, result) => {
      observed.finished.push({ id, result: structuredClone(result) });
    },
    onInput: () => {},
    onToolEvent: () => {},
  };
}

function observed(): Observed {
  return { attempts: [], finished: [], authorizeExtensionModel: vi.fn() };
}

test('uses only the frozen model request and preserves bounded output, attempts and shared usage', async () => {
  const generated = `${'가'.repeat(6_000)}\ud83dextra`;
  const provider = await loopbackProvider(async (_request, response) => {
    await writeSse(response, [
      { type: 'text_delta', delta: generated },
      { type: 'usage', inputTokens: 17, outputTokens: 23, costUsd: null },
      { type: 'done', reason: 'stop' },
    ]);
  });
  servers.push(provider);
  const target = model(provider.endpoint, 200_000);
  const log = observed();
  const usage: Usage = { modelCalls: 1, inputTokens: 5, outputTokens: 7, costUsd: 0 };
  const service = createExtensionModelService(snapshot(target), hooks(target, log), usage);

  const result = await service.generate(
    binding,
    { prompt: 'Classify this bounded input.' },
    new AbortController().signal
  );

  expect(result).toEqual({
    status: 'completed',
    text: '가'.repeat(6_000),
    truncated: true,
    error: null,
  });
  expect(result).not.toHaveProperty('usage');
  expect(service.hostWaitMs).toBe(800_000);
  expect(usage).toEqual({ modelCalls: 2, inputTokens: 22, outputTokens: 30, costUsd: null });
  expect(log.attempts).toHaveLength(1);
  expect(log.attempts[0]).toMatchObject({
    role: 'state',
    connectionId: target.connection.id,
    modelId: target.modelId,
    extensionAction: {
      instanceId: binding.instanceId,
      actionId: binding.actionId,
      packageId: 'extension-model',
      packageRevision: 1,
    },
  });
  expect(log.attempts[0].extensionAction).not.toHaveProperty('trigger');
  expect(log.finished).toHaveLength(1);
  expect(log.finished[0].result.opaqueState).toBeNull();
  expect(log.authorizeExtensionModel).toHaveBeenCalledTimes(4);
  const body = JSON.parse(provider.requests[0].body) as Record<string, unknown>;
  expect(body).toMatchObject({
    role: 'state',
    modelId: target.modelId,
    generation: { maxOutputTokens: 321, temperature: 0.4 },
    stable: { tools: [] },
    input: { task: 'Classify this bounded input.', controls: {} },
  });
  expect(body).not.toHaveProperty('history');
  expect(body).not.toHaveProperty('source');
  expect(body).not.toHaveProperty('endpoint');
  expect(body).not.toHaveProperty('credentialEnv');
});

test('admits deferred before-turn generation and marks only its durable attempt attribution', async () => {
  const provider = await loopbackProvider(async (_request, response) => {
    await writeSse(response, [
      { type: 'text_delta', delta: 'prepared result' },
      { type: 'usage', inputTokens: 4, outputTokens: 2, costUsd: 0 },
      { type: 'done', reason: 'stop' },
    ]);
  });
  servers.push(provider);
  const target = model(provider.endpoint);
  const log = observed();
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const beforeTurnBinding = { ...binding, trigger: 'before-turn' as const };
  const frozen = snapshot(target, 4, {
    trigger: 'before-turn',
    deferredAutomatic: true,
  });

  await expect(
    createExtensionModelService(frozen, hooks(target, log), usage).generate(
      beforeTurnBinding,
      { prompt: 'prepare automatic state' },
      new AbortController().signal
    )
  ).resolves.toMatchObject({ status: 'completed', text: 'prepared result' });

  expect(log.authorizeExtensionModel).toHaveBeenCalledWith(beforeTurnBinding);
  expect(log.attempts).toHaveLength(1);
  expect(log.attempts[0].extensionAction).toEqual({
    instanceId: binding.instanceId,
    actionId: binding.actionId,
    packageId: 'extension-model',
    packageRevision: 1,
    trigger: 'before-turn',
  });
  expect(usage).toEqual({ modelCalls: 1, inputTokens: 4, outputTokens: 2, costUsd: 0 });
});

test('keeps legacy attribution valid and rejects forged or undeferred trigger markers', () => {
  const target = model('http://127.0.0.1:1');
  const legacy = snapshot(target);
  const legacyAttribution = extensionModelTarget(legacy, binding).attribution;
  expect(legacyAttribution).toEqual({
    instanceId: binding.instanceId,
    actionId: binding.actionId,
    packageId: 'extension-model',
    packageRevision: 1,
  });
  expect(validateExtensionModelAttribution(legacy, legacyAttribution).attribution).toEqual(
    legacyAttribution
  );

  const automatic = snapshot(target, 6, {
    trigger: 'before-turn',
    deferredAutomatic: true,
  });
  const beforeTurnBinding = { ...binding, trigger: 'before-turn' as const };
  const automaticAttribution = extensionModelTarget(automatic, beforeTurnBinding).attribution;
  expect(validateExtensionModelAttribution(automatic, automaticAttribution).attribution).toEqual(
    automaticAttribution
  );
  expect(() =>
    extensionModelTarget(snapshot(target, 6, { trigger: 'before-turn' }), beforeTurnBinding)
  ).toThrow('BEHAVIOR_HOST_MODEL_DENIED');
  for (const trigger of ['model', 'user', 'future-trigger'])
    expect(() =>
      validateExtensionModelAttribution(automatic, {
        ...automaticAttribution,
        trigger,
      })
    ).toThrow('BEHAVIOR_HOST_MODEL_ATTRIBUTION');
});

test('admits only a frozen permitted after-turn target and validates its durable marker', () => {
  const target = model('http://127.0.0.1:1');
  const afterTurnBinding = { ...binding, trigger: 'after-turn' as const };
  const frozen = snapshot(target, 6, {
    trigger: 'after-turn',
    behaviorExecution: true,
  });
  const attribution = extensionModelTarget(frozen, afterTurnBinding).attribution;

  expect(attribution).toEqual({
    instanceId: binding.instanceId,
    actionId: binding.actionId,
    packageId: 'extension-model',
    packageRevision: 1,
    trigger: 'after-turn',
  });
  expect(validateExtensionModelAttribution(frozen, attribution).attribution).toEqual(attribution);
  expect(() =>
    extensionModelTarget(snapshot(target, 6, { trigger: 'after-turn' }), afterTurnBinding)
  ).toThrow('BEHAVIOR_HOST_MODEL_DENIED');

  const wrongGrant = structuredClone(frozen);
  wrongGrant.profile!.extensionGrants![binding.instanceId]!.packageRevision = 2;
  expect(() => extensionModelTarget(wrongGrant, afterTurnBinding)).toThrow(
    'BEHAVIOR_HOST_MODEL_DENIED'
  );
  const noTarget = structuredClone(frozen);
  delete noTarget.profile!.extensionModel;
  expect(() => extensionModelTarget(noTarget, afterTurnBinding)).toThrow(
    'BEHAVIOR_HOST_MODEL_UNAVAILABLE'
  );
});

test('uses the post-response budget only for after-turn and keeps generation main-call reserve', async () => {
  const provider = await loopbackProvider(async (_request, response) => {
    await writeSse(response, [
      { type: 'text_delta', delta: 'after result' },
      { type: 'usage', inputTokens: 2, outputTokens: 3, costUsd: 0 },
      { type: 'done', reason: 'stop' },
    ]);
  });
  servers.push(provider);
  const target = model(provider.endpoint);
  const afterTurnBinding = { ...binding, trigger: 'after-turn' as const };
  const frozen = snapshot(target, 2, {
    trigger: 'after-turn',
    behaviorExecution: true,
  });
  const log = observed();
  const usage: Usage = { modelCalls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const afterResponse = createExtensionModelService(frozen, hooks(target, log), usage, {
    phase: 'after-response',
  });
  const signal = new AbortController().signal;
  expect(afterResponse.hostWaitMs).toBe(120_000);

  await expect(
    afterResponse.generate(afterTurnBinding, { prompt: 'after response' }, signal)
  ).resolves.toMatchObject({ status: 'completed', text: 'after result' });
  await expect(
    afterResponse.generate(binding, { prompt: 'wrong binding' }, signal)
  ).rejects.toThrow('BEHAVIOR_HOST_MODEL_DENIED');
  await expect(
    afterResponse.generate(afterTurnBinding, { prompt: 'over budget' }, signal)
  ).rejects.toThrow('BEHAVIOR_HOST_MODEL_BUDGET_EXHAUSTED');
  expect(usage).toEqual({ modelCalls: 2, inputTokens: 2, outputTokens: 3, costUsd: 0 });
  expect(log.attempts[0].extensionAction).toMatchObject({ trigger: 'after-turn' });

  const generationUsage: Usage = {
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  await expect(
    createExtensionModelService(
      snapshot(target, 2),
      hooks(target, observed()),
      generationUsage
    ).generate(binding, { prompt: 'reserved for main prose' }, signal)
  ).rejects.toThrow('BEHAVIOR_HOST_MODEL_BUDGET_EXHAUSTED');
  await expect(
    createExtensionModelService(frozen, hooks(target, observed()), generationUsage).generate(
      afterTurnBinding,
      { prompt: 'wrong phase' },
      signal
    )
  ).rejects.toThrow('BEHAVIOR_HOST_MODEL_DENIED');
  expect(provider.requests).toHaveLength(1);
});

test('reserves concurrent calls before awaiting and keeps one call for final prose', async () => {
  const provider = await loopbackProvider(async (_request, response) => {
    await writeSse(response, [
      { type: 'text_delta', delta: 'bounded result' },
      { type: 'usage', inputTokens: 2, outputTokens: 3, costUsd: 0.01 },
      { type: 'done', reason: 'stop' },
    ]);
  });
  servers.push(provider);
  const target = model(provider.endpoint);
  const log = observed();
  const usage: Usage = { modelCalls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const service = createExtensionModelService(snapshot(target, 4), hooks(target, log), usage);
  const signal = new AbortController().signal;

  const outcomes = await Promise.allSettled([
    service.generate(binding, { prompt: 'first' }, signal),
    service.generate(binding, { prompt: 'second' }, signal),
    service.generate(binding, { prompt: 'over budget' }, signal),
  ]);

  expect(outcomes.slice(0, 2).every((outcome) => outcome.status === 'fulfilled')).toBe(true);
  expect(outcomes[2]).toMatchObject({
    status: 'rejected',
    reason: expect.objectContaining({ message: 'BEHAVIOR_HOST_MODEL_BUDGET_EXHAUSTED' }),
  });
  expect(provider.requests).toHaveLength(2);
  expect(log.attempts).toHaveLength(2);
  expect(log.finished).toHaveLength(2);
  expect(usage).toEqual({ modelCalls: 3, inputTokens: 4, outputTokens: 6, costUsd: 0.02 });
  expect(service.hostWaitMs).toBe(240_000);
});

test('denies missing permission and guest-selected request fields before any provider attempt', async () => {
  const provider = await loopbackProvider(async (_request, response) => {
    await writeSse(response, [{ type: 'done', reason: 'stop' }]);
  });
  servers.push(provider);
  const target = model(provider.endpoint);
  const noGrant = observed();
  const noGrantHooks = hooks(target, noGrant);
  delete noGrantHooks.authorizeExtensionModel;
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  await expect(
    createExtensionModelService(snapshot(target), noGrantHooks, usage).generate(
      binding,
      { prompt: 'try without grant' },
      new AbortController().signal
    )
  ).rejects.toThrow('BEHAVIOR_HOST_MODEL_DENIED');
  await expect(
    createExtensionModelService(snapshot(target), hooks(target, observed()), usage).generate(
      binding,
      {
        prompt: 'try to redirect',
        modelId: 'guest-model',
        endpoint: 'https://example.invalid',
        temperature: 2,
        maxCalls: 99,
        phase: 'after-response',
      } as RuntimeValue,
      new AbortController().signal
    )
  ).rejects.toThrow('BEHAVIOR_HOST_ARGUMENTS');
  expect(provider.requests).toHaveLength(0);
  expect(usage.modelCalls).toBe(0);
});

test('rechecks the user grant after a sent attempt while preserving its usage', async () => {
  const provider = await loopbackProvider(async (_request, response) => {
    await writeSse(response, [
      { type: 'text_delta', delta: 'late output' },
      { type: 'usage', inputTokens: 11, outputTokens: 13, costUsd: null },
      { type: 'done', reason: 'stop' },
    ]);
  });
  servers.push(provider);
  const target = model(provider.endpoint);
  const log = observed();
  log.authorizeExtensionModel.mockImplementation(() => {
    if (log.authorizeExtensionModel.mock.calls.length === 4)
      throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_DENIED');
  });
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  await expect(
    createExtensionModelService(snapshot(target), hooks(target, log), usage).generate(
      binding,
      { prompt: 'permission may be withdrawn' },
      new AbortController().signal
    )
  ).rejects.toThrow('BEHAVIOR_HOST_MODEL_DENIED');
  expect(provider.requests).toHaveLength(1);
  expect(log.attempts).toHaveLength(1);
  expect(log.finished).toHaveLength(1);
  expect(usage).toEqual({ modelCalls: 1, inputTokens: 11, outputTokens: 13, costUsd: null });
});

test('returns fixed guest errors for refusal and provider failure without exposing diagnostics', async () => {
  const provider = await loopbackProvider(async (request, response) => {
    const body = JSON.parse(request.body) as { input: { task: string } };
    if (body.input.task === 'refuse') {
      await writeSse(response, [
        { type: 'refusal', message: 'PRIVATE_PROVIDER_REFUSAL' },
        { type: 'usage', inputTokens: 3, outputTokens: 1, costUsd: null },
        { type: 'done', reason: 'refusal' },
      ]);
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ privateDiagnostic: 'PRIVATE_PROVIDER_DIAGNOSTIC' }));
  });
  servers.push(provider);
  const target = model(provider.endpoint);
  const log = observed();
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const service = createExtensionModelService(snapshot(target, 4), hooks(target, log), usage);
  const signal = new AbortController().signal;

  const refused = await service.generate(binding, { prompt: 'refuse' }, signal);
  const failed = await service.generate(binding, { prompt: 'fail' }, signal);

  expect(refused).toEqual({
    status: 'refused',
    text: '',
    truncated: false,
    error: 'BEHAVIOR_HOST_MODEL_REFUSED',
  });
  expect(failed).toEqual({
    status: 'error',
    text: '',
    truncated: false,
    error: 'BEHAVIOR_HOST_MODEL_FAILED',
  });
  expect(JSON.stringify([refused, failed])).not.toContain('PRIVATE_PROVIDER');
  expect(log.finished).toHaveLength(2);
  expect(usage.modelCalls).toBe(2);
  expect(usage.costUsd).toBeNull();
});
