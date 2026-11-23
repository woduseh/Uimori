export const readerRefreshDelay = 100;

export function createReaderSync(options: {
  refresh: (incremental: boolean) => Promise<boolean | undefined>;
  cursor: () => number;
  onError: (error: unknown) => void;
  active?: boolean;
}) {
  let target = -1,
    full = 0,
    acknowledged = 0,
    failures = 0,
    load = 0;
  let disposed = false,
    inFlight = false,
    loading = false,
    fresh = false,
    snapshotDuringLoad = false,
    disconnectedDuringLoad = false;
  let active = options.active ?? true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const needed = () => full > acknowledged || target > options.cursor();
  const schedule = (delay: number) => {
    if (active && !disposed && !inFlight && !loading && !timer && needed())
      timer = setTimeout(flush, delay);
  };
  const flush = async () => {
    timer = undefined;
    if (!active || disposed || loading || !needed()) return;
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
  const settleLoad = (id: number, applied: boolean, coveredFull: number) => {
    if (id !== load || disposed) return;
    loading = false;
    if (applied) acknowledged = Math.max(acknowledged, coveredFull);
    fresh = applied && !disconnectedDuringLoad && !snapshotDuringLoad;
    if (snapshotDuringLoad && (!applied || disconnectedDuringLoad)) full++;
    snapshotDuringLoad = disconnectedDuringLoad = false;
    schedule(readerRefreshDelay);
  };
  return {
    setActive(next: boolean) {
      active = next;
      clearTimeout(timer);
      timer = undefined;
      if (active) schedule(0);
    },
    request(cursor = 0, reconnect = false) {
      target = Math.max(target, cursor);
      if (reconnect) {
        if (loading) snapshotDuringLoad = true;
        else if (fresh) fresh = false;
        else full++;
      }
      schedule(readerRefreshDelay);
    },
    track(fullLoad: Promise<boolean | undefined>) {
      const id = ++load;
      const coveredFull = full;
      loading = true;
      fresh = false;
      clearTimeout(timer);
      timer = undefined;
      fullLoad.then(
        (applied) => settleLoad(id, !!applied, coveredFull),
        () => settleLoad(id, false, coveredFull)
      );
    },
    disconnected() {
      fresh = false;
      if (loading) disconnectedDuringLoad = true;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
