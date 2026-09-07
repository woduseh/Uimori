import { afterEach, expect, test, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { runRegistrationAgent, type RegistrationAgentHooks } from '../server/provider-registration-agent.js';
import { PROVIDER_DEFINITIONS } from '../core/provider-definitions.js';
import { defaultEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';
import { loopbackProvider, sse, writeSse } from './fixtures/loopback-provider.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.unstubAllEnvs(); });
const env = 'My_Registration_Key';
const proposed = () => ({ connection: { kind: 'new', draft: { title: 'Proposed local connection', protocol: 'openai-chat-v1', endpoint: 'http://127.0.0.1:9/v1', enabled: false } }, model: { title: 'Proposed model', modelId: 'chosen/model', maxOutputTokens: 2048, temperature: null } });
const context = (): Json => ({ definitions: JSON.parse(JSON.stringify(PROVIDER_DEFINITIONS)), connections: [{ id: 'existing', revision: 2, protocol: 'openai-chat-v1', title: 'Saved connection', endpoint: 'PRIVATE_EXISTING_ENDPOINT', credentialEnv: 'PRIVATE_EXISTING_CREDENTIAL_REF', catalog: [{ text: 'PRIVATE_CATALOG_BODY' }] }],
  models: [{ id: 'model', revision: 3, title: 'Saved model', modelId: 'saved/model', protocol: 'openai-chat-v1', endpoint: 'PRIVATE_MODEL_ENDPOINT', body: 'PRIVATE_MODEL_BODY' }], story: 'PRIVATE_STORY_BODY' });
type Target = ModelPreset & { connection: Connection };
function target(origin: string, protocol: Connection['protocol'] = 'fixture-sse-v1'): Target { return { id: 'selected', revision: 1, title: 'Registration model', connectionId: 'connection', modelId: 'synthetic-model', maxOutputTokens: 512, temperature: 0, timeoutMs: 4000,
  connection: { id: 'connection', revision: 1, title: 'Synthetic runtime', protocol, endpoint: `${origin}${protocol === 'fixture-sse-v1' ? '/turn' : '/v1'}`, credentialEnv: env, enabled: true, catalog: [], catalogError: null } }; }
async function fixture(handler: (body: any, response: ServerResponse) => void | Promise<void>) {
  vi.stubEnv(env, 'synthetic-registration-key');
  const failures: unknown[] = [];
  const server = await loopbackProvider(async (request, response) => { try { expect(request.headers.authorization).toBe('Bearer synthetic-registration-key'); await handler(JSON.parse(request.body), response); } catch (error) { failures.push(error); throw error; } });
  closes.push(server.close); return { ...server, failures };
}
function observe(origin: string, extra: Partial<RegistrationAgentHooks> = {}) {
  const attempts: { id: string; wire: WireRecord; result?: ProviderResult }[] = [];
  const proposals: unknown[] = [];
  const hooks: RegistrationAgentHooks = { signal: new AbortController().signal, approvedOrigins: [origin], context: context(), authorize: connection => connection,
    onAttemptStart: wire => { const id = `attempt-${attempts.length}`; attempts.push({ id, wire }); return id; },
    onAttemptFinish: (id, result) => { attempts.find(attempt => attempt.id === id)!.result = result; }, onProposal: raw => { proposals.push(raw); return { normalized: raw }; }, ...extra };
  return { hooks, attempts, proposals };
}
const tool = (name = 'registration.propose', id = 'proposal', args: unknown = proposed()): Json => ({ type: 'tool_delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) });
const complete = (args: unknown = proposed()): Json[] => [{ type: 'text_delta', delta: JSON.stringify(args) }, { type: 'usage', inputTokens: 11, outputTokens: 7 }, { type: 'done', reason: 'stop' }];
const toolComplete = (events: Json[] = [tool()]): Json[] => [...events, { type: 'usage', inputTokens: 11, outputTokens: 7 }, { type: 'done', reason: 'tool_calls' }];

test('one proposal call records attempt before HTTP and sends only registration metadata', async () => {
  const server = await fixture(async (body, response) => {
    expect(log.attempts).toHaveLength(1); expect(body.role).toBe('main');
    expect(body.stable.tools.map((tool: any) => tool.name)).toEqual(['registration.propose']);
    expect(body.input.controls).toEqual({ purpose: 'provider-registration', maxCalls: 1 }); expect(body.input).not.toHaveProperty('source'); expect(body.input).not.toHaveProperty('history');
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_|credentialEnvDefault/);
    expect(body.input.catalog.connections[0]).toEqual({ id: 'existing', revision: 2, protocol: 'openai-chat-v1', title: 'Saved connection' });
    await writeSse(response, toolComplete());
  });
  const chosen = target(server.origin); const original = structuredClone(chosen); const log = observe(server.origin);
  expect(await runRegistrationAgent(chosen, '로컬 모델 등록안을 만들어 주세요.', log.hooks)).toEqual({ status: 'ready', proposal: { normalized: proposed() }, error: null });
  expect(chosen).toEqual(original); expect(log.proposals).toEqual([proposed()]); expect(server.requests).toHaveLength(1); expect(server.failures).toEqual([]);
  expect(log.attempts[0].result).toMatchObject({ usage: { inputTokens: 11, outputTokens: 7, costUsd: null }, opaqueState: null });
});

test('native Chat completed JSON preserves selected generation options and unknown usage', async () => {
  const server = await fixture(async (body, response) => {
    expect(body).toMatchObject({ model: 'synthetic-model', temperature: 0, max_completion_tokens: 512, reasoning_effort: 'high' });
    expect(body.tools).toHaveLength(1); expect(body.tools[0].function.name).toContain('registration_propose');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse({ id: 'chat', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(proposed()) }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  const chosen = target(server.origin, 'openai-chat-v1'); chosen.reasoningEffort = 'high'; const log = observe(server.origin);
  expect((await runRegistrationAgent(chosen, 'Prepare a proposal', log.hooks)).status).toBe('ready');
  expect(server.failures).toEqual([]); expect(server.requests).toHaveLength(1); expect(log.attempts[0].result!.usage).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
});

test('registration exposes only its proposal tool even on evaluation-enabled presets', async () => {
  for (const mode of ['proposal', 'artifact', 'local']) {
    const server = await fixture(async (body, response) => {
      expect(body.stable.tools).toHaveLength(1); expect(body.stable.tools[0].name).toBe('registration.propose');
      expect(body.input).not.toHaveProperty('source');
      await writeSse(response,toolComplete([tool(mode === 'proposal' ? 'registration.propose' : mode === 'artifact' ? 'eval_submit_artifact' : 'eval_get_context')]));
    });
    const chosen = target(server.origin); chosen.evaluationTools = defaultEvaluationToolOptions(); const original = structuredClone(chosen); const log = observe(server.origin);
    const result = await runRegistrationAgent(chosen, 'Prepare a proposal', log.hooks);
    expect(server.failures).toEqual([]); expect(result.status,JSON.stringify(result)).toBe(mode === 'proposal' ? 'ready' : 'failed'); expect(log.proposals).toHaveLength(mode === 'proposal' ? 1 : 0);
    expect(chosen).toEqual(original); expect(server.requests).toHaveLength(1); expect(server.failures).toEqual([]); expect(JSON.stringify(log.attempts)).not.toContain('PRIVATE_NOTICE');
  }
});

test('unsupported/multiple tools, malformed/oversized output, partial completion and enabled drafts never normalize or retry', async () => {
  for (const mode of ['unknown', 'multiple', 'malformed', 'oversized', 'partial', 'enabled']) {
    const server = await fixture(async (_body, response) => {
      if (mode === 'unknown') await writeSse(response, toolComplete([tool('knowledge.read')]));
      else if (mode === 'multiple') await writeSse(response, toolComplete([tool(), { ...(tool('registration.propose', 'second') as object), index: 1 } as Json]));
      else if (mode === 'malformed') await writeSse(response, [{ type: 'text_delta', delta: 'not json' }, { type: 'done', reason: 'stop' }]);
      else if (mode === 'oversized') await writeSse(response, complete({ ...proposed(), ignored: 'x'.repeat(32000) }));
      else if (mode === 'enabled') { const plan = proposed(); plan.connection.draft.enabled = true; await writeSse(response, complete(plan)); }
      else { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(sse({ type: 'text_delta', delta: JSON.stringify(proposed()) })); }
    });
    const log = observe(server.origin); expect((await runRegistrationAgent(target(server.origin), 'Prepare a proposal', log.hooks)).status).toBe('failed');
    expect(log.proposals).toEqual([]); expect(server.requests).toHaveLength(1); expect(server.failures).toEqual([]);
  }
});

test('initial disabled/preloaded/invalid requests and failed attempt persistence cannot send HTTP', async () => {
  const server = await fixture(async (_body, response) => writeSse(response, complete()));
  const chosen = target(server.origin); const log = observe(server.origin);
  chosen.enabled = false; expect((await runRegistrationAgent(chosen, 'Prepare', log.hooks)).error).toBe('REGISTRATION_MODEL_DISABLED'); chosen.enabled = true;
  chosen.connection.enabled = false; expect((await runRegistrationAgent(chosen, 'Prepare', log.hooks)).error).toBe('CONNECTION_NOT_AUTHORIZED'); chosen.connection.enabled = true;
  for (const request of ['', ' ', 'x'.repeat(6001)]) expect((await runRegistrationAgent(chosen, request, log.hooks)).error).toBe('REGISTRATION_REQUEST_INVALID');
  expect((await runRegistrationAgent(chosen, 'Prepare', { ...log.hooks, timeoutMs: 60001 })).error).toBe('REGISTRATION_TIMEOUT_INVALID');
  expect((await runRegistrationAgent(chosen, 'Prepare', { ...log.hooks, onAttemptStart: () => { throw new Error('PRIVATE_PERSISTENCE_ERROR'); } })).error).toBe('REGISTRATION_ATTEMPT_START_FAILED');
  expect(server.requests).toHaveLength(0); expect(log.proposals).toHaveLength(0);
});

test('authority is checked again after journal admission and after the model response', async () => {
  for (const mode of ['before-fetch', 'after-response']) {
    let allowed = true;
    const server = await fixture(async (_body, response) => { allowed = false; await writeSse(response, complete()); });
    const log = observe(server.origin, { authorize: connection => ({ ...connection, enabled: allowed }) });
    if (mode === 'before-fetch') { const start = log.hooks.onAttemptStart; log.hooks.onAttemptStart = async wire => { const id = await start(wire); allowed = false; return id; }; }
    const result = await runRegistrationAgent(target(server.origin), 'Prepare', log.hooks);
    expect(result.error).toBe('CONNECTION_NOT_AUTHORIZED'); expect(log.proposals).toHaveLength(0); expect(log.attempts).toHaveLength(1);
    expect(server.requests).toHaveLength(mode === 'before-fetch' ? 0 : 1); expect(server.failures).toEqual([]);
  }
});

test('real HTTP timeout and user cancellation cannot produce a proposal or a replay', async () => {
  for (const mode of ['timeout', 'cancel']) {
    const controller = new AbortController();
    const server = await fixture((_body, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(sse({ type: 'text_delta', delta: '{' })); if (mode === 'cancel') controller.abort('PRIVATE_ABORT'); });
    const log = observe(server.origin, { signal: controller.signal, timeoutMs: 100 });
    const result = await runRegistrationAgent(target(server.origin), 'Prepare', log.hooks);
    expect(result).toEqual({ status: mode === 'cancel' ? 'cancelled' : 'failed', error: mode === 'cancel' ? 'CANCELLED' : 'TIMEOUT' });
    expect(log.proposals).toHaveLength(0); expect(server.requests).toHaveLength(1); expect(log.attempts).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('PRIVATE_ABORT');
    expect(log.attempts[0].result!.error?.code).toBe(mode === 'cancel' ? 'CANCELLED' : 'TIMEOUT');
  }
});

test('normalization and journal-finalization failures preserve one attempt but cannot return ready', async () => {
  for (const mode of ['normalize', 'journal']) {
    const server = await fixture(async (_body, response) => writeSse(response, complete()));
    const log = observe(server.origin);
    if (mode === 'normalize') log.hooks.onProposal = () => { throw new Error('PRIVATE_VALIDATION_ERROR'); };
    else log.hooks.onAttemptFinish = () => { throw new Error('PRIVATE_JOURNAL_ERROR'); };
    const result = await runRegistrationAgent(target(server.origin), 'Prepare', log.hooks);
    expect(result.error).toBe(mode === 'normalize' ? 'REGISTRATION_PROPOSAL_INVALID' : 'REGISTRATION_ATTEMPT_FINISH_FAILED');
    expect(result.status).toBe('failed'); expect(server.requests).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  }
});
