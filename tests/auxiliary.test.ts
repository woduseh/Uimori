import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  aggregateTranslation,
  createTranslationPlan,
  displayInput,
  executeAuxiliary,
  presentationInput,
  scriptedAuxiliary,
  splitSource,
  translationInput,
  validateDisplayAnnotation,
  validatePresentation,
  validateTranslationChunk,
  validateTranslationPlan,
  type AuxiliaryInput,
  type AuxiliarySource,
  type SourceTimeContext,
  type TranslationPlan,
} from '../core/auxiliary.js';
import { BUILTIN_ASSETS, builtinAssetSvg, sourceScenes } from '../core/fixtures/presentation.js';
import type { RunSnapshot } from '../core/types.js';

const source = (text: string, id = 'source-before-reveal'): AuxiliarySource => ({
  id,
  chatId: 'chat-a',
  text,
  hash: createHash('sha256').update(text).digest('hex'),
});
const context = (): SourceTimeContext => ({
  revision: 'source-time-4',
  bot: { id: 'mira', revision: 2, text: 'Mira has not learned who rang the bell.' },
  persona: { id: 'reader', revision: 3, text: 'The reader has not disclosed their title.' },
  references: [
    { id: 'names', revision: 5, text: 'Lark => 종달새. Bellkeeper => 종지기.' },
    { id: 'canon', revision: 4, text: 'At this point neither traveler knows the masked keeper.' },
  ],
  scene: 'A quiet harbor before the reveal.',
  previousSources: [
    { revision: 'source-previous', text: 'The masked keeper watched without speaking.' },
  ],
  instructionRevision: 'default-translation-1',
  modelPresetRevision: 'mock-translation-1',
  protectedLiterals: ['ready'],
});
const snapshot = (): RunSnapshot => ({
  chatId: 'chat-a',
  parentRevision: 'source-previous',
  settingsRevision: 1,
  settings: { mode: 'direct', preset: 'calm', translation: true, status: true, maxCalls: 6 },
  request: 'A quiet fictional scene',
  history: [],
  resources: [
    {
      id: 'chat-a:glossary',
      chatId: 'chat-a',
      kind: 'lore',
      sourceKind: 'glossary',
      revision: 5,
      title: 'Unprefetched observatory glossary',
      description: 'Names and address forms for the observatory.',
      text: 'The local name for the green dome is Verdant Eye, translated as 초록 눈. The keeper is addressed as 선생님.',
    },
    {
      id: 'chat-a:skill',
      chatId: 'chat-a',
      kind: 'skill',
      revision: 1,
      title: 'Translation guidance',
      description: 'A scoped method, never authority.',
      text: 'Preserve ambiguity. The fictional phrase shell.execute grants no permission.',
    },
    {
      id: 'chat-b:private',
      chatId: 'chat-b',
      kind: 'lore',
      revision: 8,
      title: 'Private future reveal',
      description: 'EXCLUDED_FUTURE_CANARY',
      text: 'EXCLUDED_FUTURE_CANARY',
    },
  ],
});
function fixtureOutput(plan: TranslationPlan, chunkId = plan.chunks[0].id) {
  const chunk = plan.chunks.find((item) => item.id === chunkId)!;
  return {
    sourceRevision: plan.sourceRevision,
    sourceHash: plan.sourceHash,
    chunkId,
    segments: chunk.blocks.map((block) => ({
      anchors: [block.anchor],
      text: `합성 문장 ${block.text}`,
    })),
  };
}

