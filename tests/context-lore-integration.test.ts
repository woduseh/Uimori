import { observeExecutions, observedExecution } from './fixtures/execution-observer.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { nativeContent } from './fixtures/native-content.js';
import { prepareNativeRisuReadOnly } from '../server/risu-native-readonly.js';
import {
  modelWorkspace,
  updateModelWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, type App } from '../server/app.js';
import { Store } from '../server/store.js';
import { freezeLoreContext } from '../server/lore-context.js';

import { captureLogicalHistory } from '../server/prompt-snapshot.js';
import { freezeReservationSnapshot } from '../server/reservation-snapshot.js';
import {
  contextSourceRefs,
  fitFixedLoreContext,
  measureMainContext,
  seedContextPlan,
  withContextProjection,
} from '../server/context-planning.js';
import { executeTool } from '../core/provider.js';
import { estimateContextTokens, MIN_INPUT_TOKEN_LIMIT } from '../core/context-budget.js';
import { DEFAULT_LORE_CONTEXT, type RetainedLore } from '../core/lore-context.js';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import type { Run, RunSnapshot, Source } from '../core/types.js';

const endpoint = 'http://127.0.0.1:44996/turn';
const paragraph = '항구 기록에는 오래된 약속이 적혀 있어요. 기록의 진실은 아직 불확실해요.\n';
const scene = '비 오는 항구에서 미라는 지도를 살펴봐요. 선택은 아직 정해지지 않았어요.\n';
const summaryText =
  '이전 장면에서 미라는 항구의 지도를 살폈어요. 사용자는 미라의 선택을 대신 정하지 말라고 요청했어요.';
const finalText = '미라는 젖은 지도를 조심스럽게 펼쳤어요.';
const nextRequest = '미라가 지도를 펼치는 다음 장면을 써 주세요.';
const owned: { directory: string; app?: App; store?: Store }[] = [];
type Body = {
  role: string;
  input: unknown;
  prompt?: {
    messages: {
      id: string;
      content: { text: string }[];
      provenance: { origin: string; sourceRevision?: string };
    }[];
  };
  [key: string]: unknown;
};
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Unexpected network in synthetic context-lore integration')
  );
});
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    item.store?.close();
    const target = resolve(item.directory),
      inside = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !basename(target).startsWith('uimori-context-lore-integration-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function directory() {
  const item: (typeof owned)[number] = {
    directory: await mkdtemp(join(tmpdir(), 'uimori-context-lore-integration-')),
  };
  owned.push(item);
  return item;
}
const complete = (text: string) =>
  new Response(
    [
      { type: 'text_delta', delta: text },
      { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: null },
      { type: 'done', reason: 'stop' },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  );
function snapshot(
  store: Store,
  chatId: string,
  request = '미라의 다음 장면을 이어 써 주세요.'
): RunSnapshot {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId)!;
  return {
    chatId,
    parentRevision: chat.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request,
    history: store.history(chat.headRevision),
    resources: store.product.resources(chatId, profile),
    profile,
  };
}
async function seed(
  store: Store,
  chatId: string,
  text: string,
  reads: { id: string; text: string }[] = []
): Promise<Source> {
  const captured = snapshot(
    store,
    chatId,
    `사용자 ${store.history(store.chat(chatId).headRevision).length}: 미라의 선택을 대신 정하지 마세요.`
  );
  let run = store.createRun(
    chatId,
    {
      request: captured.request,
      expectedRevision: captured.parentRevision,
      expectedSettingsRevision: captured.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => captured
  ).run;
  const prepared = compileSnapshotPrompt(
    freezeLoreContext(store, await prepareNativeRisuRun(run.snapshot))
  );
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(prepared), run.id);
  run = store.run(run.id);
  store.startRun(run.id);
  for (const lore of reads) {
    const event = executeTool(run.snapshot, {
      name: 'knowledge.read',
      callId: randomUUID(),
      args: { ids: [lore.id], offset: 0, limit: Math.min(lore.text.length, 4096) },
    });
    expect(event.denied).toBe(false);
    expect((event.result as any).items[0].read.text).toBe(lore.text.slice(0, 4096));
    store.tool(run.id, event);
  }
  return store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    run.snapshot.settings
  );
}

