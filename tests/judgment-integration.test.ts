import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { AssetEntry } from '../core/auxiliary.js';
import type { JudgmentTarget } from '../core/judgment.js';
import { sourceHash } from '../core/source-history.js';
import type { Json, WireRecord } from '../core/transport.js';
import { judgeImagePlacement, validateImageJudgmentWire } from '../server/image-judgment.js';
import { validateTranslationJudgmentWire } from '../server/jev-attribution.js';
import { prepareJevImage } from '../server/jev-images.js';
import type { JudgmentHooks } from '../server/judgment.js';
import { assertJudgmentRuntimeWire } from '../server/judgment-runtime.js';
import {
  judgeMainRefusal,
  mainJudgmentInput,
  validateMainJudgmentWire,
} from '../server/main-judgment.js';
import { judgeTranslationRefusal } from '../server/translation-judgment.js';

const targets: (JudgmentTarget & { protocol: WireRecord['protocol'] })[] = [
  {
    provider: 'openai',
    connectionId: 'openai',
    modelId: 'gpt-6-luna',
    endpoint: 'https://api.openai.com/v1/decisions',
    protocol: 'openai-decisions-v1',
  },
  {
    provider: 'gemini',
    connectionId: 'gemini',
    modelId: 'gemini-decision-1',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/decisions',
    protocol: 'gemini-decisions-v1',
  },
  {
    provider: 'openai-compatible',
    connectionId: 'gateway',
    modelId: 'typesafe-ai/jev',
    endpoint: 'https://ai-gateway.vercel.sh/v1/decisions',
    protocol: 'openai-compatible-decisions-v1',
  },
  {
    provider: 'typesafe-compatible',
    connectionId: 'system-one',
    modelId: 'jev-1.13',
    endpoint: 'https://openrouter.ai/api/v1/systemone',
    protocol: 'typesafe-compatible-systemone-v1',
  },
];

type Target = (typeof targets)[number];
const isOpenAI = (target: Target) =>
  target.provider === 'openai' || target.provider === 'openai-compatible';
const digest = (body: Json) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

function capture(target: Target, handle: (body: Record<string, Json>) => Response) {
  const { protocol: _protocol, ...identity } = target;
  const wires: WireRecord[] = [];
  const finish = vi.fn<JudgmentHooks['onAttemptFinish']>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(url).toBe(target.endpoint);
    const headers = new Headers(init?.headers);
    expect(headers.get(target.provider === 'gemini' ? 'x-goog-api-key' : 'authorization')).toBe(
      target.provider === 'gemini' ? 'mock-key' : 'Bearer mock-key'
    );
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(target.modelId);
    return handle(body);
  });
  return {
    wires,
    fetch,
    finish,
    hooks: {
      target: identity,
      signal: new AbortController().signal,
      credential: () => 'mock-key',
      fetch,
      onAttemptStart: (wire) => {
        assertJudgmentRuntimeWire(wire, { target: identity });
        wires.push(JSON.parse(JSON.stringify(wire)));
        return String(wires.length);
      },
      onAttemptFinish: finish,
    } satisfies JudgmentHooks,
  };
}

function binaryResponse(target: Target, probability: number) {
  if (isOpenAI(target))
    return Response.json({
      model: target.modelId,
      answers: [{ type: 'predicate', name: 'explicitRefusal', probability }],
      usage: { input_tokens: 46, output_tokens: 0, total_tokens: 46 },
    });
  if (target.provider === 'gemini')
    return Response.json({
      answers: { explicitRefusal: { type: 'noul', noul: probability, confidence: 0.98 } },
      usage: { total_input_tokens: 46, total_output_tokens: 0, total_tokens: 46 },
    });
  return Response.json({
    model: target.modelId,
    answers: { explicitRefusal: { type: 'noul', noul: probability } },
    usage: { input_tokens: 46, output_tokens: 0 },
  });
}

function withBody(wire: WireRecord, body: Json): WireRecord {
  return { ...wire, body, bodySha256: digest(body) };
}

const scene = 'Mira finds the silver boat at the pier.';
const sceneSource = { id: 'source', chatId: 'chat', text: scene, hash: sourceHash(scene) };
const catalog: AssetEntry[] = [
  {
    ref: 'pier',
    revision: 2,
    hash: 'a'.repeat(64),
    url: '/api/assets/pier',
    alt: 'Mira at the pier',
    caption: 'Mira steps into a silver boat.',
    actorId: 'Mira',
    clothing: null,
    location: 'pier',
    uses: ['inline'],
  },
  {
    ref: 'city',
    revision: 1,
    hash: 'b'.repeat(64),
    url: '/api/assets/city',
    alt: 'Empty city',
    caption: 'Deserted city in winter.',
    actorId: null,
    clothing: null,
    location: 'city',
    uses: ['inline'],
  },
];

function imageResponse(target: Target) {
  const probabilities = { none: 0.01, asset_0: 0.98, asset_1: 0.01 };
  const answer = { type: 'choice', choice: 'asset_0', confidence: 0.98 };
  return isOpenAI(target)
    ? Response.json({
        model: target.modelId,
        answers: [
          {
            name: 'block_0',
            ...answer,
            probabilities: Object.entries(probabilities).map(([value, probability]) => ({
              value,
              probability,
            })),
          },
        ],
        usage: { input_tokens: 900, output_tokens: 0, total_tokens: 900 },
      })
    : Response.json({
        ...(target.provider !== 'gemini' && { model: target.modelId }),
        answers: { block_0: { ...answer, probabilities } },
        usage:
          target.provider === 'gemini'
            ? { total_input_tokens: 900, total_output_tokens: 0, total_tokens: 900 }
            : { input_tokens: 900, output_tokens: 0 },
      });
}

