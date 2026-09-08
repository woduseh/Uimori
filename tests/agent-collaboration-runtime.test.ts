import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import type { Json } from '../core/transport.js';
import type { Connection, ModelPreset, PromptPreset } from '../core/product.js';
import {
  MAIN_ONLY,
  SHARED,
  agent,
  api,
  call,
  collaboration,
  consults,
  credentialEnv,
  deferred,
  fixture,
  message,
  outputs,
  packet,
  rawCall,
  send,
  settled,
  toolName,
} from './fixtures/agent-collaboration.js';
import { sse } from './fixtures/loopback-provider.js';

test('absent and disabled collaboration preserve the one-call main path and its existing read permissions', async () => {
  const permissions: string[][] = [];
  for (const config of [
    null,
    collaboration({ enabled: false, agents: [agent('advisor', { trigger: 'before' })] }),
  ]) {
    const state = await fixture(
      async (body, target, number, wire) => {
        expect(number).toBe(1);
        expect(wire.agentId).toBeUndefined();
        expect(
          (body.tools ?? []).some((tool) => /agents_consult|behavior_|state[._]/u.test(tool.name))
        ).toBe(false);
        for (const name of ['knowledge.search', 'knowledge.read', 'skills.list', 'skills.load'])
          expect(toolName(body, name)).toBeTruthy();
        permissions.push((body.tools ?? []).map((tool) => tool.name));
        expect(JSON.stringify(body)).toContain(MAIN_ONLY);
        expect(JSON.stringify(body)).not.toContain(SHARED);
        expect(body.input.some((item) => item.type === 'function_call_output')).toBe(false);
        await send(target, [message('Only the main writes this source.')]);
      },
      { collaboration: config }
    );
    const run = await settled(state, (await state.start()).id);
    expect(run).toMatchObject({
      status: 'completed',
      usage: { modelCalls: 1, inputTokens: 7, outputTokens: 3, costUsd: null },
    });
    expect(run.snapshot.profile?.collaborationModels).toBeUndefined();
    expect(run.toolEvents).toEqual([]);
    const detail = await state.detail();
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0].text).toBe('Only the main writes this source.');
    expect(detail.attempts).toHaveLength(1);
    expect(detail.jobs).toEqual([]);
  }
  expect(permissions[0]).toEqual(permissions[1]);
});

test('completed advisor attempts restore with their frozen models and reject forged advisor attribution atomically', async () => {
  const state = await fixture(
    async (_body, target, number, wire) => {
      expect(wire.agentId).toBe(number === 1 ? 'advisor' : undefined);
      await send(target, [message(number === 1 ? 'Synthetic advisor evidence.' : 'Final scene.')]);
    },
    { collaboration: collaboration({ agents: [agent('advisor', { trigger: 'before' })] }) }
  );
  const run = await settled(state, (await state.start()).id);
  expect(run.status).toBe('completed');
  const archive = state.app.store.product.export();
  const restored = new Store(join(state.owner.directory, 'restored.sqlite'));
  try {
    expect(restored.product.import(archive)).toMatchObject({ restored: true });
    expect(restored.run(run.id).usage).toEqual(run.usage);
    expect(restored.run(run.id).toolEvents).toEqual(run.toolEvents);
    expect(restored.product.attempts(state.chat.id)).toHaveLength(2);
    expect(restored.detail(state.chat.id).sources.map((source) => source.text)).toEqual([
      'Final scene.',
    ]);
    const model = restored.run(run.id).snapshot.profile!.collaborationModels!.advisor;
    expect(model.id).toBe(state.advisorModel.id);
    expect(model.connection.enabled).toBe(false);
    expect(model.connection).not.toHaveProperty('credentialEnv');
  } finally {
    restored.close();
  }
  for (const agentId of ['unconfigured', 'constructor']) {
    const damaged = structuredClone(archive);
    const attempt = damaged.tables.attempts.find((row) => JSON.parse(row.request).agentId)!;
    attempt.request = JSON.stringify({ ...JSON.parse(attempt.request), agentId });
    const rejected = new Store(join(state.owner.directory, `rejected-${agentId}.sqlite`));
    try {
      expect(() => rejected.product.import(damaged)).toThrow(
        'Advisor attempt attribution mismatch'
      );
      expect(rejected.chats()).toEqual([]);
      expect(rejected.db.prepare('SELECT 1 FROM attempts').all()).toEqual([]);
    } finally {
      rejected.close();
    }
  }
  expect(state.provider.requests).toHaveLength(2);
});

