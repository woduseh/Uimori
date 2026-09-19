import {
  validateProviderPrompt,
  type PromptCompilation,
  type LogicalMessage,
} from './prompt-program.js';
import type { NativeRisuLorePosition } from './risu-native.js';

type PositionedLore = {
  id: string;
  revision: number;
  text: string;
  nativeRisuPosition?: NativeRisuLorePosition;
};

/** Apply authored native positions after host context; resource budgets and read scopes stay intact. */
export function placeNativeRisuLore(
  compilation: PromptCompilation,
  resources: readonly PositionedLore[]
): PromptCompilation {
  const entries = resources.filter((entry) => entry.nativeRisuPosition && entry.text.trim());
  if (!entries.length) return compilation;
  const result = structuredClone(compilation);
  const conversation = result.messages
    .filter(
      (message) =>
        message.provenance.origin === 'history' || message.provenance.origin === 'current'
    )
    .map((message) => message.id);
  const ordered = [...entries].sort(
    (a, b) => a.nativeRisuPosition!.order - b.nativeRisuPosition!.order
  );
  const end = ordered.filter(
    (entry) => entry.nativeRisuPosition!.mode === 'depth' && entry.nativeRisuPosition!.depth === 0
  );
  const positioned = ordered.filter((entry) => !end.includes(entry));
  const insert = (entry: PositionedLore, at: number): string => {
    const position = entry.nativeRisuPosition!;
    const id = `__native_lore:${entry.id}:${entry.revision}`;
    if (result.messages.some((message) => message.id === id))
      throw new Error('RISU_NATIVE_LORE_MESSAGE_COLLISION');
    const message: LogicalMessage = {
      id,
      role: position.role,
      content: [{ type: 'text', text: entry.text }],
      completion: 'complete',
      provenance: { blockId: id, origin: 'prompt' },
    };
    result.messages.splice(at, 0, message);
    result.trace.push({ blockId: id, included: true, messageIds: [id] });
    return id;
  };
  for (const entry of positioned) {
    const position = entry.nativeRisuPosition!;
    const raw =
      position.mode === 'lore'
        ? 0
        : position.mode === 'depth'
          ? position.depth
          : conversation.length - position.depth;
    // Array.splice's negative-index behavior is the upstream native contract.
    const index =
      raw < 0 ? Math.max(conversation.length + raw, 0) : Math.min(raw, conversation.length);
    const next = conversation[index],
      previous = conversation[index - 1];
    const boundary = next
      ? result.messages.findIndex((message) => message.id === next)
      : previous
        ? result.messages.findIndex((message) => message.id === previous) + 1
        : Math.max(
            0,
            result.messages.findIndex((message) => message.completion === 'prefill')
          );
    const id = insert(entry, boundary);
    if (position.mode !== 'lore') conversation.splice(index, 0, id);
  }
  // Native @@end / @@depth 0 follows the prompt; assistant entries follow user/system entries.
  // Keep an already authored provider prefill last rather than changing its role or completion.
  for (const entry of [
    ...end.filter((entry) => entry.nativeRisuPosition!.role !== 'assistant'),
    ...end.filter((entry) => entry.nativeRisuPosition!.role === 'assistant'),
  ]) {
    const prefill = result.messages.findIndex((message) => message.completion === 'prefill');
    insert(entry, prefill < 0 ? result.messages.length : prefill);
  }
  const last = result.messages.at(-1);
  if (
    last?.role === 'assistant' &&
    last.id.startsWith('__native_lore:') &&
    end.some((entry) => `__native_lore:${entry.id}:${entry.revision}` === last.id)
  )
    last.completion = 'prefill';
  validateProviderPrompt({
    compilerVersion: result.compilerVersion,
    messages: result.messages,
    cachePlan: result.cachePlan,
    values: result.values,
  });
  return result;
}
