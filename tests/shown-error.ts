import { translateMessage } from '../web/i18n.js';

export async function shownRejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (cause: unknown) => cause
  );
  return translateMessage((error as Error).message);
}

export function shownThrow(run: () => unknown): string {
  try {
    run();
  } catch (cause) {
    return translateMessage((cause as Error).message);
  }
  throw new Error('expected a throw');
}
