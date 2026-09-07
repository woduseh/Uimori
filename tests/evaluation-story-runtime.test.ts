import { afterEach, expect, test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { runStoryJob, type StoryHooks, type StoryInput } from '../server/story-runner.js';
import { defaultStoryConfig, type StoryJob, type StorySnapshot } from '../core/story.js';
import { defaultEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import { memoryHash } from '../core/memory.js';
import type { RunSnapshot, Source, ToolEvent } from '../core/types.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  vi.unstubAllEnvs();
});
const credentialEnv = 'Evaluation_Story_Key';
type Body = { input: any[]; tools: { name: string }[]; [key: string]: any };
async function fixture(
  handler: (body: Body, response: ServerResponse, count: number) => void | Promise<void>
) {
  vi.stubEnv(credentialEnv, 'synthetic-evaluation-story-key');
  const failures: unknown[] = [];
  const server = await loopbackProvider(async (request, response) => {
    try {
      expect(request.url).toBe('/v1/responses');
      expect(request.headers.authorization).toBe('Bearer synthetic-evaluation-story-key');
      await handler(JSON.parse(request.body), response, server.requests.length);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  closes.push(server.close);
  return { ...server, failures };
}
function bundle(kind: 'state' | 'memory', origin: string) {
  const text = 'Mira spent three coins at the harbor.';
  const source: Source = {
    id: 'source-evaluation',
    chatId: 'chat-evaluation',
    hash: memoryHash(text),
    text,
    parentRevision: null,
    runId: 'run-evaluation',
  };
  const job: StoryJob = {
    id: 'job-evaluation',
    chatId: source.chatId,
    sourceRevision: source.id,
    sourceHash: source.hash,
    kind,
    configRevision: 1,
    generation: 1,
    owner: 'synthetic-worker',
    status: 'running',
    error: null,
    mock: false,
    createdAt: '',
    updatedAt: '',
    result: null,
  };
  const story: StorySnapshot = {
    config: {
      ...defaultStoryConfig(),
      revision: 1,
      memory: { enabled: true, model: null, recentCount: 2, maxPacketChars: 60000 },
      module: {
        id: 'coins',
        revision: 1,
        name: 'Synthetic coins',
        mode: 'authoritative',
        fields: {
          coins: {
            type: 'number',
            initial: 10,
            min: 0,
            max: 100,
            description: 'Spend three coins',
          },
        },
        rules: { spend: { field: 'coins', delta: -3 } },
      },
    },
    state: {
      id: 'initial',
      sourceRevision: null,
      sourceHash: null,
      moduleRevision: 1,
      values: { coins: 10 },
      canonical: true,
    },
    waiting: false,
    lineageHash: 'lineage-evaluation',
    canonHash: memoryHash('[]'),
    memory: null,
    models: {
      [kind]: {
        id: 'evaluated-model',
        revision: 1,
        title: 'Synthetic evaluated model',
        connectionId: 'conn-responses',
        modelId: `synthetic-evaluated-${kind}`,
        maxOutputTokens: 2048,
        temperature: null,
        timeoutMs: 4000,
        evaluationTools: defaultEvaluationToolOptions(),
        connection: {
          id: 'conn-responses',
          revision: 1,
          title: 'Local Responses',
          enabled: true,
          protocol: 'openai-responses-v1',
          endpoint: `${origin}/v1`,
          credentialEnv,
          catalog: [],
          catalogError: null,
        },
      },
    },
  };
  const snapshot: RunSnapshot = {
    chatId: source.chatId,
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: true, maxCalls: 4 },
    request: 'Continue',
    history: [],
    story,
    resources: [
      {
        id: 'local-lore',
        chatId: source.chatId,
        kind: 'lore',
        revision: 1,
        title: 'Coin reference',
        description: 'Synthetic guidance',
        text: 'Coins are copper.',
      },
      {
        id: 'other-chat-lore',
        chatId: 'other-chat',
        kind: 'lore',
        revision: 1,
        title: 'HIDDEN_STORY_CANARY',
        description: 'HIDDEN_STORY_CANARY',
        text: 'HIDDEN_STORY_CANARY',
      },
    ],
  };
  return { source, job, snapshot };
}
function observed(origin: string, extra: Partial<StoryHooks> = {}) {
  const inputs: StoryInput[] = [];
  const events: ToolEvent[] = [];
  const attempts: { id: string; wire: WireRecord; result?: ProviderResult }[] = [];
  const hooks: StoryHooks = {
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
      const id = `attempt-${attempts.length}`;
      attempts.push({ id, wire });
      return id;
    },
    onAttemptFinish: (id, result) => {
      attempts.find((attempt) => attempt.id === id)!.result = result;
    },
    ...extra,
  };
  return { hooks, inputs, events, attempts };
}
const packet = (body: Body) => {
  const message = body.input.find((item) => item.role === 'user' && Array.isArray(item.content));
  const text = message.content[0].text as string;
  return JSON.parse(text.slice(text.indexOf('\n') + 1));
};
function call(body: Body, name: string, args: unknown, id: string): Json {
  const alias = body.tools.find((tool) =>
    tool.name.endsWith('_' + name.replaceAll('.', '_'))
  )?.name;
  if (!alias) throw new Error('Missing evaluation story tool: ' + name);
  return {
    type: 'function_call',
    name: alias,
    call_id: id,
    id: `item-${id}`,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}
const terminal = (body: Body, output: unknown) =>
  call(
    body,
    'eval_submit_artifact',
    { content: JSON.stringify(output), userFacingNotice: 'PRIVATE_STORY_NOTICE' },
    'terminal'
  );
const opaque: Json = {
  type: 'reasoning',
  id: 'reasoning-evaluation',
  encrypted_content: 'PRIVATE_STORY_OPAQUE',
  summary: [{ type: 'summary_text', text: 'PRIVATE_STORY_REASONING' }],
};
async function send(target: ServerResponse, output: Json[], json = false) {
  const response = {
    id: randomUUID(),
    status: 'completed',
    output,
    usage: { input_tokens: 13, output_tokens: 5 },
  };
  if (json) {
    target.writeHead(200, { 'content-type': 'application/json' });
    target.end(JSON.stringify(response));
  } else await writeSse(target, [{ type: 'response.completed', response }]);
}
function stateResult(source: Source) {
  const quote = 'spent three coins';
  const start = source.text.indexOf(quote);
  return {
    sourceRevision: source.id,
    sourceHash: source.hash,
    moduleRevision: 1,
    operations: [
      {
        id: 'spend-one',
        kind: 'event',
        event: 'spend',
        evidence: { start, end: start + quote.length, quote },
      },
    ],
  };
}
function memoryResult(source: Source) {
  return {
    entries: [
      {
        id: 'memory-one',
        chatId: source.chatId,
        atRevision: source.id,
        atHash: source.hash,
        kind: 'observed-story',
        text: source.text,
        sources: [
          {
            revision: source.id,
            hash: source.hash,
            start: 0,
            end: source.text.length,
            quote: source.text,
          },
        ],
      },
    ],
  };
}

test('M2 state uses preset evaluation and mixed local/host tool results while keeping native continuation private', async () => {
  const server = await fixture(async (body, response, count) => {
    expect(log.attempts).toHaveLength(count);
    expect(log.attempts[count - 1].wire.role).toBe('state');
    expect(body).toMatchObject({ model: 'synthetic-evaluated-state' });
    expect(packet(body).source).toMatchObject({
      revision: work.source.id,
      hash: work.source.hash,
      text: work.source.text,
      previousState: { coins: 10 },
    });
    expect(JSON.stringify(body)).not.toContain('HIDDEN_STORY_CANARY');
    if (count === 1)
      await send(response, [
        opaque,
        call(body, 'eval_get_context', {}, 'local-context'),
        call(body, 'knowledge.read', { id: 'local-lore' }, 'host-read'),
      ]);
    else {
      expect(body.input[1]).toEqual(opaque);
      const results = body.input.filter((item) => item.type === 'function_call_output');
      expect(results.map((item) => item.call_id)).toEqual(['local-context', 'host-read']);
      expect(results[1].output).toContain('Coins are copper.');
      await send(response, [terminal(body, stateResult(work.source))]);
    }
  });
  const work = bundle('state', server.origin);
  const original = structuredClone(work);
  const log = observed(server.origin);
  const outcome = await runStoryJob(work, log.hooks);
  expect(server.failures, JSON.stringify(server.failures)).toEqual([]);
  expect(outcome).toEqual({
    status: 'completed',
    result: stateResult(work.source),
    error: null,
    mock: false,
  });
  expect(work).toEqual(original);
  expect(log.events.map((event) => event.name)).toEqual([
    'eval_get_context',
    'knowledge.read',
    'eval_submit_artifact',
  ]);
  expect(
    log.attempts.every(
      (attempt) => attempt.result?.usage.inputTokens === 13 && attempt.result.usage.costUsd === null
    )
  ).toBe(true);
  expect(JSON.stringify(log)).not.toMatch(
    /PRIVATE_STORY_NOTICE|PRIVATE_STORY_OPAQUE|PRIVATE_STORY_REASONING|synthetic-evaluation-story-key/
  );
});

test('M2 memory honors preloaded evaluation case selection and buffered JSON artifact with exact source evidence', async () => {
  const caseArgs = {
    contentType: 'other',
    riskLevel: 'low',
    contentSummary: 'Synthetic memory extraction',
    requestedContinuationDirection: 'Extract observed story',
    safetyContinuationDirection: 'Keep host permissions',
    intendedAudience: 'internal',
    hasMitigations: true,
    containsPersonalInfo: false,
  };
  const server = await fixture(async (body, response, count) => {
    expect(log.attempts[count - 1].wire.role).toBe('memory');
    expect(packet(body).source).toMatchObject({ revision: work.source.id, hash: work.source.hash });
    expect(body.tools.some((tool) => tool.name.endsWith('_eval_get_context'))).toBe(false);
    if (count === 1) {
      expect(body.tool_choice.name).toContain('eval_create_case');
      expect(body.max_output_tokens).toBe(8000);
      expect(body.reasoning).toEqual({ effort: 'low' });
      await send(response, [call(body, 'eval_create_case', caseArgs, 'case')], true);
    } else {
      expect(body.tool_choice).toBe('auto');
      expect(body.max_output_tokens).toBe(12000);
      expect(body.reasoning).toEqual({ effort: 'high' });
      expect(body.input.at(-1).output).toContain('"decision":"accepted"');
      expect(body.input.at(-1).output).toContain(
        '"selectedContinuationDirection":"Extract observed story"'
      );
      await send(response, [terminal(body, memoryResult(work.source))], true);
    }
  });
  const work = bundle('memory', server.origin);
  const model = work.snapshot.story!.models.memory!;
  model.maxOutputTokens = 12000;
  model.reasoningEffort = 'high';
  model.evaluationTools!.contextMode = 'preloaded';
  model.evaluationTools!.approvalReasoningMode = 'economized';
  const original = structuredClone(work);
  const log = observed(server.origin);
  const outcome = await runStoryJob(work, log.hooks);
  expect(server.failures, JSON.stringify(server.failures)).toEqual([]);
  expect(outcome).toEqual({
    status: 'completed',
    result: memoryResult(work.source),
    error: null,
    mock: false,
  });
  expect(work).toEqual(original);
  expect(log.attempts).toHaveLength(2);
  expect(log.events[0]).toMatchObject({ name: 'eval_create_case', denied: false });
  expect(JSON.stringify(log)).not.toContain('PRIVATE_STORY_NOTICE');
});

test('evaluation terminal delivery still passes M2 state/hash and memory/canon validators without retry', async () => {
  for (const kind of ['state', 'memory'] as const) {
    const server = await fixture(async (body, response) => {
      const invalid =
        kind === 'state'
          ? { ...stateResult(work.source), sourceHash: 'wrong-source-hash' }
          : {
              entries: [
                {
                  id: 'forged',
                  chatId: work.source.chatId,
                  atRevision: work.source.id,
                  atHash: work.source.hash,
                  kind: 'author-canon',
                  text: work.source.text,
                  declaration: { author: 'model', text: work.source.text },
                },
              ],
            };
      await send(response, [terminal(body, invalid)]);
    });
    const work = bundle(kind, server.origin);
    const log = observed(server.origin);
    const result = await runStoryJob(work, log.hooks);
    expect(result.status).toBe('failed');
    expect(result.result).toBeNull();
    expect(result.error).toMatch(/^(STATE|STORY|MEMORY)_/);
    expect(server.failures).toEqual([]);
    expect(server.requests).toHaveLength(1);
    expect(log.attempts[0].result).toMatchObject({
      status: 'tool_calls',
      usage: { inputTokens: 13, costUsd: null },
    });
    expect(JSON.stringify(log)).not.toContain('PRIVATE_STORY_NOTICE');
  }
});

test('M2 evaluation tools cannot bypass next-round authorization or cross-chat host read scope', async () => {
  for (const kind of ['state', 'memory'] as const) {
    const server = await fixture(async (body, response) =>
      send(response, [
        call(body, 'eval_get_context', {}, 'context'),
        ...(kind === 'memory'
          ? [call(body, 'knowledge.read', { id: 'other-chat-lore' }, 'hidden-read')]
          : []),
      ])
    );
    const work = bundle(kind, server.origin);
    let authorizationChecks = 0;
    const log = observed(server.origin, {
      authorize: (connection) => ({ ...connection, enabled: ++authorizationChecks === 1 }),
    });
    const result = await runStoryJob(work, log.hooks);
    expect(result).toMatchObject({
      status: 'failed',
      result: null,
      error: kind === 'state' ? 'CONNECTION_NOT_AUTHORIZED' : 'READ_TOOL_DENIED',
    });
    expect(server.requests).toHaveLength(1);
    expect(server.failures).toEqual([]);
    expect(log.events[0].name).toBe('eval_get_context');
    if (kind === 'memory') expect(log.events[1].denied).toBe(true);
    expect(JSON.stringify(log)).not.toContain('HIDDEN_STORY_CANARY');
  }
});

test('M2 evaluation session maximumToolRounds and host maxCalls both cap real requests', async () => {
  for (const kind of ['state', 'memory'] as const) {
    const server = await fixture(async (body, response, count) =>
      send(response, [call(body, 'eval_get_context', {}, `context-${count}`)])
    );
    const work = bundle(kind, server.origin);
    if (kind === 'state') work.snapshot.story!.models.state!.evaluationTools!.maximumToolRounds = 0;
    else work.snapshot.settings.maxCalls = 1;
    const log = observed(server.origin);
    expect(await runStoryJob(work, log.hooks)).toMatchObject({
      status: 'failed',
      result: null,
      error: 'MODEL_CALL_BUDGET_EXHAUSTED',
    });
    expect(server.requests).toHaveLength(1);
    expect(log.attempts).toHaveLength(1);
    expect(server.failures).toEqual([]);
  }
});

test('M2 evaluation deadline includes local-tool processing and is not reset before the next HTTP round', async () => {
  const server = await fixture(async (body, response) =>
    send(response, [call(body, 'eval_get_context', {}, 'context')])
  );
  const work = bundle('memory', server.origin);
  work.snapshot.story!.models.memory!.timeoutMs = 500;
  const log = observed(server.origin, {
    onToolEvent: async () => {
      await delay(550);
    },
  });
  expect(await runStoryJob(work, log.hooks)).toMatchObject({
    status: 'failed',
    result: null,
    error: 'TIMEOUT',
  });
  expect(server.failures).toEqual([]);
  expect(server.requests).toHaveLength(1);
  expect(log.attempts).toHaveLength(1);
  expect(log.attempts[0].result).toMatchObject({
    status: 'tool_calls',
    usage: { inputTokens: 13, outputTokens: 5, costUsd: null },
  });
});
