import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Run } from '../server/store.js';
import type { Content } from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import type { RunSnapshot } from '../core/types.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import { prepareAfterResponse } from '../server/package-after-response.js';
import { runBehaviorProgress } from '../server/package-behavior-run.js';
import * as behaviorRuntime from '../server/package-behavior-run.js';
import { BehaviorError } from '../core/package-behavior.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import * as runtime from '../server/extension-runtime.js';
import { createFixtureChat } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';

const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-after-response-')
    )
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function definition(): ContentPackage {
  return {
    version: 1,
    id: 'after-response',
    revision: 1,
    title: 'Synthetic after response',
    description: '',
    body: 'Synthetic material',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      stateSchema: {
        type: 'record',
        properties: { count: { type: 'number', min: 0, max: 10000, integer: true } },
      },
      initialState: { count: 0 },
      outputParsers: [],
      actions: [
        {
          id: 'after',
          triggers: ['after-turn'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            capabilities: ['response.read.current'],
            source:
              "const page = await api.host.call('response.read', {}); return {state: {count: api.state.count + page.totalChars}, result: page.text};",
          },
        },
      ],
    },
  };
}
function fixture(configure?: (pkg: ContentPackage) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-after-response-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  const pkg = definition();
  configure?.(pkg);
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: '',
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic after response', 'calm', { botId: content.id });
  return { store, chat, instanceId: `${content.id}:bot` };
}
type Fixture = ReturnType<typeof fixture>;
function addModule(f: Fixture) {
  const pkg = definition();
  const content = f.store.product.content({
    kind: 'module',
    title: pkg.title,
    description: '',
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const profile = f.store.product.profile(f.chat.id);
  updateTestProfile(f.store.product, f.chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    routes: profile.routes,
    image: profile.image,
    packageAttachments: [
      ...(profile.packageAttachments ?? []),
      { id: content.id, revision: 1, role: 'module' },
    ],
    packageValues: profile.packageValues,
  });
}
function start(f: Fixture) {
  const chat = f.store.chat(f.chat.id),
    profile = f.store.product.snapshot(chat.id);
  const snapshot: RunSnapshot = {
    chatId: chat.id,
    branchId: `main:${chat.id}`,
    parentRevision: chat.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: 'Synthetic request',
    history: f.store.history(chat.headRevision),
    profile,
    resources: f.store.product.resources(chat.id, profile),
  };
  const run = f.store.createRun(
    chat.id,
    {
      request: snapshot.request,
      expectedRevision: snapshot.parentRevision,
      expectedSettingsRevision: snapshot.settingsRevision,
      branchId: snapshot.branchId,
      idempotencyKey: randomUUID(),
    },
    () => snapshot
  ).run;
  expect(f.store.startRun(run.id)).toBe(true);
  return f.store.run(run.id);
}
function finish(f: Fixture, run: Run, text: string) {
  return f.store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
const current = (f: Fixture) => behaviorDetail(f.store, f.chat.id).instances;
const receipt = (f: Fixture, run: Run) => runBehaviorProgress(f.store, run.id)!.afterResponse!;

test('after-only program reads its fixed response and publishes only with the source', async () => {
  const f = fixture(),
    run = start(f),
    reserved = structuredClone(run.snapshot);
  const execute = vi.spyOn(runtime, 'executeExtensionProgram');
  await prepareAfterResponse(f.store, run.id, 'hello');
  expect(receipt(f, run)).toMatchObject({
    status: 'completed',
    completed: 1,
    total: 1,
    packages: [
      {
        status: 'ready',
        before: { state: { count: 0 } },
        after: { state: { count: 5 } },
        entries: [{ result: 'hello' }],
      },
    ],
  });
  expect(current(f)[0].state).toEqual({ count: 0 });
  expect(f.store.run(run.id).snapshot).toEqual(reserved);
  expect(runBehaviorProgress(f.store, run.id)!.entries).toEqual([]);
  await prepareAfterResponse(f.store, run.id, 'hello');
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(prepareAfterResponse(f.store, run.id, 'different')).rejects.toThrow(
    'BEHAVIOR_AFTER_RESPONSE_SOURCE_CHANGED'
  );
  finish(f, run, 'hello');
  expect(current(f)[0]).toMatchObject({ state: { count: 5 }, stateRevision: 1 });
});

test('output parsers precede after programs and each group advances the revision', async () => {
  const f = fixture((pkg) => {
    pkg.behavior!.outputParsers = [
      {
        id: 'count',
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['count'], from: ['count'] }],
      },
    ];
    pkg.behavior!.actions[0].program!.source =
      'return {state: {count: api.state.count + 1}, result: api.state.count};';
  });
  const run = start(f),
    text = '<state>{"count":7}</state>';
  await prepareAfterResponse(f.store, run.id, text);
  expect(receipt(f, run).packages[0]).toMatchObject({
    before: { stateRevision: 1, state: { count: 7 } },
    after: { stateRevision: 2, state: { count: 8 } },
  });
  expect(current(f)[0].state).toEqual({ count: 0 });
  finish(f, run, text);
  expect(current(f)[0]).toMatchObject({ stateRevision: 2, state: { count: 8 } });
});

test('failed package discards every staged action while an independent package completes', async () => {
  const f = fixture((pkg) => {
    const action = structuredClone(pkg.behavior!.actions[0]);
    action.id = 'fail';
    action.program!.source = 'throw new Error("private guest text");';
    pkg.behavior!.actions.push(action);
  });
  addModule(f);
  const run = start(f);
  await prepareAfterResponse(f.store, run.id, 'hello');
  expect(receipt(f, run).packages.map((item) => item.status)).toEqual(['failed', 'ready']);
  expect(receipt(f, run).packages[0]).toMatchObject({
    entries: [],
    after: { state: { count: 0 } },
  });
  expect(JSON.stringify(receipt(f, run))).not.toContain('private guest text');
  finish(f, run, 'hello');
  expect(current(f).map((item) => item.state)).toEqual([{ count: 0 }, { count: 5 }]);
});

