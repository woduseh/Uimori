import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AssetEntry } from '../core/auxiliary.js';
import type { WireRecord } from '../core/transport.js';
import {
  imageJudgmentRequest,
  judgeImagePlacement,
  validateImageJudgmentWire,
  IMAGE_JUDGMENT_LIMITS,
} from '../server/image-judgment.js';
import { estimateContextTokens } from '../core/context-budget.js';
import { countTextTokens } from '../core/text-tokens.js';
import { JEV_MODEL } from '../server/jev-judgment.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import { bundle, bridge, hooks } from './fixtures/translation-job.js';
const text = 'Mira waits near the pier.\n\nThe harbor fills with morning light.';
const source = {
  id: 'source',
  chatId: 'chat-a',
  text,
  hash: createHash('sha256').update(text).digest('hex'),
};
const assets: AssetEntry[] = [
  {
    ref: 'mira',
    revision: 1,
    hash: 'a'.repeat(64),
    url: '/api/assets/mira',
    alt: 'Mira at pier',
    caption: 'Morning pier portrait',
    actorId: 'Mira',
    clothing: null,
    location: 'pier',
    uses: ['inline'],
  },
  {
    ref: 'mountain',
    revision: 2,
    hash: 'b'.repeat(64),
    url: '/api/assets/mountain',
    alt: 'Mountain',
    caption: 'Empty winter mountains',
    actorId: null,
    clothing: null,
    location: 'mountain',
    uses: ['inline'],
  },
];
function typedResponse(
  body: { questions: Record<string, { criteria: Record<string, unknown> }> },
  choose = 'asset_0'
) {
  return new Response(
    JSON.stringify({
      model: 'jev-latest',
      usage: { input_tokens: 120, output_tokens: 8 },
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([key, question]) => [
          key,
          {
            type: 'choice',
            choice: choose,
            confidence: 0.95,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((option) => [
                option,
                option === choose ? 0.98 : 0.02 / (Object.keys(question.criteria).length - 1),
              ])
            ),
          },
        ])
      ),
    })
  );
}
describe('JEV-only existing image placement', () => {
  it('selects existing source-bound images in one typed call and validates attribution', async () => {
    let wire: WireRecord | undefined;
    const finish = vi.fn();
    const send = vi.fn(async (_url: unknown, init?: RequestInit) =>
      typedResponse(JSON.parse(String(init?.body)))
    );
    const result = await judgeImagePlacement(
      source,
      assets,
      'Use only appropriate existing illustrations.',
      {
        signal: new AbortController().signal,
        credential: () => 'test-jev-secret',
        fetch: send,
        onAttemptStart: (value) => {
          wire = value;
          return 'attempt';
        },
        onAttemptFinish: finish,
      }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      assetRef: 'mira',
      assetRevision: 1,
      assetHash: assets[0].hash,
      presentationIntent: 'inline',
    });
    expect(wire).toMatchObject({
      role: 'image',
      protocol: 'typesafe-systemone-v1',
      judgment: { kind: 'image-selection' },
    });
    expect(JSON.stringify(wire)).not.toContain('test-jev-secret');
    expect(() => validateImageJudgmentWire(source, assets, wire!)).not.toThrow();
    expect(() =>
      validateImageJudgmentWire(
        { ...source, id: 'restored-source', chatId: 'restored-chat' },
        assets.map((asset) => ({ ...asset, ref: `restored-${asset.ref}` })),
        wire!
      )
    ).not.toThrow();
    expect(() =>
      validateImageJudgmentWire({ ...source, hash: 'c'.repeat(64) }, assets, wire!)
    ).toThrow('SOURCE_IDENTITY_INVALID');
    expect(() =>
      validateImageJudgmentWire(source, [{ ...assets[0], revision: 9 }, assets[1]], wire!)
    ).toThrow('IMAGE_JUDGMENT_ATTEMPT_MISMATCH');
    expect(finish).toHaveBeenCalledWith(
      'attempt',
      expect.objectContaining({ status: 'completed' })
    );
  });
  it('none and empty catalogs succeed without inventing images', async () => {
    const send = vi.fn(async (_url: unknown, init?: RequestInit) =>
      typedResponse(JSON.parse(String(init?.body)), 'none')
    );
    const h = {
      signal: new AbortController().signal,
      credential: () => 'key',
      fetch: send,
      onAttemptStart: () => 'attempt',
      onAttemptFinish: vi.fn(),
    };
    expect((await judgeImagePlacement(source, assets, '', h)).entries).toEqual([]);
    expect((await judgeImagePlacement(source, [], '', h)).entries).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('records network failure once without generative fallback or replay', async () => {
    const seed = bundle(source.text);
    seed.job.kind = 'image';
    seed.assets = assets;
    const observed = hooks();
    const fetch = vi.fn(async () => {
      throw new Error('provider uncertainty');
    });
    const authorize = vi.fn();
    const outcome = await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', {
      ...observed.options,
      authorize,
      jev: { credential: () => 'key', fetch },
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      error: 'JEV_EXECUTION_FAILED',
      diagnostic: { stage: 'image', attemptId: 'attempt-1' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
    expect(observed.finishes).toHaveLength(1);
  });
  it('rejects invented choices or malformed probability distributions', async () => {
    const h = {
      signal: new AbortController().signal,
      credential: () => 'key',
      onAttemptStart: () => 'attempt',
      onAttemptFinish: vi.fn(),
    };
    await expect(
      judgeImagePlacement(source, assets, '', {
        ...h,
        fetch: async (_url, init) => typedResponse(JSON.parse(String(init?.body)), 'invented'),
      })
    ).rejects.toThrow('JEV_RESPONSE_INVALID');
    expect(h.onAttemptFinish).toHaveBeenCalledWith(
      'attempt',
      expect.objectContaining({
        status: 'error',
        usage: expect.objectContaining({ inputTokens: 120 }),
      })
    );
  });
  it('bounds large catalogs before dispatch and records evaluated coverage', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({
      ...assets[i % 2],
      ref: `asset-${i}`,
      caption: 'Detailed image metadata '.repeat(30),
    }));
    const request = imageJudgmentRequest(source, many)!;
    expect(estimateContextTokens({ model: JEV_MODEL, ...request })).toBeLessThanOrEqual(
      IMAGE_JUDGMENT_LIMITS.inputTokens
    );
    const state = request.state as { evaluatedAssets: number; totalAssets: number };
    expect(state.evaluatedAssets).toBeGreaterThan(0);
    expect(state.evaluatedAssets).toBeLessThan(2000);
    expect(state.totalAssets).toBe(2000);
  });
  it('keeps inexpensive long blocks intact and marks token-bounded excerpts without editing the source', () => {
    for (const text of [
      'A lantern glows. '.repeat(100),
      '강가에서 소녀가 등불을 흔든다. 🌙 '.repeat(200),
    ]) {
      const input = { ...source, text, hash: createHash('sha256').update(text).digest('hex') };
      const request = imageJudgmentRequest(input, assets)!;
      const state = request.state as { blocks: { text: string }[] };
      expect(state.blocks).toHaveLength(1);
      const excerpt = state.blocks[0].text;
      expect(countTextTokens(excerpt)).toBeLessThanOrEqual(IMAGE_JUDGMENT_LIMITS.blockTokens);
      if (countTextTokens(text) <= IMAGE_JUDGMENT_LIMITS.blockTokens) expect(excerpt).toBe(text);
      else expect(excerpt.endsWith('\n[Remaining block text omitted]')).toBe(true);
      expect(new TextDecoder().decode(new TextEncoder().encode(excerpt))).toBe(excerpt);
      expect(input.text).toBe(text);
      expect(estimateContextTokens({ model: JEV_MODEL, ...request })).toBeLessThanOrEqual(
        IMAGE_JUDGMENT_LIMITS.inputTokens
      );
    }
  });
});
