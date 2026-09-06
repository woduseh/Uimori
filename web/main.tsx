import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Chat, ChatDetail, Job, Settings } from '../core/types.js';
import './style.css';

async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 409) throw new Error('다른 요청이 먼저 반영됐어요. 최신 내용을 확인한 뒤 다시 시도해 주세요.');
    const message = response.status >= 500 ? '서버 작업을 완료하지 못했어요.' : '요청을 처리할 수 없어요.';
    throw new Error(`${message} (${response.status})`);
  }
  return response.json() as Promise<T>;
}
const labels: Record<string, string> = { queued: '대기', running: '진행 중', completed: '완료', failed: '실패', cancelled: '취소됨', interrupted: '서버 중단 · 자동 재생성 안 함', stale: '이전 자료의 결과' };

function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get('chat') || '');
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const current = useRef(selected);
  const refreshVersion = useRef(0);
  current.current = selected;
  const refresh = useCallback(async (id: string) => {
    if (current.current !== id) return;
    const version = ++refreshVersion.current;
    const value = await api<ChatDetail>(`/chats/${id}`);
    if (current.current === id && refreshVersion.current === version) setDetail(value);
  }, []);
  const loadChats = useCallback(async () => setChats(await api<Chat[]>('/chats')), []);
  useEffect(() => { void loadChats().catch(e => setError(e.message)); }, [loadChats]);
  useEffect(() => {
    setDetail(null); setError(''); setConnected(false);
    setDraft(sessionStorage.getItem(`draft:${selected}`) || '');
    if (!selected) return;
    let alive = true;
    void refresh(selected).catch(e => { if (alive) setError(e.message); });
    const stream = new EventSource(`/api/chats/${selected}/events`);
    stream.onopen = () => { if (alive) setConnected(true); };
    stream.onerror = () => { if (alive) setConnected(false); };
    stream.onmessage = () => { if (alive) void refresh(selected).catch(e => setError(e.message)); };
    return () => { alive = false; stream.close(); };
  }, [selected, refresh]);
  useEffect(() => {
    const onPop = () => setSelected(new URLSearchParams(location.search).get('chat') || '');
    addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop);
  }, []);
  const select = (id: string) => { history.pushState(null, '', `?chat=${encodeURIComponent(id)}`); setSelected(id); };
  async function createChat(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const chat = await api<Chat>('/chats', { title: title.trim() }); await loadChats(); select(chat.id); setTitle(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function generate(event: React.FormEvent) {
    event.preventDefault(); if (!detail || !draft.trim()) return;
    const chat = detail.chat;
    const payload = { request: draft, expectedRevision: chat.headRevision, expectedSettingsRevision: chat.settingsRevision };
    // A lost HTTP response can be retried with the identical logical command.
    const key = `command:${chat.id}`;
    const previous = JSON.parse(sessionStorage.getItem(key) || 'null') as { payload: string; id: string } | null;
    const serialized = JSON.stringify(payload);
    const idempotencyKey = previous?.payload === serialized ? previous.id : crypto.randomUUID();
    sessionStorage.setItem(key, JSON.stringify({ payload: serialized, id: idempotencyKey }));
    setBusy(true); setError('');
    try { await api(`/chats/${chat.id}/runs`, { ...payload, idempotencyKey }); await refresh(chat.id); }
    catch (e) { setError((e as Error).message); await refresh(chat.id).catch(() => undefined); }
    finally { setBusy(false); }
  }
  const active = detail?.runs.find(r => r.status === 'queued' || r.status === 'running');
  return <div className="shell">
    <header className="masthead"><a href="/" className="wordmark">여백<span>NARRATIVE RUNTIME</span></a><span className="badge">M0 · 모든 생성은 모의 실행</span></header>
    <div className="workspace">
      <aside className="library"><p className="eyebrow">나의 작업실</p><h1>이야기를 이어가는 곳</h1><p className="muted">원문을 먼저 읽고, 번역과 표시 상태는 준비되는 대로 확인해요.</p>
        <nav aria-label="채팅 목록">{chats.map(chat => <button key={chat.id} className={`chat-link ${selected === chat.id ? 'selected' : ''}`} onClick={() => select(chat.id)}>{chat.title}<span>이야기 열기 ↗</span></button>)}</nav>
        <form onSubmit={createChat} className="new-chat"><label htmlFor="title">새 이야기 이름</label><input id="title" value={title} maxLength={100} onChange={e => setTitle(e.target.value)} placeholder="예: 등대의 편지" required/><button disabled={busy || !title.trim()}>이야기 만들기</button></form>
        <p className="footnote">합성 자료로 실행하는 로컬 프로토타입이에요. 실제 작품·API 키는 입력하지 마세요.</p>
      </aside>
      <main>{error && <div role="alert" className="error">{error}</div>}
      {!selected ? <section className="empty"><span className="folio">01 / 시작</span><h2>아직 쓰이지 않은<br/>다음 장면.</h2><p>이야기를 만들고 짧은 장면 요청으로 시작해 보세요.</p></section> : !detail ? <p role="status">이야기를 불러오는 중이에요…</p> : <>
        <div className="chapter-heading"><div><span className="eyebrow">WORK IN PROGRESS</span><h2>{detail.chat.title}</h2></div><span className="connection">{connected ? '● 연결됨' : '○ 재연결 중'}</span></div>
        <SettingsEditor key={detail.chat.id} chat={detail.chat} onSaved={() => refresh(detail.chat.id)} onError={setError}/>
        <section className="reader" aria-label="원고">
          {!detail.sources.length && <p className="muted">첫 요청을 보내면 이곳에 원문이 남아요. 탭을 닫아도 서버에서 진행돼요.</p>}
          {detail.sources.map((source, i) => <article className="source" key={source.id} data-testid="source" data-source-id={source.id}>
            <div className="source-heading"><span className="folio">{String(i + 1).padStart(2, '0')} / 원문</span><small>확정된 원고</small></div>
            <div className="prose" data-testid="source-text">{source.text}</div>
            <div className="derived">{detail.jobs.filter(j => j.sourceRevision === source.id).map(job => <JobCard key={job.id} job={job} refresh={() => refresh(detail.chat.id)} onError={setError}/>)}</div>
            <details className="inspector"><summary>원문 연결 정보</summary><dl><dt>source revision</dt><dd>{source.id}</dd><dt>parent revision</dt><dd>{source.parentRevision || '시작'}</dd><dt>SHA-256</dt><dd>{source.hash}</dd></dl></details>
          </article>)}
        </section>
        <section className="runs" aria-label="실행 기록">{detail.runs.map(run => <div key={run.id} data-testid="run" data-run-id={run.id} className="run">
          <div><strong>원문 {labels[run.status]}</strong><span className="muted"> · {run.snapshot.settings.preset === 'calm' ? '차분한 서술' : '선명한 서술'}</span></div>
          {run.error && <p className="error">{run.error}</p>}
          {(run.status === 'queued' || run.status === 'running') && <button className="secondary" onClick={() => { void api(`/runs/${run.id}/cancel`, {}).then(() => refresh(detail.chat.id)).catch(e => setError(e.message)); }}>원문 생성 취소</button>}
          <details className="inspector"><summary>실행과 실제 입력 확인</summary><p>Run {run.id} · 모델 호출 {run.usage.modelCalls}회 · 사용량/비용 미계측 (mock)</p><pre>{JSON.stringify({ snapshot: { parentRevision: run.parentRevision, settingsRevision: run.settingsRevision, settings: run.snapshot.settings }, inputs: run.inputs, toolEvents: run.toolEvents }, null, 2)}</pre></details>
        </div>)}</section>
        <form onSubmit={generate} className="composer"><label htmlFor="request">다음 장면 요청</label><textarea id="request" rows={4} maxLength={4000} value={draft} onChange={e => { setDraft(e.target.value); sessionStorage.setItem(`draft:${selected}`, e.target.value); }} placeholder="(OOC: ...) 장면과 인물의 행동을 요청해 보세요."/><div><small>서버가 실행을 보관해요. 결과를 기다리는 동안 다른 이야기를 읽어도 돼요.</small><button disabled={busy || !!active || !draft.trim()}>{active ? '서버에서 생성 중…' : '원문 생성'}</button></div></form>
      </>}</main>
    </div><footer>여백 · 원문과 그 곁의 기록들</footer>
  </div>;
}

function SettingsEditor({ chat, onSaved, onError }: { chat: Chat; onSaved: () => Promise<void>; onError: (e: string) => void }) {
  const [value, setValue] = useState<Settings>(chat.settings);
  const [revision, setRevision] = useState(chat.settingsRevision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!dirty) { setValue(chat.settings); setRevision(chat.settingsRevision); } }, [chat.settings, chat.settingsRevision, dirty]);
  function update<K extends keyof Settings>(key: K, v: Settings[K]) { setDirty(true); setValue(old => ({ ...old, [key]: v })); }
  return <details className="settings"><summary>이야기 설정 <small>저장된 설정 v{chat.settingsRevision}</small></summary><form onSubmit={async e => { e.preventDefault(); setSaving(true); try { await api(`/chats/${chat.id}/settings`, { ...value, expectedSettingsRevision: revision }, 'PATCH'); setDirty(false); onError(''); await onSaved(); } catch (error) { onError((error as Error).message); } finally { setSaving(false); } }}>
    <label>서술 프리셋<select aria-label="서술 프리셋" value={value.preset} onChange={e => update('preset', e.target.value as Settings['preset'])}><option value="calm">차분한 서술</option><option value="vivid">선명한 서술</option></select></label>
    <label>모의 생성 경로<select aria-label="모의 생성 경로" value={value.mode} onChange={e => update('mode', e.target.value as Settings['mode'])}><option value="direct">바로 쓰기 · 도구 없음</option><option value="research">로컬 자료 조사 후 쓰기</option></select></label>
    <label className="check"><input type="checkbox" checked={value.translation} onChange={e => update('translation', e.target.checked)}/>모의 한국어 번역</label><label className="check"><input type="checkbox" checked={value.status} onChange={e => update('status', e.target.checked)}/>모의 표시 상태</label>
    <button className="secondary" disabled={saving || !dirty}>설정 저장</button>{dirty && <button type="button" className="secondary" onClick={() => { setValue(chat.settings); setRevision(chat.settingsRevision); setDirty(false); onError(''); }}>저장된 설정 다시 불러오기</button>}<small>저장한 설정은 다음 실행에 적용돼요.</small>
  </form></details>;
}
function JobCard({ job, refresh, onError }: { job: Job; refresh: () => Promise<void>; onError: (e: string) => void }) {
  return <section className="job" data-testid={`job-${job.kind}`} data-source-id={job.sourceRevision}>
    <h3>{job.kind === 'translation' ? '모의 한국어 번역' : '모의 표시 상태'} <small>{labels[job.status]}</small></h3>
    {job.result && <p>{job.result.text || job.result.label}</p>}
    {job.error && <p className="error">보조 작업이 실패했어요. 원문은 보존돼요.</p>}
    {job.status === 'failed' && <button className="secondary" onClick={() => { void api(`/jobs/${job.id}/retry`, {}).then(refresh).catch(e => onError(e.message)); }}>이 작업만 재시도</button>}
    {job.kind === 'status' && <small>표시용 annotation · 다음 이야기의 사실에 반영하지 않아요.</small>}
  </section>;
}
createRoot(document.getElementById('root')!).render(<App/>);
