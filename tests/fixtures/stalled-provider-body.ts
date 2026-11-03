/** A response whose body stops after its first bytes and ignores fetch's abort signal. */
export function stalledProviderBody(contentType = 'application/json') {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let reading!: () => void;
  let acknowledgeCancel: (() => void) | undefined;
  let cancellations = 0;
  const pendingRead = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(new TextEncoder().encode('{'));
    },
    pull() {
      reading();
    },
    cancel() {
      cancellations++;
      // A remote cancellation acknowledgement can itself remain pending.
      return new Promise<void>((resolve) => {
        acknowledgeCancel = resolve;
      });
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': contentType } }),
    pendingRead,
    get cancellations() {
      return cancellations;
    },
    fail(error: Error) {
      source.error(error);
    },
    release() {
      try {
        source.close();
      } catch {
        // The reader may already have been cancelled or failed.
      }
      acknowledgeCancel?.();
    },
  };
}

/** Keep a broken cancellation test bounded, even if the underlying read never completes. */
export async function settleWithin<T>(work: Promise<T>, milliseconds = 800): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