async function lorePressureBudget(store: Store, chatId: string) {
  const now = new Date();
  const reserved = freezeReservationSnapshot(store, snapshot(store, chatId, nextRequest), {
    purpose: 'preview-main',
    executionClock: () => ({ iso: now.toISOString(), unix: Math.floor(now.getTime() / 1000) }),
  });
  const prepared = seedContextPlan(
    freezeLoreContext(store, await prepareNativeRisuReadOnly(reserved, 'context'))
  );
  const references = prepared.loreContext!.entries;
  expect(references).toHaveLength(3);
  const measure = (entries: RetainedLore[], includeHistory: boolean) => {
    const projected = structuredClone(prepared);
    const context = projected.loreContext!;
    context.entries = entries;
    context.stats.retainedEntries = entries.length;
    context.stats.retainedChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
    context.stats.droppedEntries += references.length - entries.length;
    return measureMainContext(
      withContextProjection(projected, includeHistory ? [] : contextSourceRefs(projected), null)
    ).estimatedInputTokens;
  };
  // A is newest; B then C must be evicted. Place the budget between measured costs:
  // all fixed references trigger eviction, two cannot meet its target, and one plus
  // the actual conversation fits below that target without a summary call.
  const allFixed = measure(references, false);
  const twoFixed = measure([references[0], references[2]], false);
  const oneWithHistory = measure([references[0]], true);
  const minimum = Math.max(MIN_INPUT_TOKEN_LIMIT, Math.ceil(oneWithHistory / 0.75));
  const maximum = Math.floor(Math.min(allFixed / 0.85, twoFixed / 0.75));
  expect(minimum, 'Fixture must leave room between retention and eviction costs').toBeLessThan(
    maximum
  );
  return {
    inputTokenLimit: Math.floor((minimum + maximum) / 2),
    relaxedInputTokenLimit: Math.ceil(measure(references, true) / 0.75),
  };
}

