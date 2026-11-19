import { afterEach, describe, expect, test, vi } from 'vitest';
import sharp from 'sharp';
import type { Connection, ModelPreset } from '../core/product.js';
import {
  defaultIllustrationSettings,
  IllustrationError,
  parseIllustrationPlan,
  type IllustrationSettings,
} from '../core/illustration.js';
import {
  illustrationPresetFile,
  parseIllustrationPresetFile,
  emptyIllustrationPreset,
} from '../core/illustration-presets.js';
import {
  generateWithNovelAI,
  novelAISubscription,
  NOVELAI_ORIGIN,
} from '../server/novelai-client.js';
import { runIllustrationJob } from '../server/illustration-runner.js';
import {
  illustrationJob,
  illustrationSettingsView,
  NOVELAI_CREDENTIAL_ID,
  projectIllustration,
  retryIllustration,
  updateIllustrationReferences,
  updateIllustrationSettings,
} from '../server/illustrations.js';
import { CredentialStore } from '../server/credentials.js';
import { writeRisuZip } from '../server/risu-export-codec.js';
import type { Store } from '../server/store.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import {
  chatWithSource,
  fixtureIllustrationPreset,
  fixtureSettings,
  illustrationDatabases,
  PNG_BASE64,
  reserveIllustration,
} from './fixtures/illustration.js';

const databases = illustrationDatabases('uimori-novelai-');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  databases.cleanup();
});
const PNG = Buffer.from(PNG_BASE64, 'base64');
const render = defaultIllustrationSettings().novelai;
const prompt = { prompt: '2girls, pier, river at night', negativePrompt: 'blurry' };
const characters = [
  {
    prompt: 'girl, mira, red coat, source#hug',
    negativePrompt: 'blue hair',
    position: { x: 0.33, y: 0.5 },
  },
  {
    prompt: 'girl, ara, blue hair, target#hug',
    negativePrompt: 'red coat',
    position: { x: 0.68, y: 0.5 },
  },
];
type Sent = { url: string; headers: Record<string, string>; body: any };

/** Intercepts NovelAI only; loopback prompt-model traffic keeps the real fetch. */
function novelAI(respond: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(NOVELAI_ORIGIN)) return original(input, init);
    const request: Sent = {
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(request);
    return respond(request);
  });
  return sent;
}
const zip = () =>
  new Response(new Uint8Array(writeRisuZip(new Map([['image_0.png', PNG]]))), {
    status: 200,
    headers: { 'content-type': 'application/zip' },
  });
async function failure(promise: Promise<unknown>): Promise<IllustrationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IllustrationError) return error;
    throw error;
  }
  throw new Error('Expected an IllustrationError');
}
const options = () => ({
  signal: new AbortController().signal,
  token: () => 'pst-synthetic',
});

