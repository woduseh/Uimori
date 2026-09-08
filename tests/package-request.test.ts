import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Store, type Run } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import { deleteBranch, deleteChat, chatDeletionImpact } from '../server/chat-deletion.js';
import { behaviorDetail, performBehaviorAction } from '../server/package-behavior-host.js';
import {
  cancelPackageRequest,
  pendingPackageRequest,
  validatePackageRequests,
} from '../server/package-requests.js';
import { packageInstanceId } from '../core/execution-context.js';
import { validatePackageBehavior } from '../core/package-behavior.js';
import { buildMainInput } from '../core/provider.js';
import type { Content } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { createActionPackage } from './fixtures/action-package.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const child = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(child) || child.startsWith('..') || !child.startsWith('uimori-package-request-'))
      throw Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-package-request-')),
    store = new Store(join(directory, 'fixture.sqlite'));
  owned.push({ store, directory });
  return store;
}
function fixture(customize?: (pkg: ReturnType<typeof createActionPackage>) => void) {
  const store = database(),
    pkg = createActionPackage();
  customize?.(pkg);
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic package requests', 'calm', {
    botId: content.id,
  });
  store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
  });
  return {
    store,
    chatId: chat.id,
    branchId: `main:${chat.id}`,
    content,
    instanceId: packageInstanceId({ id: content.id, revision: content.revision, role: 'bot' }),
  };
}
type Fixture = ReturnType<typeof fixture>;
function action(
  f: Fixture,
  actionId = 'propose',
  input: unknown = { request: 'Explore the bridge, then wait for the user.' },
  key: string = randomUUID(),
  overrides: Record<string, unknown> = {}
) {
  const detail = behaviorDetail(f.store, f.chatId, f.branchId),
    instance = detail.instances[0];
  return performBehaviorAction(f.store, f.chatId, f.branchId, f.instanceId, {
    actionId,
    input,
    expectedStateRevision: instance.stateRevision,
    expectedSourceHash: detail.sourceHash,
    idempotencyKey: key,
    ...overrides,
  });
}
function run(
  f: Fixture,
  request = 'A synthetic request',
  packageRequestId?: string,
  key: string = randomUUID()
) {
  const chat = f.store.chat(f.chatId),
    branch = f.store.product.branch(f.chatId, f.branchId),
    profile = f.store.product.snapshot(f.chatId)!;
  const snapshot: RunSnapshot = {
    chatId: f.chatId,
    branchId: f.branchId,
    parentRevision: branch.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request,
    profile,
    resources: f.store.product.resources(f.chatId, profile),
    history: f.store.history(branch.headRevision),
  };
  return f.store.createRun(
    f.chatId,
    {
      branchId: f.branchId,
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: profile.revision,
      idempotencyKey: key,
      ...(packageRequestId ? { packageRequestId } : {}),
    },
    () => snapshot
  );
}
function complete(f: Fixture, work: Run, text = 'Ari marks the path on a map.') {
  expect(f.store.startRun(work.id)).toBe(true);
  return f.store.completeRun(
    work.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    work.snapshot.settings
  );
}
function rows(f: Fixture, table: string) {
  return f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}
function setOptions(f: Fixture, responseSize: 'brief' | 'detailed') {
  const profile = f.store.product.profile(f.chatId),
    scope = `${f.content.id}@${f.content.revision}:bot`;
  return updateTestProfile(f.store.product, f.chatId, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    routes: profile.routes,
    image: profile.image,
    packageAttachments: profile.packageAttachments,
    packageValues: { [scope]: { responseLanguage: 'fr', responseSize } },
  });
}

test('PREQUEST01 common data supports arbitrary state axes, language choices, lore, starts and images without a specialized bot model', () => {
  const pkg = createActionPackage('a'.repeat(64));
  expect(pkg.behavior!.initialState).toEqual({ energy: 25, progress: 0, ready: true, plan: '' });
  expect(pkg.stateView!.fields).toHaveLength(4);
  expect(
    pkg.controls[0].type === 'select' && pkg.controls[0].options!.map((option) => option.value)
  ).toContain('fr');
  expect(pkg.starts!.map((start) => start.mode)).toEqual(['authored', 'generate']);
  expect(pkg.images![0].blobHash).toBe('a'.repeat(64));
  expect(pkg.lore[0].relatedIds).toEqual(['bridge']);
  const f = fixture(),
    before = rows(f, 'package_behavior_journal');
  behaviorDetail(f.store, f.chatId);
  behaviorDetail(f.store, f.chatId);
  expect(rows(f, 'package_behavior_journal')).toEqual(before);
  expect(rows(f, 'package_requests')).toEqual([]);
  expect(action(f, 'set-energy', { value: 150 }).instances[0].state).toMatchObject({ energy: 120 });
  expect(action(f, 'set-energy', { value: 30.5 }).instances[0].state).toMatchObject({
    energy: 30.5,
  });
  action(f, 'set-energy', { value: 0 });
  expect(() => action(f)).toThrow('BEHAVIOR_ACTION_DISABLED');
  expect(rows(f, 'package_requests')).toEqual([]);
});

