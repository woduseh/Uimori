import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Run } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import { productRoutes } from '../server/product-routes.js';
import { behaviorDetail, freezePackageStates } from '../server/package-behavior-host.js';
import { executionContext, packageInstanceId } from '../core/execution-context.js';
import { buildMainInput } from '../core/provider.js';
import type { Content, PromptPreset } from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import type { PackageBehavior } from '../core/package-behavior.js';
import { behaviorPayloadHash, type BehaviorScope } from '../server/package-behavior-store.js';
import type { RunSnapshot } from '../core/types.js';

const owned: { store: Store; app: FastifyInstance; dir: string }[] = [];
afterEach(async () => {
  for (const { store, app, dir } of owned.splice(0)) {
    await app.close();
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-behavior-integration-')
    )
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function definition(): PackageBehavior {
  return {
    revision: 1,
    schemaVersion: 1,
    mode: 'authoritative',
    stateSchema: {
      type: 'record',
      properties: { count: { type: 'number', min: 0, max: 100, integer: true } },
    },
    initialState: { count: 0 },
    actions: [
      {
        id: 'record',
        inputSchema: {
          type: 'record',
          properties: { value: { type: 'number', min: 0, max: 100, integer: true } },
        },
        draws: [{ id: 'die', type: 'integer', min: 1, max: 6 }],
        effects: [{ path: ['count'], value: { context: ['input', 'value'] } }],
      },
    ],
    outputParsers: [
      {
        id: 'count',
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['count'], from: ['count'], valueType: 'number' }],
      },
    ],
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-behavior-integration-')),
    store = new Store(join(dir, 'test.sqlite')),
    app = Fastify();
  owned.push({ store, app, dir });
  productRoutes(app, store, { approvedOrigins: [], publish: () => {} });
  const behavior = definition();
  const pkg: ContentPackage = {
    version: 1,
    id: 'fixture',
    revision: 1,
    title: 'Synthetic state',
    description: '',
    body: 'Synthetic only',
    lore: [],
    controls: [],
    transforms: [],
    behavior,
    instructions: [
      {
        id: 'state-guide',
        target: 'main',
        text: '',
        template: [
          { kind: 'text', text: 'FROZEN_COUNT=' },
          { kind: 'value', expression: { context: ['state', 'count'] } },
          { kind: 'text', text: ';FROZEN_DIE=' },
          { kind: 'value', expression: { context: ['draws', 'die'] } },
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
  const chat = createFixtureChat(store, 'Synthetic behavior', 'calm', { botId: content.id });
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
  });
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: prompt.title, program: prompt.program, values: prompt.values ?? {} },
  });
  const instanceId = packageInstanceId({ id: content.id, revision: content.revision, role: 'bot' });
  const scope: BehaviorScope = {
    chatId: chat.id,
    branchId: `main:${chat.id}`,
    attachmentInstanceId: instanceId,
    packageId: content.id,
    packageRevision: content.revision,
    behaviorRevision: 1,
    schemaVersion: 1,
  };
  const endpoint = `/api/chats/${chat.id}/package-behaviors`;
  return { store, app, behavior, content, chat, scope, instanceId, endpoint };
}
type Fixture = ReturnType<typeof fixture>;
function snapshot(f: Fixture, branchId = f.scope.branchId): RunSnapshot {
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
function run(f: Fixture, branchId = f.scope.branchId) {
  const s = snapshot(f, branchId);
  return f.store.createRun(
    f.chat.id,
    {
      request: s.request,
      expectedRevision: s.parentRevision,
      expectedSettingsRevision: s.settingsRevision,
      branchId,
      idempotencyKey: randomUUID(),
    },
    () => s
  ).run;
}
function complete(f: Fixture, r: Run, text = 'Original prose.\n<state>{"count":7}</state>') {
  expect(f.store.startRun(r.id)).toBe(true);
  return f.store.completeRun(
    r.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    r.snapshot.settings
  );
}
function expectRunBlocked(f: Fixture) {
  try {
    run(f);
    throw Error('Expected authoritative successor to reject');
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 409 });
  }
}
async function action(f: Fixture, value: number, branchId = f.scope.branchId) {
  const detail = behaviorDetail(f.store, f.chat.id, branchId),
    state = detail.instances[0];
  return injectWithFixtureBot(f.app, {
    method: 'POST',
    url: `${f.endpoint}/${f.instanceId}/actions`,
    payload: {
      branchId,
      actionId: 'record',
      input: { value },
      expectedStateRevision: state.stateRevision,
      expectedSourceHash: detail.sourceHash,
      idempotencyKey: randomUUID(),
    },
  });
}
function tables(f: Fixture) {
  return Object.fromEntries(
    [
      'package_behavior_states',
      'package_behavior_journal',
      'package_behavior_heads',
      'package_behavior_outputs',
    ].map((table) => [table, f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
  );
}

test('BINT01 GET and preview do not initialize, draw, journal or alter source-bound state', async () => {
  const f = fixture(),
    before = tables(f),
    base = snapshot(f),
    original = structuredClone(base);
  for (let i = 0; i < 3; i++) {
    const response = await injectWithFixtureBot(f.app, { method: 'GET', url: f.endpoint });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().instances[0]).toMatchObject({
      stateRevision: 0,
      state: { count: 0 },
      status: 'ready',
    });
  }
  const preview = f.store.behavior.preview(f.scope, f.behavior, {
    actionId: 'record',
    input: { value: 5 },
  });
  expect(preview.requiresDraw).toBe(true);
  expect(preview).not.toHaveProperty('projectedState');
  expect(freezePackageStates(f.store, base, false).packageStates?.[0]).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
    draws: {},
  });
  expect(base).toEqual(original);
  expect(tables(f)).toEqual(before);
  expect(f.store.product.attempts(f.chat.id)).toEqual([]);
});

