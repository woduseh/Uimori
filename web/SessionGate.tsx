import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, sessionRequiredEvent } from './api.js';

type Session = { required: boolean; authenticated: boolean };

export function SessionGate({ children }: { children: ReactNode }) {
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
        if (alive && revision.current === expected) {
          setSession(next);
          setError(expired && next.required && !next.authenticated ? '접속이 만료됐어요. 토큰을 입력해 다시 연결해 주세요.' : '');
        }
      } catch {
        if (alive && revision.current === expected) setError('서버 연결을 확인해 주세요.');
      }
    };
    const expired = () => {
      // A delayed 401 may belong to a session already replaced by a new login.
      // Confirm current authority before unmounting the workspace.
      void refresh(true);
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const online = () => { void refresh(); };
    void refresh();
    window.addEventListener(sessionRequiredEvent, expired);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false; ++revision.current;
      window.removeEventListener(sessionRequiredEvent, expired);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  if (session && (!session.required || session.authenticated)) return <>{children}</>;
  return <main className="login"><a className="wordmark" href="/">Uimori</a><h1>{session?.required ? '개인 작업실에 연결' : '작업실 연결 확인 중'}</h1>{error && <p role="alert" className="error">{error}</p>}
    {session?.required && <form className="editor-grid" onSubmit={async event => {
      event.preventDefault(); if (signingIn.current) return;
      signingIn.current = true; ++revision.current; setBusy(true); setError('');
      try { await api('/session', { token }); setToken(''); setSession(await api<Session>('/session')); }
      catch (error) { setToken(''); setError(error instanceof ApiError && error.status === 429 ? '접속 시도가 많아요. 잠시 후 다시 연결해 주세요.' : '접속 토큰을 확인해 주세요.'); }
      finally { signingIn.current = false; setBusy(false); }
    }}><label className="full">접속 토큰<input aria-label="접속 토큰" type="password" autoComplete="off" required value={token} onChange={event => setToken(event.target.value)}/></label><button disabled={busy}>작업실 연결</button><small>토큰은 이 입력창에서만 사용하고 브라우저 저장소에 보관하지 않아요.</small></form>}
    {!session && <button type="button" className="secondary" onClick={() => location.reload()}>다시 연결</button>}
  </main>;
}
