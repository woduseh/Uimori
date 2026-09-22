import type { PromptHistoryMessage } from './risu-prompt.js';

/** Authored message changes, not a copy of provider inputs or of the entire conversation. */
export type MessageChanges = {
  removed: string[];
  updated: { message: PromptHistoryMessage; expectedSourceHash?: string }[];
  /** Only recorded when a script reorders/inserts messages instead of ordinary append. */
  order?: string[];
};

export function messageChanges(
  before: readonly PromptHistoryMessage[],
  after: readonly PromptHistoryMessage[],
  sourceMessages: ReadonlySet<string>
): MessageChanges | undefined {
  const previous = new Map(before.map((message) => [message.id, message]));
  const present = new Set(after.map((message) => message.id));
  const removed = before.filter((message) => !present.has(message.id)).map((message) => message.id);
  const updated = after.flatMap((message) => {
    const old = previous.get(message.id);
    if (
      old &&
      old.role === message.role &&
      old.text === message.text &&
      old.sourceKind === message.sourceKind
    )
      return [];
    return [
      {
        message: { ...message },
        ...(old?.sourceHash && sourceMessages.has(message.id)
          ? { expectedSourceHash: old.sourceHash }
          : {}),
      },
    ];
  });
  const appendedOrder = [
    ...before.filter((message) => present.has(message.id)).map((message) => message.id),
    ...after.filter((message) => !previous.has(message.id)).map((message) => message.id),
  ];
  const orderChanged =
    appendedOrder.length !== after.length ||
    after.some((message, index) => message.id !== appendedOrder[index]);
  if (!removed.length && !updated.length && !orderChanged) return undefined;
  return {
    removed,
    updated,
    ...(orderChanged ? { order: after.map((message) => message.id) } : {}),
  };
}

export function applyMessageChanges(
  messages: readonly PromptHistoryMessage[],
  changes: MessageChanges | undefined
): PromptHistoryMessage[] {
  if (!changes) return [...messages];
  const removed = new Set(changes.removed);
  const entries = new Map(
    messages.filter((message) => !removed.has(message.id)).map((message) => [message.id, message])
  );
  for (const change of changes.updated) {
    const current = entries.get(change.message.id);
    // A later explicit user edit to the source wins over a script that saw its old text.
    if (current && change.expectedSourceHash && current.sourceHash !== change.expectedSourceHash)
      continue;
    entries.set(change.message.id, {
      ...(current ?? change.message),
      role: change.message.role,
      text: change.message.text,
    });
  }
  if (!changes.order) return [...entries.values()];
  const ordered = changes.order.flatMap((id) => {
    const message = entries.get(id);
    if (!message) return [];
    entries.delete(id);
    return [message];
  });
  return [...ordered, ...entries.values()];
}
