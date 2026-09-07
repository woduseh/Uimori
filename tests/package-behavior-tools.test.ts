import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultProfile, type ProviderProtocol } from '../core/product.js';
import { modelCapability } from '../core/model-capabilities.js';
import type { ContentPackage } from '../core/content-package.js';
import type { PackageBehavior } from '../core/package-behavior.js';
import { behaviorInputJsonSchema, listBehaviorTools } from '../core/package-behavior-tools.js';
import { buildMainInput, executeTool } from '../core/provider.js';
import type { ModelInput, RunSnapshot, ToolEvent } from '../core/types.js';
import type { Json, WireRecord } from '../core/transport.js';
import { buildMainProviderRequest, encodeMainPreview } from '../server/main-request.js';
import { runMain, type MainHooks } from '../server/model-runner.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

function behavior(): PackageBehavior {
  return {
    revision: 1,
    schemaVersion: 1,
    stateSchema: {
      type: 'record',
      properties: { hiddenCount: { type: 'number', min: 0, max: 100 } },
    },
    initialState: { hiddenCount: 37 },
    outputParsers: [],
    actions: [
      { id: 'user_only', inputSchema: { type: 'record', properties: {} }, effects: [] },
      {
        id: 'resolve_check',
        label: 'Resolve persuasion',
        description: 'Resolve one persuasion attempt in the current scene.',
        triggers: ['model'],
        inputSchema: {
          type: 'record',
          properties: {
            intent: { type: 'string', maxLength: 120 },
            difficulty: { type: 'enum', values: ['easy', 'hard'] },
          },
        },
        draws: [{ id: 'die', type: 'integer', min: 1, max: 20 }],
        effects: [],
      },
    ],
  };
}
function snapshot(
  endpoint = 'http://127.0.0.1:19999/turn',
  protocol: ProviderProtocol = 'fixture-sse-v1'
): RunSnapshot {
  const pkg: ContentPackage = {
    version: 1,
    id: 'rules',
    revision: 1,
    title: 'Synthetic rules',
    description: '',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    behavior: behavior(),
  };
  return {
    chatId: 'synthetic',
    parentRevision: null,
    settingsRevision: 1,
    request: 'Persuade the keeper.',
    history: [],
    resources: [],
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 3 },
    profile: {
      ...defaultProfile('synthetic'),
      contents: [],
      packageAttachments: [{ id: pkg.id, revision: 1, role: 'bot' }],
      packages: [pkg],
      models: {
        main: {
          id: 'model',
          revision: 1,
          title: 'Synthetic model',
          connectionId: 'connection',
          modelId: 'synthetic-model',
          maxOutputTokens: 1024,
          temperature: null,
          connection: {
            id: 'connection',
            revision: 1,
            title: 'Local synthetic only',
            enabled: true,
            protocol,
            endpoint,
            catalog: [],
            catalogError: null,
          },
        },
      },
    },
  };
}
function hooks(origin: string, extra: Partial<MainHooks> = {}) {
  const inputs: ModelInput[] = [],
    events: ToolEvent[] = [],
    attempts: WireRecord[] = [];
  const value: MainHooks = {
    signal: new AbortController().signal,
    approvedOrigins: [origin],
    authorize: (value) => value,
    onInput: (input) => {
      inputs.push(input);
    },
    onToolEvent: (event) => {
      events.push(event);
    },
    onAttemptStart: (wire) => {
      attempts.push(wire);
      return String(attempts.length);
    },
    onAttemptFinish: () => {},
    ...extra,
  };
  return { value, inputs, events, attempts };
}

