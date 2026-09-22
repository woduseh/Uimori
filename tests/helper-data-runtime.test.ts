import { runDataProcess } from '../server/helper-data-tools.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { editableResource } from '../core/resource-editing.js';
import { nativeDraftTitle } from './fixtures/native-content.js';
import { countTextTokens } from '../core/text-tokens.js';
import type { ProviderTool } from '../core/transport.js';
import type { Content } from '../core/product.js';

const owned: { store: Store; path: string; work: Promise<void>[]; controller: AbortController }[] =
  [];
afterEach(async () => {
  for (const f of owned.splice(0)) {
    f.controller.abort();
    await Promise.allSettled(f.work);
    f.store.close();
    rmSync(f.path, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture(inputTokenLimit = 272000) {
  const path = mkdtempSync(join(tmpdir(), 'uimori-data-runtime-')),
    store = new Store(join(path, 'test.sqlite')),
    work: Promise<void>[] = [],
    controller = new AbortController();
  owned.push({ store, path, work, controller });
  const connection = store.product.connection({
    title: 'Synthetic native Chat',
    protocol: 'openai-chat-v1',
    endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    enabled: true,
  });
  const helper = store.product.model({
    title: 'Synthetic helper',
    connectionId: connection.id,
    modelId: 'synthetic-helper',
    maxOutputTokens: 2048,
    inputTokenLimit,
    temperature: null,
  });
  const context = store.product.model({
    title: 'Synthetic context',
    connectionId: connection.id,
    modelId: 'synthetic-context',
    maxOutputTokens: 4096,
    inputTokenLimit: 65536,
    temperature: null,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: helper.id },
    contextModel: { id: context.id },
  });
  const runtime = new HelperRuntime(store, {
    owner: 'data-runtime',
    signal: controller.signal,
    track: (p) => work.push(p),
    streams: new ResponseStreamStore(store),
  });
  const conversation = runtime.workspace.open({ kind: 'library', workId: 'native-data-runtime' });
  const run = async (request: string, editor?: Parameters<HelperRuntime['enqueue']>[3]) => {
    const task = runtime.enqueue(conversation.id, randomUUID(), request, editor);
    await Promise.all(work);
    return runtime.workspace.task(task.id);
  };
  return { store, work, runtime, conversation, run };
}
function answer(text: string, tools?: { id: string; name: string; args: unknown }[], body?: any) {
  const delta = tools
    ? {
        role: 'assistant',
        tool_calls: tools.map((t, index) => ({
          index,
          id: t.id,
          type: 'function',
          function: {
            name: body.tools.find((v: any) =>
              v.function.name.endsWith('_' + t.name.replaceAll('.', '_'))
            ).function.name,
            arguments: JSON.stringify(t.args),
          },
        })),
      }
    : { role: 'assistant', content: text };
  const chunks = [
    {
      id: 'synthetic-response',
      choices: [{ index: 0, delta, finish_reason: tools ? 'tool_calls' : 'stop' }],
    },
    { id: 'synthetic-response', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
  ];
  return new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }
  );
}
function provider(action: (body: any, round: number) => Response) {
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return action(body, bodies.length - 1);
    })
  );
  return bodies;
}
const toolResult = (body: any, id: string) =>
  JSON.parse(
    body.messages.findLast((m: any) => m.role === 'tool' && m.tool_call_id === id).content
  );

