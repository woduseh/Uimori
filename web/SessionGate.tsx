import { useI18n } from './i18n.js';
import { uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { LanguageSelect } from './LanguageSelect.js';
import { createContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import type { MaintenanceStatus } from '#contracts';
import { api, ApiError, rememberMaintenance, sessionRequiredEvent } from './api.js';

type Session = { required: boolean; authenticated: boolean; maintenance?: MaintenanceStatus };

export const SessionRequiredContext = createContext(false);

export function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<UiMessage | null>(null);
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
              : null
          );
        }
      } catch {
        if (alive && revision.current === expected) setError(uiMessage('outside.checkServer'));
      }
    };
    const expired = () => {
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
  if (session && (!session.required || session.authenticated))
    return (
      <SessionRequiredContext.Provider value={session.required}>
        {children}
      </SessionRequiredContext.Provider>
    );
  return (
    <main className="login">
      <a className="wordmark" href="/">
        Uimori
      </a>
      {session?.required && <h1>{t('outside.connectTitle')}</h1>}
      {!session && !error && (
        <LoadingState presentation="placeholder" label={uiMessage('outside.checkingWorkspace')} />
      )}
      {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
      {session?.required && (
        <form
          className="editor-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            if (signingIn.current) return;
            signingIn.current = true;
            ++revision.current;
            setBusy(true);
            setError(null);
            try {
              await api('/session', { token });
              setToken('');
              const next = await api<Session>('/session');
              rememberMaintenance(next.maintenance);
              setSession(next);
            } catch (error) {
              const rejected = error instanceof ApiError && error.status === 401;
              if (rejected) setToken('');
              setError(
                rejected
                  ? uiMessage('outside.checkToken')
                  : error instanceof ApiError && error.status === 429
                    ? uiMessage('outside.tooManyConnections')
                    : toUiMessage(error, 'outside.checkServer')
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
              autoFocus
              required
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? t('shared.working') : t('outside.connect')}
          </button>
        </form>
      )}
      {!session && !!error && (
        <button type="button" className="secondary" onClick={() => location.reload()}>
          {t('outside.reconnect')}
        </button>
      )}
      <LanguageSelect />
    </main>
  );
}
