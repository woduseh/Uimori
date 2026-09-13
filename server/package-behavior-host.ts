import { randomUUID } from 'node:crypto';
import { HttpError } from './request-validation.js';
import {
  executionContext,
  packageInstanceId,
  type PackageExecutionState,
} from '../core/execution-context.js';
import type { RuntimeValue } from '../core/prompt-program.js';
import {
  BehaviorError,
  validatePackageBehavior,
  validateBehaviorValue,
  behaviorActionAllowed,
  behaviorActionTriggers,
} from '../core/package-behavior.js';
import { withoutPackageBehavior } from '../core/package-behavior-tools.js';
import {
  packageControlKey,
  type ContentPackage,
  type PackageAttachment,
} from '../core/content-package.js';
import { renderPackagePanels } from '../core/package-panels.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import type { RunSnapshot } from '../core/types.js';
import {
  behaviorPayloadHash,
  type BehaviorScope,
  type BehaviorState,
  type BehaviorActionCommand,
  type BehaviorUpgradeCommand,
} from './package-behavior-store.js';
import type { ResolvedExtensionProgram } from '../core/extension-program.js';
import { executeExtensionProgram } from './extension-runtime.js';
import { createPackageExtensionHost } from './extension-materials.js';
import { extensionOperationViews } from './extension-operations.js';
import type { Store, Run, Source } from './store.js';
import { captureLogicalHistory } from './prompt-snapshot.js';
import { freezeSourceSegments } from '../core/package-source-segments.js';
import {
  commitRunBehaviorInstance,
  completedRunBehaviorView,
  copyForkRunBehaviors,
  isRecoverableBehaviorExecutionError,
  runBehaviorProgress,
  saveProgress,
} from './package-behavior-run.js';
import { commitAfterResponseInstance } from './package-after-response.js';
import {
  initPackageRequests,
  packageRequestDependenciesHash,
  pendingPackageRequest,
  reservePackageRequestInTransaction,
} from './package-requests.js';

