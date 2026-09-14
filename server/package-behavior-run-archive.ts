import { historicalPersonaExcluded } from '../core/persona-scope.js';
import { HttpError } from './request-validation.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  BehaviorError,
  behaviorActionAllowed,
  behaviorActionTriggers,
  behaviorEditResultMessages,
  behaviorEditResultText,
  behaviorHookBeforeRequest,
  behaviorHookOrder,
  behaviorRecord,
  evaluateBehaviorAction,
  validateBehaviorValue,
  validatePackageBehavior,
} from '../core/package-behavior.js';
import { EXTENSION_PROGRAM_MAX_EDIT_RESULT_CHARS } from '../core/extension-program.js';
import {
  extensionEditHookInput,
  extensionEditRequestInput,
  requestEditMessages,
} from './extension-request-edit.js';
import type {
  AfterResponseEntry,
  AfterResponsePackage,
  AfterResponseProgress,
} from '../core/after-response.js';
import { projectBehaviorOutputs } from '../core/behavior-output.js';
import { inspectRuntimeValue } from '../core/prompt-values.js';
import { executionContext, type PackageExecutionState } from '../core/execution-context.js';
import type { RunSnapshot } from '../core/types.js';
import { behaviorPayloadHash, recordDraws } from './package-behavior-store.js';
import { validateExtensionProgramReceipt } from './extension-program-receipt.js';
import type {
  OpportunityEntropy,
  RunBehaviorEntry,
  RunBehaviorProgress,
} from './package-behavior-run.js';
import { preparedBehaviorSnapshot } from './package-behavior-run.js';
import type { Run, Store } from './store.js';
import { validateChatVariableState } from '../core/chat-variables.js';
import {
  profileWithExtensionVariables,
  projectExtensionVariableMutation,
  variableStateFromProfile,
  validateExtensionVariablePermission,
} from './extension-variables.js';
import { resolveTemplateVariableContext } from '../core/template-variables.js';
import type { PackageAttachment } from '../core/content-package.js';
import type { ExtensionProgram } from '../core/extension-program.js';
import {
  resolveExtensionConversation,
  extensionConversationViewHash,
} from './extension-conversation.js';
import { validateExtensionConversationPermission } from './extension-conversation-access.js';

function validateConversationReceipt(
  store: Store,
  snapshot: RunSnapshot,
  ref: PackageAttachment,
  program: ExtensionProgram,
  receipt: { viewHash: string },
  response?: string,
  includeRequest = true
): void {
  const view = resolveExtensionConversation(store, snapshot, snapshot.extensionConversation, {
    ...(includeRequest ? { request: snapshot.request } : {}),
    ...(response !== undefined ? { response } : {}),
  });
  validateExtensionConversationPermission(
    receipt,
    snapshot.profile,
    ref,
    program,
    extensionConversationViewHash(view)
  );
}

export const packageBehaviorRunTables = [
  'package_behavior_entropy',
  'package_behavior_opportunities',
  'package_behavior_runs',
];
type Row = Record<string, any>;
type AutomaticPreparation = NonNullable<RunBehaviorProgress['preparation']>;
type CheckState = (
  value: unknown,
  chatId: string,
  branchId: string,
  profile?: RunSnapshot['profile']
) => PackageExecutionState;
function reject(message: string): never {
  throw new HttpError(400, `Invalid run behavior archive: ${message}`);
}
function object(value: unknown, fields: string[], optional: string[] = []): Row {
  const record = behaviorRecord(value);
  if (
    Object.keys(record).some((key) => !fields.includes(key) && !optional.includes(key)) ||
    fields.some((key) => !Object.hasOwn(record, key))
  )
    reject('fields');
  return record;
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) reject('hash');
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 200) reject('identity');
}
function list(value: unknown, max = 100): asserts value is any[] {
  if (!Array.isArray(value) || value.length > max) reject('list');
}
function count(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) reject('count');
}
const same = (a: unknown, b: unknown, message: string) => {
  if (!isDeepStrictEqual(a, b)) reject(message);
};
function body(row: Row): Row {
  if (typeof row.body !== 'string' || row.body.length > 4_000_000) reject('body size');
  return behaviorRecord(JSON.parse(row.body));
}
const key = (entry: Pick<RunBehaviorEntry, 'instanceId' | 'actionId'>) =>
  JSON.stringify([entry.instanceId, entry.actionId]);

function afterFailureCode(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    !/^BEHAVIOR_(?:AFTER_RESPONSE|HOST|PROGRAM)_[A-Z0-9_]+$/u.test(value)
  )
    reject('after-response failure code');
}

