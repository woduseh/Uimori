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
import { rollBackHelperTask } from '../server/helper-rollback.js';
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
    return {
      task: done,
      bodies: sent,
      rounds: sent.length,
      inputChars: sent.reduce((n, b) => n + JSON.stringify(b).length, 0),
      inputTokens: sent.reduce((n, b) => n + countTextTokens(JSON.stringify(b)), 0),
    };
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

function report(
  caseId: string,
  behavior: string,
  measured: { rounds: number; inputChars: number; inputTokens: number }
) {
  console.log(
    'HELPER_ROUND_TRIPS',
    JSON.stringify({
      caseId,
      behavior,
      evidence: 'scripted native Chat transport and temporary SQLite; not live model behavior',
      rounds: measured.rounds,
      inputChars: measured.inputChars,
      wireTokens: measured.inputTokens,
    })
  );
}

for (const behavior of ['looks-up-again', 'reuses-known'] as const)
  test(`a follow-up task can call an operation discovered in an earlier task (${behavior})`, async () => {
    let bot: Content | undefined;
    let secondTask = false;
    const f = fixture((body, round) => {
      const read = appCall(`read-${secondTask}`, 'resource.read', { kind: 'content', id: bot!.id });
      if (!secondTask || behavior === 'looks-up-again') {
        if (round === 0)
          return [
            { id: `schemas-${secondTask}`, name: 'app.tools', args: { names: ['resource.read'] } },
          ];
        if (round === 1) return [read];
        return 'Harin is the bot.';
      }
      if (round === 0) {
        const known = requestSource(body).knownOperations;
        expect(known.tools).toEqual([
          HELPER_APP_TOOLS.find((tool) => tool.name === 'resource.read'),
        ]);
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
    report('schema-reuse/task-1', behavior, first);
    report('schema-reuse/task-2', behavior, second);
    expect(first.rounds).toBe(3);
    expect(second.rounds).toBe(behavior === 'reuses-known' ? 2 : 3);
    const all = [...first.bodies, ...second.bodies];
    expect(new Set(all.map(stablePrefix)).size).toBe(1);
    expect(new Set(attemptPrefixes(f)).size).toBe(1);
    expect(attemptPrefixes(f)).toHaveLength(all.length);
    const sources = second.bodies.map((body) => JSON.stringify(requestSource(body)));
    expect(new Set(sources).size).toBe(1);
  });

test('a plan task carries only the earlier operations it may run', async () => {
  let bot: Content | undefined;
  let planning = false;
  const f = fixture((body, round) => {
    if (planning) {
      expect(
        requestSource(body).knownOperations.tools.map((tool: { name: string }) => tool.name)
      ).toEqual(['resource.read']);
      return 'The plan.';
    }
    if (round === 0)
      return [
        appCall('read', 'resource.read', { kind: 'content', id: bot!.id }),
        appCall('patch', 'resource.patch', {
          kind: 'content',
          id: bot!.id,
          expectedRevision: bot!.revision,
          changes: [{ op: 'set', path: '/package/nativeRisu/card/description', value: 'Edited.' }],
        }),
      ];
    return 'Edited.';
  });
  bot = f.store.product.content(fixtureBotInput('Harin', 'Name: Harin.')) as Content;
  await f.run('Edit Harin.');
  planning = true;
  const task = f.runtime.enqueue(
    f.conversation.id,
    randomUUID(),
    'Plan the next edit.',
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    { mode: 'plan' }
  );
  await Promise.all(owned.at(-1)!.work);
  expect(f.runtime.workspace.task(task.id).status).toBe('completed');
});

for (const behavior of ['reads-the-continuation', 'uses-the-following-text'] as const)
  test(`a lookup whose answer follows the excerpt (${behavior})`, async () => {
    const lore =
      "## Harin's history\n" +
      'Harin grew up among quiet rivers and long winters, and the town remembers her for many small things. '.repeat(
        5
      ) +
      'She was born in Lumen.' +
      '\nUnrelated closing notes. '.repeat(200);
    const f = fixture((body, round) => {
      if (round === 0)
        return [
          appCall('find', 'data.search', { scope: 'library', patterns: ["Harin's history"] }),
        ];
      if (round === 1) {
        const found = toolResult(body, 'find');
        const top = found.items[0];
        expect(JSON.stringify(found).length).toBeLessThanOrEqual(8000);
        expect(top.text).not.toContain('born in Lumen');
        if (behavior === 'uses-the-following-text') {
          expect(top.following.text).toContain('She was born in Lumen.');
          expect(top.following.range.start).toBe(top.range.end);
          return 'Harin was born in Lumen.';
        }
        return [appCall('more', 'data.read', { refs: [top.ref], offset: top.nextOffset })];
      }
      expect(toolResult(body, 'more').items[0].read.text).toContain('She was born in Lumen.');
      return 'Harin was born in Lumen.';
    });
    f.store.product.content(fixtureBotInput('Harin', lore));
    const lookup = await f.run('Where was Harin born?');
    report('search-excerpt', behavior, lookup);
    expect(lookup.rounds).toBe(behavior === 'uses-the-following-text' ? 2 : 3);
    expect(new Set(lookup.bodies.map(stablePrefix)).size).toBe(1);
    expect(new Set(attemptPrefixes(f)).size).toBe(1);
  });

test('a task after a rollback keeps one stable prefix and one source across its rounds', async () => {
  let bot: Content | undefined;
  let stage = 0;
  const f = fixture((_body, round) => {
    if (stage === 0)
      return round === 0
        ? [
            appCall('patch', 'resource.patch', {
              kind: 'content',
              id: bot!.id,
              expectedRevision: bot!.revision,
              changes: [
                { op: 'set', path: '/package/nativeRisu/card/description', value: 'Edited.' },
              ],
            }),
          ]
        : 'Edited Harin.';
    return round === 0
      ? [appCall(`read-${stage}`, 'resource.read', { kind: 'content', id: bot!.id })]
      : 'Harin is unchanged.';
  });
  bot = f.store.product.content(fixtureBotInput('Harin', 'Name: Harin.')) as Content;
  const edited = await f.run('Edit Harin.');
  expect(
    rollBackHelperTask(f.store, f.runtime.workspace, edited.task.id, undefined).units
  ).toMatchObject([{ status: 'restored' }]);
  stage = 1;
  const next = await f.run('Show Harin.');
  stage = 2;
  const later = await f.run('Show Harin again.');
  expect(next.rounds).toBe(2);
  const all = [...edited.bodies, ...next.bodies, ...later.bodies];
  expect(new Set(all.map(stablePrefix)).size).toBe(1);
  const sources = next.bodies.map((body) => JSON.stringify(requestSource(body)));
  expect(new Set(sources).size).toBe(1);
  expect(requestSource(next.bodies[0]).revertedChanges).toEqual([
    {
      taskId: edited.task.id,
      request: 'Edit Harin.',
      domain: 'resource',
      kind: 'content',
      targetId: bot.id,
      title: 'Harin',
    },
  ]);
  expect(requestSource(later.bodies[0])).not.toHaveProperty('revertedChanges');
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

test('the contract depends only on the conversation scope, not on what a task carries', async () => {
  const f = fixture((_body, round) => (round === 0 ? 'Done.' : 'Done.'));
  await f.run('First library task.');
  await f.run('Second library task.');
  const library = f.bodies.map(stablePrefix);
  expect(new Set(library).size).toBe(1);
  const system = (body: any) =>
    body.messages
      .filter((m: any) => m.role === 'system')
      .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
  expect(system(f.bodies[0])).not.toContain('author-note');
  expect(system(f.bodies[0])).not.toContain('uimori apply');
  expect(system(f.bodies[0])).toContain('source already holds');
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