test('before advisors run in order with scoped reads, selected models and explicit shared controls; only final main prose becomes a source', async () => {
  const longOpinion = 'A'.repeat(499) + '😀ADVISOR_ONLY_SUFFIX';
  const finalText = 'The keeper watched the copper observatory.';
  const state = await fixture(
    async (body, target, number, wire) => {
      expect((await state.detail()).sources).toEqual([]);
      if (wire.agentId) {
        expect(JSON.stringify(body)).not.toContain(MAIN_ONLY);
        expect(JSON.stringify(body)).not.toContain('PRIVATE_UNSHARED_CONTROL');
        expect(JSON.stringify(body)).not.toContain(state.foreign.text);
        expect(JSON.stringify(body)).toContain(SHARED);
        expect(JSON.stringify(body)).toContain(`ADVISOR_INSTRUCTIONS_${wire.agentId}`);
        expect(packet(body).controls).toEqual({ tone: 'shared dramatic tone' });
        expect(
          (body.tools ?? []).some((tool) => /agents_consult|state[._]|behavior_/u.test(tool.name))
        ).toBe(false);
      }
      if (number === 1) {
        expect(wire.agentId).toBe('advisor');
        expect(body.model).toBe(state.advisorModel.modelId);
        expect(body.max_output_tokens).toBe(1024);
        expect(body.tools).toHaveLength(2);
        toolName(body, 'knowledge.search');
        toolName(body, 'knowledge.read');
        await send(target, [call(body, 'knowledge.read', { id: state.lore.id }, 'before-read')]);
      } else if (number === 2) {
        expect(wire.agentId).toBe('advisor');
        expect(outputs(body)[0]).toMatchObject({
          text: state.lore.text,
          source: { id: state.lore.id, revision: state.lore.revision },
        });
        await send(target, [message(longOpinion)]);
      } else if (number === 3) {
        expect(wire.agentId).toBe('second');
        expect(body.model).toBe(state.mainModel.modelId);
        expect(body.tools ?? []).toEqual([]);
        await send(target, [message('SECOND_ADVISOR_ONLY')]);
      } else {
        expect(number).toBe(4);
        expect(wire.agentId).toBeUndefined();
        expect(body.model).toBe(state.mainModel.modelId);
        expect(body.max_output_tokens).toBe(4096);
        expect(JSON.stringify(body)).toContain(MAIN_ONLY);
        const bootstrap = outputs(body);
        expect(bootstrap.map((result) => result.agentId)).toEqual(['advisor', 'second']);
        expect(bootstrap.map((result) => result.status)).toEqual(['completed', 'completed']);
        expect(bootstrap[0]).toMatchObject({
          text: 'A'.repeat(499),
          truncated: true,
          usage: { modelCalls: 2, inputTokens: 14, outputTokens: 6, costUsd: null },
        });
        expect(body.input.filter((item) => item.type === 'function_call')).toHaveLength(2);
        await send(target, [message(finalText)]);
      }
    },
    {
      collaboration: collaboration({
        agents: [
          agent('advisor', { trigger: 'before', maxOutputChars: 500 }),
          agent('second', { trigger: 'before', tools: [] }),
        ],
      }),
    }
  );
  const run = await settled(state, (await state.start()).id);
  expect(run.status).toBe('completed');
  expect(state.observed.map((wire) => wire.agentId ?? 'main')).toEqual([
    'advisor',
    'advisor',
    'second',
    'main',
  ]);
  expect(run.usage).toEqual({ modelCalls: 4, inputTokens: 28, outputTokens: 12, costUsd: null });
  expect(run.toolEvents.map((event) => event.name)).toEqual([
    'agents.read',
    'agents.consult',
    'agents.consult',
  ]);
  const result = consults(run)[0].result;
  expect(result.source).toEqual({
    chatId: state.chat.id,
    parentRevision: null,
    prompt: { id: state.prompt.id, revision: state.prompt.revision },
  });
  const detail = await state.detail();
  expect(detail.sources).toHaveLength(1);
  expect(detail.sources[0]).toMatchObject({
    text: finalText,
    runId: run.id,
    hash: createHash('sha256').update(finalText).digest('hex'),
  });
  expect(detail.jobs).toEqual([]);
  expect(detail.attempts).toHaveLength(4);
  expect(state.app.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(result.evidence).toEqual([
    {
      tool: 'knowledge.read',
      args: { id: state.lore.id, offset: 0, limit: 4096 },
      reference: `resource:${state.lore.id}@${state.lore.revision}#chars=0-${state.lore.text.length}`,
    },
  ]);
});

test('on-demand main -> advisor read loop -> main persists attempts before HTTP and caches duplicate consultations without double-counting usage', async () => {
  const opaque = 'SYNTHETIC_ADVISOR_PRIVATE_CONTINUATION';
  const state = await fixture(async (body, target, number, wire) => {
    expect((await state.detail()).sources).toEqual([]);
    if (number === 1) {
      expect(wire.agentId).toBeUndefined();
      await send(target, [
        call(
          body,
          'agents.consult',
          { agentId: 'advisor', question: 'Where does the source place the observatory?' },
          'consult-1'
        ),
      ]);
    } else if (number === 2) {
      expect(wire.agentId).toBe('advisor');
      expect(packet(body).task).toBe('Where does the source place the observatory?');
      await send(target, [
        { type: 'reasoning', id: 'advisor-reasoning', encrypted_content: opaque, summary: [] },
        call(body, 'knowledge.search', { query: 'copper' }, 'search'),
        call(body, 'knowledge.read', { id: state.lore.id }, 'read'),
      ]);
    } else if (number === 3) {
      expect(wire.agentId).toBe('advisor');
      expect(
        body.input.some((item) => item.type === 'reasoning' && item.encrypted_content === opaque)
      ).toBe(true);
      expect(outputs(body)).toHaveLength(2);
      expect(outputs(body)[1].text).toBe(state.lore.text);
      await send(target, [message('The attached source places it north of the harbor.')]);
    } else if (number === 4) {
      expect(wire.agentId).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(opaque);
      expect(outputs(body)[0]).toMatchObject({
        status: 'completed',
        text: 'The attached source places it north of the harbor.',
        usage: { modelCalls: 2 },
      });
      await send(target, [
        call(
          body,
          'agents.consult',
          { agentId: 'advisor', question: 'Return the same consultation again.' },
          'consult-2'
        ),
      ]);
    } else {
      expect(number).toBe(5);
      expect(wire.agentId).toBeUndefined();
      const results = outputs(body);
      expect(results).toHaveLength(2);
      expect(results[1]).toMatchObject({
        cached: true,
        status: 'completed',
        text: results[0].text,
        usage: results[0].usage,
        evidence: results[0].evidence,
      });
      await send(target, [message('Final main scene, with one grounded detail.')]);
    }
  });
  const run = await settled(state, (await state.start()).id);
  expect(run.status).toBe('completed');
  expect(state.observed.map((wire) => wire.agentId ?? 'main')).toEqual([
    'main',
    'advisor',
    'advisor',
    'main',
    'main',
  ]);
  expect(run.usage).toEqual({ modelCalls: 5, inputTokens: 35, outputTokens: 15, costUsd: null });
  expect(run.toolEvents.filter((event) => event.name === 'agents.read')).toHaveLength(2);
  expect(consults(run)).toHaveLength(2);
  expect(consults(run)[1].result.cached).toBe(true);
  const detail = await state.detail();
  expect(detail.sources.map((source) => source.text)).toEqual([
    'Final main scene, with one grounded detail.',
  ]);
  expect(detail.attempts).toHaveLength(5);
  expect(
    detail.attempts!.every(
      (attempt) =>
        attempt.inputTokens === 7 && attempt.outputTokens === 3 && attempt.costUsd === null
    )
  ).toBe(true);
  expect(JSON.stringify(detail)).not.toContain(opaque);
  expect((await state.start()).id).toBe(run.id);
  expect(state.provider.requests).toHaveLength(5);
});

test('host, collaboration and per-advisor budgets bound real requests while reserving the last main call', async () => {
  for (const scenario of [
    {
      label: 'host leaves one',
      host: 2,
      shared: 6,
      individual: 3,
      second: false,
      read: true,
      expected: ['unavailable'],
      calls: 2,
    },
    {
      label: 'host only main',
      host: 1,
      shared: 6,
      individual: 3,
      second: false,
      read: true,
      expected: ['unavailable'],
      calls: 1,
    },
    {
      label: 'shared ceiling',
      host: 8,
      shared: 1,
      individual: 3,
      second: true,
      read: false,
      expected: ['completed', 'unavailable'],
      calls: 2,
    },
    {
      label: 'per-advisor ceiling',
      host: 8,
      shared: 6,
      individual: 1,
      second: true,
      read: true,
      expected: ['unavailable', 'completed'],
      calls: 3,
    },
  ]) {
    const state = await fixture(
      async (body, target, number, wire) => {
        if (wire.agentId === 'advisor' && scenario.read)
          await send(target, [
            call(body, 'knowledge.read', { id: state.lore.id }, `budget-read-${number}`),
          ]);
        else if (wire.agentId) await send(target, [message('Bounded advisory opinion.')]);
        else {
          expect(
            outputs(body).map((result) => result.status),
            scenario.label
          ).toEqual(scenario.expected);
          await send(target, [message('The reserved main call completes.')]);
        }
      },
      {
        maxCalls: scenario.host,
        collaboration: collaboration({
          maxCalls: scenario.shared,
          agents: [
            agent('advisor', { trigger: 'before', maxCalls: scenario.individual }),
            ...(scenario.second ? [agent('second', { trigger: 'before' })] : []),
          ],
        }),
      }
    );
    const run = await settled(state, (await state.start()).id);
    expect(run.status, scenario.label).toBe('completed');
    expect(state.provider.requests, scenario.label).toHaveLength(scenario.calls);
    expect(run.usage.modelCalls).toBe(scenario.calls);
    expect(state.observed.at(-1)?.agentId).toBeUndefined();
    for (const event of consults(run))
      if (event.result.status === 'unavailable')
        expect(event.result.error).toBe('ADVISOR_CALL_BUDGET_EXHAUSTED');
    expect((await state.detail()).sources.map((source) => source.text)).toEqual([
      'The reserved main call completes.',
    ]);
  }
});

test('advisor recursive consult, state writes, final submission and ungranted reads are rejected before any mixed-turn read; inaccessible content stays excluded', async () => {
  for (const forbidden of [
    'agents.consult',
    'state.apply',
    'story.submit',
    'skills.load',
    'foreign-resource',
  ]) {
    let advisorRequests = 0;
    const state = await fixture(
      async (body, target, _number, wire) => {
        if (wire.agentId) {
          advisorRequests++;
          expect(advisorRequests).toBe(1);
          expect(JSON.stringify(body)).not.toContain(state.foreign.text);
          expect(body.tools).toHaveLength(2);
          if (forbidden === 'foreign-resource')
            await send(target, [
              call(body, 'knowledge.read', { id: state.foreign.id }, 'excluded-read'),
            ]);
          else {
            const args: Json =
              forbidden === 'agents.consult'
                ? { agentId: 'advisor', question: 'Recurse' }
                : { id: state.lore.id, content: 'MUST_NOT_COMMIT', values: { changed: true } };
            await send(target, [
              call(body, 'knowledge.read', { id: state.lore.id }, 'must-not-read-mixed-turn'),
              rawCall(forbidden, args, 'forbidden'),
            ]);
          }
        } else {
          expect(outputs(body)[0]).toMatchObject({ status: 'unavailable', text: '' });
          expect(JSON.stringify(body)).not.toContain(state.foreign.text);
          await send(target, [message('The main continues without the unavailable opinion.')]);
        }
      },
      { collaboration: collaboration({ agents: [agent('advisor', { trigger: 'before' })] }) }
    );
    const run = await settled(state, (await state.start()).id);
    expect(run.status, forbidden).toBe('completed');
    expect(advisorRequests).toBe(1);
    expect(state.provider.requests).toHaveLength(2);
    expect(consults(run)[0].result.status).toBe('unavailable');
    const reads = run.toolEvents.filter((event) => event.name === 'agents.read');
    if (forbidden === 'foreign-resource') {
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ denied: true, result: { code: 'RESOURCE_UNAVAILABLE' } });
      expect(consults(run)[0].result.error).toBe('ADVISOR_READ_DENIED');
    } else expect(reads).toEqual([]);
    expect(
      run.toolEvents.some((event) => /^(state\.|behavior_|story\.submit)/u.test(event.name))
    ).toBe(false);
    const detail = await state.detail();
    expect(detail.sources.map((source) => source.text)).toEqual([
      'The main continues without the unavailable opinion.',
    ]);
    expect(detail.jobs).toEqual([]);
  }
});