function preparation(value: unknown, total: number): AutomaticPreparation {
  const receipt = object(value, ['status', 'completed', 'total'], ['code', 'skipKey']);
  if (!['pending', 'running', 'ready', 'failed', 'skipped'].includes(receipt.status))
    reject('preparation status');
  count(receipt.completed, 0, total);
  count(receipt.total, 1, 100);
  if (receipt.total !== total) reject('preparation total');
  const hasCode = Object.hasOwn(receipt, 'code');
  const hasSkipKey = Object.hasOwn(receipt, 'skipKey');
  switch (receipt.status) {
    case 'pending':
      if (receipt.completed !== 0 || hasCode || hasSkipKey) reject('pending preparation');
      break;
    case 'running':
      if (receipt.completed >= total || hasCode || hasSkipKey) reject('running preparation');
      break;
    case 'ready':
      if (receipt.completed !== total || hasCode || hasSkipKey) reject('ready preparation');
      break;
    case 'failed':
      if (
        receipt.completed >= total ||
        !hasCode ||
        typeof receipt.code !== 'string' ||
        receipt.code.length > 200 ||
        !/^(BEHAVIOR|PROMPT)_[A-Z0-9_]+$/u.test(receipt.code) ||
        hasSkipKey
      )
        reject('failed preparation');
      break;
    case 'skipped':
      if (
        receipt.completed >= total ||
        receipt.code !== 'BEHAVIOR_PREPARATION_SKIPPED' ||
        !hasSkipKey
      )
        reject('skipped preparation');
      text(receipt.skipKey);
      break;
  }
  return receipt as AutomaticPreparation;
}