test('a native two-call fact lookup sends five stable tools, no full editor JSON, and bounded exact evidence', async () => {
  const f = fixture();
  const body =
    'Name: Harin. Age: 27.\n' + 'Irrelevant native design and visual details. '.repeat(1500);
  const bot = f.store.product.content(fixtureBotInput('Harin', body)) as Content;
  const editor = {
    kind: 'content' as const,
    targetId: bot.id,
    revision: bot.revision,
    title: bot.title,
    model: editableResource('content', bot),
  };
  const bodies = provider((wire, round) => {
    expect(wire.tools).toHaveLength(5);
    expect(wire.tools.map((t: any) => t.function.name.replace(/^tool_\d+_/, ''))).toEqual([
      'data_search',
      'data_read',
      'db_query',
      'app_tools',
      'app_call',
    ]);
    if (round === 0) {
      expect(JSON.stringify(wire)).not.toContain('Irrelevant native design');
      return answer(
        '',
        [{ id: 'find-age', name: 'data.search', args: { patterns: ['Age'], scope: 'editor' } }],
        wire
      );
    }
    const evidence = toolResult(wire, 'find-age');
    expect(evidence.items).toHaveLength(1);
    expect(evidence.items[0].text).toContain('Age: 27');
    expect(evidence.items[0].origin).toBe('unsaved-device-editor');
    return answer('The supplied editor states that Harin is 27.');
  });
  const task = await f.run('How old is Harin in this editor?', editor);
  expect(task.status, task.error ?? '').toBe('completed');
  expect(bodies).toHaveLength(2);
  const initialTokens = countTextTokens(JSON.stringify(bodies[0]));
  expect(initialTokens).toBeLessThan(4000);
  expect(task.usage).toMatchObject({ modelCalls: 2, inputTokens: 22, outputTokens: 14 });
  const metrics = f.runtime.workspace
    .events(f.conversation.id)
    .filter((e) => e.kind === 'input.measured')
    .map((e) => e.data as any);
  expect(metrics).toHaveLength(2);
  expect(
    metrics.every(
      (m) => typeof m.attemptId === 'string' && m.preparationMs >= 0 && m.compactionMs === 0
    )
  ).toBe(true);
  const queried = (await runDataProcess({
    path: f.store.path,
    taskId: task.id,
    name: 'db.query',
    args: {
      sql: 'SELECT m.helper_call,m.estimated_input_tokens,u.input_tokens FROM agent_helper_inputs m JOIN agent_usage u ON u.id=m.attempt_id WHERE m.task_id=? ORDER BY m.helper_call',
      params: [task.id],
    },
  })) as any;
  expect(queried.rows).toHaveLength(2);
  expect(queried.rows[0]).toMatchObject({ helper_call: 1, input_tokens: 11 });
  expect(metrics[0].helperCall).toBe(1);
  expect(metrics[0].componentEstimates.toolSchemas).toBeGreaterThan(0);
  console.log(
    'HELPER_DATA_FACT_INPUT',
    JSON.stringify({
      initialTokens,
      totalTokens: bodies.reduce((n, b) => n + countTextTokens(JSON.stringify(b)), 0),
      calls: bodies.length,
    })
  );
});

test('native app gateway discovers schemas then reads and saves a bot without changing native tool aliases', async () => {
  const f = fixture();
  const original = f.store.product.content(
    fixtureBotInput('Original helper bot', 'Age: 27')
  ) as Content;
  let schemas: ProviderTool[] = [];
  const bodies = provider((wire, round) => {
    if (round === 0)
      return answer(
        '',
        [{ id: 'schemas', name: 'app.tools', args: { names: ['resource.read', 'resource.save'] } }],
        wire
      );
    schemas = toolResult(wire, 'schemas').tools;
    expect(schemas.map((t) => t.name)).toEqual(['resource.read', 'resource.save']);
    if (round === 1)
      return answer(
        '',
        [
          {
            id: 'read',
            name: 'app.call',
            args: { name: 'resource.read', arguments: { kind: 'content', id: original.id } },
          },
        ],
        wire
      );
    const read = toolResult(wire, 'read') as Content;
    if (round === 2)
      return answer(
        '',
        [
          {
            id: 'save',
            name: 'app.call',
            args: {
              name: 'resource.save',
              arguments: {
                kind: 'content',
                id: read.id,
                expectedRevision: read.revision,
                model: nativeDraftTitle(
                  editableResource('content', read),
                  'Renamed through gateway'
                ),
              },
            },
          },
        ],
        wire
      );
    expect(toolResult(wire, 'save')).toMatchObject({ id: original.id, revision: 2 });
    return answer('Saved the requested name.');
  });
  const task = await f.run('Rename the specified bot to Renamed through gateway and save it.');
  expect(task.status, task.error ?? '').toBe('completed');
  expect(bodies).toHaveLength(4);
  expect(bodies.every((b) => JSON.stringify(b.tools) === JSON.stringify(bodies[0].tools))).toBe(
    true
  );
  expect(f.store.product.get<Content>('content', original.id)).toMatchObject({
    title: 'Renamed through gateway',
    revision: 2,
    text: original.text,
  });
});

