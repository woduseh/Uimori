import { afterEach, expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createApp, type App } from '../server/app.js';
import {
  mainJudgmentInput,
  mainJudgmentRequest,
  mainJudgmentInputHash,
  validateMainJudgmentInput,
  validateMainJudgmentWire,
} from '../server/main-judgment.js';
import type { CodexRuntimeService } from '../server/codex-runtime.js';
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
  scriptStage?: 'input' | 'editRequest',
  judgmentEnabled = true,
  generationStatus: 'completed' | 'partial' = 'completed'
) {
  vi.stubEnv('TYPESAFE_API_KEY', key ? 'synthetic-jev-key' : '');
  const judged: Record<string, any>[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    expect(url).toBe(JEV_ENDPOINT);
    judged.push(JSON.parse(String(init?.body)));
    if (scores === 'failure') throw new Error('synthetic transport failed');
    if (scores === 'budget')
      return new Response(JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }), {
        status: 400,
      });
    return new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: {
          explicitRefusal: { type: 'noul', noul: scores === 'invalid' ? 2 : scores },
        },
        usage: { input_tokens: 7, output_tokens: 3 },
      })
    );
  });
  const calls: ProviderRequest[] = [];
  const output = { text: candidate };
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
  };
  const owner = {
    directory: await mkdtemp(join(tmpdir(), 'uimori-main-judgment-')),
  } as (typeof owned)[number];
  owned.push(owner);
  const app = await createApp({
    dbPath: join(owner.directory, 'test.sqlite'),
    buildId: 'synthetic-main-judgment',
    testMode: true,
    codexRuntime: runtime,
  });
  owner.app = app;
  if (!judgmentEnabled) {
    const workspace = modelWorkspace(app.store);
    updateModelWorkspace(app.store, {
      routes: workspace.routes,
      translationPolicy: workspace.translationPolicy,
      expectedRevision: workspace.revision,
      mainJudgmentEnabled: false,
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
  scriptStage === 'input'
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
      status: false,
      translation: false,
      maxCalls,
    },
    'PATCH'
  );
  const profile = await api(app, `/api/chats/${chat.id}/profile`);
  await api(
    app,
    `/api/chats/${chat.id}/profile`,
    {
      expectedRevision: profile.revision,
      image: false,
      imageTranslation: false,
      routes: { main: { id: model.id }, translation: null, status: null },
    },
    'PUT'
  );
  const run = await api(app, `/api/chats/${chat.id}/runs`, {
    request: 'Respond to the selected task.',
    expectedRevision: null,
    expectedSettingsRevision: app.store.chat(chat.id).settingsRevision,
    idempotencyKey: randomUUID(),
  });
  await expect.poll(() => app.store.run(run.id).status).not.toMatch(/^(queued|running)$/u);
  return { app, chat, run: app.store.run(run.id), calls, judged, output };
}

