import { setFixtureModelRoutes } from './fixtures/chat.js';
import {
  observeExecutions,
  observedExecution,
  observedAttempts,
} from './fixtures/execution-observer.js';
import { afterEach, expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createApp, type App } from '../server/app.js';
import {
  mainJudgmentInput,
  mainJudgmentRequest,
  validateMainJudgmentWire,
} from '../server/main-judgment.js';
import type { CodexRuntimeService } from '../server/codex-runtime.js';
import type { ExternalJudgmentProvider } from '../core/judgment-settings.js';
import type { ProviderRequest, WireRecord } from '../core/transport.js';
import { injectWithFixtureBot } from './fixtures/chat.js';
import { JEV_ENDPOINT } from '../server/jev-judgment.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { Store } from '../server/store.js';
import { nativeContent } from './fixtures/native-content.js';

const owned: { directory: string; app?: App }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    await item.app?.close();
    const path = resolve(item.directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-main-judgment-')
    )
      throw new Error('Unsafe fixture cleanup');
    await rm(path, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const judgmentEndpoints = {
  openai: {
    endpoint: 'https://api.openai.com/v1',
    modelId: 'gpt-6-luna',
    protocol: 'openai-responses-v1',
    wireProtocol: 'openai-decisions-v1',
  },
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    modelId: 'gemini-decision-1',
    protocol: 'google-gemini-v1',
    wireProtocol: 'gemini-decisions-v1',
  },
  'openai-compatible': {
    endpoint: 'https://ai-gateway.vercel.sh/v1',
    modelId: 'typesafe-ai/jev',
    protocol: 'openai-chat-v1',
    wireProtocol: 'openai-compatible-decisions-v1',
  },
  'typesafe-compatible': {
    endpoint: 'https://openrouter.ai/api/v1',
    modelId: 'jev-1.13',
    protocol: 'openai-chat-v1',
    wireProtocol: 'typesafe-compatible-systemone-v1',
  },
} satisfies Record<
  ExternalJudgmentProvider,
  {
    endpoint: string;
    modelId: string;
    protocol: string;
    wireProtocol: WireRecord['protocol'];
  }
