import { createHash } from 'node:crypto';
import type { ExtensionProgram } from '../core/extension-program.js';
import { pageText } from '../core/paging.js';
import {
  createHostDispatcher,
  exactHostArguments,
  failHost as fail,
  type HostMethodOf,
} from './extension-host-methods.js';
import type { ExtensionHostHandler } from './extension-runtime.js';

/** Binds a program to a fixed copy of the just-completed response. */
export function createResponseExtensionHost(
  program: ExtensionProgram,
  text: string,
  assertCurrent: () => void
): ExtensionHostHandler {
  const captured = text;
  const contentHash = createHash('sha256').update(captured).digest('hex');
  return createHostDispatcher<HostMethodOf<'response'>>({
    denied: 'BEHAVIOR_HOST_DENIED',
    granted: (entry) => program.capabilities?.includes(entry.capability) === true,
    screen: exactHostArguments,
    gate: (_entry, signal) => {
      assertCurrent();
      if (signal.aborted) fail('BEHAVIOR_HOST_ABORTED');
    },
    handlers: {
      'response.read': async ({ offset, limit }) => {
        if (offset > captured.length) fail('BEHAVIOR_HOST_ARGUMENTS');
        return { ...pageText(captured, offset, limit), contentHash };
      },
    },
  });
}
