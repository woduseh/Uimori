import { readStoredRunSnapshot } from './run-projections.js';
import type { CopiedMessageState } from '../core/chat-backup.js';
import type { MessageChanges } from '../core/message-changes.js';
import type { SourceHistoryItem } from '../core/source-history.js';
import type { NativeRisuAuthored } from '../core/risu-native-execution.js';
import type { Store } from './store.js';
import { HttpError } from './request-validation.js';

export function captureCopiedMessages(
  store: Store,
  history: readonly SourceHistoryItem[]
): CopiedMessageState[] {
  return history.map((item) => {
    const source = store.source(item.revision);
    const snapshot = readStoredRunSnapshot(store, source.runId);
    return {
      sourceId: source.id,
      sourceHash: source.hash,
      ...(snapshot.messageChanges ? { changes: structuredClone(snapshot.messageChanges) } : {}),
      ...(snapshot.nativeRisuAuthored
        ? { authored: structuredClone(snapshot.nativeRisuAuthored) }
        : {}),
      ...(snapshot.packageStart?.mode === 'authored' ? { opening: true } : {}),
    };
  });
}

export function copiedMessageTexts(messages: readonly CopiedMessageState[]): string[] {
  return messages.flatMap((state) => [
    ...(state.changes?.updated.map((item) => item.message.text) ?? []),
    ...(state.authored?.messages.map((message) => message.data) ?? []),
  ]);
}

export function mapCopiedMessageTexts(
  messages: CopiedMessageState[],
  transform: (text: string) => string
): void {
  for (const state of messages) {
    for (const item of state.changes?.updated ?? [])
      item.message.text = transform(item.message.text);
    for (const message of state.authored?.messages ?? []) message.data = transform(message.data);
  }
}

/** Local identity mapping touches authored messages only; it never reconstructs old model inputs. */
export function restoreCopiedMessages(
  store: Store,
  states: readonly CopiedMessageState[],
  history: readonly SourceHistoryItem[]
): void {
  if (states.length !== history.length)
    throw new HttpError(400, '메시지 상태와 본문 개수가 맞지 않아요.');
  const sources = new Map(
    states.map((state, index) => [
      state.sourceId,
      { before: state, after: store.source(history[index].revision) },
    ])
  );
  const mapId = (id: string): string =>
    id.replace(/^(source|request|native):([^:]+)(.*)$/u, (raw, kind, sourceId, suffix) => {
      const mapped = sources.get(sourceId);
      return mapped
        ? mapped.before.opening && !mapped.before.authored && kind === 'source'
          ? `native:${mapped.after.id}:0`
          : `${kind}:${mapped.after.id}${suffix}`
        : raw;
    });
  for (const [index, state] of states.entries()) {
    const source = store.source(history[index].revision);
    const snapshot = readStoredRunSnapshot(store, source.runId);
    if (state.changes) {
      const changes: MessageChanges = {
        removed: state.changes.removed.map(mapId),
        ...(state.changes.order ? { order: state.changes.order.map(mapId) } : {}),
        updated: state.changes.updated.map((item) => {
          const original = item.message;
          const mapped = original.sourceRevision ? sources.get(original.sourceRevision) : undefined;
          return {
            message: {
              ...original,
              id: mapId(original.id),
              ...(mapped
                ? {
                    sourceRevision: mapped.after.id,
                    sourceHash: mapped.after.hash,
                    runId: mapped.after.runId,
                  }
                : {}),
            },
            ...(item.expectedSourceHash
              ? {
                  expectedSourceHash:
                    mapped && mapped.before.sourceHash === item.expectedSourceHash
                      ? mapped.after.hash
                      : item.expectedSourceHash,
                }
              : {}),
          };
        }),
      };
      snapshot.messageChanges = changes;
    }
    if (state.authored)
      snapshot.nativeRisuAuthored = {
        version: 1,
        action: 'copied-messages',
        messages: state.authored.messages.map((message) => ({
          ...message,
          ...(message.id ? { id: mapId(message.id) } : {}),
        })),
        ...(state.authored.greeting ? { greeting: true } : {}),
      } satisfies NativeRisuAuthored;
    else if (state.opening)
      snapshot.nativeRisuAuthored = {
        version: 1,
        action: 'copied-opening',
        greeting: true,
        messages: [{ role: 'char', data: source.text }],
      };
    if (state.changes || state.authored || state.opening)
      store.db
        .prepare('UPDATE runs SET snapshot=? WHERE id=?')
        .run(JSON.stringify(snapshot), source.runId);
  }
}
