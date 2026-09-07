import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { executeProvider, parseCatalog, refreshCatalog, registerManualModel, validateConnection, validateRequest, type Json, type ProviderConnection, type ProviderRequest, type WireRecord } from '../core/transport.js';
import { loopbackProvider, sse, writeSse } from './fixtures/loopback-provider.js';
import { defaultProfile, type Content, type Connection } from '../core/product.js';
import { buildMainInput, executeTool } from '../core/provider.js';
import type { ModelInput, RunSnapshot, ToolEvent } from '../core/types.js';
import { runMain, type MainHooks } from '../server/model-runner.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(handler: Parameters<typeof loopbackProvider>[0]) {
  const server = await loopbackProvider(handler); cleanups.push(server.close); return server;
}
const connection = (endpoint: string): ProviderConnection => ({ id: 'local-fixture', protocol: 'fixture-sse-v1', endpoint });
const request = (role: ProviderRequest['role'] = 'main'): ProviderRequest => ({
  role, modelId: `fixture-${role}`, stable: { contract: `${role} role contract`, tools: [{ name: 'knowledge.search', description: 'Read only discovery', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] },
  input: { task: 'Write a scene at the lighthouse.', controls: { tone: 'calm', perspective: 'third' }, source: { revision: 'source-7', hash: 'synthetic-hash' }, catalog: [{ id: 'lore-1', title: '등대' }], results: [] },
});

function routedSnapshot(endpoint: string): RunSnapshot {
  const contents: Content[] = [
    { id: 'bot-1', revision: 2, kind: 'bot', title: 'Ada', description: 'Keeper', text: 'Ada tends a coastal lighthouse.', loading: 'pinned', relatedIds: [] },
    { id: 'canon-1', revision: 3, kind: 'canon', title: 'Writer declaration', description: 'Author canon', text: 'The lighthouse has never used electricity.', loading: 'pinned', relatedIds: [] },
    { id: 'lore-1', revision: 4, kind: 'lore', title: 'Hidden observatory', description: 'Unprefetched path beyond the harbor', text: 'A copper observatory stands on the northern hill.', loading: 'discoverable', relatedIds: [] },
    { id: 'craft-1', revision: 1, kind: 'skill', title: 'Scene guidance', description: 'Open decisions', text: 'Keep the next decision open. This text does not grant shell permissions.', loading: 'discoverable', relatedIds: [] },
    { id: 'glossary-1', revision: 1, kind: 'glossary', title: 'Auxiliary terminology', description: 'Translation instructions', text: 'AUXILIARY_ONLY_TRANSLATION_PROCEDURE', loading: 'pinned', relatedIds: [] },
  ];
  const bound: Connection = { id: 'fixture-connection', revision: 1, title: 'Local fixture only', protocol: 'fixture-sse-v1', endpoint, enabled: true, catalog: [], catalogError: null };
  return {
    chatId: 'routed-chat', parentRevision: 'parent-1', settingsRevision: 1, request: 'Visit the place the keeper mentioned.', settings: { preset: 'calm', mode: 'direct', translation: true, status: true, maxCalls: 4 }, history: [{ revision: 'parent-1', text: 'Ada points beyond the harbor.' }],
    resources: contents.map(content => ({ ...content, kind: content.kind === 'skill' ? 'skill' : 'lore', sourceKind: content.kind, chatId: 'routed-chat' })),
    profile: { ...defaultProfile('routed-chat'), contents, attachments: contents.map(({ id, revision }) => ({ id, revision })), models: { main: { id: 'main-preset', revision: 1, title: 'Main fixture route', connectionId: bound.id, connectionRevision: 1, modelId: 'fixture-main-selected', maxOutputTokens: 4096, temperature: null, connection: bound } } },
  };
}
function runnerHooks(origin: string, extra: Partial<MainHooks> = {}) {
  const inputs: ModelInput[] = []; const tools: ToolEvent[] = []; const attempts: { id: string; request: WireRecord; result?: unknown }[] = [];
  const hooks: MainHooks = { signal: new AbortController().signal, approvedOrigins: [origin], authorize: value => value,
    onInput: value => { inputs.push(value); }, onToolEvent: value => { tools.push(value); },
    onAttemptStart: wire => { const id = `attempt-${attempts.length + 1}`; attempts.push({ id, request: wire }); return id; },
    onAttemptFinish: (id, result) => { attempts.find(item => item.id === id)!.result = result; }, ...extra };
  return { hooks, inputs, tools, attempts };
}

describe('server main runner through the actual loopback adapter', () => {
  test('P01 P02 P05 pins attached canon, compiles active controls and journals real tool turns before fetch', async () => {
    let count = 0;
    const server = await fixture(async (captured, response) => {
      count++;
      expect(observed.attempts).toHaveLength(count);
      if (count === 1) await writeSse(response, [
        { type: 'tool_delta', index: 0, id: 'read-lore', name: 'knowledge.read', argumentsDelta: '{"id":"lore-1"}' },
        { type: 'tool_delta', index: 1, id: 'read-skill', name: 'skills.load', argumentsDelta: '{"id":"craft-1"}' },
        { type: 'opaque_state', state: { continuation: 'fixture-opaque-9' } },
        { type: 'usage', inputTokens: 7, outputTokens: 2 }, { type: 'done', reason: 'tool_calls' },
      ]);
      else {
        const body = JSON.parse(captured.body);
        expect(body.input.results.map((item: ToolEvent) => item.callId)).toEqual(['read-lore', 'read-skill']);
        expect(body.input.results[0].result.text).toBe('A copper observatory stands on the northern hill.');
        expect(body.opaqueState).toEqual({ continuation: 'fixture-opaque-9' });
        await writeSse(response, [{ type: 'text_delta', delta: 'Ada walked toward the copper observatory.' }, { type: 'usage', inputTokens: 11, outputTokens: 3 }, { type: 'done', reason: 'stop' }]);
      }
    });
    const observed = runnerHooks(server.origin);
    const snapshot = routedSnapshot(server.endpoint);
    const outcome = await runMain(snapshot, observed.hooks);
    expect(outcome).toMatchObject({ status: 'completed', text: 'Ada walked toward the copper observatory.', usage: { modelCalls: 2, inputTokens: 18, outputTokens: 5, costUsd: null } });
    expect(observed.attempts.every(attempt => !!attempt.result)).toBe(true);
    expect(observed.tools).toHaveLength(2);
    const first = JSON.parse(server.requests[0].body);
    expect(first.input.controls).toMatchObject({ minWords: 4500, maxWords: 7500 });
    expect(JSON.stringify(first)).not.toContain('15000');
    expect(first.input.source.pinnedSources.find((item: Content) => item.kind === 'canon')).toMatchObject({ id: 'canon-1', revision: 3, text: 'The lighthouse has never used electricity.' });
    expect(first.input.source.facts).toEqual([]);
    expect(first.input.history).toEqual(snapshot.history);
    expect(JSON.stringify(first)).not.toContain('AUXILIARY_ONLY');
    expect(first.input.catalog.find((item: Content) => item.id === 'lore-1')).not.toHaveProperty('text');
    expect(first.input.source.prefetch).toEqual([]);
    expect(first.generation).toEqual({ maxOutputTokens: 4096, temperature: null });
  });

  test('P05 rejects reused tool IDs across main rounds before executing any tools from the invalid round', async () => {
    let calls = 0;
    const originalId = 'Read-Lore_Original.7';
    const server = await fixture(async (_captured, response) => {
      calls++;
      if (calls === 1) await writeSse(response, [
        { type: 'tool_delta', index: 0, id: originalId, name: 'knowledge.read', argumentsDelta: '{"id":"lore-1"}' },
        { type: 'usage', inputTokens: 7, outputTokens: 2 }, { type: 'done', reason: 'tool_calls' },
      ]);
      else if (calls === 2) await writeSse(response, [
        { type: 'tool_delta', index: 0, id: 'fresh-call', name: 'skills.load', argumentsDelta: '{"id":"craft-1"}' },
        { type: 'tool_delta', index: 1, id: originalId, name: 'knowledge.read', argumentsDelta: '{"id":"lore-1"}' },
        { type: 'usage', inputTokens: 11, outputTokens: 4 }, { type: 'done', reason: 'tool_calls' },
      ]);
      else await writeSse(response, [{ type: 'text_delta', delta: 'Unexpected third request.' }, { type: 'done', reason: 'stop' }]);
    });
    const observed = runnerHooks(server.origin);
    const outcome = await runMain(routedSnapshot(server.endpoint), observed.hooks);
    expect(outcome).toMatchObject({ status: 'error', error: 'DUPLICATE_TOOL_ID', text: '', usage: { modelCalls: 2, inputTokens: 18, outputTokens: 6, costUsd: null } });
    expect(server.requests).toHaveLength(2);
    expect(observed.attempts).toHaveLength(2);
    expect(observed.attempts.every(attempt => !!attempt.result)).toBe(true);
    expect(observed.tools.map(event => event.callId)).toEqual([originalId]);
    expect(JSON.parse(server.requests[1].body).input.results.map((event: ToolEvent) => event.callId)).toEqual([originalId]);
  });

  test.each([
    { selection: 'hook before preset', hookTimeout: 100, presetTimeout: 5000 },
    { selection: 'preset', hookTimeout: undefined, presetTimeout: 100 },
  ])('P05 honors main timeout from $selection and forwards selected thinking level', async ({ hookTimeout, presetTimeout }) => {
    const server = await fixture((_captured, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sse({ type: 'text_delta', delta: 'Observed main prefix.' }));
      response.write(sse({ type: 'usage', inputTokens: 5, outputTokens: 2 }));
    });
    const observed = runnerHooks(server.origin, { timeoutMs: hookTimeout });
    const snapshot = routedSnapshot(server.endpoint);
    snapshot.profile!.models.main!.timeoutMs = presetTimeout;
    snapshot.profile!.models.main!.thinkingLevel = 'LOW';
    const outcome = await runMain(snapshot, observed.hooks);
    expect(outcome).toMatchObject({ status: 'partial', text: 'Observed main prefix.', error: 'TIMEOUT', usage: { modelCalls: 1, inputTokens: 5, outputTokens: 2, costUsd: null } });
    expect(server.requests).toHaveLength(1);
    expect(observed.tools).toEqual([]);
    expect(observed.attempts).toHaveLength(1);
    expect(observed.attempts[0].result).toMatchObject({ status: 'partial', error: { code: 'TIMEOUT' } });
    expect(JSON.parse(server.requests[0].body).generation).toEqual({ maxOutputTokens: 4096, temperature: null, thinkingLevel: 'LOW' });
  });

  test('P04 P05 checks current connection policy before each call and never retries a revoked route', async () => {
    const server = await fixture(async (_captured, response) => { await writeSse(response, [{ type: 'tool_delta', index: 0, id: 'read-lore', name: 'knowledge.read', argumentsDelta: '{"id":"lore-1"}' }, { type: 'done', reason: 'tool_calls' }]); });
    let checks = 0;
    const observed = runnerHooks(server.origin, { authorize: value => ({ ...value, enabled: ++checks === 1 }) });
    const result = await runMain(routedSnapshot(server.endpoint), observed.hooks);
    expect(result).toMatchObject({ status: 'error', error: 'CONNECTION_NOT_AUTHORIZED', usage: { modelCalls: 1, inputTokens: null, costUsd: null } });
    expect(server.requests).toHaveLength(1); expect(observed.attempts).toHaveLength(1); expect(checks).toBe(2);
  });

  test('P01 P04 hides disabled persona in pinned context and read scope; denied model tools cannot escalate', async () => {
    const server = await fixture(async (_captured, response) => { await writeSse(response, [{ type: 'tool_delta', index: 0, id: 'escape', name: 'shell.execute', argumentsDelta: '{"command":"PRIVATE_ARGUMENT"}' }, { type: 'done', reason: 'tool_calls' }]); });
    const snapshot = routedSnapshot(server.endpoint);
    const persona: Content = { id: 'persona-1', revision: 1, kind: 'persona', title: 'Reader', description: 'Disabled persona', text: 'EXCLUDED_PERSONA_CANARY', loading: 'pinned', relatedIds: [] };
    snapshot.profile!.contents.push(persona); snapshot.profile!.creative.personaReference = false;
    snapshot.resources.push({ ...persona, chatId: snapshot.chatId, kind: 'lore', sourceKind: 'persona' });
    snapshot.resources[0].relatedIds = ['lore-1', 'persona-1', 'unknown-private-id'];
    expect(JSON.stringify(buildMainInput(snapshot))).not.toContain('EXCLUDED_PERSONA_CANARY');
    expect(buildMainInput(snapshot).catalog[0].relatedIds).toEqual(['lore-1']);
    const observed = runnerHooks(server.origin);
    const result = await runMain(snapshot, observed.hooks);
    expect(result.error).toBe('READ_TOOL_DENIED');
    expect(observed.tools).toMatchObject([{ denied: true, name: 'unapproved', args: {} }]);
    expect(JSON.stringify(observed.tools)).not.toContain('PRIVATE_ARGUMENT');
    expect(server.requests).toHaveLength(1);
  });

  test('P01 P03 separates native main scope from translation glossary reads and keeps empty profiles free of synthetic facts', () => {
    const snapshot = routedSnapshot('http://127.0.0.1:49999/turn');
    const read = { callId: 'glossary-read', name: 'knowledge.read', args: { id: 'glossary-1' } };
    expect(executeTool(snapshot, read).denied).toBe(true);
    const translated = executeTool(snapshot, read, undefined, 'translation');
    expect(translated).toMatchObject({ denied: false, result: { text: 'AUXILIARY_ONLY_TRANSLATION_PROCEDURE', source: { id: 'glossary-1', revision: 1 } } });
    expect(JSON.stringify(buildMainInput(snapshot))).not.toContain('AUXILIARY_ONLY');
    expect(buildMainInput(snapshot).contract).toContain('An (OOC: ...) request is an author direction inside the fiction');
    snapshot.profile!.contents = []; snapshot.resources = [];
    expect(buildMainInput(snapshot).facts).toEqual([]);
    expect(JSON.stringify(buildMainInput(snapshot))).not.toContain('Mira');
  });
});
const options = (origin: string, extra: Partial<Parameters<typeof executeProvider>[2]> = {}) => ({ approvedOrigins: [origin], signal: new AbortController().signal, ...extra });

