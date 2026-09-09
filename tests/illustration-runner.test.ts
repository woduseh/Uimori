import { afterEach, describe, expect, test } from 'vitest';
import type { Connection, ModelPreset } from '../core/product.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import type { CodexImageRequest, CodexImageResult } from '../server/codex-runtime.js';
import {
  reconcileIllustrationJob,
  runIllustrationJob,
  type IllustrationRunnerHooks,
} from '../server/illustration-runner.js';
import {
  illustrationJob,
  illustrationsForSources,
  reserveIllustration,
  updateIllustrationReferences,
} from '../server/illustrations.js';
import type { Store } from '../server/store.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { comfyUIFixture, FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import {
  chatWithSource,
  completedSource,
  fixtureSettings,
  illustrationDatabases,
  PNG_BASE64,
} from './fixtures/illustration.js';

const databases = illustrationDatabases('uimori-illustration-runner-');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  databases.cleanup();
});
const PNG = Buffer.from(PNG_BASE64, 'base64');
test.each(['TIMEOUT', 'throw'] as const)(
  'Codex %s after dispatch finishes its attempt without automatic replay',
  async (fault) => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const model = codexModel(store);
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: 'codex',
        maxAutoRetries: 5,
        codex: { model: { id: model.id } },
      }),
    });
    const observed = hooks(store, {
      generateCodexImage: async (connection, request, options) => {
        await options.onWire({
          connectionId: connection.id,
          protocol: connection.protocol,
          role: 'illustration',
          modelId: request.modelId,
          method: 'RPC',
          url: 'codex://local',
          headers: {},
          body: { method: 'turn/start' },
          bodySha256: 'a'.repeat(64),
          stablePrefixSha256: 'b'.repeat(64),
        });
        if (fault === 'throw') throw new Error('synthetic connection lost');
        return {
          status: 'error',
          images: [],
          revisedPrompt: null,
          text: '',
          error: { code: fault },
          usage: {
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            raw: null,
            priceRevision: null,
          },
        };
      },
    });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toMatchObject({
      status: 'failed',
    });
    expect(illustrationJob(store, job.id)).toMatchObject({ status: 'failed', attempt: 1 });
    expect(observed.wires).toHaveLength(1);
    expect(observed.finishes).toHaveLength(1);
    expect(observed.finishes[0].result).toMatchObject({
      status: 'error',
      usage: { costUsd: null },
    });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toBeNull();
  }
);
function hooks(store: Store, extra: Partial<IllustrationRunnerHooks> = {}) {
  const wires: WireRecord[] = [];
  const finishes: { id: string; result: ProviderResult }[] = [];
  let progress = 0;
  const options: IllustrationRunnerHooks = {
    signal: new AbortController().signal,
    approvedOrigins: [],
    authorize: (connection) => store.product.authorize(connection),
    onAttemptStart: (wire) => {
      wires.push(structuredClone(wire));
      return `attempt-${wires.length}`;
    },
    onAttemptFinish: (id, result) => {
      finishes.push({ id, result: structuredClone(result) });
    },
    onProgress: () => {
      progress++;
    },
    allowFixture: true,
    ...extra,
  };
  return { options, wires, finishes, progress: () => progress };
}
function codexModel(store: Store) {
  const connection = store.product.connection({
    title: 'Codex',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  }) as Connection;
  return store.product.model({
    title: 'Codex image model',
    connectionId: connection.id,
    modelId: 'gpt-5.4',
    maxOutputTokens: 1024,
    temperature: null,
    reasoningEffort: 'low',
  }) as ModelPreset;
}
async function promptModel(store: Store, reply: (body: any) => string) {
  const provider = await loopbackProvider(async (request, response) => {
    const body = JSON.parse(request.body);
    await writeSse(response, [
      { type: 'text_delta', delta: reply(body) },
      { type: 'done', reason: 'stop' },
    ]);
  });
  cleanups.push(provider.close);
  const connection = store.product.connection({
    title: 'Loopback prompt model',
    protocol: 'fixture-sse-v1',
    endpoint: provider.endpoint,
    enabled: true,
  }) as Connection;
  const model = store.product.model({
    title: 'Prompt writer',
    connectionId: connection.id,
    modelId: 'fixture-prompt-writer',
    maxOutputTokens: 512,
    temperature: null,
  }) as ModelPreset;
  return { provider, model };
}