type Row = Record<string, any>;
type Definition = { ref: PackageAttachment; pkg: ContentPackage; scope: BehaviorScope };
export function initBehaviorHost(store: Store) {
  initPackageRequests(store);
  store.db.exec(`CREATE TABLE IF NOT EXISTS package_behavior_heads(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,instance_id TEXT NOT NULL,dependencies TEXT NOT NULL,status TEXT NOT NULL,error TEXT,draws TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,instance_id));
    CREATE TABLE IF NOT EXISTS package_behavior_outputs(source_id TEXT NOT NULL,instance_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source_id,instance_id));`);
}
function definitions(
  store: Store,
  chatId: string,
  branchId: string,
  snapshot?: RunSnapshot
): Definition[] {
  const profile = snapshot?.profile ?? store.product.snapshot(chatId);
  return (profile?.packageAttachments ?? []).flatMap((ref) => {
    const pkg = profile?.packages?.find((p) => p.id === ref.id && p.revision === ref.revision);
    if (!pkg?.behavior) return [];
    validatePackageBehavior(pkg.behavior);
    return [
      {
        ref,
        pkg,
        scope: {
          chatId,
          branchId,
          attachmentInstanceId: packageInstanceId(ref),
          packageId: ref.id,
          packageRevision: ref.revision,
          behaviorRevision: pkg.behavior.revision,
          schemaVersion: pkg.behavior.schemaVersion,
        },
      },
    ];
  });
}
function dependencies(store: Store, chatId: string, branchId: string) {
  return store
    .history(store.product.branch(chatId, branchId).headRevision)
    .map((s) => ({ id: s.revision, hash: store.source(s.revision).hash }));
}
function setHead(
  store: Store,
  scope: BehaviorScope,
  status: string,
  error: string | null,
  draws: Record<string, RuntimeValue> = {}
) {
  store.db
    .prepare(
      'INSERT INTO package_behavior_heads VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat_id,branch_id,instance_id) DO UPDATE SET dependencies=excluded.dependencies,status=excluded.status,error=excluded.error,draws=excluded.draws'
    )
    .run(
      scope.chatId,
      scope.branchId,
      scope.attachmentInstanceId,
      JSON.stringify(dependencies(store, scope.chatId, scope.branchId)),
      status,
      error,
      JSON.stringify(draws)
    );
}
function status(
  store: Store,
  scope: BehaviorScope
): { status: 'ready' | 'stale'; error: string | null } {
  const row = store.db
    .prepare(
      'SELECT * FROM package_behavior_heads WHERE chat_id=? AND branch_id=? AND instance_id=?'
    )
    .get(scope.chatId, scope.branchId, scope.attachmentInstanceId) as Row | undefined;
  if (!row) return { status: 'ready', error: null };
  if (row.status !== 'ready')
    return { status: 'stale', error: row.error ?? 'BEHAVIOR_STATE_STALE' };
  for (const dep of JSON.parse(row.dependencies) as { id: string; hash: string }[])
    if (store.source(dep.id).hash !== dep.hash)
      return { status: 'stale', error: 'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED' };
  return { status: 'ready', error: null };
}
function frozenState(store: Store, d: Definition, state: BehaviorState): PackageExecutionState {
  const journal = store.behavior.journal(d.scope);
  const lastDraw = [...journal]
    .reverse()
    .find(
      (r) =>
        ['explicit-reset', 'explicit-upgrade'].includes(r.provenance) || Object.keys(r.draws).length
    );
  const head = store.db
    .prepare(
      'SELECT draws FROM package_behavior_heads WHERE chat_id=? AND branch_id=? AND instance_id=?'
    )
    .get(d.scope.chatId, d.scope.branchId, d.scope.attachmentInstanceId) as Row | undefined;
  return {
    instanceId: d.scope.attachmentInstanceId,
    packageId: d.ref.id,
    packageRevision: d.ref.revision,
    role: d.ref.role,
    behaviorRevision: d.scope.behaviorRevision,
    schemaVersion: d.scope.schemaVersion,
    stateRevision: state.stateRevision,
    state: state.state,
    draws: lastDraw?.draws ?? (head ? JSON.parse(head.draws) : {}),
  };
}
function retainedState(store: Store, d: Definition): PackageExecutionState[] {
  const stored = store.behavior.storedState(d.scope);
  if (!stored) return [];
  const prior = store.product.get<{ package: ContentPackage }>(
    'content',
    stored.packageId,
    stored.packageRevision
  ).package;
  validateBehaviorValue(validatePackageBehavior(prior.behavior).stateSchema, stored.state);
  return [
    frozenState(
      store,
      {
        ...d,
        ref: { ...d.ref, revision: stored.packageRevision },
        scope: {
          ...d.scope,
          packageRevision: stored.packageRevision,
          behaviorRevision: stored.behaviorRevision,
          schemaVersion: stored.schemaVersion,
        },
      },
      stored
    ),
  ];
}
/** GET and previews are projections. They never initialize rows, roll dice, or repair state. */
export function behaviorDetail(store: Store, chatId: string, requestedBranch?: string) {
  store.chat(chatId);
  const branch = store.product.branch(chatId, requestedBranch);
  const profile = store.product.snapshot(chatId);
  const identity = profile
    ? packageIdentityFromProfile(profile, 'status')
    : { bot: { name: 'Character' }, user: { name: 'User' } };
  const renderPanels = (pkg: ContentPackage, ref: PackageAttachment, state: RuntimeValue) =>
    renderPackagePanels(pkg, {
      state,
      identity,
      values: profile?.packageValues?.[packageControlKey(ref)],
    });
  const standalonePanels = (profile?.packageAttachments ?? []).flatMap((ref) => {
    const pkg = profile?.packages?.find(
      (item) => item.id === ref.id && item.revision === ref.revision
    );
    return pkg?.panels?.length && !pkg.behavior
      ? [
          {
            instanceId: packageInstanceId(ref),
            title: pkg.title,
            panels: renderPanels(pkg, ref, null),
          },
        ]
      : [];
  });
  const pending = !!store.db
    .prepare(
      "SELECT 1 FROM runs WHERE branch_id=? AND status IN ('queued','running','waiting_for_state')"
    )
    .get(branch.id);
  return {
    ...(standalonePanels.length ? { standalonePanels } : {}),
    sourceHash: branch.headRevision ? store.source(branch.headRevision).hash : null,
    pendingRequest: pendingPackageRequest(store, chatId, branch.id),
    operations: extensionOperationViews(store, chatId, branch.id),
    instances: definitions(store, chatId, branch.id).map((d) => {
      let state: BehaviorState;
      let availability: { status: 'ready' | 'stale'; error: string | null };
      try {
        state = store.behavior.read(d.scope, d.pkg.behavior!);
        availability = status(store, d.scope);
      } catch (error) {
        state = store.behavior.storedState(d.scope) ?? {
          ...d.scope,
          stateRevision: 0,
          state: d.pkg.behavior!.initialState,
        };
        availability = {
          status: 'stale',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const last = store.db
        .prepare(
          "SELECT payload,result FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND json_type(result,'$.actionResult') IS NOT NULL AND json_extract(result,'$.provenance') <> 'explicit-upgrade' ORDER BY rowid DESC LIMIT 1"
        )
        .get(chatId, branch.id, d.scope.attachmentInstanceId) as Row | undefined;
      const receipt = last ? JSON.parse(last.result) : undefined;
      const lastAction = last
        ? {
            actionId: JSON.parse(last.payload).actionId as string,
            result: receipt.actionResult as RuntimeValue,
            stateRevision: receipt.stateRevision as number,
            trigger: (receipt.provenance === 'ui-action'
              ? 'user'
              : receipt.provenance === 'before-turn'
                ? 'before-turn'
                : receipt.provenance === 'after-turn'
                  ? 'after-turn'
                  : 'model') as 'user' | 'before-turn' | 'model' | 'after-turn',
          }
        : undefined;
      return {
        instanceId: d.scope.attachmentInstanceId,
        packageId: d.ref.id,
        packageRevision: d.ref.revision,
        role: d.ref.role,
        title: d.pkg.title,
        behavior: d.pkg.behavior!,
        stateRevision: state.stateRevision,
        state: state.state,
        status: pending ? ('pending' as const) : availability.status,
        error: availability.error,
        ...(!pending &&
        availability.error === 'BEHAVIOR_MIGRATION_REQUIRED' &&
        status(store, d.scope).status === 'ready'
          ? { upgrade: upgradeOptions(d, state) }
          : {}),
        ...(d.pkg.panels?.length ? { panels: renderPanels(d.pkg, d.ref, state.state) } : {}),
        ...(lastAction ? { lastAction } : {}),
      };
    }),
  };
}
export function freezePackageStates(
  store: Store,
  snapshot: RunSnapshot,
  initialize: boolean
): RunSnapshot {
  const branchId = snapshot.branchId ?? `main:${snapshot.chatId}`;
  let projected = snapshot;
  const states = definitions(store, snapshot.chatId, branchId, snapshot).flatMap((d) => {
    if (
      snapshot.packageBehaviorUnavailable?.some(
        (item) => item.instanceId === d.scope.attachmentInstanceId
      )
    )
      return [];
    const availability = status(store, d.scope);
    if (availability.status !== 'ready') {
      projected = withoutPackageBehavior(
        projected,
        [d.ref],
        'state',
        availability.error!,
        retainedState(store, d)
      );
      return [];
    }
    try {
      const state = initialize
        ? store.behavior.ensureInTransaction(d.scope, d.pkg.behavior!)
        : store.behavior.read(d.scope, d.pkg.behavior!);
      validateBehaviorValue(d.pkg.behavior!.stateSchema, state.state);
      return [frozenState(store, d, state)];
    } catch (error) {
      // A definition update is recoverable; malformed rows/SQL/ownership errors are not.
      if (!(error instanceof BehaviorError) || error.message !== 'BEHAVIOR_MIGRATION_REQUIRED')
        throw error;
      projected = withoutPackageBehavior(
        projected,
        [d.ref],
        'state',
        error.message,
        retainedState(store, d)
      );
      return [];
    }
  });
  return states.length || projected.packageBehaviorUnavailable?.length
    ? { ...projected, packageStates: states }
    : snapshot;
}
export type BehaviorUpgradePreviewCommand = Omit<
  BehaviorUpgradeCommand,
  'previewId' | 'idempotencyKey'
>;
function upgradeOptions(d: Definition, state: BehaviorState) {
  let canPreserve = false;
  try {
    validateBehaviorValue(d.pkg.behavior!.stateSchema, state.state);
    canPreserve = true;
  } catch {
    /* The author may provide a transformation for the new schema. */
  }
  return { canPreserve, canTransform: !!d.pkg.behavior!.migration };
}
function upgradeDefinition(
  store: Store,
  chatId: string,
  branchId: string | undefined,
  instanceId: string
) {
  store.chat(chatId);
  const branch = store.product.branch(chatId, branchId);
  const d = definitions(store, chatId, branch.id).find(
    (item) => item.scope.attachmentInstanceId === instanceId
  );
  if (!d) throw new HttpError(404, 'PACKAGE_BEHAVIOR_NOT_ATTACHED');
  return { branch, d };
}
function upgradeContext(
  store: Store,
  chatId: string,
  branchId: string | undefined,
  instanceId: string,
  command: BehaviorUpgradePreviewCommand
) {
  const { branch, d } = actionContext(store, chatId, branchId, instanceId, command, false);
  if (command.expectedPackageRevision !== d.scope.packageRevision)
    throw new HttpError(409, 'BEHAVIOR_PACKAGE_STALE');
  let migrationRequired = false;
  try {
    store.behavior.read(d.scope, d.pkg.behavior!);
  } catch (error) {
    if (!(error instanceof BehaviorError) || error.message !== 'BEHAVIOR_MIGRATION_REQUIRED')
      throw error;
    migrationRequired = true;
  }
  if (!migrationRequired) throw new HttpError(409, 'BEHAVIOR_UPGRADE_NOT_REQUIRED');
  const state = store.behavior.storedState(d.scope)!;
  const prior = store.product.get<{ package: ContentPackage }>(
    'content',
    state.packageId,
    state.packageRevision
  ).package;
  validateBehaviorValue(validatePackageBehavior(prior.behavior).stateSchema, state.state);
  if (state.stateRevision !== command.expectedStateRevision)
    throw new HttpError(409, 'BEHAVIOR_STATE_STALE');
  if (
    (branch.headRevision ? store.source(branch.headRevision).hash : null) !==
    command.expectedSourceHash
  )
    throw new HttpError(409, 'BEHAVIOR_SOURCE_STALE');
  if (command.mode !== 'preserve' && command.mode !== 'program')
    throw new HttpError(400, 'BEHAVIOR_UPGRADE_MODE');
  const guard = behaviorPayloadHash({
    scope: d.scope,
    state,
    prior,
    target: d.pkg,
    profile: store.product.snapshot(chatId),
    settingsRevision: store.chat(chatId).settingsRevision,
    head: branch.headRevision,
    dependencies: dependencies(store, chatId, branch.id),
    requestDependencies: packageRequestDependenciesHash(store, branch.headRevision),
  });
  return { branch, d, state, guard };
}
type UpgradePreview = {
  guard: string;
  commandHash: string;
  expires: number;
  result?: ResolvedExtensionProgram;
};
const upgradePreviews = new WeakMap<Store, Map<string, UpgradePreview>>();
function upgradeCommandHash(
  chatId: string,
  branchId: string,
  instanceId: string,
  command: BehaviorUpgradePreviewCommand
) {
  return behaviorPayloadHash({
    chatId,
    branchId,
    instanceId,
    command: {
      mode: command.mode,
      expectedPackageRevision: command.expectedPackageRevision,
      expectedStateRevision: command.expectedStateRevision,
      expectedSourceHash: command.expectedSourceHash,
    },
  });
}
/** Explicit POST only: guest code calculates a candidate without changing persistent state. */
export async function previewBehaviorUpgrade(
  store: Store,
  chatId: string,
  branchId: string | undefined,
  instanceId: string,
  command: BehaviorUpgradePreviewCommand,
  signal?: AbortSignal
) {
  const captured = store.transaction(() =>
    upgradeContext(store, chatId, branchId, instanceId, command)
  );
  const behavior = captured.d.pkg.behavior!;
  let result: ResolvedExtensionProgram | undefined;
  if (command.mode === 'program') {
    if (!behavior.migration || behavior.migration.capabilities?.length)
      throw new HttpError(400, 'BEHAVIOR_UPGRADE_PROGRAM_UNAVAILABLE');
    const executed = await executeExtensionProgram(
      behavior.migration,
      {
        state: captured.state.state,
        input: {
          from: {
            behaviorRevision: captured.state.behaviorRevision,
            schemaVersion: captured.state.schemaVersion,
          },
          to: { behaviorRevision: behavior.revision, schemaVersion: behavior.schemaVersion },
        },
      },
      signal
    );
    result = { ...executed, programHash: behaviorPayloadHash(behavior.migration) };
  }
  if (signal?.aborted) throw new HttpError(409, 'EXTENSION_CANCELLED');
  const after = result ? result.state : captured.state.state;
  validateBehaviorValue(behavior.stateSchema, after);
  return store.transaction(() => {
    const current = upgradeContext(store, chatId, captured.branch.id, instanceId, command);
    if (current.guard !== captured.guard)
      throw new HttpError(409, 'BEHAVIOR_PROGRAM_CONTEXT_CHANGED');
    if (signal?.aborted) throw new HttpError(409, 'EXTENSION_CANCELLED');
    let cache = upgradePreviews.get(store);
    if (!cache) {
      cache = new Map();
      upgradePreviews.set(store, cache);
    }
    const now = Date.now();
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
    while (cache.size >= 64) cache.delete(cache.keys().next().value!);
    const previewId = randomUUID();
    cache.set(previewId, {
      guard: captured.guard,
      result,
      expires: now + 600_000,
      commandHash: upgradeCommandHash(chatId, captured.branch.id, instanceId, command),
    });
    return {
      previewId,
      mode: command.mode,
      from: {
        packageRevision: captured.state.packageRevision,
        behaviorRevision: captured.state.behaviorRevision,
        schemaVersion: captured.state.schemaVersion,
        stateRevision: captured.state.stateRevision,
      },
      to: {
        packageRevision: captured.d.scope.packageRevision,
        behaviorRevision: behavior.revision,
        schemaVersion: behavior.schemaVersion,
        stateRevision: captured.state.stateRevision + 1,
      },
      before: captured.state.state,
      after,
      drawsCleared: true,
    };
  });
}
/** Apply only a host-owned candidate; durable receipts survive preview expiry and restart. */
export function applyBehaviorUpgrade(
  store: Store,
  chatId: string,
  branchId: string | undefined,
  instanceId: string,
  command: BehaviorUpgradeCommand
) {
  return store.transaction(() => {
    const { branch, d } = upgradeDefinition(store, chatId, branchId, instanceId);
    if (priorActionPayload(store, d.scope, command.idempotencyKey)) {
      store.behavior.upgradeInTransaction(d.scope, d.pkg.behavior!, command);
      return behaviorDetail(store, chatId, branch.id);
    }
    const current = upgradeContext(store, chatId, branch.id, instanceId, command);
    const preview = upgradePreviews.get(store)?.get(command.previewId);
    if (!preview || preview.expires <= Date.now())
      throw new HttpError(409, 'BEHAVIOR_UPGRADE_PREVIEW_EXPIRED');
    if (
      preview.commandHash !== upgradeCommandHash(chatId, branch.id, instanceId, command) ||
      preview.guard !== current.guard
    )
      throw new HttpError(409, 'BEHAVIOR_PROGRAM_CONTEXT_CHANGED');
    store.behavior.upgradeInTransaction(d.scope, d.pkg.behavior!, command, preview.result);
    setHead(store, d.scope, 'ready', null, {});
    store.event(chatId, 'package.state.upgrade', instanceId);
    return behaviorDetail(store, chatId, branch.id);
  });
}
type ActionPanel = { id: string; packageRevision: number };
function actionContext(
  store: Store,
  chatId: string,
  branchId: string | undefined,
  instanceId: string,
  command: any,
  reset: boolean,
  panel?: ActionPanel
) {
  const branch = store.product.branch(chatId, branchId);
  const d = definitions(store, chatId, branch.id).find(
    (item) => item.scope.attachmentInstanceId === instanceId
  );
  if (!d) throw new HttpError(404, 'PACKAGE_BEHAVIOR_NOT_ATTACHED');
  if (panel) {
    if (d.pkg.revision !== panel.packageRevision)
      throw new HttpError(409, 'PACKAGE_PANEL_REVISION_CHANGED');
    const definition = d.pkg.panels?.find((item) => item.id === panel.id);
    if (reset || !definition?.actions?.includes(command.actionId))
      throw new HttpError(403, 'PACKAGE_PANEL_ACTION_NOT_ALLOWED');
  }
  if (
    store.db
      .prepare(
        "SELECT 1 FROM runs WHERE branch_id=? AND status IN ('queued','running','waiting_for_state')"
      )
      .get(branch.id)
  )
    throw new HttpError(409, 'BEHAVIOR_RUN_ACTIVE');
  const availability = status(store, d.scope);
  if (!reset && availability.status !== 'ready') throw new HttpError(409, availability.error!);
  return { branch, d };
}
function actionRuntime(store: Store, chatId: string, branchId: string, ref: PackageAttachment) {
  const chat = store.chat(chatId);
  const branch = store.product.branch(chatId, branchId);
  const profile = store.product.snapshot(chatId);
  const iso = new Date().toISOString();
  let view: RunSnapshot = {
    chatId,
    parentRevision: branch.headRevision,
    branchId,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: '',
    history: store.history(branch.headRevision),
    resources: store.product.resources(chatId, profile),
    profile,
    executionClock: { iso, unix: Math.floor(Date.parse(iso) / 1000) },
  };
  view.sourceSegments = freezeSourceSegments(profile);
  view.logicalHistory = captureLogicalHistory(store, view);
  view = freezePackageStates(store, view, false);
  return {
    ...executionContext(view, 'main', ref),
    profile: { revision: profile?.revision ?? 0 },
    sourceDependenciesHash: packageRequestDependenciesHash(store, branch.headRevision),
  };
}
function priorActionPayload(store: Store, scope: BehaviorScope, key: string) {
  const row = store.db
    .prepare(
      'SELECT payload FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND idempotency_key=?'
    )
    .get(scope.chatId, scope.branchId, scope.attachmentInstanceId, key) as
    | { payload: string }
    | undefined;
  return row ? JSON.parse(row.payload) : undefined;
}
/** Only host-owned preparation may supply these values; the HTTP body never accepts them. */
type PreparedAction = {
  guard: string;
  runtime: Record<string, RuntimeValue>;
  result: ResolvedExtensionProgram;
};
function actionGuard(store: Store, d: Definition) {
  const branch = store.product.branch(d.scope.chatId, d.scope.branchId);
  const runtime = actionRuntime(store, d.scope.chatId, d.scope.branchId, d.ref);
  return behaviorPayloadHash({
    scope: d.scope,
    state: store.behavior.read(d.scope, d.pkg.behavior!),
    profileRevision: store.product.profile(d.scope.chatId).revision,
    settingsRevision: store.chat(d.scope.chatId).settingsRevision,
    // Conditions/nextRequest may read other scoped values. Only the captured wall clock
    // is intentionally stable for this action instead of becoming a spurious conflict.
    context: { ...runtime, time: null },
    head: branch.headRevision,
    dependencies: packageRequestDependenciesHash(store, branch.headRevision),
  });
}
export function performBehaviorAction(
  store: Store,
  chatId: string,
  branchId: string | undefined,
  instanceId: string,
  command: any,
  reset = false,
  panel?: ActionPanel,
  prepared?: PreparedAction
) {
  return store.transaction(() => {
    const { branch, d } = actionContext(store, chatId, branchId, instanceId, command, reset, panel);
    const beforeRevision =
      (reset ? store.behavior.storedState(d.scope) : undefined)?.stateRevision ??
      store.behavior.read(d.scope, d.pkg.behavior!).stateRevision;
    if (reset) store.behavior.resetInTransaction(d.scope, d.pkg.behavior!, command);
    else {
      const priorAction = priorActionPayload(store, d.scope, command.idempotencyKey);
      if (prepared && !priorAction && actionGuard(store, d) !== prepared.guard)
        throw new HttpError(409, 'BEHAVIOR_PROGRAM_CONTEXT_CHANGED');
      // A retransmitted UI command must compare with its original clock/context, not a new timestamp.
      // The behavior store still verifies the entire command and scope before returning the receipt.
      const runtime = priorAction
        ? (priorAction.hostRuntime ?? {})
        : (prepared?.runtime ?? actionRuntime(store, chatId, branch.id, d.ref));
      const receipt = store.behavior.executeInTransaction(
        d.scope,
        d.pkg.behavior!,
        command,
        runtime,
        priorAction?.program ?? prepared?.result
      );
      const action = d.pkg.behavior!.actions.find((action) => action.id === command.actionId)!;
      if (receipt.stateRevision > beforeRevision && action.nextRequest !== undefined)
        reservePackageRequestInTransaction(store, action, receipt, command.input, runtime);
    }
    const afterState = store.behavior.read(d.scope, d.pkg.behavior!);
    if (afterState.stateRevision !== beforeRevision) {
      setHead(store, d.scope, 'ready', null, frozenState(store, d, afterState).draws);
      store.event(chatId, reset ? 'package.state.reset' : 'package.action', instanceId);
    }
    return behaviorDetail(store, chatId, branch.id);
  });
}
const activePrograms = new WeakMap<
  Store,
  Map<string, { commandHash: string; promise: Promise<ReturnType<typeof behaviorDetail>> }>
>();
/** Shared admission for short local actions and durable user model operations. */
export function prepareUserBehaviorProgram(
  store: Store,
  chatId: string,
  branchId: string | undefined,
  instanceId: string,
  command: BehaviorActionCommand,
  panel?: ActionPanel
) {
  return store.transaction(() => {
    const { branch, d } = actionContext(store, chatId, branchId, instanceId, command, false, panel);
    const action = d.pkg.behavior!.actions.find((item) => item.id === command.actionId);
    if (!action) throw new HttpError(400, 'BEHAVIOR_ACTION_UNKNOWN');
    // A committed receipt is returned through the normal full-command idempotency check.
    if (!action.program || priorActionPayload(store, d.scope, command.idempotencyKey)) return null;
    if (!behaviorActionTriggers(action).includes('user'))
      throw new HttpError(403, 'BEHAVIOR_USER_ACTION_NOT_ALLOWED');
    const state = store.behavior.read(d.scope, d.pkg.behavior!);
    const sourceHash = branch.headRevision ? store.source(branch.headRevision).hash : null;
    if (state.stateRevision !== command.expectedStateRevision)
      throw new HttpError(409, 'BEHAVIOR_STATE_STALE');
    if (sourceHash !== command.expectedSourceHash)
      throw new HttpError(409, 'BEHAVIOR_SOURCE_STALE');
    const runtime = actionRuntime(store, chatId, branch.id, d.ref);
    if (!behaviorActionAllowed(action, state.state, command.input, runtime))
      throw new HttpError(409, 'BEHAVIOR_ACTION_DISABLED');
    const guard = actionGuard(store, d);
    return {
      scope: d.scope,
      stateRevision: state.stateRevision,
      profile: store.product.snapshot(chatId)!,
      settings: store.chat(chatId).settings,
      sourceRevision: branch.headRevision,
      sourceHash,
      branchId: branch.id,
      program: action.program,
      input: { state: state.state, input: command.input },
      runtime,
      guard,
      host: createPackageExtensionHost(
        action.program,
        store.product.snapshot(chatId),
        d.ref,
        () => {
          const current = actionContext(
            store,
            chatId,
            branch.id,
            instanceId,
            command,
            false,
            panel
          );
          if (actionGuard(store, current.d) !== guard)
            throw new HttpError(409, 'BEHAVIOR_PROGRAM_CONTEXT_CHANGED');
        }
      ),
    };
  });
}

/** A durable invocation checks the same context boundary as an immediate user action. */
export function assertUserBehaviorProgramCurrent(
  store: Store,
  chatId: string,
  branchId: string,
  instanceId: string,
  command: BehaviorActionCommand,
  guard: string,
  panel?: ActionPanel
) {
  const { d } = actionContext(store, chatId, branchId, instanceId, command, false, panel);
  if (actionGuard(store, d) !== guard) throw new HttpError(409, 'BEHAVIOR_PROGRAM_CONTEXT_CHANGED');
}

/** Calculate outside SQLite transactions; only the host can adopt the returned state. */
export async function performBehaviorActionWithProgram(
  store: Store,
  chatId: string,
  branchId: string | undefined,
  instanceId: string,
  command: BehaviorActionCommand,
  panel?: ActionPanel,
  signal?: AbortSignal
) {
  const preparation = prepareUserBehaviorProgram(
    store,
    chatId,
    branchId,
    instanceId,
    command,
    panel
  );
  if (!preparation)
    return performBehaviorAction(store, chatId, branchId, instanceId, command, false, panel);
  let active = activePrograms.get(store);
  if (!active) {
    active = new Map();
    activePrograms.set(store, active);
  }
  const key = JSON.stringify([chatId, preparation.branchId, instanceId, command.idempotencyKey]);
  const commandHash = behaviorPayloadHash({ command, panel: panel ?? null });
  const pending = active.get(key);
  if (pending) {
    if (pending.commandHash !== commandHash)
      throw new HttpError(409, 'BEHAVIOR_IDEMPOTENCY_CONFLICT');
    return pending.promise;
  }
  const promise = (async () => {
    const result = await executeExtensionProgram(preparation.program, preparation.input, signal, {
      host: preparation.host,
    });
    if (signal?.aborted) throw new HttpError(409, 'EXTENSION_CANCELLED');
    return performBehaviorAction(
      store,
      chatId,
      preparation.branchId,
      instanceId,
      command,
      false,
      panel,
      {
        guard: preparation.guard,
        runtime: preparation.runtime,
        result: { ...result, programHash: behaviorPayloadHash(preparation.program) },
      }
    );
  })();
  active.set(key, { commandHash, promise });
  try {
    return await promise;
  } finally {
    if (active.get(key)?.promise === promise) active.delete(key);
  }
}
/** Actions and authoritative outputs share one transaction boundary across packages.
 * Annotation parsing is a separate overlay; its failure preserves already validated action facts. */
export function completePackageOutputs(store: Store, run: Run, source: Source) {
  const branchId = run.snapshot.branchId ?? `main:${run.chatId}`;
  let projected = completedRunBehaviorView(store, run);
  const defs = definitions(store, run.chatId, branchId, projected)
    .filter(
      (d) =>
        !projected.packageBehaviorUnavailable?.some(
          (item) => item.instanceId === d.scope.attachmentInstanceId
        )
    )
    .map((d) => ({
      d,
      before: (run.snapshot.behaviorExecution?.baseStates ?? run.snapshot.packageStates)?.find(
        (s) => s.instanceId === d.scope.attachmentInstanceId
      ),
    }))
    .filter((item): item is { d: Definition; before: PackageExecutionState } => !!item.before);
  if (!defs.length) return;
  const parse = (d: Definition, before: PackageExecutionState) => {
    const expected =
      projected.packageStates?.find((s) => s.instanceId === d.scope.attachmentInstanceId)
        ?.stateRevision ?? before.stateRevision;
    if (d.pkg.behavior!.outputParsers.length)
      store.behavior.applyOutputsInTransaction(
        d.scope,
        d.pkg.behavior!,
        {
          parserIds: d.pkg.behavior!.outputParsers.map((p) => p.id),
          text: source.text,
          baseStateRevision: expected,
          sourceHash: source.hash,
          idempotencyKey: `source:${source.id}:${source.hash}`,
        },
        executionContext(projected, 'main', d.ref)
      );
  };
  let groupFailure: string | null = null;
  store.db.exec('SAVEPOINT package_outputs');
  try {
    projected = completedRunBehaviorView(store, run);
    if (
      run.snapshot.history.some(
        (item) =>
          store.source(item.revision).hash !==
          (item.contentHash ?? store.sourceOriginal(item.revision).hash)
      )
    )
      throw new HttpError(409, 'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED');
    for (const { d } of defs)
      commitRunBehaviorInstance(store, run, d.scope.attachmentInstanceId, source.hash);
    for (const { d, before } of defs) if (d.pkg.behavior!.mode !== 'annotation') parse(d, before);
    store.db.exec('RELEASE package_outputs');
  } catch (error) {
    store.db.exec('ROLLBACK TO package_outputs; RELEASE package_outputs');
    if (
      !isRecoverableBehaviorExecutionError(error) &&
      !(error instanceof HttpError && error.message === 'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED')
    )
      throw error;
    groupFailure = error instanceof Error ? error.message : String(error);
  }
  for (const { d, before } of defs) {
    let failure = groupFailure;
    const rejectAfterResponse = (code: string) => {
      const progress = runBehaviorProgress(store, run.id);
      const prepared = progress?.afterResponse?.packages.find(
        (item) => item.instanceId === d.scope.attachmentInstanceId
      );
      if (progress && prepared?.status === 'ready') {
        prepared.status = 'failed';
        prepared.code = code;
        prepared.entries = [];
        prepared.after = structuredClone(prepared.before);
        saveProgress(store, run.id, progress);
      }
    };
    if (!groupFailure && d.pkg.behavior!.mode === 'annotation') {
      store.db.exec('SAVEPOINT package_annotation');
      try {
        parse(d, before);
        store.db.exec('RELEASE package_annotation');
      } catch (error) {
        store.db.exec('ROLLBACK TO package_annotation; RELEASE package_annotation');
        if (!isRecoverableBehaviorExecutionError(error)) throw error;
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    if (!failure) {
      // Response hooks are an optional overlay: retain successful actions/parsers on guest failure.
      store.db.exec('SAVEPOINT package_after_response');
      try {
        commitAfterResponseInstance(store, run, d.scope.attachmentInstanceId, source.hash);
        store.db.exec('RELEASE package_after_response');
      } catch (error) {
        store.db.exec('ROLLBACK TO package_after_response; RELEASE package_after_response');
        if (!isRecoverableBehaviorExecutionError(error)) throw error;
        rejectAfterResponse(
          error instanceof Error ? error.message : 'BEHAVIOR_AFTER_RESPONSE_FAILED'
        );
        store.event(run.chatId, 'package.after-response.failed', source.id);
      }
    } else rejectAfterResponse('BEHAVIOR_AFTER_RESPONSE_BASE_UNAVAILABLE');
    const after = groupFailure
      ? structuredClone(before)
      : frozenState(store, d, store.behavior.read(d.scope, d.pkg.behavior!));
    store.db.prepare('INSERT INTO package_behavior_outputs VALUES(?,?,?)').run(
      source.id,
      d.scope.attachmentInstanceId,
      JSON.stringify({
        before,
        after,
        status: failure ? 'failed' : 'ready',
        error: failure,
        sourceHash: source.hash,
      })
    );
    setHead(store, d.scope, failure ? 'failed' : 'ready', failure, after.draws);
    store.event(
      run.chatId,
      failure ? 'package.output.failed' : 'package.output.completed',
      source.id
    );
  }
}

/** Copy source-bound projections into a new chat. The selected boundary supplies its current state. */
export function copyPackageFork(
  store: Store,
  chatId: string,
  branchId: string,
  sourceIds: Map<string, string>,
  selectedSourceId: string
) {
  for (const [oldId, newId] of sourceIds) {
    for (const row of store.db
      .prepare('SELECT instance_id,body FROM package_behavior_outputs WHERE source_id=?')
      .all(oldId) as Row[])
      store.db
        .prepare('INSERT INTO package_behavior_outputs VALUES(?,?,?)')
        .run(newId, row.instance_id, row.body);
  }
  copyForkRunBehaviors(store, chatId, branchId, sourceIds);
  branchPackageStates(store, chatId, branchId, selectedSourceId);
}
/** Restore the state at a source boundary, including its failure status, without applying current-branch actions. */
export function branchPackageStates(
  store: Store,
  chatId: string,
  branchId: string,
  sourceId: string | null,
  candidate?: RunSnapshot
) {
  const defs = definitions(store, chatId, branchId, candidate);
  for (const d of defs) {
    let saved = (candidate?.behaviorExecution?.baseStates ?? candidate?.packageStates)?.find(
      (s) => s.instanceId === d.scope.attachmentInstanceId
    );
    let failure: string | null = null;
    if (!saved && sourceId) {
      const row = store.db
        .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=? AND instance_id=?')
        .get(sourceId, d.scope.attachmentInstanceId) as Row | undefined;
      if (row) {
        const result = JSON.parse(row.body);
        saved = result.after;
        failure = result.error;
        if (store.source(sourceId).hash !== result.sourceHash)
          failure = 'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED';
      }
    }
    const basis =
      candidate ?? (sourceId ? store.run(store.source(sourceId).runId).snapshot : undefined);
    const unavailable = basis?.packageBehaviorUnavailable?.find(
      (item) => item.instanceId === d.scope.attachmentInstanceId
    );
    if (unavailable) {
      saved = unavailable.retainedState;
      failure = unavailable.code;
    }
    if (
      saved &&
      basis?.history.some(
        (item) =>
          store.source(item.revision).hash !==
          (item.contentHash ?? store.sourceOriginal(item.revision).hash)
      )
    )
      failure = 'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED';
    if (saved) {
      const savedDefinition = validatePackageBehavior(
        store.product.get<any>('content', d.ref.id, saved.packageRevision).package?.behavior
      );
      const compatible =
        behaviorPayloadHash(savedDefinition) === behaviorPayloadHash(d.pkg.behavior!);
      const restoreScope = compatible
        ? d.scope
        : {
            ...d.scope,
            packageRevision: saved.packageRevision,
            behaviorRevision: saved.behaviorRevision,
            schemaVersion: saved.schemaVersion,
          };
      store.behavior.ensureInTransaction(
        restoreScope,
        compatible ? d.pkg.behavior! : savedDefinition
      );
      if (!compatible) failure = 'BEHAVIOR_MIGRATION_REQUIRED';
      store.db
        .prepare(
          'UPDATE package_behavior_states SET state_revision=?,state=? WHERE chat_id=? AND branch_id=? AND instance_id=?'
        )
        .run(
          saved.stateRevision,
          JSON.stringify(saved.state),
          chatId,
          branchId,
          d.scope.attachmentInstanceId
        );
    } else store.behavior.ensureInTransaction(d.scope, d.pkg.behavior!);
    setHead(store, d.scope, failure ? 'failed' : 'ready', failure, saved?.draws ?? {});
  }
}