test('compatible latest content preserves state and dice; incompatible behavior requires explicit reset and roundtrips', async () => {
  const f = fixture();
  expect((await action(f, 3)).statusCode).toBe(200);
  const originalRun = run(f);
  const source = complete(f, originalRun);
  const frozen = structuredClone(f.store.run(originalRun.id).snapshot);
  const prior = freezePackageStates(f.store, snapshot(f), false).packageStates![0];
  const update = (content: Content, pkg: ContentPackage) =>
    f.store.product.content(
      {
        kind: content.kind,
        title: content.title,
        description: content.description,
        text: pkg.body,
        loading: content.loading,
        relatedIds: content.relatedIds,
        package: pkg,
        expectedRevision: content.revision,
      },
      content.id
    ) as Content;
  const latest = update(f.content, { ...f.content.package!, body: 'Updated prose only' });
  const beforeReads = tables(f);
  const detail = behaviorDetail(f.store, f.chat.id);
  expect(detail.instances[0]).toMatchObject({
    packageRevision: latest.revision,
    state: prior.state,
    stateRevision: prior.stateRevision,
    status: 'ready',
  });
  const preview = freezePackageStates(f.store, snapshot(f), false).packageStates![0];
  expect(preview).toMatchObject({
    packageRevision: latest.revision,
    state: prior.state,
    draws: prior.draws,
  });
  expect(tables(f)).toEqual(beforeReads);
  const next = run(f);
  expect(next.snapshot.packageStates![0]).toMatchObject({
    packageRevision: latest.revision,
    state: prior.state,
    draws: prior.draws,
  });
  complete(f, next);
  expect(f.store.run(originalRun.id).snapshot).toEqual(frozen);
  const fork = forkChat(f.store, f.chat.id, {
    fromRevision: source.id,
    idempotencyKey: randomUUID(),
  });
  expect(behaviorDetail(f.store, fork.id).instances[0]).toMatchObject({
    status: 'ready',
    state: prior.state,
  });
  const newerBehavior: PackageBehavior = {
    revision: 2,
    schemaVersion: 2,
    mode: 'authoritative',
    stateSchema: { type: 'record', properties: { label: { type: 'string', maxLength: 40 } } },
    initialState: { label: 'reset explicitly' },
    actions: [],
    outputParsers: [],
  };
  update(latest, { ...latest.package!, behavior: newerBehavior, instructions: [] });
  const stale = behaviorDetail(f.store, f.chat.id);
  expect(stale.instances[0]).toMatchObject({
    status: 'stale',
    error: 'BEHAVIOR_MIGRATION_REQUIRED',
    state: { count: 7 },
  });
  expectRunBlocked(f);
  const beforeReset = tables(f);
  expect(behaviorDetail(f.store, f.chat.id)).toEqual(stale);
  expect(tables(f)).toEqual(beforeReset);
  const rejected = await injectWithFixtureBot(f.app, {
    method: 'POST',
    url: `${f.endpoint}/${f.instanceId}/reset`,
    payload: {
      expectedStateRevision: stale.instances[0].stateRevision - 1,
      expectedSourceHash: stale.sourceHash,
      idempotencyKey: randomUUID(),
    },
  });
  expect(rejected.statusCode).toBe(409);
  expect(tables(f)).toEqual(beforeReset);
  const reset = await injectWithFixtureBot(f.app, {
    method: 'POST',
    url: `${f.endpoint}/${f.instanceId}/reset`,
    payload: {
      expectedStateRevision: stale.instances[0].stateRevision,
      expectedSourceHash: stale.sourceHash,
      idempotencyKey: randomUUID(),
    },
  });
  expect(reset.statusCode, reset.body).toBe(200);
  expect(reset.json().instances[0]).toMatchObject({
    status: 'ready',
    state: newerBehavior.initialState,
  });
  expect(f.store.run(originalRun.id).snapshot).toEqual(frozen);
  const archive = f.store.product.export();
  // The empty target is separate from the fixture database holding the tested story.
  const emptyDir = mkdtempSync(join(tmpdir(), 'uimori-behavior-integration-'));
  const target = new Store(join(emptyDir, 'restored.sqlite'));
  owned.push({ store: target, app: Fastify(), dir: emptyDir });
  const forged = structuredClone(archive);
  const receipt = forged.tables.package_behavior_journal.find(
    (row) => JSON.parse(String(row.payload)).provenance === 'explicit-reset'
  )!;
  const payload = JSON.parse(String(receipt.payload));
  payload.previousScope = payload.scope;
  receipt.payload = JSON.stringify(payload);
  receipt.payload_hash = behaviorPayloadHash(payload);
  expect(() => target.product.import(forged)).toThrow();
  expect(target.chats()).toHaveLength(0);
  expect(target.product.import(archive)).toMatchObject({ restored: true, chats: 2 });
  expect(behaviorDetail(target, f.chat.id)).toEqual(behaviorDetail(f.store, f.chat.id));
  expect(target.run(originalRun.id).snapshot).toEqual(frozen);
});

