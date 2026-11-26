import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { AssetEntry } from '../core/auxiliary.js';
import type { WireRecord } from '../core/transport.js';
import {
  imageJudgmentRequest,
  judgeImagePlacement,
  validateImageJudgmentWire,
  IMAGE_JUDGMENT_LIMITS,
} from '../server/image-judgment.js';
import { countTextTokens } from '../core/text-tokens.js';
import { jevRequestFits } from '../server/judgment.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import { bundle, bridge, hooks } from './fixtures/translation-job.js';
import { prepareJevImage } from '../server/jev-images.js';
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
function paragraphCatalog() {
  const names = [
    'aurora',
    'birch',
    'cedar',
    'dahlia',
    'ember',
    'fern',
    'glacier',
    'hemlock',
    'iris',
    'juniper',
    'kelp',
    'lavender',
    'maple',
    'nectar',
    'orchid',
    'peony',
  ];
  const description = Array.from({ length: 1940 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(
    ''
  );
  const asset = (index: number, caption: string): AssetEntry => ({
    ref: `r${index}`,
    revision: 1,
    hash: 'a'.repeat(64),
    url: '/api/a',
    alt: names[index % names.length],
    caption,
    actorId: null,
    clothing: null,
    location: null,
    uses: ['inline'],
  });
  return {
    names,
    catalog: [
      ...names.map((name, index) => asset(index, `${name} ${description}`)),
      ...names.map((name, index) => asset(index + names.length, name)),
    ],
  };
}
describe('JEV-only existing image placement', () => {
  it('normalizes a small EXIF-rotated original into an upright supported still without changing it', async () => {
    const original = await sharp({
      create: { width: 120, height: 360, channels: 3, background: '#e00000' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const originalCopy = Buffer.from(original);
    const image = await prepareJevImage(original);
    expect(image).toMatchObject({ type: 'image', format: 'jpeg' });
    const decoded = Buffer.from(image.data_base64, 'base64');
    const metadata = await sharp(decoded).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 512, height: 512 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.isProgressive).toBe(false);
    const { data, info } = await sharp(decoded).raw().toBuffer({ resolveWithObject: true });
    const rgb = (x: number, y: number) => [
      ...data.subarray(
        (y * info.width + x) * info.channels,
        (y * info.width + x) * info.channels + 3
      ),
    ];
    expect(rgb(256, 20).every((channel) => channel > 245)).toBe(true);
    expect(rgb(256, 256)[0]).toBeGreaterThan(200);
    expect(rgb(256, 256)[1]).toBeLessThan(20);
    expect(original).toEqual(originalCopy);
    await expect(prepareJevImage(new Uint8Array([1, 2, 3]))).rejects.toThrow('JEV_IMAGE_INVALID');
  });
  it('sends only shortlisted pictures once, selects an existing asset, and binds saved vision wires', async () => {
    const original = await sharp({
      create: { width: 64, height: 96, channels: 4, background: '#1a7b98' },
    })
      .webp()
      .toBuffer();
    const catalog = Array.from({ length: 1000 }, (_, index) => ({
      ...assets[1],
      ref: `warehouse-${index}`,
      alt: `Warehouse crate ${index}`,
      caption: 'Unrelated warehouse storage',
    }));
    catalog[999] = { ...assets[0], ref: 'tail-pier' };
    let wire: WireRecord | undefined;
    const readImage = vi.fn(() => original);
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.state.selectionVersion).toBe('image-selection-jev-v5');
      expect(body.questions.block_0.instructions).toContain('candidate pictures');
      expect(body.state.settings).toEqual({ images: true, longContext: false });
      expect(Object.keys(body.assets).length).toBeLessThanOrEqual(16);
      expect(Object.keys(body.assets)).toHaveLength(body.state.assets.length);
      for (const asset of body.state.assets) {
        expect(body.assets[asset.image]).toMatchObject({ type: 'image', format: 'jpeg' });
        expect(
          JSON.stringify({ state: body.state, questions: body.questions }).split(asset.image)
        ).toHaveLength(2);
      }
      const tail = body.state.assets.find(
        (asset: { name: string }) => asset.name === 'Mira at pier'
      );
      expect(tail).toBeDefined();
      return typedResponse(body, tail.id);
    });
    const settings = { revision: 7, images: true, longContext: false };
    const result = await judgeImagePlacement(source, catalog, '', {
      settings,
      readImage,
      signal: new AbortController().signal,
      credential: () => 'key',
      fetch,
      onAttemptStart: (value) => {
        wire = value;
        return 'vision';
      },
      onAttemptFinish: vi.fn(),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readImage.mock.calls.length).toBeGreaterThan(0);
    expect(readImage.mock.calls.length).toBeLessThanOrEqual(16);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      assetRef: 'tail-pier',
      assetRevision: 1,
      assetHash: assets[0].hash,
    });
    expect(wire?.headers['TypeSafe-Danger-Zone-Images']).toBe('true');
    expect(() => validateImageJudgmentWire(source, catalog, wire!)).not.toThrow();
    const changed = structuredClone(wire!);
    const changedAssets = (changed.body as { assets: Record<string, { data_base64: string }> })
      .assets;
    changedAssets[Object.keys(changedAssets)[0]].data_base64 =
      Buffer.from('tampered').toString('base64');
    expect(() => validateImageJudgmentWire(source, catalog, changed)).toThrow(
      'IMAGE_JUDGMENT_ATTEMPT_MISMATCH'
    );
    expect(() =>
      validateImageJudgmentWire(
        source,
        catalog.map((asset) => ({ ...asset, revision: 2 })),
        wire!
      )
    ).toThrow('IMAGE_JUDGMENT_ATTEMPT_MISMATCH');
    const withoutHeader = structuredClone(wire!);
    delete withoutHeader.headers['TypeSafe-Danger-Zone-Images'];
    expect(() => validateImageJudgmentWire(source, catalog, withoutHeader)).toThrow(
      'IMAGE_JUDGMENT_ATTEMPT_MISMATCH'
    );
  });
  it('uses the configured context window without loading bytes when vision is off', async () => {
    const readImage = vi.fn();
    const guidance = 'z '.repeat(40000);
    const settings = { images: false, longContext: true };
    let wire: WireRecord | undefined;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty('assets');
      expect(body.state.assets.every((asset: object) => !Object.hasOwn(asset, 'image'))).toBe(true);
      expect(body.state.guidance).toBe(guidance);
      return typedResponse(body, 'none');
    });
    const result = await judgeImagePlacement(source, assets, guidance, {
      settings,
      readImage,
      signal: new AbortController().signal,
      credential: () => 'key',
      fetch,
      onAttemptStart: (value) => {
        wire = value;
        return 'long';
      },
      onAttemptFinish: vi.fn(),
    });
    expect(result.entries).toEqual([]);
    expect(readImage).not.toHaveBeenCalled();
    expect(wire?.headers['TypeSafe-Danger-Zone-Long-Context']).toBe('true');
    expect(() => validateImageJudgmentWire(source, assets, wire!)).not.toThrow();
    expect(() =>
      imageJudgmentRequest(source, assets, guidance, { images: false, longContext: false })
    ).toThrow('JEV_INPUT_BUDGET');
  });
  it('keeps none and the four-image result cap after judging actual pictures', async () => {
    const bytes = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#5a7089' },
    })
      .png()
      .toBuffer();
    const catalog = Array.from({ length: 6 }, (_, index) => ({
      ...assets[0],
      ref: `picture-${index}`,
    }));
    const text = Array.from({ length: 6 }, (_, index) => `Scene ${index} at the pier.`).join(
      '\n\n'
    );
    const input = { ...source, text, hash: createHash('sha256').update(text).digest('hex') };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const response = await typedResponse(body, 'none').json();
      for (let index = 0; index < 5; index++)
        response.answers[`block_${index}`] = {
          type: 'choice',
          choice: `asset_${index}`,
          probabilities: { [`asset_${index}`]: 0.95 },
        };
      return new Response(JSON.stringify(response));
    });
    const result = await judgeImagePlacement(input, catalog, '', {
      settings: { images: true, longContext: false },
      readImage: () => bytes,
      signal: new AbortController().signal,
      credential: () => 'key',
      fetch,
      onAttemptStart: () => 'cap',
      onAttemptFinish: vi.fn(),
    });
    expect(result.entries).toHaveLength(4);
    expect(new Set(result.entries.map((entry) => entry.assetRef)).size).toBe(4);
    expect(
      result.entries.every(
        (entry) => entry.assetRevision === 1 && entry.assetHash === assets[0].hash
      )
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
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
    const sent = JSON.parse(String(send.mock.calls[0][1]?.body));
    expect(sent.questions.block_0.criteria.asset_0).toContain('Morning pier portrait');
    expect(sent.questions.block_0.criteria.asset_1).toContain('Mountain');
    expect(sent.questions.block_0.instructions).not.toContain('candidate pictures');
    expect(sent.state).not.toHaveProperty('sourceHash');
    expect(sent.state.assets[0]).toMatchObject({
      id: 'asset_0',
      name: assets[0].alt,
      description: assets[0].caption,
      actor: assets[0].actorId,
      location: assets[0].location,
      uses: assets[0].uses,
    });
    for (const asset of sent.state.assets) {
      expect(asset).not.toHaveProperty('revision');
      expect(asset).not.toHaveProperty('hash');
    }
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
  it('keeps source identity binding when a source edit leaves the semantic model input unchanged', async () => {
    const updatedText = `${source.text}\n\n`;
    const updated = {
      ...source,
      text: updatedText,
      hash: createHash('sha256').update(updatedText).digest('hex'),
    };
    const wires: WireRecord[] = [];
    const send = vi.fn(async (_url: unknown, init?: RequestInit) =>
      typedResponse(JSON.parse(String(init?.body)))
    );
    for (const input of [source, updated])
      await judgeImagePlacement(input, assets, '', {
        signal: new AbortController().signal,
        credential: () => 'key',
        fetch: send,
        onAttemptStart: (wire) => {
          wires.push(wire);
          return `attempt-${wires.length}`;
        },
        onAttemptFinish: vi.fn(),
      });
    expect(send.mock.calls[0][1]?.body).toBe(send.mock.calls[1][1]?.body);
    expect(wires[0].judgment?.inputHash).not.toBe(wires[1].judgment?.inputHash);
    expect(() => validateImageJudgmentWire(updated, assets, wires[0])).toThrow(
      'IMAGE_JUDGMENT_ATTEMPT_MISMATCH'
    );
    expect(() => validateImageJudgmentWire(updated, assets, wires[1])).not.toThrow();
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
  it('rejects an invented choice', async () => {
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
  it('reserves a suitable affordable candidate for every paragraph before filling depth', async () => {
    const { names, catalog } = paragraphCatalog();
    const text = names
      .map((name) => `${name} waits. ${'Story continues slowly. '.repeat(200)}`)
      .join('\n\n');
    const input = { ...source, text, hash: createHash('sha256').update(text).digest('hex') };
    expect(catalog.every((asset) => asset.alt.length <= 200 && asset.caption.length <= 2000)).toBe(
      true
    );
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.state.selectionVersion).toBe('image-selection-jev-v5');
      expect(jevRequestFits(body)).toBe(true);
      const own = names.map((name, index) => {
        const found = body.state.assets.find(
          (asset: { id: string; name: string }) =>
            asset.name === name &&
            Object.hasOwn(body.questions[`block_${index}`].criteria, asset.id)
        );
        expect(found, `candidate for paragraph ${index}`).toBeDefined();
        return found;
      });
      const response = await typedResponse(body, 'none').json();
      response.answers.block_15 = {
        type: 'choice',
        choice: own[15].id,
        probabilities: { [own[15].id]: 0.95 },
      };
      return new Response(JSON.stringify(response));
    });
    const result = await judgeImagePlacement(input, catalog, '', {
      signal: new AbortController().signal,
      credential: () => 'key',
      fetch,
      onAttemptStart: (wire) => {
        validateImageJudgmentWire(input, catalog, wire);
        return 'coverage';
      },
      onAttemptFinish: vi.fn(),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].assetRef).toBe('r31');
  });
  it('keeps minority scenes eligible and rejects a shared catalog ID outside its block choices', async () => {
    const text = [
      ...Array.from({ length: 15 }, () => 'Harbor pier sailors morning boats.'),
      'Observatory telescope astronomer constellations.',
    ].join('\n\n');
    const input = { ...source, text, hash: createHash('sha256').update(text).digest('hex') };
    const many = Array.from({ length: 300 }, (_, i) => ({
      ...assets[0],
      ref: `scene-${i}`,
      actorId: null,
      alt: i < 250 ? `Harbor pier sailors ${i}` : `Observatory telescope astronomer ${i}`,
      caption:
        i < 250
          ? 'Morning boats at the harbor pier'
          : 'Astronomer studies constellations through a telescope',
      location: i < 250 ? 'harbor pier' : 'observatory',
    }));
    const finish = vi.fn();
    let unauthorized = '';
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const minority = body.state.assets.find(
        (asset: { name: string; id: string }) =>
          asset.name.startsWith('Observatory') &&
          Object.hasOwn(body.questions.block_15.criteria, asset.id)
      );
      expect(minority).toBeDefined();
      unauthorized = minority.id;
      expect(body.questions.block_0.criteria).not.toHaveProperty(unauthorized);
      expect(
        Object.values(body.questions).every(
          (question) => Object.keys((question as { criteria: object }).criteria).length <= 255
        )
      ).toBe(true);
      const response = await typedResponse(body, 'none').json();
      response.answers.block_15 = {
        type: 'choice',
        choice: minority.id,
        probabilities: { [minority.id]: 0.95 },
      };
      if (fetch.mock.calls.length > 1) response.answers.block_0 = response.answers.block_15;
      return new Response(JSON.stringify(response));
    });
    const h = {
      signal: new AbortController().signal,
      credential: () => 'key',
      fetch,
      onAttemptStart: () => 'minority',
      onAttemptFinish: finish,
    };
    const result = await judgeImagePlacement(input, many, '', h);
    expect(result.entries).toHaveLength(1);
    expect(many.find((asset) => asset.ref === result.entries[0].assetRef)?.location).toBe(
      'observatory'
    );
    await expect(judgeImagePlacement(input, many, '', h)).rejects.toThrow('JEV_RESPONSE_INVALID');
    expect(unauthorized).not.toBe('');
  });
  it('skips oversized metadata and preserves affordable candidates instead of prefix crowdout', async () => {
    const catalog = [
      { ...assets[0], ref: 'oversized', caption: 'Mira pier '.repeat(30000) },
      assets[1],
    ];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.state.assets.map((asset: { name: string }) => asset.name)).toEqual(['Mountain']);
      expect(jevRequestFits(body)).toBe(true);
      return typedResponse(body, 'asset_1');
    });
    const result = await judgeImagePlacement(source, catalog, '', {
      signal: new AbortController().signal,
      credential: () => 'key',
      fetch,
      onAttemptStart: () => 'budget',
      onAttemptFinish: vi.fn(),
    });
    expect(result.entries[0].assetRef).toBe('mountain');
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
      expect(jevRequestFits(request)).toBe(true);
    }
  });
});
