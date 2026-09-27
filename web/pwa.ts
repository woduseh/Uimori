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
    return Promise.reject(
      new Error('이 환경에서는 앱 설치·알림을 준비할 수 없어요. HTTPS 주소로 열어 주세요.')
    );
  if (!registration)
    registration = navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch(() => {
        registration = null;
        throw new Error('앱 서비스를 준비하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
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
    publish({ error: '브라우저의 앱 설치 메뉴에서 다시 시도해 주세요.' });
  }
  // The appinstalled event, not a possibly accepted prompt, confirms installation.
}

export function startPwa() {
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