describe('fixture HTTP transport (no live provider compatibility claim)', () => {
  test('P05 handles fragmented UTF8, tool argument JSON, call IDs and opaque state across real fetch turns', async () => {
    let calls = 0;
    const server = await fixture(async (_req, response) => {
      calls++;
      await writeSse(response, calls === 1 ? [
        { type: 'tool_delta', index: 0, id: 'call-lore-7', name: 'knowledge.search', argumentsDelta: '{"que' },
        { type: 'tool_delta', index: 0, argumentsDelta: 'ry":"등대 🌊"}' },
        { type: 'opaque_state', state: { response: 'fixture-r7', signature: 'opaque-roundtrip-value' } },
        { type: 'usage', inputTokens: 12, outputTokens: 4, costUsd: null, raw: { input_tokens: 12, output_tokens: 4, cached_tokens: 0 }, priceRevision: null },
        { type: 'done', reason: 'tool_calls' },
      ] : [{ type: 'text_delta', delta: '등대의 불빛 🌊' }, { type: 'done', reason: 'stop' }], true);
    });
    const first = await executeProvider(connection(server.endpoint), request(), options(server.origin));
    expect(first).toMatchObject({ status: 'tool_calls', toolCalls: [{ id: 'call-lore-7', name: 'knowledge.search', arguments: { query: '등대 🌊' } }], usage: { inputTokens: 12, outputTokens: 4, costUsd: null } });
    const next = request(); next.opaqueState = first.opaqueState;
    next.input.results = first.toolCalls.map(call => ({ callId: call.id, name: call.name, result: { items: [{ id: 'lore-1', title: '등대' }] } }));
    const final = await executeProvider(connection(server.endpoint), next, options(server.origin));
    expect(final).toMatchObject({ status: 'completed', text: '등대의 불빛 🌊', usage: { inputTokens: null, outputTokens: null, costUsd: null } });
    const secondBody = JSON.parse(server.requests[1].body);
    expect(secondBody.opaqueState).toEqual(first.opaqueState);
    expect(secondBody.input.results[0].callId).toBe(first.toolCalls[0].id);
    expect(server.requests).toHaveLength(2);
  });

  test('P02 P05 preserves exact role requests and stable prefix while dynamic controls and source change', async () => {
    const server = await fixture(async (_req, response) => { await writeSse(response, [{ type: 'text_delta', delta: 'fixture narrative' }, { type: 'done', reason: 'stop' }]); });
    const wire: WireRecord[] = [];
    const first = request(); const second = structuredClone(first);
    second.input.controls.tone = 'vivid'; second.input.source = { revision: 'source-8', hash: 'different' };
    const translated = request('translation'); translated.stable.tools = [];
    for (const input of [first, second, translated]) {
      expect((await executeProvider(connection(server.endpoint), input, options(server.origin, { onWire: record => { wire.push(record); } }))).status).toBe('completed');
    }
    expect(wire[0].stablePrefixSha256).toBe(wire[1].stablePrefixSha256);
    expect(wire[0].bodySha256).not.toBe(wire[1].bodySha256);
    expect(wire[2].role).toBe('translation'); expect(wire[2].modelId).toBe('fixture-translation');
    for (let index = 0; index < wire.length; index++) {
      expect(wire[index].body).toEqual(JSON.parse(server.requests[index].body));
      expect(wire[index].bodySha256).toBe(createHash('sha256').update(server.requests[index].body).digest('hex'));
    }
    expect(server.requests[2].body).not.toContain('main role contract');
    expect(server.requests[0].body.indexOf('stable')).toBeLessThan(server.requests[0].body.indexOf('controls'));
    const unsupported = { ...request(), headers: { authorization: 'injected' } };
    expect(() => validateRequest(unsupported)).toThrow('UNSUPPORTED_OPTIONS');
  });

  test('P04 validates catalog data separately, keeps unknown metadata and preserves manual models on refresh failure', () => {
    const manual = registerManualModel('user-supplied-unverified-id');
    expect(manual.capabilities).toEqual({ tools: null, structuredOutput: null });
    expect(manual.pricing.inputUsdPerMillion).toBeNull();
    const refreshed = refreshCatalog([manual], { models: [{ id: 'new-catalog-entry', label: 'New fixture entry', capabilities: { tools: true } }] });
    expect(refreshed.models.map(item => item.id)).toEqual(['new-catalog-entry', manual.id]);
    expect(refreshed.models[0].pricing).toEqual({ inputUsdPerMillion: null, outputUsdPerMillion: null, revision: null });
    expect(refreshed.models[0].capabilities.structuredOutput).toBeNull();
    const failed = refreshCatalog(refreshed.models, { models: [], credentialEnv: 'NARRATIVE_PROVIDER_OTHER', preset: 'override' });
    expect(failed.error).toBe('UNSUPPORTED_OPTIONS'); expect(failed.models).toEqual(refreshed.models);
    expect(() => parseCatalog({ models: [{ id: 'bad', label: 'bad', headers: { authorization: 'overwrite' } }] })).toThrow('UNSUPPORTED_OPTIONS');
    expect(() => parseCatalog({ models: [{ id: 'a', label: 'a', pricing: { inputUsdPerMillion: -1 } }] })).toThrow('INVALID_USAGE');
  });

  test('P12 P04 refuses unapproved origins, redirects and connection options; credentials stay server-side and redacted', async () => {
    const target = await fixture((_req, response) => { response.end('must not follow'); });
    const server = await fixture(async (req, response) => {
      if (req.url === '/redirect') { response.writeHead(307, { location: target.endpoint }); response.end(); return; }
      await writeSse(response, [{ type: 'text_delta', delta: 'synthetic' }, { type: 'done', reason: 'stop' }]);
    });
    const secret = 'SYNTHETIC_TEST_CREDENTIAL_DO_NOT_LOG'; const records: WireRecord[] = [];
    const bound = { ...connection(server.endpoint), credentialEnv: 'NARRATIVE_PROVIDER_FIXTURE' };
    const input = request(); input.input.source = { secret, text: `accidental ${secret} inside content` };
    const outcome = await executeProvider(bound, input, options(server.origin, { resolveCredential: name => { expect(name).toBe('NARRATIVE_PROVIDER_FIXTURE'); return secret; }, onWire: record => { records.push(record); } }));
    expect(outcome.status).toBe('completed');
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(records[0].headers.authorization).toBe('[REDACTED]');
    expect(JSON.stringify(bound)).not.toContain(secret);
    expect((await executeProvider(connection(server.endpoint), request(), options(target.origin))).error?.code).toBe('ENDPOINT_NOT_APPROVED');
    const redirect = await executeProvider(connection(`${server.origin}/redirect`), request(), options(server.origin));
    expect(redirect.status).toBe('error'); expect(redirect.error?.code).toBe('TRANSPORT_ERROR'); expect(target.requests).toHaveLength(0);
    for (const endpoint of [`http://user:password@127.0.0.1:${new URL(server.origin).port}/turn`, `${server.endpoint}?api_key=secret`, `${server.endpoint}#fragment`]) {
      expect(() => validateConnection(connection(endpoint), [server.origin])).toThrow('ENDPOINT_NOT_APPROVED');
    }
    expect(() => validateConnection({ ...bound, headers: { authorization: 'escape' } }, [server.origin])).toThrow('UNSUPPORTED_OPTIONS');
    expect(() => validateConnection({ ...bound, credentialEnv: 'PATH' }, [server.origin])).toThrow('INVALID_CREDENTIAL_REFERENCE');
    expect(() => validateConnection(connection('https://example.com/turn'), ['https://example.com'])).toThrow('FIXTURE_REQUIRES_LOOPBACK');
  });

  test('P05 P06 keeps refusal, trailing usage, partial output and remote errors distinct without retry', async () => {
    const cases: { events: Json[]; status: string; code?: string }[] = [
      { events: [{ type: 'text_delta', delta: 'do not commit this text' }, { type: 'refusal', message: 'Fixture explicit refusal' }, { type: 'usage', inputTokens: 0, outputTokens: 2, costUsd: 0, raw: { total: 2 }, priceRevision: 'fixture-zero-v1' }, { type: 'done', reason: 'refusal' }], status: 'refused' },
      { events: [{ type: 'text_delta', delta: 'unfinished' }], status: 'partial', code: 'UNEXPECTED_EOF' },
      { events: [{ type: 'text_delta', delta: 'unfinished' }, { type: 'error', message: 'raw provider secret must not leak' }], status: 'partial', code: 'PROVIDER_ERROR' },
      { events: [{ type: 'error', message: 'raw provider secret must not leak' }], status: 'error', code: 'PROVIDER_ERROR' },
      { events: [], status: 'error', code: 'UNEXPECTED_EOF' },
    ];
    let index = 0;
    const server = await fixture(async (_req, response) => { await writeSse(response, cases[index++].events); });
    for (const entry of cases) {
      const output = await executeProvider(connection(server.endpoint), request(), options(server.origin));
      expect(output.status).toBe(entry.status);
      if (entry.code) expect(output.error?.code).toBe(entry.code);
      else expect(output).toMatchObject({ refusal: 'Fixture explicit refusal', usage: { inputTokens: 0, outputTokens: 2, costUsd: 0, priceRevision: 'fixture-zero-v1' } });
      expect(JSON.stringify(output)).not.toContain('raw provider secret');
    }
    expect(server.requests).toHaveLength(cases.length);
  });

  test('P05 rejects malformed UTF8/JSON, changed or duplicate tool IDs and incomplete terminal results', async () => {
    const cases: { bytes?: Buffer; events?: Json[]; code: string }[] = [
      { bytes: Buffer.from([0xff]), code: 'TRANSPORT_ERROR' },
      { bytes: Buffer.from('data: {bad}\n\n'), code: 'INVALID_EVENT' },
      { events: [{ type: 'tool_delta', index: 0, id: 'original', name: 'knowledge.search', argumentsDelta: '{}' }, { type: 'tool_delta', index: 0, id: 'changed' }], code: 'TOOL_ID_CHANGED' },
      { events: [{ type: 'tool_delta', index: 0, id: 'same', name: 'knowledge.search', argumentsDelta: '{}' }, { type: 'tool_delta', index: 1, id: 'same', name: 'knowledge.read', argumentsDelta: '{}' }, { type: 'done', reason: 'tool_calls' }], code: 'DUPLICATE_TOOL_ID' },
      { events: [{ type: 'tool_delta', index: 0, id: 'bad-args', name: 'knowledge.search', argumentsDelta: '{"query":' }, { type: 'done', reason: 'tool_calls' }], code: 'INVALID_TOOL_ARGUMENTS' },
      { events: [{ type: 'done', reason: 'tool_calls' }], code: 'INVALID_TERMINAL' },
      { events: [{ type: 'done', reason: 'stop' }], code: 'EMPTY_COMPLETION' },
    ];
    let index = 0;
    const server = await fixture(async (_req, response) => {
      const entry = cases[index++];
      if (entry.bytes) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(entry.bytes); }
      else await writeSse(response, entry.events!);
    });
    for (const entry of cases) {
      const output = await executeProvider(connection(server.endpoint), request(), options(server.origin));
      expect(output.status).not.toBe('completed'); expect(output.status).not.toBe('tool_calls'); expect(output.error?.code).toBe(entry.code);
    }
    expect(server.requests).toHaveLength(cases.length);
  });

  test('P05 abort and timeout stop a real stream, retain observed text and never start another request', async () => {
    let release: (() => void) | undefined;
    const received = new Promise<void>(resolve => { release = resolve; });
    const server = await fixture((_req, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(sse({ type: 'text_delta', delta: 'observed prefix' })); release?.();
    });
    const abort = new AbortController();
    const pending = executeProvider(connection(server.endpoint), request(), options(server.origin, { signal: abort.signal }));
    await received;
    await new Promise(resolve => setTimeout(resolve, 40));
    abort.abort('private cancellation reason');
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ status: 'cancelled', text: 'observed prefix', error: { code: 'CANCELLED' } });
    expect(JSON.stringify(cancelled)).not.toContain('private cancellation reason');
    const timed = await executeProvider(connection(server.endpoint), request(), options(server.origin, { timeoutMs: 80 }));
    expect(timed).toMatchObject({ status: 'partial', text: 'observed prefix', error: { code: 'TIMEOUT' } });
    expect(server.requests).toHaveLength(2);
    const before = new AbortController(); before.abort();
    expect((await executeProvider(connection(server.endpoint), request(), options(server.origin, { signal: before.signal }))).status).toBe('cancelled');
    expect(server.requests).toHaveLength(2);
  });
});

