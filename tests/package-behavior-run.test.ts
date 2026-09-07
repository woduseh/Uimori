import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Run } from '../server/store.js';
import {
  behaviorDetail,
  freezePackageStates,
  performBehaviorAction,
} from '../server/package-behavior-host.js';
import { executeRunBehaviorTool, runBehaviorProgress } from '../server/package-behavior-run.js';
import { listBehaviorTools } from '../core/package-behavior-tools.js';
import { buildMainInput } from '../core/provider.js';
import type { Content, PromptPreset } from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import { validatePackageBehavior, type PackageBehavior } from '../core/package-behavior.js';
import type { RunSnapshot } from '../core/types.js';
import { forkChat } from '../server/chat-fork.js';

const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-behavior-run-'))
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-behavior-run-')),
    store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
const number = { type: 'number' as const, min: 0, max: 1000, integer: true };
function definition(): PackageBehavior {
  return {
    revision: 1,
    schemaVersion: 1,
    stateSchema: {
      type: 'record',
      properties: { days: number, score: number, die: { ...number, min: 0, max: 6 } },
    },
    initialState: { days: 0, score: 0, die: 0 },
    actions: [
      {
        id: 'day',
        label: '새 날',
        inputSchema: { type: 'record', properties: {} },
        triggers: ['before-turn'],
        effects: [
          { path: ['days'], value: { op: 'add', args: [{ context: ['state', 'days'] }, 1] } },
        ],
        result: { context: ['nextState', 'days'] },
      },
      {
        id: 'check',
        label: '판정',
        inputSchema: { type: 'record', properties: { bonus: { ...number, max: 5 } } },
        triggers: ['model'],
        draws: [{ id: 'die', type: 'integer', min: 1, max: 6 }],
        effects: [
          { path: ['die'], value: { context: ['draws', 'die'] } },
          {
            path: ['score'],
            value: {
              op: 'add',
              args: [{ context: ['draws', 'die'] }, { context: ['input', 'bonus'] }],
            },
          },
        ],
        result: {
          op: 'object',
          args: [
            'die',
            { context: ['draws', 'die'] },
            'score',
            { context: ['nextState', 'score'] },
          ],
        },
      },
    ],
    outputParsers: [],
  };
}
function fixture(change?: (b: PackageBehavior) => void) {
  const store = database(),
    behavior = definition();
  change?.(behavior);
  const pkg: ContentPackage = {
    version: 1,
    id: 'synthetic',
    revision: 1,
    title: 'Synthetic execution',
    description: '',
    body: 'Synthetic only',
    lore: [],
    controls: [],
    transforms: [],
    behavior,
    instructions: [
      {
        id: 'day',
        target: 'main',
        text: '',
        template: [
          { kind: 'text', text: 'DAY=' },
          { kind: 'value', expression: { context: ['state', 'days'] } },
        ],
      },
    ],
  };
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: '',
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic run', 'calm', { botId: content.id });
  const prompt = store.product.promptPreset({
    title: 'Synthetic composed',
    role: 'main',
    text: '',
    program: {
      version: 1,
      controls: [],
      blocks: [
        { id: 'bot', title: 'Bot', kind: 'slot', role: 'system', slot: 'bot' },
        { id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' },
      ],
    },
  }) as PromptPreset;
  const profile = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    personaReference: profile.personaReference,
    routes: profile.routes,
    image: profile.image,
    prompts: { main: { id: prompt.id, revision: prompt.revision } },
  });
  return {
    store,
    behavior,
    chat,
    content,
    instanceId: `${content.id}:bot`,
    branchId: `main:${chat.id}`,
  };
}
type Fixture = ReturnType<typeof fixture>;
function snapshot(f: Fixture, branchId = f.branchId): RunSnapshot {
  const chat = f.store.chat(f.chat.id),
    branch = f.store.product.branch(chat.id, branchId),
    profile = f.store.product.snapshot(chat.id);
  return {
    chatId: chat.id,
    branchId,
    parentRevision: branch.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: 'Synthetic next',
    history: f.store.history(branch.headRevision),
    profile,
    resources: f.store.product.resources(chat.id, profile),
  };
}
function admit(f: Fixture, branchId = f.branchId, key = randomUUID()) {
  const s = snapshot(f, branchId);
  return f.store.createRun(
    f.chat.id,
    {
      request: s.request,
      expectedRevision: s.parentRevision,
      expectedSettingsRevision: s.settingsRevision,
      branchId,
      idempotencyKey: key,
    },
    () => s
  ).run;
}
function start(f: Fixture, run = admit(f)) {
  expect(f.store.startRun(run.id)).toBe(true);
  return f.store.run(run.id);
}
function call(f: Fixture, run: Run, bonus = 1, callId = randomUUID()) {
  const binding = listBehaviorTools(run.snapshot).find((t) => t.actionId === 'check')!;
  return executeRunBehaviorTool(f.store, run.id, binding, {
    callId,
    name: binding.tool.name,
    args: { bonus },
  });
}
function finish(f: Fixture, run: Run, text = 'Original synthetic fiction.') {
  return f.store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
function current(f: Fixture, branchId = f.branchId) {
  return behaviorDetail(f.store, f.chat.id, branchId).instances[0];
}
function frozenTables(f: Fixture) {
  return Object.fromEntries(
    [
      'package_behavior_states',
      'package_behavior_journal',
      'package_behavior_heads',
      'package_behavior_opportunities',
      'package_behavior_runs',
      'package_behavior_entropy',
    ].map((t) => [t, f.store.db.prepare(`SELECT * FROM ${t}`).all()])
  );
}
function dependentModule(f: Fixture, trigger: 'before-turn' | 'model') {
  const content = f.store.product.content({
    kind: 'module',
    title: 'Dependent package',
    description: 'Synthetic',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: {
      version: 1,
      id: 'dependent',
      revision: 1,
      title: 'Dependent package',
      description: '',
      lore: [],
      instructions: [],
      controls: [],
      transforms: [],
      behavior: {
        revision: 1,
        schemaVersion: 1,
        stateSchema: { type: 'record', properties: { copied: number } },
        initialState: { copied: 0 },
        actions: [
          {
            id: 'copy',
            inputSchema: { type: 'record', properties: {} },
            triggers: [trigger],
            effects: [{ path: ['copied'], value: { context: ['packages', '0', 'state', 'days'] } }],
            result: { context: ['nextState', 'copied'] },
          },
        ],
        outputParsers: [],
      },
    },
  }) as Content;
  const profile = f.store.product.profile(f.chat.id);
  f.store.product.updateProfile(f.chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    personaReference: profile.personaReference,
    routes: profile.routes,
    image: profile.image,
    prompts: profile.prompts,
    packageAttachments: [
      ...(profile.packageAttachments ?? []),
      { id: content.id, revision: 1, role: 'module' },
    ],
    packageValues: profile.packageValues,
  });
  return content;
}
function namedCall(f: Fixture, run: Run, actionId: string) {
  const binding = listBehaviorTools(run.snapshot).find((b) => b.actionId === actionId)!;
  return executeRunBehaviorTool(f.store, run.id, binding, {
    callId: randomUUID(),
    name: binding.tool.name,
    args: {},
  });
}