async function fixture(kind: 'lore-pressure' | 'history-pressure') {
  const item = await directory(),
    app = (item.app = await createApp({
      dbPath: join(item.directory, 'story.sqlite'),
      buildId: 'synthetic-context-lore-test',
    }));
  await app.ready();
  observeExecutions(app.store);
  // Reference pressure is measured against the same short synthetic instructions.
  updatePromptWorkspace(app.store, {
    expectedRevision: modelWorkspace(app.store).revision,
    main: {
      title: 'Synthetic context instructions',
      program: createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT),
      values: {},
    },
  });
  let chat = createFixtureChat(app.store, '문맥 요약과 조회 자료 합성 검증');
  chat = app.store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    status: false,
    maxCalls: 16,
  });
  const modules = (kind === 'lore-pressure' ? ['A', 'B', 'C'] : ['A']).map(
    (label) =>
      app.store.product.content({
        kind: 'module',
        title: `Reference ${label}`,
        description: '',
        text: `LORE_${label}_RAW_BODY_ONLY\n${paragraph.repeat(kind === 'lore-pressure' ? 100 : 2)}`,
        loading: 'discoverable',
        relatedIds: [],
        package: {
          ...nativeContent(
            {
              name: `Reference ${label}`,
              character_book: {
                entries: [
                  {
                    comment: `Reference ${label}`,
                    keys: [label],
                    content: `LORE_${label}_RAW_BODY_ONLY\n${paragraph.repeat(kind === 'lore-pressure' ? 100 : 2)}`,
                    enabled: true,
                  },
                ],
              },
            },
            {},
            'module'
          ),
          loreActivation: { mode: 'discoverable' },
        },
      }) as Content
  );
  const { chatId: _id, revision, ...profile } = app.store.product.profile(chat.id);
  updateTestProfile(app.store.product, chat.id, {
    ...profile,
    expectedRevision: revision,
    packageAttachments: [
      ...profile.packageAttachments!,
      ...modules.map(({ id, revision }) => ({ id, revision, role: 'module' })),
    ],
    loreContext: { ...DEFAULT_LORE_CONTEXT },
  });
  const lore = app.store.product
    .resources(chat.id, app.store.product.snapshot(chat.id)!)
    .filter((item) => item.sourceKind === 'lore');
  const sources: Source[] = [];
  if (kind === 'lore-pressure') {
    sources.push(await seed(app.store, chat.id, '첫 번째 짧은 장면.', [lore[0]]));
    sources.push(await seed(app.store, chat.id, '두 번째 짧은 장면.', [lore[1]]));
    sources.push(await seed(app.store, chat.id, '세 번째 짧은 장면.', [lore[2]]));
    sources.push(await seed(app.store, chat.id, '네 번째 짧은 장면.', [lore[0]]));
  } else {
    for (let index = 0; index < 5; index++)
      sources.push(
        await seed(
          app.store,
          chat.id,
          `이전 장면 ${index}.\n${scene.repeat(65)}`,
          index === 0 ? lore : []
        )
      );
  }
  const connection = app.store.product.connection({
    title: 'Synthetic context-lore loopback',
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
  }) as Connection;
  let model = app.store.product.model({
    title: 'Synthetic bounded model',
    connectionId: connection.id,
    modelId: 'synthetic-context-lore',
    maxOutputTokens: 8192,
    // The history-pressure case needs compaction; the lore-pressure case derives
    // its budget from the complete measured request below.
    inputTokenLimit: 10_000,
    temperature: null,
  }) as ModelPreset;
  const {
    chatId: _chat,
    revision: currentRevision,
    ...current
  } = app.store.product.profile(chat.id);
  updateTestProfile(app.store.product, chat.id, {
    ...current,
    expectedRevision: currentRevision,
    routes: { ...current.routes, main: { id: model.id } },
  });
  const workspace = modelWorkspace(app.store);
  updateModelWorkspace(app.store, {
    expectedRevision: workspace.revision,
    routes: workspace.routes,
    translationPolicy: workspace.translationPolicy,
    contextModel: { id: model.id },
  });
  let relaxedInputTokenLimit = model.inputTokenLimit!;
  if (kind === 'lore-pressure') {
    const budget = await lorePressureBudget(app.store, chat.id);
    relaxedInputTokenLimit = budget.relaxedInputTokenLimit;
    model = app.store.product.model(
      {
        title: model.title,
        connectionId: model.connectionId,
        modelId: model.modelId,
        maxOutputTokens: model.maxOutputTokens,
        inputTokenLimit: budget.inputTokenLimit,
        temperature: model.temperature,
        expectedRevision: model.revision,
      },
      model.id
    ) as ModelPreset;
  }
  const bodies: Body[] = [];
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    expect(String(url)).toBe(endpoint);
    const body = JSON.parse(String(options?.body)) as Body;
    bodies.push(body);
    expect(body).not.toHaveProperty('contextBudget');
    expect(estimateContextTokens(body)).toBeLessThanOrEqual(
      app.store.product.get<ModelPreset>('model', model.id).inputTokenLimit!
    );
    return complete(body.role === 'context' ? summaryText : finalText);
  });
  return { app, chatId: chat.id, sources, lore, model, bodies, relaxedInputTokenLimit };
}
async function start(app: App, chatId: string) {
  const chat = app.store.chat(chatId);
  const response = await injectWithFixtureBot(app, {
    method: 'POST',
    url: `/api/chats/${chatId}/runs`,
    headers: { host: '127.0.0.1' },
    payload: {
      request: nextRequest,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Run;
}
async function terminal(app: App, id: string) {
  let run!: Run;
  await vi.waitFor(
    () => {
      run = observedExecution(app.store, id);
      expect(['queued', 'running']).not.toContain(run.status);
    },
    { timeout: 10_000, interval: 20 }
  );
  expect(run.status, run.error ?? '').toBe('completed');
  return run;
}

describe('automatic summary and retained lore at the same input boundary', () => {
  test('summarizes only logical conversation pairs and carries old-source raw references after the summary before recent history', async () => {
    const f = await fixture('history-pressure'),
      expected = freezeLoreContext(
        f.app.store,
        await prepareNativeRisuReadOnly(snapshot(f.app.store, f.chatId), 'context')
      ),
      originals = captureLogicalHistory(f.app.store, expected),
      started = await start(f.app, f.chatId);
    const run = await terminal(f.app, started.id),
      plan = run.snapshot.contextPlan!,
      summaries = f.bodies.filter((body) => body.role === 'context');
    expect(summaries.length).toBeGreaterThan(0);
    expect(plan.compacted.some((ref) => ref.revision === f.sources[0].id)).toBe(true);
    expect(run.snapshot.loreContext!.entries).toEqual(expected.loreContext!.entries);
    expect(run.snapshot.loreContext!.entries).toHaveLength(1);
    expect(run.snapshot.logicalHistory).toEqual(originals);
    expect(run.snapshot.history.map((source) => source.text)).toEqual(
      f.sources.map((source) => source.text)
    );
    for (const body of summaries) {
      expect(JSON.stringify(body)).not.toContain('LORE_A_RAW_BODY_ONLY');
      expect(JSON.stringify(body)).not.toContain(f.lore[0].text);
      expect(JSON.stringify(body)).not.toContain('Previously read reference data');
    }
    const main = f.bodies.find((body) => body.role === 'main')!,
      messages = main.prompt!.messages;
    const summaryIndex = messages.findIndex((message) =>
      message.content.some((part) => part.text.includes(summaryText))
    );
    const carriedIndex = messages.findIndex((message) =>
      message.content.some((part) => part.text.includes('LORE_A_RAW_BODY_ONLY'))
    );
    const recent = new Set(plan.recentSourceRevisions),
      recentIndex = messages.findIndex(
        (message) =>
          message.provenance.origin === 'history' &&
          !!message.provenance.sourceRevision &&
          recent.has(message.provenance.sourceRevision)
      );
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(carriedIndex).toBeGreaterThan(summaryIndex);
    expect(recentIndex).toBeGreaterThan(carriedIndex);
    expect(messages[summaryIndex].content.map((part) => part.text).join('')).not.toContain(
      'LORE_A_RAW_BODY_ONLY'
    );
    expect(messages[carriedIndex].content.map((part) => part.text).join('')).toContain(
      'Previously read reference data'
    );
    expect(run.usage.modelCalls).toBe(f.bodies.length);
  });

  test('fixed-input lore fitting and hypothetical history measurement leave the supplied snapshot and database unchanged', async () => {
    const f = await fixture('lore-pressure');
    let prepared = seedContextPlan(
      freezeLoreContext(
        f.app.store,
        await prepareNativeRisuReadOnly(snapshot(f.app.store, f.chatId), 'context')
      )
    );
    prepared = { ...prepared, logicalHistory: captureLogicalHistory(f.app.store, prepared) };
    const original = structuredClone(prepared),
      before = f.app.store.db.prepare('SELECT total_changes() AS n').get();
    const all = prepared.history.map((source) => ({
      revision: source.revision,
      hash: f.app.store.sourceOriginal(source.revision).hash,
    }));
    const hypothetical = withContextProjection(prepared, all, null),
      fitted = fitFixedLoreContext(hypothetical);
    expect(fitted.loreContext!.entries.length).toBeLessThan(prepared.loreContext!.entries.length);
    measureMainContext(withContextProjection(prepared, all, summaryText));
    expect(prepared).toEqual(original);
    expect(f.app.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
});