describe('NovelAI image client', () => {
  test('posts the documented V4 caption body with the Bearer token and reads the zipped image', async () => {
    const sent = novelAI(() => zip());
    const result = await generateWithNovelAI(render, prompt, options());
    expect(result.images).toEqual([{ mime: 'image/png', bytes: PNG }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${NOVELAI_ORIGIN}/ai/generate-image`);
    expect(sent[0].headers.authorization).toBe('Bearer pst-synthetic');
    expect(sent[0].body).toMatchObject({
      input: prompt.prompt,
      model: 'nai-diffusion-5-full',
      action: 'generate',
      parameters: {
        width: 832,
        height: 1216,
        steps: 23,
        n_samples: 1,
        seed: result.seed,
        v4_prompt: { caption: { base_caption: prompt.prompt, char_captions: [] } },
        v4_negative_prompt: { caption: { base_caption: 'blurry', char_captions: [] } },
      },
    });
  });

  test.each([
    [401, 'NOVELAI_UNAUTHORIZED'],
    [402, 'NOVELAI_ANLAS_INSUFFICIENT'],
    [429, 'NOVELAI_BUSY'],
    [400, 'NOVELAI_REQUEST_REJECTED'],
    [503, 'NOVELAI_RESULT_UNCERTAIN'],
  ])('maps HTTP %i to %s and keeps the bounded provider message', async (status, code) => {
    novelAI(() => Response.json({ statusCode: status, message: 'synthetic reason' }, { status }));
    const error = await failure(generateWithNovelAI(render, prompt, options()));
    expect(error).toMatchObject({ code, retryable: false });
    expect(error.diagnostic.novelai).toEqual({ httpStatus: status, message: 'synthetic reason' });
  });

  test('separates a refused connection from a lost request and never sends without a token', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    novelAI(() => {
      throw refused;
    });
    expect((await failure(generateWithNovelAI(render, prompt, options()))).code).toBe(
      'NOVELAI_UNREACHABLE'
    );
    vi.restoreAllMocks();
    novelAI(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    expect((await failure(generateWithNovelAI(render, prompt, options()))).code).toBe(
      'NOVELAI_RESULT_UNCERTAIN'
    );
    vi.restoreAllMocks();
    const sent = novelAI(() => zip());
    const missing = { signal: new AbortController().signal, token: () => undefined };
    expect((await failure(generateWithNovelAI(render, prompt, missing))).code).toBe(
      'NOVELAI_TOKEN_MISSING'
    );
    expect(sent).toHaveLength(0);
  });

  test('sends character boxes with coordinates snapped to the model grid', async () => {
    const sent = novelAI(() => zip());
    await generateWithNovelAI(render, { ...prompt, characters }, options());
    expect(sent[0].body.parameters.v4_prompt).toEqual({
      caption: {
        base_caption: prompt.prompt,
        char_captions: [
          { char_caption: characters[0].prompt, centers: [{ x: 0.33, y: 0.5 }] },
          { char_caption: characters[1].prompt, centers: [{ x: 0.68, y: 0.5 }] },
        ],
      },
      use_coords: true,
      use_order: true,
    });
    expect(sent[0].body.parameters.v4_negative_prompt.caption.char_captions).toEqual([
      { char_caption: 'blue hair', centers: [{ x: 0.33, y: 0.5 }] },
      { char_caption: 'red coat', centers: [{ x: 0.68, y: 0.5 }] },
    ]);
    await generateWithNovelAI(
      { ...render, model: 'nai-diffusion-4-5-full' },
      { ...prompt, characters },
      options()
    );
    expect(
      sent[1].body.parameters.v4_prompt.caption.char_captions.map(
        (caption: { centers: unknown[] }) => caption.centers[0]
      )
    ).toEqual([
      { x: 0.3, y: 0.5 },
      { x: 0.7, y: 0.5 },
    ]);
    await generateWithNovelAI(
      render,
      { ...prompt, characters: characters.map(({ position: _position, ...rest }) => rest) },
      options()
    );
    expect(sent[2].body.parameters.v4_prompt.use_coords).toBe(false);
  });

  test('parses NovelAI character boxes only for NovelAI, capped at six with all-or-none positions', () => {
    const reply = JSON.stringify({
      ...prompt,
      caption: 'c',
      characters: [
        ...Array.from({ length: 7 }, (_, index) => ({
          prompt: `girl, extra ${index}`,
          position: { x: 2, y: 0.5 },
        })),
      ],
    });
    const plan = parseIllustrationPlan(reply, false, { novelai: true });
    expect(plan.kind === 'generate' && plan.prompt.characters).toHaveLength(6);
    expect(plan.kind === 'generate' && plan.prompt.characters?.[0]).toEqual({
      prompt: 'girl, extra 0',
      negativePrompt: '',
      position: { x: 0.9, y: 0.5 },
    });
    const partial = JSON.stringify({
      ...prompt,
      characters: [{ prompt: 'girl', position: { x: 0.2, y: 0.5 } }, { prompt: 'boy' }],
    });
    const mixed = parseIllustrationPlan(partial, false, { novelai: true });
    expect(mixed.kind === 'generate' && mixed.prompt.characters).toEqual([
      { prompt: 'girl', negativePrompt: '' },
      { prompt: 'boy', negativePrompt: '' },
    ]);
    expect(parseIllustrationPlan(partial, false)).toMatchObject({
      prompt: { prompt: prompt.prompt },
    });
    expect((parseIllustrationPlan(partial, false) as { prompt: object }).prompt).not.toHaveProperty(
      'characters'
    );
    expect(() =>
      parseIllustrationPlan(JSON.stringify({ ...prompt, characters: [{}] }), false, {
        novelai: true,
      })
    ).toThrow('ILLUSTRATION_PROMPT_INVALID');
  });

  test('reports tier, Anlas balances and the V5 usage bar for the connection check', async () => {
    const sent = novelAI(() =>
      Response.json({
        tier: 3,
        active: true,
        perks: {},
        trainingStepsLeft: { fixedTrainingStepsLeft: 9500, purchasedTrainingSteps: 120 },
        usage: { isNegative: false, percent: 82, purchasedPercent: 0, timeUntilNextPercent: 300 },
      })
    );
    expect(await novelAISubscription(options())).toEqual({
      tier: 'Opus',
      active: true,
      anlas: { subscription: 9500, purchased: 120 },
      usage: { percent: 82, secondsUntilNextPercent: 300 },
    });
    expect(sent[0].url).toBe(`${NOVELAI_ORIGIN}/user/subscription`);
  });
});

describe('NovelAI illustration settings and jobs', () => {
  async function promptModel(store: Store, extra: Record<string, unknown> = {}) {
    const provider = await loopbackProvider(async (_request, response) => {
      await writeSse(response, [
        {
          type: 'text_delta',
          delta: JSON.stringify({ ...prompt, characters, caption: '강 위의 등불', ...extra }),
        },
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
  const novelAISettings = (promptModelId: string): IllustrationSettings => ({
    ...fixtureSettings({ maxAutoRetries: 5 }),
    generator: undefined,
    novelai: { ...render, promptModel: { id: promptModelId } },
  });

  test('stores the token only in the credential table; omission keeps it and null removes it', () => {
    const store = databases.create();
    // A GET response, including its read-only token flag, can be saved back unchanged.
    const save = (extra: Record<string, unknown>) => {
      const { revision, ...view } = illustrationSettingsView(store);
      return updateIllustrationSettings(store, { ...view, expectedRevision: revision, ...extra });
    };
    save({ novelaiToken: 'pst-saved' });
    const stored = store.db.prepare('SELECT body FROM illustration_settings').get() as {
      body: string;
    };
    expect(stored.body).not.toContain('pst-saved');
    expect(illustrationSettingsView(store).novelaiTokenConfigured).toBe(true);
    save({});
    expect(new CredentialStore(store.db).get(NOVELAI_CREDENTIAL_ID)).toBe('pst-saved');
    save({ novelaiToken: null });
    expect(illustrationSettingsView(store).novelaiTokenConfigured).toBe(false);
  });

  test('freezes no automatic retries, keeps the shared canon out of the scene prompt and reuses the prompt on a manual retry', async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    const { provider, model } = await promptModel(store);
    fixtureIllustrationPreset(store, {
      generator: 'novelai',
      novelai: { negativeGuidance: 'watermark' },
    });
    const settings = novelAISettings(model.id);
    expect(() => reserveIllustration(store, source, 'manual', { settings })).toThrow(
      'NOVELAI_TOKEN_MISSING'
    );
    new CredentialStore(store.db).set(NOVELAI_CREDENTIAL_ID, 'pst-saved');
    const job = reserveIllustration(store, source, 'manual', { settings });
    expect(job.input).toMatchObject({
      generator: 'novelai',
      maxAutoRetries: 0,
      novelai: { model: 'nai-diffusion-5-full', negativeGuidance: 'watermark' },
    });
    expect(JSON.stringify(job.input)).not.toContain('pst-saved');
    store.db
      .prepare('UPDATE illustration_jobs SET input=? WHERE id=?')
      .run(
        JSON.stringify({ ...job.input, visualCanon: [{ name: 'Mira', appearance: 'red coat' }] }),
        job.id
      );

    let fail = true;
    const sent = novelAI(() => (fail ? new Response('', { status: 502 }) : zip()));
    const hooks = {
      signal: new AbortController().signal,
      authorize: (connection: Connection) => store.product.authorize(connection),
      onAttemptStart: () => 'attempt',
      onAttemptFinish: () => undefined,
      resolveNovelAIToken: () => new CredentialStore(store.db).get(NOVELAI_CREDENTIAL_ID),
    };
    expect(await runIllustrationJob(store, job.id, 'worker', hooks)).toMatchObject({
      status: 'failed',
      code: 'NOVELAI_RESULT_UNCERTAIN',
    });
    retryIllustration(store, job.id);
    fail = false;
    expect(await runIllustrationJob(store, job.id, 'worker', hooks)).toMatchObject({
      status: 'completed',
      images: 1,
    });
    expect(provider.requests).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[1].headers.authorization).toBe('Bearer pst-saved');
    expect(sent[1].body.parameters.v4_negative_prompt.caption.base_caption).toBe('blurry');
    expect(sent[1].body.input).toBe(prompt.prompt);
    expect(sent[1].body.parameters.v4_prompt.caption.char_captions).toHaveLength(2);
    expect(illustrationJob(store, job.id).diagnostic?.prompt?.characters).toEqual(characters);
    expect(projectIllustration(store, illustrationJob(store, job.id)).images).toMatchObject([
      { mime: 'image/webp', caption: '강 위의 등불', prompt: prompt.prompt },
    ]);
  });

  test('sends only the character references the prompt model chose, on V4.5 models only', async () => {
    const store = databases.create();
    const { chat, source } = chatWithSource(store);
    const asset = (title: string) =>
      (
        store.product.createAsset(chat.id, {
          title,
          mime: 'image/png',
          base64: PNG_BASE64,
          description: '',
          actor: title,
          outfit: '',
          location: '',
          allowedUse: 'both',
        }) as { id: string }
      ).id;
    const [mira, sol] = [asset('Mira design'), asset('Sol design')];
    updateIllustrationReferences(store, chat.id, {
      expectedRevision: 0,
      references: [
        { ref: mira, role: 'character' },
        { ref: sol, role: 'character' },
      ],
      characterProfiles: [],
    });
    const { provider, model } = await promptModel(store, { references: [2, 9] });
    fixtureIllustrationPreset(store, { generator: 'novelai' });
    new CredentialStore(store.db).set(NOVELAI_CREDENTIAL_ID, 'pst-saved');
    const reserve = (novelaiModel: string) =>
      reserveIllustration(store, source, 'manual', {
        settings: {
          ...novelAISettings(model.id),
          novelai: {
            ...render,
            model: novelaiModel,
            characterReference: true,
            promptModel: { id: model.id },
          },
        },
      });
    expect(reserve('nai-diffusion-5-full').input.novelai?.references).toBeUndefined();
    store.db.prepare("UPDATE illustration_jobs SET status='cancelled'").run();
    const job = reserve('nai-diffusion-4-5-full');
    expect(job.input.novelai?.references).toHaveLength(2);
    const sent = novelAI(() => zip());
    expect(
      await runIllustrationJob(store, job.id, 'worker', {
        signal: new AbortController().signal,
        authorize: (connection: Connection) => store.product.authorize(connection),
        onAttemptStart: () => 'attempt',
        onAttemptFinish: () => undefined,
        resolveNovelAIToken: () => 'pst-saved',
      })
    ).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(provider.requests[0])).toContain('attachedReferences');
    const parameters = sent[0].body.parameters;
    expect(parameters.director_reference_images).toHaveLength(1);
    expect(parameters.director_reference_descriptions).toEqual([
      { caption: { base_caption: 'character', char_captions: [] }, legacy_uc: false },
    ]);
    const image = await sharp(
      Buffer.from(parameters.director_reference_images[0], 'base64')
    ).metadata();
    expect([image.format, image.width, image.height]).toEqual(['png', 1472, 1472]);
    expect(illustrationJob(store, job.id).diagnostic?.novelai).toMatchObject({ references: 1 });
  });

  test('preset files keep NovelAI negative guidance and older files default it to empty', () => {
    const file = illustrationPresetFile({
      ...emptyIllustrationPreset('NAI'),
      generator: 'novelai',
      novelai: { negativeGuidance: 'lowres' },
    });
    expect(parseIllustrationPresetFile(JSON.parse(JSON.stringify(file)))).toMatchObject({
      generator: 'novelai',
      novelai: { negativeGuidance: 'lowres' },
    });
    const { novelai: _novelai, ...older } = file.preset;
    expect(parseIllustrationPresetFile({ ...file, preset: older }).novelai).toEqual({
      negativeGuidance: '',
    });
  });
});