describe('illustration runner with the synthetic generator', () => {
  test('re-queues retryable failures up to the frozen limit, then completes and stores the image', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({ maxAutoRetries: 1 }),
      testMode: true,
      fixture: { failures: 1 },
    });
    const observed = hooks(store);
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'requeued',
      code: 'FIXTURE_FAILURE',
      images: 0,
    });
    expect(illustrationJob(store, job.id)).toMatchObject({
      status: 'queued',
      attempt: 2,
      error: null,
    });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'completed',
      code: null,
      images: 1,
    });
    const [item] = illustrationsForSources(store, [source.id]);
    expect(item).toMatchObject({ status: 'completed', attempt: 2, maxAutoRetries: 1 });
    expect(item.diagnostic?.retries).toEqual([
      { attempt: 1, code: 'FIXTURE_FAILURE', at: expect.any(String) },
    ]);
    expect(item.images[0]).toMatchObject({ mime: 'image/png', caption: '모의 삽화 · 시도 2' });
    expect(observed.wires).toEqual([]);
    expect(observed.progress()).toBeGreaterThan(0);
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toBeNull();
  });
  test('fails after the automatic retry budget, refuses the synthetic generator outside test mode and honors cancellation', async () => {
    const store = databases.create();
    const { chat, source } = chatWithSource(store);
    const exhausted = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({ maxAutoRetries: 1, maxPerSource: 4 }),
      testMode: true,
      fixture: { failures: 5 },
    });
    const observed = hooks(store);
    expect(
      (await runIllustrationJob(store, exhausted.id, 'worker', observed.options))?.status
    ).toBe('requeued');
    expect(await runIllustrationJob(store, exhausted.id, 'worker', observed.options)).toEqual({
      status: 'failed',
      code: 'FIXTURE_FAILURE',
      images: 0,
    });
    expect(illustrationJob(store, exhausted.id)).toMatchObject({
      status: 'failed',
      attempt: 2,
      error: 'FIXTURE_FAILURE',
    });
    const { source: other } = { source: store.source(source.id) };
    const denied = reserveIllustration(store, other, 'manual', {
      settings: fixtureSettings({ maxPerSource: 4 }),
      testMode: true,
    });
    expect(
      await runIllustrationJob(
        store,
        denied.id,
        'worker',
        hooks(store, { allowFixture: false }).options
      )
    ).toEqual({
      status: 'failed',
      code: 'ILLUSTRATION_GENERATOR_UNCONFIGURED',
      images: 0,
    });
    const slow = reserveIllustration(store, store.source(source.id), 'manual', {
      settings: fixtureSettings({ maxPerSource: 4 }),
      testMode: true,
      fixture: { delayMs: 2000 },
    });
    const controller = new AbortController();
    const pending = runIllustrationJob(
      store,
      slow.id,
      'worker',
      hooks(store, { signal: controller.signal, cancellationStatus: 'interrupted' }).options
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    expect(await pending).toEqual({
      status: 'interrupted',
      code: 'ILLUSTRATION_CANCELLED',
      images: 0,
    });
    expect(illustrationJob(store, slow.id)).toMatchObject({
      status: 'interrupted',
      error: 'ILLUSTRATION_CANCELLED',
    });
    expect(store.chat(chat.id)).toBeTruthy();
  });
});