test('PREQUEST02 proposal actions preserve source/state CAS, idempotency and the original draw with no model call', () => {
  const f = fixture(),
    key = 'original-action',
    input = { request: 'Wait near the bridge.' };
  const first = action(f, 'propose', input, key),
    pending = first.pendingRequest!;
  const receipt = rows(f, 'package_behavior_journal');
  expect(pending.request).toBe(input.request);
  expect(receipt).toHaveLength(1);
  const retry = action(f, 'propose', input, key, { expectedStateRevision: 0 });
  expect(retry.pendingRequest).toEqual(pending);
  expect(rows(f, 'package_behavior_journal')).toEqual(receipt);
  expect(() =>
    action(f, 'propose', { request: 'Changed request' }, key, { expectedStateRevision: 0 })
  ).toThrow('BEHAVIOR_IDEMPOTENCY_CONFLICT');
  expect(() => action(f, 'propose', input, randomUUID(), { expectedStateRevision: 0 })).toThrow(
    'BEHAVIOR_STATE_STALE'
  );
  expect(() =>
    action(f, 'propose', input, randomUUID(), { expectedSourceHash: 'f'.repeat(64) })
  ).toThrow('BEHAVIOR_SOURCE_STALE');
  expect(f.store.detail(f.chatId).runs).toHaveLength(0);
  expect(f.store.product.attempts(f.chatId)).toHaveLength(0);
  expect(rows(f, 'package_requests')).toHaveLength(1);
});

test('PREQUEST03 a user action request is consumed by exactly one accepted Run and an action retry cannot requeue it', () => {
  const f = fixture(),
    input = { request: 'Propose a quiet expedition.' },
    actionKey = 'propose-once';
  const pending = action(f, 'propose', input, actionKey).pendingRequest!,
    key = 'run-once';
  const first = run(f, pending.request, pending.id, key);
  expect(first.created).toBe(true);
  expect(pendingPackageRequest(f.store, f.chatId)).toBeNull();
  expect(run(f, pending.request, pending.id, key)).toMatchObject({
    created: false,
    run: { id: first.run.id },
  });
  f.store.finishRun(first.run.id, 'cancelled', 'synthetic cancellation');
  expect(() => run(f, pending.request, pending.id)).toThrow('PACKAGE_REQUEST_STALE');
  expect(
    action(f, 'propose', input, actionKey, { expectedStateRevision: 0 }).pendingRequest
  ).toBeNull();
  expect(rows(f, 'package_behavior_journal')).toHaveLength(1);
  expect(rows(f, 'package_requests')[0]).toMatchObject({
    status: 'consumed',
    consumed_run_id: first.run.id,
  });
  validatePackageRequests(f.store);
});

test('PREQUEST04 invalid request output and failed Run admission roll back both state and reservation atomically', () => {
  const invalid = fixture((pkg) => {
    pkg.behavior!.actions[1].nextRequest = 42;
  });
  expect(() => action(invalid)).toThrow('PACKAGE_REQUEST_TEXT_INVALID');
  expect(rows(invalid, 'package_requests')).toEqual([]);
  expect(rows(invalid, 'package_behavior_journal')).toEqual([]);
  expect(behaviorDetail(invalid.store, invalid.chatId).instances[0].stateRevision).toBe(0);
  const f = fixture(),
    pending = action(f).pendingRequest!,
    before = rows(f, 'runs');
  expect(() => run(f, 'Different user request', pending.id)).toThrow(
    'PACKAGE_REQUEST_TEXT_MISMATCH'
  );
  expect(rows(f, 'runs')).toEqual(before);
  expect(pendingPackageRequest(f.store, f.chatId)).toEqual(pending);
  expect(rows(f, 'package_requests')[0]).toMatchObject({
    status: 'pending',
    consumed_run_id: null,
  });
  const definition = createActionPackage().behavior!;
  definition.actions[1].triggers = ['user', 'model'];
  expect(() => validatePackageBehavior(definition)).toThrow(
    'BEHAVIOR_REQUEST_REQUIRES_USER_ACTION'
  );
});