function validateAfterResponseProgress(
  store: Store,
  run: Run,
  snapshot: RunSnapshot,
  progress: RunBehaviorProgress,
  value: unknown,
  checkState: CheckState
): AfterResponseProgress {
  const receipt = object(
    value,
    ['version', 'sourceHash', 'status', 'completed', 'total', 'packages'],
    ['skipKey']
  );
  if (receipt.version !== 1) reject('after-response version');
  digest(receipt.sourceHash);
  if (!['running', 'completed', 'skipped'].includes(receipt.status))
    reject('after-response status');
  if (receipt.status === 'skipped') {
    text(receipt.skipKey);
    if (receipt.skipKey.length > 200) reject('after-response skip key');
  } else if (Object.hasOwn(receipt, 'skipKey')) reject('after-response skip key');
  list(receipt.packages);

  const branchId = snapshot.branchId ?? `main:${run.chatId}`;
  const effectiveSnapshot = preparedBehaviorSnapshot(store, run.id, snapshot);
  const definitions = (effectiveSnapshot.profile?.packageAttachments ?? []).flatMap((ref) => {
    const instanceId = `${ref.id}:${ref.role}`;
    if (
      historicalPersonaExcluded(effectiveSnapshot.profile, ref.role) ||
      effectiveSnapshot.packageBehaviorUnavailable?.some((item) => item.instanceId === instanceId)
    )
      return [];
    const pkg = effectiveSnapshot.profile?.packages?.find(
      (candidate) => candidate.id === ref.id && candidate.revision === ref.revision
    );
    if (!pkg?.behavior) return [];
    const behavior = validatePackageBehavior(pkg.behavior);
    const state = progress.states.find((candidate) => candidate.instanceId === instanceId);
    return state ? [{ ref, instanceId, behavior, state }] : [];
  });
  const hooks = definitions
    .map((definition) => ({
      ...definition,
      actions: definition.behavior.actions.filter((action) =>
        behaviorActionTriggers(action).includes('after-turn')
      ),
    }))
    .filter((definition) => definition.actions.length);
  count(receipt.total, 1, 100);
  if (receipt.total !== hooks.length) reject('after-response total');
  count(receipt.completed, 0, receipt.total);
  if (receipt.packages.length !== receipt.completed) reject('after-response completed count');
  if (receipt.status === 'completed') {
    if (receipt.completed !== receipt.total) reject('after-response completion');
  } else if (receipt.status === 'running') {
    // The last package is persisted before the separate completion marker; a crash in between
    // leaves every package computed but still uncommitted. Preserve that interrupted receipt.
    if (run.status === 'completed') reject('after-response running');
  }

  const source = run.sourceRevision ? store.sourceOriginal(run.sourceRevision) : undefined;
  if (source) same(receipt.sourceHash, source.hash, 'after-response source');
  if (run.status === 'completed' && (!source || receipt.status === 'running'))
    reject('completed after-response');

  const projectedSnapshot: RunSnapshot = {
    ...effectiveSnapshot,
    packageStates: structuredClone(progress.states),
  };
  const parserStates = structuredClone(progress.states);
  const parserFailures = new Set<string>();
  const parserProjections = new Set<string>();
  let authoritativeParserFailure = false;
  if (source) {
    for (const definition of definitions) {
      if (!definition.behavior.outputParsers.length) {
        parserProjections.add(definition.instanceId);
        continue;
      }
      const journal = store.db
        .prepare(
          'SELECT payload FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND idempotency_key=?'
        )
        .get(run.chatId, branchId, definition.instanceId, `source:${source.id}:${source.hash}`) as
        | Row
        | undefined;
      const output = store.db
        .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=? AND instance_id=?')
        .get(source.id, definition.instanceId) as Row | undefined;
      const outputReceipt = output ? JSON.parse(output.body) : undefined;
      if (!journal) {
        if (outputReceipt?.status === 'failed') {
          parserFailures.add(definition.instanceId);
          if (definition.behavior.mode !== 'annotation') authoritativeParserFailure = true;
        }
        continue;
      }
      try {
        const payload = behaviorRecord(JSON.parse(journal.payload));
        const hostRuntime = behaviorRecord(payload.hostRuntime);
        inspectRuntimeValue(hostRuntime);
        const state = projectBehaviorOutputs(
          definition.behavior,
          definition.behavior.outputParsers.map((parser) => parser.id),
          definition.state.state,
          source.text,
          hostRuntime
        );
        const index = parserStates.findIndex(
          (candidate) => candidate.instanceId === definition.instanceId
        );
        parserStates[index] = {
          ...structuredClone(definition.state),
          state,
          stateRevision: definition.state.stateRevision + 1,
        };
        parserProjections.add(definition.instanceId);
      } catch (error) {
        if (!(error instanceof BehaviorError)) throw error;
        parserFailures.add(definition.instanceId);
        if (definition.behavior.mode !== 'annotation') authoritativeParserFailure = true;
      }
    }
  }
  // A copied fork intentionally has no cloned journal. Its receipt is an immutable origin fact;
  // use the recorded parser boundary for internal state-chain checks without reinterpreting it
  // under the new chat/source identities.
  if (snapshot.forkedFrom)
    for (const [packageIndex, rawPackage] of receipt.packages.entries()) {
      const definition = hooks[packageIndex];
      if (!definition || parserProjections.has(definition.instanceId)) continue;
      const pkg = behaviorRecord(rawPackage);
      const before = checkState(pkg.before, run.chatId, branchId, snapshot.profile);
      const index = parserStates.findIndex((state) => state.instanceId === definition.instanceId);
      parserStates[index] = before;
    }

  let variableState = progress.variableState ?? variableStateFromProfile(snapshot.profile);
  for (const [packageIndex, rawPackage] of receipt.packages.entries()) {
    const definition = hooks[packageIndex];
    if (!definition) reject('after-response package count');
    const pkg = object(
      rawPackage,
      ['instanceId', 'status', 'before', 'after', 'entries'],
      ['code']
    ) as AfterResponsePackage;
    if (pkg.instanceId !== definition.instanceId) reject('after-response package order');
    if (!['ready', 'failed'].includes(pkg.status)) reject('after-response package status');
    list(pkg.entries, definition.actions.length);
    const before = checkState(pkg.before, run.chatId, branchId, snapshot.profile);
    const after = checkState(pkg.after, run.chatId, branchId, snapshot.profile);
    if (before.instanceId !== definition.instanceId || after.instanceId !== definition.instanceId)
      reject('after-response package instance');
    if (source && parserProjections.has(definition.instanceId))
      same(
        before,
        parserStates.find((state) => state.instanceId === definition.instanceId),
        'after-response parser projection'
      );
    const parserBlocked =
      source && (authoritativeParserFailure || parserFailures.has(definition.instanceId));
    if (pkg.status === 'failed') {
      afterFailureCode(pkg.code);
      if (pkg.entries.length) reject('failed after-response entries');
      same(after, before, 'failed after-response state');
      if (
        parserBlocked &&
        ![
          'BEHAVIOR_AFTER_RESPONSE_PARSER_FAILED',
          'BEHAVIOR_AFTER_RESPONSE_BASE_UNAVAILABLE',
        ].includes(pkg.code)
      )
        reject('after-response parser failure receipt');
      continue;
    }
    if (Object.hasOwn(pkg, 'code') || parserBlocked) reject('ready after-response package');

    let current = before;
    let previousActionIndex = -1;
    for (const rawEntry of pkg.entries) {
      const entry = object(rawEntry, [
        'instanceId',
        'actionId',
        'trigger',
        'input',
        'before',
        'after',
        'result',
        'draws',
        'drawSeed',
        'hostRuntime',
        'program',
      ]) as AfterResponseEntry;
      const actionIndex = definition.actions.findIndex(
        (candidate, index) => index > previousActionIndex && candidate.id === entry.actionId
      );
      if (actionIndex < 0) reject('after-response action order');
      previousActionIndex = actionIndex;
      const action = definition.actions[actionIndex];
      if (action.program === undefined || action.draws?.length)
        reject('after-response action definition');
      const expectedRuntime = executionContext(
        {
          ...projectedSnapshot,
          profile: profileWithExtensionVariables(projectedSnapshot.profile, variableState),
          packageStates: parserStates.map((state) =>
            state.instanceId === definition.instanceId ? current : state
          ),
        },
        'main',
        definition.ref
      );
      const input = action.automaticInput ?? {};
      if (entry.instanceId !== definition.instanceId || entry.trigger !== 'after-turn')
        reject('after-response action order');
      same(entry.input, input, 'after-response automatic input');
      same(entry.before, current, 'after-response state chain');
      const entryAfter = checkState(entry.after, run.chatId, branchId, snapshot.profile);
      same(
        entryAfter,
        {
          ...current,
          state: entryAfter.state,
          stateRevision: current.stateRevision + 1,
        },
        'after-response entry state'
      );
      same(entry.draws, {}, 'after-response draws');
      if (entry.drawSeed !== null) reject('after-response draw seed');
      behaviorRecord(entry.hostRuntime);
      inspectRuntimeValue(entry.hostRuntime);
      same(entry.hostRuntime.state, current.state, 'after-response host state');
      same(entry.hostRuntime.draws, current.draws, 'after-response host draws');
      if (!snapshot.forkedFrom && source)
        same(entry.hostRuntime.packages, expectedRuntime.packages, 'after-response packages');
      same(entry.hostRuntime.package, expectedRuntime.package, 'after-response package');
      same(entry.hostRuntime.options, expectedRuntime.options, 'after-response options');
      for (const field of ['variables', 'variableStateRevision', 'variableDefaultsError'])
        same(entry.hostRuntime[field], expectedRuntime[field], 'after-response variables');
      try {
        validateBehaviorValue(action.inputSchema, entry.input);
        if (!behaviorActionAllowed(action, current.state, entry.input, entry.hostRuntime))
          reject('after-response action condition');
        validateExtensionProgramReceipt(entry.program, {
          programHash: behaviorPayloadHash(action.program),
          stateSchema: definition.behavior.stateSchema,
          state: entryAfter.state,
          result: entry.result,
        });
        if (entry.program.conversation) {
          const staged = source
            ? undefined
            : store.db.prepare('SELECT partial_text FROM runs WHERE id=?').get(run.id)
                ?.partial_text;
          const response = source?.text ?? (typeof staged === 'string' ? staged : undefined);
          if (
            response === undefined ||
            createHash('sha256').update(response).digest('hex') !== receipt.sourceHash
          )
            reject('after-response conversation source');
          validateConversationReceipt(
            store,
            snapshot,
            definition.ref,
            action.program,
            entry.program.conversation,
            response
          );
        }
        if (entry.program.variables) {
          validateExtensionVariablePermission(
            entry.program.variables,
            snapshot.profile,
            definition.ref,
            action.program
          );
          variableState = projectExtensionVariableMutation(variableState, entry.program.variables);
        }
      } catch {
        reject('after-response program receipt');
      }
      current = entryAfter;
    }
    same(after, current, 'after-response final state');
  }
  return receipt as AfterResponseProgress;
}

