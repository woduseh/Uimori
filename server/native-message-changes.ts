import { readStoredRunSnapshot } from './run-projections.js';
import { messageChanges, type MessageChanges } from '../core/message-changes.js';
import type { PromptHistoryMessage } from '../core/risu-prompt.js';
import type { RunSnapshot, Source } from '../core/types.js';
import { captureLogicalHistory } from './prompt-snapshot.js';
import type { Store } from './store.js';

/** Retain Lua-authored results while releasing the large execution input. */
export function captureNativeMessageChanges(
  store: Store,
  snapshot: RunSnapshot,
  source: Source
): MessageChanges | undefined {
  const execution = snapshot.nativeRisuExecution;
  if (!execution?.output) return undefined;
  const history = snapshot.logicalHistory ?? captureLogicalHistory(store, snapshot);
  const provenance = { sourceRevision: source.id, sourceHash: source.hash, runId: source.runId };
  const requestId = `request:${source.id}`,
    sourceId = `source:${source.id}`;
  const base: PromptHistoryMessage[] = [
    ...history,
    { id: requestId, role: 'user', text: snapshot.request ?? '', ...provenance },
    { id: sourceId, role: 'assistant', text: source.text, ...provenance },
  ];
  const byId = new Map(base.map((message) => [message.id, message]));
  const sourceMessages = new Set(
    base.filter((message) => message.id.startsWith('source:')).map((message) => message.id)
  );
  const authoredBySource = new Map<
    string,
    NonNullable<RunSnapshot['nativeRisuAuthored']> | undefined
  >();
  for (const message of history) {
    if (!message.id.startsWith('native:') || !message.sourceRevision) continue;
    if (!authoredBySource.has(message.sourceRevision)) {
      const owner = store.sourceOriginal(message.sourceRevision);
      authoredBySource.set(
        message.sourceRevision,
        readStoredRunSnapshot(store, owner.runId).nativeRisuAuthored
      );
    }
    const authored = authoredBySource.get(message.sourceRevision);
    const index = Number(message.id.split(':').at(-1));
    if (authored?.messages[index]?.role === 'char') sourceMessages.add(message.id);
  }
  const after: PromptHistoryMessage[] = [
    ...history.filter((message) => message.sourceKind === 'authored-start'),
    ...execution.output.messages.map((message, index) => {
      const id =
        message.id === 'current-output'
          ? sourceId
          : message.id === 'current-input'
            ? requestId
            : message.id && byId.has(message.id)
              ? message.id
              : `native:${source.id}:${index}`;
      const existing = byId.get(id);
      return {
        ...(existing ?? provenance),
        id,
        role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
        text: id === sourceId ? source.text : message.data,
      };
    }),
  ];
  return messageChanges(base, after, sourceMessages);
}
