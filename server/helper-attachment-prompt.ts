import type { HelperTaskSnapshot } from '../core/helper.js';
import { PROMPT_COMPILER_VERSION, type LogicalMessage } from '../core/risu-prompt.js';
import { withNativeHostContext } from '../core/provider-messages.js';
import type { ProviderRequest } from '../core/transport.js';
import type { HelperAttachments } from './helper-attachments.js';

const attached = (value: HelperAttachments) => !!(value.images?.length || value.files?.length);

/** Preserve authored turn identity and native media parts; JSON references alone are not media input. */
export function helperAttachmentPrompt(
  request: ProviderRequest,
  history: HelperTaskSnapshot['history'],
  current: HelperAttachments,
  currentId: string
): ProviderRequest {
  if (!attached(current) && !history.some(attached)) return request;
  const content = (text: string, value: HelperAttachments): LogicalMessage['content'] => [
    { type: 'text', text },
    ...(value.images ?? []).map((image) => ({ type: 'image' as const, image })),
    ...(value.files ?? []).map((file) => ({ type: 'file' as const, file })),
  ];
  return withNativeHostContext({
    ...request,
    prompt: {
      compilerVersion: PROMPT_COMPILER_VERSION,
      values: {},
      cachePlan: [],
      messages: [
        ...history.map(
          (message): LogicalMessage => ({
            id: `helper:${message.id}`,
            role: message.role,
            content: content(message.text, message),
            completion: 'complete',
            provenance: {
              blockId: 'helper.history',
              origin: 'history',
              sourceMessageId: message.id,
            },
          })
        ),
        {
          id: `helper:${currentId}`,
          role: 'user',
          content: content(request.input.task, current),
          completion: 'complete',
          provenance: { blockId: 'helper.current', origin: 'current' },
        },
      ],
    },
  });
}