/** Receipt validation replays deterministic calculations over recorded host facts, including copied fork facts. */
export function validateRunBehaviorArchive(store: Store, checkState: CheckState): void {
  const rows = (table: string) => store.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  const entropy = rows('package_behavior_entropy');
  if (entropy.length !== 1 || entropy[0].id !== 1) reject('entropy');
  digest(entropy[0].seed);
  const opportunities = new Map<
    string,
    { row: Row; seed: string; entries: RunBehaviorEntry[]; originEntropy?: OpportunityEntropy }
  >();
  for (const row of rows('package_behavior_opportunities')) {
    digest(row.id);
    text(row.chat_id);
    text(row.branch_id);
    store.chat(row.chat_id);
    store.product.branch(row.chat_id, row.branch_id);
    const value = object(body(row), ['seed', 'entries'], ['originEntropy']);
    digest(value.seed);
    let originEntropy: OpportunityEntropy | undefined;
    if (Object.hasOwn(value, 'originEntropy')) {
      const proof = object(value.originEntropy, ['opportunityId', 'seed']);
      digest(proof.opportunityId);
      digest(proof.seed);
      same(
        value.seed,
        createHash('sha256').update(`${proof.seed}:${proof.opportunityId}`).digest('hex'),
        'origin opportunity entropy'
      );
      originEntropy = proof as OpportunityEntropy;
    }
    list(value.entries);
    const seen = new Set<string>();
    const owner = store.db
      .prepare(
        "SELECT snapshot FROM runs WHERE json_extract(snapshot,'$.behaviorExecution.opportunityId')=? ORDER BY created_at,id LIMIT 1"
      )
      .get(row.id);
    const ownerSnapshot = owner ? (JSON.parse(String(owner.snapshot)) as RunSnapshot) : undefined;
    let opportunityVariables = variableStateFromProfile(ownerSnapshot?.profile);
    for (const raw of value.entries) {
      const entry = object(
        raw,
        [
          'instanceId',
          'actionId',
          'trigger',
          'input',
          'before',
          'after',
          'result',
          'draws',
          'drawSeed',
          'hostRuntime',
        ],
        ['program']
      ) as RunBehaviorEntry;
      text(entry.instanceId);
      text(entry.actionId);
      if (!['before-turn', 'model'].includes(entry.trigger)) reject('trigger');
      if (seen.has(key(entry))) reject('duplicate opportunity action');
      seen.add(key(entry));
      const before = checkState(entry.before, row.chat_id, row.branch_id),
        after = checkState(entry.after, row.chat_id, row.branch_id);
      if (
        entry.instanceId !== before.instanceId ||
        after.instanceId !== before.instanceId ||
        after.stateRevision !== before.stateRevision + 1
      )
        reject('entry state revision');
      same(
        { ...before, state: after.state, stateRevision: after.stateRevision, draws: after.draws },
        after,
        'entry definition'
      );
      const pkg = store.product.get<any>(
          'content',
          before.packageId,
          before.packageRevision
        ).package,
        behavior = validatePackageBehavior(pkg?.behavior);
      const action = behavior.actions.find((candidate) => candidate.id === entry.actionId);
      if (!action || !behaviorActionTriggers(action).includes(entry.trigger))
        reject('action permission');
      behaviorRecord(entry.hostRuntime);
      inspectRuntimeValue(entry.hostRuntime);
      if (ownerSnapshot) {
        const variables = resolveTemplateVariableContext(
          profileWithExtensionVariables(ownerSnapshot.profile, opportunityVariables)
        );
        for (const field of [
          'variables',
          'variableStateRevision',
          'variableDefaultsError',
        ] as const)
          same(entry.hostRuntime[field], variables[field], 'opportunity variable dependency');
      }
      behaviorRecord(entry.draws);
      try {
        validateBehaviorValue(action.inputSchema, entry.input);
        if (!behaviorActionAllowed(action, before.state, entry.input, entry.hostRuntime))
          reject('action contract');
      } catch {
        reject('action contract');
      }
      same(entry.hostRuntime.state, before.state, 'host state');
      same(entry.hostRuntime.draws, before.draws, 'host draws');
      if (action.draws?.length) {
        digest(entry.drawSeed);
        same(
          entry.drawSeed,
          createHash('sha256')
            .update(`${value.seed}:${key(entry)}`)
            .digest('hex'),
          'opportunity draw seed'
        );
        same(entry.draws, recordDraws(action.draws, entry.drawSeed), 'recorded draws');
      } else if (entry.drawSeed !== null || Object.keys(entry.draws).length)
        reject('unexpected draws');
      same(
        after.draws,
        Object.keys(entry.draws).length ? entry.draws : before.draws,
        'projected draws'
      );
      if (action.program !== undefined) {
        if (!['before-turn', 'model'].includes(entry.trigger) || entry.program === undefined)
          reject('program receipt missing');
        try {
          validateExtensionProgramReceipt(entry.program, {
            programHash: behaviorPayloadHash(action.program),
            stateSchema: behavior.stateSchema,
            state: after.state,
            result: entry.result,
            ...(action.hook === undefined
              ? {}
              : { maxResultChars: EXTENSION_PROGRAM_MAX_EDIT_RESULT_CHARS }),
          });
          if (entry.program.conversation) {
            if (!ownerSnapshot) reject('conversation opportunity owner');
            const ref = ownerSnapshot.profile?.packageAttachments?.find(
              (ref) => `${ref.id}:${ref.role}` === entry.instanceId
            );
            if (!ref) reject('conversation opportunity attachment');
            validateConversationReceipt(
              store,
              ownerSnapshot,
              ref,
              action.program,
              entry.program.conversation,
              undefined,
              !behaviorHookBeforeRequest(action)
            );
          }
          if (entry.program.variables) {
            if (!ownerSnapshot) reject('variable opportunity owner');
            const ref = ownerSnapshot.profile?.packageAttachments?.find(
              (ref) => `${ref.id}:${ref.role}` === entry.instanceId
            );
            if (!ref) reject('opportunity variable attachment');
            validateExtensionVariablePermission(
              entry.program.variables,
              ownerSnapshot.profile,
              ref,
              action.program
            );
            opportunityVariables = projectExtensionVariableMutation(
              opportunityVariables,
              entry.program.variables
            );
          }
        } catch {
          reject('program receipt');
        }
      } else {
        if (entry.program !== undefined) reject('unexpected program receipt');
        const evaluated = evaluateBehaviorAction(
          behavior,
          action,
          before.state,
          entry.input,
          entry.draws,
          entry.hostRuntime
        );
        same(evaluated.state, after.state, 'calculated state');
        same(evaluated.result, entry.result, 'calculated result');
      }
    }
    opportunities.set(row.id, { row, seed: value.seed, entries: value.entries, originEntropy });
  }
  const progresses = new Map<string, RunBehaviorProgress>();
  for (const row of rows('package_behavior_runs')) {
    text(row.run_id);
    const run = store.run(row.run_id),
      snapshot = run.snapshot,
      execution = snapshot.behaviorExecution;
    if (!execution) reject('unexpected progress');
    const value = object(
      body(row),
      ['version', 'opportunityId', 'entries', 'states'],
      ['preparation', 'afterResponse', 'variableState']
    );
    if (value.version !== 1 || execution.version !== 1) reject('version');
    digest(value.opportunityId);
    if (value.opportunityId !== execution.opportunityId) reject('opportunity binding');
    const opportunity = opportunities.get(value.opportunityId);
    if (!opportunity || opportunity.row.chat_id !== run.chatId) reject('opportunity owner');
    if (
      opportunity.row.branch_id !== (snapshot.branchId ?? `main:${run.chatId}`) &&
      !snapshot.candidateOf
    )
      reject('opportunity branch');
    list(value.entries);
    list(value.states);
    list(execution.baseStates);
    list(execution.automaticResults);
    const base = execution.baseStates.map((state) =>
      checkState(state, run.chatId, snapshot.branchId ?? `main:${run.chatId}`, snapshot.profile)
    );
    const automaticDefinitions = (snapshot.profile?.packageAttachments ?? [])
      .filter(
        (ref) =>
          !historicalPersonaExcluded(snapshot.profile, ref.role) &&
          !snapshot.packageBehaviorUnavailable?.some(
            (item) => item.instanceId === `${ref.id}:${ref.role}`
          )
      )
      .flatMap((ref) => {
        const pkg = snapshot.profile?.packages?.find(
          (candidate) => candidate.id === ref.id && candidate.revision === ref.revision
        );
        if (!pkg?.behavior) return [];
        const behavior = validatePackageBehavior(pkg.behavior);
        return behavior.actions
          .filter((action) => behaviorActionTriggers(action).includes('before-turn'))
          .map((action) => ({
            ref,
            behavior,
            action,
            instanceId: `${ref.id}:${ref.role}`,
          }));
      })
      .sort((a, b) => behaviorHookOrder(a.action) - behaviorHookOrder(b.action));
    const deferred = execution.deferredAutomatic === true;
    if (deferred !== Object.hasOwn(value, 'preparation')) reject('preparation contract');
    const preparationReceipt = deferred
      ? preparation(value.preparation, automaticDefinitions.length)
      : undefined;
    if (
      preparationReceipt &&
      ['pending', 'running'].includes(preparationReceipt.status) &&
      value.entries.length
    )
      reject('unfinished preparation entries');
    if (
      preparationReceipt &&
      ['pending', 'running'].includes(preparationReceipt.status) &&
      run.status === 'completed'
    )
      reject('completed unfinished preparation');
    const states = structuredClone(base),
      seen = new Set<string>(),
      automatic: RunBehaviorEntry[] = [];
    const automaticInstances = new Set(automaticDefinitions.map((item) => item.instanceId));
    if (new Set(base.map((state) => state.instanceId)).size !== base.length)
      reject('duplicate base state');
    let modelSeen = false;
    let variableState = variableStateFromProfile(snapshot.profile);
    let variablesUsed = snapshot.profile?.variableState !== undefined;
    for (const raw of value.entries) {
      const entry = object(
        raw,
        [
          'instanceId',
          'actionId',
          'trigger',
          'input',
          'before',
          'after',
          'result',
          'draws',
          'drawSeed',
          'hostRuntime',
        ],
        ['program']
      ) as RunBehaviorEntry;
      if (!['before-turn', 'model'].includes(entry.trigger)) reject('progress trigger');
      if (seen.has(key(entry))) reject('duplicate run action');
      seen.add(key(entry));
      const cached = opportunity.entries.find((item) => key(item) === key(entry));
      if (!cached) reject('missing opportunity receipt');
      same({ ...cached, trigger: entry.trigger }, entry, 'run receipt');
      const ref = snapshot.profile?.packageAttachments?.find(
        (ref) => `${ref.id}:${ref.role}` === entry.instanceId
      );
      const pkg = snapshot.profile?.packages?.find(
          (pkg) => pkg.id === ref?.id && pkg.revision === ref?.revision
        ),
        action = pkg?.behavior?.actions.find((action) => action.id === entry.actionId);
      if (
        !ref ||
        snapshot.packageBehaviorUnavailable?.some((item) => item.instanceId === entry.instanceId) ||
        historicalPersonaExcluded(snapshot.profile, ref.role) ||
        !action ||
        !behaviorActionTriggers(action).includes(entry.trigger)
      )
        reject('frozen permission');
      const index = states.findIndex((state) => state.instanceId === entry.instanceId);
      if (index < 0) reject('state missing');
      const runtime = executionContext(
        {
          ...snapshot,
          profile: profileWithExtensionVariables(snapshot.profile, variableState),
          packageStates: states,
        },
        'main',
        ref
      );
      same(entry.hostRuntime.packages, runtime.packages, 'package dependency projection');
      same(entry.hostRuntime.package, runtime.package, 'selected package projection');
      same(entry.hostRuntime.options, runtime.options, 'selected options');
      for (const field of ['variables', 'variableStateRevision', 'variableDefaultsError'])
        same(entry.hostRuntime[field], runtime[field], 'variable dependency projection');
      if (entry.program?.conversation) {
        if (!action.program) reject('conversation program missing');
        validateConversationReceipt(
          store,
          snapshot,
          ref,
          action.program,
          entry.program.conversation,
          undefined,
          !behaviorHookBeforeRequest(action)
        );
      }
      if (entry.program?.variables) {
        try {
          if (!action.program) reject('variable program missing');
          validateExtensionVariablePermission(
            entry.program.variables,
            snapshot.profile,
            ref,
            action.program
          );
          variableState = projectExtensionVariableMutation(variableState, entry.program.variables);
        } catch {
          reject('variable state chain');
        }
        variablesUsed = true;
      }
      same(states[index], entry.before, 'progress state chain');
      states[index] = structuredClone(entry.after);
      if (entry.trigger === 'before-turn') {
        if (deferred && preparationReceipt?.status !== 'ready')
          reject('unpublished automatic entry');
        if (modelSeen) reject('automatic order');
        automatic.push(entry);
      } else {
        if (
          deferred &&
          ['failed', 'skipped'].includes(preparationReceipt!.status) &&
          automaticInstances.has(entry.instanceId)
        )
          reject('disabled automatic cohort');
        modelSeen = true;
      }
    }
    same(states, value.states, 'progress states');
    if (variablesUsed)
      same(validateChatVariableState(value.variableState), variableState, 'progress variables');
    else if (Object.hasOwn(value, 'variableState')) reject('unexpected progress variables');
    const afterResponseReceipt = Object.hasOwn(value, 'afterResponse')
      ? validateAfterResponseProgress(
          store,
          run,
          snapshot,
          value as RunBehaviorProgress,
          value.afterResponse,
          checkState
        )
      : undefined;
    if (deferred) {
      same(snapshot.packageStates, base, 'deferred snapshot states');
      same(execution.automaticResults, [], 'deferred snapshot results');
      if (preparationReceipt!.status === 'ready') {
        // Accepted predicates were checked against their recorded hostRuntime above.
        // A copied branch must not reinterpret omitted predicates under its new identity.
        let previousIndex = -1;
        // Host-owned edit hooks chain over the transmitted copy instead of a declared input.
        let editedRequest = snapshot.request;
        let editedMessages = requestEditMessages(snapshot, editedRequest);
        for (const entry of automatic) {
          const index = automaticDefinitions.findIndex(
            (d) => d.instanceId === entry.instanceId && d.action.id === entry.actionId
          );
          if (index <= previousIndex) reject('automatic declaration order');
          const hooked = automaticDefinitions[index].action;
          same(
            entry.input,
            hooked.hook === 'edit-input'
              ? extensionEditHookInput(editedRequest)
              : hooked.hook === 'edit-request'
                ? extensionEditRequestInput(editedMessages)
                : (hooked.automaticInput ?? {}),
            'automatic input'
          );
          try {
            if (hooked.hook === 'edit-input') {
              editedRequest = behaviorEditResultText(entry.result);
              editedMessages = requestEditMessages(snapshot, editedRequest);
            }
            if (hooked.hook === 'edit-request') {
              const texts = behaviorEditResultMessages(entry.result, editedMessages);
              editedMessages = editedMessages.map((message, at) => ({
                ...message,
                text: texts[at],
              }));
            }
          } catch {
            reject('automatic edit result');
          }
          previousIndex = index;
        }
      } else if (automatic.length) reject('terminal automatic entry');
    } else {
      const autoStates = structuredClone(base);
      for (const entry of automatic)
        autoStates[autoStates.findIndex((state) => state.instanceId === entry.instanceId)] =
          structuredClone(entry.after);
      same(autoStates, snapshot.packageStates, 'frozen automatic states');
      same(
        automatic.map(({ instanceId, actionId, result }) => ({ instanceId, actionId, result })),
        execution.automaticResults,
        'automatic results'
      );
    }
    if (run.status === 'completed' && !snapshot.forkedFrom) {
      for (const entry of value.entries as RunBehaviorEntry[]) {
        const output = store.db
          .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=? AND instance_id=?')
          .get(run.sourceRevision!, entry.instanceId) as Row | undefined;
        if (!output) reject('missing committed output');
        const out = JSON.parse(output.body),
          published = out.status === 'ready' || out.after.stateRevision > out.before.stateRevision;
        if (
          published &&
          !store.db
            .prepare(
              'SELECT 1 FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND idempotency_key=?'
            )
            .get(
              run.chatId,
              snapshot.branchId ?? `main:${run.chatId}`,
              entry.instanceId,
              `run:${run.id}:${behaviorPayloadHash(key(entry))}`
            )
        )
          reject('missing committed action');
      }
      for (const pkg of afterResponseReceipt?.status === 'skipped'
        ? []
        : (afterResponseReceipt?.packages ?? [])) {
        if (pkg.status !== 'ready') continue;
        for (const entry of pkg.entries)
          if (
            !store.db
              .prepare(
                'SELECT 1 FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND idempotency_key=?'
              )
              .get(
                run.chatId,
                snapshot.branchId ?? `main:${run.chatId}`,
                entry.instanceId,
                `after:${run.id}:${behaviorPayloadHash(key(entry))}`
              )
          )
            reject('missing committed after-response action');
      }
    }
    progresses.set(row.run_id, value as RunBehaviorProgress);
  }
  const runs = rows('runs'),
    snapshotsById = new Map<string, RunSnapshot>(),
    ownersByOpportunity = new Map<string, RunSnapshot[]>();
  for (const row of runs) {
    const snapshot = JSON.parse(row.snapshot) as RunSnapshot;
    snapshotsById.set(row.id, snapshot);
    if (snapshot.behaviorExecution) {
      const id = snapshot.behaviorExecution.opportunityId,
        owners = ownersByOpportunity.get(id) ?? [];
      owners.push(snapshot);
      ownersByOpportunity.set(id, owners);
    }
    if (snapshot.behaviorExecution && !progresses.has(row.id)) reject('missing run progress');
  }
  for (const [id, opportunity] of opportunities) {
    const owners = ownersByOpportunity.get(id) ?? [];
    if (!owners.length) reject('orphan opportunity');
    // Portable imports keep the original entropy proof while owning new chat/run identities.
    if (opportunity.originEntropy) continue;
    if (owners.some((snapshot) => !snapshot.forkedFrom))
      same(
        opportunity.seed,
        createHash('sha256').update(`${entropy[0].seed}:${id}`).digest('hex'),
        'opportunity entropy'
      );
    else
      for (const snapshot of owners) {
        const original = snapshotsById.get(snapshot.forkedFrom!.runId)?.behaviorExecution,
          source = original && opportunities.get(original.opportunityId);
        if (!source) reject('fork opportunity source');
        same(source.seed, opportunity.seed, 'fork opportunity entropy');
      }
  }
}
