import { reserveIllustration } from './fixtures/illustration.js';
import { fixtureIllustrationPreset } from './fixtures/illustration.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import type { CodexImageRequest, CodexImageResult } from '../server/codex-runtime.js';
import {
  reconcileIllustrationJob,
  runIllustrationJob,
  type IllustrationRunnerHooks,
} from '../server/illustration-runner.js';
import {
  illustrationJob,
  projectIllustration,
  reserveIllustrationPlan,
  queuedIllustrations,
  cancelIllustration,
  illustrationsForSources,
  retryIllustration,
  regenerateIllustration,
  updateIllustrationSettings,
  updateIllustrationReferences,
  scheduleIllustrationPlacement,
  type IllustrationJobRow,
} from '../server/illustrations.js';
import { splitSource } from '../core/auxiliary.js';
import type { IllustrationTarget } from '../core/illustration-storyboard.js';
import { illustrationPresentation } from '../server/illustration-presentation.js';
import type { Store } from '../server/store.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { comfyUIFixture, FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
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
  vi.restoreAllMocks();
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
    const job = withPreparedPrompt(
      store,
      reserveIllustration(store, source, 'manual', {
        settings: fixtureSettings({
          generator: undefined,
          maxAutoRetries: 5,
          codex: { model: { id: model.id }, promptModel: { id: model.id } },
        }),
      })
    );
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
test('a Codex job input without a prompt model fails explicitly before any dispatch', async () => {
  const store = databases.create();
  const { source } = chatWithSource(store);
  const model = codexModel(store);
  const job = withPreparedPrompt(
    store,
    reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: undefined,
        codex: { model: { id: model.id }, promptModel: { id: model.id } },
      }),
    })
  );
  const { promptModel: _promptModel, ...codex } = job.input.codex!;
  store.db
    .prepare('UPDATE illustration_jobs SET input=? WHERE id=?')
    .run(JSON.stringify({ ...job.input, codex }), job.id);
  const generate = vi.fn<NonNullable<IllustrationRunnerHooks['generateCodexImage']>>();
  const observed = hooks(store, { generateCodexImage: generate });
  expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toMatchObject({
    status: 'failed',
    code: 'ILLUSTRATION_PROMPT_MODEL_REQUIRED',
  });
  expect(generate).not.toHaveBeenCalled();
  expect(observed.wires).toHaveLength(0);
});
function withPreparedPrompt(store: Store, job: IllustrationJobRow) {
  const [block] = splitSource(store.source(job.sourceRevision));
  const target: IllustrationTarget = {
    id: `target-${job.id}`,
    order: 0,
    startAnchor: block.anchor,
    endAnchor: block.anchor,
    focus: block.text,
    visualBrief: block.text,
    prompt: { prompt: 'A lantern above the river.', negativePrompt: '', caption: '등불' },
  };
  store.db
    .prepare('UPDATE illustration_jobs SET input=? WHERE id=?')
    .run(JSON.stringify({ ...job.input, target }), job.id);
  return illustrationJob(store, job.id);
}
function hooks(store: Store, extra: Partial<IllustrationRunnerHooks> = {}) {
  const wires: WireRecord[] = [];
  const finishes: { id: string; result: ProviderResult }[] = [];
  let progress = 0;
  const options: IllustrationRunnerHooks = {
    signal: new AbortController().signal,

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
async function promptModel(store: Store, reply: (body: any) => string, inputTokenLimit?: number) {
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
    ...(inputTokenLimit === undefined ? {} : { inputTokenLimit }),
  }) as ModelPreset;
  return { provider, model };
}

describe('illustration runner with the synthetic generator', () => {
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
  test('a separate prompt model stops Codex dispatch for invalid prompt output', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const imageModel = codexModel(store);
    const { provider, model } = await promptModel(store, () => 'invalid prompt JSON');
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: undefined,
        maxAutoRetries: 0,
        codex: { model: { id: imageModel.id }, promptModel: { id: model.id } },
      }),
    });
    const generateCodexImage = vi.fn<NonNullable<IllustrationRunnerHooks['generateCodexImage']>>();
    const observed = hooks(store, { generateCodexImage });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'failed',
      code: 'ILLUSTRATION_PROMPT_INVALID',
      images: 0,
    });
    expect(provider.requests).toHaveLength(1);
    expect(generateCodexImage).not.toHaveBeenCalled();
    expect(observed.wires).toHaveLength(1);
    expect(store.source(source.id).text).toBe(source.text);
  });

  test('usage limits fail immediately without an automatic retry', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const model = codexModel(store);
    const settings = fixtureSettings({
      generator: undefined,
      maxAutoRetries: 1,
      maxPerSource: 4,
      codex: { model: { id: model.id }, promptModel: { id: model.id }, useReferences: false },
    });
    const limited = withPreparedPrompt(
      store,
      reserveIllustration(store, source, 'manual', { settings })
    );
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
  });
});

