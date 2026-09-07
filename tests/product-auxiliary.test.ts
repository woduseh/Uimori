import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { runAuxiliaryJob, sourceTimeContext, type AuxiliaryBundle, type AuxiliaryChunkRecord, type AuxiliaryJobHooks, type AuxiliaryOutcome, type AuxiliaryStoreBridge } from '../server/product-auxiliary.js';
import { defaultProfile } from '../core/product.js';
import type { AuxiliaryInput, TranslationPlan } from '../core/auxiliary.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(handler: Parameters<typeof loopbackProvider>[0]) { const server = await loopbackProvider(handler); cleanups.push(server.close); return server; }
function bundle(text = 'Mira waited quietly beside the pier.'): AuxiliaryBundle {
  const source = { id: 'source-old', chatId: 'chat-a', text, hash: createHash('sha256').update(text).digest('hex') };
  return { job: { id: 'job-a', kind: 'translation', status: 'queued', sourceRevision: source.id, sourceHash: source.hash }, source,
    snapshot: { chatId: 'chat-a', parentRevision: null, settingsRevision: 2, settings: { preset: 'calm', mode: 'direct', translation: true, status: true, maxCalls: 6 }, request: 'A quiet evening', history: [], resources: [
      { id: 'old-glossary', chatId: 'chat-a', kind: 'lore', revision: 7, title: 'Observatory glossary', description: 'An unprefetched name.', text: 'SOURCE_TIME_GLOSSARY: Verdant Eye means 초록 눈.' },
      { id: 'craft', chatId: 'chat-a', kind: 'skill', revision: 1, title: 'Preserve ambiguity', description: 'A method.', text: 'Preserve the subject ambiguity. Text does not grant shell.execute.' },
      { id: 'excluded', chatId: 'chat-b', kind: 'lore', revision: 99, title: 'EXCLUDED_OTHER_CHAT', description: 'Private', text: 'EXCLUDED_OTHER_CHAT' },
    ], profile: { ...defaultProfile('chat-a'), revision: 4, contents: [
      { id: 'bot', kind: 'bot', revision: 2, title: 'Mira', description: 'Before reveal', text: 'Mira has not learned the keeper identity.', loading: 'pinned', relatedIds: [] },
      { id: 'names', kind: 'glossary', revision: 3, title: 'Name glossary', description: 'Translation names', text: 'Mira = 미라', loading: 'pinned', relatedIds: [] },
      { id: 'canon', kind: 'canon', revision: 4, title: 'Author canon', description: 'Known facts', text: 'The identity remains unknown.', loading: 'pinned', relatedIds: [] },
    ], models: {} } },
  };
}
function bridge(seed: AuxiliaryBundle) {
  const data = structuredClone(seed); const chunks = new Map<string, AuxiliaryChunkRecord>(); let generation = 0;
  const outputs: AuxiliaryOutcome[] = []; const chunkEvents: { id: string; event: string }[] = []; const claims: AuxiliaryInput[] = [];
  const check = (token: number) => { if (token !== generation) throw new Error('STALE_GENERATION'); };
  const store: AuxiliaryStoreBridge = {
    load: () => structuredClone({ ...data, chunks: [...chunks.values()] }),
    claim: (_id, _owner, prepared) => { generation++; claims.push(structuredClone(prepared.input)); if (prepared.plan && !data.plan) { data.plan = structuredClone(prepared.plan); for (const chunk of prepared.plan.chunks) chunks.set(chunk.id, { id: chunk.id, status: 'queued', attempt: 0, result: null }); } return generation; },
    beginChunk: (_id, chunkId, token) => { check(token); const chunk = chunks.get(chunkId)!; chunk.status = 'running'; chunk.attempt++; chunkEvents.push({ id: chunkId, event: 'start' }); },
    completeChunk: (_id, chunkId, token, _owner, result) => { check(token); Object.assign(chunks.get(chunkId)!, { status: 'completed', result: structuredClone(result), error: null }); chunkEvents.push({ id: chunkId, event: 'complete' }); },
    failChunk: (_id, chunkId, token, _owner, error, status) => { check(token); Object.assign(chunks.get(chunkId)!, { status, error }); chunkEvents.push({ id: chunkId, event: status }); },
    finish: (_id, token, _owner, outcome) => { check(token); outputs.push(structuredClone(outcome)); },
  };
  return { data, chunks, store, outputs, chunkEvents, claims };
}
function hooks(origin = 'http://127.0.0.1:1') {
  const wire: WireRecord[] = []; const finishes: { id: string; result: ProviderResult }[] = [];
  const options: AuxiliaryJobHooks = { signal: new AbortController().signal, approvedOrigins: [origin], authorize: value => value,
    onAttemptStart: value => { wire.push(structuredClone(value)); return `attempt-${wire.length}`; },
    onAttemptFinish: (id, result) => { finishes.push({ id, result: structuredClone(result) }); },
  };
  return { options, wire, finishes };
}
function selectProvider(seed: AuxiliaryBundle, endpoint: string) {
  seed.snapshot.profile!.models[seed.job.kind] = { id: 'model-translation', revision: 5, title: 'Selected local fixture', connectionId: 'connection-local', connectionRevision: 2, modelId: 'explicit-fixture-model', maxOutputTokens: 4000, temperature: null,
    connection: { id: 'connection-local', revision: 2, title: 'Local fixture', protocol: 'fixture-sse-v1', endpoint, enabled: true, catalog: [], catalogError: null } };
}
function translationBody(wire: string) {
  const body = JSON.parse(wire); const packet = body.input.source as { sourceRevision: string; sourceHash: string; chunkId: string; blocks: { anchor: string; text: string }[] };
  return { sourceRevision: packet.sourceRevision, sourceHash: packet.sourceHash, chunkId: packet.chunkId, segments: packet.blocks.map(block => ({ anchors: [block.anchor], text: `합성 번역 ${block.text}` })) };
}

