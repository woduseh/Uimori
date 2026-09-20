import { threadId, resourceLimits } from 'node:worker_threads';
let calls = 0;
export async function evaluate(input) {
  if (input?.fail) throw new Error('fixture failure');
  if (input?.exit) process.exit(7);
  if (input?.spin) {
    for (;;) {
      /* Only in a disposable test worker; the host must terminate this. */
    }
  }
  if (input?.delay) await new Promise((resolve) => setTimeout(resolve, input.delay));
  const copy = structuredClone(input);
  if (input?.nested) input.nested.value = 'changed in worker';
  return {
    threadId,
    calls: ++calls,
    copy,
    env: process.env.UIMORI_WORKER_TEST_SECRET ?? null,
    resourceLimits,
  };
}
