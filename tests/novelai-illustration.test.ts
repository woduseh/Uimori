import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Connection, ModelPreset } from '../core/product.js';
import {
  defaultIllustrationSettings,
  IllustrationError,
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
const prompt = { prompt: '1girl, lantern, river at night', negativePrompt: 'blurry' };
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

  test('reports the subscription tier for the connection check', async () => {
    const sent = novelAI(() => Response.json({ tier: 3, active: true, perks: {} }));
    expect(await novelAISubscription(options())).toEqual({ tier: 'Opus', active: true });
    expect(sent[0].url).toBe(`${NOVELAI_ORIGIN}/user/subscription`);
  });
});

describe('NovelAI illustration settings and jobs', () => {
  async function promptModel(store: Store) {
    const provider = await loopbackProvider(async (_request, response) => {
      await writeSse(response, [
        { type: 'text_delta', delta: JSON.stringify({ ...prompt, caption: '강 위의 등불' }) },
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

  test('freezes no automatic retries, reports an uncertain result and reuses the prompt on a manual retry', async () => {
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
    expect(projectIllustration(store, illustrationJob(store, job.id)).images).toMatchObject([
      { mime: 'image/webp', caption: '강 위의 등불', prompt: prompt.prompt },
    ]);
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