test('selecting Codex as the prompt model still plans first and renders from the prepared prompt', async () => {
  const store = databases.create();
  const { source } = chatWithSource(store);
  const model = codexModel(store);
  const plan = reserveIllustrationPlan(store, source, 'manual', {
    maxTargets: 1,
    settings: fixtureSettings({
      generator: undefined,
      codex: { model: { id: model.id }, promptModel: { id: model.id } },
    }),
  });
  const prompt = '  A "silver lantern" floats above the river.\n';
  const calls: string[] = [];
  const executeCodex = vi.fn<NonNullable<IllustrationRunnerHooks['executeCodex']>>(
    async (_connection, request) => {
      calls.push('plan');
      const source = request.input.source as { blocks: [string, string][] };
      return {
        status: 'completed',
        text: JSON.stringify({
          heroIndex: 0,
          targets: [
            {
              startAnchor: source.blocks[0][0],
              endAnchor: source.blocks[0][0],
              focus: 'The lantern',
              visualBrief: 'A lantern above the river',
              prompt: { prompt, caption: '은빛 등불' },
            },
          ],
        }),
        toolCalls: [],
        refusal: null,
        error: null,
        usage: { inputTokens: 20, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
        opaqueState: null,
      };
    }
  );
  const generateCodexImage = vi.fn<NonNullable<IllustrationRunnerHooks['generateCodexImage']>>(
    async (_connection, request) => {
      calls.push('image');
      expect(JSON.parse(request.text).prompt).toBe(prompt);
      return {
        status: 'completed',
        images: [{ mime: 'image/png', bytes: PNG }],
        revisedPrompt: null,
        text: '{"caption":"은빛 등불"}',
        error: null,
        usage: { inputTokens: 20, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
      };
    }
  );
  const observed = hooks(store, { executeCodex, generateCodexImage });
  expect((await runIllustrationJob(store, plan.id, 'worker', observed.options))?.status).toBe(
    'completed'
  );
  expect(generateCodexImage).not.toHaveBeenCalled();
  const [cut] = queuedIllustrations(store);
  expect((await runIllustrationJob(store, cut, 'worker', observed.options))?.status).toBe(
    'completed'
  );
  expect(executeCodex).toHaveBeenCalledTimes(1);
  expect(generateCodexImage).toHaveBeenCalledTimes(1);
  expect(calls).toEqual(['plan', 'image']);
});

test('one separate Codex planning call prepares every cut and passes each prompt unchanged to image generation', async () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const reference = store.product.createAsset(chat.id, {
    title: 'Mira character reference',
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
    references: [],
    characterProfiles: [
      { id: 'mira', name: 'Mira', appearance: 'Silver braid', referenceRef: reference.id },
      { id: 'sol', name: 'Sol', appearance: 'Freckles' },
    ],
  });
  const imageModel = codexModel(store);
  const prompts = [
    '  Mira holds a "blue lantern".\nKeep the silver trim.\n',
    '\tA quiet pier — before sunrise.  ',
  ];
  const { provider, model } = await promptModel(store, (body) =>
    JSON.stringify({
      heroIndex: 1,
      targets: body.input.source.blocks.map(([anchor, text]: [string, string], index: number) => ({
        startAnchor: anchor,
        endAnchor: anchor,
        focus: text,
        visualBrief: text,
        prompt: { prompt: prompts[index], caption: `별도 프롬프트 컷 ${index + 1}` },
      })),
    })
  );
  const plan = reserveIllustrationPlan(store, source, 'manual', {
    maxTargets: 2,
    direction: '  등불을 든 미라와 고요한 부두를 각각 그려 주세요.  ',
    requestKey: 'manual-directed-plan',
    settings: fixtureSettings({
      generator: undefined,
      codex: { model: { id: imageModel.id }, promptModel: { id: model.id } },
    }),
  });
  expect(
    reserveIllustrationPlan(store, source, 'manual', {
      direction: 'This later request must not replace the admitted direction.',
      requestKey: 'manual-directed-plan',
    }).input.plan?.direction
  ).toBe('등불을 든 미라와 고요한 부두를 각각 그려 주세요.');
  cancelIllustration(store, plan.id);
  retryIllustration(store, plan.id);
  const captured: CodexImageRequest[] = [];
  const observed = hooks(store, {
    generateCodexImage: async (_connection, request) => {
      captured.push(request);
      return {
        status: 'completed',
        images: [{ mime: 'image/png', bytes: PNG }],
        revisedPrompt: null,
        text: '{"caption":"생성된 그림"}',
        error: null,
        usage: { inputTokens: 20, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
      };
    },
  });
  expect((await runIllustrationJob(store, plan.id, 'worker', observed.options))?.status).toBe(
    'completed'
  );
  const cuts = queuedIllustrations(store);
  expect(cuts).toHaveLength(2);
  for (const id of cuts)
    expect((await runIllustrationJob(store, id, 'worker', observed.options))?.status).toBe(
      'completed'
    );
  expect(provider.requests).toHaveLength(1);
  const plannedSource = JSON.parse(provider.requests[0].body).input.source;
  expect(plannedSource.direction).toBe('등불을 든 미라와 고요한 부두를 각각 그려 주세요.');
  expect(cuts.every((id) => !illustrationJob(store, id).input.plan)).toBe(true);
  expect(plannedSource.characterProfiles).toEqual([
    { name: 'Mira', appearance: 'Silver braid' },
    { name: 'Sol', appearance: 'Freckles' },
  ]);
  expect(plannedSource.attachedReferences).toEqual([
    { attachment: 1, role: 'character design reference', label: 'Mira (Mira character reference)' },
  ]);
  expect(provider.requests[0].body).not.toContain(PNG_BASE64);
  expect(captured.map((request) => JSON.parse(request.text).prompt)).toEqual([
    prompts[1],
    prompts[0],
  ]);
  expect(captured.every((request) => request.modelId === imageModel.modelId)).toBe(true);
  expect(captured.map((request) => request.references)).toEqual([
    [{ mime: 'image/png', base64: PNG_BASE64 }],
    [{ mime: 'image/png', base64: PNG_BASE64 }],
  ]);
  expect(illustrationJob(store, cuts[0]).diagnostic?.prompt).toMatchObject({
    prompt: prompts[1],
    caption: '별도 프롬프트 컷 2',
  });
  expect(store.source(source.id).text).toBe(source.text);
});

test('Codex redraw uses the new refinement setting and retries keep the draft and mode', async () => {
  const changeRequest = '빛을 더 따뜻하게 바꿔 주세요.';
  const store = databases.create();
  const { source } = chatWithSource(store);
  const imageModel = codexModel(store);
  fixtureIllustrationPreset(store, { styleGuidance: 'watercolor' });
  const originalPrompt = 'Original blue lantern';
  const redrawPrompt = '  Redraw the "blue lantern".\n';
  const { provider, model } = await promptModel(store, (body) => {
    const blocks = body.input.source.blocks as [string, string][] | undefined;
    return JSON.stringify(
      blocks
        ? {
            heroIndex: 0,
            targets: [
              {
                startAnchor: blocks[0][0],
                endAnchor: blocks[0][0],
                focus: 'Mira',
                visualBrief: 'Mira with a lantern',
                prompt: { prompt: originalPrompt, caption: '첫 등불' },
              },
            ],
          }
        : { prompt: redrawPrompt, caption: '다시 그린 등불' }
    );
  });
  const { revision, ...body } = fixtureSettings({
    generator: undefined,
    maxAutoRetries: 0,
    codex: { model: { id: imageModel.id }, promptModel: { id: model.id } },
  });
  let saved = updateIllustrationSettings(store, { expectedRevision: revision, ...body }, true);
  const plan = reserveIllustrationPlan(store, source, 'manual', { maxTargets: 1 });
  const captured: CodexImageRequest[] = [];
  let rejectNext = false;
  const observed = hooks(store, {
    generateCodexImage: async (_connection, request) => {
      captured.push(request);
      const fail = rejectNext;
      rejectNext = false;
      return {
        status: fail ? 'error' : 'completed',
        images: fail ? [] : [{ mime: 'image/png', bytes: PNG }],
        revisedPrompt: fail ? null : 'Mira holds a lantern in warm light.',
        text: '{"caption":"따뜻한 빛을 비추는 등불"}',
        error: fail ? { code: 'CODEX_IMAGE_NOT_GENERATED' } : null,
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          costUsd: null,
          raw: null,
          priceRevision: null,
        },
      };
    },
  });
  expect((await runIllustrationJob(store, plan.id, 'worker', observed.options))?.status).toBe(
    'completed'
  );
  const [cut] = queuedIllustrations(store);
  saved = updateIllustrationSettings(
    store,
    { expectedRevision: saved.revision, ...body, codex: { ...body.codex, refinePrompt: true } },
    true
  );
  expect((await runIllustrationJob(store, cut, 'worker', observed.options))?.status).toBe(
    'completed'
  );
  expect(captured[0].developerInstructions).toContain('verbatim');
  expect(projectIllustration(store, illustrationJob(store, cut)).images[0].caption).toBe('첫 등불');
  const redraw = regenerateIllustration(store, cut, false, changeRequest);
  expect(redraw.input.target?.prompt).toBeUndefined();
  expect(redraw.input.redraw).toEqual({
    changeRequest,
    originalPrompt: { prompt: originalPrompt, negativePrompt: '', caption: '첫 등불' },
  });
  rejectNext = true;
  expect(await runIllustrationJob(store, redraw.id, 'worker', observed.options)).toEqual({
    status: 'failed',
    code: 'CODEX_IMAGE_NOT_GENERATED',
    images: 0,
  });
  updateIllustrationSettings(store, { expectedRevision: saved.revision, ...body }, true);
  retryIllustration(store, redraw.id);
  expect((await runIllustrationJob(store, redraw.id, 'worker', observed.options))?.status).toBe(
    'completed'
  );
  expect(provider.requests).toHaveLength(2);
  expect(JSON.parse(provider.requests[1].body).input.source.redraw).toEqual(redraw.input.redraw);
  expect(illustrationJob(store, redraw.id).input.redraw).toEqual(redraw.input.redraw);
  const sent = captured.map(({ text }) => JSON.parse(text));
  expect(sent.map((text) => text.prompt ?? text.draft)).toEqual([
    originalPrompt,
    redrawPrompt,
    redrawPrompt,
  ]);
  expect(sent[0].draft).toBeUndefined();
  expect(sent[1].prompt).toBeUndefined();
  expect(captured[1].developerInstructions).toContain('could not see the attached images');
  expect(sent[1].styleGuidance).toContain('watercolor');
  expect(sent[1].changeRequest).toBe(changeRequest);
  expect(JSON.parse(captured[1].text).moment).toEqual({
    focus: 'Mira',
    visualBrief: 'Mira with a lantern',
  });
  expect(captured[2].text).toBe(captured[1].text);
  expect(captured[2].developerInstructions).toBe(captured[1].developerInstructions);
  expect(projectIllustration(store, illustrationJob(store, redraw.id)).images[0]).toMatchObject({
    caption: '따뜻한 빛을 비추는 등불',
    prompt: redrawPrompt,
    revisedPrompt: 'Mira holds a lantern in warm light.',
  });
  const followup = regenerateIllustration(store, redraw.id, false, '장갑 색만 바꿔 주세요.');
  expect(followup.input.redraw).toEqual({
    changeRequest: '장갑 색만 바꿔 주세요.',
    originalPrompt: {
      prompt: redrawPrompt,
      negativePrompt: '',
      caption: '따뜻한 빛을 비추는 등불',
    },
    revisedPrompt: 'Mira holds a lantern in warm light.',
  });
  expect(store.source(source.id).text).toBe(source.text);
});

test('a requested redraw from ComfyUI carries the last successful prompt into Codex', async () => {
  const originalGenerator = 'comfyui' as 'codex' | 'comfyui';
  const store = databases.create();
  const { source } = chatWithSource(store);
  const imageModel = codexModel(store);
  const originalPrompt = 'Mira, blue lantern, (silver trim:1.2)';
  const changedPrompt = 'Mira holds a warm lantern with silver trim.';
  const { provider, model } = await promptModel(store, (request) => {
    const blocks = request.input.source.blocks as [string, string][] | undefined;
    return JSON.stringify(
      blocks
        ? {
            heroIndex: 0,
            targets: [
              {
                startAnchor: blocks[0][0],
                endAnchor: blocks[0][0],
                focus: 'Mira with her lantern',
                visualBrief: 'Mira holds a blue lantern with silver trim.',
                prompt: { prompt: originalPrompt, negativePrompt: 'text', caption: '푸른 등불' },
              },
            ],
          }
        : { prompt: changedPrompt, caption: '따뜻한 등불' }
    );
  });
  const comfy = await comfyUIFixture();
  cleanups.push(comfy.close);
  const selectGenerator = (generator: 'codex' | 'comfyui') =>
    fixtureIllustrationPreset(store, {
      generator,
      styleGuidance: `${generator} visual style`,
      comfyui: { workflow: FIXTURE_WORKFLOW },
    });
  selectGenerator(originalGenerator);
  const { revision, ...settings } = fixtureSettings({
    generator: undefined,
    codex: { model: { id: imageModel.id }, promptModel: { id: model.id } },
    comfyui: {
      baseUrl: comfy.origin,
      promptModel: { id: model.id },
      timeoutMs: 10_000,
      pollIntervalMs: 250,
    },
  });
  updateIllustrationSettings(store, { expectedRevision: revision, ...settings }, true);
  const observed = hooks(store, {
    generateCodexImage: async () => ({
      status: 'completed',
      images: [{ mime: 'image/png', bytes: PNG }],
      revisedPrompt: null,
      text: '{"caption":"등불"}',
      error: null,
      usage: { inputTokens: 20, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
    }),
  });
  const plan = reserveIllustrationPlan(store, source, 'manual');
  await runIllustrationJob(store, plan.id, 'worker', observed.options);
  const [originalId] = queuedIllustrations(store);
  expect((await runIllustrationJob(store, originalId, 'worker', observed.options))?.status).toBe(
    'completed'
  );
  const generator = originalGenerator === 'codex' ? 'comfyui' : 'codex';
  selectGenerator(generator);
  const cancelled = regenerateIllustration(store, originalId);
  cancelIllustration(store, cancelled.id);
  const redraw = regenerateIllustration(
    store,
    cancelled.id,
    false,
    '  빛을 따뜻하게 바꿔 주세요.  '
  );
  expect(redraw.input).toMatchObject({
    generator,
    styleGuidance: `${generator} visual style`,
    redraw: {
      changeRequest: '빛을 따뜻하게 바꿔 주세요.',
      originalPrompt: {
        prompt: originalPrompt,
        negativePrompt: originalGenerator === 'comfyui' ? 'text' : '',
        caption: '푸른 등불',
      },
    },
  });
  expect((await runIllustrationJob(store, redraw.id, 'worker', observed.options))?.status).toBe(
    'completed'
  );
  expect(provider.requests).toHaveLength(2);
  expect(JSON.parse(provider.requests[1].body).input.source).toMatchObject({
    redraw: redraw.input.redraw,
    styleGuidance: `${generator} visual style`,
  });
  expect(projectIllustration(store, illustrationJob(store, redraw.id)).images[0].prompt).toBe(
    changedPrompt
  );
});

describe('illustration runner through a prompt model and remote ComfyUI', () => {
  test('reuses a successful prompt only within the same job and a recorded matching request', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const prompt = { prompt: 'a lantern', negativePrompt: 'text', caption: '강 위의 등불' };
    const { provider, model } = await promptModel(store, () => JSON.stringify(prompt));
    const comfy = await comfyUIFixture({ behavior: 'error' });
    cleanups.push(comfy.close);
    fixtureIllustrationPreset(store, { comfyui: { workflow: FIXTURE_WORKFLOW } });
    const settings = fixtureSettings({
      generator: undefined,
      maxAutoRetries: 1,
      comfyui: {
        baseUrl: comfy.origin,
        promptModel: { id: model.id },
        timeoutMs: 5000,
        pollIntervalMs: 20,
      },
    });
    const job = reserveIllustration(store, source, 'manual', { settings });
    const observed = hooks(store);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toMatchObject({
      status: 'requeued',
      code: 'COMFYUI_EXECUTION_FAILED',
    });
    random.mockReturnValue(0.2);
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toMatchObject({
      status: 'failed',
    });
    retryIllustration(store, job.id);
    random.mockReturnValue(0.3);
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toMatchObject({
      status: 'failed',
    });
    expect(provider.requests).toHaveLength(1);
    expect(observed.wires).toHaveLength(1);
    expect(comfy.prompts).toHaveLength(3);
    const seeds = comfy.prompts.map(
      ({ workflow }) => (workflow['3'] as { inputs: { seed: number } }).inputs.seed
    );
    expect(new Set(seeds).size).toBe(3);
    random.mockRestore();
    for (const rendered of comfy.prompts) {
      expect(rendered.workflow['6']).toMatchObject({ inputs: { text: prompt.prompt } });
      expect(rendered.workflow['7']).toMatchObject({ inputs: { text: 'blurry, text' } });
    }
    expect(illustrationJob(store, job.id).diagnostic?.prompt).toEqual(prompt);

    const legacy = illustrationJob(store, job.id).diagnostic!;
    delete legacy.promptRequestHash;
    store.db
      .prepare('UPDATE illustration_jobs SET diagnostic=? WHERE id=?')
      .run(JSON.stringify(legacy), job.id);
    retryIllustration(store, job.id);
    await runIllustrationJob(store, job.id, 'worker', observed.options);
    expect(provider.requests).toHaveLength(2);

    const next = reserveIllustration(store, source, 'manual', { settings });
    await runIllustrationJob(store, next.id, 'worker', observed.options);
    expect(provider.requests).toHaveLength(3);
  });

  test('regenerates after reconstructed character notes change and never caches an invalid plan', async () => {
    const store = databases.create();
    const { chat, source } = chatWithSource(store);
    let reply = JSON.stringify({ prompt: 'a lantern', caption: '처음 장면' });
    const { provider, model } = await promptModel(store, () => reply);
    const comfy = await comfyUIFixture({ behavior: 'error' });
    cleanups.push(comfy.close);
    fixtureIllustrationPreset(store, { comfyui: { workflow: FIXTURE_WORKFLOW } });
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: undefined,
        maxAutoRetries: 2,
        comfyui: {
          baseUrl: comfy.origin,
          promptModel: { id: model.id },
          timeoutMs: 5000,
          pollIntervalMs: 20,
        },
      }),
    });
    const observed = hooks(store);
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toMatchObject({
      status: 'requeued',
      code: 'COMFYUI_EXECUTION_FAILED',
    });
    const bot = store.product.get<Content>('content', chat.botId);
    store.product.content(
      { ...fixtureBotInput(bot.title, 'Mira wears a red coat.'), expectedRevision: bot.revision },
      bot.id
    );
    reply = 'not a JSON illustration plan';
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toMatchObject({
      status: 'requeued',
      code: 'ILLUSTRATION_PROMPT_INVALID',
    });
    expect(JSON.parse(provider.requests[1].body).input.source.characterNotes.bot).toBe(
      'Mira wears a red coat.'
    );
    reply = JSON.stringify({ prompt: 'Mira in a red coat', caption: '붉은 외투' });
    await runIllustrationJob(store, job.id, 'worker', observed.options);
    expect(provider.requests).toHaveLength(3);
    expect(comfy.prompts).toHaveLength(2);
    expect(comfy.prompts[1].workflow['6']).toMatchObject({
      inputs: { text: 'Mira in a red coat' },
    });
    expect(illustrationJob(store, job.id).diagnostic?.prompt?.caption).toBe('붉은 외투');
  });

  test('style guidance over the selected model budget stays intact and causes no model or render request', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const { provider, model } = await promptModel(store, () => '{"prompt":"unused"}', 8192);
    const comfy = await comfyUIFixture();
    cleanups.push(comfy.close);
    const guidance = '강가의 빛과 그림자, 그림 속 인물의 외모를 보존해 주세요. '.repeat(1000);
    fixtureIllustrationPreset(store, {
      styleGuidance: guidance,
      comfyui: { workflow: FIXTURE_WORKFLOW, negativeGuidance: '' },
    });
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: undefined,

        maxAutoRetries: 5,
        comfyui: {
          baseUrl: comfy.origin,

          promptModel: { id: model.id },
        },
      }),
    });
    const observed = hooks(store);
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'failed',
      code: 'ILLUSTRATION_PROMPT_INPUT_CONTEXT_LIMIT_EXCEEDED',
      images: 0,
    });
    expect(provider.requests).toEqual([]);
    expect(comfy.requests).toEqual([]);
    expect(observed.wires).toEqual([]);
    const frozen = illustrationJob(store, job.id);
    expect(frozen.attempt).toBe(1);
    expect(frozen.input.styleGuidance).toBe(guidance);
  });
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
    fixtureIllustrationPreset(store, {
      styleGuidance: 'watercolor',
      comfyui: { workflow: FIXTURE_WORKFLOW, negativeGuidance: 'text' },
    });
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: undefined,

        comfyui: {
          baseUrl: comfy.origin,

          promptModel: { id: model.id },
          timeoutMs: 5000,
          pollIntervalMs: 20,
        },
      }),
    });
    expect(job.input.comfyui?.promptModel.modelId).toBe('fixture-prompt-writer');
    const observed = hooks(store, {});
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
    const item = projectIllustration(store, illustrationJob(store, job.id));
    expect(item.images[0]).toMatchObject({
      mime: 'image/webp',
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
    const { model } = await promptModel(store, () => reply);
    const rejecting = await comfyUIFixture({ behavior: 'reject' });
    cleanups.push(rejecting.close);
    fixtureIllustrationPreset(store, { comfyui: { workflow: FIXTURE_WORKFLOW } });
    const base = (baseUrl: string) =>
      fixtureSettings({
        generator: undefined,
        maxAutoRetries: 1,
        maxPerSource: 6,
        comfyui: {
          baseUrl,

          promptModel: { id: model.id },
          timeoutMs: 5000,
          pollIntervalMs: 20,
        },
      });
    const observed = hooks(store, {});
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
  test('accepted history HTTP 401 never requeues and reconciles the same authenticated remote job', async () => {
    const httpStatus = 401;
    const store = databases.create();
    const { source } = chatWithSource(store);
    const { provider, model } = await promptModel(store, () =>
      JSON.stringify({ prompt: 'one render', caption: '한 번' })
    );
    const comfy = await comfyUIFixture({
      fault: { path: 'history', kind: 'http-error', httpStatus },
      authorization: 'Bearer callback-only',
    });
    cleanups.push(comfy.close);
    fixtureIllustrationPreset(store, { comfyui: { workflow: FIXTURE_WORKFLOW } });
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: undefined,
        maxAutoRetries: 3,
        comfyui: {
          baseUrl: comfy.origin,
          authorizationEnv: 'CALLBACK_ONLY',

          promptModel: { id: model.id },
          timeoutMs: 1000,
          pollIntervalMs: 10,
        },
      }),
    });
    const observed = hooks(store, {
      resolveCredential: () => 'Bearer callback-only',
      resolveComfyCredential: () => 'Bearer callback-only',
    });
    expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
      status: 'failed',
      code: 'COMFYUI_RESULT_UNAVAILABLE',
      images: 0,
    });
    expect(illustrationJob(store, job.id).diagnostic?.comfyui).toMatchObject({
      promptId: comfy.prompts[0].id,
      httpStatus,
      submission: 'accepted',
    });
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

  test('automatic runs may skip through the prompt model without touching ComfyUI; manual runs must draw', async () => {
    const store = databases.create();
    const { chat, source } = chatWithSource(store);
    let reply = JSON.stringify({ decision: 'skip', reason: '대화만 이어지는 장면' });
    const { provider, model } = await promptModel(store, () => reply);
    const comfy = await comfyUIFixture();
    cleanups.push(comfy.close);
    fixtureIllustrationPreset(store, { comfyui: { workflow: FIXTURE_WORKFLOW } });
    const settings = fixtureSettings({
      generator: undefined,
      automatic: true,
      maxPerSource: 2,
      comfyui: {
        baseUrl: comfy.origin,

        promptModel: { id: model.id },
        timeoutMs: 5000,
        pollIntervalMs: 20,
      },
    });
    const automatic = reserveIllustration(store, source, 'automatic', { settings });
    const observed = hooks(store, {});
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
  test('a ComfyUI timeout keeps the prompt_id, never re-renders, and reconcile stores the late result', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const { model } = await promptModel(store, () =>
      JSON.stringify({ prompt: 'slow lantern', caption: '늦게 도착한 등불' })
    );
    const comfy = await comfyUIFixture({ delayPolls: 1 });
    cleanups.push(comfy.close);
    fixtureIllustrationPreset(store, { comfyui: { workflow: FIXTURE_WORKFLOW } });
    const timeoutMs = 5000;
    const deadline = new AbortController();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds) =>
        milliseconds === timeoutMs ? deadline.signal : realTimeout(milliseconds)
      );
    const job = reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: undefined,
        maxAutoRetries: 2,
        comfyui: {
          baseUrl: comfy.origin,

          promptModel: { id: model.id },
          timeoutMs,
          pollIntervalMs: 20,
        },
      }),
    });
    const observed = hooks(store, {
      onProgress: () => {
        if (illustrationJob(store, job.id).diagnostic?.comfyui?.submission === 'accepted')
          deadline.abort(new DOMException('Synthetic deadline expired', 'TimeoutError'));
      },
    });
    try {
      expect(await runIllustrationJob(store, job.id, 'worker', observed.options)).toEqual({
        status: 'failed',
        code: 'COMFYUI_TIMEOUT',
        images: 0,
      });
    } finally {
      timeout.mockRestore();
    }
    const failed = illustrationJob(store, job.id);
    expect(comfy.prompts).toHaveLength(1);
    expect(failed.diagnostic?.comfyui).toMatchObject({
      promptId: comfy.prompts[0].id,
      submission: 'accepted',
    });
    expect(comfy.requests.some((request) => request.url === '/interrupt')).toBe(false);
    const reconcileHooks = { signal: new AbortController().signal };
    expect(await reconcileIllustrationJob(store, job.id, 'worker', reconcileHooks)).toMatchObject({
      status: 'failed',
      error: 'COMFYUI_TIMEOUT',
    });
    const result = await reconcileIllustrationJob(store, job.id, 'worker', reconcileHooks);
    expect(result.status).toBe('completed');
    expect(result.images[0]).toMatchObject({ caption: '늦게 도착한 등불', prompt: 'slow lantern' });
    expect(comfy.prompts).toHaveLength(1);
    expect(
      comfy.requests.filter((request) => request.url.startsWith('/history/')).map(({ url }) => url)
    ).toEqual([`/history/${comfy.prompts[0].id}`, `/history/${comfy.prompts[0].id}`]);
    expect(illustrationJob(store, job.id).diagnostic?.stage).toBe('store');
    await expect(reconcileIllustrationJob(store, job.id, 'worker', reconcileHooks)).rejects.toThrow(
      'ILLUSTRATION_NOT_RECONCILABLE'
    );
  });
});