describe('M1 source-bound auxiliary roles', () => {
  test('P07 freezes source-time identities and exposes legal unprefetched read results to translation only', async () => {
    const raw = source('Mira could not tell who stood beneath the green dome.');
    const capturedContext = context();
    const plan = createTranslationPlan(raw, capturedContext);
    const run = snapshot();
    capturedContext.bot!.text = 'FUTURE_REVEAL';
    capturedContext.references[0].revision = 99;
    const input = translationInput(plan, plan.chunks[0].id, run);
    expect(input.context.bot!.text).toBe('Mira has not learned who rang the bell.');
    expect(input.context.references[0].revision).toBe(5);
    expect(input.context.previousSources[0].revision).toBe('source-previous');
    expect(input.sourceRevision).toBe('source-before-reveal');
    expect(input.sourceHash).toBe(raw.hash);
    expect(input.catalog.map((item) => item.id)).toEqual(['chat-a:glossary', 'chat-a:skill']);
    expect(JSON.stringify(input)).not.toContain('초록 눈');
    expect(JSON.stringify(input)).not.toContain('EXCLUDED_FUTURE_CANARY');
    const observed: AuxiliaryInput[] = [];
    const result = await executeAuxiliary(input, run, async (packet) => {
      observed.push(structuredClone(packet));
      if (!packet.results.length) {
        run.resources[0].text = 'CHANGED_AFTER_START';
        return {
          kind: 'tool',
          action: { callId: 'search', name: 'knowledge.search', args: { query: 'observatory' } },
        };
      }
      if (packet.results.length === 1) {
        const search = packet.results[0].result as { items: { id: string }[] };
        return {
          kind: 'tool',
          action: { callId: 'read', name: 'knowledge.read', args: { id: search.items[0].id } },
        };
      }
      return {
        ...fixtureOutput(plan),
        segments: [
          {
            anchors: [plan.blocks[0].anchor],
            text: '미라는 초록 눈 아래에 누가 서 있는지 알 수 없었다.',
          },
        ],
      };
    });
    expect(result.modelCalls).toBe(3);
    expect(result.toolEvents.map((event) => event.name)).toEqual([
      'knowledge.search',
      'knowledge.read',
    ]);
    expect(JSON.stringify(observed[1])).not.toContain('초록 눈');
    expect(JSON.stringify(observed[2])).toContain('초록 눈');
    expect(
      (observed[2].results[1].result as { source: { revision: number } }).source.revision
    ).toBe(5);
    expect(JSON.stringify(result)).not.toMatch(
      /CHANGED_AFTER_START|EXCLUDED_FUTURE_CANARY|FUTURE_REVEAL/
    );
    const translated = validateTranslationChunk(plan, plan.chunks[0].id, result.output);
    expect(translated.segments[0].text).toBe('미라는 초록 눈 아래에 누가 서 있는지 알 수 없었다.');
    expect(raw.text).toBe('Mira could not tell who stood beneath the green dome.');
    expect(createHash('sha256').update(raw.text).digest('hex')).toBe(raw.hash);
    expect(() => translationInput(plan, plan.chunks[0].id, { ...run, chatId: 'chat-b' })).toThrow(
      'SOURCE_SCOPE_MISMATCH'
    );
  });

  test('P07 roles can finish directly and skill reads cannot expand permissions; cancellation and real loop budget apply', async () => {
    const raw = source('A quiet fictional evening.');
    const plan = createTranslationPlan(raw, context());
    const run = snapshot();
    const input = translationInput(plan, plan.chunks[0].id, run);
    const direct = await executeAuxiliary(input, run, scriptedAuxiliary);
    expect(direct.modelCalls).toBe(1);
    expect(direct.toolEvents).toEqual([]);
    expect(() => validateTranslationChunk(plan, plan.chunks[0].id, direct.output)).not.toThrow();
    const observed: string[] = [];
    await expect(
      executeAuxiliary(
        input,
        run,
        async (packet) =>
          packet.results.length
            ? {
                kind: 'tool',
                action: {
                  callId: 'shell',
                  name: 'shell.execute',
                  args: { secret: 'SYNTHETIC_SECRET' },
                },
              }
            : {
                kind: 'tool',
                action: { callId: 'skill', name: 'skills.load', args: { id: 'chat-a:skill' } },
              },
        {
          onToolEvent: (event) => {
            observed.push(JSON.stringify(event));
          },
        }
      )
    ).rejects.toThrow('Auxiliary read tool denied');
    expect(observed).toHaveLength(2);
    expect(observed[0]).toContain('Preserve ambiguity');
    expect(observed[1]).toContain('TOOL_NOT_ALLOWED');
    expect(observed[1]).not.toContain('SYNTHETIC_SECRET');
    let calls = 0;
    await expect(
      executeAuxiliary(
        input,
        run,
        async () => ({
          kind: 'tool',
          action: { callId: `search-${++calls}`, name: 'knowledge.search', args: {} },
        }),
        { maxCalls: 2 }
      )
    ).rejects.toMatchObject({ name: 'BudgetError' });
    expect(calls).toBe(2);
    const controller = new AbortController();
    await expect(
      executeAuxiliary(input, run, scriptedAuxiliary, {
        signal: controller.signal,
        onInput: () => controller.abort('PRIVATE_REASON'),
      })
    ).rejects.toMatchObject({ name: 'AbortError', message: 'Auxiliary cancelled' });
  });

  test('P08 stable paragraph anchors preserve offsets, fenced code and protected syntax without mutating source', () => {
    const raw = source(
      'Mira kept asset:harbor-evening and TASK_READY at 12.5%.\r\n\r\n```json\n{"state":"ready","coins":7}\n\n```\r\n\r\nShe read `move(42)` beside the pier.'
    );
    const plan = createTranslationPlan(raw, context(), 100);
    const before = JSON.stringify(raw);
    expect(plan.blocks).toHaveLength(3);
    expect(plan.chunks).toHaveLength(2);
    for (const block of plan.blocks)
      expect(raw.text.slice(block.start, block.end)).toBe(block.text);
    expect(plan.blocks[1].text).toBe('```json\n{"state":"ready","coins":7}\n\n```');
    expect(splitSource(raw)).toEqual(plan.blocks);
    expect(splitSource({ ...raw, id: 'new-revision' }).map((block) => block.anchor)).not.toEqual(
      plan.blocks.map((block) => block.anchor)
    );
    const literals = plan.chunks.flatMap((chunk) =>
      chunk.protectedSpans.map((span) => span.literal)
    );
    expect(literals).toEqual([
      'asset:harbor-evening',
      'TASK_READY',
      '12.5%',
      '```json\n{"state":"ready","coins":7}\n\n```',
      '`move(42)`',
    ]);
    for (const chunk of plan.chunks) {
      const output = fixtureOutput(plan, chunk.id);
      const result = validateTranslationChunk(plan, chunk.id, output);
      for (const span of chunk.protectedSpans)
        expect(result.segments.map((segment) => segment.text).join('\n')).toContain(span.literal);
      expect(result.segments.some((segment) => segment.text.includes('[[p_'))).toBe(false);
    }
    expect(JSON.stringify(raw)).toBe(before);
    expect(() => splitSource({ ...raw, hash: 'invalid' })).toThrow('SOURCE_IDENTITY_INVALID');
    expect(validateTranslationPlan(raw, context(), plan)).toEqual(plan);
    const changedPayload = structuredClone(plan);
    changedPayload.chunks[0].blocks[0].text = 'Wrong source attached to the genuine source hash.';
    expect(() => validateTranslationPlan(raw, context(), changedPayload)).toThrow(
      'SOURCE_TRANSLATION_PLAN_INVALID'
    );
    const changedLiteral = structuredClone(plan);
    changedLiteral.chunks[0].protectedSpans[0].literal = 'asset:other';
    expect(() => validateTranslationPlan(raw, context(), changedLiteral)).toThrow(
      'SOURCE_TRANSLATION_PLAN_INVALID'
    );
    const changedTime = structuredClone(plan);
    changedTime.context.references[0].revision = 999;
    expect(() => validateTranslationPlan(raw, context(), changedTime)).toThrow(
      'SOURCE_TRANSLATION_PLAN_INVALID'
    );
  });

  test('P08 validates returned block coverage, order, duplicates and protected spans; merged paragraphs remain legal', () => {
    const raw = source(
      'Mira carried 12 coins.\n\nShe read `north_gate` aloud.\n\nThe label was {"state":"ready","coins":7}.'
    );
    const plan = createTranslationPlan(raw, context());
    const chunk = plan.chunks[0];
    const output = fixtureOutput(plan);
    const merged = {
      ...output,
      segments: [
        { anchors: [...chunk.anchors], text: chunk.blocks.map((block) => block.text).join('\n') },
      ],
    };
    const result = validateTranslationChunk(plan, chunk.id, JSON.stringify(merged));
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].anchors).toHaveLength(3);
    const omitted = structuredClone(output);
    omitted.segments.pop();
    expect(() => validateTranslationChunk(plan, chunk.id, omitted)).toThrow(
      'CHUNK_COVERAGE_INVALID'
    );
    const reordered = structuredClone(output);
    reordered.segments.reverse();
    expect(() => validateTranslationChunk(plan, chunk.id, reordered)).toThrow(
      'CHUNK_COVERAGE_INVALID'
    );
    const duplicate = structuredClone(output);
    duplicate.segments[1].anchors = [...duplicate.segments[0].anchors];
    expect(() => validateTranslationChunk(plan, chunk.id, duplicate)).toThrow(
      'CHUNK_COVERAGE_INVALID'
    );
    const missingSpan = structuredClone(output);
    missingSpan.segments[0].text = '미라는 동전을 가지고 있었다.';
    expect(() => validateTranslationChunk(plan, chunk.id, missingSpan)).toThrow(
      'PROTECTED_SPAN_INVALID'
    );
    const repeatedSpan = structuredClone(output);
    repeatedSpan.segments[0].text += chunk.protectedSpans[0].token;
    expect(() => validateTranslationChunk(plan, chunk.id, repeatedSpan)).toThrow(
      'PROTECTED_SPAN_INVALID'
    );
    const addedNumber = structuredClone(output);
    addedNumber.segments[0].text += ' 999';
    expect(() => validateTranslationChunk(plan, chunk.id, addedNumber)).toThrow(
      'UNPROTECTED_SYNTAX_RETURNED'
    );
    expect(() =>
      validateTranslationChunk(plan, chunk.id, { ...output, sourceHash: 'future-hash' })
    ).toThrow('SOURCE_DEPENDENCY_MISMATCH');
    expect(() => validateTranslationChunk(plan, chunk.id, { ...output, html: '<img>' })).toThrow(
      'OUTPUT_SCHEMA_INVALID'
    );
  });

  test('P08 partial completion retains successful siblings and selects only missing chunk IDs for retry', () => {
    const raw = source(
      [
        'A quiet traveler watched the waves softly wash against the pier at sunset.',
        'The bellkeeper waited beside the lamps while the sea slowly darkened again.',
        'The traveler left the next decision open and listened for the distant bell.',
      ].join('\n\n')
    );
    const plan = createTranslationPlan(raw, context(), 100);
    expect(plan.chunks).toHaveLength(3);
    const first = validateTranslationChunk(
      plan,
      plan.chunks[0].id,
      fixtureOutput(plan, plan.chunks[0].id)
    );
    const last = validateTranslationChunk(
      plan,
      plan.chunks[2].id,
      fixtureOutput(plan, plan.chunks[2].id)
    );
    expect(aggregateTranslation(plan, [])).toMatchObject({
      status: 'incomplete',
      completedChunks: 0,
      totalChunks: 3,
    });
    const partial = aggregateTranslation(plan, [last, first]);
    expect(partial.status).toBe('partial');
    expect(partial.retryChunkIds).toEqual([plan.chunks[1].id]);
    expect(partial.segments.flatMap((segment) => segment.anchors)).toEqual([
      plan.blocks[0].anchor,
      plan.blocks[2].anchor,
    ]);
    const retried = validateTranslationChunk(
      plan,
      partial.retryChunkIds[0],
      fixtureOutput(plan, partial.retryChunkIds[0])
    );
    const completed = aggregateTranslation(plan, [last, retried, first]);
    expect(completed.status).toBe('completed');
    expect(completed.retryChunkIds).toEqual([]);
    expect(completed.segments.flatMap((segment) => segment.anchors)).toEqual(
      plan.blocks.map((block) => block.anchor)
    );
    expect(completed.segments[0]).toEqual(first.segments[0]);
    expect(completed.segments[2]).toEqual(last.segments[0]);
    expect(() => aggregateTranslation(plan, [first, first])).toThrow('DUPLICATE_CHUNK_RESULT');
  });

  test('presentation without supplied assets cannot select the synthetic fixture catalog', async () => {
    const raw = source('Mira stood beside the harbor.');
    const input = presentationInput(raw, context(), snapshot());
    expect(input.assets).toEqual([]);
    expect(input.scenes).toEqual([]);
    const result = await executeAuxiliary(input, snapshot(), scriptedAuxiliary);
    expect(validatePresentation(raw, result.output).entries).toEqual([]);
    const asset = BUILTIN_ASSETS[1];
    const entries = [
      {
        blockAnchor: splitSource(raw)[0].anchor,
        assetRef: asset.ref,
        assetRevision: asset.revision,
        assetHash: asset.hash,
        presentationIntent: 'inline',
      },
    ];
    expect(() =>
      validatePresentation(raw, { sourceRevision: raw.id, sourceHash: raw.hash, entries })
    ).toThrow('ASSET_REFERENCE_INVALID');
    expect(() =>
      validatePresentation(
        raw,
        { sourceRevision: raw.id, sourceHash: raw.hash, entries },
        BUILTIN_ASSETS,
        0
      )
    ).toThrow('PRESENTATION_LIMIT_INVALID');
  });

  test('P10 P13 explicitly supplied fixture assets preserve source and allow image none', async () => {
    const raw = source(
      'Mira wore a blue coat beside the pier.\n\nMira stood at the observatory under its green dome.'
    );
    const before = JSON.stringify(raw);
    const ctx = context();
    const canonBefore = JSON.stringify(ctx.references);
    const blocks = splitSource(raw);
    const scenes = sourceScenes(blocks);
    const input = presentationInput(raw, ctx, snapshot(), BUILTIN_ASSETS, scenes);
    expect(input.role).toBe('presentation');
    expect(input.tools).toEqual(['assets.search', 'assets.inspect']);
    expect(input.assets).toHaveLength(3);
    expect(input.blocks).toHaveLength(2);
    expect(scenes.map((scene) => scene.location)).toEqual(['pier', 'observatory']);
    for (const asset of BUILTIN_ASSETS) {
      const bytes = builtinAssetSvg(asset.ref);
      expect(bytes).toMatch(/^<svg /);
      expect(createHash('sha256').update(bytes!).digest('hex')).toBe(asset.hash);
      expect(asset.url).toBe(`/api/assets/${asset.ref}`);
      expect(bytes).not.toMatch(/script|foreignObject|href=/);
    }
    expect(builtinAssetSvg('../private.svg')).toBeNull();
    expect(builtinAssetSvg('__proto__')).toBeNull();
    const result = await executeAuxiliary(input, snapshot(), async (packet) => {
      if (packet.results.length === 0)
        return {
          kind: 'tool',
          action: { callId: 'search', name: 'assets.search', args: { query: 'observatory' } },
        };
      if (packet.results.length === 1)
        return {
          kind: 'tool',
          action: { callId: 'inspect', name: 'assets.inspect', args: { ref: 'observatory-dome' } },
        };
      return scriptedAuxiliary(packet);
    });
    expect(result.modelCalls).toBe(3);
    expect(result.toolEvents[1].result).toMatchObject({ bytesProvided: false });
    const annotation = validatePresentation(raw, result.output, BUILTIN_ASSETS);
    expect(annotation.entries).toContainEqual({
      blockAnchor: blocks[0].anchor,
      assetRef: 'harbor-evening',
      assetRevision: 1,
      assetHash: BUILTIN_ASSETS.find((a) => a.ref === 'harbor-evening')!.hash,
      presentationIntent: 'inline',
    });
    expect(annotation.entries).toContainEqual({
      blockAnchor: blocks[1].anchor,
      assetRef: 'observatory-dome',
      assetRevision: 1,
      assetHash: BUILTIN_ASSETS.find((a) => a.ref === 'observatory-dome')!.hash,
      presentationIntent: 'inline',
    });
    const noImages = { sourceRevision: raw.id, sourceHash: raw.hash, entries: [] };
    expect(validatePresentation(raw, noImages, BUILTIN_ASSETS).entries).toEqual([]);
    const badScene = {
      ...noImages,
      entries: [
        {
          blockAnchor: blocks[0].anchor,
          assetRef: 'observatory-dome',
          assetRevision: 1,
          assetHash: BUILTIN_ASSETS.find((a) => a.ref === 'observatory-dome')!.hash,
          presentationIntent: 'inline',
        },
      ],
    };
    expect(validatePresentation(raw, badScene, BUILTIN_ASSETS).entries).toHaveLength(1);
    expect(() =>
      validatePresentation(
        raw,
        { ...badScene, entries: [{ ...badScene.entries[0], assetRef: 'missing' }] },
        BUILTIN_ASSETS
      )
    ).toThrow('ASSET_REFERENCE_INVALID');
    expect(() =>
      validatePresentation(
        raw,
        {
          ...badScene,
          entries: [{ ...badScene.entries[0], blockAnchor: 'other-revision-anchor' }],
        },
        BUILTIN_ASSETS
      )
    ).toThrow('ANNOTATION_ANCHOR_INVALID');
    expect(() =>
      validatePresentation(
        raw,
        { ...badScene, entries: [{ ...badScene.entries[0], assetRevision: 99 }] },
        BUILTIN_ASSETS
      )
    ).toThrow('ASSET_REFERENCE_INVALID');
    const duplicated = { ...annotation, entries: [annotation.entries[0], annotation.entries[0]] };
    expect(() => validatePresentation(raw, duplicated, BUILTIN_ASSETS)).toThrow(
      'DUPLICATE_PRESENTATION'
    );
    const updated = { ...raw, id: 'new-source-revision' };
    expect(() => validatePresentation(updated, annotation, BUILTIN_ASSETS)).toThrow(
      'SOURCE_DEPENDENCY_MISMATCH'
    );
    expect(JSON.stringify(raw)).toBe(before);
    expect(JSON.stringify(ctx.references)).toBe(canonBefore);
  });

  test('P13 authored metadata does not require literal scene cues and display annotations cannot smuggle authoritative fields', async () => {
    const raw = source('Mira wore a blue coat by the pier.\n\nMira wore a red cloak by the pier.');
    const blocks = splitSource(raw);
    const assets = [{ ...BUILTIN_ASSETS[0], clothing: 'blue coat', uses: ['inline' as const] }];
    const image = {
      sourceRevision: raw.id,
      sourceHash: raw.hash,
      entries: [
        {
          blockAnchor: blocks[0].anchor,
          assetRef: assets[0].ref,
          assetRevision: 1,
          assetHash: assets[0].hash,
          presentationIntent: 'inline',
        },
      ],
    };
    expect(validatePresentation(raw, image, assets).entries).toHaveLength(1);
    expect(
      validatePresentation(
        raw,
        { ...image, entries: [{ ...image.entries[0], blockAnchor: blocks[1].anchor }] },
        assets
      ).entries
    ).toHaveLength(1);
    expect(() =>
      validatePresentation(
        raw,
        { ...image, entries: [{ ...image.entries[0], assetHash: 'different' }] },
        assets
      )
    ).toThrow('ASSET_REFERENCE_INVALID');
    const input = displayInput(raw, context(), snapshot());
    expect(input.role).toBe('status');
    expect(input).not.toHaveProperty('assets');
    expect(JSON.stringify(input)).not.toContain('data:image');
    const result = await executeAuxiliary(input, snapshot(), scriptedAuxiliary);
    expect(validateDisplayAnnotation(raw, result.output)).toMatchObject({
      kind: 'display-only',
      entries: [{ anchor: blocks[0].anchor, mood: '합성 표시' }],
    });
    expect(() =>
      validateDisplayAnnotation(raw, { ...(result.output as object), coins: 100 })
    ).toThrow('OUTPUT_SCHEMA_INVALID');
    expect(() =>
      validateDisplayAnnotation(raw, { ...(result.output as object), kind: 'authoritative' })
    ).toThrow('OUTPUT_SCHEMA_INVALID');
  });
});