describe('Author-selected behavior tool surface', () => {
  test('BT01 converts constraints recursively without exposing internal rules or state', () => {
    const schema = behaviorInputJsonSchema({
      type: 'record',
      properties: {
        amount: {
          type: 'number',
          integer: true,
          min: 1,
          max: 6,
          label: 'Amount',
          description: 'Requested amount',
        },
        flag: { type: 'boolean' },
        tags: { type: 'list', maxItems: 2, items: { type: 'string', maxLength: 10 } },
        choice: { type: 'enum', values: [true, 'unknown', 3] },
        nested: { type: 'record', properties: { value: { type: 'number', min: -1, max: 1 } } },
      },
    });
    expect(schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['amount', 'flag', 'tags', 'choice', 'nested'],
      properties: {
        amount: {
          type: 'integer',
          minimum: 1,
          maximum: 6,
          title: 'Amount',
          description: 'Requested amount',
        },
        flag: { type: 'boolean' },
        tags: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 10 } },
        choice: { enum: [true, 'unknown', 3] },
        nested: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'number', minimum: -1, maximum: 1 } },
        },
      },
    });
    const work = snapshot(),
      before = structuredClone(work),
      bindings = listBehaviorTools(work),
      built = buildMainProviderRequest(work);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ instanceId: 'rules:bot', actionId: 'resolve_check' });
    expect(bindings[0].tool.name).toMatch(/^behavior_[a-f0-9]{16}$/);
    expect(built.request.stable.tools).toContainEqual(bindings[0].tool);
    expect(built.input.tools).toEqual(built.request.stable.tools.map((tool) => tool.name));
    expect(JSON.stringify(built.request.stable)).not.toMatch(
      /hiddenCount|initialState|outputParsers|effects|"draws"|user_only/
    );
    expect(work).toEqual(before);
  });

  test('BT02 defaults to user only and exact attachment/role selection, excluding disabled persona', () => {
    const work = snapshot(),
      pkg = work.profile!.packages![0];
    delete pkg.behavior!.actions[1].triggers;
    expect(listBehaviorTools(work)).toEqual([]);
    expect(buildMainInput(work).tools).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^behavior_/)])
    );
    pkg.behavior!.actions[1].triggers = ['model'];
    const bot = listBehaviorTools(work)[0];
    work.profile!.packageAttachments!.push({ id: pkg.id, revision: 1, role: 'persona' });
    expect(listBehaviorTools(work)).toHaveLength(2);
    expect(new Set(listBehaviorTools(work).map((binding) => binding.tool.name)).size).toBe(2);
    work.profile!.personaReference = false;
    expect(listBehaviorTools(work)).toEqual([bot]);
    work.profile!.packages!.push({
      ...structuredClone(pkg),
      id: 'unattached',
      title: 'UNATTACHED_RULE_CANARY',
    });
    expect(JSON.stringify(listBehaviorTools(work))).not.toContain('UNATTACHED_RULE_CANARY');
    const action = {
      callId: 'permission-test',
      name: bot.tool.name,
      args: { intent: 'test', difficulty: 'easy' },
    };
    for (const role of ['main', 'translation', 'status', 'image'] as const)
      expect(executeTool(work, action, undefined, role)).toMatchObject({
        denied: true,
        args: {},
        result: { code: 'TOOL_NOT_ALLOWED' },
      });
  });

  test('BT03 enforces the shared tool limit and rejects known unsupported models before attempts', async () => {
    const work = snapshot(),
      template = work.profile!.packages![0].behavior!.actions[1];
    work.profile!.packages![0].behavior!.actions = Array.from({ length: 20 }, (_, index) => ({
      ...template,
      id: `action_${index}`,
    }));
    expect(listBehaviorTools(work)).toHaveLength(20);
    work.profile!.packages![0].behavior!.actions.push({ ...template, id: 'one_too_many' });
    expect(() => buildMainProviderRequest(work)).toThrow('BEHAVIOR_MODEL_ACTION_LIMIT');
    const observed = hooks('http://127.0.0.1:19999');
    expect(await runMain(work, observed.value)).toMatchObject({
      status: 'error',
      error: 'BEHAVIOR_MODEL_ACTION_LIMIT',
      usage: { modelCalls: 0 },
    });
    for (const kind of ['catalog', 'override'] as const) {
      const unsupported = snapshot(),
        target = unsupported.profile!.models.main!;
      if (kind === 'catalog')
        target.connection.catalog = [
          {
            id: target.modelId,
            name: target.modelId,
            capabilities: { tools: false },
            priceRevision: null,
          },
        ];
      else
        target.userOverrides = {
          tools: false,
          structuredOutput: null,
          note: 'Synthetic unsupported route',
        };
      expect(() => buildMainProviderRequest(unsupported)).toThrow(
        'BEHAVIOR_MODEL_TOOLS_UNSUPPORTED'
      );
      expect(await runMain(unsupported, observed.value)).toMatchObject({
        status: 'error',
        error: 'BEHAVIOR_MODEL_TOOLS_UNSUPPORTED',
        usage: { modelCalls: 0 },
      });
    }
    expect(observed.attempts).toEqual([]);
    expect(observed.events).toEqual([]);
    expect(observed.inputs).toEqual([]);
  });

  test.each([
    'openai-responses-v1',
    'openai-chat-v1',
    'vercel-chat-v1',
    'anthropic-messages-v1',
    'vertex-gemini-v1',
  ] as const)('BT04 %s native preview carries the same selected input schema', (protocol) => {
    const endpoint =
      protocol === 'vertex-gemini-v1'
        ? 'https://aiplatform.googleapis.com/v1/projects/synthetic/locations/global/publishers/google/models'
        : 'http://127.0.0.1:19999/v1';
    const work = snapshot(endpoint, protocol);
    if (protocol === 'vertex-gemini-v1') {
      const target = work.profile!.models.main!;
      target.modelId = 'gemini-3.8-flash';
      target.capabilityRevision = modelCapability(protocol, target.modelId)!.revision;
    }
    const selected = listBehaviorTools(work)[0],
      built = buildMainProviderRequest(work);
    const encoded = encodeMainPreview(built.request, work.profile!.models.main!);
    expect(JSON.stringify(encoded.body)).toContain(selected.tool.name);
    expect(JSON.stringify(encoded.body)).toContain('Resolve one persuasion attempt');
    expect(JSON.stringify(encoded.body)).toContain('maxLength');
    expect(JSON.stringify(encoded.body)).not.toContain('hiddenCount');
  });
});