test('BINT02 user action freezes state and recorded draw into Run and composed provider input', async () => {
  const f = fixture();
  const applied = await action(f, 3);
  expect(applied.statusCode, applied.body).toBe(200);
  const journal = f.store.behavior.journal(f.scope);
  expect(journal).toHaveLength(1);
  expect(journal[0].drawSeed).toMatch(/^[a-f0-9]{64}$/u);
  const r = run(f),
    before = structuredClone(r.snapshot),
    frozen = r.snapshot.packageStates![0];
  expect(frozen.state).toEqual({ count: 3 });
  expect(frozen.draws).toEqual(journal[0].draws);
  expect(
    executionContext(r.snapshot, 'main', { id: f.content.id, revision: 1, role: 'bot' })
  ).toMatchObject({ state: { count: 3 }, draws: journal[0].draws });
  const expected = `FROZEN_COUNT=3;FROZEN_DIE=${journal[0].draws.die}`;
  expect(JSON.stringify(buildMainInput(r.snapshot))).toContain(expected);
  expect(JSON.stringify(r.snapshot.promptCompilation)).toContain(expected);
  const blocked = await action(f, 8);
  expect(blocked.statusCode).toBe(409);
  expect(behaviorDetail(f.store, f.chat.id).instances[0].status).toBe('pending');
  const source = complete(f, r);
  expect(f.store.source(source.id).text).toBe('Original prose.\n<state>{"count":7}</state>');
  expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 2,
    state: { count: 7 },
    status: 'ready',
  });
  expect((await action(f, 99)).statusCode).toBe(200);
  expect(f.store.run(r.id).snapshot).toEqual(before);
  const output = f.store.db
    .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=?')
    .get(source.id) as { body: string };
  expect(JSON.parse(output.body)).toMatchObject({
    before: { state: { count: 3 } },
    after: { state: { count: 7 } },
    sourceHash: source.hash,
    status: 'ready',
  });
});