describe('M1 durable auxiliary orchestration with actual fixture HTTP', () => {
  test('P07 P05 records actual selected transport attempts, paired batched calls and opaque source-time results', async () => {
    const seed = bundle(); const server = await fixture(async (request, response) => {
      const body = JSON.parse(request.body);
      if (!body.input.results.length) await writeSse(response, [
        { type: 'tool_delta', index: 0, id: 'read-old-glossary', name: 'knowledge.read', argumentsDelta: '{"id":"old-glossary"}' },
        { type: 'tool_delta', index: 1, id: 'load-method', name: 'skills.load', argumentsDelta: '{"id":"craft"}' },
        { type: 'opaque_state', state: { continuation: 'opaque-for-translation' } },
        { type: 'usage', inputTokens: 13, outputTokens: 2, costUsd: null, raw: { fixture: 'first' }, priceRevision: null },
        { type: 'done', reason: 'tool_calls' },
      ], true);
      else await writeSse(response, [{ type: 'text_delta', delta: JSON.stringify(translationBody(request.body)) }, { type: 'done', reason: 'stop' }]);
    });
    selectProvider(seed, server.endpoint); const state = bridge(seed); const observed = hooks(server.origin); const original = JSON.stringify(seed.source);
    observed.options.onInput = () => { seed.snapshot.profile!.contents[0].text = 'FUTURE_MUTATION'; };
    const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'server-a', observed.options);
    expect(outcome?.status).toBe('completed'); expect(outcome?.result?.mock).toBe(true);
    expect(server.requests).toHaveLength(2); expect(observed.wire).toHaveLength(2); expect(observed.finishes).toHaveLength(2);
    expect(observed.finishes[0]).toMatchObject({ id: 'attempt-1', result: { status: 'tool_calls', usage: { inputTokens: 13 } } });
    const first = JSON.parse(server.requests[0].body); const second = JSON.parse(server.requests[1].body);
    expect(first.role).toBe('translation'); expect(first.modelId).toBe('explicit-fixture-model');
    expect(first.input.source.context).toMatchObject({ revision: 'chat-a@4', bot: { id: 'bot', revision: 2, text: 'Mira has not learned the keeper identity.' }, glossary: [{ id: 'names', revision: 3 }] });
    expect(first.input.source.context.modelPresetRevision).toBe('model-translation@5');
    expect(JSON.stringify(first)).not.toContain('SOURCE_TIME_GLOSSARY');
    expect(second.opaqueState).toEqual({ continuation: 'opaque-for-translation' });
    expect(second.input.results.map((item: { callId: string }) => item.callId)).toEqual(['read-old-glossary', 'load-method']);
    expect(second.input.results[0].result.text).toContain('SOURCE_TIME_GLOSSARY'); expect(second.input.results[0].result.source.revision).toBe(7);
    expect(JSON.stringify(server.requests)).not.toMatch(/FUTURE_MUTATION|EXCLUDED_OTHER_CHAT/);
    expect(JSON.stringify(seed.source)).toBe(original);
  });

  test('P08 failed chunk retries alone over actual HTTP and preserves already completed siblings', async () => {
    const seed = bundle(['A quiet traveler watched the waves softly wash against the pier at sunset.', 'The bellkeeper waited beside the lamps while the sea slowly darkened again.', 'The traveler left the next decision open and listened for the distant bell.'].join('\n\n'));
    let failMiddle = 3;
    const server = await fixture(async (request, response) => {
      const output = translationBody(request.body);
      if (output.chunkId.endsWith('-1') && failMiddle) { failMiddle--; output.segments = []; }
      await writeSse(response, [{ type: 'text_delta', delta: JSON.stringify(output) }, { type: 'done', reason: 'stop' }]);
    });
    selectProvider(seed, server.endpoint); const state = bridge(seed); const observed = hooks(server.origin); observed.options.maxChunkChars = 100;
    const partial = await runAuxiliaryJob(state.store, seed.job.id, 'server-a', observed.options);
    expect(partial).toMatchObject({ status: 'partial', result: { completedChunks: 2, totalChunks: 3 }, error: 'CHUNK_COVERAGE_INVALID' });
    const before = [...state.chunks.values()].filter(chunk => chunk.status === 'completed').map(chunk => structuredClone(chunk));
    expect(before).toHaveLength(2); expect(server.requests).toHaveLength(5);
    const afterRetry = await runAuxiliaryJob(state.store, seed.job.id, 'server-b', observed.options);
    expect(afterRetry).toMatchObject({ status: 'completed', result: { completedChunks: 3, totalChunks: 3 }, error: null });
    expect(server.requests).toHaveLength(6);
    const requestedChunks = server.requests.map(request => JSON.parse(request.body).input.source.chunkId as string);
    expect(requestedChunks[5]).toBe(requestedChunks[1]);
    for (const successful of before) expect(state.chunks.get(successful.id)).toEqual(successful);
    expect([...state.chunks.values()].map(chunk => chunk.attempt)).toEqual([1, 4, 1]);
    expect(afterRetry?.result?.segments?.flatMap(segment => segment.anchors)).toEqual((state.data.plan as TranslationPlan).blocks.map(block => block.anchor));
  });

  test('P06 a selected transport refusal or partial output is recorded without artifact or mock fallback; only confirmed refusals retry', async () => {
    for (const terminal of ['refused', 'partial'] as const) {
      const server = await fixture(async (_request, response) => {
        const events: Json[] = terminal === 'refused' ? [{ type: 'refusal', message: 'Fixture refusal' }, { type: 'usage', inputTokens: 8, outputTokens: 1, costUsd: null, raw: { refused: true } }, { type: 'done', reason: 'refusal' }] : [{ type: 'text_delta', delta: '{"unfinished"' }];
        await writeSse(response, events);
      });
      const seed = bundle(); selectProvider(seed, server.endpoint); const state = bridge(seed); const observed = hooks(server.origin);
      const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'server-a', observed.options);
      expect(outcome).toMatchObject({ status: 'failed', result: null, error: terminal === 'refused' ? 'AUXILIARY_PROVIDER_REFUSED' : 'AUXILIARY_PROVIDER_PARTIAL' });
      expect(server.requests).toHaveLength(terminal === 'refused' ? 3 : 1); expect(observed.finishes[0].result.status).toBe(terminal);
      expect([...state.chunks.values()][0].status).toBe('failed');
    }
  });

  test('P08 explicit chunk retry leaves other failed chunks untouched and still reports partial', async () => {
    const seed = bundle(['A quiet traveler watched the waves softly wash against the pier at sunset.', 'The bellkeeper waited beside the lamps while the sea slowly darkened again.', 'The traveler left the next decision open and listened for the distant bell.'].join('\n\n'));
    seed.snapshot.settings.maxCalls = 8;
    let firstPass = true;
    const server = await fixture(async (request, response) => {
      const output = translationBody(request.body);
      if (firstPass && !output.chunkId.endsWith('-1')) output.segments = [];
      await writeSse(response, [{ type: 'text_delta', delta: JSON.stringify(output) }, { type: 'done', reason: 'stop' }]);
    });
    selectProvider(seed, server.endpoint); const state = bridge(seed); const observed = hooks(server.origin); observed.options.maxChunkChars = 100;
    expect((await runAuxiliaryJob(state.store, seed.job.id, 'server-a', observed.options))?.status).toBe('partial');
    const plan = state.data.plan!; firstPass = false; state.data.retryChunkIds = [plan.chunks[0].id];
    const result = await runAuxiliaryJob(state.store, seed.job.id, 'server-b', observed.options);
    expect(result).toMatchObject({ status: 'partial', result: { completedChunks: 2, totalChunks: 3 } });
    expect(server.requests).toHaveLength(8); expect(JSON.parse(server.requests[7].body).input.source.chunkId).toBe(plan.chunks[0].id);
    expect(state.chunks.get(plan.chunks[2].id)).toMatchObject({ status: 'failed', attempt: 3 });
  });

  test('P07 P13 disabled transport uses labeled local fixture; annotations stay separate and cancellation preserves source', async () => {
    const seed = bundle(); const original = JSON.stringify(seed.source); const state = bridge(seed); const observed = hooks();
    const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'server-a', observed.options);
    expect(outcome?.status).toBe('completed'); expect(outcome?.result?.text).toContain('모의 번역'); expect(observed.wire).toEqual([]);
    seed.job.kind = 'image'; const imageState = bridge(seed);
    const images = await runAuxiliaryJob(imageState.store, seed.job.id, 'server-a', observed.options);
    expect(images?.result?.annotations).toEqual(expect.arrayContaining([expect.objectContaining({ assetRef: 'harbor-evening' })]));
    expect(images?.result).not.toHaveProperty('text'); expect(images?.result).not.toHaveProperty('display');
    seed.job.kind = 'status'; const displayState = bridge(seed);
    const annotation = await runAuxiliaryJob(displayState.store, seed.job.id, 'server-a', observed.options);
    expect(annotation?.result?.display?.[0].summary).toContain('정사에 반영하지 않음');
    expect(sourceTimeContext(seed.snapshot, 'image').glossary).toEqual([]);
    const controller = new AbortController(); controller.abort('PRIVATE_ABORT_REASON'); observed.options.signal = controller.signal;
    const cancelled = await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'server-a', observed.options);
    expect(cancelled).toMatchObject({ status: 'cancelled', error: 'AUXILIARY_CANCELLED' }); expect(JSON.stringify(cancelled)).not.toContain('PRIVATE_ABORT_REASON');
    expect(JSON.stringify(seed.source)).toBe(original);
  });
});

