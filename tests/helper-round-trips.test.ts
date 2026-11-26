import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import {
  HELPER_APP_TOOLS,
  HELPER_KNOWN_OPERATION_LIMIT,
  knownHelperOperations,
} from '../server/helper-app-tools.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { countTextTokens } from '../core/text-tokens.js';
import { sourceHash } from '../core/source-history.js';
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

type Call = { id: string; name: string; args: unknown };
type Script = (body: any, round: number) => Call[] | string;

function fixture(script: Script) {
  const path = mkdtempSync(join(tmpdir(), 'uimori-round-trips-')),
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
    inputTokenLimit: 272000,
    temperature: null,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: { id: helper.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: helper.id },
    contextModel: { id: helper.id },
  });
  const runtime = new HelperRuntime(store, {
    resolveCredential: () => 'synthetic-fixture-key',
    owner: 'round-trips',
    signal: controller.signal,
    track: (p) => work.push(p),
    streams: new ResponseStreamStore(store),
  });
  const conversation = runtime.workspace.open({ kind: 'library', workId: 'round-trips' });
  const bodies: any[] = [];
  let taskRound = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      try {
        return respond(script(body, taskRound++), body);
      } catch (error) {
        scriptErrors.push(error);
        throw error;
      }
    })
  );
  const scriptErrors: unknown[] = [];
  const run = async (request: string) => {
    taskRound = 0;
    const first = bodies.length;
    const task = runtime.enqueue(conversation.id, randomUUID(), request);
    await Promise.all(work);
    if (scriptErrors.length) throw scriptErrors[0];
    const done = runtime.workspace.task(task.id);
    expect(done.status, done.error ?? '').toBe('completed');
    const sent = bodies.slice(first);
    return { task: done, bodies: sent, rounds: sent.length };
  };
  return { store, runtime, conversation, bodies, run };
}