test('BINT03 malformed output and lost state CAS preserve source and fence the next authoritative run', async () => {
  for (const scenario of ['malformed', 'cas'] as const) {
    const f = fixture();
    expect((await action(f, 3)).statusCode).toBe(200);
    const r = run(f);
    if (scenario === 'cas')
      f.store.behavior.execute(f.scope, f.behavior, {
        actionId: 'record',
        input: { value: 4 },
        expectedStateRevision: 1,
        expectedSourceHash: null,
        idempotencyKey: randomUUID(),
      });
    const text =
      scenario === 'malformed'
        ? 'Exact original despite parser failure.'
        : 'Exact original despite CAS. <state>{"count":9}</state>';
    const source = complete(f, r, text);
    expect(f.store.run(r.id).status).toBe('completed');
    expect(f.store.sourceOriginal(source.id).text).toBe(text);
    const detail = behaviorDetail(f.store, f.chat.id);
    expect(detail.instances[0]).toMatchObject({
      state: { count: scenario === 'cas' ? 4 : 3 },
      status: 'stale',
    });
    const output = f.store.db
      .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=?')
      .get(source.id) as { body: string };
    expect(JSON.parse(output.body)).toMatchObject({ status: 'failed', sourceHash: source.hash });
    expectRunBlocked(f);
    const actionBlocked = await action(f, 8);
    expect(actionBlocked.statusCode).toBe(409);
    expect(f.store.source(source.id).hash).toBe(source.hash);
    expect(f.store.product.attempts(f.chat.id)).toEqual([]);
  }
});

test('BINT04 source edits stale derived state; reset requires current hash and retains the journal', async () => {
  const f = fixture(),
    r = run(f),
    source = complete(f, r);
  const old = behaviorDetail(f.store, f.chat.id),
    edited = f.store.editSource(source.id, { text: 'Author edited prose.', expectedRevision: 0 });
  expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
    status: 'stale',
    state: { count: 7 },
  });
  expectRunBlocked(f);
  const payload = {
    expectedStateRevision: old.instances[0].stateRevision,
    expectedSourceHash: source.hash,
    idempotencyKey: randomUUID(),
  };
  const rejected = await injectWithFixtureBot(f.app, {
    method: 'POST',
    url: `${f.endpoint}/${f.instanceId}/reset`,
    payload,
  });
  expect(rejected.statusCode).toBe(409);
  const reset = await injectWithFixtureBot(f.app, {
    method: 'POST',
    url: `${f.endpoint}/${f.instanceId}/reset`,
    payload: { ...payload, expectedSourceHash: edited.hash, idempotencyKey: randomUUID() },
  });
  expect(reset.statusCode, reset.body).toBe(200);
  expect(reset.json().instances[0]).toMatchObject({
    status: 'ready',
    state: { count: 0 },
    stateRevision: old.instances[0].stateRevision + 1,
  });
  expect(f.store.behavior.journal(f.scope).map((j) => j.provenance)).toEqual([
    'local-output-parser',
    'explicit-reset',
  ]);
  expect(f.store.sourceOriginal(source.id).text).toBe(source.text);
  expect(f.store.source(source.id).text).toBe(edited.text);
  expect(run(f).snapshot.packageStates![0].state).toEqual({ count: 0 });
});

test('BINT09 replaying an earlier reset cannot acknowledge a later source edit or write metadata again', async () => {
  const f = fixture(),
    source = complete(f, run(f));
  const first = f.store.editSource(source.id, { text: 'First author edit.', expectedRevision: 0 }),
    detail = behaviorDetail(f.store, f.chat.id);
  const payload = {
    expectedStateRevision: detail.instances[0].stateRevision,
    expectedSourceHash: first.hash,
    idempotencyKey: 'fixed-reset',
  };
  const endpoint = `${f.endpoint}/${f.instanceId}/reset`;
  expect(
    (await injectWithFixtureBot(f.app, { method: 'POST', url: endpoint, payload })).statusCode
  ).toBe(200);
  f.store.editSource(source.id, { text: 'Second author edit.', expectedRevision: 1 });
  const before = tables(f),
    eventCount = f.store.events(f.chat.id, 0).length;
  const replay = await injectWithFixtureBot(f.app, { method: 'POST', url: endpoint, payload });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().instances[0].status).toBe('stale');
  expect(tables(f)).toEqual(before);
  expect(f.store.events(f.chat.id, 0)).toHaveLength(eventCount);
  expectRunBlocked(f);
});