>;
const externalKey = 'synthetic-judgment-key';
async function api(
  app: App,
  url: string,
  payload?: unknown,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' = payload === undefined ? 'GET' : 'POST'
) {
  const response = await injectWithFixtureBot(app, {
    method,
    url,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function fixture(
  candidate: string,
  scores: number | 'failure' | 'invalid' | 'budget',
  maxCalls = 8,
  key = true,
  scriptStage?: 'input' | 'editRequest' | 'recovery',
  judgmentEnabled = true,
  generationStatus: 'completed' | 'partial' = 'completed',
  mainThreshold = 0.9,
  createShellWorkspace = false,
  selectedProvider?: ExternalJudgmentProvider
) {
  vi.stubEnv('TYPESAFE_API_KEY', key ? 'synthetic-jev-key' : '');
  const selected = selectedProvider && judgmentEndpoints[selectedProvider];
  const gemini = selectedProvider === 'gemini';
  const systemOne = !selectedProvider || selectedProvider === 'typesafe-compatible';
  const judgmentEndpoint = selected
    ? `${selected.endpoint}/${systemOne ? 'systemone' : 'decisions'}`
    : JEV_ENDPOINT;
  const judged: Record<string, any>[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    expect(url).toBe(judgmentEndpoint);
    const body = JSON.parse(String(init?.body));
    judged.push(body);
    if (selected) {
      expect(new Headers(init?.headers).get(gemini ? 'x-goog-api-key' : 'authorization')).toBe(
        gemini ? externalKey : `Bearer ${externalKey}`
      );
      expect(body.model).toBe(selected.modelId);
      expect(systemOne ? body.state : JSON.parse(body.input)).toEqual({ response: candidate });
      if (gemini || systemOne) expect(body.questions.explicitRefusal.type).toBe('noul');
      else
        expect(body.questions).toEqual([
          expect.objectContaining({
            name: 'explicitRefusal',
            type: 'predicate',
          }),
        ]);
    }
    if (scores === 'failure') throw new Error('synthetic transport failed');
    if (scores === 'budget')
      return new Response(JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }), {
        status: 400,
      });
    const probability = scores === 'invalid' ? 2 : scores;
    return Response.json({
      ...(!gemini && { model: selected ? selected.modelId : 'jev-latest' }),
      answers:
        gemini || systemOne
          ? {
              explicitRefusal: {
                type: 'noul',
                noul: probability,
                ...(gemini && { confidence: 0.95 }),
              },
            }
          : [{ type: 'predicate', name: 'explicitRefusal', probability }],
      usage: gemini
        ? { total_input_tokens: 7, total_output_tokens: 0 }
        : { input_tokens: 7, output_tokens: systemOne ? 3 : 0 },
    });
  });
  const calls: ProviderRequest[] = [];
  const output = { text: candidate };
  let shellRoot: string | undefined;
  let shellWorkspace: string | undefined;
  const status = async () => ({
    available: true,
    authenticated: true,
    authMode: 'chatgpt' as const,
    error: null,
    login: null,
    planType: null,
    limits: [],
  });
  const runtime: CodexRuntimeService = {
    status,
    login: status,
    cancelLogin: status,
    logout: status,
    catalog: async () => [],
    close: async () => {},
    generateImage: async () => {
      throw new Error('Unexpected image generation');
    },
    execute: async (connection, request, options) => {
      calls.push(request);
      if (shellRoot && request.role === 'main') {
        const active = app.store.db.prepare("SELECT id FROM runs WHERE status='running'").get()!;
        shellWorkspace = join(shellRoot, 'tasks', String(active.id));
        mkdirSync(join(shellWorkspace, 'scratch'), { recursive: true });
        writeFileSync(join(shellWorkspace, 'scratch', 'private.txt'), 'temporary work');
      }
      const body = { method: 'turn/start', role: request.role, model: request.modelId };
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'RPC',
        url: 'codex://local',
        headers: {},
        body,
        bodySha256: digest(body),
        stablePrefixSha256: digest(request.stable),
      });
      return {
        status: generationStatus,
        text: output.text,
        toolCalls: [],
        refusal: null,
        error: null,
        opaqueState: null,
        usage: { inputTokens: 11, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
      };
    },
    executeAgent: async (connection, request, options) => {
      const packet = JSON.parse(request.text);
      return runtime.execute(
        connection,
        {
          role: request.role ?? 'helper',
          modelId: request.modelId,
          stable: { contract: packet.taskContract, tools: request.tools },
          input: packet.input,
        },
        options
      );
    },
  };
  const owner = {
    directory: await mkdtemp(join(tmpdir(), 'uimori-main-judgment-')),
  } as (typeof owned)[number];
  owned.push(owner);
  if (createShellWorkspace) {
    shellRoot = join(owner.directory, 'shell');
    vi.stubEnv('UIMORI_SHELL_ROOT', shellRoot);
  }
  const app = await createApp({
    dbPath: join(owner.directory, 'test.sqlite'),
    buildId: 'synthetic-main-judgment',
    testMode: true,
    codexRuntime: runtime,
  });
  owner.app = app;
  observeExecutions(app.store);
  if (key) app.store.credentials.set('jev', 'synthetic-jev-key');
  let judgmentConnectionId: string | undefined;
  if (selectedProvider && selected) {
    const selector = await api(app, '/api/connections', {
      title: 'Synthetic judgment provider',
      protocol: selected.protocol,
      endpoint: selected.endpoint,
      apiKey: externalKey,
      enabled: true,
    });
    judgmentConnectionId = selector.id;
    const workspace = await api(app, '/api/model-workspace');
    await api(
      app,
      '/api/model-workspace',
      {
        routes: workspace.routes,
        translationPolicy: workspace.translationPolicy,
        expectedRevision: workspace.revision,
        mainJudgmentEnabled: judgmentEnabled,
        mainJudgmentThreshold: mainThreshold,
        judgment: {
          provider: selectedProvider,
          connectionId: judgmentConnectionId,
          modelId: selected.modelId,
          images: false,
        },
      },
      'PUT'
    );
  } else {
    const workspace = modelWorkspace(app.store);
    updateModelWorkspace(app.store, {
      routes: workspace.routes,
      translationPolicy: workspace.translationPolicy,
      expectedRevision: workspace.revision,
      mainJudgmentEnabled: judgmentEnabled,
      mainJudgmentThreshold: mainThreshold,
    });
  }
  const connection = await api(app, '/api/connections', {
    title: 'Synthetic Codex',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  });
  const model = await api(app, '/api/model-presets', {
    title: 'Synthetic writer',
    connectionId: connection.id,
    modelId: 'synthetic-writer',
    maxOutputTokens: 2048,
    temperature: null,
  });
  let botId: string | undefined;
  if (scriptStage) {
    const code = `
local function tryCalls(id)
  LLM(id, 'First permitted script call')
  local ok = pcall(function() LLM(id, 'Must preserve writer and judgment') end)
  setChatVar(id, 'budgetBlocked', tostring(not ok))
end
${
  scriptStage === 'recovery'
    ? "function onInput(id) setChatVar(id, 'inputCount', tostring((tonumber(getChatVar(id, 'inputCount')) or 0) + 1)) end; function onOutput(id) setChatVar(id, 'outputCount', tostring((tonumber(getChatVar(id, 'outputCount')) or 0) + 1)) end"
    : scriptStage === 'input'
      ? 'function onInput(id) tryCalls(id) end'
      : "listenEdit('editRequest', function(id, messages) tryCalls(id); return messages end)"
}
`;
    const bot = await api(app, '/api/content', {
      kind: 'bot',
      title: 'Budget fixture',
      description: '',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: nativeContent({
        name: 'Budget fixture',
        extensions: {
          risuai: {
            lowLevelAccess: true,
            triggerscript: [
              { type: 'start', lowLevelAccess: true, effect: [{ type: 'triggerlua', code }] },
            ],
          },
        },
      }),
    });
    botId = bot.id;
  }
  const chat = await api(app, '/api/chats', {
    title: 'Judgment test',
    ...(botId ? { botId } : {}),
  });
  await api(
    app,
    `/api/chats/${chat.id}/settings`,
    {
      expectedSettingsRevision: chat.settingsRevision,
      ...chat.settings,

      maxCalls,
    },
    'PATCH'
  );
  const profile = await api(app, `/api/chats/${chat.id}/profile`);
  await setFixtureModelRoutes(app, { main: { id: model.id }, translation: null });
  await api(
    app,
    `/api/chats/${chat.id}/profile`,
    {
      expectedRevision: profile.revision,
      image: false,
      imageTranslation: false,
    },
    'PUT'
  );
  const run = await api(app, `/api/chats/${chat.id}/runs`, {
    request: 'Respond to the selected task.',
    expectedRevision: null,
    expectedSettingsRevision: app.store.chat(chat.id).settingsRevision,
    idempotencyKey: randomUUID(),
  });
  await expect
    .poll(() => app.store.run(run.id).status, { timeout: 6000 })
    .not.toMatch(/^(queued|running)$/u);
  return {
    app,
    chat,
    run: observedExecution(app.store, run.id),
    calls,
    judged,
    output,
    runtime,
    shellWorkspace,
    judgmentConnectionId,
    judgmentEndpoint,
  };
}

