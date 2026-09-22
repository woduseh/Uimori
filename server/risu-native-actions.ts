import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RunSnapshot, Usage } from '../core/types.js';
import type { NativeRisuMessage } from '../core/risu-native-execution.js';
import { validateChatVariableValues } from '../core/chat-variables.js';
import { nativeRisuContext, nativeRisuSessionKey } from './risu-native-context.js';
import {
  executeRisuNative,
  disposeNativeRisuSession,
  type NativeRisuExecutionOptions,
} from './risu-native-runtime.js';
import { captureLogicalHistory } from './prompt-snapshot.js';
import { chatVariableProfile } from './chat-variable-context.js';
import { readChatVariables, writeChatVariablesInTransaction } from './chat-variables.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { readRunSnapshot } from './run-projections.js';

const zeroUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function groupMessages(messages: NativeRisuMessage[]): NativeRisuMessage[][] {
  const groups: NativeRisuMessage[][] = [];
  let pending: NativeRisuMessage[] = [];
  for (const message of messages) {
    if (
      !['user', 'char'].includes(message.role) ||
      typeof message.data !== 'string' ||
      message.data.length > 2_000_000
    )
      throw new HttpError(400, 'RISU_NATIVE_MESSAGE_INVALID');
    pending.push({ role: message.role, data: message.data });
    if (message.role === 'char') {
      groups.push(pending);
      pending = [];
    }
  }
  if (pending.length) groups.push(pending);
  return groups;
}

/** Current branch context; the source package revision remains the one the reader rendered. */
export function nativeSourceSnapshot(
  store: Store,
  chatId: string,
  sourceId: string,
  branchId?: string
) {
  const branch = store.product.branch(chatId, branchId);
  const history = store.history(branch.headRevision);
  if (!history.some((entry) => entry.revision === sourceId))
    throw new HttpError(409, 'RISU_NATIVE_SOURCE_OUTSIDE_BRANCH');
  const source = store.source(sourceId);
  if (source.chatId !== chatId) throw new HttpError(404, 'Source not found');
  const own = readRunSnapshot(store, source.runId);
  const snapshot: RunSnapshot = {
    ...own,
    profile: chatVariableProfile(store, chatId, branch.id, own.profile),
    history,
    parentRevision: branch.headRevision,
    branchId: branch.id,
  };
  // Reading a later button uses the live branch, not the variables captured before generation.
  delete snapshot.nativeRisuExecution;
  snapshot.logicalHistory = captureLogicalHistory(store, snapshot);
  return { source, snapshot, branch, variables: readChatVariables(store, chatId, branch.id) };
}

/**
 * Reserve before executing. A lost HTTP response or a restart never replays an uncertain script.
 * Changed messages get new source identities; other branches keep their original sources.
 */
