type Listener = (event: PopStateEvent) => void;
type Interceptor = (event: PopStateEvent) => boolean;
const listeners = new Set<Listener>();
let interceptor: Interceptor | undefined;
let attached = false;

function dispatch(event: PopStateEvent) {
  if (interceptor?.(event)) {
    event.stopImmediatePropagation();
    return;
  }
  for (const listener of listeners) listener(event);
}
function attach() {
  if (attached) return;
  addEventListener('popstate', dispatch);
  attached = true;
}
function release() {
  if (listeners.size || interceptor) return;
  removeEventListener('popstate', dispatch);
  attached = false;
}
export function subscribeAppHistory(listener: Listener) {
  listeners.add(listener);
  attach();
  return () => {
    listeners.delete(listener);
    release();
  };
}
/** Modal handling runs before route subscribers, regardless of lazy panel mount order. */
export function interceptAppHistory(handler: Interceptor) {
  interceptor = handler;
  attach();
  return () => {
    if (interceptor === handler) interceptor = undefined;
    release();
  };
}