test('PREQUEST05 source and ancestor edits invalidate proposals without rewriting captured Run or source originals', () => {
  for (const ancestor of [false, true]) {
    const f = fixture(),
      firstRun = run(f).run,
      first = complete(f, firstRun, 'First original scene.'),
      frozen = structuredClone(firstRun.snapshot);
    const second = complete(f, run(f).run, 'Second original scene.'),
      pending = action(f).pendingRequest!,
      selected = ancestor ? first : second;
    f.store.editSource(selected.id, { text: 'The source was edited.', expectedRevision: 0 });
    expect(pendingPackageRequest(f.store, f.chatId)).toBeNull();
    expect(() => run(f, pending.request, pending.id)).toThrow();
    expect(f.store.sourceOriginal(selected.id).text).toBe(
      ancestor ? 'First original scene.' : 'Second original scene.'
    );
    expect(f.store.run(firstRun.id).snapshot).toEqual(frozen);
    expect(rows(f, 'package_requests')[0]).toMatchObject({ status: 'pending' });
    validatePackageRequests(f.store);
  }
});

test('PREQUEST06 language and response size are package preferences and never overwrite state rules', () => {
  const f = fixture();
  action(f, 'set-energy', { value: 60 });
  const first = run(f).run;
  complete(f, first);
  const before = behaviorDetail(f.store, f.chatId).instances[0],
    pending = action(f).pendingRequest!;
  setOptions(f, 'detailed');
  expect(pendingPackageRequest(f.store, f.chatId)).toBeNull();
  expect(() => run(f, pending.request, pending.id)).toThrow('PACKAGE_REQUEST_STALE');
  const after = behaviorDetail(f.store, f.chatId).instances[0];
  expect(after.behavior).toEqual(before.behavior);
  expect(after.state).toMatchObject({ energy: 60 });
  const next = run(f).run,
    text = JSON.stringify(buildMainInput(next.snapshot));
  expect(text).toContain('RESPONSE_LANGUAGE=fr;RESPONSE_SIZE=detailed;ENERGY=60');
  expect(first.snapshot.profile!.packageValues).toBeUndefined();
});

test('PREQUEST07 replacement, cancellation and chat scopes cannot replay or steal a pending request', () => {
  const f = fixture(),
    first = action(f).pendingRequest!,
    second = action(f, 'propose', { request: 'A replacement proposal.' }).pendingRequest!;
  expect(first.id).not.toBe(second.id);
  expect(() => run(f, first.request, first.id)).toThrow('PACKAGE_REQUEST_STALE');
  expect(cancelPackageRequest(f.store, f.chatId, f.branchId, first.id)).toEqual({
    cancelled: true,
  });
  expect(pendingPackageRequest(f.store, f.chatId)).toEqual(second);
  const other = fixture();
  expect(() => run(other, second.request, second.id)).toThrow('PACKAGE_REQUEST_STALE');
  cancelPackageRequest(f.store, f.chatId, f.branchId, second.id);
  cancelPackageRequest(f.store, f.chatId, f.branchId, second.id);
  expect(pendingPackageRequest(f.store, f.chatId)).toBeNull();
  expect(() => run(f, second.request, second.id)).toThrow('PACKAGE_REQUEST_STALE');
});

test('PREQUEST08 archive/fork preserve common state and frozen inputs while pending proposals stay in their original chat', () => {
  const f = fixture();
  action(f, 'set-energy', { value: 55 });
  const first = run(f).run,
    source = complete(f, first),
    frozen = structuredClone(first.snapshot);
  const pending = action(f).pendingRequest!,
    archive = f.store.product.export(),
    restored = database();
  expect(restored.product.import(archive)).toEqual({ restored: true, chats: 1 });
  expect(pendingPackageRequest(restored, f.chatId)).toEqual(pending);
  expect(restored.run(first.id).snapshot).toEqual(frozen);
  const fork = forkChat(restored, f.chatId, {
      fromRevision: source.id,
      title: 'Common package copy',
      idempotencyKey: 'fork',
    }),
    forked = restored.run(restored.source(fork.headRevision!).runId);
  expect(pendingPackageRequest(restored, fork.id)).toBeNull();
  expect(pendingPackageRequest(restored, f.chatId)).toEqual(pending);
  expect(behaviorDetail(restored, fork.id).instances[0].state).toMatchObject({ energy: 55 });
  expect(forked.snapshot.packageStates).toEqual(first.snapshot.packageStates);
  expect(restored.run(first.id).snapshot).toEqual(frozen);
  const roundtrip = database();
  expect(roundtrip.product.import(restored.product.export())).toEqual({ restored: true, chats: 2 });
  for (const field of ['request', 'profileRevision', 'actionKey'] as const) {
    const altered = structuredClone(archive);
    const row = altered.tables.package_requests[0];
    const body = JSON.parse(row.body as string);
    body[field] = field === 'profileRevision' ? 999 : 'forged';
    row.body = JSON.stringify(body);
    const target = database();
    expect(() => target.product.import(altered)).toThrow();
    expect(target.chats()).toHaveLength(0);
  }
});

