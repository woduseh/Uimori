import { useState } from 'react';
import { branchLabel } from './storyLabels.js';
import type { StoryState } from './useStory.js';
import { api, labels } from './api.js';
import { ConnectionEditor } from './LibraryPanel.js';
import { ArchivePanel } from './ArchivePanel.js';
import { AttemptInspector } from './AttemptInspector.js';
import { RunIssue } from './RuntimeSettings.js';
import { JobCard } from './SourceReader.js';

export function TasksPanel({ state, inspectedRun, onInspect, onClose }: { state: StoryState; inspectedRun: string | null; onInspect: (runId: string) => void; onClose: () => void }) {
  const [pending, setPending] = useState<string[]>([]);
  const detail = state.detail;
  if (!detail) return <p className="muted">이야기를 열면 실행한 작업을 확인할 수 있어요.</p>;
  const runs = inspectedRun ? detail.runs.filter(run => run.id === inspectedRun) : detail.runs;
  const refresh = () => state.refresh(detail.chat.id);
  async function perform(key: string, operation: () => Promise<unknown>) { if (pending.includes(key)) return; setPending(old => [...old, key]); state.setError(''); try { await operation(); } catch (error) { state.setError((error as Error).message); } finally { setPending(old => old.filter(item => item !== key)); } }
  return <section className="tasks-panel" aria-label="실행 기록">
    <div className="panel-intro"><p className="muted">{detail.chat.title} · 이 화면을 닫아도 서버의 작업은 이어져요.</p>{inspectedRun && <button type="button" className="secondary" onClick={() => onInspect('')}>전체 작업 보기</button>}</div>
    {!state.connected && <p className="connection-notice" role="status">연결을 다시 확인하는 중이에요. 원격 작업의 상태는 아직 확정할 수 없어요.</p>}
    {!runs.length && <p className="muted">아직 실행한 작업이 없어요.</p>}
    <div className="runs">{runs.map(run => <article key={run.id} data-testid="run" data-run-id={run.id} className="run">
      <div className="task-heading"><strong>{run.snapshot.forkedFrom ? '복사한 원고' : `원문 ${labels[run.status]}`}</strong><small>{run.snapshot.profile?.models.main?.title || 'Scripted mock · 모의 생성'}</small></div>
      <p className="task-request">{run.request}</p>
      {run.error && <p className="error">{run.error}</p>}
      {run.status === 'refused' && <p className="error">요청에 대한 생성이 거절됐어요. 대체 원고를 자동 생성하지 않았어요.</p>}
      {run.partialText && <details className="partial-result"><summary>보존된 부분 출력 · 확정 원문에 합류하지 않음</summary><pre>{run.partialText}</pre></details>}
      {run.issue && <p className="error">요청 충실성 메모: {run.issue}</p>}
      <div className="form-actions">
        {run.sourceRevision && <button type="button" className="secondary" onClick={() => { const branch = detail.branches?.find(item => item.id === run.snapshot.branchId) ?? detail.branches?.find(item => item.default); if (branch && branch.id !== state.branch?.id) state.chooseBranch(branch.default ? '' : branch.id); else state.chooseSource(run.sourceRevision!); onClose(); }}>원고 읽기</button>}
        {(run.status === 'queued' || run.status === 'running' || run.status === 'waiting_for_state') && <button type="button" className="secondary" disabled={pending.includes(run.id)} onClick={() => { void perform(run.id, async () => { await api(`/runs/${run.id}/cancel`, {}); await refresh(); }); }}>원문 생성 취소</button>}
        {run.sourceRevision && <button type="button" className="secondary" disabled={pending.includes(run.id)} onClick={() => { void perform(run.id, async () => { await state.fork(run.sourceRevision!); }); }}>새 이야기로 이어가기</button>}
      </div>
      {run.sourceRevision && <small>여기까지 복사하고 새 이야기에서 이어 써요. 복사만으로 모델을 호출하지 않아요.</small>}
      <RunIssue run={run} refresh={refresh} onError={state.setError}/>
      {detail.jobs.filter(job => job.sourceRevision === run.sourceRevision).map(job => <JobCard key={job.id} job={job} refresh={refresh} onError={state.setError} hideText/>)}
      <details className="inspector" open={!!inspectedRun}><summary>실행과 실제 입력 확인</summary><p>Run {run.id} · 모델 호출 {run.usage.modelCalls}회 · 입력 {run.usage.inputTokens ?? '미확인'} / 출력 {run.usage.outputTokens ?? '미확인'} 토큰 · 비용 {run.usage.costUsd === null ? '미확인' : `$${run.usage.costUsd}`}</p><pre>{JSON.stringify({ snapshot: { parentRevision: run.parentRevision, settingsRevision: run.settingsRevision, settings: run.snapshot.settings, profile: run.snapshot.profile }, inputs: run.inputs, toolEvents: run.toolEvents, attempts: detail.attempts?.filter(attempt => attempt.runId === run.id) }, null, 2)}</pre></details>
    </article>)}</div>
    <AttemptInspector attempts={detail.attempts ?? []} runs={detail.runs}/>
  </section>;
}

