import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import {
  aggregateTranslation,
  compileTranslationPrompt,
  createTranslationPlan,
  executeAuxiliary,
  translationInput,
  validateTranslationChunk,
  validateTranslationPlan,
  type AuxiliaryInput,
  type TranslationPlan,
  type TranslationResult,
} from '../core/auxiliary.js';
import { defaultProfile } from '../core/product.js';
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function bundle(count = 5): AuxiliaryBundle {
  const text = Array.from(
    { length: count },
    () => 'Mira watched the dark harbor while Captain Arlen waited beside the quiet lighthouse.'
  ).join('\n\n');
  const source = {
    id: 'source-continuity',
    chatId: 'chat-continuity',
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  return {
    job: {
      id: 'job-continuity',
      kind: 'translation',
      status: 'queued',
      sourceRevision: source.id,
      sourceHash: source.hash,
    },
    source,
    snapshot: {
      chatId: source.chatId,
      parentRevision: null,
      settingsRevision: 1,
      settings: { preset: 'calm', mode: 'direct', translation: true, status: false, maxCalls: 8 },
      request: 'Synthetic translation continuity',
      history: [],
      resources: [],
      profile: {
        ...defaultProfile(source.chatId),
        revision: 3,
        contents: [
          {
            id: 'mira',
            revision: 2,
            kind: 'bot',
            title: 'Mira',
            description: 'Known relationship',
            text: 'Mira speaks informally with the traveler, an old friend.',
            loading: 'pinned',
            relatedIds: [],
          },
          {
            id: 'traveler',
            revision: 4,
            kind: 'persona',
            title: 'Traveler',
            description: 'Known relationship',
            text: 'The traveler is an old friend of Mira and chooses their own replies.',
            loading: 'pinned',
            relatedIds: [],
          },
          {
            id: 'names',
            revision: 5,
            kind: 'module',
            title: 'Author names',
            description: 'Preferred form',
            text: 'Captain Arlen = 앨런 선장',
            loading: 'pinned',
            relatedIds: [],
          },
        ],
        models: {},
      },
    },
  };
}
function planFor(seed = bundle()) {
  return createTranslationPlan(seed.source, sourceTimeContext(seed.snapshot, 'translation'), 100);
}
function translated(
  plan: TranslationPlan,
  index: number,
  text = '앨런 선장은 곧 돌아올 거야.'
): TranslationResult {
  return {
    sourceRevision: plan.sourceRevision,
    sourceHash: plan.sourceHash,
    chunkId: plan.chunks[index].id,
    segments: [{ anchors: [...plan.chunks[index].anchors], text }],
  };
}
function bridge(seed: AuxiliaryBundle) {
  const data = structuredClone(seed);
  const chunks = new Map<string, AuxiliaryChunkRecord>();
  let generation = 0;
  const outputs: AuxiliaryOutcome[] = [];
  const owns = (token: number) => {
    if (token !== generation) throw Error('STALE_GENERATION');
  };
  const store: AuxiliaryStoreBridge = {
    load: () => structuredClone({ ...data, chunks: [...chunks.values()] }),
    claim: (_id, _owner, prepared) => {
      generation++;
      if (prepared.plan && !data.plan) {
        data.plan = structuredClone(prepared.plan);
        for (const chunk of prepared.plan.chunks)
          chunks.set(chunk.id, { id: chunk.id, status: 'queued', attempt: 0, result: null });
      }
      return generation;
    },
    beginChunk: (_id, id, token) => {
      owns(token);
      const chunk = chunks.get(id)!;
      chunk.status = 'running';
      chunk.attempt++;
    },
    completeChunk: (_id, id, token, _owner, result) => {
      owns(token);
      Object.assign(chunks.get(id)!, {
        status: 'completed',
        result: structuredClone(result),
        error: null,
      });
    },
    failChunk: (_id, id, token, _owner, error, status) => {
      owns(token);
      Object.assign(chunks.get(id)!, { status, error });
    },
    finish: (_id, token, _owner, outcome) => {
      owns(token);
      outputs.push(structuredClone(outcome));
    },
  };
  return { store, data, chunks, outputs };
}
function selected(seed: AuxiliaryBundle, endpoint: string) {
  seed.snapshot.profile!.models.translation = {
    id: 'model-continuity',
    revision: 1,
    title: 'Synthetic local fixture',
    connectionId: 'connection-continuity',
    modelId: 'fixture-continuity',
    maxOutputTokens: 8192,
    temperature: null,
    connection: {
      id: 'connection-continuity',
      revision: 1,
      title: 'Loopback only',
      protocol: 'fixture-sse-v1',
      endpoint,
      enabled: true,
      catalog: [],
      catalogError: null,
    },
  };
}
function hooks(origin: string): AuxiliaryJobHooks {
  return {
    signal: new AbortController().signal,
    approvedOrigins: [origin],
    authorize: (value) => value,
    onAttemptStart: () => 'synthetic-attempt',
    onAttemptFinish: () => {},
    maxChunkChars: 100,
  };
}
function body(wire: string) {
  const packet = JSON.parse(wire).input.source;
  return {
    sourceRevision: packet.sourceRevision,
    sourceHash: packet.sourceHash,
    chunkId: packet.chunkId,
    segments: packet.blocks.map((block: { anchor: string }) => ({
      anchors: [block.anchor],
      text: '앨런 선장은 곧 돌아올 거야.',
    })),
  };
}

describe('same-source completed translation wording references', () => {
  test('provides the nearest two earlier completed translations with immutable source-time relationships and no plan mutation', () => {
    const seed = bundle();
    const plan = planFor(seed);
    const before = JSON.stringify(plan);
    const completed = plan.chunks.map((_, index) =>
      translated(plan, index, '앨런 선장은 곧 돌아올 거야.')
    );
    const first = translationInput(plan, plan.chunks[0].id, seed.snapshot, completed);
    expect(first.context).not.toHaveProperty('previousTranslation');
    const current = translationInput(plan, plan.chunks[3].id, seed.snapshot, completed);
    expect(current.context.previousTranslation).toEqual({
      sourceRevision: plan.sourceRevision,
      sourceHash: plan.sourceHash,
      chunks: [1, 2].map((index) => ({
        chunkId: plan.chunks[index].id,
        text: completed[index].segments[0].text,
        truncated: false,
      })),
    });
    expect(current.context.bot).toMatchObject({
      id: 'mira',
      revision: 2,
      text: 'Mira speaks informally with the traveler, an old friend.',
    });
    expect(current.context.persona).toMatchObject({ id: 'traveler', revision: 4 });
    expect(current.context.references[0]).toMatchObject({ id: 'names', revision: 5 });
    expect(current.blocks.map((block) => block.anchor)).toEqual(plan.chunks[3].anchors);
    expect(JSON.stringify(plan)).toBe(before);
    expect(
      validateTranslationPlan(seed.source, sourceTimeContext(seed.snapshot, 'translation'), plan)
    ).toEqual(plan);
    completed[1].segments[0].text = '뒤늦게 바뀐 번역';
    seed.snapshot.profile!.contents[0].text = 'LATER_RELATIONSHIP';
    expect(current.context.previousTranslation!.chunks[0].text).toBe('앨런 선장은 곧 돌아올 거야.');
    expect(current.context.bot!.text).not.toContain('LATER_RELATIONSHIP');
  });

  test('limits translated text to six thousand UTF-16 units across at most two chunks without splitting surrogate pairs', () => {
    const seed = bundle();
    const plan = planFor(seed);
    const old = translated(plan, 0, '오래된 번역');
    const one = translated(plan, 1, '앞🌊' + '가'.repeat(2999));
    const two = translated(plan, 2, '나'.repeat(4000));
    const input = translationInput(plan, plan.chunks[3].id, seed.snapshot, [old, one, two]);
    const references = input.context.previousTranslation!.chunks;
    expect(references.map((item) => item.chunkId)).toEqual([one.chunkId, two.chunkId]);
    expect(references.every((item) => item.truncated)).toBe(true);
    expect(references.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(6000);
    expect(references[0].text).toBe('가'.repeat(2999));
    expect(references[1].text).toBe('나'.repeat(3000));
  });

  test('rejects different-source, duplicate or mismatched-anchor references and excludes valid current or future results', () => {
    const seed = bundle();
    const plan = planFor(seed);
    const result = translated(plan, 0);
    for (const invalid of [
      { ...result, sourceRevision: 'another-source' },
      { ...result, sourceHash: 'another-hash' },
      { ...result, chunkId: 'unknown-chunk' },
      { ...result, segments: [{ anchors: plan.chunks[1].anchors, text: '같은 문장' }] },
    ])
      expect(() => translationInput(plan, plan.chunks[1].id, seed.snapshot, [invalid])).toThrow(
        'SOURCE_DEPENDENCY_MISMATCH'
      );
    expect(() =>
      translationInput(plan, plan.chunks[1].id, seed.snapshot, [result, result])
    ).toThrow('DUPLICATE_CHUNK_RESULT');
    const input = translationInput(plan, plan.chunks[1].id, seed.snapshot, [
      result,
      translated(plan, 1, '현재 구간'),
      translated(plan, 2, '미래 구간'),
    ]);
    expect(input.context.previousTranslation!.chunks).toEqual([
      { chunkId: result.chunkId, text: '앨런 선장은 곧 돌아올 거야.', truncated: false },
    ]);
    expect(() =>
      validateTranslationChunk(plan, plan.chunks[1].id, {
        ...translated(plan, 1),
        segments: [...result.segments, ...translated(plan, 1).segments],
      })
    ).toThrow('CHUNK_COVERAGE_INVALID');
  });

  test('holds the same reference through read-tool continuation and keeps canonical facts above translated wording', async () => {
    const seed = bundle();
    const plan = planFor(seed);
    const input = translationInput(plan, plan.chunks[1].id, seed.snapshot, [translated(plan, 0)]);
    const observed: AuxiliaryInput[] = [];
    const output = await executeAuxiliary(input, seed.snapshot, async (packet) => {
      observed.push(structuredClone(packet));
      if (!packet.results.length) {
        input.context.previousTranslation!.chunks[0].text = '나중에 변경된 외부 사본';
        return {
          kind: 'tool',
          action: { callId: 'search', name: 'knowledge.search', args: { query: 'Captain Arlen' } },
        };
      }
      return translated(plan, 1);
    });
    expect(output.modelCalls).toBe(2);
    expect(observed[1].context.previousTranslation).toEqual(
      observed[0].context.previousTranslation
    );
    expect(observed[0].context.references[0].text).toBe('Captain Arlen = 앨런 선장');
    expect(input.contract).toBe('');
    const instructions = compileTranslationPrompt(input, seed.snapshot, 'Translate this chunk.')!
      .messages[0].content[0].text;
    expect(instructions).toContain('source-time references take precedence');
    expect(instructions).toContain('never repeat reference passages');
  });

  test('sends already persisted earlier wording to subsequent chunks without extra planning calls', async () => {
    const server = await loopbackProvider(async (request, response) => {
      await writeSse(response, [
        { type: 'text_delta', delta: JSON.stringify(body(request.body)) },
        { type: 'done', reason: 'stop' },
      ]);
    });
    cleanups.push(server.close);
    const seed = bundle(3);
    selected(seed, server.endpoint);
    const state = bridge(seed);
    const before = JSON.stringify(seed.source);
    const outcome = await runAuxiliaryJob(
      state.store,
      seed.job.id,
      'first-owner',
      hooks(server.origin)
    );
    expect(outcome?.status).toBe('completed');
    expect(server.requests).toHaveLength(3);
    const packets = server.requests.map((request) => JSON.parse(request.body).input.source);
    expect(packets[0].context).not.toHaveProperty('previousTranslation');
    expect(
      packets[1].context.previousTranslation.chunks.map((item: { chunkId: string }) => item.chunkId)
    ).toEqual([packets[0].chunkId]);
    expect(
      packets[2].context.previousTranslation.chunks.map((item: { chunkId: string }) => item.chunkId)
    ).toEqual([packets[0].chunkId, packets[1].chunkId]);
    expect(packets[1].context.previousTranslation.chunks[0].text).toBe(
      '앨런 선장은 곧 돌아올 거야.'
    );
    expect(JSON.stringify(seed.source)).toBe(before);
    expect(state.data.plan!.context).not.toHaveProperty('previousTranslation');
    expect(
      aggregateTranslation(
        state.data.plan!,
        [...state.chunks.values()].map((item) => item.result!)
      ).status
    ).toBe('completed');
  });

  test('failed-chunk retry uses only earlier successes and preserves future completed siblings byte-for-byte', async () => {
    let failMiddle = 3;
    const server = await loopbackProvider(async (request, response) => {
      const output = body(request.body);
      if (output.chunkId.endsWith('-1') && failMiddle) {
        failMiddle--;
        output.segments = [];
      }
      await writeSse(response, [
        { type: 'text_delta', delta: JSON.stringify(output) },
        { type: 'done', reason: 'stop' },
      ]);
    });
    cleanups.push(server.close);
    const seed = bundle(3);
    selected(seed, server.endpoint);
    const state = bridge(seed);
    const options = hooks(server.origin);
    expect((await runAuxiliaryJob(state.store, seed.job.id, 'first-owner', options))?.status).toBe(
      'partial'
    );
    const prior = [...state.chunks.values()]
      .filter((item) => item.status === 'completed')
      .map((item) => structuredClone(item));
    const originalPlan = JSON.stringify(state.data.plan);
    const originalSource = JSON.stringify(seed.source);
    expect((await runAuxiliaryJob(state.store, seed.job.id, 'retry-owner', options))?.status).toBe(
      'completed'
    );
    expect(server.requests).toHaveLength(6);
    const packets = server.requests.map((request) => JSON.parse(request.body).input.source);
    expect(packets[5].chunkId).toBe(packets[1].chunkId);
    expect(
      packets[5].context.previousTranslation.chunks.map((item: { chunkId: string }) => item.chunkId)
    ).toEqual([packets[0].chunkId]);
    expect(
      packets[4].context.previousTranslation.chunks.map((item: { chunkId: string }) => item.chunkId)
    ).toEqual([packets[0].chunkId]);
    for (const earlier of prior) expect(state.chunks.get(earlier.id)).toEqual(earlier);
    expect([...state.chunks.values()].map((item) => item.attempt)).toEqual([1, 4, 1]);
    expect(JSON.stringify(state.data.plan)).toBe(originalPlan);
    expect(JSON.stringify(seed.source)).toBe(originalSource);
  });
});
