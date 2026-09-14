import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { packageControlKey } from '../core/content-package.js';
import { packageInstanceId } from '../core/execution-context.js';
import type { Content } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { readChatVariables } from '../server/chat-variables.js';
import * as extensionRuntime from '../server/extension-runtime.js';
import { executePackageExtensionProgram } from '../server/package-extension-execution.js';
import { prepareAfterResponse } from '../server/package-after-response.js';
import {
  prepareAutomaticRunBehavior,
  preparedBehaviorSnapshot,
  runBehaviorProgress,
} from '../server/package-behavior-run.js';
import { productRoutes } from '../server/product-routes.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';
import { Store } from '../server/store.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';

const owned: { store: Store; app: FastifyInstance; directory: string }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { store, app, directory } of owned.splice(0).reverse()) {
    await app.close();
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-risu-plugin-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-risu-plugin-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const app = Fastify();
  productRoutes(app, store, { approvedOrigins: [], publish: () => {} });
  owned.push({ store, app, directory });
  return { store, app };
}

/**
 * One plugin that exercises the three axes at once: the `//@arg` option, the two script handler
 * phases, and a `pluginStorage` value the input event writes and the output event reads back.
 */
const PLUGIN = [
  '//@name synthetic-plugin',
  '//@display-name Synthetic Plugin',
  '//@api 3.0',
  '//@arg prefix string 전송 사본 앞에 붙일 말',
  "risuai.addRisuScriptHandler('input', async (text) => {",
  "  const prefix = await risuai.getArgument('prefix');",
  "  const seen = await risuai.pluginStorage.getItem('seen');",
  "  await risuai.pluginStorage.setItem('seen', (seen ?? 0) + 1);",
  '  return prefix + text;',
  '});',
  "risuai.addRisuScriptHandler('output', async (text) => {",
  "  const seen = await risuai.pluginStorage.getItem('seen');",
  "  await risuai.pluginStorage.setItem('log', 'output');",
  "  return text + ' [' + String(seen) + ']';",
  '});',
].join('\n');

const fileOf = (code: string) => ({
  name: 'synthetic-plugin.js',
  base64: Buffer.from(code, 'utf8').toString('base64'),
});

function imported(code = PLUGIN, options: { grant?: boolean; prefix?: string } = {}) {
  const { store, app } = database();
  const source = fileOf(code);
  const preview = prepareRisuImport({ source });
  const saved = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    // Unmapped Risu members stay explicit pending findings, so a plugin is always a partial import.
    allowPartial: true,
    idempotencyKey: randomUUID(),
  });
  const content = store.product.get<Content>('content', saved.receipt.items[0].id);
  const chat = createFixtureChat(store, 'Synthetic plugin chat');
  const attachment = { id: content.id, revision: content.revision, role: 'module' as const };
  const profile = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    image: profile.image,
    packageAttachments: [...(profile.packageAttachments ?? []), attachment],
    ...(options.prefix === undefined
      ? {}
      : { packageValues: { [packageControlKey(attachment)]: { prefix: options.prefix } } }),
    ...(options.grant === false
      ? {}
      : {
          extensionGrants: {
            [packageInstanceId(attachment)]: {
              packageRevision: content.revision,
              capabilities: ['variables.write', 'conversation.read'],
            },
          },
        }),
  });
  return {
    store,
    app,
    preview,
    saved,
    chat,
    content,
    attachment,
    branchId: store.product.branch(chat.id).id,
  };
}

type Fixture = ReturnType<typeof imported>;

function generation(fixture: Fixture, request: string) {
  const { store, chat, branchId } = fixture;
  const profile = store.product.snapshot(chat.id);
  const snapshot: RunSnapshot = {
    chatId: chat.id,
    branchId,
    parentRevision: store.product.branch(chat.id).headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request,
    history: [],
    logicalHistory: [],
    profile,
    resources: store.product.resources(chat.id, profile),
  };
  const run = store.createRun(
    chat.id,
    {
      request,
      expectedRevision: snapshot.parentRevision,
      expectedSettingsRevision: snapshot.settingsRevision,
      branchId,
      idempotencyKey: randomUUID(),
    },
    () => snapshot
  ).run;
  expect(store.startRun(run.id)).toBe(true);
  return run;
}

