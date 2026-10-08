import { TransientNotice } from './TransientNotice.js';
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
  ['main', '본문 생성 완료'],
  ['failures', '확인이 필요한 작업 실패'],
  ['translation', '번역 완료·실패'],
  ['illustration', '삽화 완료·실패'],
  ['showTitle', '잠금 화면에 채팅 제목 표시'],
];
export function PushSettings() {
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
        setWarning('알림을 허용하지 않았어요. 브라우저의 사이트 알림 설정에서 변경할 수 있어요.');
        return;
      }
      const prepared = await api<PushInfo>('/push/prepare', { clientId });
      if (!prepared.publicKey) throw new Error('서버의 알림 키를 준비하지 못했어요.');
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
      setNotice('알림을 켰어요.');
    } catch (caught) {
      setError(
        (caught as Error).message || '알림을 켜지 못했어요. 연결과 브라우저 권한을 확인해 주세요.'
      );
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
      setNotice('알림을 껐어요.');
      try {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        await subscription?.unsubscribe();
      } catch {
        setNotice('');
        setWarning('서버 알림은 껐어요. 브라우저 연결 해제는 다음 접속 때 다시 확인해 주세요.');
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
      setNotice('테스트 알림을 발송 대기열에 넣었어요. 기기에서 수신되는지 확인해 주세요.');
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
    <section className="settings-service push-settings" aria-label="작업 완료 알림">
      <div className="settings-service-row">
        <div className="settings-service-copy">
          <h4>작업 완료 알림</h4>
          <p className="muted">작업이 끝나면 이 기기로 알려드려요.</p>
          {available && (
            <small role="status">{enabled ? '이 기기의 알림 켜짐' : '이 기기의 알림 꺼짐'}</small>
          )}
        </div>
        {available &&
          (enabled ? (
            <button type="button" disabled={busy} onClick={() => void disable()}>
              <BellOff size={16} aria-hidden="true" /> 알림 끄기
            </button>
          ) : permission === 'denied' ? (
            <button type="button" disabled={busy} onClick={recheck}>
              <RefreshCw size={16} aria-hidden="true" /> 권한 다시 확인
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void enable()}>
              <Bell size={16} aria-hidden="true" /> {busy ? '연결 중…' : '알림 켜기'}
            </button>
          ))}
      </div>
      {!supported && (
        <p className="muted">
          이 환경에서는 알림을 지원하지 않아요. HTTPS 또는 설치된 앱에서 확인해 주세요.
        </p>
      )}
      {info && !info.available && <p className="muted">{info.reason}</p>}
      {available && permission === 'denied' && (
        <p className="muted">브라우저의 사이트 설정에서 알림을 허용해 주세요.</p>
      )}
      {available && info.device && (
        <details className="push-options">
          <summary>알림 옵션</summary>
          <div className="push-preferences">
            {labels.map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={info.device!.preferences[key]}
                  disabled={busy}
                  onChange={(event) => void change(key, event.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
          <small className="muted">원고 내용은 보내지 않으며, 로그아웃하면 알림이 해제돼요.</small>
          <div className="settings-service-actions">
            {permission !== 'granted' && (
              <button
                type="button"
                disabled={busy}
                onClick={permission === 'denied' ? recheck : () => void enable()}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {permission === 'denied' ? '권한 다시 확인' : '알림 다시 연결'}
              </button>
            )}
            <button
              type="button"
              disabled={busy || permission !== 'granted'}
              onClick={() => void test()}
            >
              <Send size={16} aria-hidden="true" /> 테스트 알림 보내기
            </button>
          </div>
        </details>
      )}
      {info?.device?.lastError && <p role="status">{info.device.lastError}</p>}
      <TransientNotice message={notice} />
      {warning && <p role="status">{warning}</p>}
      {error && (
        <div className="settings-service-error">
          <p role="alert" className="error">
            {error}
          </p>
          <button type="button" disabled={busy} onClick={recheck}>
            <RefreshCw size={16} aria-hidden="true" /> 알림 연결 다시 확인
          </button>
        </div>
      )}
    </section>
  );
}