test('BRUN01 previews have no draws or writes; automatic actions are staged and frozen before the prompt', () => {
  const f = fixture(),
    before = frozenTables(f);
  for (let i = 0; i < 3; i++) {
    freezePackageStates(f.store, snapshot(f), false);
    behaviorDetail(f.store, f.chat.id);
  }
  expect(frozenTables(f)).toEqual(before);
  const run = admit(f),
    snapshotBefore = structuredClone(run.snapshot);
  expect(current(f).state).toEqual({ days: 0, score: 0, die: 0 });
  expect(run.snapshot.packageStates![0]).toMatchObject({ stateRevision: 1, state: { days: 1 } });
  expect(run.snapshot.behaviorExecution).toMatchObject({
    version: 1,
    baseStates: [{ stateRevision: 0 }],
    automaticResults: [{ actionId: 'day', result: 1 }],
  });
  expect(JSON.stringify(buildMainInput(run.snapshot))).toContain('DAY=1');
  expect(f.store.product.attempts(f.chat.id)).toEqual([]);
  start(f, run);
  finish(f, run);
  expect(current(f)).toMatchObject({
    stateRevision: 1,
    state: { days: 1, score: 0, die: 0 },
    status: 'ready',
  });
  expect(f.store.run(run.id).snapshot).toEqual(snapshotBefore);
  expect(
    f.store.db
      .prepare('SELECT result FROM package_behavior_journal')
      .all()
      .map((r: any) => JSON.parse(r.result).provenance)
  ).toEqual(['before-turn']);
});

