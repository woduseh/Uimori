import { createHash } from 'node:crypto';
import type { ProviderRequest } from '../core/transport.js';
import { validateProviderPrompt } from '../core/prompt-program.js';
import type { RunSnapshot } from '../core/types.js';
import { nativeRisuContext, nativeRisuSessionKey } from './risu-native-context.js';
import { executeRisuNative, type NativeRisuExecutionOptions } from './risu-native-runtime.js';
import { nativeHistoryRevision } from './risu-native-run.js';

export async function prepareNativeRisuRequest(
  snapshot: RunSnapshot,
  request: ProviderRequest,
  options: NativeRisuExecutionOptions = {}
) {
  const receipt = snapshot.nativeRisuExecution,
    context = nativeRisuContext(snapshot);
  if (!receipt || !context || !request.prompt) return { snapshot, request };
  const result = await executeRisuNative(
    {
      ...context,
      variables: receipt.variables,
      messages: receipt.messages,
      event: 'editRequest',
      request: request.prompt.messages.map((message) => ({
        role: message.role,
        content: message.content.map((part) => part.text).join('\n'),
      })),
    },
    { ...options, sessionKey: options.sessionKey ?? nativeRisuSessionKey(snapshot) }
  );
  const prompt = structuredClone(request.prompt);
  if (result.request) {
    prompt.messages = result.request.map((message, index) => {
      if (!['system', 'user', 'assistant'].includes(message.role))
        throw new Error('RISU_NATIVE_REQUEST_ROLE');
      const previous = prompt.messages[index];
      return {
        id: previous?.id ?? `native-request:${index}`,
        role: message.role as 'system' | 'user' | 'assistant',
        content: [{ type: 'text' as const, text: message.content }],
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
  const inputHash = createHash('sha256').update(JSON.stringify(request.prompt)).digest('hex');
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
        requestEdits: [...(receipt.requestEdits ?? []), { inputHash, prompt }],
      },
    },
  };
}
