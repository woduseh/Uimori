import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { splitSource } from '../core/auxiliary.js';
import type { ProviderResult } from '../core/transport.js';
import { CodexRuntime } from '../server/codex-runtime.js';
import { runIllustrationJob, type IllustrationRunnerHooks } from '../server/illustration-runner.js';
import {
  claimIllustration,
  completeIllustrationStoryboard,
  illustrationJob,
  queuedIllustrations,
  reserveIllustration,
  reserveIllustrationPlan,
} from '../server/illustrations.js';
import type { Store } from '../server/store.js';
import { illustrationErrorMessage } from '../web/illustration-labels.js';
import { FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import {
  chatWithSource,
  fixtureIllustrationPreset,
  fixtureSettings,
  illustrationDatabases,
} from './fixtures/illustration.js';

const databases = illustrationDatabases('uimori-illustration-retry-');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  databases.cleanup();
  vi.restoreAllMocks();
});
const usage = {
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  raw: null,
  priceRevision: null,
};
function setup(stage: 'plan' | 'placement' | 'prompt' | 'image') {
  const store = databases.create();
  const { source } = chatWithSource(store);
  const connection = store.product.connection({
    title: 'Synthetic Codex',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic illustration',
    connectionId: connection.id,
    modelId: 'gpt-5.4',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const settings = fixtureSettings({
    generator: stage === 'prompt' ? 'comfyui' : 'codex',
    maxAutoRetries: 5,
    codex: { model: { id: model.id } },
    comfyui: { baseUrl: 'http://127.0.0.1:1', promptModel: { id: model.id } },
  });
  if (stage === 'prompt')
    fixtureIllustrationPreset(store, { comfyui: { workflow: FIXTURE_WORKFLOW } });
  if (stage === 'prompt' || stage === 'image')
    return { store, source, job: reserveIllustration(store, source, 'manual', { settings }) };
  const plan = reserveIllustrationPlan(store, source, 'manual', { settings, maxTargets: 1 });
  if (stage === 'plan') return { store, source, job: plan };
  const claimed = claimIllustration(store, plan.id, 'prepare-placement')!;
  const block = splitSource(source)[0];
  completeIllustrationStoryboard(
    store,
    claimed.job,
    'prepare-placement',
    {
      heroIndex: 0,
      targets: [
        {
          startAnchor: block.anchor,
          endAnchor: block.anchor,
          focus: 'The lantern',
          visualBrief: block.text,
        },
      ],
    },
    { stage: 'planning', attempts: [], retries: [] }
  );
  store.editTranslation(source.id, {
    expectedRevision: 0,
    expectedSourceHash: source.hash,
    text: '강 위의 등불.\n\n부두에 미라.',
  });
  const job = queuedIllustrations(store)
    .map((id) => illustrationJob(store, id))
    .find((candidate) => candidate.input.task === 'placement')!;
  expect(job).toBeDefined();
  return { store, source, job };
}
function hooks(
  store: Store,
  extra: Partial<IllustrationRunnerHooks> = {}
): IllustrationRunnerHooks {
  return {
    signal: new AbortController().signal,
    authorize: (connection) => store.product.authorize(connection),
    onAttemptStart: () => 'synthetic-attempt',
    onAttemptFinish: () => {},
    ...extra,
  };
}
function result(code: string): ProviderResult {
  return {
    status: code === 'invalid' ? 'completed' : code === 'refused' ? 'refused' : 'error',
    text: code === 'invalid' ? 'not JSON' : '',
    toolCalls: [],
    refusal: code === 'refused' ? 'Declined' : null,
    error: code === 'invalid' || code === 'refused' ? null : { code },
    usage,
    opaqueState: null,
  };
}
for (const stage of ['plan', 'placement', 'prompt'] as const) {
  test.each([
    'TIMEOUT',
    'CODEX_CLOSED',
    'TRANSPORT_ERROR',
    'HTTP_503',
    'refused',
    'CODEX_BUSY',
    'invalid',
  ])(`${stage} uses conservative automatic retry classification for %s`, async (code) => {
    const { store, source, job } = setup(stage);
    const executeCodex = vi.fn<NonNullable<IllustrationRunnerHooks['executeCodex']>>(
      async (connection, request, options) => {
        if (code !== 'CODEX_BUSY')
          await options.onWire?.({
            connectionId: connection.id,
            protocol: connection.protocol,
            role: request.role,
            modelId: request.modelId,
            method: 'RPC',
            url: 'codex://local',
            headers: {},
            body: {},
            bodySha256: 'synthetic',
            stablePrefixSha256: 'synthetic',
          });
        return result(code);
      }
    );
    const options = hooks(store, { executeCodex });
    const retryable = code === 'CODEX_BUSY' || code === 'invalid';
    const outcome = await runIllustrationJob(store, job.id, 'worker', options);
    expect(outcome?.status).toBe(retryable ? 'requeued' : 'failed');
    expect(illustrationJob(store, job.id).attempt).toBe(retryable ? 2 : 1);
    if (!retryable) {
      expect(await runIllustrationJob(store, job.id, 'worker', options)).toBeNull();
      expect(illustrationJob(store, job.id).diagnostic?.code).toBe(
        code === 'refused' ? 'ILLUSTRATION_PROMPT_REFUSED' : `ILLUSTRATION_PROMPT_${code}`
      );
    }
    expect(executeCodex).toHaveBeenCalledTimes(1);
    expect(store.source(source.id).text).toBe(source.text);
  });
}
function runtime(mode: string, output?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-illustration-stdio-'));
  const log = join(directory, 'requests.jsonl');
  const instance = new CodexRuntime(join(directory, 'synthetic.sqlite'), {
    enabled: true,
    launch: {
      command: process.execPath,
      args: [resolve('tests/fixtures/codex-app-server.mjs')],
      env: {
        UIMORI_CODEX_FIXTURE_MODE: mode,
        UIMORI_CODEX_FIXTURE_LOG: log,
        ...(output ? { UIMORI_CODEX_FIXTURE_OUTPUT: output } : {}),
      },
    },
  });
  cleanups.push(async () => {
    await instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    instance,
    starts: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((record) => record.method === 'turn/start'),
  };
}
test('an acknowledged synthetic Codex text turn that times out is started exactly once', async () => {
  const { store, job } = setup('plan');
  const { instance, starts } = runtime('turn-hang');
  const options = hooks(store, {
    executeCodex: (connection, request, execution) =>
      instance.execute(connection, request, { ...execution, timeoutMs: 2000 }),
  });
  expect(await runIllustrationJob(store, job.id, 'worker', options)).toMatchObject({
    status: 'failed',
    code: 'ILLUSTRATION_PROMPT_TIMEOUT',
  });
  expect(await runIllustrationJob(store, job.id, 'worker', options)).toBeNull();
  expect(starts()).toHaveLength(1);
  expect(illustrationErrorMessage('ILLUSTRATION_PROMPT_TIMEOUT')).toContain('사용량이 추가');
});
test('an explicit UNAVAILABLE refusal from synthetic Codex is terminal and keeps its bounded reason', async () => {
  const { store, job } = setup('image');
  const reason = 'The image tool refused this request.';
  const { instance, starts } = runtime(
    'image-none',
    JSON.stringify({ caption: 'UNAVAILABLE: ' + reason })
  );
  const options = hooks(store, {
    generateCodexImage: (connection, request, execution) =>
      instance.generateImage(connection, request, execution),
  });
  expect(await runIllustrationJob(store, job.id, 'worker', options)).toMatchObject({
    status: 'failed',
    code: 'CODEX_IMAGE_UNAVAILABLE',
  });
  expect(await runIllustrationJob(store, job.id, 'worker', options)).toBeNull();
  expect(starts()).toHaveLength(1);
  expect(illustrationJob(store, job.id)).toMatchObject({
    attempt: 1,
    diagnostic: { codex: { unavailableReason: reason } },
  });
  expect(illustrationErrorMessage('CODEX_IMAGE_UNAVAILABLE')).toContain('거절');
});
test('a plain missing image without the exact unavailable marker remains a bounded retry', async () => {
  const { store, job } = setup('image');
  const generateCodexImage = vi.fn<NonNullable<IllustrationRunnerHooks['generateCodexImage']>>(
    async () => ({
      status: 'error',
      images: [],
      revisedPrompt: null,
      text: JSON.stringify({ caption: 'An ordinary caption mentioning unavailable tools.' }),
      error: { code: 'CODEX_IMAGE_NOT_GENERATED' },
      usage,
    })
  );
  expect(
    await runIllustrationJob(store, job.id, 'worker', hooks(store, { generateCodexImage }))
  ).toMatchObject({ status: 'requeued', code: 'CODEX_IMAGE_NOT_GENERATED' });
  expect(illustrationJob(store, job.id).diagnostic?.codex).toBeUndefined();
});
test('metadata-only workflows fail before either a prompt call or a Comfy submission', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { store, job } = setup('prompt');
  const input = structuredClone(job.input);
  const workflow = JSON.parse(FIXTURE_WORKFLOW);
  workflow['6'].inputs.text = 'old fixed prompt';
  workflow['6']._meta = { title: '{{prompt}}' };
  // A frozen legacy recipe can predate the stricter preset validation.
  input.comfyui!.workflow = JSON.stringify(workflow);
  store.db
    .prepare('UPDATE illustration_jobs SET input=? WHERE id=?')
    .run(JSON.stringify(input), job.id);
  const executeCodex = vi.fn<NonNullable<IllustrationRunnerHooks['executeCodex']>>();
  expect(
    await runIllustrationJob(store, job.id, 'worker', hooks(store, { executeCodex }))
  ).toMatchObject({ status: 'failed', code: 'COMFYUI_WORKFLOW_PROMPT_PLACEHOLDER_MISSING' });
  expect(executeCodex).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(illustrationJob(store, job.id).diagnostic?.comfyui).toBeUndefined();
});