test.each(['blocked', 'missing-key', 'unavailable', 'cancelled'] as const)(
  'Codex image dispatch respects the JEV %s outcome and records its real attempts',
  async (mode) => {
    const store = databases.create();
    const { source, chat } = chatWithSource(store);
    const model = codexModel(store);
    const job = withPreparedPrompt(
      store,
      reserveIllustration(store, source, 'manual', {
        settings: fixtureSettings({
          generator: undefined,
          maxAutoRetries: 5,
          codex: { model: { id: model.id }, promptModel: { id: model.id } },
        }),
      })
    );
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (mode === 'cancelled') controller.abort();
      if (mode === 'unavailable') return new Response('synthetic unavailable', { status: 503 });
      return Response.json({
        model: 'jev-latest',
        answers: {
          explicitSexualContent: { type: 'noul', noul: mode === 'blocked' ? 0.95 : 0.1 },
        },
        usage: { input_tokens: 40, output_tokens: 1 },
      });
    });
    const generate = vi.fn<NonNullable<IllustrationRunnerHooks['generateCodexImage']>>(
      async () => ({
        status: 'completed',
        images: [{ mime: 'image/png', bytes: PNG }],
        text: '{"caption":"등불"}',
        revisedPrompt: null,
        error: null,
        usage: { inputTokens: 20, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
      })
    );
    const result = await runIllustrationJob(store, job.id, 'worker', {
      signal: controller.signal,
      resolveJevCredential: () => (mode === 'missing-key' ? undefined : 'synthetic-test-key'),
      authorize: (connection) => connection,
      onAttemptStart: (wire) => store.product.startAttempt(chat.id, null, null, wire),
      onAttemptFinish: (id, value) => store.product.finishAttempt(id, value),
      generateCodexImage: generate,
    });
    const saved = illustrationJob(store, job.id);
    if (mode === 'blocked') {
      expect(result).toEqual({
        status: 'failed',
        code: 'ILLUSTRATION_CODEX_CONTENT_BLOCKED',
        images: 0,
      });
      expect(saved.attempt).toBe(1);
      expect(saved.diagnostic?.contentCheck).toMatchObject({ status: 'blocked', score: 0.95 });
      expect(() => retryIllustration(store, job.id)).toThrow('ILLUSTRATION_CODEX_CONTENT_BLOCKED');
      const recorded = store.db.prepare('SELECT role,input_tokens,request FROM attempts').all();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ role: 'illustration', input_tokens: 40 });
      expect(JSON.parse(String(recorded[0].request)).judgment.kind).toBe('illustration-content');
    } else if (mode === 'cancelled') {
      expect(result?.status).toBe('cancelled');
    } else {
      expect(result?.status).toBe('completed');
      expect(saved.diagnostic?.contentCheck?.status).toBe('unavailable');
    }
    expect(generate).toHaveBeenCalledTimes(mode === 'blocked' || mode === 'cancelled' ? 0 : 1);
    expect(fetch).toHaveBeenCalledTimes(mode === 'missing-key' ? 0 : 1);
    expect(store.source(source.id).text).toBe(source.text);
  }
);