describe.each(targets)('$provider judgment attribution', (target) => {
  it('retains exact main and translation wire receipts after another provider is selected', async () => {
    const candidate = 'I cannot fulfill that request.';
    const originalHash = sourceHash('Original passage');
    const policy = { threshold: 0.8 };
    const main = mainJudgmentInput(candidate, policy.threshold);
    const first = capture(target, (body) => {
      const context =
        target.provider === 'typesafe-compatible' ? body.state : JSON.parse(String(body.input));
      expect(context).toEqual({ response: candidate });
      return binaryResponse(target, 0.98);
    });

    await expect(judgeMainRefusal(main, first.hooks)).resolves.toMatchObject({
      verdict: 'refused',
      usage: { inputTokens: 46, outputTokens: 0 },
    });
    await expect(
      judgeTranslationRefusal(candidate, originalHash, policy, first.hooks)
    ).resolves.toMatchObject({ verdict: 'refused' });
    expect(first.fetch).toHaveBeenCalledTimes(2);
    expect(first.finish).toHaveBeenCalledTimes(2);
    const [mainWire, translationWire] = first.wires;
    expect(mainWire.protocol).toBe(target.protocol);
    expect(translationWire.url).toBe(target.endpoint);
    expect(mainWire.headers).not.toHaveProperty('authorization');
    expect(translationWire.headers).not.toHaveProperty('x-goog-api-key');

    const replacement = targets.find((option) => option.provider !== target.provider)!;
    const later = capture(replacement, () => binaryResponse(replacement, 0.02));
    await expect(judgeMainRefusal(main, later.hooks)).resolves.toMatchObject({
      verdict: 'accepted',
    });
    expect(later.wires[0].protocol).toBe(replacement.protocol);

    expect(() => validateMainJudgmentWire(main, mainWire)).not.toThrow();
    expect(() =>
      validateTranslationJudgmentWire(originalHash, policy, translationWire, candidate)
    ).not.toThrow();
    expect(() => validateMainJudgmentWire(main, { ...mainWire, modelId: 'other-model' })).toThrow(
      'MAIN_JUDGMENT_ATTEMPT_MISMATCH'
    );
    expect(() =>
      assertJudgmentRuntimeWire(
        { ...mainWire, url: 'https://elsewhere.test/v1/decisions' },
        first.hooks
      )
    ).toThrow('JUDGMENT_ATTEMPT_MISMATCH');
    const translated = { ...(translationWire.body as Record<string, Json>) };
    if (target.provider === 'typesafe-compatible')
      translated.state = { response: 'Altered response' };
    else translated.input = '{"response":"Altered response"}';
    expect(() =>
      validateTranslationJudgmentWire(
        originalHash,
        policy,
        withBody(translationWire, translated),
        candidate
      )
    ).toThrow('TRANSLATION_JUDGMENT_ATTEMPT_MISMATCH');
  });

  it('maps attached images to their asset references and verifies the chosen placement receipt', async () => {
    const pixels = await Promise.all(
      ['#aa0000', '#0000aa'].map((background) =>
        sharp({ create: { width: 16, height: 16, channels: 3, background } })
          .png()
          .toBuffer()
      )
    );
    const images = await Promise.all(pixels.map(prepareJevImage));
    const byName = new Map(catalog.map((asset, index) => [asset.alt, images[index].data_base64]));
    type SceneState = { assets: { name: string; image: string }[] };
    const attempt = capture(target, (body) => {
      if (target.provider === 'typesafe-compatible') {
        const state = body.state as SceneState;
        const attachments = body.assets as Record<string, { data_base64: string }>;
        expect(state.assets).toHaveLength(2);
        expect(Object.keys(attachments)).toEqual(state.assets.map(({ image }) => image));
        for (const { image, name } of state.assets)
          expect(attachments[image].data_base64).toBe(byName.get(name));
      } else {
        const parts = (
          isOpenAI(target) ? (body.input as { content: Json[] }[])[0].content : body.input
        ) as Record<string, Json>[];
        const state = JSON.parse(String(parts[0].text)) as SceneState;
        expect(state.assets).toHaveLength(2);
        expect(parts).toHaveLength(5);
        for (const [index, { image, name }] of state.assets.entries()) {
          expect(parts[1 + index * 2].text).toBe(`\nImage reference: ${image}`);
          expect(parts[2 + index * 2]).toMatchObject(
            isOpenAI(target)
              ? {
                  type: 'input_image',
                  image_url: `data:image/jpeg;base64,${byName.get(name)}`,
                }
              : { type: 'image', mime_type: 'image/jpeg', data: byName.get(name) }
          );
        }
      }
      return imageResponse(target);
    });
    const result = await judgeImagePlacement(sceneSource, catalog, '', {
      ...attempt.hooks,
      settings: { images: true, longContext: false },
      readImage: (hash) => pixels[catalog.findIndex((asset) => asset.hash === hash)],
    });
    expect(attempt.fetch).toHaveBeenCalledTimes(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      assetRef: 'pier',
      assetRevision: 2,
      assetHash: catalog[0].hash,
    });
    const [wire] = attempt.wires;
    expect(() => validateImageJudgmentWire(sceneSource, catalog, wire)).not.toThrow();
    expect(() =>
      validateImageJudgmentWire(sceneSource, [{ ...catalog[0], revision: 3 }, catalog[1]], wire)
    ).toThrow('IMAGE_JUDGMENT_ATTEMPT_MISMATCH');
  });
});