test('HTTP failure, partial output and uncertain disconnect become cached unavailable advice without retries or discarded usage', async () => {
  for (const failure of ['http', 'partial', 'disconnect']) {
    let advisorRequests = 0,
      mainRequests = 0;
    const state = await fixture(async (body, target, _number, wire) => {
      if (wire.agentId) {
        advisorRequests++;
        expect(advisorRequests).toBe(1);
        if (failure === 'http') {
          target.writeHead(503, { 'content-type': 'application/json' });
          target.end('{"error":"synthetic unavailable"}');
        } else if (failure === 'partial')
          await send(target, [message('INCOMPLETE_ADVISOR_MUST_NOT_BE_SOURCE')], 'incomplete');
        else target.destroy();
      } else {
        mainRequests++;
        if (mainRequests <= 2) {
          if (mainRequests === 2)
            expect(outputs(body)[0]).toMatchObject({ status: 'unavailable', text: '' });
          await send(target, [
            call(
              body,
              'agents.consult',
              { agentId: 'advisor', question: 'Need the same source check.' },
              `consult-${mainRequests}`
            ),
          ]);
        } else {
          expect(mainRequests).toBe(3);
          expect(outputs(body)[1]).toMatchObject({ cached: true, status: 'unavailable', text: '' });
          await send(target, [message('Main continues after one failed advisory attempt.')]);
        }
      }
    });
    const run = await settled(state, (await state.start()).id);
    expect(run.status, failure).toBe('completed');
    expect(advisorRequests).toBe(1);
    expect(state.provider.requests).toHaveLength(4);
    expect(run.usage.modelCalls).toBe(4);
    expect(consults(run)[0].result.usage.modelCalls).toBe(1);
    expect(consults(run)[1].result).toMatchObject({
      cached: true,
      usage: consults(run)[0].result.usage,
    });
    expect(run.usage.costUsd).toBeNull();
    if (failure === 'partial')
      expect(run.usage).toMatchObject({ inputTokens: 28, outputTokens: 12 });
    const detail = await state.detail();
    expect(detail.sources.map((source) => source.text)).toEqual([
      'Main continues after one failed advisory attempt.',
    ]);
    expect(detail.attempts).toHaveLength(4);
    expect(
      detail.attempts!.filter(
        (attempt) => (attempt.request as { agentId?: string }).agentId === 'advisor'
      )
    ).toHaveLength(1);
  }
});

