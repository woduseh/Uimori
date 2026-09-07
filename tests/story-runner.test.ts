import { afterEach, describe, expect, test } from 'vitest';
import { runStoryJob, type StoryHooks, type StoryInput } from '../server/story-runner.js';
import { defaultStoryConfig, type StoryJob, type StorySnapshot } from '../core/story.js';
import { memoryHash } from '../core/memory.js';
import type { RunSnapshot, Source, ToolEvent } from '../core/types.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function fixture(handler: Parameters<typeof loopbackProvider>[0]) { const server = await loopbackProvider(handler); closes.push(server.close); return server; }
function bundle(kind: 'state' | 'memory' = 'state', endpoint?: string, text = 'Mira spent three coins at the harbor.') {
  const source: Source = { id: 'source-1', chatId: 'chat-1', hash: memoryHash(text), text, parentRevision: null, runId: 'run-1' };
  const job: StoryJob = { id: 'job-1', chatId: source.chatId, sourceRevision: source.id, sourceHash: source.hash, kind, configRevision: 1, generation: 1, owner: 'worker', status: 'running', error: null, mock: !endpoint, createdAt: '', updatedAt: '', result: null };
  const story: StorySnapshot = {
    config: { ...defaultStoryConfig(), revision: 1, memory: { enabled: true, model: null, recentCount: 2, maxPacketChars: 60000 }, module: { id: 'coins', revision: 1, name: 'Synthetic coins', mode: 'authoritative', fields: { coins: { type: 'number', initial: 10, min: 0, max: 100, description: 'spend-three subtracts 3' } }, rules: { 'spend-three': { field: 'coins', delta: -3 } } } },
    state: { id: 'initial', sourceRevision: null, sourceHash: null, moduleRevision: 1, values: { coins: 10 }, canonical: true }, waiting: false, lineageHash: 'lineage-1', canonHash: memoryHash('[]'), memory: null,
    models: endpoint ? { [kind]: { id: 'selected', revision: 1, title: 'Synthetic', connectionId: 'conn', connectionRevision: 1, modelId: `fixture-${kind}-selected`, maxOutputTokens: 2048, temperature: null, connection: { id: 'conn', revision: 1, title: 'Fixture', enabled: true, protocol: 'fixture-sse-v1', endpoint, catalog: [], catalogError: null } } } : {},
  };
  const snapshot: RunSnapshot = { chatId: source.chatId, parentRevision: null, settingsRevision: 1, settings: { preset: 'calm', mode: 'direct', translation: false, status: true, maxCalls: 3 }, request: 'Continue', history: [], story,
    resources: [{ id: 'rule-lore', chatId: source.chatId, kind: 'lore', revision: 3, title: 'Coin rules', description: 'Read further guidance', text: 'A coin is a local copper unit.' }, { id: 'hidden', chatId: 'chat-2', kind: 'lore', revision: 1, title: 'HIDDEN_CANARY', description: 'HIDDEN_CANARY', text: 'HIDDEN_CANARY' }] };
  return { source, job, snapshot };
}
function observed(origin = '', extra: Partial<StoryHooks> = {}) {
  const inputs: StoryInput[] = []; const events: ToolEvent[] = []; const attempts: { id: string; wire: WireRecord; result?: ProviderResult }[] = [];
  const hooks: StoryHooks = { signal: new AbortController().signal, approvedOrigins: origin ? [origin] : [], authorize: value => value,
    onInput: input => { inputs.push(input); }, onToolEvent: event => { events.push(event); },
    onAttemptStart: wire => { const id = `attempt-${attempts.length}`; attempts.push({ id, wire }); return id; },
    onAttemptFinish: (id, result) => { attempts.find(attempt => attempt.id === id)!.result = result; }, ...extra };
  return { hooks, inputs, events, attempts };
}
function stateResult(source: Source) { const quote = 'spent three coins'; const start = source.text.indexOf(quote); return { sourceRevision: source.id, sourceHash: source.hash, moduleRevision: 1, operations: [{ id: 'spend-1', kind: 'event', event: 'spend-three', evidence: { start, end: start + quote.length, quote } }] }; }
const finish = (output: unknown): Json[] => [{ type: 'text_delta', delta: JSON.stringify(output) }, { type: 'usage', inputTokens: 11, outputTokens: 7 }, { type: 'done', reason: 'stop' }];