test.each([
  ['I cannot fulfill this request.', 0.99, 'refused', 'MAIN_RESPONSE_REFUSED'],
  ['I cannot provide this service.', 0.9, 'refused', 'MAIN_RESPONSE_REFUSED'],
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
  '“I refuse,” the captain said, opening the gate.',
  'Here is a plan: first review the evidence.',
  'Which of the two scenes should I analyze?',
])('accepts the selected task output without requiring fiction: %s', async (text) => {
  const f = await fixture(text, 0.58);
  expect(f.run).toMatchObject({
    status: 'completed',
    error: null,
    partialText: '',
    usage: { modelCalls: 2, inputTokens: 18, outputTokens: 8 },
  });
  expect(f.app.store.sourceOriginal(f.run.sourceRevision!).text).toBe(text);
  expect(f.judged[0].state).toEqual({ response: text });
  const attempt = f.app.store.product
    .attempts(f.chat.id)
    .find((item) => (item.request as WireRecord).judgment?.kind === 'main-refusal')!;
  expect(() =>
    validateMainJudgmentWire(f.run.snapshot.mainJudgment!, attempt.request as WireRecord)
  ).not.toThrow();
  expect(() =>
    validateMainJudgmentWire(
      mainJudgmentInput('different candidate'),
      attempt.request as WireRecord
    )
  ).toThrow('MAIN_JUDGMENT_ATTEMPT_MISMATCH');
  const archive = f.app.store.product.export();
  const restored = new Store(join(owned.at(-1)!.directory, 'restore.sqlite'));
  try {
    restored.product.import(archive);
    expect(restored.run(f.run.id).status).toBe('completed');
  } finally {
    restored.close();
  }
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
test('a candidate owns its response judgment while preserving the original frozen input', async () => {
  const f = await fixture('First response.', 0.58);
  f.output.text = 'Independent candidate response.';
  const candidate = await api(f.app, `/api/runs/${f.run.id}/candidate`, {
    idempotencyKey: randomUUID(),
    title: 'Candidate',
  });
  await expect.poll(() => f.app.store.run(candidate.id).status).not.toMatch(/^(queued|running)$/u);
  const run = f.app.store.run(candidate.id);
  expect(run).toMatchObject({ status: 'completed', error: null });
  expect(run.snapshot.mainJudgment).toEqual(mainJudgmentInput(f.output.text));
  expect(run.snapshot.mainJudgment).not.toEqual(f.run.snapshot.mainJudgment);
  const restored = new Store(join(owned.at(-1)!.directory, 'candidate-restore.sqlite'));
  try {
    restored.product.import(f.app.store.product.export());
    expect(restored.run(candidate.id).snapshot.mainJudgment).toEqual(run.snapshot.mainJudgment);
  } finally {
    restored.close();
  }
});
test.each(['input', 'editRequest'] as const)(
  'Lua %s preserves a writer call and its JEV judgment',
  async (stage) => {
    const f = await fixture('A completed response.', 0.58, 3, true, stage);
    expect(f.run).toMatchObject({ status: 'completed', error: null, usage: { modelCalls: 3 } });
    expect(f.calls.map((call) => call.role)).toEqual(['script', 'main']);
    expect(f.judged).toHaveLength(1);
    expect(f.run.snapshot.nativeRisuExecution?.variables.budgetBlocked).toBe('true');
  }
);
test('preserves the whole Unicode response and only asks about service refusal', () => {
  const candidate = '😀'.repeat(5000);
  const input = mainJudgmentInput(candidate);
  expect(input).toEqual({
    version: 'main-refusal-jev-v2',
    candidateHash: createHash('sha256').update(candidate).digest('hex'),
    response: candidate,
  });
  expect(mainJudgmentRequest(input).state).toEqual({ response: candidate });
  expect(Object.keys(mainJudgmentRequest(input).questions)).toEqual(['explicitRefusal']);
  expect(mainJudgmentRequest(input).questions.explicitRefusal.instructions).toContain(
    'Character dialogue, quoted refusals'
  );
  expect(mainJudgmentRequest(input).questions.explicitRefusal.instructions).toContain(
    'Planning, analysis, answers, useful clarification questions'
  );
});

test('sends and archives the entire long response, including its middle', async () => {
  const candidate =
    'Beginning 😀' + '가나다'.repeat(3000) + ' middle refusal quote ' + '漢字'.repeat(3000) + 'End';
  const f = await fixture(candidate, 0.58);
  expect(f.run.status).toBe('completed');
  expect(f.judged[0].state).toEqual({ response: candidate });
  expect(Object.keys(f.judged[0].questions)).toEqual(['explicitRefusal']);
  expect(f.run.snapshot.mainJudgment).toEqual(mainJudgmentInput(candidate));
  const restored = new Store(join(owned.at(-1)!.directory, 'long-restore.sqlite'));
  try {
    restored.product.import(f.app.store.product.export());
    expect(restored.run(f.run.id).snapshot.mainJudgment?.response).toBe(candidate);
  } finally {
    restored.close();
  }
});

test('rejects changed response contents, receipt hashes, and judgment wire questions', async () => {
  const f = await fixture('Original full response.', 0.58);
  const input = f.run.snapshot.mainJudgment!;
  const wire = f.app.store.product
    .attempts(f.chat.id)
    .find((item) => (item.request as WireRecord).judgment?.kind === 'main-refusal')!
    .request as WireRecord;
  expect(() => validateMainJudgmentInput({ ...input, response: 'Changed' })).toThrow(
    'MAIN_JUDGMENT_INPUT_INVALID'
  );
  expect(mainJudgmentInputHash(input)).not.toBe(
    mainJudgmentInputHash(mainJudgmentInput(input.response + 'tail'))
  );
  const changed = structuredClone(wire);
  const body = changed.body as { questions: Record<string, unknown> };
  body.questions.extra = { type: 'noul', instructions: 'Another question' };
  changed.bodySha256 = digest(changed.body);
  changed.stablePrefixSha256 = digest(body.questions);
  expect(() => validateMainJudgmentWire(input, changed)).toThrow('MAIN_JUDGMENT_ATTEMPT_MISMATCH');
  const archive = f.app.store.product.export();
  const serialized = JSON.stringify(archive).replaceAll(
    'Original full response.',
    'Tampered full response.'
  );
  const restored = new Store(join(owned.at(-1)!.directory, 'tampered-restore.sqlite'));
  try {
    expect(() => restored.product.import(JSON.parse(serialized))).toThrow();
  } finally {
    restored.close();
  }
});

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
  f.output.text = 'A candidate using the frozen disabled judgment setting.';
  const candidateRun = await api(f.app, `/api/runs/${f.run.id}/candidate`, {
    idempotencyKey: randomUUID(),
    title: 'Frozen disabled setting',
  });
  await expect
    .poll(() => f.app.store.run(candidateRun.id).status)
    .not.toMatch(/^(queued|running)$/u);
  expect(f.app.store.run(candidateRun.id)).toMatchObject({
    status: 'completed',
    snapshot: { mainJudgmentEnabled: false },
  });
  expect(f.judged).toHaveLength(0);
});

test('disabled main judgment does not accept a partial generation', async () => {
  const f = await fixture('Incomplete output', 0.01, 1, false, undefined, false, 'partial');
  expect(f.run.status).not.toBe('completed');
  expect(f.run.sourceRevision).toBeNull();
  expect(f.judged).toHaveLength(0);
});
