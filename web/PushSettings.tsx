import { useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { LoadingState } from './LoadingState.js';
import './push-settings.css';
import { useEffect, useState } from 'react';
import { Bell, BellOff, RefreshCw, Send } from 'lucide-react';
import { DEFAULT_PUSH_PREFERENCES, type PushInfo, type PushPreferences } from '../core/push.js';
import { api } from './api.js';
import { pwaRegistration } from './pwa.js';
import { browserClientId } from './browser-client.js';

function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const decoded = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
const labels: [keyof PushPreferences, string][] = [
  ['main', 'outside.prefMain'],
  ['failures', 'outside.prefFailure'],
  ['translation', 'outside.prefTranslation'],
  ['illustration', 'outside.prefIllustration'],
  ['showTitle', 'outside.prefTitle'],
];
export function PushSettings() {
  const { t } = useI18n();
  const [clientId] = useState(browserClientId);
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [refresh, setRefresh] = useState(0);
  const supported =
    isSecureContext &&
    'Notification' in window &&
    'PushManager' in window &&
    'serviceWorker' in navigator;
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    supported ? Notification.permission : 'default'
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is an explicit read after an uncertain save; it never re-subscribes or requests permission.
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<PushInfo>(
      `/push?${new URLSearchParams({ clientId })}`,
      undefined,
      'GET',
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setInfo(value);
          setError('');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught.message);
      });
    if (supported) setPermission(Notification.permission);
    return () => controller.abort();
  }, [clientId, refresh, supported]);
  async function enable() {
    if (!supported || busy || !info?.available) return;
    setBusy(true);
    setError('');
    setNotice('');
    setWarning('');
    try {
      // Invoke the permission UI in this user gesture, before a network round-trip.
      const granted =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
      setPermission(granted);
      if (granted !== 'granted') {
        setWarning(uiMessage('outside.permissionDeclined'));
        return;
      }
      const prepared = await api<PushInfo>('/push/prepare', { clientId });
      if (!prepared.publicKey) throw new Error(uiMessage('outside.pushKeyFailure'));
      await pwaRegistration();
      const registration = await navigator.serviceWorker.ready;
      const key = applicationKey(prepared.publicKey);
      let subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const existing = subscription.options.applicationServerKey;
        const bytes = existing ? new Uint8Array(existing) : null;
        if (
          !bytes ||
          bytes.length !== key.length ||
          bytes.some((value, index) => value !== key[index])
        ) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      const saved = await api<PushInfo>('/push/subscription', {
        clientId,
        expectedRevision: prepared.device?.revision ?? 0,
        subscription: subscription.toJSON(),
        preferences: prepared.device?.preferences ?? DEFAULT_PUSH_PREFERENCES,
      });
      setInfo(saved);
      setNotice(uiMessage('outside.pushOn'));
    } catch (caught) {
      setError((caught as Error).message || uiMessage('outside.pushFailure'));
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    if (!info?.device || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setWarning('');
    try {
      // Stop server sends first. Browser-side unsubscribe failure must not restore server consent.
      const saved = await api<PushInfo>(
        '/push/subscription',
        { clientId, expectedRevision: info.device.revision },
        'DELETE'
      );
      setInfo(saved);
      setNotice(uiMessage('outside.pushOff'));
      try {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        await subscription?.unsubscribe();
      } catch {
        setNotice('');
        setWarning(uiMessage('outside.unsubscribeFailure'));
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function change(key: keyof PushPreferences, value: boolean) {
    if (!info?.device || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setWarning('');
    try {
      setInfo(
        await api<PushInfo>(
          '/push/subscription',
          {
            clientId,
            expectedRevision: info.device.revision,
            preferences: { ...info.device.preferences, [key]: value },
          },
          'PUT'
        )
      );
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    if (!info?.device || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setWarning('');
    try {
      await api('/push/test', { clientId });
      setNotice(uiMessage('outside.testQueued'));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const enabled = !!info?.device;
  const available = supported && info?.available;
  const recheck = () => setRefresh((value) => value + 1);
  return (
    <section className="settings-service push-settings" aria-label={t('outside.pushTitle')}>
      <div className="settings-service-row">
        <div className="settings-service-copy">
          <h4>{t('outside.pushTitle')}</h4>
          {available && (
            <small role="status">{enabled ? t('outside.deviceOn') : t('outside.deviceOff')}</small>
          )}
        </div>
        {available &&
          (enabled ? (
            <button type="button" disabled={busy} onClick={() => void disable()}>
              <BellOff size={16} aria-hidden="true" /> {t('outside.disablePush')}
            </button>
          ) : permission === 'denied' ? (
            <button type="button" disabled={busy} onClick={recheck}>
              <RefreshCw size={16} aria-hidden="true" /> {t('outside.checkPermission')}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void enable()}>
              <Bell size={16} aria-hidden="true" />{' '}
              {busy ? t('outside.connecting') : t('outside.enablePush')}
            </button>
          ))}
      </div>
      {supported && !info && !error && (
        <LoadingState presentation="placeholder" label={t('outside.loadingPush')} />
      )}
      {!supported && <p className="muted">{t('outside.unsupportedPush')}</p>}
      {info && !info.available && <p className="muted">{translateMessage(info.reason ?? '')}</p>}
      {available && permission === 'denied' && <p className="muted">{t('outside.allowPush')}</p>}
      {available && info.device && (
        <details className="push-options">
          <summary>{t('outside.pushOptions')}</summary>
          <div className="push-preferences">
            {labels.map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={info.device!.preferences[key]}
                  disabled={busy}
                  onChange={(event) => void change(key, event.target.checked)}
                />
                {t(label)}
              </label>
            ))}
          </div>
          <small className="muted">{t('outside.pushPrivacy')}</small>
          <div className="settings-service-actions">
            {permission !== 'granted' && (
              <button
                type="button"
                disabled={busy}
                onClick={permission === 'denied' ? recheck : () => void enable()}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {permission === 'denied'
                  ? t('outside.checkPermission')
                  : t('outside.reconnectPush')}
              </button>
            )}
            <button
              type="button"
              disabled={busy || permission !== 'granted'}
              onClick={() => void test()}
            >
              <Send size={16} aria-hidden="true" /> {t('outside.sendTest')}
            </button>
          </div>
        </details>
      )}
      {info?.device?.lastError && (
        <NoticeBanner tone="error">{translateMessage(info.device.lastError)}</NoticeBanner>
      )}
      <TransientNotice message={notice} />
      {warning && <NoticeBanner>{translateMessage(warning)}</NoticeBanner>}
      {error && (
        <NoticeBanner
          tone="error"
          actions={
            <button type="button" disabled={busy} onClick={recheck}>
              <RefreshCw size={16} aria-hidden="true" /> {t('outside.recheckPush')}
            </button>
          }
        >
          {translateMessage(error)}
        </NoticeBanner>
      )}
    </section>
  );
}
