import { getLocale, localeChangedEvent, message as uiMessage } from './i18n.js';
import { notificationIntent, type NotificationIntent } from '../core/push.js';
type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type InstallState = { installed: boolean; available: boolean; error: string };
const listeners = new Set<() => void>();
let prompt: InstallPrompt | null = null;
let registration: Promise<ServiceWorkerRegistration> | null = null;
let snapshot: InstallState = { installed: false, available: false, error: '' };
const serverSnapshot: InstallState = { installed: false, available: false, error: '' };
const publish = (value: Partial<InstallState>) => {
  snapshot = { ...snapshot, ...value };
  for (const listener of listeners) listener();
};
export const subscribeInstall = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const installSnapshot = () => snapshot;
export const installServerSnapshot = () => serverSnapshot;

export function pwaRegistration(): Promise<ServiceWorkerRegistration> {
  if (!isSecureContext || !('serviceWorker' in navigator))
    return Promise.reject(new Error(uiMessage('outside.securePwa')));
  if (!registration)
    registration = navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch(() => {
        registration = null;
        throw new Error(uiMessage('outside.pwaFailure'));
      });
  return registration;
}
export async function promptInstall() {
  if (!prompt) return;
  const current = prompt;
  prompt = null;
  publish({ available: false, error: '' });
  try {
    await current.prompt();
    await current.userChoice;
  } catch {
    publish({ error: uiMessage('outside.installRetry') });
  }
  // The appinstalled event, not a possibly accepted prompt, confirms installation.
}

let notificationConsumer: ((intent: NotificationIntent) => void) | null = null;
let pendingNotification: NotificationIntent | null = null;
export function subscribeNotificationNavigation(consumer: (intent: NotificationIntent) => void) {
  notificationConsumer = consumer;
  if (pendingNotification) {
    const pending = pendingNotification;
    queueMicrotask(() => {
      if (notificationConsumer === consumer && pendingNotification === pending) {
        pendingNotification = null;
        consumer(pending);
      }
    });
  }
  return () => {
    if (notificationConsumer === consumer) notificationConsumer = null;
  };
}

/** Presentation only: no subscription, permission request, navigation or task mutation. */
export function syncPwaLocale(locale = getLocale()) {
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifest)
    manifest.href =
      locale === 'ko' ? '/manifest.webmanifest' : '/manifest.' + locale + '.webmanifest';
  if (!isSecureContext || !('serviceWorker' in navigator)) return;
  const send = (worker: ServiceWorker | null) =>
    worker?.postMessage({ type: 'uimori:ui-language', locale: getLocale() });
  void pwaRegistration()
    .then((registered) => {
      send(registered.active);
      const worker = registered.installing ?? registered.waiting;
      if (worker) {
        send(worker);
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') send(worker);
        });
      }
    })
    .catch(() => {});
  // The first install may have no active worker yet.
  void navigator.serviceWorker.ready.then((registered) => send(registered.active)).catch(() => {});
}

export function startPwa() {
  syncPwaLocale();
  window.addEventListener(localeChangedEvent, () => syncPwaLocale());
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (!event.source || !('scriptURL' in event.source)) return;
      const source = new URL(event.source.scriptURL);
      if (
        source.origin !== location.origin ||
        source.pathname !== '/sw.js' ||
        event.data?.type !== 'uimori:notification-open'
      )
        return;
      const intent = notificationIntent(event.data.payload);
      if (!intent) return;
      if (notificationConsumer) notificationConsumer(intent);
      else pendingNotification = intent;
    });
  const standalone = matchMedia('(display-mode: standalone)');
  const installed = () =>
    standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  publish({ installed: installed() });
  standalone.addEventListener('change', () => publish({ installed: installed() }));
  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    prompt = event as InstallPrompt;
    publish({ available: true });
  });
  addEventListener('appinstalled', () => {
    prompt = null;
    publish({ installed: true, available: false, error: '' });
  });
  // Registration does not request notification permission and installs no offline fetch cache.
  const register = () => {
    void pwaRegistration().catch(() => {});
  };
  if (document.readyState === 'complete') register();
  else addEventListener('load', register, { once: true });
}