test('BRUN02 one domain tool resolves effects and returns a compact result; repeated call IDs cannot reroll', () => {
  const f = fixture(),
    run = start(f),
    first = call(f, run);
  expect(first.denied).toBe(false);
  expect(first.result).toMatchObject({ score: expect.any(Number), die: expect.any(Number) });
  const second = call(f, run);
  expect(second.result).toEqual(first.result);
  expect(runBehaviorProgress(f.store, run.id)!.entries.map((e) => e.actionId)).toEqual([
    'day',
    'check',
  ]);
  expect(current(f).state).toEqual({ days: 0, score: 0, die: 0 });
  const changed = call(f, run, 2);
  expect(changed).toMatchObject({
    denied: true,
    result: { code: 'BEHAVIOR_OPPORTUNITY_INPUT_CHANGED' },
  });
  const source = finish(f, run),
    result = first.result as { die: number; score: number };
  expect(current(f)).toMatchObject({
    stateRevision: 2,
    state: { days: 1, ...result },
    status: 'ready',
  });
  expect(f.store.source(source.id).text).toBe('Original synthetic fiction.');
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 2 }
  );
});

test('BRUN03 cancellation leaves no applied state and a new request at the same source reuses the recorded opportunity', () => {
  const f = fixture(),
    first = start(f),
    result = call(f, first);
  f.store.finishRun(first.id, 'cancelled', 'Synthetic cancellation');
  expect(call(f, first)).toMatchObject({
    denied: true,
    result: { code: 'BEHAVIOR_RUN_NOT_RUNNING' },
  });
  expect(current(f).state).toEqual({ days: 0, score: 0, die: 0 });
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 0 }
  );
  const retry = start(f);
  expect(retry.snapshot.behaviorExecution!.opportunityId).toBe(
    first.snapshot.behaviorExecution!.opportunityId
  );
  expect(call(f, retry).result).toEqual(result.result);
  finish(f, retry);
  expect(current(f).stateRevision).toBe(2);
});

test('BRUN04 candidate uses the original dice and pre-automatic state without applying the automatic action twice', () => {
  const f = fixture(),
    original = start(f),
    result = call(f, original);
  finish(f, original);
  const candidate = f.store.candidate(original.id, randomUUID(), 'Alternative').run;
  expect(current(f, candidate.snapshot.branchId).stateRevision).toBe(0);
  expect(candidate.snapshot.packageStates![0].stateRevision).toBe(1);
  start(f, candidate);
  expect(call(f, candidate).result).toEqual(result.result);
  finish(f, candidate, 'Alternate fiction.');
  expect(current(f, candidate.snapshot.branchId)).toMatchObject({
    stateRevision: 2,
    state: { days: 1, ...(result.result as object) },
  });
  expect(current(f).stateRevision).toBe(2);
});

