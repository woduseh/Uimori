import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Chat, ChatDetail, Run, Settings, Source } from '../core/types.js';
import type { Branch, Library } from '../core/product.js';
import { api, labels } from './api.js';
import { LibraryPanel } from './LibraryPanel.js';
import { ProfileEditor } from './ProfileEditor.js';
import { SourceReader } from './SourceReader.js';
import { ArchivePanel } from './ArchivePanel.js';
import { AssetEditor } from './AssetEditor.js';
import { SessionGate } from './SessionGate.js';
import { AttemptInspector } from './AttemptInspector.js';
import './style.css';
import './product.css';

function initialView() {
  const params = new URLSearchParams(location.search);
  const chat = params.get('chat') || '';
  return { chat, branch: params.get('branch') || sessionStorage.getItem(`branch:${chat}`) || '', source: params.get('source') || '' };
}
function ancestry(sources: Source[], head: string | null) {
  const byId = new Map(sources.map(source => [source.id, source])); const seen = new Set<string>(); const result: Source[] = [];
  while (head && !seen.has(head)) { seen.add(head); const source = byId.get(head); if (!source) break; result.unshift(source); head = source.parentRevision; }
  return result;
}

function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selected, setSelected] = useState(() => initialView().chat);
  const [viewedBranch, setViewedBranch] = useState(() => initialView().branch);
  const [readSource, setReadSource] = useState(() => initialView().source);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const current = useRef(selected);
  const refreshVersion = useRef(0);
  const restoredView = useRef('');
  current.current = selected;
  const refresh = useCallback(async (id: string) => {
    if (current.current !== id) return;
    const version = ++refreshVersion.current;
    const value = await api<ChatDetail>(`/chats/${id}`);
    if (current.current === id && refreshVersion.current === version) setDetail(value);
  }, []);
  const loadChats = useCallback(async () => setChats(await api<Chat[]>('/chats')), []);
  const loadLibrary = useCallback(async () => setLibrary(await api<Library>('/library')), []);
  useEffect(() => { void Promise.all([loadChats(), loadLibrary()]).catch(e => setError(e.message)); }, [loadChats, loadLibrary]);
  useEffect(() => {
    setDetail(null); setError(''); setConnected(false);
    if (!selected) return;
    let alive = true;
    void refresh(selected).catch(e => { if (alive) setError(e.message); });
    const stream = new EventSource(`/api/chats/${selected}/events`);
    stream.onopen = () => { if (alive) setConnected(true); };
    stream.onerror = () => { if (alive) setConnected(false); };
    stream.onmessage = () => { if (alive) void refresh(selected).catch(e => setError(e.message)); };
    return () => { alive = false; stream.close(); };
  }, [selected, refresh]);
  const viewKey = `${selected}:${viewedBranch}`;
  const draftKey = `draft:${selected}${viewedBranch ? `:${viewedBranch}` : ''}`;
  useEffect(() => { setDraft(sessionStorage.getItem(draftKey) || ''); }, [draftKey]);
  useEffect(() => {
    const record = () => { if (selected && restoredView.current === viewKey) sessionStorage.setItem(`scroll:${viewKey}`, String(scrollY)); };
    addEventListener('scroll', record, { passive: true });
    return () => { record(); removeEventListener('scroll', record); };
  }, [selected, viewKey]);
  useEffect(() => {
    const onPop = () => { const view = initialView(); setSelected(view.chat); setViewedBranch(view.branch); setReadSource(view.source); };
    addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop);
  }, []);
  const setViewUrl = (chat: string, branch = '', source = '') => { const params = new URLSearchParams({ chat }); if (branch) params.set('branch', branch); if (source) params.set('source', source); history.pushState(null, '', `?${params}`); };
  const select = (id: string) => { const branch = sessionStorage.getItem(`branch:${id}`) || ''; setViewUrl(id, branch); setSelected(id); setViewedBranch(branch); setReadSource(''); };
  const chooseBranch = (id: string) => { setViewUrl(selected, id); sessionStorage.setItem(`branch:${selected}`, id); setViewedBranch(id); setReadSource(''); };
  const branch = detail?.branches?.find(item => item.id === viewedBranch) ?? detail?.branches?.find(item => item.default);
  const sources = detail ? branch ? ancestry(detail.sources, branch.headRevision) : detail.sources : [];
  const visibleRuns = detail?.runs.filter(run => !branch || !run.snapshot.branchId && branch.default || run.snapshot.branchId === branch.id) ?? [];
  useEffect(() => {
    if (!detail || detail.chat.id !== selected || restoredView.current === viewKey) return;
    restoredView.current = viewKey;
    requestAnimationFrame(() => {
      const target = readSource && document.getElementById(`source-${readSource}`);
      if (target) target.scrollIntoView({ block: 'start' }); else scrollTo({ top: Number(sessionStorage.getItem(`scroll:${viewKey}`) || 0), behavior: 'instant' });
    });
  }, [detail, selected, viewKey, readSource]);
  async function createChat(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const chat = await api<Chat>('/chats', { title: title.trim() }); await loadChats(); select(chat.id); setTitle(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function generate(event: React.FormEvent) {
    event.preventDefault(); if (!detail || !draft.trim()) return;
    const chat = detail.chat;
    const payload = { request: draft, expectedRevision: branch ? branch.headRevision : chat.headRevision, expectedSettingsRevision: chat.settingsRevision, ...(viewedBranch && branch ? { branchId: branch.id } : {}), ...(detail.profile ? { expectedProfileRevision: detail.profile.revision } : {}) };
    // A lost HTTP response can be retried with the identical logical command.
    const key = `command:${chat.id}${viewedBranch ? `:${viewedBranch}` : ''}`;
    const previous = JSON.parse(sessionStorage.getItem(key) || 'null') as { payload: string; id: string } | null;
    const serialized = JSON.stringify(payload);
    const idempotencyKey = previous?.payload === serialized ? previous.id : crypto.randomUUID();
    sessionStorage.setItem(key, JSON.stringify({ payload: serialized, id: idempotencyKey }));
    setBusy(true); setError('');
    try { await api(`/chats/${chat.id}/runs`, { ...payload, idempotencyKey }); await refresh(chat.id); }
    catch (e) { setError((e as Error).message); await refresh(chat.id).catch(() => undefined); }
    finally { setBusy(false); }
  }
  async function createBranch(sourceId: string) {
    const next = await api<Branch>(`/chats/${selected}/branches`, { title: `분기 ${(detail?.branches?.length ?? 0) + 1}`, fromRevision: sourceId });
    await refresh(selected); if (current.current === selected) chooseBranch(next.id);
  }
  async function candidate(run: Run) {
    const result = await api<Run>(`/runs/${run.id}/candidate`, { idempotencyKey: crypto.randomUUID() });
    await refresh(run.chatId); if (current.current === run.chatId && result.snapshot.branchId) chooseBranch(result.snapshot.branchId);
  }
  const active = visibleRuns.find(r => r.status === 'queued' || r.status === 'running');
  const profileAsset = detail?.assets?.find(asset => asset.allowedUse !== 'inline');
  return <div className="shell">
    <header className="masthead"><a href="/" className="wordmark">Uimori<span>NARRATIVE RUNTIME</span></a><div className="header-actions"><span className="badge">M1 · 로컬 fixture</span><button className="secondary small-button" onClick={() => { void api('/session', {}, 'DELETE').then(() => location.reload()).catch(error => setError(error.message)); }}>접속 해제</button></div></header>
    <div className="workspace">
      <aside className="library"><p className="eyebrow">나의 작업실</p><h1>이야기를 이어가는 곳</h1><p className="muted">원문을 먼저 읽고, 번역과 표시 상태는 준비되는 대로 확인해요.</p>
        <nav aria-label="채팅 목록">{chats.map(chat => <button key={chat.id} className={`chat-link ${selected === chat.id ? 'selected' : ''}`} onClick={() => select(chat.id)}>{chat.title}<span>이야기 열기 ↗</span></button>)}</nav>
        <form onSubmit={createChat} className="new-chat"><label htmlFor="title">새 이야기 이름</label><input id="title" value={title} maxLength={100} onChange={e => setTitle(e.target.value)} placeholder="예: 등대의 편지" required/><button disabled={busy || !title.trim()}>이야기 만들기</button></form>
        <p className="footnote">현재 연결은 로컬 검사용이에요. 실모델·실제 폰·외부 공개 검증은 별도로 진행해요.</p>
      </aside>
      <main>{error && <div role="alert" className="error">{error}</div>}
      <LibraryPanel library={library} reload={loadLibrary} onError={setError}/>
      <ArchivePanel onImported={async () => { await Promise.all([loadChats(), loadLibrary()]); if (selected) await refresh(selected); }} onError={setError}/>
      {!selected ? <section className="empty"><span className="folio">01 / 시작</span><h2>아직 쓰이지 않은<br/>다음 장면.</h2><p>이야기를 만들고 짧은 장면 요청으로 시작해 보세요.</p></section> : !detail ? <p role="status">이야기를 불러오는 중이에요…</p> : <>
        <div className="chapter-heading"><div className="chapter-title">{profileAsset && <img className="profile-asset" data-testid="profile-asset" src={profileAsset.url} alt={profileAsset.description || profileAsset.title}/>}<div><span className="eyebrow">WORK IN PROGRESS</span><h2>{detail.chat.title}</h2></div></div><span className="connection">{connected ? '● 연결됨' : '○ 재연결 중'}</span></div>
        <SettingsEditor key={detail.chat.id} chat={detail.chat} onSaved={() => refresh(detail.chat.id)} onError={setError}/>
        {detail.profile && library && <ProfileEditor key={detail.chat.id} profile={detail.profile} library={library} onSaved={() => refresh(detail.chat.id)} onError={setError}/>}
        <AssetEditor key={`assets:${detail.chat.id}`} chatId={detail.chat.id} assets={detail.assets ?? []} refresh={() => refresh(detail.chat.id)} onError={setError}/>
        {!!detail.branches?.length && <section className="branch-navigation" aria-label="분기 탐색"><label>읽고 이어갈 분기<select aria-label="읽고 이어갈 분기" value={branch?.default ? '' : branch?.id ?? ''} onChange={event => chooseBranch(event.target.value)}>{detail.branches.map(item => <option key={item.id} value={item.default ? '' : item.id}>{item.title}{item.default ? ' · 기본' : ''}</option>)}</select></label><label>읽을 원문<select aria-label="읽을 원문" value={sources.some(source => source.id === readSource) ? readSource : ''} onChange={event => { const id = event.target.value; setReadSource(id); setViewUrl(selected, viewedBranch, id); if (id) document.getElementById(`source-${id}`)?.scrollIntoView({ block: 'start' }); }}><option value="">분기 전체</option>{sources.map((source, index) => <option key={source.id} value={source.id}>원문 {index + 1} · {source.text.slice(0, 28)}</option>)}</select></label><small>보기와 독서 위치는 이 탭에만 저장돼요. 분기를 선택해도 다른 탭의 보기는 움직이지 않아요.</small></section>}
        <section className="reader" aria-label="원고">
          {!sources.length && <p className="muted">첫 요청을 보내면 이곳에 원문이 남아요. 탭을 닫아도 서버에서 진행돼요.</p>}
          {sources.map((source, index) => <SourceReader key={source.id} source={source} index={index} jobs={detail.jobs.filter(job => job.sourceRevision === source.id)} assets={detail.assets ?? []} refresh={() => refresh(detail.chat.id)} onError={setError} onBranch={createBranch}/>)}
        </section>
        <section className="runs" aria-label="실행 기록">{visibleRuns.map(run => <div key={run.id} data-testid="run" data-run-id={run.id} className="run">
          <div><strong>원문 {labels[run.status]}</strong><span className="muted"> · {run.snapshot.settings.preset === 'calm' ? '차분한 서술' : '선명한 서술'}</span></div>
          {run.error && <p className="error">{run.error}</p>}
          {run.partialText && <details className="partial-result"><summary>보존된 부분 출력 · 확정 원문에 합류하지 않음</summary><pre>{run.partialText}</pre></details>}
          {run.issue && <p className="error">요청 충실성 메모: {run.issue}</p>}
          <RunIssue run={run} refresh={() => refresh(detail.chat.id)} onError={setError}/>
          {(run.status === 'queued' || run.status === 'running') && <button className="secondary" onClick={() => { void api(`/runs/${run.id}/cancel`, {}).then(() => refresh(detail.chat.id)).catch(e => setError(e.message)); }}>원문 생성 취소</button>}
          {run.status === 'completed' && <button className="secondary" onClick={() => { void candidate(run).catch(error => setError(error.message)); }}>같은 요청의 다른 후보 생성</button>}
          <details className="inspector"><summary>실행과 실제 입력 확인</summary><p>Run {run.id} · 모델 호출 {run.usage.modelCalls}회 · 입력 {run.usage.inputTokens ?? '미확인'} / 출력 {run.usage.outputTokens ?? '미확인'} 토큰 · 비용 {run.usage.costUsd === null ? '미확인' : `$${run.usage.costUsd}`}</p><pre>{JSON.stringify({ snapshot: { parentRevision: run.parentRevision, settingsRevision: run.settingsRevision, settings: run.snapshot.settings, profile: run.snapshot.profile }, inputs: run.inputs, toolEvents: run.toolEvents, attempts: detail.attempts?.filter(attempt => attempt.runId === run.id) }, null, 2)}</pre></details>
        </div>)}</section>
        <AttemptInspector attempts={detail.attempts ?? []} runs={detail.runs}/>
        <form onSubmit={generate} className="composer"><label htmlFor="request">다음 장면 요청</label><textarea id="request" rows={4} maxLength={4000} value={draft} onChange={e => { setDraft(e.target.value); sessionStorage.setItem(draftKey, e.target.value); }} placeholder="(OOC: ...) 장면과 인물의 행동을 요청해 보세요."/><div><small>현재 분기: {branch?.title || '기본 이야기'}. 서버가 실행을 보관하므로 기다리는 동안 다른 이야기를 읽어도 돼요.</small><button disabled={busy || !!active || !draft.trim()}>{active ? '서버에서 생성 중…' : '원문 생성'}</button></div></form>
      </>}</main>
    </div><footer>Uimori · 원문과 그 곁의 기록들</footer>
  </div>;
}

function RunIssue({ run, refresh, onError }: { run: Run; refresh: () => Promise<void>; onError: (error: string) => void }) {
  const [note, setNote] = useState(run.issue ?? '');
  const [busy, setBusy] = useState(false);
  return <details className="inspector"><summary>요청 충실성 기록</summary><form className="editor-grid" onSubmit={async event => { event.preventDefault(); setBusy(true); try { await api(`/runs/${run.id}/issue`, { note }); await refresh(); } catch (error) { onError((error as Error).message); } finally { setBusy(false); } }}><label className="full">요청 충실성 메모<textarea aria-label="요청 충실성 메모" rows={2} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="전제·인물·장르가 달라진 부분을 기록해요."/></label><button className="secondary" disabled={busy}>메모 저장</button><small>메모는 원문을 자동 수정하거나 삭제하지 않아요.</small></form></details>;
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
createRoot(document.getElementById('root')!).render(<SessionGate><App/></SessionGate>);
