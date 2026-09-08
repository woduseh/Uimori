import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { evaluatePromptExpressions, type RuntimeValue } from '../core/prompt-program.js';
import { inspectRuntimeValue } from '../core/prompt-values.js';
import {
  BehaviorError,
  applyBehaviorEffects,
  behaviorActionAllowed,
  behaviorActionTriggers,
  evaluateBehaviorAction,
  parseBehaviorOutput,
  validatePackageBehavior,
  type PackageBehavior,
  type BehaviorDraw,
} from '../core/package-behavior.js';
import type { RunBehaviorEntry } from './package-behavior-run.js';

export interface BehaviorScope {
  chatId: string;
  branchId: string;
  attachmentInstanceId: string;
  packageId: string;
  packageRevision: number;
  behaviorRevision: number;
  schemaVersion: number;
}
export interface BehaviorState extends BehaviorScope {
  stateRevision: number;
  state: RuntimeValue;
}
export interface BehaviorActionCommand {
  actionId: string;
  input: RuntimeValue;
  expectedStateRevision: number;
  expectedSourceHash: string | null;
  idempotencyKey: string;
}
export interface BehaviorOutputCommand {
  parserId: string;
  text: string;
  baseStateRevision: number;
  sourceHash: string;
  idempotencyKey: string;
}
export interface BehaviorOutputGroupCommand {
  parserIds: string[];
  text: string;
  baseStateRevision: number;
  sourceHash: string;
  idempotencyKey: string;
}
export interface BehaviorJournalResult extends BehaviorState {
  beforeStateRevision: number;
  beforeState: RuntimeValue;
  provenance: 'ui-action' | 'before-turn' | 'model-tool' | 'local-output-parser' | 'explicit-reset';
  idempotencyKey: string;
  sourceHash: string | null;
  draws: Record<string, RuntimeValue>;
  drawSeed: string | null;
  actionResult?: RuntimeValue;
}
const conflict = (s: string): never => {
  throw new BehaviorError(409, s);
};
const bad = (s: string): never => {
  throw new BehaviorError(400, s);
};
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}
const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');
export const behaviorPayloadHash = hash;
function checkScope(s: BehaviorScope, b: PackageBehavior) {
  for (const text of [s.chatId, s.branchId, s.attachmentInstanceId, s.packageId])
    if (typeof text !== 'string' || !text.length || text.length > 200) bad('BEHAVIOR_SCOPE');
  for (const v of [s.packageRevision, s.behaviorRevision, s.schemaVersion])
    if (!Number.isSafeInteger(v) || v < 1) bad('BEHAVIOR_SCOPE_REVISION');
  if (s.behaviorRevision !== b.revision || s.schemaVersion !== b.schemaVersion)
    conflict('BEHAVIOR_SCOPE_VERSION');
}
/** No provider calls or source mutation. Public mutations own a transaction; *InTransaction joins a host transaction. */
export class PackageBehaviorStore {
  constructor(
    readonly db: DatabaseSync,
    readonly resolveSourceHash: (chatId: string, branchId: string) => string | null
  ) {}
  init() {
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS package_behavior_states(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,instance_id TEXT NOT NULL,scope TEXT NOT NULL,definition_hash TEXT NOT NULL,state_revision INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,instance_id));
    CREATE TABLE IF NOT EXISTS package_behavior_journal(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,instance_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,instance_id,idempotency_key));
  `);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private row(s: BehaviorScope) {
    return this.db
      .prepare(
        'SELECT * FROM package_behavior_states WHERE chat_id=? AND branch_id=? AND instance_id=?'
      )
      .get(s.chatId, s.branchId, s.attachmentInstanceId) as Record<string, any> | undefined;
  }
  storedState(scope: BehaviorScope): BehaviorState | undefined {
    const row = this.row(scope);
    if (!row) return undefined;
    const stored = JSON.parse(row.scope) as BehaviorScope;
    if (
      stored.chatId !== scope.chatId ||
      stored.branchId !== scope.branchId ||
      stored.attachmentInstanceId !== scope.attachmentInstanceId ||
      stored.packageId !== scope.packageId
    )
      conflict('BEHAVIOR_SCOPE_VERSION');
    return { ...stored, stateRevision: Number(row.state_revision), state: JSON.parse(row.state) };
  }
  read(scope: BehaviorScope, definition: PackageBehavior): BehaviorState {
    const b = validatePackageBehavior(definition);
    checkScope(scope, b);
    const row = this.row(scope);
    if (!row) return { ...scope, stateRevision: 0, state: structuredClone(b.initialState) };
    const stored = this.storedState(scope)!;
    if (
      stored.behaviorRevision !== scope.behaviorRevision ||
      stored.schemaVersion !== scope.schemaVersion ||
      row.definition_hash !== hash(b)
    )
      conflict('BEHAVIOR_MIGRATION_REQUIRED');
    checkScope(stored, b);
    return { ...scope, stateRevision: Number(row.state_revision), state: JSON.parse(row.state) };
  }
  ensure(scope: BehaviorScope, b: PackageBehavior) {
    return this.tx(() => this.ensureInTransaction(scope, b));
  }
  ensureInTransaction(scope: BehaviorScope, b: PackageBehavior): BehaviorState {
    const state = this.read(scope, b);
    if (!this.row(scope))
      this.db
        .prepare('INSERT INTO package_behavior_states VALUES(?,?,?,?,?,?,?)')
        .run(
          scope.chatId,
          scope.branchId,
          scope.attachmentInstanceId,
          JSON.stringify(scope),
          hash(validatePackageBehavior(b)),
          0,
          JSON.stringify(state.state)
        );
    // Only the live definition reference advances. Historical journal receipts stay frozen.
    else
      this.db
        .prepare(
          'UPDATE package_behavior_states SET scope=? WHERE chat_id=? AND branch_id=? AND instance_id=? AND scope<>?'
        )
        .run(
          JSON.stringify(scope),
          scope.chatId,
          scope.branchId,
          scope.attachmentInstanceId,
          JSON.stringify(scope)
        );
    return state;
  }
  preview(
    scope: BehaviorScope,
    b: PackageBehavior,
    command: Pick<BehaviorActionCommand, 'actionId' | 'input'>,
    hostRuntime: Record<string, RuntimeValue> = {}
  ) {
    inspectRuntimeValue(hostRuntime);
    const state = this.read(scope, b),
      action = b.actions.find((a) => a.id === command.actionId);
    if (!action) bad('BEHAVIOR_ACTION_UNKNOWN');
    const allowed = behaviorActionAllowed(action!, state.state, command.input, hostRuntime);
    return {
      ...state,
      allowed,
      requiresDraw: !!action!.draws?.length,
      ...(allowed && !action!.draws?.length
        ? {
            projectedState: applyBehaviorEffects(
              b,
              state.state,
              command.input,
              {},
              action!.effects,
              hostRuntime
            ),
          }
        : {}),
    };
  }
  execute(
    scope: BehaviorScope,
    b: PackageBehavior,
    command: BehaviorActionCommand,
    hostRuntime: Record<string, RuntimeValue> = {}
  ) {
    return this.tx(() => this.executeInTransaction(scope, b, command, hostRuntime));
  }
  reset(
    scope: BehaviorScope,
    b: PackageBehavior,
    command: Pick<
      BehaviorActionCommand,
      'expectedStateRevision' | 'expectedSourceHash' | 'idempotencyKey'
    >
  ) {
    return this.tx(() => this.resetInTransaction(scope, b, command));
  }
  resetInTransaction(
    scope: BehaviorScope,
    definition: PackageBehavior,
    command: Pick<
      BehaviorActionCommand,
      'expectedStateRevision' | 'expectedSourceHash' | 'idempotencyKey'
    >
  ): BehaviorJournalResult {
    const b = validatePackageBehavior(definition);
    checkScope(scope, b);
    const prior = this.storedState(scope);
    const payload = {
        scope,
        provenance: 'explicit-reset',
        ...command,
        ...(prior
          ? {
              previousScope: Object.fromEntries(
                Object.keys(scope).map((key) => [key, prior[key as keyof BehaviorScope]])
              ),
            }
          : {}),
      },
      cached = this.cached(scope, command.idempotencyKey, payload);
    if (cached) return cached;
    const state = prior ?? this.read(scope, b);
    this.expect(state, command.expectedStateRevision, command.expectedSourceHash);
    if (prior)
      this.db
        .prepare(
          'UPDATE package_behavior_states SET scope=?,definition_hash=? WHERE chat_id=? AND branch_id=? AND instance_id=?'
        )
        .run(
          JSON.stringify(scope),
          hash(b),
          scope.chatId,
          scope.branchId,
          scope.attachmentInstanceId
        );
    return this.commit(
      scope,
      b,
      state,
      b.initialState,
      command.idempotencyKey,
      payload,
      'explicit-reset',
      command.expectedSourceHash,
      {},
      null
    );
  }
  executeInTransaction(
    scope: BehaviorScope,
    definition: PackageBehavior,
    command: BehaviorActionCommand,
    hostRuntime: Record<string, RuntimeValue> = {}
  ): BehaviorJournalResult {
    inspectRuntimeValue(hostRuntime);
    const b = validatePackageBehavior(definition);
    this.read(scope, b);
    const payload = { scope, provenance: 'ui-action', ...command, hostRuntime },
      cached = this.cached(scope, command.idempotencyKey, payload);
    if (cached) return cached;
    const state = this.read(scope, b);
    this.expect(state, command.expectedStateRevision, command.expectedSourceHash);
    const action = b.actions.find((a) => a.id === command.actionId);
    if (!action) bad('BEHAVIOR_ACTION_UNKNOWN');
    if (!behaviorActionTriggers(action!).includes('user'))
      conflict('BEHAVIOR_USER_ACTION_NOT_ALLOWED');
    if (!behaviorActionAllowed(action!, state.state, command.input, hostRuntime))
      conflict('BEHAVIOR_ACTION_DISABLED');
    const drawSeed = action!.draws?.length ? randomBytes(32).toString('hex') : null;
    const draws = drawSeed ? recordDraws(action!.draws!, drawSeed) : {};
    const evaluated = evaluateBehaviorAction(
      b,
      action!,
      state.state,
      command.input,
      draws,
      hostRuntime
    );
    return this.commit(
      scope,
      b,
      state,
      evaluated.state,
      command.idempotencyKey,
      payload,
      'ui-action',
      command.expectedSourceHash,
      draws,
      drawSeed,
      evaluated.result
    );
  }
  /** Only the source-completion transaction can publish a previously resolved run action. */
  commitRunActionInTransaction(
    scope: BehaviorScope,
    b: PackageBehavior,
    entry: RunBehaviorEntry,
    sourceHash: string,
    idempotencyKey: string
  ): BehaviorJournalResult {
    const state = this.read(scope, b);
    this.expect(state, entry.before.stateRevision, sourceHash);
    if (hash(state.state) !== hash(entry.before.state)) conflict('BEHAVIOR_STATE_STALE');
    const action = b.actions.find((a) => a.id === entry.actionId);
    if (!action) throw new BehaviorError(409, 'BEHAVIOR_TRIGGER_NOT_ALLOWED');
    if (!behaviorActionTriggers(action).includes(entry.trigger))
      conflict('BEHAVIOR_TRIGGER_NOT_ALLOWED');
    if (action.draws?.length) {
      if (!entry.drawSeed || hash(recordDraws(action.draws, entry.drawSeed)) !== hash(entry.draws))
        conflict('BEHAVIOR_DRAW_MISMATCH');
    } else if (entry.drawSeed !== null || Object.keys(entry.draws).length)
      conflict('BEHAVIOR_DRAW_MISMATCH');
    const evaluated = evaluateBehaviorAction(
      b,
      action,
      state.state,
      entry.input,
      entry.draws,
      entry.hostRuntime
    );
    if (
      hash(evaluated.state) !== hash(entry.after.state) ||
      hash(evaluated.result) !== hash(entry.result)
    )
      conflict('BEHAVIOR_RESULT_MISMATCH');
    const provenance = entry.trigger === 'before-turn' ? 'before-turn' : 'model-tool';
    const payload = {
      scope,
      provenance,
      actionId: entry.actionId,
      input: entry.input,
      expectedStateRevision: entry.before.stateRevision,
      expectedSourceHash: sourceHash,
      idempotencyKey,
      hostRuntime: entry.hostRuntime,
    };
    return this.commit(
      scope,
      b,
      state,
      evaluated.state,
      idempotencyKey,
      payload,
      provenance,
      sourceHash,
      entry.draws,
      entry.drawSeed,
      evaluated.result
    );
  }
  applyOutput(
    scope: BehaviorScope,
    b: PackageBehavior,
    command: BehaviorOutputCommand,
    hostRuntime: Record<string, RuntimeValue> = {}
  ) {
    return this.tx(() => this.applyOutputInTransaction(scope, b, command, hostRuntime));
  }
  applyOutputInTransaction(
    scope: BehaviorScope,
    b: PackageBehavior,
    command: BehaviorOutputCommand,
    hostRuntime: Record<string, RuntimeValue> = {}
  ) {
    const { parserId, ...rest } = command;
    return this.applyOutputsInTransaction(
      scope,
      b,
      { ...rest, parserIds: [parserId] },
      hostRuntime
    );
  }
  applyOutputs(
    scope: BehaviorScope,
    b: PackageBehavior,
    command: BehaviorOutputGroupCommand,
    hostRuntime: Record<string, RuntimeValue> = {}
  ) {
    return this.tx(() => this.applyOutputsInTransaction(scope, b, command, hostRuntime));
  }
  applyOutputsInTransaction(
    scope: BehaviorScope,
    definition: PackageBehavior,
    command: BehaviorOutputGroupCommand,
    hostRuntime: Record<string, RuntimeValue> = {}
  ): BehaviorJournalResult {
    inspectRuntimeValue(hostRuntime);
    const b = validatePackageBehavior(definition);
    this.read(scope, b);
    const payload = { scope, provenance: 'local-output-parser', ...command, hostRuntime },
      cached = this.cached(scope, command.idempotencyKey, payload);
    if (cached) return cached;
    const state = this.read(scope, b);
    this.expect(state, command.baseStateRevision, command.sourceHash);
    if (
      !Array.isArray(command.parserIds) ||
      !command.parserIds.length ||
      new Set(command.parserIds).size !== command.parserIds.length
    )
      bad('BEHAVIOR_PARSER_IDS');
    const selected = command.parserIds.map((id) => {
      const parser = b.outputParsers.find((p) => p.id === id);
      if (!parser) bad('BEHAVIOR_PARSER_UNKNOWN');
      return parser!;
    });
    const paths = selected.flatMap((p) => p.fields.map((f) => f.path.join('/')));
    for (let i = 0; i < paths.length; i++)
      for (let j = i + 1; j < paths.length; j++)
        if (
          paths[i] === paths[j] ||
          paths[i].startsWith(paths[j] + '/') ||
          paths[j].startsWith(paths[i] + '/')
        )
          bad('BEHAVIOR_OVERLAPPING_PARSERS');
    let next = state.state;
    const allowed = evaluatePromptExpressions(
      selected.map((parser) => parser.when ?? true),
      {},
      { runtime: { ...hostRuntime, state: state.state, input: {}, draws: {} } }
    );
    for (const [index, parser] of selected.entries()) {
      if (typeof allowed[index] !== 'boolean') bad('BEHAVIOR_CONDITION_NOT_BOOLEAN');
      if (!allowed[index]) continue;
      next = parseBehaviorOutput(b, parser, next, command.text);
    }
    return this.commit(
      scope,
      b,
      state,
      next,
      command.idempotencyKey,
      payload,
      'local-output-parser',
      command.sourceHash,
      {},
      null
    );
  }
  private expect(state: BehaviorState, revision: number, sourceHash: string | null) {
    if (!Number.isSafeInteger(revision) || revision < 0) bad('BEHAVIOR_STATE_REVISION');
    if (
      sourceHash !== null &&
      (typeof sourceHash !== 'string' || !sourceHash.length || sourceHash.length > 200)
    )
      bad('BEHAVIOR_SOURCE_HASH');
    if (state.stateRevision !== revision) conflict('BEHAVIOR_STATE_STALE');
    if (this.resolveSourceHash(state.chatId, state.branchId) !== sourceHash)
      conflict('BEHAVIOR_SOURCE_STALE');
  }
  private cached(
    scope: BehaviorScope,
    key: string,
    payload: unknown
  ): BehaviorJournalResult | undefined {
    if (typeof key !== 'string' || !key.length || key.length > 200) bad('BEHAVIOR_IDEMPOTENCY_KEY');
    const row = this.db
      .prepare(
        'SELECT payload_hash,payload,result FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND idempotency_key=?'
      )
      .get(scope.chatId, scope.branchId, scope.attachmentInstanceId, key) as
      | Record<string, any>
      | undefined;
    if (!row) return undefined;
    // Host time/history/options may advance after success. The replay identity is
    // the user's command; a retry uses the originally captured host projection.
    const captured = JSON.parse(row.payload),
      candidate = { ...(payload as Record<string, unknown>) };
    if (Object.hasOwn(captured, 'hostRuntime')) candidate.hostRuntime = captured.hostRuntime;
    if (captured.provenance === 'explicit-reset') {
      delete candidate.previousScope;
      if (Object.hasOwn(captured, 'previousScope'))
        candidate.previousScope = captured.previousScope;
    }
    if (row.payload_hash !== hash(candidate)) conflict('BEHAVIOR_IDEMPOTENCY_CONFLICT');
    return JSON.parse(row.result);
  }
  private commit(
    scope: BehaviorScope,
    b: PackageBehavior,
    before: BehaviorState,
    next: RuntimeValue,
    key: string,
    payload: unknown,
    provenance: BehaviorJournalResult['provenance'],
    sourceHash: string | null,
    draws: Record<string, RuntimeValue>,
    drawSeed: string | null,
    actionResult?: RuntimeValue
  ): BehaviorJournalResult {
    this.ensureInTransaction(scope, b);
    const result: BehaviorJournalResult = {
      ...scope,
      stateRevision: before.stateRevision + 1,
      state: next,
      beforeStateRevision: before.stateRevision,
      beforeState: before.state,
      provenance,
      idempotencyKey: key,
      sourceHash,
      draws,
      drawSeed,
      ...(actionResult !== undefined ? { actionResult } : {}),
    };
    const changed = this.db
      .prepare(
        'UPDATE package_behavior_states SET state_revision=?,state=? WHERE chat_id=? AND branch_id=? AND instance_id=? AND state_revision=?'
      )
      .run(
        result.stateRevision,
        JSON.stringify(next),
        scope.chatId,
        scope.branchId,
        scope.attachmentInstanceId,
        before.stateRevision
      );
    if (Number(changed.changes) !== 1) conflict('BEHAVIOR_STATE_STALE');
    this.db
      .prepare('INSERT INTO package_behavior_journal VALUES(?,?,?,?,?,?,?,?)')
      .run(
        scope.chatId,
        scope.branchId,
        scope.attachmentInstanceId,
        key,
        hash(payload),
        JSON.stringify(payload),
        JSON.stringify(result),
        new Date().toISOString()
      );
    return result;
  }
  journal(scope: BehaviorScope): BehaviorJournalResult[] {
    return (
      this.db
        .prepare(
          'SELECT result FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? ORDER BY rowid'
        )
        .all(scope.chatId, scope.branchId, scope.attachmentInstanceId) as Record<string, any>[]
    ).map((r) => JSON.parse(r.result));
  }
  cloneBranchInTransaction(
    fromChatId: string,
    fromBranchId: string,
    toChatId: string,
    toBranchId: string
  ) {
    const rows = this.db
      .prepare('SELECT * FROM package_behavior_states WHERE chat_id=? AND branch_id=?')
      .all(fromChatId, fromBranchId) as Record<string, any>[];
    for (const row of rows) {
      const scope = { ...JSON.parse(row.scope), chatId: toChatId, branchId: toBranchId };
      this.db
        .prepare('INSERT INTO package_behavior_states VALUES(?,?,?,?,?,?,?)')
        .run(
          toChatId,
          toBranchId,
          row.instance_id,
          JSON.stringify(scope),
          row.definition_hash,
          row.state_revision,
          row.state
        );
    }
  }
  /** Version changes are intentionally explicit errors until a validated migration/reset flow is supplied. */
  migrate(): never {
    return conflict('BEHAVIOR_MIGRATION_NOT_IMPLEMENTED');
  }
}
/** Host-owned seed and results are journaled; repeated execution reads the journal, never redraws. */
export function recordDraws(draws: BehaviorDraw[], seed: string): Record<string, RuntimeValue> {
  let counter = 0;
  const next = (max: number) => {
    const range = 0x1_0000_0000,
      limit = range - (range % max);
    let value: number;
    do {
      value = createHash('sha256')
        .update(seed + ':' + counter++)
        .digest()
        .readUInt32BE(0);
    } while (value >= limit);
    return value % max;
  };
  const result: Record<string, RuntimeValue> = {};
  for (const draw of draws) {
    if (draw.type === 'integer') result[draw.id] = draw.min + next(draw.max - draw.min + 1);
    else if (draw.type === 'choice')
      result[draw.id] = structuredClone(draw.values[next(draw.values.length)]);
    else {
      const values = structuredClone(draw.values);
      for (let i = values.length - 1; i > 0; i--) {
        const j = next(i + 1);
        [values[i], values[j]] = [values[j], values[i]];
      }
      result[draw.id] = values;
    }
  }
  return result;
}