describe('M2 story runner actual localhost request evidence (synthetic, no live provider quality claim)', () => {
  test('S01 actual provider receives original source, rules and previous state; tool results and opaque continuation stay correctly scoped', async () => {
    let count = 0; let auth = 0;
    const server = await fixture(async (request, response) => {
      count++; expect(log.attempts).toHaveLength(count);
      const wire = JSON.parse(request.body);
      expect(wire.role).toBe('state'); expect(wire.modelId).toBe('fixture-state-selected');
      expect(wire.input.source.text).toBe(work.source.text); expect(wire.input.source.previousState).toEqual({ coins: 10 });
      expect(wire.input.source.module.rules['spend-three'].delta).toBe(-3);
      expect(wire.stable.contract).toContain('additionalProperties'); expect(request.body).not.toContain('HIDDEN_CANARY');
      if (count === 1) await writeSse(response, [{ type: 'tool_delta', index: 0, id: 'read-1', name: 'knowledge.read', argumentsDelta: '{"id":"rule-lore"}' }, { type: 'opaque_state', state: { continuation: 'OPAQUE_SECRET_CANARY' } }, { type: 'done', reason: 'tool_calls' }]);
      else {
        expect(wire.input.results[0].result.text).toBe('A coin is a local copper unit.');
        expect(wire.opaqueState.continuation).toBe('OPAQUE_SECRET_CANARY');
        await writeSse(response, finish(stateResult(work.source)));
      }
    });
    const work = bundle('state', server.endpoint); const log = observed(server.origin, { authorize: value => { auth++; return value; } });
    const result = await runStoryJob(work, log.hooks);
    expect(result).toEqual({ status: 'completed', result: stateResult(work.source), error: null, mock: false });
    expect(auth).toBe(2); expect(log.events).toHaveLength(1); expect(log.attempts.every(attempt => attempt.result)).toBe(true);
    expect(JSON.stringify(log)).not.toContain('OPAQUE_SECRET_CANARY'); expect(work.snapshot.story!.state!.values.coins).toBe(10);
  });

  test('S01 provider no-facts empty proposal is preserved without inventing numeric changes', async () => {
    const server = await fixture(async (_request, response) => { await writeSse(response, finish({ sourceRevision: work.source.id, sourceHash: work.source.hash, moduleRevision: 1, operations: [] })); });
    const work = bundle('state', server.endpoint, 'Mira waited.'); const log = observed(server.origin);
    expect((await runStoryJob(work, log.hooks)).result).toMatchObject({ operations: [] }); expect(server.requests).toHaveLength(1);
  });

  test('S03 malformed terminal JSON and invalid evidence preserve usage with no automatic retry', async () => {
    let output = 'not json';
    const server = await fixture(async (_request, response) => { await writeSse(response, [{ type: 'text_delta', delta: output }, { type: 'usage', inputTokens: 11, outputTokens: 7 }, { type: 'done', reason: 'stop' }]); });
    const work = bundle('state', server.endpoint); const log = observed(server.origin);
    expect(await runStoryJob(work, log.hooks)).toMatchObject({ status: 'failed', error: 'STORY_OUTPUT_JSON_INVALID' });
    expect(log.attempts[0].result!.usage.inputTokens).toBe(11); expect(server.requests).toHaveLength(1);
    const invalid = stateResult(work.source); invalid.operations[0].evidence.quote = 'invented'; output = JSON.stringify(invalid);
    expect(await runStoryJob(work, log.hooks)).toMatchObject({ status: 'failed', error: 'STATE_EVIDENCE_QUOTE_INVALID' });
    expect(server.requests).toHaveLength(2);
  });

  test('S03 duplicate calls are rejected before reads; connection revocation and budget block the next fetch', async () => {
    let duplicate = true;
    const server = await fixture(async (_request, response) => { await writeSse(response, [
      { type: 'tool_delta', index: 0, id: 'same', name: 'knowledge.read', argumentsDelta: '{"id":"rule-lore"}' },
      ...(duplicate ? [{ type: 'tool_delta', index: 1, id: 'same', name: 'knowledge.read', argumentsDelta: '{"id":"rule-lore"}' }] : []), { type: 'done', reason: 'tool_calls' }]); });
    const work = bundle('state', server.endpoint); const log = observed(server.origin);
    expect(await runStoryJob(work, log.hooks)).toMatchObject({ result: null, error: 'DUPLICATE_TOOL_ID' }); expect(log.events).toHaveLength(0);
    duplicate = false; let auth = 0;
    const revoked = observed(server.origin, { authorize: value => ({ ...value, enabled: ++auth === 1 }) });
    expect((await runStoryJob(work, revoked.hooks)).error).toBe('CONNECTION_NOT_AUTHORIZED'); expect(revoked.attempts).toHaveLength(1);
    work.snapshot.settings.maxCalls = 1; const budget = observed(server.origin);
    expect((await runStoryJob(work, budget.hooks)).error).toBe('MODEL_CALL_BUDGET_EXHAUSTED'); expect(budget.attempts).toHaveLength(1);
  });

  test('S03 refused provider is terminal and cross-chat read cannot expand scope', async () => {
    let denied = false;
    const server = await fixture(async (_request, response) => { await writeSse(response, denied
      ? [{ type: 'tool_delta', index: 0, id: 'denied', name: 'knowledge.read', argumentsDelta: '{"id":"hidden"}' }, { type: 'done', reason: 'tool_calls' }]
      : [{ type: 'refusal', message: 'Synthetic refusal' }, { type: 'done', reason: 'refusal' }]); });
    const work = bundle('state', server.endpoint); const log = observed(server.origin);
    expect((await runStoryJob(work, log.hooks)).status).toBe('failed'); expect(server.requests).toHaveLength(1);
    denied = true; expect((await runStoryJob(work, log.hooks)).error).toBe('READ_TOOL_DENIED'); expect(server.requests).toHaveLength(2);
    expect(JSON.stringify(log.inputs)).not.toContain('HIDDEN_CANARY');
  });

  test('S03 repeated tool IDs across turns are rejected and uncertain partial output is never replayed', async () => {
    let partial = false;
    const server = await fixture(async (_request, response) => {
      if (partial) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"type":"text_delta","delta":"{partial"}\n\n'); return; }
      await writeSse(response, [{ type: 'tool_delta', index: 0, id: 'repeated', name: 'knowledge.read', argumentsDelta: '{"id":"rule-lore"}' }, { type: 'done', reason: 'tool_calls' }]);
    });
    const work = bundle('state', server.endpoint); const log = observed(server.origin);
    expect((await runStoryJob(work, log.hooks)).error).toBe('DUPLICATE_TOOL_ID'); expect(log.events).toHaveLength(1); expect(server.requests).toHaveLength(2);
    partial = true; const uncertain = observed(server.origin);
    expect(await runStoryJob(work, uncertain.hooks)).toMatchObject({ status: 'interrupted', result: null });
    expect(uncertain.attempts).toHaveLength(1); expect(uncertain.attempts[0].result).toMatchObject({ status: 'partial' }); expect(server.requests).toHaveLength(3);
  });

  test('R03 memory provider returns validated source-bound entries and cannot forge author canon or wrong scope', async () => {
    let mode = 'valid';
    const server = await fixture(async (request, response) => {
      expect(JSON.parse(request.body).role).toBe('memory');
      const entry = { id: 'memory-1', chatId: mode === 'wrong-chat' ? 'chat-2' : work.job.chatId, atRevision: work.source.id, atHash: work.source.hash, text: work.source.text, kind: 'observed-story', sources: [{ revision: work.source.id, hash: work.source.hash, start: 0, end: work.source.text.length, quote: work.source.text }] };
      await writeSse(response, finish({ entries: mode === 'canon' ? [{ id: entry.id, chatId: entry.chatId, atRevision: entry.atRevision, atHash: entry.atHash, text: entry.text, kind: 'author-canon', declaration: { author: 'model', text: entry.text } }] : mode === 'empty' ? [] : [entry] }));
    });
    const work = bundle('memory', server.endpoint); const log = observed(server.origin);
    expect((await runStoryJob(work, log.hooks)).result).toMatchObject({ entries: [{ kind: 'observed-story', atRevision: work.source.id }] });
    mode = 'canon'; expect((await runStoryJob(work, log.hooks)).error).toBe('STORY_MEMORY_OUTPUT_INVALID');
    mode = 'wrong-chat'; expect((await runStoryJob(work, log.hooks)).status).toBe('failed');
    mode = 'empty'; expect((await runStoryJob(work, log.hooks)).result).toEqual({ entries: [] });
  });

  test('S01 R03 mock is explicit: numeric events need literal markers and memory is extractive with safe UTF16 evidence', async () => {
    const log = observed(); const noEvent = bundle();
    expect(await runStoryJob(noEvent, log.hooks)).toMatchObject({ mock: true, result: { operations: [] } });
    const marked = bundle('state', undefined, '[[event:spend-three]] [[event:unknown]]');
    expect((await runStoryJob(marked, log.hooks)).result).toMatchObject({ operations: [{ kind: 'event', event: 'spend-three', evidence: { start: 0, end: 21, quote: '[[event:spend-three]]' } }] });
    const memory = bundle('memory', undefined, `${'a'.repeat(999)}🌙 end`);
    const result = await runStoryJob(memory, log.hooks);
    expect(result).toMatchObject({ mock: true, result: { entries: [{ kind: 'derived-summary', text: 'a'.repeat(999), sources: [{ end: 999 }] }] } });
    expect(log.attempts).toHaveLength(0);
  });

  test('S03 stale source and pre-aborted jobs cannot reach provider or leak abort reason', async () => {
    const work = bundle(); work.job.sourceHash = 'wrong'; const log = observed();
    expect((await runStoryJob(work, log.hooks)).error).toBe('STORY_SOURCE_DEPENDENCY_MISMATCH'); expect(log.inputs).toHaveLength(0);
    const controller = new AbortController(); controller.abort('PRIVATE_ABORT_CANARY');
    expect(await runStoryJob(bundle(), { ...log.hooks, signal: controller.signal })).toEqual({ status: 'interrupted', result: null, error: 'CANCELLED', mock: true });
  });
});