test('BINT05 source branching restores post-source state and candidates restore original pre-source state', async () => {
  const f = fixture();
  expect((await action(f, 3)).statusCode).toBe(200);
  const original = run(f),
    source = complete(f, original);
  expect((await action(f, 99)).statusCode).toBe(200);
  const branch = f.store.product.createBranch(f.chat.id, {
    title: 'Synthetic branch',
    fromRevision: source.id,
  });
  expect(behaviorDetail(f.store, f.chat.id, branch.id).instances[0].state).toEqual({ count: 7 });
  expect(
    freezePackageStates(f.store, snapshot(f, branch.id), false).packageStates![0].draws
  ).toEqual(original.snapshot.packageStates![0].draws);
  expect((await action(f, 8, branch.id)).statusCode).toBe(200);
  expect(behaviorDetail(f.store, f.chat.id).instances[0].state).toEqual({ count: 99 });
  const candidate = f.store.candidate(original.id, randomUUID(), 'Synthetic candidate').run;
  expect(candidate.snapshot.packageStates).toEqual(original.snapshot.packageStates);
  expect(candidate.snapshot.promptCompilation).toEqual(original.snapshot.promptCompilation);
  expect(
    behaviorDetail(f.store, f.chat.id, candidate.snapshot.branchId).instances[0]
  ).toMatchObject({ state: { count: 3 }, status: 'pending' });
  complete(f, candidate, 'Candidate prose. <state>{"count":12}</state>');
  expect(
    behaviorDetail(f.store, f.chat.id, candidate.snapshot.branchId).instances[0].state
  ).toEqual({ count: 12 });
  expect(behaviorDetail(f.store, f.chat.id).instances[0].state).toEqual({ count: 99 });
  expect(f.store.sourceOriginal(source.id).text).toBe(source.text);
});

test('BINT06 branching after an ancestor edit cannot mark old derived state fresh or replay an old candidate', () => {
  const f = fixture(),
    firstRun = run(f),
    first = complete(f, firstRun),
    secondRun = run(f),
    second = complete(f, secondRun, 'Second original. <state>{"count":9}</state>');
  const secondFrozen = structuredClone(secondRun.snapshot);
  f.store.editSource(first.id, {
    text: 'Changed ancestor, retained original version.',
    expectedRevision: 0,
  });
  for (const source of [first, second]) {
    const branch = f.store.product.createBranch(f.chat.id, {
      title: 'Branch with changed dependency',
      fromRevision: source.id,
    });
    expect(behaviorDetail(f.store, f.chat.id, branch.id).instances[0].status).toBe('stale');
    try {
      run(f, branch.id);
      throw Error('Expected stale branch to reject');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409 });
    }
  }
  const branchCount = f.store.product.branches(f.chat.id).length;
  try {
    f.store.candidate(secondRun.id, randomUUID(), 'Candidate with changed dependency');
    throw Error('Expected stale candidate to reject');
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 409 });
  }
  expect(f.store.product.branches(f.chat.id)).toHaveLength(branchCount);
  expect(f.store.run(secondRun.id).snapshot).toEqual(secondFrozen);
  expect(f.store.sourceOriginal(first.id).text).toBe(first.text);
  expect(f.store.sourceOriginal(second.id).text).toBe(second.text);
});

