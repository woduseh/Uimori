import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import {
  aggregateTranslation,
  compileTranslationPrompt,
  createTranslationPlan,
  translationInput,
  validateTranslationChunk,
  validateTranslationPlan,
  type AuxiliaryInput,
  type TranslationPlan,
  type TranslationResult,
} from '../core/auxiliary.js';
import { parseSourceSegments, validateSegmentTranslation } from '../core/source-segments.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import { defaultProfile } from '../core/product.js';
import type { PromptProgram } from '../core/prompt-program.js';
import {
  runAuxiliaryJob,
  sourceTimeContext,
  type AuxiliaryBundle,
  type AuxiliaryChunkRecord,
  type AuxiliaryJobHooks,
  type AuxiliaryOutcome,
  type AuxiliaryStoreBridge,
} from '../server/product-auxiliary.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const text =
  'The traveler waited.\n\n@hsTitle: A quiet memory\n⟦harbor @ dusk @ keeper⟧\n[hsPortrait: asset:keeper-profile]\nThe keeper remembered an unopened letter.\n@hs\n\nThe traveler walked away.';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const program: PromptProgram = {
  version: 1,
  controls: [
    {
      id: 'style',
      label: 'Style',
      type: 'select',
      options: [
        { label: 'Soft', value: 'soft' },
        { label: 'Precise', value: 'precise' },
      ],
      default: 'soft',
    },
  ],
  blocks: [
    {
      id: 'instructions',
      title: 'Translation',
      kind: 'message',
      role: 'system',
      template: [
        { kind: 'text', text: 'Translate faithfully. Style=' },
        { kind: 'value', expression: { control: 'style' } },
      ],
    },
    { id: 'source', title: 'Requested blocks', kind: 'slot', slot: 'source', role: 'user' },
    {
      id: 'source-cache',
      title: 'Cache source',
      kind: 'cache',
      depth: 1,
      role: 'user',
      policy: 'prefer',
    },
    {
      id: 'receipt',
      title: 'Receipt',
      kind: 'message',
      role: 'assistant',
      template: [{ kind: 'text', text: 'I will preserve the protected tokens.' }],
    },
    { id: 'current', title: 'Translation task', kind: 'current' },
  ],
};
function bundle(sourceText = text): AuxiliaryBundle {
  const source = {
    id: 'native-source',
    chatId: 'native-chat',
    text: sourceText,
    hash: hash(sourceText),
  };
  return {
    job: {
      id: 'native-job',
      kind: 'translation',
      status: 'queued',
      sourceRevision: source.id,
      sourceHash: source.hash,
    },
    source,
    snapshot: {
      sourceSegments: createSourceSegmentFixture(),
      chatId: source.chatId,
      parentRevision: null,
      settingsRevision: 1,
      settings: { preset: 'calm', mode: 'direct', translation: true, status: false, maxCalls: 5 },
      request: 'MAIN_TASK_MUST_NOT_REPLAY',
      history: [],
      logicalHistory: [{ id: 'main-history', role: 'user', text: 'MAIN_HISTORY_MUST_NOT_REPLAY' }],
      resources: [],
      profile: {
        ...defaultProfile(source.chatId),
        revision: 3,
        contents: [],
        models: {},
        promptPresets: {
          translation: {
            id: 'translation-preset',
            revision: 4,
            role: 'translation',
            title: 'Frozen translation',
            program: structuredClone(program),
          },
        },
        promptControls: {
          'translation-preset@4': { values: { style: 'precise' }, combinations: [] },
          'translation-preset@5': { values: { style: 'soft' }, combinations: [] },
        },
      },
    },
  };
}
function echo(plan: TranslationPlan, chunkIndex = 0): TranslationResult {
  const chunk = plan.chunks[chunkIndex];
  return validateTranslationChunk(plan, chunk.id, {
    sourceRevision: plan.sourceRevision,
    sourceHash: plan.sourceHash,
    chunkId: chunk.id,
    segments: chunk.blocks.map((block) => ({ anchors: [block.anchor], text: block.text })),
  });
}
function bridge(seed: AuxiliaryBundle) {
  const state = structuredClone(seed);
  const chunks = new Map<string, AuxiliaryChunkRecord>();
  const outcomes: AuxiliaryOutcome[] = [];
  const store: AuxiliaryStoreBridge = {
    load: () => structuredClone({ ...state, chunks: [...chunks.values()] }),
    claim: (_job, _owner, prepared) => {
      state.plan ??= prepared.plan;
      for (const chunk of prepared.plan?.chunks ?? [])
        if (!chunks.has(chunk.id))
          chunks.set(chunk.id, { id: chunk.id, status: 'queued', attempt: 0, result: null });
      return 1;
    },
    beginChunk: (_job, id) => {
      const chunk = chunks.get(id)!;
      chunk.status = 'running';
      chunk.attempt++;
    },
    completeChunk: (_job, id, _generation, _owner, result) => {
      Object.assign(chunks.get(id)!, { status: 'completed', result: structuredClone(result) });
    },
    failChunk: (_job, id, _generation, _owner, error, status) => {
      Object.assign(chunks.get(id)!, { error, status });
    },
    finish: (_job, _generation, _owner, result) => {
      outcomes.push(structuredClone(result));
    },
  };
  return { store, state, chunks, outcomes };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const hooks = (origin: string): AuxiliaryJobHooks => ({
  signal: new AbortController().signal,
  approvedOrigins: [origin],
  authorize: (connection) => connection,
  onAttemptStart: () => 'native-translation-attempt',
  onAttemptFinish: () => {},
});

describe('native translation prompt and hidden source boundaries', () => {
  test('local scripted translation keeps hidden line boundaries across chunks without altering the source', async () => {
    const sourceText =
      'Main arrival.\n\n@hsTitle: Quiet Tower\n⟦Tower @ Dawn @ Mira⟧\nMira recalls a blue bell.\n@hs\n\nMain crossing.\n\n@hsTitle: Old Letter\nAnother traveler remembers winter.\n@hs\n\nMain departure.';
    const seed = bundle(sourceText);
    const original = structuredClone(seed.source);
    const state = bridge(seed);
    let attempts = 0;
    const options = hooks('http://127.0.0.1:1');
    options.maxChunkChars = 100;
    options.onAttemptStart = () => {
      attempts++;
      return 'unexpected-provider-attempt';
    };
    const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'owner', options);
    expect(state.chunks.size).toBeGreaterThan(1);
    expect(outcome).toMatchObject({
      status: 'completed',
      error: null,
      result: {
        mock: true,
        sourceRevision: seed.source.id,
        sourceHash: seed.source.hash,
        text: sourceText,
      },
    });
    expect(
      validateSegmentTranslation(
        { sourceRevision: seed.source.id, sourceHash: seed.source.hash, text: sourceText },
        outcome!.result!.text!,
        createSourceSegmentFixture()
      ).ok
    ).toBe(true);
    expect(
      parseSourceSegments(
        {
          sourceRevision: seed.source.id,
          sourceHash: seed.source.hash,
          text: outcome!.result!.text!,
        },
        createSourceSegmentFixture()
      ).segments.map((segment) => segment.kind)
    ).toEqual(['main', 'aside', 'main', 'aside', 'main']);
    expect(seed.source).toEqual(original);
    expect(attempts).toBe(0);
    // Plain prose retains the explicit mock label; only structured hidden sources echo.
    const plain = bundle('Plain synthetic source.');
    const plainState = bridge(plain);
    const plainOutcome = await runAuxiliaryJob(plainState.store, plain.job.id, 'owner', options);
    expect(plainOutcome?.result?.text).toBe(
      '[모의 번역 · 의미 품질 미검증] Plain synthetic source.'
    );
  });
  test('protects hidden delimiters, portrait identity and scene separators without omitting prose', () => {
    const seed = bundle();
    const context = sourceTimeContext(seed.snapshot, 'translation');
    const before = JSON.stringify(context);
    const plan = createTranslationPlan(seed.source, context, 100);
    expect(plan.context.protectedLiterals).toEqual(
      expect.arrayContaining([
        '@hsTitle:',
        '@hs',
        '⟦',
        '@',
        '⟧',
        '[hsPortrait: asset:keeper-profile]',
      ])
    );
    const protectedText = plan.chunks
      .flatMap((chunk) => chunk.blocks)
      .map((block) => block.text)
      .join('\n\n');
    expect(protectedText).toContain('The keeper remembered an unopened letter.');
    expect(protectedText).not.toContain('@hsTitle:');
    expect(protectedText).not.toContain('asset:keeper-profile');
    const translated = aggregateTranslation(
      plan,
      plan.chunks.map((_, index) => echo(plan, index))
    )
      .segments.map((segment) => segment.text)
      .join('\n\n');
    expect(translated).toBe(seed.source.text);
    expect(
      validateSegmentTranslation(
        { sourceRevision: seed.source.id, sourceHash: seed.source.hash, text: seed.source.text },
        translated,
        createSourceSegmentFixture()
      ).ok
    ).toBe(true);
    expect(validateTranslationPlan(seed.source, context, plan)).toEqual(plan);
    expect(JSON.stringify(context)).toBe(before);
  });
  test('source-time provenance separates reader text, actor knowledge and world truth as unknown', () => {
    const seed = bundle();
    const plan = createTranslationPlan(
      seed.source,
      sourceTimeContext(seed.snapshot, 'translation')
    );
    const hidden = plan.context.segmentKnowledge!.segments.find(
      (segment) => segment.kind === 'aside'
    )!;
    expect(plan.context.segmentKnowledge).toMatchObject({
      sourceRevision: seed.source.id,
      sourceHash: seed.source.hash,
      provenance: 'source-markers',
    });
    expect(hidden).toMatchObject({
      readerExposure: 'present-in-source',
      worldTruth: 'unknown',
      actorKnowledge: {
        status: 'unknown',
        mode: 'unspecified',
        perspectiveActorIds: null,
        knownByActorIds: null,
        evidence: [],
      },
    });
    expect(hidden.range).toEqual(
      parseSourceSegments(
        {
          sourceRevision: seed.source.id,
          sourceHash: seed.source.hash,
          text: seed.source.text,
        },
        createSourceSegmentFixture()
      ).segments.find((segment) => segment.kind === 'aside')!.range
    );
    const forged = structuredClone(plan);
    forged.context.segmentKnowledge!.segments[0].worldTruth = 'asserted' as 'unknown';
    expect(() =>
      validateTranslationPlan(seed.source, sourceTimeContext(seed.snapshot, 'translation'), forged)
    ).toThrow('SOURCE_TRANSLATION_PLAN_INVALID');
  });
  test('compiles exactly the frozen translation revision, ordered roles/cache and one current task', () => {
    const seed = bundle();
    const plan = createTranslationPlan(
      seed.source,
      sourceTimeContext(seed.snapshot, 'translation')
    );
    const input = translationInput(plan, plan.chunks[0].id, seed.snapshot);
    const compiled = compileTranslationPrompt(input, seed.snapshot, 'Translate this chunk.')!;
    expect(compiled.values).toEqual({ style: 'precise' });
    expect(compiled.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(compiled.messages[0].content[0].text).toBe('Translate faithfully. Style=precise');
    expect(compiled.messages[1].content[0].text).toBe(JSON.stringify(input.blocks));
    expect(
      compiled.messages.filter((message) => message.provenance.origin === 'current')
    ).toHaveLength(1);
    expect(compiled.cachePlan).toEqual([
      { blockId: 'source-cache', afterMessageId: 'source', policy: 'prefer' },
    ]);
    expect(JSON.stringify(compiled)).not.toMatch(
      /MAIN_TASK_MUST_NOT_REPLAY|MAIN_HISTORY_MUST_NOT_REPLAY|LEGACY_FALLBACK_MUST_NOT_OVERRIDE/
    );
    const changed = structuredClone(seed.snapshot);
    changed.profile!.promptPresets!.translation!.revision++;
    expect(() => compileTranslationPrompt(input, changed, 'task')).toThrow(
      'SOURCE_PROMPT_REVISION_MISMATCH'
    );
  });
  test('default and explicit empty instructions use the same program compiler', () => {
    for (const selected of [false, true]) {
      const seed = bundle('The harbor was quiet.');
      if (selected) {
        seed.snapshot.profile!.promptPresets!.translation!.program = createDefaultPromptProgram(
          '',
          'translation'
        );
        delete seed.snapshot.profile!.promptControls;
      } else delete seed.snapshot.profile!.promptPresets;
      const plan = createTranslationPlan(
        seed.source,
        sourceTimeContext(seed.snapshot, 'translation')
      );
      const input = translationInput(plan, plan.chunks[0].id, seed.snapshot);
      expect(input.contract).toBe('');
      const compilation = compileTranslationPrompt(input, seed.snapshot, 'task')!;
      expect(compilation).toBeDefined();
      expect(compilation.messages.some((m) => m.id === 'instructions')).toBe(!selected);
      expect(plan.context).not.toHaveProperty('segmentKnowledge');
    }
  });
  test('invalid frozen program values fail with their prompt code before an attempt is sent', async () => {
    const seed = bundle();
    seed.snapshot.profile!.promptControls!['translation-preset@4'].values.style = 'unrecognized';
    seed.snapshot.profile!.models.translation = {
      id: 'model',
      revision: 1,
      title: 'Fixture',
      modelId: 'fixture',
      connectionId: 'connection',
      maxOutputTokens: 4096,
      temperature: null,
      connection: {
        id: 'connection',
        revision: 1,
        title: 'Fixture',
        protocol: 'fixture-sse-v1',
        endpoint: 'http://127.0.0.1:1',
        enabled: true,
        catalog: [],
        catalogError: null,
      },
    };
    const state = bridge(seed);
    const options = hooks('http://127.0.0.1:1');
    let attempts = 0;
    options.onAttemptStart = () => {
      attempts++;
      return 'unexpected';
    };
    const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'owner', options);
    expect(outcome).toEqual({
      status: 'failed',
      result: null,
      error: 'PROMPT_INVALID_CONTROL_VALUE',
    });
    expect(attempts).toBe(0);
  });
  test('actual loopback requests preserve composed messages across source-time tools and freeze later mutations', async () => {
    const seed = bundle();
    let calls = 0;
    const local = await loopbackProvider(async (request, response) => {
      const body = JSON.parse(request.body);
      calls++;
      if (calls === 1)
        await writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: 'lookup',
            name: 'knowledge.search',
            argumentsDelta: '{"query":"keeper"}',
          },
          { type: 'opaque_state', state: { cursor: 'synthetic-source-time' } },
          { type: 'done', reason: 'tool_calls' },
        ]);
      else {
        const packet = body.input.source;
        await writeSse(response, [
          {
            type: 'text_delta',
            delta: JSON.stringify({
              sourceRevision: packet.sourceRevision,
              sourceHash: packet.sourceHash,
              chunkId: packet.chunkId,
              segments: packet.blocks.map((block: { anchor: string; text: string }) => ({
                anchors: [block.anchor],
                text: block.text,
              })),
            }),
          },
          { type: 'done', reason: 'stop' },
        ]);
      }
    });
    cleanups.push(local.close);
    seed.snapshot.profile!.models.translation = {
      id: 'native-model',
      revision: 1,
      title: 'Fixture',
      modelId: 'fixture-native-translation',
      connectionId: 'native-connection',
      maxOutputTokens: 4096,
      temperature: null,
      connection: {
        id: 'native-connection',
        revision: 1,
        title: 'Fixture',
        protocol: 'fixture-sse-v1',
        endpoint: local.endpoint,
        enabled: true,
        catalog: [],
        catalogError: null,
      },
    };
    const state = bridge(seed);
    const observed: AuxiliaryInput[] = [];
    const options = hooks(local.origin);
    options.onInput = (_job, input) => {
      observed.push(input);
      state.state.snapshot.profile!.promptControls!['translation-preset@4'].values.style = 'soft';
      seed.snapshot.profile!.promptPresets!.translation!.program!.blocks = [];
    };
    const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'owner', options);
    expect(outcome).toMatchObject({
      status: 'completed',
      error: null,
      result: { text, mock: true },
    });
    expect(local.requests).toHaveLength(2);
    const bodies = local.requests.map((request) => JSON.parse(request.body));
    expect(bodies[0].stable.contract).toBe('');
    expect(bodies[0].prompt.values).toEqual({ style: 'precise' });
    expect(bodies[1].prompt).toEqual(bodies[0].prompt);
    expect(bodies[1].opaqueState).toEqual({ cursor: 'synthetic-source-time' });
    expect(bodies[1].input.results[0].callId).toBe('lookup');
    expect(
      observed[0].context.segmentKnowledge!.segments.some((segment) => segment.kind === 'aside')
    ).toBe(true);
  });
  test('a fully mapped result with malformed hidden line placement fails instead of being published completed', async () => {
    const seed = bundle();
    const local = await loopbackProvider(async (request, response) => {
      const packet = JSON.parse(request.body).input.source;
      // All anchors and protected tokens survive, but moving the opening delimiter off
      // its own line invalidates hidden structure. Final assembly must catch this.
      const segments = packet.blocks.map((block: { anchor: string; text: string }) => ({
        anchors: [block.anchor],
        text: block.text.replaceAll('\n', ' '),
      }));
      await writeSse(response, [
        {
          type: 'text_delta',
          delta: JSON.stringify({
            sourceRevision: packet.sourceRevision,
            sourceHash: packet.sourceHash,
            chunkId: packet.chunkId,
            segments,
          }),
        },
        { type: 'done', reason: 'stop' },
      ]);
    });
    cleanups.push(local.close);
    seed.snapshot.profile!.models.translation = {
      id: 'model',
      revision: 1,
      title: 'Fixture',
      modelId: 'fixture',
      connectionId: 'connection',
      maxOutputTokens: 4096,
      temperature: null,
      connection: {
        id: 'connection',
        revision: 1,
        title: 'Fixture',
        protocol: 'fixture-sse-v1',
        endpoint: local.endpoint,
        enabled: true,
        catalog: [],
        catalogError: null,
      },
    };
    const state = bridge(seed);
    const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'owner', hooks(local.origin));
    expect(outcome?.status).toBe('failed');
    expect(outcome?.result).toBeNull();
    expect(outcome?.error).toMatch(/^SEGMENT_/u);
    expect(state.outcomes.every((result) => result.status !== 'completed')).toBe(true);
    expect(seed.source.text).toBe(text);
  });
});