describe('Main behavior tool execution through local provider transports', () => {
  test('BT05 executes exact frozen bindings, resumes with compact results and keeps prompt inputs stable', async () => {
    let actionName = '',
      executions = 0;
    const server = await loopbackProvider(async (captured, response) => {
      if (server.requests.length === 1)
        await writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: 'resolve-1',
            name: actionName,
            argumentsDelta: '{"intent":"persuade","difficulty":"easy"}',
          },
          { type: 'opaque_state', state: { continuation: 'synthetic-continuation' } },
          { type: 'done', reason: 'tool_calls' },
        ]);
      else {
        const body = JSON.parse(captured.body);
        expect(body.input.results).toEqual([
          {
            callId: 'resolve-1',
            name: actionName,
            args: { intent: 'persuade', difficulty: 'easy' },
            denied: false,
            result: { accepted: true, result: { success: true, total: 17 } },
          },
        ]);
        expect(body.opaqueState).toEqual({ continuation: 'synthetic-continuation' });
        await writeSse(response, [
          { type: 'text_delta', delta: 'The keeper accepted the appeal.' },
          { type: 'done', reason: 'stop' },
        ]);
      }
    });
    cleanups.push(server.close);
    const work = snapshot(server.endpoint),
      before = structuredClone(work);
    actionName = listBehaviorTools(work)[0].tool.name;
    const observed = hooks(server.origin, {
      onBehaviorTool: (binding, action) => {
        executions++;
        expect(binding).toEqual({ instanceId: 'rules:bot', actionId: 'resolve_check' });
        return {
          ...action,
          denied: false,
          result: { accepted: true, result: { success: true, total: 17 } },
        };
      },
    });
    expect(await runMain(work, observed.value)).toMatchObject({
      status: 'completed',
      text: 'The keeper accepted the appeal.',
      usage: { modelCalls: 2 },
    });
    expect(executions).toBe(1);
    expect(work).toEqual(before);
    expect(observed.events).toHaveLength(1);
    expect(observed.inputs.every((input) => input.tools.includes(actionName))).toBe(true);
    expect(observed.attempts[0].stablePrefixSha256).toBe(observed.attempts[1].stablePrefixSha256);
  });

  test.each(['unregistered', 'missing-executor', 'host-denial'] as const)(
    'BT06 %s cannot fall through to read permissions or another provider call',
    async (scenario) => {
      let actionName = '',
        executions = 0;
      const server = await loopbackProvider(async (_captured, response) =>
        writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: 'denied-1',
            name: actionName,
            argumentsDelta: '{"secret":"PRIVATE_ARGUMENT"}',
          },
          { type: 'done', reason: 'tool_calls' },
        ])
      );
      cleanups.push(server.close);
      const work = snapshot(server.endpoint);
      actionName =
        scenario === 'unregistered'
          ? 'behavior_not_registered'
          : listBehaviorTools(work)[0].tool.name;
      const observed = hooks(
        server.origin,
        scenario === 'missing-executor'
          ? {}
          : {
              onBehaviorTool: (_binding, action) => {
                executions++;
                return {
                  callId: action.callId,
                  name: action.name,
                  args: {},
                  denied: true,
                  result: { code: 'BEHAVIOR_INVALID_ARGUMENTS' },
                };
              },
            }
      );
      expect(await runMain(work, observed.value)).toMatchObject({
        status: 'error',
        error: 'ACTION_TOOL_DENIED',
        usage: { modelCalls: 1 },
      });
      expect(executions).toBe(scenario === 'host-denial' ? 1 : 0);
      expect(server.requests).toHaveLength(1);
      expect(observed.events).toHaveLength(1);
      expect(JSON.stringify(observed.events)).not.toContain('PRIVATE_ARGUMENT');
    }
  );

  test('BT07 preset evaluation tools coexist with host actions on Responses and preserve continuation into the final artifact', async () => {
    let actionName = '';
    const server = await loopbackProvider(async (captured, response) => {
      const body = JSON.parse(captured.body),
        alias = (name: string) =>
          body.tools.find((tool: { name: string }) => tool.name.endsWith('_' + name))!.name;
      const call = (name: string, id: string, args: Json): Json => ({
        type: 'function_call',
        id: `item-${id}`,
        call_id: id,
        name: alias(name),
        arguments: JSON.stringify(args),
        status: 'completed',
      });
      const output =
        server.requests.length === 1
          ? [
              call(actionName, 'action', { intent: 'persuade', difficulty: 'easy' }),
              call('eval_get_context', 'local', {}),
            ]
          : [
              call('eval_submit_artifact', 'final', {
                content: 'Synthetic resolved evaluated prose.',
                userFacingNotice: 'PRIVATE_NOTICE',
              }),
            ];
      if (server.requests.length === 2) {
        const outputs = body.input.filter(
          (item: { type: string }) => item.type === 'function_call_output'
        );
        expect(outputs.map((item: { call_id: string }) => item.call_id)).toEqual([
          'action',
          'local',
        ]);
        expect(outputs[0].output).toContain('success');
      }
      await writeSse(response, [
        {
          type: 'response.completed',
          response: {
            id: `response-${server.requests.length}`,
            status: 'completed',
            output,
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        },
      ]);
    });
    cleanups.push(server.close);
    const work = snapshot(`${server.origin}/v1`, 'openai-responses-v1');
    actionName = listBehaviorTools(work)[0].tool.name;
    work.profile!.models.main!.evaluationTools = {
      contextMode: 'model-selected',
      approvalReasoningMode: 'configured',
      maximumToolRounds: 8,
      terminalLateCorrections: false,
      outputRecovery: true,
    };
    work.profile!.models.main!.connection.credentialEnv = 'NARRATIVE_PROVIDER_BEHAVIOR_TEST';
    vi.stubEnv('NARRATIVE_PROVIDER_BEHAVIOR_TEST', 'synthetic-test-value');
    const observed = hooks(server.origin, {
      onBehaviorTool: (_binding, action) => ({
        ...action,
        denied: false,
        result: { success: true },
      }),
    });
    const outcome = await runMain(work, observed.value);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: 'completed',
      text: 'Synthetic resolved evaluated prose.',
      usage: { modelCalls: 2 },
    });
    expect(observed.events.map((event) => event.name)).toEqual([
      actionName,
      'eval_get_context',
      'eval_submit_artifact',
    ]);
    expect(JSON.stringify(observed.events)).not.toContain('PRIVATE_NOTICE');
  });
});
