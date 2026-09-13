import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Run } from '../server/store.js';
import type { Content } from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import type { RunSnapshot } from '../core/types.js';
import {
  EXTENSION_PROGRAM_API,
  ExtensionProgramError,
  type ExtensionProgram,
} from '../core/extension-program.js';
import { prepareAfterResponse, skipAfterResponse } from '../server/package-after-response.js';
import {
  runBehaviorProgress,
  prepareAutomaticRunBehavior,
} from '../server/package-behavior-run.js';
import { readChatVariables } from '../server/chat-variables.js';
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
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-after-response-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
function fixture(configure?: (pkg: ContentPackage) => void) {
  const store = database();
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
function addModule(f: Fixture, configure?: (pkg: ContentPackage) => void) {
  const pkg = definition();
  configure?.(pkg);
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

const variablesProgram = (source: string): ExtensionProgram => ({
  api: EXTENSION_PROGRAM_API,
  capabilities: ['variables.read', 'variables.write'],
  source,
});
function grantVariables(f: Fixture, exclude?: string) {
  const profile = f.store.product.profile(f.chat.id);
  updateTestProfile(f.store.product, f.chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    routes: profile.routes,
    image: profile.image,
    packageAttachments: profile.packageAttachments,
    extensionGrants: Object.fromEntries(
      profile
        .packageAttachments!.filter((ref) => `${ref.id}:${ref.role}` !== exclude)
        .map((ref) => [
          `${ref.id}:${ref.role}`,
          { packageRevision: ref.revision, capabilities: ['variables.write'] },
        ])
    ),
  });
}

test('after-turn variables inherit preparation and successful package writes, then archive without replay', async () => {
  const f = fixture((pkg) => {
    const after = pkg.behavior!.actions[0];
    after.program = variablesProgram(
      "const p = await api.host.call('variables.read', {key:'phase'}); await api.host.call('variables.set', {key:'phase',value:p.value + ':bot'}); return {state:{count:api.state.count+1},result:p.value};"
    );
    pkg.behavior!.actions.unshift({
      ...structuredClone(after),
      id: 'before',
      triggers: ['before-turn'],
      automaticInput: {},
      program: variablesProgram(
        "await api.host.call('variables.set', {key:'phase',value:'prefix'}); return {state:{count:api.state.count+1},result:'prefix'};"
      ),
    });
  });
  addModule(f, (pkg) => {
    pkg.behavior!.actions[0].program = variablesProgram(
      "const p = await api.host.call('variables.read', {key:'phase'}); await api.host.call('variables.set', {key:'phase',value:p.value + ':module'}); return {state:{count:api.state.count+1},result:p.value};"
    );
  });
  grantVariables(f);
  const run = start(f),
    frozen = structuredClone(run.snapshot);
  await prepareAutomaticRunBehavior(f.store, run.id);
  await prepareAfterResponse(f.store, run.id, 'source survives');
  expect(receipt(f, run).packages.map((p) => p.entries[0].result)).toEqual([
    'prefix',
    'prefix:bot',
  ]);
  expect(readChatVariables(f.store, f.chat.id, `main:${f.chat.id}`)).toEqual({
    revision: 0,
    values: {},
  });
  finish(f, run, 'source survives');
  expect(readChatVariables(f.store, f.chat.id, `main:${f.chat.id}`)).toEqual({
    revision: 3,
    values: { phase: 'prefix:bot:module' },
  });
  expect(f.store.run(run.id).snapshot).toEqual(frozen);
  const archived = f.store.product.export();
  const restored = database();
  const execute = vi.spyOn(runtime, 'executeExtensionProgram');
  const tampered = structuredClone(archived);
  const row = tampered.tables.package_behavior_runs.find((item) => item.run_id === run.id)!;
  const broken = JSON.parse(row.body);
  broken.afterResponse.packages[1].entries[0].program.variables.beforeRevision++;
  row.body = JSON.stringify(broken);
  expect(() => restored.product.import(tampered)).toThrow();
  expect(restored.chats()).toHaveLength(0);
  restored.product.import(archived);
  expect(execute).not.toHaveBeenCalled();
  expect(readChatVariables(restored, f.chat.id, `main:${f.chat.id}`)).toEqual({
    revision: 3,
    values: { phase: 'prefix:bot:module' },
  });
});

test('failed after-turn package discards staged variables before the following package reads', async () => {
  const f = fixture((pkg) => {
    pkg.variableDefaults = { values: { phase: 'default' } };
    pkg.behavior!.actions[0].program = variablesProgram(
      "await api.host.call('variables.set',{key:'phase',value:'discard me'}); throw Error('failed package');"
    );
  });
  addModule(f, (pkg) => {
    pkg.behavior!.actions[0].program = variablesProgram(
      "const p=await api.host.call('variables.read',{key:'phase'}); await api.host.call('variables.set',{key:'phase',value:p.value+':module'}); return {state:{count:1},result:p.value};"
    );
  });
  grantVariables(f);
  const run = start(f);
  await prepareAfterResponse(f.store, run.id, 'kept text');
  expect(receipt(f, run).packages.map((p) => p.status)).toEqual(['failed', 'ready']);
  expect(receipt(f, run).packages[1].entries[0].result).toBe('default');
  finish(f, run, 'kept text');
  expect(readChatVariables(f.store, f.chat.id, `main:${f.chat.id}`)).toEqual({
    revision: 1,
    values: { phase: 'default:module' },
  });
  expect(current(f).map((p) => p.state)).toEqual([{ count: 0 }, { count: 1 }]);
});

test('revoked after-turn write rejects dependent later adoption while preserving the source', async () => {
  const f = fixture((pkg) => {
    pkg.behavior!.actions[0].program = variablesProgram(
      "await api.host.call('variables.set',{key:'phase',value:'bot'}); return {state:{count:1},result:'bot'};"
    );
  });
  addModule(f, (pkg) => {
    pkg.behavior!.actions[0].program = variablesProgram(
      "const p=await api.host.call('variables.read',{key:'phase'}); await api.host.call('variables.set',{key:'phase',value:p.value+':module'}); return {state:{count:1},result:p.value};"
    );
  });
  grantVariables(f);
  const run = start(f);
  await prepareAfterResponse(f.store, run.id, 'valid original');
  expect(receipt(f, run).packages.every((p) => p.status === 'ready')).toBe(true);
  grantVariables(f, f.instanceId);
  const source = finish(f, run, 'valid original');
  expect(f.store.source(source.id).text).toBe('valid original');
  expect(receipt(f, run).packages.every((p) => p.status === 'failed')).toBe(true);
  expect(readChatVariables(f.store, f.chat.id, `main:${f.chat.id}`)).toEqual({
    revision: 0,
    values: {},
  });
  expect(current(f).map((p) => p.state)).toEqual([{ count: 0 }, { count: 0 }]);
});

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

function skipBody(f: Fixture, run: Run, key = 'skip-after') {
  return {
    chatId: f.chat.id,
    branchId: run.snapshot.branchId,
    expectedRevision: run.parentRevision,
    idempotencyKey: key,
  };
}
function modelFixture() {
  return fixture((pkg) => {
    pkg.behavior!.actions[0].program = {
      api: EXTENSION_PROGRAM_API,
      capabilities: ['model.generate'],
      source:
        "const result = await api.host.call('model.generate', {prompt:'synthetic'}); return {state:{count:7},result};",
    };
  });
}

test('synchronous progress skip closes adoption before the first guest and retries by exact ownership', async () => {
  const f = fixture(),
    run = start(f);
  const execute = vi.spyOn(runtime, 'executeExtensionProgram');
  await prepareAfterResponse(f.store, run.id, 'hello', undefined, () => {
    expect(() =>
      skipAfterResponse(f.store, run.id, { ...skipBody(f, run), branchId: 'foreign' })
    ).toThrow('OWNER_MISMATCH');
    expect(skipAfterResponse(f.store, run.id, skipBody(f, run)).skipped).toBe(true);
  });
  expect(execute).not.toHaveBeenCalled();
  expect(receipt(f, run)).toMatchObject({ status: 'skipped', completed: 0, skipKey: 'skip-after' });
  finish(f, run, 'hello');
  expect(current(f)[0].state).toEqual({ count: 0 });
  expect(skipAfterResponse(f.store, run.id, skipBody(f, run)).skipped).toBe(true);
  expect(skipAfterResponse(f.store, run.id, skipBody(f, run, 'different')).skipped).toBe(false);
});

test('skipping after a computed package keeps variable receipts without adopting their writes', async () => {
  const configure = (pkg: ContentPackage) => {
    pkg.behavior!.actions[0].program = variablesProgram(
      "await api.host.call('variables.set',{key:'phase',value:'staged'}); return {state:{count:1},result:'staged'};"
    );
  };
  const f = fixture(configure);
  addModule(f, configure);
  grantVariables(f);
  const run = start(f);
  await prepareAfterResponse(f.store, run.id, 'skip keeps source', undefined, () => {
    if (receipt(f, run).completed === 1)
      expect(skipAfterResponse(f.store, run.id, skipBody(f, run)).skipped).toBe(true);
  });
  expect(receipt(f, run)).toMatchObject({ status: 'skipped', completed: 1 });
  expect(receipt(f, run).packages[0].entries[0].program.variables?.changes).toEqual({
    phase: 'staged',
  });
  finish(f, run, 'skip keeps source');
  expect(readChatVariables(f.store, f.chat.id, `main:${f.chat.id}`)).toEqual({
    revision: 0,
    values: {},
  });
  expect(current(f).map((p) => p.state)).toEqual([{ count: 0 }, { count: 0 }]);
});

test('after model results reauthorize before adoption and use a bounded host wait', async () => {
  const f = modelFixture(),
    run = start(f);
  const execute = vi.spyOn(runtime, 'executeExtensionProgram');
  const assertModelAccess = vi.fn();
  const services = vi.fn(() => ({
    modelGenerate: async () => 'result',
    assertModelAccess,
    hostWaitMs: 40 * 60_000,
  }));
  await prepareAfterResponse(f.store, run.id, 'hello', undefined, undefined, services);
  expect(services).toHaveBeenCalledWith({
    instanceId: f.instanceId,
    actionId: 'after',
    trigger: 'after-turn',
  });
  expect(execute.mock.calls[0][3]).toMatchObject({
    awaitHostSettlement: true,
    hostWaitMs: 30 * 60_000,
  });
  expect(assertModelAccess).toHaveBeenCalledOnce();
  finish(f, run, 'hello');
  expect(current(f)[0].state).toEqual({ count: 7 });
});

test.each([false, true])(
  'skip waits for paid host settlement and preserves fatal errors (%s)',
  async (fatal) => {
    const f = modelFixture(),
      run = start(f);
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let settled = false;
    const work = prepareAfterResponse(f.store, run.id, 'hello', undefined, undefined, () => ({
      modelGenerate: async () => {
        entered();
        await settlement;
        if (fatal) throw new Error('fatal settlement');
        return 'late';
      },
      assertModelAccess: () => {},
      hostWaitMs: 30_000,
    }));
    const outcome = work.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await admitted;
    skipAfterResponse(f.store, run.id, skipBody(f, run));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(receipt(f, run).status).toBe('skipped');
    settle();
    const error = await outcome;
    if (fatal) expect(error).toMatchObject({ message: 'fatal settlement' });
    else {
      expect(error).toBeNull();
      finish(f, run, 'hello');
      expect(current(f)[0].state).toEqual({ count: 0 });
    }
  }
);

test('revoked model access discards after state while preserving the raw source', async () => {
  const f = modelFixture(),
    run = start(f);
  await prepareAfterResponse(f.store, run.id, 'hello', undefined, undefined, () => ({
    modelGenerate: async () => 'result',
    assertModelAccess: () => {
      throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_DENIED');
    },
    hostWaitMs: 30_000,
  }));
  expect(receipt(f, run).packages[0]).toMatchObject({
    status: 'failed',
    code: 'BEHAVIOR_HOST_MODEL_DENIED',
    entries: [],
  });
  finish(f, run, 'hello');
  expect(current(f)[0].state).toEqual({ count: 0 });
});