test.each(['paragraph', 'none', 'missing-key', 'unavailable'] as const)(
  'translation placement asks the judgment model first: %s',
  async (mode) => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const model = codexModel(store);
    const plan = reserveIllustrationPlan(store, source, 'manual', {
      maxTargets: 1,
      settings: fixtureSettings({
        generator: undefined,
        codex: { model: { id: model.id }, promptModel: { id: model.id } },
      }),
    });
    const usage = {
      inputTokens: 20,
      outputTokens: 5,
      costUsd: null,
      raw: null,
      priceRevision: null,
    };
    const executeCodex = vi.fn<NonNullable<IllustrationRunnerHooks['executeCodex']>>(
      async (_connection, request) => {
        const blocks = (request.input.source as { blocks?: [string, string][] }).blocks;
        return {
          status: 'completed',
          text: blocks
            ? JSON.stringify({
                heroIndex: 0,
                targets: [
                  {
                    startAnchor: blocks[1][0],
                    endAnchor: blocks[1][0],
                    focus: 'Mira on the pier',
                    visualBrief: 'Mira waiting on the pier',
                    prompt: { prompt: 'Mira on a pier', caption: '부두의 미라' },
                  },
                ],
              })
            : '{"afterByTarget":{"i0":"t0"}}',
          toolCalls: [],
          refusal: null,
          error: null,
          usage,
          opaqueState: null,
        };
      }
    );
    const generateCodexImage = vi.fn<NonNullable<IllustrationRunnerHooks['generateCodexImage']>>(
      async () => ({
        status: 'completed',
        images: [{ mime: 'image/png', bytes: PNG }],
        revisedPrompt: null,
        text: '{"caption":"부두의 미라"}',
        error: null,
        usage,
      })
    );
    const setup = hooks(store, { executeCodex, generateCodexImage });
    await runIllustrationJob(store, plan.id, 'worker', setup.options);
    await runIllustrationJob(store, queuedIllustrations(store)[0], 'worker', setup.options);
    const translation = store.editTranslation(source.id, {
      expectedRevision: 0,
      expectedSourceHash: source.hash,
      text: '강 위로 등불이 흔들렸다.\n\n미라는 부두에서 기다렸다.',
    });
    const placement = scheduleIllustrationPlacement(store, source.id)!;
    const [targetId] = placement.input.placement!.targets.map((target) => target.id);
    const choice = mode === 'none' ? 'none' : 't1';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      mode === 'unavailable'
        ? new Response('synthetic unavailable', { status: 503 })
        : Response.json({
            model: 'jev-latest',
            answers: {
              i0: {
                type: 'choice',
                choice,
                confidence: 0.9,
                probabilities: { none: 0.05, t0: 0.05, t1: 0.05, [choice]: 0.9 },
              },
            },
            usage: { input_tokens: 60, output_tokens: 1 },
          })
    );
    const observed = hooks(store, {
      executeCodex,
      resolveJevCredential: () => (mode === 'missing-key' ? undefined : 'synthetic-test-key'),
    });
    const result = await runIllustrationJob(store, placement.id, 'worker', observed.options);
    const mapping = illustrationPresentation(store, source.id)?.translation;
    const judged = observed.wires.filter((wire) => wire.judgment);
    expect(fetch).toHaveBeenCalledTimes(mode === 'missing-key' ? 0 : 1);
    expect(executeCodex).toHaveBeenCalledTimes(mode === 'missing-key' ? 2 : 1);
    expect(generateCodexImage).toHaveBeenCalledTimes(1);
    if (mode === 'unavailable') {
      expect(result).toEqual({ status: 'failed', code: 'JEV_HTTP_503', images: 0 });
      expect(mapping).toBeUndefined();
      return;
    }
    expect(result?.status).toBe('completed');
    const anchors = translation.translationLayout!.blocks.map((block) => block.anchor);
    expect(mapping?.afterByTarget).toEqual({
      [targetId]: mode === 'none' ? null : anchors[mode === 'paragraph' ? 1 : 0],
    });
    expect(judged.map((wire) => [wire.role, wire.judgment?.kind])).toEqual(
      mode === 'missing-key' ? [] : [['illustration', 'illustration-placement']]
    );
  }
);