describe('illustration runner through the Codex image turn', () => {
  test('sends the scene, guidance and role-labeled references, records the attempt and stores the caption', async () => {
    const store = databases.create();
    const { chat, source } = chatWithSource(store);
    const asset = store.product.createAsset(chat.id, {
      title: 'Mira design',
      mime: 'image/png',
      base64: PNG_BASE64,
      description: '',
      actor: 'Mira',
      outfit: '',
      location: '',
      allowedUse: 'both',
    }) as { id: string };
    updateIllustrationReferences(store, chat.id, {
      expectedRevision: 0,
      references: [{ ref: asset.id, role: 'character' }],
    });
    const model = codexModel(store);
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: 'codex',
        styleGuidance: 'watercolor',
        codex: { model: { id: model.id }, useReferences: true },
      }),
    });
    const captured: { connection: Connection; request: CodexImageRequest }[] = [];
    const observed = hooks(store, {
      generateCodexImage: async (connection, request, options) => {
        captured.push({ connection, request });
        await options.onWire({
          connectionId: connection.id,
          protocol: connection.protocol,
          role: 'illustration',
          modelId: request.modelId,
          method: 'RPC',
          url: 'codex://local',
          headers: {},
          body: { method: 'turn/start' },
          bodySha256: 'a'.repeat(64),
          stablePrefixSha256: 'b'.repeat(64),
        });
        const result: CodexImageResult = {
          status: 'completed',
          images: [{ mime: 'image/png', bytes: PNG }],
          revisedPrompt: 'A watercolor lantern above the river.',
          text: '{"caption":"강 위의 등불"}',
          usage: {
            inputTokens: 12,
            outputTokens: 3,
            costUsd: null,
            raw: null,
            priceRevision: null,
          },
          error: null,
        };
        return result;
      },
    });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'completed',
      code: null,
      images: 1,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].connection.protocol).toBe('codex-app-server-v1');
    expect(captured[0].request.modelId).toBe('gpt-5.4');
    expect(captured[0].request.reasoningEffort).toBe('low');
    expect(captured[0].request.references).toEqual([{ mime: 'image/png', base64: PNG_BASE64 }]);
    const text = JSON.parse(captured[0].request.text) as {
      scene: string;
      styleGuidance: string;
      attachedReferences: unknown[];
    };
    expect(text.scene).toBe(source.text);
    expect(text.styleGuidance).toBe('watercolor');
    expect(text.attachedReferences).toEqual([
      { attachment: 1, role: 'character design reference', label: 'Mira design' },
    ]);
    expect(observed.wires).toHaveLength(1);
    expect(observed.finishes).toEqual([
      {
        id: 'attempt-1',
        result: expect.objectContaining({
          status: 'completed',
          usage: expect.objectContaining({ inputTokens: 12 }),
        }),
      },
    ]);
    const [item] = illustrationsForSources(store, [source.id]);
    expect(item.images[0]).toMatchObject({
      caption: '강 위의 등불',
      revisedPrompt: 'A watercolor lantern above the river.',
    });
    expect(item.diagnostic).toMatchObject({
      stage: 'store',
      attempts: ['attempt-1'],
      revisedPrompt: 'A watercolor lantern above the river.',
    });
  });
  test('usage limits fail immediately while a missing image is re-queued once', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const model = codexModel(store);
    const settings = fixtureSettings({
      generator: 'codex',
      maxAutoRetries: 1,
      maxPerSource: 4,
      codex: { model: { id: model.id }, useReferences: false },
    });
    const limited = reserveIllustration(store, source, 'manual', { settings });
    const failure = (
      code: string,
      usageLimit?: { limitId: string; resetsAt: number | null }
    ): CodexImageResult => ({
      status: 'error',
      images: [],
      revisedPrompt: null,
      text: '',
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        raw: null,
        priceRevision: null,
      },
      error: { code, ...(usageLimit ? { usageLimit } : {}) },
    });
    expect(
      await runIllustrationJob(
        store,
        limited.id,
        'worker',
        hooks(store, {
          generateCodexImage: async () =>
            failure('CODEX_IMAGE_USAGE_LIMIT', { limitId: 'image_gen', resetsAt: 99 }),
        }).options
      )
    ).toEqual({ status: 'failed', code: 'CODEX_IMAGE_USAGE_LIMIT', images: 0 });
    expect(illustrationJob(store, limited.id).diagnostic?.codex).toEqual({
      usageLimit: { limitId: 'image_gen', resetsAt: 99 },
    });
    const missing = reserveIllustration(store, store.source(source.id), 'manual', { settings });
    expect(
      await runIllustrationJob(
        store,
        missing.id,
        'worker',
        hooks(store, {
          generateCodexImage: async () => failure('CODEX_IMAGE_NOT_GENERATED'),
        }).options
      )
    ).toEqual({ status: 'requeued', code: 'CODEX_IMAGE_NOT_GENERATED', images: 0 });
    expect(illustrationJob(store, missing.id)).toMatchObject({ status: 'queued', attempt: 2 });
  });
});

