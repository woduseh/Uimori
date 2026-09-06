import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api.js';

export function SessionGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<{ required: boolean; authenticated: boolean } | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<{ required: boolean; authenticated: boolean }>('/session').then(setSession).catch(() => setError('서버 연결을 확인해 주세요.')); }, []);
  if (session && (!session.required || session.authenticated)) return <>{children}</>;
  return <main className="login"><a className="wordmark" href="/">Uimori</a><h1>{session?.required ? '개인 작업실에 연결' : '작업실 연결 확인 중'}</h1>{error && <p role="alert" className="error">{error}</p>}
    {session?.required && <form className="editor-grid" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await api('/session', { token }); setToken(''); setSession(await api('/session')); } catch { setToken(''); setError('접속 토큰을 확인해 주세요.'); } finally { setBusy(false); } }}><label className="full">접속 토큰<input aria-label="접속 토큰" type="password" autoComplete="off" required value={token} onChange={event => setToken(event.target.value)}/></label><button disabled={busy}>작업실 연결</button><small>토큰은 이 입력창에서만 사용하고 브라우저 저장소에 보관하지 않아요.</small></form>}
  </main>;
}
