import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { RunSnapshot, Usage } from '../core/types.js';
import { captureChatCopy } from '../server/chat-copy.js';
import { settleSnapshot } from '../server/execution-snapshot.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createNativeRisuHost } from '../server/risu-native-host.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(path));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-native-model-selection-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

test.each([
  ['script', 'model'],
  ['script', 'connection'],
  ['context', 'model'],
  ['context', 'connection'],
] as const)(
  'a deleted %s %s does not block unrelated calls or route to the main model',
  async (role, deleted) => {
    const path = mkdtempSync(join(tmpdir(), 'uimori-native-model-selection-'));
    const store = new Store(join(path, 'story.sqlite'));
    owned.push({ path, store });
    const chat = createFixtureChat(store, 'Selection');
    const model = (name: string) => {
      const connection = store.product.connection({
        title: name,
        protocol: 'fixture-sse-v1',
        endpoint: 'http://127.0.0.1:9',
        enabled: true,
      });
      const preset = store.product.model({
        title: name,
        connectionId: connection.id,
        modelId: name,
        maxOutputTokens: 512,
        temperature: null,
      });
      return { connection, preset };
    };
    const main = model('main-model');
    const selected = model('selected-model');
    const current = modelWorkspace(store);
    updateModelWorkspace(store, {
      expectedRevision: current.revision,
      routes: { ...current.routes, main: { id: main.preset.id } },
      translationPolicy: current.translationPolicy,
      [role === 'script' ? 'scriptModel' : 'contextModel']: { id: selected.preset.id },
    });
    const original = store.product.snapshot(chat.id);
    const target = deleted === 'model' ? selected.preset : selected.connection;
    deleteLibraryItem(store, deleted, target.id, { expectedRevision: target.revision });
    const profile = store.product.snapshot(chat.id);
    const snapshot: RunSnapshot = {
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Continue',
      history: [],
      resources: [],
      profile,
    };
    const run = store.createRun(
      chat.id,
      {
        request: snapshot.request,
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: 'selected-model-deleted',
      },
      () => snapshot
    ).run;
    store.startRun(run.id);
    const flag = `${role}ModelUnavailable` as const;
    const selection = `${role}Model` as const;
    const unavailableWorkspace = modelWorkspace(store);
    updateModelWorkspace(store, {
      expectedRevision: unavailableWorkspace.revision,
      routes: unavailableWorkspace.routes,
      translationPolicy: unavailableWorkspace.translationPolicy,
      [selection]: null,
    });
    expect(store.product.snapshot(chat.id)).not.toHaveProperty(flag);
    const clearedWorkspace = modelWorkspace(store);
    updateModelWorkspace(store, {
      expectedRevision: clearedWorkspace.revision,
      routes: clearedWorkspace.routes,
      translationPolicy: clearedWorkspace.translationPolicy,
      [selection]: { id: main.preset.id },
    });
    const changed = store.product.snapshot(chat.id);
    expect(changed).not.toHaveProperty(flag);
    expect(changed[selection]?.id).toBe(main.preset.id);
    const sentModels: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      sentModels.push(JSON.parse(String(init.body)).modelId);
      return new Response(
        'data: {"type":"text_delta","delta":"ok"}\n\ndata: {"type":"done","reason":"stop"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      );
    });
    vi.stubGlobal('fetch', fetch);
    const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const host = createNativeRisuHost(store, run.id, run.snapshot, usage, {}, 'start');
    const signal = new AbortController().signal;
    const mode = role === 'script' ? 'otherAx' : 'memory';
    expect(await host('axLLM', { prompt: 'Continue', options: { mode } }, signal)).toEqual({
      success: false,
      result: `Error: RISU_NATIVE_MODEL_UNAVAILABLE:${mode}`,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(usage.modelCalls).toBe(0);
    expect(run.snapshot.profile?.[flag]).toBe(true);
    expect(original[selection]?.id).toBe(selected.preset.id);
    expect(settleSnapshot(run.snapshot).profile).not.toHaveProperty(flag);
    expect(captureChatCopy(store, chat.id).state.profile).not.toHaveProperty(flag);
    expect(await host('LLM', { prompt: 'Continue' }, signal)).toEqual({
      success: true,
      result: 'ok',
    });
    expect(sentModels).toEqual(['main-model']);
    expect(usage.modelCalls).toBe(1);
  }
);
