/** Events set a target; only an applied HTTP response acknowledges a full refresh. */
export function createReaderSync(options: {
  refresh: (incremental: boolean) => Promise<boolean | undefined>;
  cursor: () => number;
  onError: (error: unknown) => void;
}) {
  let target = -1,
    full = 0,
    acknowledged = 0,
    failures = 0;
  let disposed = false,
    inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const needed = () => full > acknowledged || target > options.cursor();
  const schedule = (delay: number) => {
    if (!disposed && !inFlight && !timer && needed()) timer = setTimeout(flush, delay);
  };
  const flush = async () => {
    timer = undefined;
    if (disposed || !needed()) return;
    inFlight = true;
    const requestedFull = full;
    try {
      const applied = await options.refresh(requestedFull === acknowledged);
      if (applied) acknowledged = requestedFull;
      failures = applied ? 0 : failures + 1;
    } catch (error) {
      failures++;
      if (!disposed) options.onError(error);
    } finally {
      inFlight = false;
      schedule(Math.min(5000, 100 * 2 ** Math.min(failures, 6)));
    }
  };
  return {
    request(cursor = 0, reconnect = false) {
      target = Math.max(target, cursor);
      if (reconnect) full++;
      schedule(100);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