export async function applyNativeRisuAction(
  store: Store,
  chatId: string,
  sourceId: string,
  value: unknown,
  options: {
    createHost?: (
      runId: string,
      snapshot: RunSnapshot,
      usage: Usage
    ) => NativeRisuExecutionOptions['host'];
    signal?: AbortSignal;
  } = {}
) {
  const body = record(value);
  fields(body, [
    'branchId',
    'kind',
    'name',
    'expectedHeadRevision',
    'expectedHeadHash',
    'expectedVariableRevision',
    'idempotencyKey',
  ]);
  const branchId = body.branchId === undefined ? undefined : text(body.branchId, 'branch id', 100);
  const kind = body.kind;
  if (kind !== 'trigger' && kind !== 'button') throw new HttpError(400, 'RISU_NATIVE_ACTION_KIND');
  const name = text(body.name, 'action name', 300);
  const key = `native-action:${text(body.idempotencyKey, 'request key', 120)}`;
  const expectedHeadRevision = text(body.expectedHeadRevision, 'head revision', 100);
  const expectedHeadHash = text(body.expectedHeadHash, 'head hash', 64);
  const expectedVariableRevision = number(body.expectedVariableRevision, 'variables revision', 0);
  const commandHash = digest({
    sourceId,
    branchId,
    kind,
    name,
    expectedHeadRevision,
    expectedHeadHash,
    expectedVariableRevision,
  });
  const prior = store.db
    .prepare('SELECT id FROM runs WHERE chat_id=? AND request_key=?')
    .get(chatId, key);
  if (prior) {
    const run = store.run(String(prior.id));
    if (run.snapshot.nativeRisuAuthored?.commandHash !== commandHash)
      throw new HttpError(409, 'RISU_NATIVE_ACTION_REPLAY_CONFLICT');
    if (run.status !== 'completed')
      throw new HttpError(409, `RISU_NATIVE_ACTION_${run.status.toUpperCase()}`);
    return { created: false, runId: run.id };
  }
  const captured = nativeSourceSnapshot(store, chatId, sourceId, branchId);
  const context = nativeRisuContext(captured.snapshot);
  if (!context) throw new HttpError(400, 'RISU_NATIVE_CARD_REQUIRED');
  const check = () => {
    const branch = store.product.branch(chatId, captured.branch.id);
    if (
      branch.headRevision !== expectedHeadRevision ||
      store.source(expectedHeadRevision).hash !== expectedHeadHash ||
      readChatVariables(store, chatId, branch.id).revision !== expectedVariableRevision
    )
      throw new HttpError(409, 'RISU_NATIVE_ACTION_STATE_CHANGED');
  };
  const reserved = store.transaction(() => {
    check();
    const chat = store.chat(chatId);
    const result = store.createRunInTransaction(
      chatId,
      {
        request: '',
        expectedRevision: branchHead(captured.snapshot),
        branchId: captured.branch.id,
        expectedSettingsRevision: chat.settingsRevision,
        expectedProfileRevision: store.product.profile(chatId).revision,
        idempotencyKey: key,
      },
      () => ({
        ...captured.snapshot,
        request: '',
        nativeRisuAuthored: { version: 1, action: name, commandHash, messages: [] },
        packageStart: undefined,
        promptCompilation: undefined,
        contextPlan: undefined,
      })
    );
    store.startRun(result.run.id);
    return result.run;
  });
  const usage: Usage = structuredClone(zeroUsage);
  try {
    const result = await executeRisuNative(
      {
        ...context,
        event: kind === 'button' ? 'button' : 'manual',
        argument: name,
      },
      {
        sessionKey: nativeRisuSessionKey(captured.snapshot),
        signal: options.signal,
        host: options.createHost?.(reserved.id, reserved.snapshot, usage),
      }
    );
    validateChatVariableValues(result.variables);
    const previous = groupMessages(context.messages);
    const next = groupMessages(result.messages);
    const greeting = captured.snapshot.history.find((entry) => {
      const saved = store.run(store.source(entry.revision).runId).snapshot;
      return saved.packageStart?.mode === 'authored' || saved.nativeRisuAuthored?.greeting;
    });
    const messageSources = captured.snapshot.history.filter((entry) => entry !== greeting);
    const sourceByMessage = new Map(
      (captured.snapshot.logicalHistory ?? []).map((message) => [
        message.id,
        message.sourceRevision,
      ])
    );
    let sourceIndex = 0;
    const aligned =
      previous.length === messageSources.length &&
      context.messages.every((message) => {
        const sameSource =
          !!message.id && sourceByMessage.get(message.id) === messageSources[sourceIndex]?.revision;
        if (message.role === 'char') sourceIndex++;
        return sameSource;
      });
    // FirstMessage is outside Risu's message array. A variables-only opening action
    // checkpoints a new greeting source while its runtime chat remains empty.
    const greetingOnly = !next.length;
    if (greetingOnly) next.push([{ role: 'char', data: greeting?.text ?? '' }]);
    let first = 0;
    while (
      first < previous.length &&
      first < next.length &&
      isDeepStrictEqual(previous[first], next[first])
    )
      first++;
    first = Math.min(first, next.length - 1);
    // Output callbacks may insert/delete messages within one immutable source. Only reuse
    // a stored prefix when its boundaries still match the runtime message groups.
    if (!aligned) first = 0;
    const retained = greetingOnly
      ? null
      : first
        ? (messageSources[first - 1]?.revision ?? null)
        : (greeting?.revision ?? null);
    return store.transaction(() => {
      check();
      if (store.run(reserved.id).status !== 'running')
        throw new HttpError(409, 'RISU_NATIVE_ACTION_CANCELLED');
      // The atomic rewind is immediately followed by copy-on-write source commits.
      store.db
        .prepare('UPDATE branches SET head_revision=? WHERE id=?')
        .run(retained, captured.branch.id);
      if (captured.branch.default)
        store.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(retained, chatId);
      let head = retained;
      let lastRunId = reserved.id;
      for (let index = first; index < next.length; index++) {
        const messages = next[index];
        const request = messages
          .filter((entry) => entry.role === 'user')
          .map((entry) => entry.data)
          .join('\n\n');
        const output = messages.find((entry) => entry.role === 'char')?.data ?? '';
        const chat = store.chat(chatId);
        const snapshot: RunSnapshot = {
          chatId,
          branchId: captured.branch.id,
          parentRevision: head,
          settingsRevision: chat.settingsRevision,
          settings: chat.settings,
          request,
          history: store.history(head),
          resources: captured.snapshot.profile
            ? store.product.resources(chatId, captured.snapshot.profile)
            : [],
          profile: captured.snapshot.profile,
          nativeRisuAuthored: {
            version: 1,
            action: name,
            messages,
            commandHash,
            ...(greetingOnly ? { greeting: true } : {}),
          },
          executionClock: reserved.snapshot.executionClock,
        };
        let id: string;
        if (index === first) {
          id = reserved.id;
          store.db
            .prepare('UPDATE runs SET parent_revision=?,request=?,snapshot=? WHERE id=?')
            .run(head, request, JSON.stringify(snapshot), id);
        } else {
          const added = store.createRunInTransaction(
            chatId,
            {
              request,
              expectedRevision: head,
              branchId: captured.branch.id,
              expectedSettingsRevision: chat.settingsRevision,
              idempotencyKey: `${key}:${index}`,
            },
            () => snapshot
          );
          id = added.run.id;
          store.startRun(id);
        }
        // Last checkpoint carries the action's final variables. Earlier retained/copy sources
        // are immutable and cannot be used to resurrect a future state on another branch.
        if (index === next.length - 1)
          writeChatVariablesInTransaction(store, chatId, captured.branch.id, {
            expectedRevision: expectedVariableRevision,
            expectedSourceHash: head ? store.source(head).hash : null,
            idempotencyKey: `${key}:variables`,
            values: result.variables,
          });
        const source = store.completeRunInTransaction(
          id,
          output,
          index === first ? usage : zeroUsage,
          chat.settings
        );
        head = source.id;
        lastRunId = id;
      }
      return { created: true, runId: lastRunId, notifications: result.effects.notifications ?? [] };
    });
  } catch (error) {
    disposeNativeRisuSession(nativeRisuSessionKey(captured.snapshot));
    if (store.run(reserved.id).status === 'running')
      store.finishRun(
        reserved.id,
        'failed',
        error instanceof Error ? error.message : 'RISU_NATIVE_ACTION_FAILED',
        undefined,
        usage
      );
    else if (store.run(reserved.id).status === 'cancelled')
      store.settleCancelledUsage(reserved.id, usage);
    throw error;
  }
}

const branchHead = (snapshot: RunSnapshot) => snapshot.parentRevision;