test('BRUN05 UI cannot invoke a model/automatic-only action even through the API', () => {
  const f = fixture();
  for (const [actionId, input] of [
    ['day', {}],
    ['check', { bonus: 1 }],
  ] as const)
    expect(() =>
      performBehaviorAction(f.store, f.chat.id, undefined, f.instanceId, {
        actionId,
        input,
        expectedStateRevision: 0,
        expectedSourceHash: null,
        idempotencyKey: randomUUID(),
      })
    ).toThrow('BEHAVIOR_USER_ACTION_NOT_ALLOWED');
  expect(current(f).stateRevision).toBe(0);
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 0 }
  );
});

test('BRUN06 failed output parsing rolls all staged effects back while preserving the completed original source', () => {
  const f = fixture((b) => {
      b.outputParsers = [
        {
          id: 'score',
          format: 'json',
          start: '<state>',
          end: '</state>',
          fields: [{ path: ['score'], from: ['score'] }],
        },
      ];
    }),
    run = start(f);
  call(f, run);
  const source = finish(f, run, 'Fiction with a broken state payload.');
  expect(f.store.run(run.id).status).toBe('completed');
  expect(f.store.source(source.id).text).toBe('Fiction with a broken state payload.');
  expect(current(f)).toMatchObject({
    stateRevision: 0,
    state: { days: 0, die: 0, score: 0 },
    status: 'stale',
  });
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 0 }
  );
  expect(() => admit(f)).toThrow();
});

test('BRUN07 source edits reject subsequent actions and fence stale completion without changing original prose', () => {
  const f = fixture(),
    prior = start(f),
    source = finish(f, prior);
  const run = start(f);
  f.store.editSource(source.id, { text: 'Author changed the source.', expectedRevision: 0 });
  expect(call(f, run)).toMatchObject({
    denied: true,
    result: { code: 'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED' },
  });
  const completed = finish(f, run, 'Original completion at the old basis.');
  expect(f.store.source(completed.id).text).toBe('Original completion at the old basis.');
  expect(current(f)).toMatchObject({ stateRevision: 1, state: { days: 1 }, status: 'stale' });
});

test('BRUN08 automatic when=false does not draw; dual-trigger action can be requested once later', () => {
  const f = fixture((b) => {
      b.actions[0].when = false;
      b.actions[1].triggers = ['before-turn', 'model'];
      b.actions[1].automaticInput = { bonus: 1 };
    }),
    run = start(f);
  const before = runBehaviorProgress(f.store, run.id)!;
  expect(before.entries.map((e) => e.actionId)).toEqual(['check']);
  const result = call(f, run);
  expect(result.result).toEqual(before.entries[0].result);
  expect(runBehaviorProgress(f.store, run.id)!.entries).toHaveLength(1);
  finish(f, run);
  expect(current(f)).toMatchObject({ stateRevision: 1, state: { days: 0 } });
});

test('BRUN09 state CAS rejects tool execution and rolls completion effects back', () => {
  const f = fixture((b) => {
      b.actions.push({
        id: 'user',
        inputSchema: { type: 'record', properties: {} },
        triggers: ['user'],
        effects: [{ path: ['score'], value: 99 }],
      });
    }),
    run = start(f);
  const scope = {
    chatId: f.chat.id,
    branchId: f.branchId,
    attachmentInstanceId: f.instanceId,
    packageId: f.content.id,
    packageRevision: 1,
    behaviorRevision: 1,
    schemaVersion: 1,
  };
  f.store.behavior.execute(scope, f.behavior, {
    actionId: 'user',
    input: {},
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'synthetic-race',
  });
  expect(call(f, run)).toMatchObject({ denied: true, result: { code: 'BEHAVIOR_STATE_STALE' } });
  finish(f, run);
  expect(current(f)).toMatchObject({
    stateRevision: 1,
    state: { days: 0, score: 99 },
    status: 'stale',
  });
});