function respond(step: Call[] | string, body: any) {
  const delta =
    typeof step === 'string'
      ? { role: 'assistant', content: step }
      : {
          role: 'assistant',
          tool_calls: step.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: {
              name: body.tools.find((v: any) => v.function.name === call.name.replaceAll('.', '_'))
                .function.name,
              arguments: JSON.stringify(call.args),
            },
          })),
        };
  const chunks = [
    {
      id: 'synthetic-response',
      choices: [
        { index: 0, delta, finish_reason: typeof step === 'string' ? 'stop' : 'tool_calls' },
      ],
    },
    { id: 'synthetic-response', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
  ];
  return new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

const toolResult = (body: any, id: string) =>
  JSON.parse(
    body.messages.findLast((m: any) => m.role === 'tool' && m.tool_call_id === id).content
  );
const requestSource = (body: any) => {
  const text = body.messages
    .filter((m: any) => m.role === 'user')
    .flatMap((m: any) =>
      typeof m.content === 'string' ? [m.content] : m.content.map((p: any) => p.text)
    )
    .find((t: string) => t?.startsWith('Request data (JSON):\n'));
  return JSON.parse(text.slice('Request data (JSON):\n'.length)).source;
};
const stablePrefix = (body: any) =>
  JSON.stringify([body.messages.filter((m: any) => m.role === 'system'), body.tools]);
const attemptPrefixes = (f: ReturnType<typeof fixture>) =>
  f.store.db
    .prepare(
      "SELECT json_extract(request,'$.stablePrefixSha256') AS prefix FROM attempts WHERE role='helper' ORDER BY started_at, rowid"
    )
    .all()
    .map((row) => row.prefix);
const appCall = (id: string, name: string, args: unknown): Call => ({
  id,
  name: 'app.call',
  args: { name, arguments: args },
});

test('a follow-up task can call an operation discovered in an earlier task', async () => {
  let bot: Content | undefined;
  let secondTask = false;
  const f = fixture((body, round) => {
    const read = appCall(`read-${secondTask}`, 'resource.read', { kind: 'content', id: bot!.id });
    if (!secondTask) {
      if (round === 0)
        return [{ id: 'schemas', name: 'app.tools', args: { names: ['resource.read'] } }];
      if (round === 1) return [read];
      return 'Harin is the bot.';
    }
    if (round === 0) {
      const known = requestSource(body).knownOperations;
      expect(known.tools).toEqual([HELPER_APP_TOOLS.find((tool) => tool.name === 'resource.read')]);
      return [read];
    }
    expect(toolResult(body, read.id)).toMatchObject({ id: bot!.id });
    return 'Harin is still the bot.';
  });
  bot = f.store.product.content(fixtureBotInput('Harin', 'Name: Harin.')) as Content;
  const first = await f.run('Show the bot Harin.');
  expect(requestSource(first.bodies[0]).knownOperations).toBeUndefined();
  secondTask = true;
  const second = await f.run('Show it once more.');
  expect(second.rounds).toBe(2);
  const all = [...first.bodies, ...second.bodies];
  expect(new Set(all.map(stablePrefix)).size).toBe(1);
  expect(new Set(attemptPrefixes(f)).size).toBe(1);
  expect(attemptPrefixes(f)).toHaveLength(all.length);
  const sources = second.bodies.map((body) => JSON.stringify(requestSource(body)));
  expect(new Set(sources).size).toBe(1);
});

test('a selection edit saves from the seeded schema and source guards without a lookup or read', async () => {
  let selection: { sourceId: string; sourceHash: string; text: string } | undefined;
  const f = fixture((body, round) => {
    const source = requestSource(body);
    if (round === 0) {
      expect(source.knownOperations.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'scene.read',
        'scene.patch',
      ]);
      expect(source.writing.chat).toMatchObject({
        title: 'Harbor story',
        titleRevision: expect.any(Number),
        notesRevision: expect.any(Number),
        latestScene: { sourceId: selection!.sourceId, sceneNumber: 1, translation: 'none' },
      });
      expect(source.usageDate).toEqual({ date: expect.any(String), timeZone: 'Asia/Seoul' });
      const { chatId: _chatId, ...guards } = source.selection.editTarget;
      return [
        appCall('fix', 'scene.patch', {
          ...guards,
          changes: [{ oldText: 'teh bell', newText: 'the bell' }],
        }),
      ];
    }
    expect(toolResult(body, 'fix')).toMatchObject({ changed: true });
    return 'Fixed the typo.';
  });
  const chat = createFixtureChat(f.store, 'Harbor story');
  const head = f.store.chat(chat.id);
  const run = f.store.createRun(
    chat.id,
    {
      request: 'Write',
      expectedRevision: head.headRevision,
      expectedSettingsRevision: head.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (c) => ({
      chatId: chat.id,
      parentRevision: c.headRevision,
      settingsRevision: c.settingsRevision,
      settings: c.settings,
      request: 'Write',
      history: f.store.history(c.headRevision),
      resources: [],
    })
  ).run;
  f.store.startRun(run.id);
  const text = 'At dusk teh bell rang twice.';
  const source = f.store.completeRun(run.id, text, {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  selection = { sourceId: source.id, sourceHash: sourceHash(text), text: 'teh bell' };
  const conversation = f.runtime.workspace.open({ kind: 'chat', chatId: chat.id });
  const first = f.bodies.length;
  const task = f.runtime.enqueue(
    conversation.id,
    randomUUID(),
    'Fix this typo.',
    undefined,
    selection
  );
  await Promise.all(owned.at(-1)!.work);
  expect(f.runtime.workspace.task(task.id).status).toBe('completed');
  const bodies = f.bodies.slice(first);
  expect(bodies).toHaveLength(2);
  expect(f.store.source(source.id).text).toBe('At dusk the bell rang twice.');
  expect(new Set(bodies.map(stablePrefix)).size).toBe(1);
  expect(new Set(bodies.map((body) => JSON.stringify(requestSource(body)))).size).toBe(1);
  const stored = f.runtime.workspace.task(task.id).snapshot;
  expect(stored.seededOperations).toEqual(['scene.read', 'scene.patch']);
});

test('known operations follow the review allowlist, the count cap and the size cap', () => {
  const names = HELPER_APP_TOOLS.map((tool) => tool.name);
  const all = knownHelperOperations(names, false, Number.MAX_SAFE_INTEGER);
  expect(all.map((tool) => tool.name)).toEqual(names.slice(0, HELPER_KNOWN_OPERATION_LIMIT));
  expect(
    knownHelperOperations(['resource.patch', 'outline.read', 'unknown.op'], true, 100_000).map(
      (tool) => tool.name
    )
  ).toEqual(['outline.read']);
  const small = HELPER_APP_TOOLS.find((tool) => tool.name === 'settings.read')!;
  expect(
    knownHelperOperations(
      ['resource.read', 'settings.read'],
      false,
      countTextTokens(JSON.stringify(small))
    )
  ).toEqual([small]);
});
