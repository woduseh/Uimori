import { toUiMessage } from '../web/api-errors.js';
import { formatUiMessage } from '../web/ui-message.js';

export async function shownRejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (cause: unknown) => cause
  );
  return formatUiMessage(toUiMessage(error));
}

export function shownThrow(run: () => unknown): string {
  try {
    run();
  } catch (cause) {
    return formatUiMessage(toUiMessage(cause));
  }
  throw new Error('expected a throw');
}