test('BRUN10 cancelling a request before its first tool does not expose or commit hidden state', () => {
  const f = fixture(),
    run = start(f),
    controller = new AbortController();
  controller.abort();
  const binding = listBehaviorTools(run.snapshot)[0];
  expect(
    executeRunBehaviorTool(
      f.store,
      run.id,
      binding,
      { callId: 'late', name: binding.tool.name, args: { bonus: 1 } },
      controller.signal
    )
  ).toMatchObject({ denied: true, result: { code: 'BEHAVIOR_RUN_CANCELLED' } });
  expect(runBehaviorProgress(f.store, run.id)!.entries.map((e) => e.actionId)).toEqual(['day']);
  expect(current(f).stateRevision).toBe(0);
});

test('BRUN11 current-format archive and chat fork retain staged outcomes and independent successor state', () => {
  const f = fixture(),
    run = start(f),
    result = call(f, run),
    source = finish(f, run);
  const fork = forkChat(f.store, f.chat.id, {
      fromRevision: source.id,
      idempotencyKey: randomUUID(),
    }),
    forkedRun = f.store.run(f.store.source(fork.headRevision!).runId);
  expect(runBehaviorProgress(f.store, forkedRun.id)!.entries.map((e) => e.result)).toEqual(
    runBehaviorProgress(f.store, run.id)!.entries.map((e) => e.result)
  );
  expect(forkedRun.snapshot.behaviorExecution!.opportunityId).not.toBe(
    run.snapshot.behaviorExecution!.opportunityId
  );
  expect(behaviorDetail(f.store, fork.id).instances[0]).toMatchObject({
    stateRevision: 2,
    state: { days: 1, ...(result.result as object) },
  });
  const archive = f.store.product.export(),
    restored = database();
  expect(archive.version).toBe(11);
  expect(restored.product.import(archive)).toMatchObject({ restored: true, chats: 2 });
  expect(restored.run(run.id).snapshot).toEqual(f.store.run(run.id).snapshot);
  expect(runBehaviorProgress(restored, run.id)).toEqual(runBehaviorProgress(f.store, run.id));
});

test('BRUN12 authoritative parser failure rolls dependent actions back across all packages', () => {
  const f = fixture((b) => {
    b.outputParsers = [
      {
        id: 'days',
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['days'], from: ['days'] }],
      },
    ];
  });
  dependentModule(f, 'before-turn');
  const run = start(f);
  expect(run.snapshot.packageStates!.map((s) => s.state)).toEqual([
    { days: 1, score: 0, die: 0 },
    { copied: 1 },
  ]);
  const source = finish(f, run, 'Fiction without its required state.');
  const detail = behaviorDetail(f.store, f.chat.id);
  expect(detail.instances.map((i) => i.state)).toEqual([
    { days: 0, score: 0, die: 0 },
    { copied: 0 },
  ]);
  expect(detail.instances.every((i) => i.status === 'stale')).toBe(true);
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 0 }
  );
  expect(f.store.source(source.id).text).toBe('Fiction without its required state.');
});

test('BRUN13 annotation parse failure preserves the shared action facts and does not fence the authoritative successor', () => {
  const f = fixture((b) => {
    b.mode = 'annotation';
    b.outputParsers = [
      {
        id: 'days',
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['days'], from: ['days'] }],
      },
    ];
  });
  dependentModule(f, 'before-turn');
  const run = start(f);
  finish(f, run, 'Fiction with no optional overlay.');
  const detail = behaviorDetail(f.store, f.chat.id);
  expect(detail.instances.map((i) => i.state)).toEqual([
    { days: 1, score: 0, die: 0 },
    { copied: 1 },
  ]);
  expect(detail.instances.map((i) => i.status)).toEqual(['stale', 'ready']);
  expect(admit(f).snapshot.packageStates!.map((s) => s.state)).toEqual([
    { days: 2, score: 0, die: 0 },
    { copied: 2 },
  ]);
});

