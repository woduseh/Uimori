import { useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { LanguageSelect } from './LanguageSelect.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import {
  api,
  ApiError,
  rememberMaintenance,
  sessionRequiredEvent,
  type MaintenanceStatus,
} from './api.js';

type Session = { required: boolean; authenticated: boolean; maintenance?: MaintenanceStatus };

export function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const signingIn = useRef(false);
  useEffect(() => {
    let alive = true;
    const refresh = async (expired = false) => {
      if (signingIn.current) return;
      const expected = ++revision.current;
      try {
        const next = await api<Session>('/session');
        rememberMaintenance(next.maintenance);
        if (alive && revision.current === expected) {
          setSession(next);
          setError(
            expired && next.required && !next.authenticated
              ? uiMessage('outside.sessionExpired')
              : ''
          );
        }
      } catch {
        if (alive && revision.current === expected) setError(uiMessage('outside.checkServer'));
      }
    };
    const expired = () => {
      // A delayed 401 may belong to a session already replaced by a new login.
      // Confirm current authority before unmounting the workspace.
      void refresh(true);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const online = () => {
      void refresh();
    };
    void refresh();
    window.addEventListener(sessionRequiredEvent, expired);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false;
      ++revision.current;
      window.removeEventListener(sessionRequiredEvent, expired);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  if (session && (!session.required || session.authenticated)) return <>{children}</>;
  return (
    <main className="login">
      <LanguageSelect />
      <a className="wordmark" href="/">
        Uimori
      </a>
      {session?.required && <h1>{t('outside.connectTitle')}</h1>}
      {!session && !error && (
        <LoadingState presentation="placeholder" label={t('outside.checkingWorkspace')} />
      )}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      {session?.required && (
        <form
          className="editor-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            if (signingIn.current) return;
            signingIn.current = true;
            ++revision.current;
            setBusy(true);
            setError('');
            try {
              await api('/session', { token });
              setToken('');
              const next = await api<Session>('/session');
              rememberMaintenance(next.maintenance);
              setSession(next);
            } catch (error) {
              setToken('');
              setError(
                error instanceof ApiError && error.status === 429
                  ? uiMessage('outside.tooManyConnections')
                  : uiMessage('outside.checkToken')
              );
            } finally {
              signingIn.current = false;
              setBusy(false);
            }
          }}
        >
          <label className="full">
            {t('outside.token')}
            <input
              aria-label={t('outside.token')}
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button disabled={busy}>{t('outside.connect')}</button>
          <small>{t('outside.tokenPrivacy')}</small>
        </form>
      )}
      {!session && !!error && (
        <button type="button" className="secondary" onClick={() => location.reload()}>
          {t('outside.reconnect')}
        </button>
      )}
    </main>
  );
}