test.each([3, 1])(
  'illustration research spends the chat call budget current at run time: %i calls',
  async (maxCalls) => {
    const store = databases.create();
    const description = 'Unrelated archive material. '.repeat(1200) + '\nMira has a silver braid.';
    const bot = store.product.content(fixtureBotInput('Budget Mira', description)) as Content;
    let chat = createFixtureChat(store, 'Budget scene', { botId: bot.id });
    const source = completedSource(store, chat.id, 'Mira raises the lantern beside the river.');
    chat = store.chat(chat.id);
    store.settings(chat.id, chat.settingsRevision, { ...chat.settings, maxCalls });
    const bodies: Record<string, any>[] = [];
    const provider = await loopbackProvider(async (captured, response) => {
      const body = JSON.parse(captured.body);
      bodies.push(body);
      await writeSse(response, [
        {
          type: 'tool_delta',
          index: 0,
          id: `search-${bodies.length}`,
          name: 'illustration.sources.search',
          argumentsDelta: JSON.stringify({ query: 'braid' }),
        },
        { type: 'opaque_state', state: `budget-${bodies.length}` },
        { type: 'done', reason: 'tool_calls' },
      ]);
    });
    cleanups.push(provider.close);
    const connection = store.product.connection({
      title: 'Budget fixture',
      protocol: 'fixture-sse-v1',
      endpoint: provider.endpoint,
      enabled: true,
    }) as Connection;
    const model = store.product.model({
      title: 'Budget model',
      connectionId: connection.id,
      modelId: 'fixture-budget',
      maxOutputTokens: 512,
      temperature: null,
      inputTokenLimit: 32768,
    }) as ModelPreset;
    const imageModel = codexModel(store);
    const plan = reserveIllustrationPlan(store, source, 'manual', {
      maxTargets: 1,
      settings: fixtureSettings({
        generator: undefined,
        maxAutoRetries: 0,
        codex: { model: { id: imageModel.id }, promptModel: { id: model.id } },
      }),
    });
    const result = await runIllustrationJob(store, plan.id, 'worker', hooks(store).options);
    expect(bodies).toHaveLength(maxCalls);
    if (maxCalls === 1) {
      expect(bodies[0].stable.tools).toEqual([]);
      expect(result).toMatchObject({
        status: 'failed',
        code: 'ILLUSTRATION_PROMPT_CALL_BUDGET_EXHAUSTED',
      });
      return;
    }
    expect(bodies.map((body) => body.stable.tools.length)).toEqual([2, 2, 2]);
    expect(bodies.map((body) => body.continuationInput !== undefined)).toEqual([
      false,
      false,
      true,
    ]);
    expect(result).toMatchObject({
      status: 'failed',
      code: 'ILLUSTRATION_PROMPT_CALL_BUDGET_EXHAUSTED',
    });
    store.settings(chat.id, store.chat(chat.id).settingsRevision, {
      ...store.chat(chat.id).settings,
      maxCalls: 4,
    });
    bodies.length = 0;
    retryIllustration(store, plan.id);
    await runIllustrationJob(store, plan.id, 'worker', hooks(store).options);
    expect(bodies).toHaveLength(4);
  }
);

