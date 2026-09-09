import type { ProviderProtocol } from './product.js';
import type { ProviderExecutionOptions, ProviderRequest } from './transport.js';
import { ProviderContractError } from './provider-errors.js';

/** Public assistant prose only. Offset is the UTF-16 end offset within one provider attempt. */
export type ProviderProgress = { text: string; offset: number };

/** Final-submission envelopes and evaluation rounds have no safe incremental public body. */
export function publicProgressAllowed(request: ProviderRequest, protocol: ProviderProtocol) {
  return (
    protocol !== 'codex-app-server-v1' &&
    request.generation?.structuredOutput !== true &&
    !request.stable.tools.some((tool) =>
      ['story.submit', 'eval_submit_artifact'].includes(tool.name)
    )
  );
}

/** Receives decoder-selected prose, never raw provider events or an opaque snapshot. */
export function createPublicTextProgress(
  request: ProviderRequest,
  protocol: ProviderProtocol,
  options: Pick<ProviderExecutionOptions, 'signal' | 'onProgress'>
) {
  let emitted = '';
  const listener = publicProgressAllowed(request, protocol) ? options.onProgress : undefined;
  return async (text: string): Promise<void> => {
    if (!listener || options.signal.aborted || text === emitted) return;
    if (!text.startsWith(emitted)) throw new ProviderContractError('PUBLIC_TEXT_CHANGED');
    const delta = text.slice(emitted.length);
    emitted = text;
    if (delta) await listener({ text: delta, offset: text.length });
  };
}