test('cancelling a live advisor closes its HTTP stream, preserves completed usage and prevents any main call or source', async () => {
  const received = deferred(),
    closed = deferred();
  const state = await fixture(
    async (body, target, number, wire) => {
      expect(wire.agentId).toBe('advisor');
      if (number === 1)
        await send(target, [
          call(body, 'knowledge.read', { id: state.lore.id }, 'read-before-cancel'),
        ]);
      else {
        expect(number).toBe(2);
        target.once('close', closed.release);
        target.writeHead(200, { 'content-type': 'text/event-stream' });
        target.write(sse({ type: 'response.created', response: { id: 'waiting-advisor' } }));
        received.release();
      }
    },
    { collaboration: collaboration({ agents: [agent('advisor', { trigger: 'before' })] }) }
  );
  const started = await state.start();
  await received.promise;
  await api(state.app, `/api/runs/${started.id}/cancel`, {});
  expect((await settled(state, started.id)).status).toBe('cancelled');
  await closed.promise;
  await expect
    .poll(
      async () =>
        (await state.detail()).attempts!.filter((attempt) => attempt.status === 'running').length
    )
    .toBe(0);
  await expect
    .poll(async () => (await api(state.app, `/api/runs/${started.id}`)).usage.modelCalls)
    .toBe(2);
  const detail = await state.detail();
  expect(detail.sources).toEqual([]);
  expect(state.observed.map((wire) => wire.agentId)).toEqual(['advisor', 'advisor']);
  expect(state.provider.requests).toHaveLength(2);
  expect(detail.attempts!.find((attempt) => attempt.status === 'tool_calls')).toMatchObject({
    inputTokens: 7,
    outputTokens: 3,
    costUsd: null,
  });
  expect(detail.attempts!.filter((attempt) => attempt.status === 'cancelled')).toHaveLength(1);
  expect(detail.runs[0]).toMatchObject({
    status: 'cancelled',
    sourceRevision: null,
    usage: { modelCalls: 2, costUsd: null },
  });
});