test('a safe Codex retry reuses only its identical successful JEV check', async () => {
  const store = databases.create();
  const { source } = chatWithSource(store);
  const model = codexModel(store);
  const job = withPreparedPrompt(
    store,
    reserveIllustration(store, source, 'manual', {
      settings: fixtureSettings({
        generator: undefined,
        maxAutoRetries: 1,
        codex: { model: { id: model.id }, promptModel: { id: model.id } },
      }),
    })
  );
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      model: 'jev-latest',
      answers: { explicitSexualContent: { type: 'noul', noul: 0.1 } },
      usage: { input_tokens: 20, output_tokens: 1 },
    })
  );
  let renders = 0;
  const observed = hooks(store, {
    resolveJevCredential: () => 'synthetic',
    generateCodexImage: async () => ({
      status: ++renders === 1 ? 'error' : 'completed',
      images: renders === 1 ? [] : [{ mime: 'image/png', bytes: PNG }],
      error: renders === 1 ? { code: 'CODEX_IMAGE_NOT_GENERATED' } : null,
      revisedPrompt: null,
      text: '{"caption":"등불"}',
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        raw: null,
        priceRevision: null,
      },
    }),
  });
  expect((await runIllustrationJob(store, job.id, 'worker', observed.options))?.status).toBe(
    'requeued'
  );
  expect((await runIllustrationJob(store, job.id, 'worker', observed.options))?.status).toBe(
    'completed'
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(renders).toBe(2);
});

