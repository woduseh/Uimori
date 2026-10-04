import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import type { RequestPreview } from '../core/request-preview.js';
import * as transport from '../core/transport.js';
import { createApp, type App } from '../server/app.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { contextSourceRefs } from '../server/context-planning.js';
import {
  modelWorkspace,
  promptWorkspace,
  updateModelWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { freezeReservationSnapshot } from '../server/reservation-snapshot.js';
import * as nativeRun from '../server/risu-native-run.js';
import * as nativeRuntime from '../server/risu-native-runtime.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const owned: { app: App; directory: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await nativeRuntime.disposeAllNativeRisuSessions();
  for (const { app, directory } of owned.splice(0)) {
    await app.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-request-preview-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(withModel = true) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-request-preview-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'request-preview',
    testMode: true,
  });
  owned.push({ app, directory });
  const { store } = app;
  const input = fixtureBotInput('Preview owner', 'PRIVATE_BOT_BODY');
  input.package.nativeRisu.card.character_book = {
    entries: [
      {
        id: 1,
        keys: ['harbor'],
        comment: 'Pinned harbor',
        content: 'PRIVATE_PINNED_LORE',
        constant: true,
        enabled: true,
      },
      {
        id: 2,
        keys: ['station'],
        comment: 'Optional station',
        content: 'PRIVATE_OPTIONAL_LORE',
        enabled: true,
      },
    ],
  };
  input.package.nativeRisu.card.extensions = {
    risuai: {
      lowLevelAccess: true,
      triggerscript: [
        {
          type: 'start',
          lowLevelAccess: true,
          effect: [{ type: 'triggerlua', code: 'error("CALLBACK_MUST_NOT_EXECUTE")' }],
        },
      ],
    },
  };
  const bot = store.product.content(input);
  const chat = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Preview transcript',
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: Array.from({ length: 4 }, (_, index) => ({
        request: `Authored request ${index}`,
        text: `PRIVATE_HISTORY_${index}: ` + '비 오는 항구에서 미라는 기다려요. '.repeat(100),
        translation: null,
      })),
    },
  }).chat;
  const connection = store.product.connection({
    title: 'Preview fixture connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9/PRIVATE_ENDPOINT',
    enabled: true,
  });
  const modelInput = {
    title: 'Current preview model',
    connectionId: connection.id,
    modelId: 'fixture',
    inputTokenLimit: 8192,
    maxOutputTokens: 4096,
    temperature: null,
    tokenizer: 'openai-cl100k',
  };
  const model = store.product.model(modelInput);
  const workspace = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: workspace.revision,
    routes: { ...workspace.routes, main: withModel ? { id: model.id } : null },
    translationPolicy: workspace.translationPolicy,
  });
  const post = (body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/request-preview`,
      payload: body as object,
    });
  const preview = async (request = 'Visit the harbor.', loreContextReset = false) => {
    const response = await post({ request, loreContextReset });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RequestPreview>();
  };
  const changes = () => store.db.prepare('SELECT total_changes() AS count').get()!.count;
  return { app, store, chat, model, modelInput, connection, bot, post, preview, changes };
}

test('current preview is metadata only, with no writes, provider calls or native callbacks', async () => {
  const f = await fixture();
  const provider = vi
    .spyOn(transport, 'executeProvider')
    .mockRejectedValue(new Error('Provider forbidden'));
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
  const callbacks = vi.spyOn(nativeRuntime, 'executeRisuNative');
  const before = f.changes();
  const result = await f.preview();
  expect(result.error).toBeNull();
  expect(result.snapshot).toMatchObject({
    headRevision: f.chat.headRevision,
    settingsRevision: f.chat.settingsRevision,
    stale: false,
  });
  expect(result.selected.model).toMatchObject({
    id: f.model.id,
    title: 'Current preview model',
    revision: f.model.revision,
  });
  expect(result.tokens).toMatchObject({
    tokenizer: 'openai-cl100k',
    inputTokenLimit: 8192,
    tokenizerInfo: { requested: 'openai-cl100k', fallback: false },
  });
  expect(result.tokens.estimatedInputTokens).toBeGreaterThan(100);
  expect(result.lore).toMatchObject({
    retainedEntries: 0,
    pinnedEntries: 1,
    selectionPending: true,
  });
  expect(result.caveats).toEqual(
    expect.arrayContaining([
      'NATIVE_CALLBACKS_DEFERRED',
      'NATIVE_EDIT_REQUEST_DEFERRED',
      'LORE_SELECTION_PENDING',
    ])
  );
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    'PRIVATE_BOT_BODY',
    'PRIVATE_PINNED_LORE',
    'PRIVATE_HISTORY_',
    'PRIVATE_ENDPOINT',
    'Visit the harbor.',
  ])
    expect(serialized).not.toContain(privateValue);
  expect(f.changes()).toBe(before);
  expect(provider).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect(callbacks).not.toHaveBeenCalled();
});

test('draft and refreshed current settings/models affect provenance and estimate without creating summaries', async () => {
  const f = await fixture();
  const first = await f.preview();
  const before = f.changes();
  const long = await f.preview('가나다라마바사 '.repeat(2200), true);
  expect(long.tokens.estimatedInputTokens!).toBeGreaterThan(first.tokens.estimatedInputTokens!);
  expect(long.snapshot.requestHash).not.toBe(first.snapshot.requestHash);
  expect(long.snapshot.loreContextReset).toBe(true);
  expect(long.summary.compactionPending).toBe(true);
  expect(long.tokens.status).toBe('compaction-pending');
  expect(f.store.db.prepare('SELECT count(*) AS count FROM context_checkpoints').get()!.count).toBe(
    0
  );
  expect(f.changes()).toBe(before);
  const saved = f.store.settings(f.chat.id, f.chat.settingsRevision, {
    ...f.chat.settings,
    maxCalls: 7,
  });
  const model = f.store.product.model(
    {
      ...f.modelInput,
      title: 'Revised model',
      inputTokenLimit: 16000,
      expectedRevision: f.model.revision,
    },
    f.model.id
  );
  const refreshed = await f.preview();
  expect(refreshed.snapshot.settingsRevision).toBe(saved.settingsRevision);
  expect(refreshed.selected.model).toMatchObject({
    title: 'Revised model',
    revision: model.revision,
  });
  expect(refreshed.tokens.inputTokenLimit).toBe(16000);
});

test.each([false, true])(
  'checks encoded summary inclusion and invalidated checkpoints (current-only prompt: %s)',
  async (currentOnly) => {
    const f = await fixture();
    if (currentOnly) {
      const workspace = promptWorkspace(f.store);
      updatePromptWorkspace(f.store, {
        expectedRevision: workspace.revision,
        main: {
          ...workspace.main,
          program: nativePrompt('Current input only.', {
            promptTemplate: [
              { type: 'plain', role: 'system', text: 'Current input only.' },
              { type: 'chat', rangeStart: -1, rangeEnd: 'end' },
            ],
          }),
          values: {},
        },
      });
    }
    const beforeSummary = await f.preview();
    const profile = f.store.product.snapshot(f.chat.id);
    const reserved = freezeReservationSnapshot(
      f.store,
      {
        chatId: f.chat.id,
        parentRevision: f.chat.headRevision,
        settingsRevision: f.chat.settingsRevision,
        settings: f.chat.settings,
        request: 'Visit the harbor.',
        history: f.store.history(f.chat.headRevision),
        resources: f.store.product.resources(f.chat.id, profile),
        profile,
      },
      {
        purpose: 'preview-main',
        executionClock: () => ({ iso: '2026-10-05T00:00:00.000Z', unix: 1791158400 }),
      }
    );
    const snapshot = f.store.context.prepareRun(
      await nativeRun.prepareNativeRisuRun(reserved, { preview: true })
    );
    snapshot.contextPlan = {
      ...snapshot.contextPlan!,
      status: 'ready',
      compacted: contextSourceRefs(snapshot).slice(0, 2),
      recentSourceRevisions: snapshot.history.slice(2).map((item) => item.revision),
      summary: '미라는 항구에서 기다렸어요.',
      estimatedInputTokens: 100,
    };
    f.store.context.publishPrepared(snapshot, { origin: 'edit' });
    const before = f.changes();
    const usingSummary = await f.preview();
    expect(usingSummary.summary).toMatchObject({
      available: true,
      inUse: currentOnly ? null : true,
      compactedSources: 2,
    });
    if (currentOnly) expect(usingSummary.caveats).toContain('SUMMARY_INCLUSION_UNVERIFIED');
    else
      expect(usingSummary.tokens.estimatedInputTokens!).toBeLessThan(
        beforeSummary.tokens.estimatedInputTokens!
      );
    expect(f.changes()).toBe(before);
    const workspace = promptWorkspace(f.store);
    updatePromptWorkspace(f.store, {
      expectedRevision: workspace.revision,
      main: {
        ...workspace.main,
        program: createDefaultRisuPrompt('Use the revised writing policy.'),
        values: {},
      },
    });
    const invalid = await f.preview();
    expect(invalid.summary).toMatchObject({ available: true, inUse: false, compactedSources: 0 });
    expect(invalid.caveats).toContain('SUMMARY_NOT_REUSABLE');
  }
);

test.each(['settings', 'attached-content', 'source', 'connection'] as const)(
  'marks %s that changes while the isolated native preview awaits as stale',
  async (change) => {
    const f = await fixture();
    const original = nativeRun.prepareNativeRisuRun;
    const profileRevision = f.store.product.profile(f.chat.id).revision;
    let afterMutation = f.changes();
    vi.spyOn(nativeRun, 'prepareNativeRisuRun').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (change === 'settings')
        f.store.settings(f.chat.id, f.chat.settingsRevision, { ...f.chat.settings, maxCalls: 6 });
      else if (change === 'attached-content') {
        const input = fixtureBotInput('Revised attached owner', 'REVISED_PRIVATE_BOT_BODY');
        f.store.product.content({ ...input, expectedRevision: f.bot.revision }, f.bot.id);
      } else if (change === 'source')
        f.store.editSource(f.chat.headRevision!, {
          text: 'Revised saved scene.',
          expectedRevision: 0,
        });
      else
        f.store.product.connection(
          {
            title: 'Revised connection',
            protocol: f.connection.protocol,
            endpoint: 'http://127.0.0.1:9/revised',
            enabled: true,
            expectedRevision: f.connection.revision,
          },
          f.connection.id
        );
      afterMutation = f.changes();
      return result;
    });
    const result = await f.preview();
    expect(result.snapshot.settingsRevision).toBe(f.chat.settingsRevision);
    expect(result.snapshot.stale).toBe(true);
    expect(result.caveats).toContain('SNAPSHOT_CHANGED');
    if (change !== 'settings')
      expect(f.store.product.profile(f.chat.id).revision).toBe(profileRevision);
    expect(f.changes()).toBe(afterMutation);
  }
);

test('missing model remains unknown and malformed drafts are rejected before execution', async () => {
  const f = await fixture(false);
  const before = f.changes();
  const result = await f.preview();
  expect(result.selected.model).toBeNull();
  expect(result.error).toBe('MAIN_MODEL_REQUIRED');
  expect(result.tokens).toMatchObject({
    estimatedInputTokens: null,
    inputTokenLimit: null,
    status: 'unknown',
  });
  expect(result.summary.compactionPending).toBeNull();
  for (const body of [
    { request: '' },
    { request: 'x'.repeat(REQUEST_TEXT_MAX_CHARS + 1) },
    { request: 'Valid', loreContextReset: 'yes' },
    { request: 'Valid', program: {} },
  ])
    expect((await f.post(body)).statusCode).toBe(400);
  expect(f.changes()).toBe(before);
});

test('failed native preparation returns unknown counts rather than invented zero or private errors', async () => {
  const f = await fixture();
  vi.spyOn(nativeRun, 'prepareNativeRisuRun').mockRejectedValueOnce(
    new Error('PRIVATE_NATIVE_ERROR')
  );
  const before = f.changes();
  const result = await f.preview();
  expect(result.error).toBe('PREVIEW_UNAVAILABLE');
  expect(result.tokens.estimatedInputTokens).toBeNull();
  expect(result.lore.retainedEntries).toBeNull();
  expect(result.lore.pinnedEntries).toBeNull();
  expect(result.summary).toEqual({
    available: null,
    inUse: null,
    compactedSources: null,
    compactionPending: null,
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_NATIVE_ERROR');
  expect(f.changes()).toBe(before);
});
