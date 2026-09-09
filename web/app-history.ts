type Listener = (event: PopStateEvent) => void;
type Interceptor = (event: PopStateEvent) => boolean;
const listeners = new Set<Listener>();
const interceptors: Interceptor[] = [];
let attached = false;

function dispatch(event: PopStateEvent) {
  for (const interceptor of [...interceptors].reverse()) {
    if (interceptor(event)) {
      event.stopImmediatePropagation();
      return;
    }
  }
  for (const listener of listeners) listener(event);
}
function attach() {
  if (attached) return;
  addEventListener('popstate', dispatch);
  attached = true;
}
function release() {
  if (listeners.size || interceptors.length) return;
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
  interceptors.push(handler);
  attach();
  return () => {
    const index = interceptors.lastIndexOf(handler);
    if (index >= 0) interceptors.splice(index, 1);
    release();
  };
}
