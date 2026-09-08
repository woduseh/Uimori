import { HttpError } from './request-validation.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { evaluatePromptExpression, type RuntimeValue } from '../core/prompt-program.js';
import { packageInstanceId } from '../core/execution-context.js';
import type { BehaviorAction } from '../core/package-behavior.js';
import type { PackageRequest } from '../core/package-request.js';
import { behaviorPayloadHash, type BehaviorJournalResult } from './package-behavior-store.js';
import type { Content } from '../core/product.js';
import type { Store } from './store.js';

type Row = Record<string, any>;
const reject = (message: string): never => {
  throw new HttpError(409, message);
};
export function initPackageRequests(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS package_requests(
    id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),
    instance_id TEXT NOT NULL,action_key TEXT NOT NULL,body TEXT NOT NULL,dependencies TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','consumed','cancelled')),consumed_run_id TEXT REFERENCES runs(id),
    UNIQUE(chat_id,branch_id,instance_id,action_key));
    CREATE UNIQUE INDEX IF NOT EXISTS package_request_pending ON package_requests(chat_id,branch_id) WHERE status='pending';`);
}
function sourceDependencies(store: Store, sourceId: string | null) {
  return store
    .history(sourceId)
    .map((source) => ({ id: source.revision, hash: store.source(source.revision).hash }));
}
/** A compact journal anchor covers the entire ancestry without enlarging the expression runtime. */
export function packageRequestDependenciesHash(store: Store, sourceId: string | null): string {
  return behaviorPayloadHash(sourceDependencies(store, sourceId));
}
/** This projection is deliberately separate from ordinary action results. Only the host can reserve it. */
export function projectPackageRequest(
  action: BehaviorAction,
  receipt: BehaviorJournalResult,
  input: RuntimeValue,
  hostRuntime: Record<string, RuntimeValue>
): string {
  if (action.nextRequest === undefined || receipt.provenance !== 'ui-action')
    reject('PACKAGE_REQUEST_USER_ACTION_REQUIRED');
  const value = evaluatePromptExpression(
    action.nextRequest!,
    {},
    {
      runtime: {
        ...hostRuntime,
        state: receipt.beforeState,
        input,
        draws: receipt.draws,
        nextState: receipt.state,
        result: receipt.actionResult ?? null,
      },
    }
  );
  if (typeof value !== 'string' || !value.trim() || value.length > 4_000)
    reject('PACKAGE_REQUEST_TEXT_INVALID');
  return value as string;
}
/** Joins the user action transaction. A replay must never recreate a consumed or cancelled reservation. */
export function reservePackageRequestInTransaction(
  store: Store,
  action: BehaviorAction,
  receipt: BehaviorJournalResult,
  input: RuntimeValue,
  hostRuntime: Record<string, RuntimeValue>
): PackageRequest {
  const cached = store.db
    .prepare(
      'SELECT body FROM package_requests WHERE chat_id=? AND branch_id=? AND instance_id=? AND action_key=?'
    )
    .get(receipt.chatId, receipt.branchId, receipt.attachmentInstanceId, receipt.idempotencyKey) as
    | Row
    | undefined;
  if (cached) return JSON.parse(cached.body);
  const branch = store.product.branch(receipt.chatId, receipt.branchId),
    profile = store.product.profile(receipt.chatId);
  const source = branch.headRevision ? store.source(branch.headRevision) : null;
  const dependencies = sourceDependencies(store, branch.headRevision);
  if (hostRuntime.sourceDependenciesHash !== behaviorPayloadHash(dependencies))
    reject('PACKAGE_REQUEST_SOURCE_CAPTURE_MISMATCH');
  const value: PackageRequest = {
    id: randomUUID(),
    chatId: receipt.chatId,
    branchId: receipt.branchId,
    instanceId: receipt.attachmentInstanceId,
    actionId: action.id,
    actionKey: receipt.idempotencyKey,
    request: projectPackageRequest(action, receipt, input, hostRuntime),
    label: action.label || action.id,
    profileRevision: profile.revision,
    sourceRevision: source?.id ?? null,
    sourceHash: source?.hash ?? null,
    stateRevision: receipt.stateRevision,
  };
  const replaced = store.db
    .prepare("SELECT id FROM package_requests WHERE chat_id=? AND branch_id=? AND status='pending'")
    .all(value.chatId, value.branchId) as { id: string }[];
  store.db
    .prepare(
      "UPDATE package_requests SET status='cancelled' WHERE chat_id=? AND branch_id=? AND status='pending'"
    )
    .run(value.chatId, value.branchId);
  for (const prior of replaced) store.event(value.chatId, 'package.request.cancelled', prior.id);
  store.db
    .prepare("INSERT INTO package_requests VALUES(?,?,?,?,?,?,?,'pending',NULL)")
    .run(
      value.id,
      value.chatId,
      value.branchId,
      value.instanceId,
      value.actionKey,
      JSON.stringify(value),
      JSON.stringify(dependencies)
    );
  store.event(value.chatId, 'package.request.reserved', value.id);
  return value;
}
function current(store: Store, row: Row): boolean {
  const value = JSON.parse(row.body) as PackageRequest,
    branch = store.product.branch(value.chatId, value.branchId),
    profile = store.product.snapshot(value.chatId);
  if (
    !profile ||
    profile.revision !== value.profileRevision ||
    branch.headRevision !== value.sourceRevision ||
    (branch.headRevision ? store.source(branch.headRevision).hash : null) !== value.sourceHash
  )
    return false;
  if (
    !isDeepStrictEqual(sourceDependencies(store, branch.headRevision), JSON.parse(row.dependencies))
  )
    return false;
  const ref = profile.packageAttachments?.find(
    (ref) => packageInstanceId(ref) === value.instanceId
  );
  const pkg =
    ref && profile.packages?.find((pkg) => pkg.id === ref.id && pkg.revision === ref.revision);
  if (!ref || !pkg?.behavior) return false;
  try {
    const state = store.behavior.read(
      {
        chatId: value.chatId,
        branchId: value.branchId,
        attachmentInstanceId: value.instanceId,
        packageId: ref.id,
        packageRevision: ref.revision,
        behaviorRevision: pkg.behavior.revision,
        schemaVersion: pkg.behavior.schemaVersion,
      },
      pkg.behavior
    );
    return state.stateRevision === value.stateRevision;
  } catch {
    return false;
  }
}
/** Read-only: stale reservations disappear from the projection without changing durable receipts. */
export function pendingPackageRequest(
  store: Store,
  chatId: string,
  branchId?: string
): PackageRequest | null {
  const branch = store.product.branch(chatId, branchId);
  const row = store.db
    .prepare("SELECT * FROM package_requests WHERE chat_id=? AND branch_id=? AND status='pending'")
    .get(chatId, branch.id) as Row | undefined;
  return row && current(store, row) ? JSON.parse(row.body) : null;
}
/** Call after the Run row is inserted, inside its admission transaction. Failed admission rolls this back. */
export function consumePackageRequestInTransaction(
  store: Store,
  chatId: string,
  branchId: string,
  id: string,
  request: string,
  runId: string
): PackageRequest {
  const row = store.db
    .prepare('SELECT * FROM package_requests WHERE id=? AND chat_id=? AND branch_id=?')
    .get(id, chatId, branchId) as Row | undefined;
  if (!row || row.status !== 'pending' || !current(store, row)) reject('PACKAGE_REQUEST_STALE');
  const value = JSON.parse(row!.body) as PackageRequest;
  if (value.request !== request) reject('PACKAGE_REQUEST_TEXT_MISMATCH');
  const changed = store.db
    .prepare(
      "UPDATE package_requests SET status='consumed',consumed_run_id=? WHERE id=? AND status='pending'"
    )
    .run(runId, id);
  if (Number(changed.changes) !== 1) reject('PACKAGE_REQUEST_ALREADY_CONSUMED');
  store.event(chatId, 'package.request.consumed', id);
  return value;
}
export function cancelPackageRequest(
  store: Store,
  chatId: string,
  branchId: string | undefined,
  id: string
) {
  return store.transaction(() => {
    const branch = store.product.branch(chatId, branchId);
    const row = store.db
      .prepare('SELECT status FROM package_requests WHERE id=? AND chat_id=? AND branch_id=?')
      .get(id, chatId, branch.id) as Row | undefined;
    if (!row) throw new HttpError(404, 'PACKAGE_REQUEST_NOT_FOUND');
    if (row.status === 'consumed') reject('PACKAGE_REQUEST_ALREADY_CONSUMED');
    const changed = store.db
      .prepare("UPDATE package_requests SET status='cancelled' WHERE id=? AND status='pending'")
      .run(id);
    if (Number(changed.changes)) store.event(chatId, 'package.request.cancelled', id);
    return { cancelled: true };
  });
}
/** Validate durable command provenance even when a later edit makes its live projection stale. */
export function validatePackageRequests(store: Store) {
  const invalid = (): never => {
    throw new HttpError(400, 'PACKAGE_REQUEST_ARCHIVE_INVALID');
  };
  const byId = new Map<string, Row>(),
    byAction = new Map<string, Row>();
  const actionKey = (chatId: string, branchId: string, instanceId: string, key: string) =>
    JSON.stringify([chatId, branchId, instanceId, key]);
  for (const row of store.db.prepare('SELECT * FROM package_requests').all() as Row[]) {
    const value = JSON.parse(row.body) as PackageRequest;
    const keys = [
      'id',
      'chatId',
      'branchId',
      'instanceId',
      'actionId',
      'actionKey',
      'request',
      'label',
      'profileRevision',
      'sourceRevision',
      'sourceHash',
      'stateRevision',
    ];
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      Object.keys(value).some((key) => !keys.includes(key))
    )
      invalid();
    if (
      value.id !== row.id ||
      value.chatId !== row.chat_id ||
      value.branchId !== row.branch_id ||
      value.instanceId !== row.instance_id ||
      value.actionKey !== row.action_key
    )
      invalid();
    for (const text of [
      value.id,
      value.chatId,
      value.branchId,
      value.instanceId,
      value.actionId,
      value.actionKey,
    ])
      if (typeof text !== 'string' || !text || text.length > 200) invalid();
    if (
      !Number.isSafeInteger(value.profileRevision) ||
      value.profileRevision < 1 ||
      !Number.isSafeInteger(value.stateRevision) ||
      value.stateRevision < 1
    )
      invalid();
    store.product.branch(value.chatId, value.branchId);
    if (value.sourceRevision !== null && store.source(value.sourceRevision).chatId !== value.chatId)
      invalid();
    if (
      (value.sourceRevision === null) !== (value.sourceHash === null) ||
      (value.sourceHash !== null && !/^[a-f0-9]{64}$/u.test(value.sourceHash))
    )
      invalid();
    const deps = JSON.parse(row.dependencies) as { id: string; hash: string }[];
    const ancestry = store.history(value.sourceRevision);
    if (
      !Array.isArray(deps) ||
      deps.length !== ancestry.length ||
      deps.some(
        (dep, index) =>
          !dep ||
          Object.keys(dep).length !== 2 ||
          dep.id !== ancestry[index].revision ||
          !/^[a-f0-9]{64}$/u.test(dep.hash)
      )
    )
      invalid();
    if (deps.length && deps.at(-1)!.hash !== value.sourceHash) invalid();
    for (const dep of deps)
      if (store.sourceAtHash(dep.id, dep.hash).chatId !== value.chatId) invalid();
    const journal = store.db
      .prepare(
        'SELECT payload,result FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND idempotency_key=?'
      )
      .get(value.chatId, value.branchId, value.instanceId, value.actionKey) as Row | undefined;
    if (!journal) invalid();
    const payload = JSON.parse(journal!.payload),
      receipt = JSON.parse(journal!.result) as BehaviorJournalResult;
    const content = store.product.get<Content>(
        'content',
        receipt.packageId,
        receipt.packageRevision
      ),
      behavior = content.package?.behavior;
    const action = behavior?.actions.find((action) => action.id === value.actionId);
    if (
      !action ||
      payload.actionId !== value.actionId ||
      receipt.provenance !== 'ui-action' ||
      receipt.stateRevision !== value.stateRevision ||
      receipt.sourceHash !== value.sourceHash ||
      payload.hostRuntime?.profile?.revision !== value.profileRevision ||
      payload.hostRuntime?.chat?.id !== value.chatId ||
      payload.hostRuntime?.chat?.branchId !== value.branchId ||
      payload.hostRuntime?.chat?.parentRevision !== value.sourceRevision ||
      payload.hostRuntime?.sourceDependenciesHash !== behaviorPayloadHash(deps)
    )
      invalid();
    if (
      projectPackageRequest(action!, receipt, payload.input, payload.hostRuntime) !==
        value.request ||
      value.label !== (action!.label || action!.id)
    )
      invalid();
    if (
      !['pending', 'consumed', 'cancelled'].includes(row.status) ||
      (row.status === 'consumed') !== (row.consumed_run_id !== null)
    )
      invalid();
    const events = store.db
      .prepare(
        "SELECT kind FROM events WHERE chat_id=? AND entity_id=? AND kind IN ('package.request.reserved','package.request.consumed','package.request.cancelled') ORDER BY seq"
      )
      .all(value.chatId, value.id) as { kind: string }[];
    if (
      !isDeepStrictEqual(
        events.map((event) => event.kind),
        [
          'package.request.reserved',
          ...(row.status === 'pending' ? [] : [`package.request.${row.status}`]),
        ]
      )
    )
      invalid();
    byId.set(value.id, row);
    byAction.set(actionKey(value.chatId, value.branchId, value.instanceId, value.actionKey), row);
    if (row.consumed_run_id !== null) {
      const run = store.run(row.consumed_run_id);
      if (
        run.chatId !== value.chatId ||
        run.snapshot.branchId !== value.branchId ||
        run.request !== value.request ||
        run.parentRevision !== value.sourceRevision ||
        run.snapshot.profile?.revision !== value.profileRevision
      )
        invalid();
      const command = store.db.prepare('SELECT command FROM runs WHERE id=?').get(run.id) as {
        command: string;
      };
      if (JSON.parse(command.command).packageRequestId !== value.id) invalid();
    }
  }
  // Validate both directions: omitting a receipt must not erase consumption or an accepted user action.
  for (const run of store.db.prepare('SELECT id,command FROM runs').all() as Row[]) {
    const command = JSON.parse(run.command);
    if (!Object.hasOwn(command, 'packageRequestId')) continue;
    const receipt = byId.get(command.packageRequestId);
    if (!receipt || receipt.status !== 'consumed' || receipt.consumed_run_id !== run.id) invalid();
  }
  for (const journal of store.db
    .prepare(
      "SELECT payload,result FROM package_behavior_journal WHERE json_extract(result,'$.provenance')='ui-action'"
    )
    .all() as Row[]) {
    const payload = JSON.parse(journal.payload),
      receipt = JSON.parse(journal.result) as BehaviorJournalResult;
    const content = store.product.get<Content>(
      'content',
      receipt.packageId,
      receipt.packageRevision
    );
    const action = content.package?.behavior?.actions.find(
      (action) => action.id === payload.actionId
    );
    if (
      action?.nextRequest !== undefined &&
      !byAction.has(
        actionKey(
          receipt.chatId,
          receipt.branchId,
          receipt.attachmentInstanceId,
          receipt.idempotencyKey
        )
      )
    )
      invalid();
  }
}