test('model and prompt changes after reservation cannot replace frozen advisor configuration or generation parameters', async () => {
  const received = deferred(),
    gate = deferred();
  const state = await fixture(async (body, target, number, wire) => {
    if (number === 1) {
      received.release();
      await gate.promise;
      await send(target, [
        call(
          body,
          'agents.consult',
          { agentId: 'advisor', question: 'Use the configuration reserved for this run.' },
          'frozen-consult'
        ),
      ]);
    } else if (wire.agentId) {
      expect(body.model).toBe('synthetic-collaboration-advisor');
      expect(body.max_output_tokens).toBe(1024);
      expect(JSON.stringify(body)).toContain(SHARED);
      expect(JSON.stringify(body)).not.toContain('FUTURE_SHARED_INSTRUCTIONS');
      expect(packet(body).controls).toEqual({ tone: 'shared dramatic tone' });
      await send(target, [message('Opinion from the original configuration.')]);
    } else {
      expect(number).toBe(3);
      await send(target, [message('Frozen execution complete.')]);
    }
  });
  state.owner.releases.push(gate.release);
  const started = await state.start();
  await received.promise;
  const before = structuredClone((await api(state.app, `/api/runs/${started.id}`)).snapshot);
  const updatedModel = await api<ModelPreset>(
    state.app,
    `/api/model-presets/${state.advisorModel.id}`,
    {
      title: 'Updated advisor',
      expectedRevision: state.advisorModel.revision,
      connectionId: state.advisorConnection.id,
      modelId: 'synthetic-advisor-updated',
      maxOutputTokens: 2048,
      temperature: null,
      timeoutMs: 4000,
    },
    'PUT'
  );
  const program = structuredClone(state.prompt.program);
  program.collaboration!.sharedInstructions = 'FUTURE_SHARED_INSTRUCTIONS';
  program.collaboration!.agents[0].instructions = 'FUTURE_ADVISOR_INSTRUCTIONS';
  await api<PromptPreset>(
    state.app,
    `/api/prompt-presets/${state.prompt.id}`,
    { title: state.prompt.title, role: 'main', program, expectedRevision: state.prompt.revision },
    'PUT'
  );
  expect(updatedModel.revision).toBeGreaterThan(state.advisorModel.revision);
  gate.release();
  const run = await settled(state, started.id);
  expect(run.status).toBe('completed');
  expect(run.snapshot.profile).toEqual(before.profile);
  expect(run.snapshot.profile?.collaborationModels?.advisor).toMatchObject({
    id: state.advisorModel.id,
    revision: state.advisorModel.revision,
    modelId: state.advisorModel.modelId,
    maxOutputTokens: 1024,
  });
  expect(consults(run)[0].result.source.prompt).toEqual({
    id: state.prompt.id,
    revision: state.prompt.revision,
  });
  expect(state.provider.requests).toHaveLength(3);
});