test('BINT07 an ancestor edit during a run preserves completed prose but fails package output and blocks its successor', () => {
  const f = fixture(),
    first = complete(f, run(f)),
    pending = run(f),
    frozen = structuredClone(pending.snapshot);
  expect(f.store.startRun(pending.id)).toBe(true);
  f.store.editSource(first.id, {
    text: 'Ancestor changed while the model was running.',
    expectedRevision: 0,
  });
  const text = 'Completed exact original. <state>{"count":42}</state>';
  const completed = f.store.completeRun(
    pending.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    pending.snapshot.settings
  );
  expect(f.store.run(pending.id)).toMatchObject({ status: 'completed', snapshot: frozen });
  expect(f.store.sourceOriginal(completed.id).text).toBe(text);
  expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
    status: 'stale',
    state: { count: 7 },
    error: 'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED',
  });
  const row = f.store.db
    .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=?')
    .get(completed.id) as { body: string };
  expect(JSON.parse(row.body)).toMatchObject({
    status: 'failed',
    sourceHash: completed.hash,
    error: 'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED',
    after: { state: { count: 7 } },
  });
  expectRunBlocked(f);
  expect(f.store.sourceOriginal(first.id).text).toBe(first.text);
});

test('BINT08 a selected-source chat fork preserves frozen state, draws and outputs, acts independently and roundtrips', async () => {
  const f = fixture();
  expect((await action(f, 3)).statusCode).toBe(200);
  complete(f, run(f));
  const originalRun = run(f),
    source = complete(f, originalRun, 'Selected source. <state>{"count":9}</state>');
  expect((await action(f, 99)).statusCode).toBe(200);
  const fork = forkChat(f.store, f.chat.id, {
    fromRevision: source.id,
    title: 'Synthetic selected fork',
    idempotencyKey: randomUUID(),
  });
  const copied = f.store.source(fork.headRevision!),
    copiedRun = f.store.run(copied.runId),
    copiedDetail = behaviorDetail(f.store, fork.id);
  expect(copied.text).toBe(source.text);
  expect(copiedRun.snapshot.packageStates).toEqual(originalRun.snapshot.packageStates);
  expect(copiedDetail.instances[0]).toMatchObject({ status: 'ready', state: { count: 9 } });
  const forkSnapshot = {
    ...snapshot(f),
    chatId: fork.id,
    branchId: `main:${fork.id}`,
    parentRevision: copied.id,
    history: f.store.history(copied.id),
    profile: f.store.product.snapshot(fork.id),
  };
  expect(freezePackageStates(f.store, forkSnapshot, false).packageStates![0].draws).toEqual(
    originalRun.snapshot.packageStates![0].draws
  );
  const originalOutput = f.store.db
    .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=?')
    .get(source.id) as { body: string };
  const copiedOutput = f.store.db
    .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=?')
    .get(copied.id) as { body: string };
  expect(JSON.parse(copiedOutput.body)).toEqual(JSON.parse(originalOutput.body));
  const changed = await injectWithFixtureBot(f.app, {
    method: 'POST',
    url: `/api/chats/${fork.id}/package-behaviors/${f.instanceId}/actions`,
    payload: {
      actionId: 'record',
      input: { value: 11 },
      expectedStateRevision: copiedDetail.instances[0].stateRevision,
      expectedSourceHash: copied.hash,
      idempotencyKey: randomUUID(),
    },
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(changed.json().instances[0].state).toEqual({ count: 11 });
  expect(behaviorDetail(f.store, f.chat.id).instances[0].state).toEqual({ count: 99 });
  const archive = f.store.product.export(),
    dir = mkdtempSync(join(tmpdir(), 'uimori-behavior-integration-')),
    restored = new Store(join(dir, 'restored.sqlite')),
    app = Fastify();
  owned.push({ store: restored, app, dir });
  expect(restored.product.import(archive)).toEqual({ restored: true, chats: 2 });
  expect(behaviorDetail(restored, fork.id)).toEqual(behaviorDetail(f.store, fork.id));
  expect(restored.run(copiedRun.id).snapshot).toEqual(copiedRun.snapshot);
  expect(
    restored.db
      .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=?')
      .get(copied.id)
  ).toEqual(copiedOutput);
  const restoredSnapshot = { ...forkSnapshot, profile: restored.product.snapshot(fork.id) };
  expect(freezePackageStates(restored, restoredSnapshot, false).packageStates).toEqual(
    freezePackageStates(f.store, forkSnapshot, false).packageStates
  );
});