test('authoritative parser failure prevents all guest execution', async () => {
  const f = fixture((pkg) => {
    pkg.behavior!.outputParsers = [
      {
        id: 'required',
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['count'], from: ['count'] }],
      },
    ];
  });
  addModule(f);
  const run = start(f),
    execute = vi.spyOn(runtime, 'executeExtensionProgram');
  await prepareAfterResponse(f.store, run.id, 'missing required state');
  expect(execute).not.toHaveBeenCalled();
  expect(receipt(f, run).packages.every((item) => item.status === 'failed')).toBe(true);
});

test('cancellation during a guest prevents receipt completion and state publication', async () => {
  const f = fixture((pkg) => {
    pkg.behavior!.actions[0].program!.source = 'while (true) {}';
  });
  const run = start(f),
    controller = new AbortController();
  const work = prepareAfterResponse(f.store, run.id, 'hello', controller.signal);
  controller.abort();
  await expect(work).rejects.toThrow('BEHAVIOR_RUN_CANCELLED');
  expect(receipt(f, run).status).toBe('running');
  expect(current(f)[0].state).toEqual({ count: 0 });
});

test('annotation parser failure skips only that package', async () => {
  const f = fixture((pkg) => {
    pkg.behavior!.mode = 'annotation';
    pkg.behavior!.outputParsers = [
      {
        id: 'required',
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['count'], from: ['count'] }],
      },
    ];
  });
  addModule(f);
  const run = start(f);
  await prepareAfterResponse(f.store, run.id, 'hello');
  expect(receipt(f, run).packages.map((item) => item.status)).toEqual(['failed', 'ready']);
  finish(f, run, 'hello');
  expect(current(f).map((item) => item.state)).toEqual([{ count: 0 }, { count: 5 }]);
});

test('disabled parser still advances its native parser group revision', async () => {
  const f = fixture((pkg) => {
    pkg.behavior!.outputParsers = [
      {
        id: 'disabled',
        when: false,
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['count'], from: ['count'] }],
      },
    ];
  });
  const run = start(f);
  await prepareAfterResponse(f.store, run.id, 'hello');
  expect(receipt(f, run).packages[0]).toMatchObject({
    before: { stateRevision: 1, state: { count: 0 } },
    after: { stateRevision: 2, state: { count: 5 } },
  });
  finish(f, run, 'hello');
  expect(current(f)[0]).toMatchObject({ stateRevision: 2, state: { count: 5 } });
});

test('source hash mismatch is fatal and leaves the native source transaction unpublished', async () => {
  const f = fixture(),
    run = start(f);
  await prepareAfterResponse(f.store, run.id, 'hello');
  expect(() => finish(f, run, 'different source')).toThrow(
    'BEHAVIOR_AFTER_RESPONSE_RECEIPT_INVALID'
  );
  expect(f.store.chat(f.chat.id).headRevision).toBeNull();
  expect(current(f)[0].state).toEqual({ count: 0 });
});

test('invalid guest state preserves the parser-derived result', async () => {
  const f = fixture((pkg) => {
    pkg.behavior!.outputParsers = [
      {
        id: 'count',
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['count'], from: ['count'] }],
      },
    ];
    pkg.behavior!.actions[0].program!.source = 'return {state: {count: -1}, result: null};';
  });
  const run = start(f),
    text = '<state>{"count":7}</state>';
  await prepareAfterResponse(f.store, run.id, text);
  expect(receipt(f, run).packages[0]).toMatchObject({
    status: 'failed',
    entries: [],
    after: { state: { count: 7 } },
  });
  finish(f, run, text);
  expect(current(f)[0]).toMatchObject({ stateRevision: 1, state: { count: 7 } });
});

test('combined journal size failure drops only after receipts and still commits the source', async () => {
  const f = fixture((pkg) => {
    pkg.behavior!.actions.unshift({
      id: 'before',
      triggers: ['before-turn'],
      inputSchema: { type: 'record', properties: {} },
      effects: [{ path: ['count'], value: 1 }],
    });
  });
  const run = start(f),
    original = runBehaviorProgress(f.store, run.id);
  const save = behaviorRuntime.saveProgress;
  vi.spyOn(behaviorRuntime, 'saveProgress').mockImplementation((store, runId, progress) => {
    if (progress.afterResponse?.packages.length)
      throw new BehaviorError(409, 'BEHAVIOR_RUN_JOURNAL_LIMIT');
    save(store, runId, progress);
  });
  const execute = vi.spyOn(runtime, 'executeExtensionProgram'),
    publish = vi.fn();
  await prepareAfterResponse(f.store, run.id, 'hello', undefined, publish);
  expect(runBehaviorProgress(f.store, run.id)).toEqual(original);
  expect(
    f.store
      .events(f.chat.id, 0)
      .filter((event) => event.kind === 'run.package-after-response.unavailable')
  ).toMatchObject([{ entityId: run.id }]);
  expect(publish).toHaveBeenCalled();
  await prepareAfterResponse(f.store, run.id, 'hello');
  expect(execute).toHaveBeenCalledTimes(1);
  const source = finish(f, run, 'hello');
  expect(source.text).toBe('hello');
  expect(current(f)[0]).toMatchObject({ stateRevision: 1, state: { count: 1 } });
});