describe('illustration runner through a prompt model and remote ComfyUI', () => {
  test('asks the prompt model for JSON, fills the workflow and stores the rendered image with the caption', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const { provider, model } = await promptModel(store, () =>
      JSON.stringify({
        prompt: 'lantern above a river, night, watercolor',
        negativePrompt: 'lowres',
        caption: '강 위의 등불',
      })
    );
    const comfy = await comfyUIFixture();
    cleanups.push(comfy.close);
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: 'comfyui',
        styleGuidance: 'watercolor',
        comfyui: {
          baseUrl: comfy.origin,
          workflow: FIXTURE_WORKFLOW,
          promptModel: { id: model.id },
          timeoutMs: 5000,
          pollIntervalMs: 20,
          negativeGuidance: 'text',
        },
      }),
    });
    expect(job.input.comfyui?.promptModel.modelId).toBe('fixture-prompt-writer');
    const observed = hooks(store, { approvedOrigins: [provider.origin] });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'completed',
      code: null,
      images: 1,
    });
    expect(provider.requests).toHaveLength(1);
    const sent = JSON.parse(provider.requests[0].body);
    expect(sent.role).toBe('illustration');
    expect(sent.input.source).toMatchObject({
      scene: source.text,
      styleGuidance: 'watercolor',
      negativeGuidance: 'text',
    });
    expect(observed.wires.map((wire) => wire.role)).toEqual(['illustration']);
    expect(comfy.prompts).toHaveLength(1);
    expect(comfy.prompts[0].workflow['6']).toMatchObject({
      inputs: { text: 'lantern above a river, night, watercolor' },
    });
    expect(comfy.prompts[0].workflow['7']).toMatchObject({ inputs: { text: 'blurry, lowres' } });
    expect(
      typeof (comfy.prompts[0].workflow['3'] as { inputs: { seed: unknown } }).inputs.seed
    ).toBe('number');
    const [item] = illustrationsForSources(store, [source.id]);
    expect(item.images[0]).toMatchObject({
      mime: 'image/png',
      caption: '강 위의 등불',
      prompt: 'lantern above a river, night, watercolor',
    });
    expect(item.diagnostic).toMatchObject({
      stage: 'store',
      attempts: ['attempt-1'],
      prompt: { caption: '강 위의 등불' },
    });
    expect(item.diagnostic?.comfyui?.promptId).toBe(comfy.prompts[0].id);
  });
  test('rejected workflows fail with node errors, unreadable prompts re-queue, and unreachable hosts stay retryable', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    let reply = JSON.stringify({ prompt: 'a lantern' });
    const { provider, model } = await promptModel(store, () => reply);
    const rejecting = await comfyUIFixture({ behavior: 'reject' });
    cleanups.push(rejecting.close);
    const base = (baseUrl: string) =>
      fixtureSettings({
        generator: 'comfyui',
        maxAutoRetries: 1,
        maxPerSource: 6,
        comfyui: {
          baseUrl,
          workflow: FIXTURE_WORKFLOW,
          promptModel: { id: model.id },
          timeoutMs: 5000,
          pollIntervalMs: 20,
        },
      });
    const observed = hooks(store, { approvedOrigins: [provider.origin] });
    const rejected = reserveIllustration(store, source, 'manual', {
      settings: base(rejecting.origin),
    });
    expect(await runIllustrationJob(store, rejected.id, 'worker', observed.options)).toEqual({
      status: 'failed',
      code: 'COMFYUI_PROMPT_REJECTED',
      images: 0,
    });
    const rejectedJob = illustrationJob(store, rejected.id);
    expect(rejectedJob.attempt).toBe(1);
    expect(rejectedJob.diagnostic?.comfyui?.nodeErrors?.[0]).toMatchObject({
      nodeId: '4',
      classType: 'CheckpointLoaderSimple',
    });
    reply = 'I cannot help with that.';
    const unreadable = reserveIllustration(store, store.source(source.id), 'manual', {
      settings: base(rejecting.origin),
    });
    expect(await runIllustrationJob(store, unreadable.id, 'worker', observed.options)).toEqual({
      status: 'requeued',
      code: 'ILLUSTRATION_PROMPT_INVALID',
      images: 0,
    });
    expect(rejecting.prompts).toHaveLength(0);
    cancel(store, unreadable.id);
    reply = JSON.stringify({ prompt: 'a lantern' });
    const closed = await comfyUIFixture();
    await closed.close();
    const unreachable = reserveIllustration(store, store.source(source.id), 'manual', {
      settings: base(closed.origin),
    });
    expect(await runIllustrationJob(store, unreachable.id, 'worker', observed.options)).toEqual({
      status: 'requeued',
      code: 'COMFYUI_UNREACHABLE',
      images: 0,
    });
    expect(await runIllustrationJob(store, unreachable.id, 'worker', observed.options)).toEqual({
      status: 'failed',
      code: 'COMFYUI_UNREACHABLE',
      images: 0,
    });
    expect(illustrationJob(store, unreachable.id).diagnostic?.retries).toHaveLength(1);
  });
});
function cancel(store: Store, id: string) {
  store.db
    .prepare("UPDATE illustration_jobs SET status='cancelled',generation=generation+1 WHERE id=?")
    .run(id);
}