test('an imported plugin is a module package whose actions carry the option and the two phases', () => {
  const execute = vi.spyOn(extensionRuntime, 'executeExtensionProgram');
  const fixture = imported();
  // Reading and registering a plugin never runs it; only an attached chat turn does.
  expect(execute).not.toHaveBeenCalled();
  expect(fixture.preview).toMatchObject({
    kind: 'module',
    format: 'risu-plugin-js',
    title: 'Synthetic Plugin',
    plugin: { name: 'synthetic-plugin', apiVersion: '3.0' },
  });
  expect(fixture.content.package!.controls).toEqual([
    {
      id: 'prefix',
      label: 'prefix',
      type: 'text',
      default: '',
      description: '전송 사본 앞에 붙일 말',
    },
  ]);
  expect(
    fixture.content.package!.behavior!.actions.map((action) => [action.id, action.hook])
  ).toEqual([
    ['risu-plugin-editInput', 'edit-input'],
    ['risu-plugin-editOutput', 'edit-output'],
  ]);
  expect(fixture.preview.findings).toContainEqual(
    expect.objectContaining({ code: 'plugin-actions', level: 'warning' })
  );
});

test('the option reaches the transmitted copy and storage round-trips into the display copy', async () => {
  const fixture = imported(PLUGIN, { prefix: '[검토] ' });
  const run = generation(fixture, '원문 요청.');
  const reserved = structuredClone(fixture.store.run(run.id).snapshot);
  await prepareAutomaticRunBehavior(fixture.store, run.id);
  expect(runBehaviorProgress(fixture.store, run.id)!.preparation?.status).toBe('ready');
  const prepared = preparedBehaviorSnapshot(fixture.store, run.id);
  // The reserved Run keeps what the user submitted; only the transmitted projection carries the edit.
  expect(fixture.store.run(run.id).snapshot).toEqual(reserved);
  expect(prepared.request).toBe('원문 요청.');
  expect(prepared.extensionRequestEdit).toMatchObject({ text: '[검토] 원문 요청.' });
  expect(JSON.stringify(compileSnapshotPrompt(prepared).promptCompilation!.messages)).toContain(
    '[검토] 원문 요청.'
  );

  const response = '모델 응답.';
  fixture.store.stageRunOutput(run.id, response);
  await prepareAfterResponse(fixture.store, run.id, response);
  expect(runBehaviorProgress(fixture.store, run.id)!.afterResponse!.status).toBe('completed');
  fixture.store.completeRun(
    run.id,
    response,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const sourceId = fixture.store.product.branch(fixture.chat.id).headRevision!;
  expect(fixture.store.source(sourceId).text).toBe(response);
  const presentation = await injectWithFixtureBot(fixture.app, {
    method: 'GET',
    url: `/api/chats/${fixture.chat.id}/sources/${sourceId}/presentation`,
  });
  // The output event read back the value the input event wrote, one fresh invocation earlier.
  expect(presentation.json()).toMatchObject({
    original: { text: '모델 응답. [1]', changed: true },
  });
  expect(readChatVariables(fixture.store, fixture.chat.id, fixture.branchId).values).toEqual({
    'risu.plugin.storage:seen': '1',
    'risu.plugin.storage:log': '"output"',
  });
});

test('without the shared variable grant each storage write fails its own bundle and changes nothing', async () => {
  const fixture = imported(PLUGIN, { grant: false, prefix: '[검토] ' });
  const run = generation(fixture, '원문 요청.');
  await prepareAutomaticRunBehavior(fixture.store, run.id);
  expect(runBehaviorProgress(fixture.store, run.id)!.preparation?.status).toBe('failed');
  const prepared = preparedBehaviorSnapshot(fixture.store, run.id);
  expect(prepared.request).toBe('원문 요청.');
  expect(prepared.extensionRequestEdit).toBeUndefined();

  const response = '모델 응답.';
  fixture.store.stageRunOutput(run.id, response);
  await prepareAfterResponse(fixture.store, run.id, response);
  // A failed preparation bundle drops this material from the turn, so its output edit never runs.
  expect(runBehaviorProgress(fixture.store, run.id)!.afterResponse?.packages ?? []).toEqual([]);
  fixture.store.completeRun(
    run.id,
    response,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const sourceId = fixture.store.product.branch(fixture.chat.id).headRevision!;
  const presentation = await injectWithFixtureBot(fixture.app, {
    method: 'GET',
    url: `/api/chats/${fixture.chat.id}/sources/${sourceId}/presentation`,
  });
  expect(presentation.json()).toMatchObject({ original: { text: response, changed: false } });
  expect(readChatVariables(fixture.store, fixture.chat.id, fixture.branchId).values).toEqual({});
});

test('a beforeRequest replacer edits the transmitted conversation copy, not the stored request', async () => {
  const fixture = imported(
    [
      '//@name request-plugin',
      '//@api 3.0',
      "risuai.addRisuReplacer('beforeRequest', async (messages) =>",
      "  messages.map((message) => ({role: message.role, content: 'kept:' + message.content})));",
    ].join('\n')
  );
  const run = generation(fixture, '원문 요청.');
  await prepareAutomaticRunBehavior(fixture.store, run.id);
  const prepared = preparedBehaviorSnapshot(fixture.store, run.id);
  expect(prepared.request).toBe('원문 요청.');
  expect(prepared.extensionMessageEdit).toMatchObject({
    entries: [{ index: 0, role: 'user', text: 'kept:원문 요청.' }],
  });
  expect(JSON.stringify(compileSnapshotPrompt(prepared).promptCompilation!.messages)).toContain(
    'kept:원문 요청.'
  );
});

test('an output chat listener receives this branch conversation and the projected bot name', async () => {
  const fixture = imported(
    [
      '//@name listener-plugin',
      '//@api 3.0',
      "risuai.addRisuChatListener('output', async (event) => {",
      "  await risuai.pluginStorage.setItem('seen', {",
      '    name: event.char.name,',
      '    index: event.messageIndex,',
      '    last: event.chat.message[event.messageIndex].data,',
      '  });',
      '});',
    ].join('\n')
  );
  const run = generation(fixture, '원문 요청.');
  await prepareAutomaticRunBehavior(fixture.store, run.id);
  const response = '모델 응답.';
  fixture.store.stageRunOutput(run.id, response);
  await prepareAfterResponse(fixture.store, run.id, response);
  fixture.store.completeRun(
    run.id,
    response,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const stored = readChatVariables(fixture.store, fixture.chat.id, fixture.branchId).values;
  expect(JSON.parse(stored['risu.plugin.storage:seen'])).toEqual({
    name: 'Synthetic fixture owner',
    index: 1,
    last: response,
  });
});

test('a process handler is reported as unsupported and connects no action of its own', () => {
  const fixture = imported(
    [
      '//@name process-plugin',
      '//@api 3.0',
      "risuai.addRisuScriptHandler('process', (text) => text);",
    ].join('\n'),
    // A plugin with no connected action has no behavior to grant anything to.
    { grant: false }
  );
  expect(fixture.preview.findings).toContainEqual(
    expect.objectContaining({
      code: 'RISU_PLUGIN_HOOK_UNSUPPORTED:process',
      level: 'unsupported',
    })
  );
  expect(fixture.content.package!.behavior).toBeUndefined();
});

test('options.read answers only a program that declares self material reading', async () => {
  const fixture = imported(PLUGIN, { prefix: '[검토] ' });
  const read = "return {state: api.state, result: await api.host.call('options.read', {})};";
  const options = {
    profile: fixture.store.product.snapshot(fixture.chat.id),
    attachment: fixture.attachment,
    assertCurrent: () => {},
  };
  const allowed = await executePackageExtensionProgram(
    { api: 'uimori-state-action-v1', capabilities: ['materials.read.self'], source: read },
    { state: {}, input: {} },
    undefined,
    options
  );
  expect(allowed.result).toEqual({ values: { prefix: '[검토] ' } });
  await expect(
    executePackageExtensionProgram(
      { api: 'uimori-state-action-v1', source: read },
      { state: {}, input: {} },
      undefined,
      options
    )
  ).rejects.toThrow('BEHAVIOR_PROGRAM_FAILED');
});