test('BRUN14 a cached result cannot be reused before its cross-package dependencies have been applied', () => {
  const f = fixture((b) => {
    b.actions[0].triggers = ['model'];
  });
  dependentModule(f, 'model');
  const original = start(f);
  expect(namedCall(f, original, 'day').denied).toBe(false);
  expect(namedCall(f, original, 'copy')).toMatchObject({ denied: false, result: 1 });
  finish(f, original);
  const candidate = f.store.candidate(original.id, randomUUID(), 'Changed order').run;
  start(f, candidate);
  expect(namedCall(f, candidate, 'copy')).toMatchObject({
    denied: true,
    result: { code: 'BEHAVIOR_OPPORTUNITY_DEPENDENCY_CHANGED' },
  });
  expect(runBehaviorProgress(f.store, candidate.id)!.entries).toHaveLength(0);
  expect(namedCall(f, candidate, 'day')).toMatchObject({ denied: false, result: 1 });
  expect(namedCall(f, candidate, 'copy')).toMatchObject({ denied: false, result: 1 });
  finish(f, candidate);
  expect(
    behaviorDetail(f.store, f.chat.id, candidate.snapshot.branchId).instances.map((i) => i.state)
  ).toEqual([{ days: 1, score: 0, die: 0 }, { copied: 1 }]);
});

test('BRUN15 result-only user functions expose the persisted result without requiring a state effect', () => {
  const f = fixture((b) => {
    b.actions = [
      {
        id: 'pure',
        triggers: ['user'],
        inputSchema: { type: 'record', properties: {} },
        draws: [{ id: 'die', type: 'integer', min: 1, max: 6 }],
        effects: [],
        result: { context: ['draws', 'die'] },
      },
    ];
  });
  const command = {
    actionId: 'pure',
    input: {},
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'pure-result',
  };
  const first = performBehaviorAction(f.store, f.chat.id, undefined, f.instanceId, command);
  expect(first.instances[0].lastAction).toMatchObject({
    actionId: 'pure',
    result: expect.any(Number),
    trigger: 'user',
    stateRevision: 1,
  });
  expect(first.instances[0].state).toEqual({ days: 0, score: 0, die: 0 });
  expect(
    performBehaviorAction(f.store, f.chat.id, undefined, f.instanceId, command).instances[0]
      .lastAction
  ).toEqual(first.instances[0].lastAction);
});

test('BRUN16 the published hybrid fixture executes all three invocation paths with one local engine', () => {
  const definition = validatePackageBehavior(
    JSON.parse(
      readFileSync(new URL('../fixtures/hybrid-actions-behavior.json', import.meta.url), 'utf8')
    )
  );
  const f = fixture((b) => Object.assign(b, definition));
  const detail = performBehaviorAction(f.store, f.chat.id, undefined, f.instanceId, {
    actionId: 'roll_die',
    input: {},
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'example-roll',
  });
  expect(detail.instances[0].lastAction!.result).toMatchObject({
    주사위: 'd6',
    결과: expect.any(Number),
  });
  const run = start(f);
  expect(run.snapshot.behaviorExecution!.automaticResults).toMatchObject([
    {
      actionId: 'prepare_scene',
      result: { 날씨: expect.any(String), '우연한 만남': expect.any(Boolean) },
    },
  ]);
  const binding = listBehaviorTools(run.snapshot)[0];
  const result = executeRunBehaviorTool(f.store, run.id, binding, {
    callId: 'example-persuasion',
    name: binding.tool.name,
    args: { target: 'gatekeeper' },
  });
  expect(result).toMatchObject({
    denied: false,
    result: { target: 'gatekeeper', roll: expect.any(Number), outcome: expect.any(String) },
  });
  finish(f, run);
  expect(current(f).state).toMatchObject({
    turn: 1,
    lastCheck: (result.result as { outcome: string }).outcome,
  });
});
