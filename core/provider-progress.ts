import type { ProviderProtocol } from './product.js';
import type { ProviderExecutionOptions, ProviderRequest } from './transport.js';
import { ProviderContractError } from './provider-errors.js';

/** Public assistant prose only. Offset is the UTF-16 end offset within one provider attempt. */
export type ProviderProgress = { text: string; offset: number };

/** Validated append, or a full snapshot at a decoder reconciliation boundary. */
export type ProviderTextUpdate = ProviderProgress | string | undefined;

/** Final-submission envelopes and structured translation JSON have no safe incremental public body. */
export function publicProgressAllowed(request: ProviderRequest, protocol: ProviderProtocol) {
  return (
    protocol !== 'codex-app-server-v1' &&
    !(request.role === 'translation' && request.generation?.structuredOutput === true) &&
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
  let lastDelta: ProviderProgress | undefined;
  const listener = publicProgressAllowed(request, protocol) ? options.onProgress : undefined;
  const receive = async (update: ProviderTextUpdate): Promise<void> => {
    if (!listener || options.signal.aborted || update === undefined) return;
    let delta: ProviderProgress;
    if (typeof update === 'string') {
      if (update === emitted) return;
      if (!update.startsWith(emitted)) throw new ProviderContractError('PUBLIC_TEXT_CHANGED');
      delta = { text: update.slice(emitted.length), offset: update.length };
    } else {
      if (update.offset === lastDelta?.offset && update.text === lastDelta.text) return;
      if (
        !Number.isSafeInteger(update.offset) ||
        update.offset !== emitted.length + update.text.length
      )
        throw new ProviderContractError('PUBLIC_TEXT_CHANGED');
      delta = update;
    }
    if (!delta.text) return;
    emitted += delta.text;
    lastDelta = delta;
    await listener(delta);
  };
  return Object.assign(receive, {
    finish(text: string): void {
      if (listener && !options.signal.aborted && text !== emitted)
        throw new ProviderContractError('PUBLIC_TEXT_CHANGED');
    },
  });
}