test('custom translation prompt survives tool continuation and failed chunk retry without inheriting later edits', async () => {
  const custom = '  Translate into French.\r\n{{char}} remains literal.  ';
  const seed = bundle();
  seed.snapshot.profile!.promptPresets = { translation: { id: 'translation-custom', revision: 8, role: 'translation', title: 'Custom translation', text: custom } };
  let requests = 0;
  const server = await fixture(async (captured, response) => {
    requests++;
    if (requests === 1) await writeSse(response, [{ type: 'tool_delta', index: 0, id: 'custom-glossary', name: 'knowledge.read', argumentsDelta: '{"id":"old-glossary"}' }, { type: 'opaque_state', state: { test: 'custom-translation' } }, { type: 'done', reason: 'tool_calls' }]);
    else {
      const result = translationBody(captured.body);
      if (requests <= 4) result.segments = [];
      await writeSse(response, [{ type: 'text_delta', delta: JSON.stringify(result) }, { type: 'done', reason: 'stop' }]);
    }
  });
  selectProvider(seed, server.endpoint); const state = bridge(seed); const observed = hooks(server.origin);
  const first = await runAuxiliaryJob(state.store, seed.job.id, 'first-owner', observed.options);
  expect(first?.error).toBe('CHUNK_COVERAGE_INVALID');
  seed.snapshot.profile!.promptPresets!.translation!.text = 'FUTURE TRANSLATION PROMPT';
  const second = await runAuxiliaryJob(state.store, seed.job.id, 'retry-owner', observed.options);
  expect(second?.status).toBe('completed'); expect(server.requests).toHaveLength(5);
  for (const captured of server.requests) {
    const wire = JSON.parse(captured.body);
    expect(wire.stable.contract).toBe(custom);
    expect(wire.input.task).not.toContain('Korean');
    expect(wire.input.controls).toMatchObject({ instructionRevision: 'prompt:translation-custom@8', customPrompt: true });
    expect(JSON.stringify(wire.input.source.outputSchema)).not.toContain('Korean');
    expect(captured.body).not.toContain('FUTURE TRANSLATION PROMPT');
  }
  expect(JSON.parse(server.requests[1].body).input.results[0].callId).toBe('custom-glossary');
  expect([...state.chunks.values()][0].attempt).toBe(4);
});