test.each(Object.keys(judgmentEndpoints) as ExternalJudgmentProvider[])(
  'routes main refusal judgment to the configured %s connection without a Jev key',
  async (provider) => {
    const candidate = 'The boat was still waiting at the pier.';
    const f = await fixture(
      candidate,
      0.05,
      8,
      false,
      undefined,
      true,
      'completed',
      0.9,
      false,
      provider
    );
    expect(f.run).toMatchObject({ status: 'completed', error: null, usage: { modelCalls: 2 } });
    expect(f.app.store.sourceOriginal(f.run.sourceRevision!).text).toBe(candidate);
    expect(f.calls.map(({ role }) => role)).toEqual(['main']);
    expect(f.judged).toHaveLength(1);
    const attempts = observedAttempts(f.app.store, f.run.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({
      status: 'completed',
      role: 'main',
      connectionId: f.judgmentConnectionId,
      modelId: judgmentEndpoints[provider].modelId,
      inputTokens: 7,
      outputTokens: provider === 'typesafe-compatible' ? 3 : 0,
      request: {
        protocol: judgmentEndpoints[provider].wireProtocol,
        url: f.judgmentEndpoint,
        judgment: { kind: 'main-refusal' },
      },
    });
    expect(
      f.app.store.db.prepare('SELECT usage_kind FROM attempts WHERE id=?').get(attempts[1].id)
    ).toMatchObject({ usage_kind: 'judgment' });
  }
);

test.each([
  ['I cannot fulfill this request.', 0.99, 'refused', 'MAIN_RESPONSE_REFUSED'],
  ['A preserved candidate.', 'failure', 'failed', 'JEV_EXECUTION_FAILED'],
  ['Invalid judgment keeps output.', 'invalid', 'failed', 'JEV_RESPONSE_INVALID'],
  ['Oversized judgment keeps output.', 'budget', 'failed', 'JEV_INPUT_BUDGET'],
] as const)('keeps %s out of canon without retrying', async (text, scores, status, error) => {
  const f = await fixture(text, scores);
  expect(f.run).toMatchObject({
    status,
    error,
    partialText: text,
    sourceRevision: null,
    usage: { modelCalls: 2 },
  });
  expect(f.app.store.chat(f.chat.id).headRevision).toBeNull();
  expect(f.run.snapshot.nativeRisuExecution?.output).toBeUndefined();
  expect(f.calls).toHaveLength(1);
  expect(f.judged).toHaveLength(1);
  expect(f.app.store.product.attempts(f.chat.id)).toHaveLength(2);
});

test.each([
  [1, true, 'MAIN_JUDGMENT_CALL_BUDGET'],
  [8, false, 'JEV_CREDENTIAL_REQUIRED'],
] as const)(
  'checks judgment budget/connection before paying for generation',
  async (budget, key, error) => {
    const f = await fixture('Never generated', 0.58, budget, key);
    expect(f.run).toMatchObject({ status: 'failed', error, sourceRevision: null });
    expect(f.calls).toEqual([]);
    expect(f.judged).toEqual([]);
  }
);

test('Lua input preserves a writer call and its JEV judgment', async () => {
  const stage = 'input' as const;
  const f = await fixture('A completed response.', 0.58, 3, true, stage);
  expect(f.run).toMatchObject({ status: 'completed', error: null, usage: { modelCalls: 3 } });
  expect(f.calls.map((call) => call.role)).toEqual(['script', 'main']);
  expect(f.judged).toHaveLength(1);
  expect(f.run.snapshot.nativeRisuExecution?.variables.budgetBlocked).toBe('true');
});
test('preserves the whole Unicode response and only asks about service refusal', () => {
  const candidate = '😀'.repeat(5000);
  const input = mainJudgmentInput(candidate);
  expect(input).toEqual({
    version: 'main-refusal-jev-v3',
    candidateHash: createHash('sha256').update(candidate).digest('hex'),
    response: candidate,
    threshold: 0.9,
  });
  expect(mainJudgmentRequest(input).state).toEqual({ response: candidate });
  expect(Object.keys(mainJudgmentRequest(input).questions)).toEqual(['explicitRefusal']);
  expect(mainJudgmentRequest(input).questions.explicitRefusal.type).toBe('noul');
});

test.each([
  { threshold: 0.7, score: 0.7, status: 'refused' },
  { threshold: 0.7, score: 0.69, status: 'completed' },
])(
  'uses the independently configured main threshold $threshold for score $score',
  async ({ threshold, score, status }) => {
    const f = await fixture('A response.', score, 8, true, undefined, true, 'completed', threshold);
    expect(f.run.status).toBe(status);
    expect(f.run.snapshot.mainJudgmentThreshold).toBe(threshold);
    expect(f.run.snapshot.mainJudgment?.threshold).toBe(threshold);
    expect(f.run.snapshot.mainJudgmentPending).toBeUndefined();
    expect(
      (await api(f.app, `/api/chats/${f.chat.id}/reader-runs`)).find(
        (run: { id: string }) => run.id === f.run.id
      ).canRejudge
    ).toBe(false);
    expect(modelWorkspace(f.app.store).translationPolicy.judgment.threshold).toBe(0.9);
    expect(() =>
      validateMainJudgmentWire(
        { ...f.run.snapshot.mainJudgment!, threshold: threshold === 0.7 ? 0.8 : 0.7 },
        observedAttempts(f.app.store, f.run.id).find(
          (item) => (item.request as WireRecord).judgment?.kind === 'main-refusal'
        )!.request as WireRecord
      )
    ).toThrow('MAIN_JUDGMENT_ATTEMPT_MISMATCH');
  }
);

test('preserves oversized main output when JEV preflight rejects it before an attempt', async () => {
  const candidate = '가😀 '.repeat(20000);
  const f = await fixture(candidate, 0.58);
  expect(f.run).toMatchObject({
    status: 'failed',
    error: 'JEV_INPUT_BUDGET',
    partialText: candidate,
    sourceRevision: null,
    usage: { modelCalls: 1 },
  });
  expect(f.app.store.chat(f.chat.id).headRevision).toBeNull();
  expect(f.calls).toHaveLength(1);
  expect(f.judged).toHaveLength(0);
  expect(f.run.snapshot.mainJudgment?.response).toBe(candidate);
  expect(f.app.store.product.attempts(f.chat.id)).toHaveLength(1);
});

test('disabled main judgment accepts refusal text without a JEV key, receipt, or reserved call', async () => {
  const candidate = 'I cannot fulfill this request.';
  const f = await fixture(candidate, 0.99, 1, false, undefined, false);
  expect(f.run).toMatchObject({ status: 'completed', error: null, usage: { modelCalls: 1 } });
  expect(f.run.snapshot.mainJudgmentEnabled).toBe(false);
  expect(f.run.snapshot.mainJudgment).toBeUndefined();
  expect(f.app.store.sourceOriginal(f.run.sourceRevision!).text).toBe(candidate);
  expect(f.calls).toHaveLength(1);
  expect(f.judged).toHaveLength(0);
  expect(f.app.store.product.attempts(f.chat.id)).toHaveLength(1);
  const workspace = modelWorkspace(f.app.store);
  updateModelWorkspace(f.app.store, {
    routes: workspace.routes,
    translationPolicy: workspace.translationPolicy,
    expectedRevision: workspace.revision,
    mainJudgmentEnabled: true,
  });
  f.output.text = 'A new copy uses the current judgment setting.';
  const candidateRun = await api(f.app, `/api/runs/${f.run.id}/candidate`, {
    idempotencyKey: randomUUID(),
    title: 'Current setting on independent copy',
  });
  await expect
    .poll(() => f.app.store.run(candidateRun.id).status)
    .not.toMatch(/^(queued|running)$/u);
  expect(f.app.store.run(candidateRun.id)).toMatchObject({
    status: 'failed',
    error: 'JEV_CREDENTIAL_REQUIRED',
    snapshot: { mainJudgmentEnabled: true },
  });
  expect(f.judged).toHaveLength(0);
});

test('disabled main judgment does not accept a partial generation', async () => {
  const f = await fixture('Incomplete output', 0.01, 1, false, undefined, false, 'partial');
  expect(f.run.status).not.toBe('completed');
  expect(f.run.sourceRevision).toBeNull();
  expect(f.judged).toHaveLength(0);
});

test('removes the writer workspace after a terminal refused result', async () => {
  const f = await fixture(
    'Temporary candidate',
    0.99,
    8,
    true,
    undefined,
    true,
    'completed',
    0.9,
    true
  );
  expect(f.run.status).toBe('refused');
  expect(f.shellWorkspace).toBeDefined();
  expect(existsSync(f.shellWorkspace!)).toBe(false);
});

test('records run phase spans and replaces them in the judgment-only recovery run', async () => {
  const f = await fixture('Measured candidate', 'failure');
  expect(f.run.status).toBe('failed');
  const original = f.app.store.run(f.run.id).snapshot.phaseSpans!;
  expect(Object.keys(original)).toEqual(expect.arrayContaining(['mainModel', 'refusalJudge']));
  expect(original).not.toHaveProperty('txCommit');
  vi.stubGlobal('fetch', async () =>
    Response.json({
      model: 'jev-latest',
      answers: { explicitRefusal: { type: 'noul', noul: 0.1 } },
    })
  );
  const next = await api(f.app, `/api/runs/${f.run.id}/rejudge`, { idempotencyKey: randomUUID() });
  await expect.poll(() => f.app.store.run(next.id).status, { timeout: 6000 }).toBe('completed');
  const recovered = f.app.store.run(next.id).snapshot.phaseSpans!;
  expect(Object.keys(recovered).sort()).toEqual(['refusalJudge', 'risuOutput', 'txCommit']);
  for (const elapsedMs of Object.values(recovered)) expect(elapsedMs).toBeGreaterThanOrEqual(0);
  expect(f.calls).toHaveLength(1);
});

test('rejudgment credential failure preserves its response and does not recharge the writer', async () => {
  const f = await fixture('Still available', 'failure');
  f.app.store.credentials.set('jev', null);
  const next = await api(f.app, `/api/runs/${f.run.id}/rejudge`, { idempotencyKey: randomUUID() });
  await expect.poll(() => f.app.store.run(next.id).status, { timeout: 6000 }).toBe('failed');
  expect(f.app.store.run(next.id)).toMatchObject({
    partialText: 'Still available',
    error: 'JEV_CREDENTIAL_REQUIRED',
    usage: { modelCalls: 0 },
  });
  expect(f.calls).toHaveLength(1);
});

test('cancelled rejudgment cannot adopt a late successful verdict', async () => {
  const f = await fixture('Preserve on cancellation', 'failure');
  let finish!: (response: Response) => void;
  let started = false;
  vi.stubGlobal('fetch', () => {
    started = true;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const next = await api(f.app, `/api/runs/${f.run.id}/rejudge`, { idempotencyKey: randomUUID() });
  await expect.poll(() => started, { timeout: 6000 }).toBe(true);
  await api(f.app, `/api/runs/${next.id}/cancel`, {});
  finish(
    new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: { explicitRefusal: { type: 'noul', noul: 0.1 } },
      })
    )
  );
  await f.app.close();
  owned.at(-1)!.app = undefined;
  const db = new Store(join(owned.at(-1)!.directory, 'test.sqlite'));
  try {
    expect(db.run(next.id)).toMatchObject({
      status: 'cancelled',
      sourceRevision: null,
      partialText: 'Preserve on cancellation',
    });
    expect(db.run(next.id).snapshot.nativeRisuExecution?.output).toBeUndefined();
  } finally {
    db.close();
  }
  expect(f.calls).toHaveLength(1);
});