test('current advisor connection authorization is checked again between read rounds while main can still finish', async () => {
  const received = deferred(),
    gate = deferred();
  const state = await fixture(
    async (body, target, number, wire) => {
      if (wire.agentId) {
        expect(number).toBe(1);
        received.release();
        await gate.promise;
        await send(target, [
          call(body, 'knowledge.read', { id: state.lore.id }, 'read-before-revoke'),
        ]);
      } else {
        expect(number).toBe(2);
        expect(outputs(body)[0]).toMatchObject({
          status: 'unavailable',
          error: 'CONNECTION_NOT_AUTHORIZED',
          usage: { modelCalls: 1 },
        });
        await send(target, [message('Main completes with its separately enabled connection.')]);
      }
    },
    { collaboration: collaboration({ agents: [agent('advisor', { trigger: 'before' })] }) }
  );
  state.owner.releases.push(gate.release);
  const started = await state.start();
  await received.promise;
  await api<Connection>(
    state.app,
    `/api/connections/${state.advisorConnection.id}`,
    {
      title: state.advisorConnection.title,
      protocol: state.advisorConnection.protocol,
      endpoint: state.advisorConnection.endpoint,
      credentialEnv,
      enabled: false,
      expectedRevision: state.advisorConnection.revision,
    },
    'PUT'
  );
  gate.release();
  const run = await settled(state, started.id);
  expect(run.status).toBe('completed');
  expect(run.usage).toEqual({ modelCalls: 2, inputTokens: 14, outputTokens: 6, costUsd: null });
  expect(state.observed.map((wire) => wire.agentId ?? 'main')).toEqual(['advisor', 'main']);
  expect((await state.detail()).sources.map((source) => source.text)).toEqual([
    'Main completes with its separately enabled connection.',
  ]);
});