test('custom main prompt remains literal across tools after the caller changes its profile', async () => {
  const custom = '  CUSTOM MAIN\r\n{{char}} `verbatim`  ';
  const server = await fixture(async (captured, response) => {
    const body = JSON.parse(captured.body);
    if (!body.input.results.length) await writeSse(response, [{ type: 'tool_delta', index: 0, id: 'custom-read', name: 'knowledge.read', argumentsDelta: '{"id":"lore-1"}' }, { type: 'opaque_state', state: { test: 'custom-continuation' } }, { type: 'done', reason: 'tool_calls' }]);
    else await writeSse(response, [{ type: 'text_delta', delta: 'Custom scene received.' }, { type: 'done', reason: 'stop' }]);
  });
  const seed = routedSnapshot(server.endpoint);
  seed.profile!.promptPresets = { main: { id: 'writing-custom', revision: 4, role: 'main', title: 'Custom writing', text: custom } };
  const observed = runnerHooks(server.origin, { onInput: () => { seed.profile!.promptPresets!.main!.text = 'FUTURE PROMPT'; } });
  expect(await runMain(seed, observed.hooks)).toMatchObject({ status: 'completed', text: 'Custom scene received.' });
  expect(server.requests).toHaveLength(2);
  for (const captured of server.requests) {
    const wire = JSON.parse(captured.body);
    expect(wire.stable.contract).toBe(custom);
    expect(wire.stable.tools.map((tool: { name: string }) => tool.name)).toEqual(['knowledge.search', 'knowledge.read', 'skills.list', 'skills.load']);
    expect(captured.body).not.toContain('FUTURE PROMPT');
  }
  expect(JSON.parse(server.requests[1].body).input.results[0].callId).toBe('custom-read');
});