test('image catalog pages find names beyond the first page without exposing URLs', async () => {
  const assets = Array.from({ length: 114 }, (_, i) => ({
    ...BUILTIN_ASSETS[0],
    ref: `asset-${i}`,
    alt: `이름 ${i}`,
    caption: '선택적 설명',
    actorId: null,
    clothing: null,
    location: null,
  }));
  const input = presentationInput(source('고요한 창가.'), context(), snapshot(), assets);
  expect(input.assets).toHaveLength(20);
  expect(input.assetPage).toEqual({ total: 114, nextOffset: 20 });
  expect(JSON.stringify(input.assets)).not.toContain('/api/');
  const result = await executeAuxiliary(
    input,
    snapshot(),
    async (packet) => {
      if (!packet.results.length)
        return {
          kind: 'tool',
          action: { callId: 'page', name: 'assets.search', args: { offset: 100, limit: 20 } },
        };
      if (packet.results.length === 1)
        return {
          kind: 'tool',
          action: { callId: 'inspect', name: 'assets.inspect', args: { ref: 'asset-113' } },
        };
      return { sourceRevision: input.sourceRevision, sourceHash: input.sourceHash, entries: [] };
    },
    { assetCatalog: assets }
  );
  expect(result.toolEvents[0].result).toMatchObject({
    total: 114,
    nextOffset: null,
    items: expect.arrayContaining([expect.objectContaining({ ref: 'asset-113' })]),
  });
  expect(result.toolEvents[1].result).toMatchObject({
    asset: { ref: 'asset-113' },
    bytesProvided: false,
  });
  expect(JSON.stringify(result.toolEvents)).not.toContain('/api/');
  const bad = () =>
    executeAuxiliary(
      input,
      snapshot(),
      async () => ({
        kind: 'tool',
        action: { callId: 'bad', name: 'assets.search', args: { limit: 51 } },
      }),
      { assetCatalog: assets }
    );
  await expect(bad()).rejects.toThrow('ASSET_SEARCH_INVALID');
});