test('gateway read compaction retains an exact completed mutation and resumes with a fresh native continuation', async () => {
  const f = fixture(8192);
  const b = f.store.product.content(fixtureBotInput('Before', 'Age: 27.')) as Content;
  const evidence = f.store.product.content(
    fixtureBotInput(
      'Large evidence',
      'Age: 27.\n' + 'one two three four five six seven eight nine ten\n'.repeat(700)
    )
  ) as Content;
  // A theme/list discovery read and an operation can share a model round. Reads compact; writes stay exact.
  let helperCalls = 0,
    summaryCalls = 0;
  let finalRequest: any;
  const bodies = provider((wire) => {
    if (wire.model === 'synthetic-context') {
      summaryCalls++;
      return answer(
        'The resource was saved as After at revision 2. The subsequent read describes Harin, age 27. Finish the same task; do not save again.'
      );
    }
    helperCalls++;
    if (helperCalls === 1)
      return answer(
        '',
        [
          {
            id: 'saved',
            name: 'app.call',
            args: {
              name: 'resource.save',
              arguments: {
                kind: 'content',
                id: b.id,
                expectedRevision: 1,
                model: nativeDraftTitle(editableResource('content', b), 'After'),
              },
            },
          },
          {
            id: 'read-large',
            name: 'app.call',
            args: { name: 'resource.read', arguments: { kind: 'content', id: evidence.id } },
          },
        ],
        wire
      );
    finalRequest = wire;
    expect(wire.messages.filter((m: any) => m.role === 'tool')).toHaveLength(0);
    expect(JSON.stringify(wire)).toContain('host-completed-tool-history');
    expect(JSON.stringify(wire)).toContain('completedReads');
    return answer('Saved once and verified the age.');
  });
  const task = await f.run('Save this bot as After and confirm the age from the saved result.');
  expect(task.status, task.error ?? '').toBe('completed');
  expect(summaryCalls).toBe(1);
  expect(helperCalls).toBe(2);
  expect(f.store.product.get<Content>('content', b.id).revision).toBe(2);
  const data = JSON.parse(
    finalRequest.messages
      .find((m: any) => m.role === 'user')
      .content.replace(/^Request data \(JSON\):\n/, '')
  );
  expect(data.source.completedToolHistory.events[0]).toMatchObject({
    callId: 'saved',
    name: 'app.call',
    args: { name: 'resource.save' },
    result: { revision: 2 },
    denied: false,
  });
  expect(data.source.continuation.completedReads[0]).toMatchObject({
    name: 'app.call',
    args: { name: 'resource.read' },
  });
  expect(bodies).toHaveLength(3);
});

test('unknown gateway operations remain recoverable and cannot fabricate a successful resource save', async () => {
  const f = fixture();
  const bodies = provider((wire, round) => {
    if (round === 0)
      return answer(
        '',
        [{ id: 'invalid', name: 'app.call', args: { name: 'not.a.tool', arguments: {} } }],
        wire
      );
    expect(toolResult(wire, 'invalid')).toMatchObject({
      error: 'UNKNOWN_APP_TOOL',
      recoverable: true,
    });
    return answer('That operation is unavailable.');
  });
  const task = await f.run('Inspect the tools.');
  expect(task.status, task.error ?? '').toBe('completed');
  expect(bodies).toHaveLength(2);
  expect(task.completedEffects?.count ?? 0).toBe(0);
});