export function BranchesPanel({ state, onClose }: { state: StoryState; onClose: () => void }) {
  const detail = state.detail;
  if (!detail) return <p className="muted">먼저 이야기를 열어 주세요.</p>;
  function preview(branchId: string, head: string | null) {
    const latestRun = detail!.runs.findLast(run => run.snapshot.branchId === branchId);
    if (latestRun && !latestRun.sourceRevision) return `새 응답 ${labels[latestRun.status]} · ${latestRun.request.slice(0, 90)}`;
    const source = detail!.sources.find(item => item.id === head);
    if (!source) return '아직 완성된 장면이 없어요.';
    const translation = detail!.jobs.findLast(job => job.sourceRevision === source.id && job.kind === 'translation' && job.status === 'completed' && job.result);
    const text = translation?.result?.segments?.map(segment => segment.text).join(' ') || translation?.result?.text || source.text;
    return text.replace(/\[\[p_[^\]]+\]\]/g, '').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  return <section className="branches-panel" aria-label="보관된 전개 목록">
    <p className="muted">이전에 저장한 전개를 읽어요. 새로 갈라 쓰려면 원고에서 ‘새 이야기로 이어가기’를 눌러요.</p>
    <div className="branch-list">{detail.branches?.map(branch => <button type="button" className={`secondary branch-choice ${state.branch?.id === branch.id ? 'selected' : ''}`} key={branch.id} onClick={() => {state.chooseBranch(branch.default ? '' : branch.id);onClose();}} aria-pressed={state.branch?.id === branch.id}><strong>{branchLabel(branch, detail)}</strong><small>{state.branch?.id === branch.id ? '읽는 중' : '이 전개 읽기'}</small><span className="branch-preview">{preview(branch.id, branch.headRevision)}</span></button>)}</div>
  </section>;

}

export function AppSettingsPanel({ state, theme, setTheme, enterSend, setEnterSend }: { state: StoryState; theme: 'system' | 'dark' | 'light'; setTheme: (theme: 'system' | 'dark' | 'light') => void; enterSend: boolean; setEnterSend: (value: boolean) => void }) {
  const [signingOut, setSigningOut] = useState(false);
  return <section className="app-settings-panel" aria-label="앱 설정">
    <section className="settings-section"><h3>화면과 입력</h3><label>화면 테마<select aria-label="앱 화면 테마" value={theme} onChange={event => setTheme(event.target.value as 'system' | 'dark' | 'light')}><option value="system">기기 설정 따르기</option><option value="dark">어둡게</option><option value="light">밝게</option></select></label><label className="check"><input type="checkbox" checked={enterSend} onChange={event => setEnterSend(event.target.checked)}/>Enter로 보내기</label><small>{enterSend ? 'Enter로 보내고 Shift+Enter로 줄을 바꿔요.' : 'Enter는 줄바꿈, Ctrl/Cmd+Enter는 보내기예요.'} 한글 조합 중에는 보내지 않아요.</small></section>
    <details className="workspace-tools" data-testid="connection-settings"><summary>연결과 모델</summary>{state.library ? <ConnectionEditor library={state.library} reload={state.loadLibrary} onError={state.setError}/> : <p role="status">연결 목록을 불러오는 중이에요…</p>}</details>
    <ArchivePanel onImported={async () => { await Promise.all([state.loadChats(), state.loadLibrary()]); if (state.selected) await state.refresh(state.selected); }} onError={state.setError}/>
    <section className="settings-section"><h3>접근 보안</h3><p className="muted">현재 브라우저의 접속 세션을 해제해요. 서버에서 진행 중인 생성은 취소되지 않아요.</p><button type="button" className="secondary" disabled={signingOut} onClick={() => { setSigningOut(true); void api('/session', {}, 'DELETE').then(() => location.reload()).catch(error => { state.setError(error.message); setSigningOut(false); }); }}>접속 해제</button></section>
  </section>;
}