describe('skip decisions and reconcile of accepted remote prompts', () => {
  test('accepted history failures never requeue and reconcile uses the same authenticated remote job', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const { provider, model } = await promptModel(store, () =>
      JSON.stringify({ prompt: 'one render', caption: '한 번' })
    );
    const comfy = await comfyUIFixture({
      fault: { path: 'history', kind: 'http-5xx' },
      authorization: 'Bearer callback-only',
    });
    cleanups.push(comfy.close);
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: 'comfyui',
        maxAutoRetries: 3,
        comfyui: {
          baseUrl: comfy.origin,
          authorizationEnv: 'CALLBACK_ONLY',
          workflow: FIXTURE_WORKFLOW,
          promptModel: { id: model.id },
          timeoutMs: 1000,
          pollIntervalMs: 10,
        },
      }),
    });
    const observed = hooks(store, {
      approvedOrigins: [provider.origin],
      resolveCredential: () => 'Bearer callback-only',
      resolveComfyCredential: () => 'Bearer callback-only',
    });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'failed',
      code: 'COMFYUI_RESULT_UNAVAILABLE',
      images: 0,
    });
    expect(illustrationJob(store, job.id).diagnostic?.comfyui?.promptId).toBe(comfy.prompts[0].id);
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toBeNull();
    comfy.clearFault();
    const recovered = await reconcileIllustrationJob(store, job.id, 'worker', {
      signal: new AbortController().signal,
      resolveCredential: () => 'Bearer callback-only',
    });
    expect(recovered.status).toBe('completed');
    expect(provider.requests).toHaveLength(1);
    expect(comfy.prompts).toHaveLength(1);
  });

  test.each([
    ['<private>excluded only</private>', 'ILLUSTRATION_SOURCE_EMPTY'],
    ['public\n<private>unclosed hidden detail', 'ILLUSTRATION_SOURCE_SEGMENTS_INVALID'],
    ['<private>'.repeat(2001), 'ILLUSTRATION_SOURCE_SEGMENTS_INVALID'],
  ])('excluded or malformed scene %s fails before any provider receives it', async (text, code) => {
    const store = databases.create();
    const { chat } = chatWithSource(store);
    const source = completedSource(store, chat.id, text);
    const snapshot = store.run(source.runId).snapshot;
    snapshot.sourceSegments = {
      version: 1,
      rules: [
        {
          id: 'private',
          kind: 'aside',
          open: '<private>',
          close: '</private>',
          match: 'inline',
          label: 'Private',
          exclude: true,
        },
      ],
    };
    store.db
      .prepare('UPDATE runs SET snapshot=? WHERE id=?')
      .run(JSON.stringify(snapshot), source.runId);
    const model = codexModel(store);
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({ generator: 'codex', codex: { model: { id: model.id } } }),
    });
    let calls = 0;
    const observed = hooks(store, {
      generateCodexImage: async () => {
        calls++;
        return {
          status: 'completed',
          images: [{ mime: 'image/png', bytes: PNG }],
          text: '{"caption":"image"}',
          revisedPrompt: null,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: null, raw: null, priceRevision: null },
          error: null,
        };
      },
    });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toMatchObject({
      status: 'failed',
      code,
    });
    expect(calls).toBe(0);
    expect(illustrationJob(store, job.id).diagnostic?.attempts).toEqual([]);
  });

  test('a valid segmented scene sends only public main text to the generator', async () => {
    const store = databases.create();
    const { chat } = chatWithSource(store);
    const source = completedSource(
      store,
      chat.id,
      'public lantern\n<private>never send this</private>\npublic river'
    );
    const snapshot = store.run(source.runId).snapshot;
    snapshot.sourceSegments = {
      version: 1,
      rules: [
        {
          id: 'private',
          kind: 'aside',
          open: '<private>',
          close: '</private>',
          match: 'inline',
          label: 'Private',
          exclude: true,
        },
      ],
    };
    store.db
      .prepare('UPDATE runs SET snapshot=? WHERE id=?')
      .run(JSON.stringify(snapshot), source.runId);
    const model = codexModel(store);
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({ generator: 'codex', codex: { model: { id: model.id } } }),
    });
    let sent = '';
    const observed = hooks(store, {
      generateCodexImage: async (_connection, request) => {
        sent = request.text;
        return {
          status: 'completed',
          images: [{ mime: 'image/png', bytes: PNG }],
          text: '{"caption":"image"}',
          revisedPrompt: null,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: null, raw: null, priceRevision: null },
          error: null,
        };
      },
    });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toMatchObject({
      status: 'completed',
    });
    expect(sent).toContain('public lantern');
    expect(sent).toContain('public river');
    expect(sent).not.toContain('never send this');
  });
  test('automatic runs may skip through the prompt model without touching ComfyUI; manual runs must draw', async () => {
    const store = databases.create();
    const { chat, source } = chatWithSource(store);
    let reply = JSON.stringify({ decision: 'skip', reason: '대화만 이어지는 장면' });
    const { provider, model } = await promptModel(store, () => reply);
    const comfy = await comfyUIFixture();
    cleanups.push(comfy.close);
    const settings = fixtureSettings({
      generator: 'comfyui',
      automatic: true,
      maxPerSource: 2,
      comfyui: {
        baseUrl: comfy.origin,
        workflow: FIXTURE_WORKFLOW,
        promptModel: { id: model.id },
        timeoutMs: 5000,
        pollIntervalMs: 20,
      },
    });
    const automatic = reserveIllustration(store, source, 'automatic', { settings });
    const observed = hooks(store, { approvedOrigins: [provider.origin] });
    expect(await runIllustrationJob(store, automatic.id, 'worker', observed.options)).toEqual({
      status: 'skipped',
      code: null,
      images: 0,
    });
    const skipped = illustrationJob(store, automatic.id);
    expect(skipped).toMatchObject({ status: 'completed', error: null });
    expect(skipped.diagnostic?.skipped).toBe('대화만 이어지는 장면');
    expect(comfy.prompts).toHaveLength(0);
    expect(JSON.parse(provider.requests[0].body).input.source.allowSkip).toBe(true);
    // A skipped run keeps the slot free and a manual request still has to produce a prompt.
    const manual = reserveIllustration(store, store.source(source.id), 'manual', { settings });
    expect(await runIllustrationJob(store, manual.id, 'worker', observed.options)).toEqual({
      status: 'requeued',
      code: 'ILLUSTRATION_PROMPT_INVALID',
      images: 0,
    });
    expect(JSON.parse(provider.requests[1].body).input.source.allowSkip).toBe(false);
    reply = JSON.stringify({ prompt: 'a lantern', caption: '등불' });
    expect(await runIllustrationJob(store, manual.id, 'worker', observed.options)).toEqual({
      status: 'completed',
      code: null,
      images: 1,
    });
    expect(illustrationsForSources(store, [source.id]).map((item) => item.images.length)).toEqual([
      0, 1,
    ]);
    expect(store.chat(chat.id)).toBeTruthy();
  });
  test('an automatic Codex run may answer SKIP instead of drawing', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const model = codexModel(store);
    const job = reserveIllustration(store, source, 'automatic', {
      settings: fixtureSettings({
        generator: 'codex',
        codex: { model: { id: model.id }, useReferences: false },
      }),
    });
    const observed = hooks(store, {
      generateCodexImage: async () => ({
        status: 'error',
        images: [],
        revisedPrompt: null,
        text: '{"caption":"SKIP: 시각적 변화가 없는 장면"}',
        usage: { inputTokens: 5, outputTokens: 2, costUsd: null, raw: null, priceRevision: null },
        error: { code: 'CODEX_IMAGE_NOT_GENERATED' },
      }),
    });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'skipped',
      code: null,
      images: 0,
    });
    expect(illustrationJob(store, job.id).diagnostic?.skipped).toBe('시각적 변화가 없는 장면');
  });
  test('a ComfyUI timeout keeps the prompt_id, never re-renders, and reconcile stores the late result', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const { provider, model } = await promptModel(store, () =>
      JSON.stringify({ prompt: 'slow lantern', caption: '늦게 도착한 등불' })
    );
    const comfy = await comfyUIFixture({ delayPolls: 3 });
    cleanups.push(comfy.close);
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: 'comfyui',
        maxAutoRetries: 2,
        comfyui: {
          baseUrl: comfy.origin,
          workflow: FIXTURE_WORKFLOW,
          promptModel: { id: model.id },
          timeoutMs: 40,
          pollIntervalMs: 20,
        },
      }),
    });
    const observed = hooks(store, { approvedOrigins: [provider.origin] });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'failed',
      code: 'COMFYUI_TIMEOUT',
      images: 0,
    });
    const failed = illustrationJob(store, job.id);
    expect(failed.diagnostic?.comfyui?.promptId).toBe(comfy.prompts[0].id);
    expect(comfy.prompts).toHaveLength(1);
    expect(comfy.requests.some((request) => request.url === '/interrupt')).toBe(false);
    const reconcileHooks = { signal: new AbortController().signal };
    let result = await reconcileIllustrationJob(store, job.id, 'worker', reconcileHooks);
    for (let round = 0; round < 5 && result.status !== 'completed'; round++)
      result = await reconcileIllustrationJob(store, job.id, 'worker', reconcileHooks);
    expect(result.status).toBe('completed');
    expect(result.images[0]).toMatchObject({ caption: '늦게 도착한 등불', prompt: 'slow lantern' });
    expect(comfy.prompts).toHaveLength(1);
    expect(illustrationJob(store, job.id).diagnostic?.stage).toBe('store');
    await expect(reconcileIllustrationJob(store, job.id, 'worker', reconcileHooks)).rejects.toThrow(
      'ILLUSTRATION_NOT_RECONCILABLE'
    );
  });
});
