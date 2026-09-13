import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createApp, type App } from '../server/app.js';
import { Store } from '../server/store.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { Run } from '../core/types.js';
import {
  modelWorkspace,
  updateModelWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { forkChat } from '../server/chat-fork.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { contextSourceRefs, withContextProjection } from '../server/context-planning.js';
import { buildMainProviderRequest } from '../server/main-request.js';

const owned: { path: string; app?: App; store?: Store }[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    item.store?.close();
    const target = resolve(item.path),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-prompt-transform-')
    )
      throw new Error('Unsafe fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
  for (const close of closes.splice(0)) await close();
});
async function directory() {
  const item: (typeof owned)[number] = {
    path: await mkdtemp(join(tmpdir(), 'uimori-prompt-transform-')),
  };
  owned.push(item);
  return item;
}
async function start(app: App, chatId: string, request: string) {
  const chat = app.store.chat(chatId);
  const result = await app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/runs`,
    headers: { host: '127.0.0.1' },
    payload: {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(result.statusCode, result.body).toBe(200);
  const queued = result.json() as Run;
  await vi.waitFor(
    () => {
      expect(['queued', 'running', 'waiting_for_state']).not.toContain(
        app.store.run(queued.id).status
      );
    },
    { timeout: 15_000, interval: 20 }
  );
  const run = app.store.run(queued.id);
  expect(run.status, run.error ?? '').toBe('completed');
  return run;
}

test.each([false, true])(
  'input transform reaches native HTTP, preview and restored compilation; invalid=%s',
  async (invalid) => {
    const provider = await loopbackProvider((_request, response) =>
      writeSse(response, [
        {
          id: 'synthetic-output',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'RAW saved source' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        '[DONE]',
      ])
    );
    closes.push(provider.close);
    const item = await directory();
    const app = (item.app = await createApp({
      dbPath: join(item.path, 'flow.sqlite'),
      buildId: 'prompt-transform-test',
      approvedOrigins: [provider.origin],
    }));
    await app.ready();
    const program = createDefaultPromptProgram('Write the next scene.');
    program.transforms = [
      {
        id: 'input-replace',
        title: 'Synthetic replacement',
        stage: 'input',
        pattern: invalid ? '[' : 'RAW',
        flags: 'g',
        replacement: 'PROJECTED',
      },
    ];
    updatePromptWorkspace(app.store, {
      expectedRevision: modelWorkspace(app.store).revision,
      main: { title: 'Synthetic transform', program, values: {} },
    });
    let chat = createFixtureChat(app.store, 'Synthetic transform flow');
    chat = app.store.settings(chat.id, chat.settingsRevision, {
      ...chat.settings,
      translation: false,
      status: false,
    });
    const connection = app.store.product.connection({
      title: 'Synthetic native loopback',
      protocol: 'openai-chat-v1',
      endpoint: provider.origin,
      enabled: true,
    }) as Connection;
    const model = app.store.product.model({
      title: 'Synthetic native model',
      connectionId: connection.id,
      modelId: 'synthetic-model',
      inputTokenLimit: 8192,
      maxOutputTokens: 1024,
      temperature: null,
    }) as ModelPreset;
    const workspace = modelWorkspace(app.store);
    updateModelWorkspace(app.store, {
      expectedRevision: workspace.revision,
      routes: { ...workspace.routes, main: { id: model.id } },
      translationPolicy: workspace.translationPolicy,
    });
    await start(app, chat.id, 'RAW first request');
    const before = app.store.product.export().tables;
    const preview = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/prompt-preview`,
      payload: { request: 'RAW second request' },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(app.store.product.export().tables).toEqual(before);
    const run = await start(app, chat.id, 'RAW second request');
    const wire = provider.requests.at(-1)!.body;
    expect(provider.requests).toHaveLength(2);
    expect(wire).toContain(invalid ? 'RAW second request' : 'PROJECTED second request');
    expect(wire).toContain(invalid ? 'RAW saved source' : 'PROJECTED saved source');
    if (!invalid) expect(wire).not.toContain('RAW');
    expect(JSON.stringify(preview.json().provider.body)).toContain(
      invalid ? 'RAW second request' : 'PROJECTED second request'
    );
    expect(run.snapshot.request).toBe('RAW second request');
    expect(run.snapshot.history[0].text).toBe('RAW saved source');
    expect(app.store.source(run.sourceRevision!).text).toBe('RAW saved source');
    expect(run.snapshot.promptInputTransforms).toBeDefined();
    const pending = {
      ...run.snapshot,
      promptInputTransforms: undefined,
      promptCompilation: undefined,
    };
    expect(() => buildMainProviderRequest(pending)).toThrow('PROMPT_INPUT_TRANSFORMS_PENDING');
    const staleCompilation = compileSnapshotPrompt(pending).promptCompilation;
    expect(() =>
      buildMainProviderRequest({ ...run.snapshot, promptCompilation: staleCompilation })
    ).toThrow('PROMPT_INPUT_TRANSFORMS_PENDING');
    expect(() => buildMainProviderRequest(run.snapshot)).not.toThrow();
    const compiled = compileSnapshotPrompt({ ...run.snapshot, promptCompilation: undefined });
    expect(compiled.promptCompilation).toEqual(run.snapshot.promptCompilation);
    const compacted = compileSnapshotPrompt(
      withContextProjection(
        run.snapshot,
        contextSourceRefs(run.snapshot),
        'Derived memory stays independent.'
      )
    );
    expect(JSON.stringify(compacted.promptCompilation!.messages)).toContain(
      invalid ? 'RAW second request' : 'PROJECTED second request'
    );
    expect(compacted.promptCompilation!.warnings).not.toContain('PROMPT_INPUT_TRANSFORMS_PENDING');
    const candidateResponse = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/candidate`,
      payload: { idempotencyKey: 'candidate-transform-receipt' },
    });
    expect(candidateResponse.statusCode, candidateResponse.body).toBe(200);
    const candidateId = candidateResponse.json().id as string;
    await vi.waitFor(() => expect(app.store.run(candidateId).status).toBe('completed'), {
      timeout: 15_000,
      interval: 20,
    });
    expect(app.store.run(candidateId).snapshot.promptInputTransforms).toEqual(
      run.snapshot.promptInputTransforms
    );
    expect(provider.requests.at(-1)!.body).toBe(wire);
    const forked = forkChat(app.store, chat.id, {
      fromRevision: run.sourceRevision,
      idempotencyKey: 'fork-transformed-history',
    });
    expect(app.store.source(forked.headRevision!).text).toBe('RAW saved source');
    const restoredItem = await directory();
    const restored = (restoredItem.store = new Store(join(restoredItem.path, 'restored.sqlite')));
    restored.product.import(app.store.product.export());
    expect(restored.run(run.id).snapshot.promptInputTransforms).toEqual(
      run.snapshot.promptInputTransforms
    );
    expect(restored.source(run.sourceRevision!).text).toBe('RAW saved source');
    const detail = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/context` });
    expect(detail.statusCode, detail.body).toBe(200);
    const state = detail.json();
    const edit = await app.inject({
      method: 'PUT',
      url: `/api/chats/${chat.id}/context/summary`,
      payload: {
        expectedRevision: state.activeRevision,
        expectedHeadRevision: state.headRevision,
        idempotencyKey: 'manual-summary-transform',
        summary: 'User edited derived memory.',
      },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(provider.requests).toHaveLength(3);
  }
);