test('interrupted judgment recovery preserves the candidate and explicitly resumes only judgment', async () => {
  const f = await fixture('Retained across server shutdown', 'failure', 8, true, 'recovery');
  let started = false;
  vi.stubGlobal('fetch', (_url: unknown, init?: RequestInit) => {
    started = true;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('Fixture aborted')), {
        once: true,
      });
    });
  });
  const next = await api(f.app, `/api/runs/${f.run.id}/rejudge`, { idempotencyKey: randomUUID() });
  await expect.poll(() => started, { timeout: 6000 }).toBe(true);
  await f.app.close();
  const item = owned.at(-1)!;
  item.app = undefined;
  let recoveryCalls = 0;
  vi.stubGlobal('fetch', (_url: unknown, init?: RequestInit) => {
    recoveryCalls++;
    expect(JSON.parse(String(init?.body)).state.response).toBe('Retained across server shutdown');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: { explicitRefusal: { type: 'noul', noul: 0.1 } },
        })
      )
    );
  });
  const reopened = await createApp({
    dbPath: join(item.directory, 'test.sqlite'),
    buildId: 'synthetic-main-judgment',
    testMode: true,
    codexRuntime: f.runtime,
  });
  item.app = reopened;
  expect(reopened.store.run(next.id)).toMatchObject({
    status: 'interrupted',
    sourceRevision: null,
    partialText: 'Retained across server shutdown',
  });
  expect(recoveryCalls).toBe(0);
  expect(
    (await api(reopened, `/api/chats/${f.chat.id}/reader-runs`)).find(
      (run: { id: string }) => run.id === next.id
    ).canRejudge
  ).toBe(true);
  const recovered = await api(reopened, `/api/runs/${next.id}/rejudge`, {
    idempotencyKey: randomUUID(),
  });
  await expect
    .poll(() => reopened.store.run(recovered.id).status, { timeout: 6000 })
    .toBe('completed');
  const completed = reopened.store.run(recovered.id);
  expect(
    (await api(reopened, `/api/chats/${f.chat.id}/reader-runs`)).find(
      (run: { id: string }) => run.id === recovered.id
    ).canRejudge
  ).toBe(false);
  expect(reopened.store.source(completed.sourceRevision!).text).toBe(
    'Retained across server shutdown'
  );
  expect(f.calls).toHaveLength(1);
  expect(recoveryCalls).toBe(1);
  const variables = reopened.store.db
    .prepare('SELECT values_json FROM chat_variable_states WHERE chat_id=?')
    .get(f.chat.id)!;
  expect(JSON.parse(String(variables.values_json))).toMatchObject({
    inputCount: '1',
    outputCount: '1',
  });
});