test.each(['complete', 'context-limit', 'budget'] as const)(
  'illustration research uses frozen native sources over bounded read-only rounds: %s',
  async (mode) => {
    const store = databases.create();
    const description =
      'Unrelated archive material. '.repeat(1200) + '\nMira has emerald eyes and a silver braid.';
    const bot = store.product.content(fixtureBotInput('Frozen Mira', description)) as Content;
    const chat = createFixtureChat(store, 'Research scene', { botId: bot.id });
    const source = completedSource(store, chat.id, 'Mira raises the lantern beside the river.');
    let readPath = '';
    let handlerError: unknown;
    const provider = await loopbackProvider(async (captured, response) => {
      try {
        const body = JSON.parse(captured.body);
        const results = body.input.results ?? [];
        const round = results.length;
        expect(body.stable.tools.map((tool: { name: string }) => tool.name)).toEqual([
          'illustration.sources.search',
          'illustration.sources.read',
        ]);
        expect(captured.body).not.toContain('LIVE REPLACEMENT');
        if (!round) expect(captured.body.length).toBeLessThan(description.length / 2);
        else {
          expect(body.opaqueState).toBe(`research-${round - 1}`);
          expect(results.at(-1).denied, JSON.stringify(results.at(-1))).toBe(false);
        }
        if (round === 1) {
          const match = results[0].result.matches.find((item: { path: string }) =>
            item.path.includes('description')
          );
          expect(match.excerpt).toContain('emerald eyes');
          readPath = match.path;
        }
        if (mode === 'complete' && round === 2) {
          expect(JSON.stringify(results)).toContain('emerald eyes');
          const anchor = body.input.source.blocks[0][0];
          await writeSse(response, [
            {
              type: 'text_delta',
              delta: JSON.stringify({
                heroIndex: 0,
                targets: [
                  {
                    startAnchor: anchor,
                    endAnchor: anchor,
                    focus: 'Mira raises the lantern',
                    visualBrief: 'Emerald eyes and a silver braid',
                    prompt: {
                      prompt: 'Mira with emerald eyes and a silver braid raises a lantern.',
                      caption: 'Mira',
                    },
                  },
                ],
              }),
            },
            { type: 'done', reason: 'stop' },
          ]);
          return;
        }
        await writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: `read-${round}`,
            name: round ? 'illustration.sources.read' : 'illustration.sources.search',
            argumentsDelta: JSON.stringify(
              round
                ? {
                    id: 'resource:0',
                    path: readPath,
                    textOffset: mode === 'context-limit' ? 0 : description.length - 45,
                    textLimit: mode === 'context-limit' ? 10000 : 100,
                  }
                : { query: 'emerald eyes' }
            ),
          },
          { type: 'opaque_state', state: `research-${round}` },
          { type: 'done', reason: 'tool_calls' },
        ]);
      } catch (error) {
        handlerError = error;
        throw error;
      }
    });
    cleanups.push(provider.close);
    const connection = store.product.connection({
      title: 'Research fixture',
      protocol: 'fixture-sse-v1',
      endpoint: provider.endpoint,
      enabled: true,
    }) as Connection;
    const model = store.product.model({
      title: 'Research model',
      connectionId: connection.id,
      modelId: 'fixture-research',
      maxOutputTokens: 512,
      temperature: null,
      inputTokenLimit: mode === 'context-limit' ? 8192 : 32768,
    }) as ModelPreset;
    const imageModel = codexModel(store);
    const plan = reserveIllustrationPlan(store, source, 'manual', {
      maxTargets: 1,
      settings: fixtureSettings({
        generator: undefined,
        maxAutoRetries: 0,
        codex: { model: { id: imageModel.id }, promptModel: { id: model.id } },
      }),
    });
    store.product.content(
      {
        ...fixtureBotInput(bot.title, 'LIVE REPLACEMENT: Mira has brown eyes.'),
        expectedRevision: bot.revision,
      },
      bot.id
    );
    if (mode === 'complete') {
      cancelIllustration(store, plan.id);
      retryIllustration(store, plan.id);
    }
    const observed = hooks(store);
    const result = await runIllustrationJob(store, plan.id, 'worker', observed.options);
    if (handlerError) throw handlerError;
    const recorded = store.db
      .prepare(
        'SELECT data FROM execution_tool_diagnostics WHERE illustration_job_id=? ORDER BY seq'
      )
      .all(plan.id)
      .map((row) => JSON.parse(String(row.data)));
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0]).toMatchObject({
      name: 'illustration.sources.search',
      state: 'finished',
      elapsedMs: expect.any(Number),
    });
    expect(JSON.stringify(recorded)).not.toContain(description);
    if (mode === 'complete') {
      expect(result, JSON.stringify(observed.finishes)).toMatchObject({ status: 'completed' });
      expect(provider.requests).toHaveLength(3);
      expect(recorded).toHaveLength(2);
      expect(
        illustrationJob(store, queuedIllustrations(store)[0]).input.target?.prompt?.prompt
      ).toContain('emerald eyes');
    } else if (mode === 'budget') {
      expect(result).toMatchObject({
        status: 'failed',
        code: 'ILLUSTRATION_PROMPT_CALL_BUDGET_EXHAUSTED',
      });
      expect(provider.requests).toHaveLength(store.chat(chat.id).settings.maxCalls);
      expect(recorded).toHaveLength(store.chat(chat.id).settings.maxCalls - 1);
      expect(queuedIllustrations(store)).toEqual([]);
    } else {
      expect(result).toMatchObject({
        status: 'failed',
        code: 'ILLUSTRATION_PROMPT_INPUT_CONTEXT_LIMIT_EXCEEDED',
      });
      expect(provider.requests.length).toBeGreaterThan(1);
      expect(provider.requests.length).toBeLessThan(13);
      expect(queuedIllustrations(store)).toEqual([]);
    }
  }
);
