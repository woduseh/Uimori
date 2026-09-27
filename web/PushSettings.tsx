import './push-settings.css';
import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { DEFAULT_PUSH_PREFERENCES, type PushInfo, type PushPreferences } from '../core/push.js';
import { api } from './api.js';
import { pwaRegistration } from './pwa.js';
import { readingClientId } from './useReadingSync.js';

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
  const [clientId] = useState(readingClientId);
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
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
    try {
      // Invoke the permission UI in this user gesture, before a network round-trip.
      const granted =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
      setPermission(granted);
      if (granted !== 'granted') {
        setNotice('알림을 허용하지 않았어요. 브라우저의 사이트 알림 설정에서 변경할 수 있어요.');
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
      setNotice('이 기기의 알림을 켰어요. 원고 문장은 알림으로 보내지 않아요.');
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
    try {
      // Stop server sends first. Browser-side unsubscribe failure must not restore server consent.
      const saved = await api<PushInfo>(
        '/push/subscription',
        { clientId, expectedRevision: info.device.revision },
        'DELETE'
      );
      setInfo(saved);
      setNotice('이 기기로 보내는 서버 알림을 껐어요.');
      try {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        await subscription?.unsubscribe();
      } catch {
        setNotice('서버 알림은 껐어요. 브라우저 연결 해제는 다음 접속 때 다시 확인해 주세요.');
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
    try {
      await api('/push/test', { clientId });
      setNotice('테스트 알림을 발송 대기열에 넣었어요. 기기에서 수신되는지 확인해 주세요.');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card push-settings" aria-label="작업 완료 알림">
      <h3>
        <Bell size={18} aria-hidden="true" /> 작업 완료 알림
      </h3>
      <p>
        이 기기에서 직접 허용한 경우에만 알림을 보내요. 브라우저의 Push 중계를 이용하며, 기본
        알림에는 채팅 제목과 원고를 넣지 않아요.
      </p>
      {!supported && (
        <p className="muted">
          이 환경에서는 Web Push를 사용할 수 없어요. 지원되는 브라우저의 HTTPS 주소 또는 홈 화면에
          설치한 앱에서 확인해 주세요.
        </p>
      )}
      {info && !info.available && <p className="muted">{info.reason}</p>}
      {supported && info?.available && (
        <>
          <p role="status">{info.device ? '이 기기의 서버 알림 켜짐' : '이 기기의 알림 꺼짐'}</p>
          {permission === 'denied' && (
            <p className="muted">
              브라우저에서 알림이 차단돼 있어요. 사이트 알림 권한을 직접 변경한 뒤 다시 확인해
              주세요.
            </p>
          )}
          {info.device ? (
            <>
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
              <div className="archive-action-row">
                <button
                  type="button"
                  disabled={busy || permission !== 'granted'}
                  onClick={() => void test()}
                >
                  테스트 알림 보내기
                </button>
                <button type="button" disabled={busy} onClick={() => void disable()}>
                  <BellOff size={16} aria-hidden="true" /> 이 기기 알림 끄기
                </button>
              </div>
              {permission !== 'granted' && (
                <button
                  type="button"
                  disabled={busy || permission === 'denied'}
                  onClick={() => void enable()}
                >
                  브라우저 알림 다시 연결
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              disabled={busy || permission === 'denied'}
              onClick={() => void enable()}
            >
              {busy ? '알림 연결 중…' : '이 기기에서 알림 받기'}
            </button>
          )}
          {info.device?.lastError && <p role="status">{info.device.lastError}</p>}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => setRefresh((value) => value + 1)}
      >
        알림 연결 다시 확인
      </button>
      <p className="muted">
        로그아웃하면 이 로그인에 연결된 알림도 해제돼요. 취소한 작업과 내부 도구 호출은 알리지
        않아요. 알림 지연·미수신 때는 앱에 저장된 작업 상태를 확인해 주세요.
      </p>
    </section>
  );
}
