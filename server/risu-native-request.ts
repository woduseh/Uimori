import { createHash } from 'node:crypto';
import type { ProviderRequest } from '../core/transport.js';
import { validateProviderPrompt } from '../core/risu-prompt.js';
import type { RunSnapshot } from '../core/types.js';
import { nativeRisuContext, nativeRisuSessionKey } from './risu-native-context.js';
import { executeRisuNative, type NativeRisuExecutionOptions } from './risu-native-runtime.js';
import { nativeHistoryRevision, validateNativeImageMessageIdentity } from './risu-native-run.js';

export async function prepareNativeRisuRequest(
  snapshot: RunSnapshot,
  request: ProviderRequest,
  options: NativeRisuExecutionOptions & {
    /** Position in this runMain entry; persisted positions replay without authored effects. */
    requestOrdinal?: number;
  } = {}
) {
  const receipt = snapshot.nativeRisuExecution,
    context = nativeRisuContext(snapshot);
  if (!receipt || !context || !request.prompt) return { snapshot, request };
  const inputHash = createHash('sha256').update(JSON.stringify(request.prompt)).digest('hex');
  const edits = receipt.requestEdits ?? [];
  const ordinal = options.requestOrdinal ?? edits.length;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > edits.length)
    throw new Error('RISU_NATIVE_REQUEST_REPLAY_MISMATCH');
  const saved = edits[ordinal];
  if (saved) {
    if (saved.inputHash !== inputHash) throw new Error('RISU_NATIVE_REQUEST_REPLAY_MISMATCH');
    const prompt = structuredClone(saved.prompt);
    validateProviderPrompt(prompt);
    return { snapshot, request: { ...request, prompt } };
  }
  const result = await executeRisuNative(
    {
      ...context,
      variables: receipt.variables,
      messages: receipt.messages,
      event: 'editRequest',
      request: request.prompt.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n'),
      })),
    },
    { ...options, sessionKey: options.sessionKey ?? nativeRisuSessionKey(snapshot) }
  );
  validateNativeImageMessageIdentity(snapshot, result.messages);
  const prompt = structuredClone(request.prompt);
  if (result.request) {
    const originals = new Map(prompt.messages.map((message) => [message.id, message]));
    const imageMessages = prompt.messages.filter((message) =>
      message.content.some((part) => part.type === 'image')
    );
    const returnedIds = new Set<string>();
    if (imageMessages.length) {
      for (const message of result.request) {
        if (message.id && returnedIds.has(message.id))
          throw new Error('RISU_NATIVE_REQUEST_IMAGE_IDENTITY');
        if (message.id) returnedIds.add(message.id);
        const previous = message.id ? originals.get(message.id) : undefined;
        if (previous?.content.some((part) => part.type === 'image') && message.role !== 'user')
          throw new Error('RISU_NATIVE_REQUEST_IMAGE_IDENTITY');
      }
      // Removing an identified message is an intentional exclusion. An unidentified
      // replacement could instead be the same message with a lost id: never guess.
      if (
        imageMessages.some((message) => !returnedIds.has(message.id)) &&
        result.request.some((message) => !message.id || !originals.has(message.id))
      )
        throw new Error('RISU_NATIVE_REQUEST_IMAGE_IDENTITY');
    }
    prompt.messages = result.request.map((message, index) => {
      if (!['system', 'user', 'assistant'].includes(message.role))
        throw new Error('RISU_NATIVE_REQUEST_ROLE');
      const previous = message.id
        ? originals.get(message.id)
        : imageMessages.length
          ? undefined
          : prompt.messages[index];
      return {
        id: message.id ?? previous?.id ?? `native-request:${index}`,
        role: message.role as 'system' | 'user' | 'assistant',
        content: [
          { type: 'text' as const, text: message.content },
          ...(previous?.content.filter((part) => part.type === 'image') ?? []),
        ],
        completion:
          previous?.role === message.role && index === result.request!.length - 1
            ? previous.completion
            : ('complete' as const),
        provenance: previous?.provenance ?? {
          blockId: `native-request:${index}`,
          origin: 'prompt' as const,
        },
      };
    });
    const ids = new Set(prompt.messages.map((message) => message.id));
    prompt.cachePlan = prompt.cachePlan.filter((anchor) => ids.has(anchor.afterMessageId));
  }
  validateProviderPrompt(prompt);
  return {
    request: { ...request, prompt },
    snapshot: {
      ...snapshot,
      nativeRisuExecution: {
        ...receipt,
        variables: result.variables,
        messages: result.messages,
        historyRevision: nativeHistoryRevision(
          receipt.messages,
          result.messages,
          receipt.historyRevision
        ),
        issues: [...new Set([...receipt.issues, ...result.warnings])],
        requestEdits: [...edits, { inputHash, prompt }],
      },
    },
  };
}