test.each(['pending', 'consumed', 'cancelled'] as const)(
  'PREQUEST09 archive cannot erase or resurrect a %s receipt',
  (status) => {
    const f = fixture(),
      pending = action(f).pendingRequest!;
    if (status === 'consumed') {
      const accepted = run(f, pending.request, pending.id).run;
      f.store.finishRun(accepted.id, 'cancelled', 'Synthetic cancellation after admission');
    } else if (status === 'cancelled') {
      cancelPackageRequest(f.store, f.chatId, f.branchId, pending.id);
    }
    const archive = f.store.product.export(),
      restored = database();
    expect(restored.product.import(archive)).toEqual({ restored: true, chats: 1 });
    expect(pendingPackageRequest(restored, f.chatId)).toEqual(
      status === 'pending' ? pending : null
    );
    for (const corruption of [...(status === 'pending' ? [] : ['resurrect']), 'erase']) {
      const altered = structuredClone(archive);
      if (corruption === 'erase') altered.tables.package_requests = [];
      else
        Object.assign(altered.tables.package_requests[0], {
          status: 'pending',
          consumed_run_id: null,
        });
      const target = database(),
        baseline = target.product.export().tables;
      expect(() => target.product.import(altered), `${status}:${corruption}`).toThrow();
      expect(target.product.export().tables).toEqual(baseline);
    }
  }
);

test('PREQUEST10 archive cannot replace a captured ancestor hash to revive a stale proposal', () => {
  const f = fixture(),
    ancestor = complete(f, run(f).run, 'Original ancestor.');
  complete(f, run(f).run, 'Current leaf.');
  const pending = action(f).pendingRequest!;
  f.store.editSource(ancestor.id, { text: 'Changed ancestor.', expectedRevision: 0 });
  expect(pendingPackageRequest(f.store, f.chatId)).toBeNull();
  const archive = f.store.product.export(),
    restored = database();
  restored.product.import(archive);
  expect(pendingPackageRequest(restored, f.chatId)).toBeNull();
  const altered = structuredClone(archive),
    row = altered.tables.package_requests[0];
  const dependencies = JSON.parse(row.dependencies as string);
  dependencies[0].hash = f.store.source(ancestor.id).hash;
  row.dependencies = JSON.stringify(dependencies);
  const target = database();
  expect(() => target.product.import(altered)).toThrow();
  expect(target.chats()).toHaveLength(0);
  expect(pending.sourceHash).toBe(f.store.source(pending.sourceRevision!).hash);
});

test('PREQUEST11 completed consumption survives fork while branch and chat deletion remove only owned receipts', () => {
  const f = fixture(),
    pending = action(f).pendingRequest!;
  const source = complete(f, run(f, pending.request, pending.id).run);
  const copied = forkChat(f.store, f.chatId, {
    fromRevision: source.id,
    idempotencyKey: 'consumed-fork',
  });
  expect(pendingPackageRequest(f.store, copied.id)).toBeNull();
  const branch = f.store.product.createBranch(f.chatId, {
    title: 'Temporary branch',
    fromRevision: source.id,
  });
  const branchRequest = action({ ...f, branchId: branch.id }).pendingRequest!;
  expect(() => cancelPackageRequest(f.store, f.chatId, f.branchId, branchRequest.id)).toThrow(
    'PACKAGE_REQUEST_NOT_FOUND'
  );
  deleteBranch(f.store, f.chatId, branch.id, {
    expectedRevision: f.store.product.branch(f.chatId, branch.id).revision,
  });
  expect(rows(f, 'package_requests')).toEqual([
    expect.objectContaining({ id: pending.id, status: 'consumed' }),
  ]);
  const restored = database();
  expect(restored.product.import(f.store.product.export())).toEqual({ restored: true, chats: 2 });
  expect(pendingPackageRequest(restored, f.chatId)).toBeNull();
  expect(pendingPackageRequest(restored, copied.id)).toBeNull();
  const disposable = fixture();
  action(disposable);
  deleteChat(
    disposable.store,
    disposable.chatId,
    chatDeletionImpact(disposable.store, disposable.chatId).request
  );
  expect(rows(disposable, 'package_requests')).toEqual([]);
  expect(rows(disposable, 'package_behavior_journal')).toEqual([]);
  validatePackageRequests(disposable.store);
});