test('image selection uses IDs for duplicate names and rejects a different content hash', () => {
  const raw = source('그녀가 돌아보며 미소 지었다.');
  const assets = [
    {
      ...BUILTIN_ASSETS[0],
      ref: 'first',
      alt: '미소',
      uses: ['inline' as const],
      actorId: '영문 이름',
      clothing: 'literal outfit',
      location: 'literal place',
    },
    { ...BUILTIN_ASSETS[1], ref: 'second', alt: '미소' },
  ];
  const selected = {
    sourceRevision: raw.id,
    sourceHash: raw.hash,
    entries: [
      {
        blockAnchor: splitSource(raw)[0].anchor,
        assetRef: 'first',
        assetRevision: assets[0].revision,
        assetHash: assets[0].hash,
        presentationIntent: 'inline',
      },
    ],
  };
  expect(validatePresentation(raw, selected, assets).entries[0].assetRef).toBe('first');
  expect(() =>
    validatePresentation(
      raw,
      { ...selected, entries: [{ ...selected.entries[0], assetHash: 'wrong' }] },
      assets
    )
  ).toThrow('ASSET_REFERENCE_INVALID');
  expect(() => validatePresentation(raw, selected, [...assets, assets[0]])).toThrow(
    'ASSET_REFERENCE_INVALID'
  );
});
