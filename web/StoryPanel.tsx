import { useEffect, useRef, useState } from 'react';
import type { ContentRef, ModelPreset } from '../core/product.js';
import type { StateModule } from '../core/state.js';
import type { MemoryEntry } from '../core/memory.js';
import type { StoryConfig, StoryDetail, StoryJob, StoryState } from '../core/story.js';
import { api, ApiError, labels } from './api.js';
import './story.css';

type PanelProps = { chatId: string; branchId: string; headRevision: string | null; settingsRevision: number; profileRevision?: number; models: ModelPreset[]; onChanged: () => void; onError: (message: string) => void };
const id = encodeURIComponent;
const refKey = (value: ContentRef | null) => value ? `${value.id}@${value.revision}` : '';
const pending = (jobs: StoryJob[]) => jobs.some(job => job.status === 'queued' || job.status === 'running');
const readiness: Record<string, string> = { disabled: '사용 안 함', ready: '준비됨', pending: '상태 확인 중', stale: '이전 원고의 상태', historical: '이전 원고에 연결된 상태', completed: '확인 완료' };
const memoryNames: Record<MemoryEntry['kind'], string> = { 'author-canon': '작가 선언', 'observed-story': '본문에서 확인한 사실', 'derived-summary': '요약', preference: '선호', 'character-belief': '인물의 믿음 · 사실과 구분', hypothesis: '가설 · 미확정' };
const sampleModule: StateModule = { id: 'synthetic-harbor', revision: 1, name: '합성 항구 예제', mode: 'authoritative', fields: { coins: { type: 'number', initial: 10, min: 0, max: 100, description: '합성 시험용 동전' } }, rules: { 'buy-ticket': { field: 'coins', delta: -3 } } };

/** Result guards cover navigation during reads, writes, file reads, and teardown. */
function useScope(key: string) {
  const scope = useRef({ key, alive: true, generation: 0 });
  if (scope.current.key !== key) { scope.current.key = key; scope.current.generation++; }
  useEffect(() => { scope.current.alive = true; return () => { scope.current.alive = false; }; }, []);
  return () => { const captured = scope.current.generation; return () => scope.current.alive && scope.current.generation === captured; };
}

function ModelChoice({ label, value, models, onChange }: { label: string; value: ContentRef | null; models: ModelPreset[]; onChange: (value: ContentRef | null) => void }) {
  const selected = refKey(value);
  return <label>{label}<select value={selected} onChange={event => { const model = models.find(item => refKey(item) === event.target.value); onChange(model ? { id: model.id, revision: model.revision } : null); }}>
    <option value="">모의 처리 · 실제 모델 호출 없음</option>
    {selected && !models.some(model => refKey(model) === selected) && <option value={selected}>보관된 선택 · {value!.id} v{value!.revision}</option>}
    {models.map(model => <option key={refKey(model)} value={refKey(model)}>{model.title} · {model.modelId} · v{model.revision}</option>)}
  </select></label>;
}

function StateValues({ state }: { state: StoryState | null }) {
  if (!state) return <p className="muted">아직 연결된 상태가 없어요.</p>;
  return <><small>{state.canonical ? '원고에 반영된 상태' : '참고 상태'}</small><dl className="story-state-values">{Object.entries(state.values).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'boolean' ? value ? '예' : '아니요' : String(value)}</dd></div>)}</dl></>;
}

function JobList({ jobs, busy, act, rebuild }: { jobs: StoryJob[]; busy: boolean; act?: (path: string) => void; rebuild?: (sourceId: string, kind: 'state' | 'memory') => void }) {
  return <ul className="story-records">{jobs.map(job => <li key={job.id}><div><strong>{job.kind === 'state' ? '상태 확인' : '기억 정리'}</strong> · {labels[job.status] ?? job.status}{job.mock && <small> · 모의 처리</small>}</div>
    {job.error && <p className="error">{job.error}</p>}
    {act && <div className="form-actions">{['failed', 'interrupted', 'cancelled'].includes(job.status) && <button type="button" className="secondary" disabled={busy} onClick={() => act(`/story-jobs/${id(job.id)}/retry`)}>다시 시도</button>}{job.status === 'stale' && rebuild && <button type="button" className="secondary" disabled={busy} onClick={() => rebuild(job.sourceRevision, job.kind)}>최신 원문으로 다시 확인</button>}{['queued', 'running'].includes(job.status) && <button type="button" className="secondary" disabled={busy} onClick={() => act(`/story-jobs/${id(job.id)}/cancel`)}>작업 취소</button>}</div>}
  </li>)}</ul>;
}

export function StoryPanel(props: PanelProps) {
  return <StoryPanelEditor key={`${props.chatId}/${props.branchId}`} {...props}/>;
}

function StoryPanelEditor({ chatId, branchId, headRevision, settingsRevision, profileRevision, models, onChanged, onError }: PanelProps) {
  const capture = useScope(JSON.stringify([chatId, branchId, headRevision, settingsRevision, profileRevision]));
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [draft, setDraft] = useState<StoryConfig | null>(null);
  const dirty = useRef(false); const request = useRef(0); const actionLock = useRef(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [confirmReset, setConfirmReset] = useState<number | null>(null);
  const [author, setAuthor] = useState(''); const [declaration, setDeclaration] = useState(''); const [retcon, setRetcon] = useState<string | null>(null);
  const [commandLabel, setCommandLabel] = useState(''); const [commandText, setCommandText] = useState('');
  const commandKey = useRef(crypto.randomUUID());
  const runKeys = useRef(new Map<string, string>());
  const base = `/chats/${id(chatId)}`;
  function report(caught: unknown) { const text = caught instanceof Error ? caught.message : '작업을 완료하지 못했어요.'; setError(text); onError(text); }
  async function load() {
    const valid = capture(), sequence = ++request.current;
    try { const result = await api<StoryDetail>(`${base}/story?branchId=${id(branchId)}`); if (!valid() || sequence !== request.current) return; setDetail(result); if (!dirty.current) setDraft(result.config); }
    catch (caught) { if (valid() && sequence === request.current) report(caught); }
  }
  useEffect(() => { actionLock.current = false; setBusy(false); setConfirmReset(null); setDetail(null); void load(); }, [chatId, branchId, headRevision, settingsRevision, profileRevision]);
  useEffect(() => { if (!detail || !(pending(detail.jobs) || detail.commands.some(command => command.status === 'pending' && command.runId))) return; const timer = setInterval(() => { void load(); }, 1500); return () => clearInterval(timer); }, [detail, chatId, branchId, headRevision]);
  function change(next: StoryConfig) { dirty.current = true; setDraft(next); setConfirmReset(null); setMessage(''); }
  async function act(path: string, body: unknown = {}, success?: () => void, method = 'POST') {
    if (actionLock.current) return;
    const valid = capture(); actionLock.current = true; setBusy(true); setError(''); setMessage('');
    try { await api(path, body, method); if (!valid()) return; success?.(); await load(); if (valid()) { setMessage('반영했어요.'); onChanged(); } }
    catch (caught) { if (valid()) { report(caught); if (caught instanceof ApiError && caught.status === 409) await load(); } }
    finally { if (valid()) { actionLock.current = false; setBusy(false); } }
  }
  async function importModule(file: File | undefined) {
    if (!file || !draft) return;
    const valid = capture();
    try {
      if (file.size > 100_000) throw new Error('상태 정의 파일은 100KB 이하로 선택해 주세요.');
      const parsed = JSON.parse(await file.text()) as StateModule;
      if (!valid()) return;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string' || typeof parsed.id !== 'string' || !Number.isSafeInteger(parsed.revision) || !['annotation', 'continuity', 'authoritative'].includes(parsed.mode) || !parsed.fields || typeof parsed.fields !== 'object' || Array.isArray(parsed.fields) || !parsed.rules || typeof parsed.rules !== 'object' || Array.isArray(parsed.rules)) throw new Error('상태 정의 형식을 확인해 주세요. 이름·필드·규칙이 있는 JSON 파일이 필요해요.');
      dirty.current = true; setDraft(current => current ? { ...current, module: parsed } : current); setMessage('불러온 내용을 확인한 뒤 저장해 주세요. 아직 적용하지 않았어요.');
    } catch (caught) { if (valid()) report(caught); }
  }
  function runCommand(commandId: string) {
    const key = runKeys.current.get(commandId) ?? crypto.randomUUID(); runKeys.current.set(commandId, key);
    void act(`/scene-commands/${id(commandId)}/run`, { expectedRevision: headRevision, expectedSettingsRevision: settingsRevision, ...(profileRevision === undefined ? {} : { expectedProfileRevision: profileRevision }), idempotencyKey: key }, () => { runKeys.current.delete(commandId); });
  }
  return <section className="story-panel" aria-label="이야기 상태와 기억"><h3>상태와 기억</h3><p className="muted">필요한 기능만 켜고 다음 원고부터 적용해요. 상태 확인과 기억 정리는 각각 모델을 선택해요.</p>
    {error && <p className="error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!draft ? <button type="button" className="secondary" onClick={() => void load()}>설정 불러오기</button> : <form onSubmit={event => { event.preventDefault(); void act(`${base}/story/config`, { expectedRevision: draft.revision, branchId, module: draft.module, stateModel: draft.stateModel, memory: draft.memory }, () => { dirty.current = false; }, 'PUT'); }}>
      <fieldset className="editor-fields editor-grid" disabled={busy}><legend>다음 원고에 적용할 설정</legend>
        <div className="full"><strong>상태 정의</strong><p>{draft.module ? draft.module.name : '사용 안 함 · 상태 정의를 선택하면 사용할 수 있어요.'}</p><div className="form-actions"><label className="story-file">JSON 파일 불러오기<input type="file" accept=".json,application/json" aria-label="상태 정의 JSON 파일" onChange={event => { void importModule(event.target.files?.[0]); event.target.value = ''; }}/></label>{draft.module && <button type="button" className="secondary" onClick={() => change({ ...draft, module: null })}>상태 사용 안 함</button>}</div>
          <details><summary>합성 예제 살펴보기</summary><p>항구의 동전 10개에서 표를 사면 3개를 빼는 시험용 예제예요. 아래 버튼은 초안에만 넣어요.</p><button type="button" className="secondary" onClick={() => change({ ...draft, module: structuredClone(sampleModule) })}>합성 항구 예제를 초안에 넣기</button></details>
          {draft.module && <div className="story-module-preview"><h4>저장 전 미리보기</h4><p>{draft.module.name} · {({ annotation: '표시용', continuity: '연속성 참고', authoritative: '규칙에 따른 상태 관리' })[draft.module.mode]}</p><p>필드 {Object.keys(draft.module.fields).length}개 · 변화 규칙 {Object.keys(draft.module.rules).length}개</p><pre>{JSON.stringify(draft.module, null, 2)}</pre></div>}
        </div>
        <ModelChoice label="상태 확인 모델" value={draft.stateModel} models={models} onChange={stateModel => change({ ...draft, stateModel })}/>
        <label className="check"><input type="checkbox" checked={draft.memory.enabled} onChange={event => change({ ...draft, memory: { ...draft.memory, enabled: event.target.checked } })}/>기억 자동 정리 사용</label>
        <ModelChoice label="기억 정리 모델" value={draft.memory.model} models={models} onChange={model => change({ ...draft, memory: { ...draft.memory, model } })}/>
        <details className="full"><summary>기억 분량 설정</summary><div className="editor-grid"><label>원문으로 유지할 최근 장면 수<input type="number" min={0} max={20} value={draft.memory.recentCount} onChange={event => change({ ...draft, memory: { ...draft.memory, recentCount: Number(event.target.value) } })}/></label><label>기억 입력 최대 글자 수<input type="number" min={1000} max={200000} value={draft.memory.maxPacketChars} onChange={event => change({ ...draft, memory: { ...draft.memory, maxPacketChars: Number(event.target.value) } })}/></label></div></details>
        <div className="form-actions full"><button className="secondary" disabled={!dirty.current}>상태와 기억 설정 저장</button>{dirty.current && detail && draft.revision !== detail.config.revision && <div><p role="alert">저장된 설정이 바뀌었어요. 입력한 내용은 유지했어요. 현재 설정을 확인한 뒤 다시 저장해 주세요.</p><details><summary>현재 저장된 설정 확인</summary><p>상태: {detail.config.module?.name ?? '사용 안 함'} · 기억: {detail.config.memory.enabled ? '사용' : '사용 안 함'}</p><pre className="story-text-preview">{JSON.stringify(detail.config, null, 2)}</pre></details><button type="button" className="secondary" onClick={() => { change({ ...draft, revision: detail.config.revision }); setMessage(`저장된 설정 v${detail.config.revision}을 기준으로 현재 초안을 다시 저장할 수 있어요.`); }}>현재 설정을 확인했어요 · 내 초안 유지</button></div>}</div>
      </fieldset>
    </form>}
    {detail && <><section><h4>현재 분기 상태 · {readiness[detail.stateStatus] ?? detail.stateStatus}</h4><StateValues state={detail.state}/>
      {detail.config.module && <div className="story-reset-state">{confirmReset !== detail.config.revision ? <><button type="button" className="secondary" disabled={busy || dirty.current} onClick={() => setConfirmReset(detail.config.revision)}>현재 장면에서 초기값으로 새 기준 적용</button>{dirty.current && <small>작성 중인 설정을 먼저 저장하면 새 기준을 적용할 수 있어요.</small>}</> : <div role="group" aria-label="상태 새 기준 적용 확인"><p>현재 분기의 이 장면에서 <strong>{detail.config.module.name}</strong>의 초기값으로 다시 시작해요. 이전 원문과 과거 상태는 보존해요.</p><p>이 이야기의 설정 버전이 바뀌고, 상태 확인을 기다리던 요청은 취소돼요. 아래 초기값을 확인한 뒤 적용해 주세요.</p><dl className="story-state-values">{Object.entries(detail.config.module.fields).map(([name, field]) => <div key={name}><dt>{name}</dt><dd>{String(field.initial)}</dd></div>)}</dl><div className="form-actions"><button type="button" className="secondary" disabled={busy || dirty.current} onClick={() => void act(`${base}/story/config`, { expectedRevision: detail.config.revision, branchId, module: detail.config.module, stateModel: detail.config.stateModel, memory: detail.config.memory, resetState: true }, () => { setConfirmReset(null); }, 'PUT')}>확인했어요 · 초기값으로 새 기준 적용</button><button type="button" className="secondary" disabled={busy} onClick={() => setConfirmReset(null)}>적용 취소</button></div></div>}</div>}
    </section>
      <details open={detail.jobs.some(job => ['failed', 'stale', 'interrupted'].includes(job.status))}><summary>상태·기억 작업 {detail.jobs.length}개</summary><JobList jobs={detail.jobs} busy={busy} act={path => void act(path)} rebuild={(sourceId, kind) => void act(`/sources/${id(sourceId)}/story/rebuild`, { kind })}/>{!detail.jobs.length && <p className="muted">아직 실행한 작업이 없어요.</p>}</details>
      <details><summary>기억과 작가 선언 {detail.memory.length}개</summary><p>인물의 믿음과 가설은 확인된 사실과 구분해요. 작가 선언은 직접 입력한 내용만 저장해요.</p>{detail.config.memory.enabled && headRevision && <button type="button" className="secondary" disabled={busy || detail.jobs.some(job => job.kind === 'memory' && ['queued', 'running'].includes(job.status))} onClick={() => void act(`${base}/story/index`, { branchId })}>기존 원고의 기억 정리</button>}<ul className="story-records">{detail.memory.map(entry => <li key={entry.id}><strong>{memoryNames[entry.kind]}</strong>{'actor' in entry && <span> · {entry.actor}</span>}<p>{entry.text}</p>{entry.kind === 'author-canon' && <><small>작성자: {entry.declaration.author}</small><button type="button" className="secondary" disabled={busy} onClick={() => { setRetcon(entry.id); setDeclaration(entry.text); setAuthor(entry.declaration.author); }}>이 선언 고치기</button></>}</li>)}</ul>
        <form className="editor-grid" onSubmit={event => { event.preventDefault(); void act(`${base}/story/memory${retcon ? `/${id(retcon)}/retcon` : ''}`, { text: declaration, author, branchId }, () => { setDeclaration(''); setRetcon(null); }); }}><label>선언 작성자<input required maxLength={160} value={author} onChange={event => setAuthor(event.target.value)} disabled={busy}/></label><label className="full">{retcon ? '기존 선언을 대신할 작가 선언' : '새 작가 선언'}<textarea required maxLength={10000} value={declaration} onChange={event => setDeclaration(event.target.value)} disabled={busy}/></label><div className="form-actions full"><button className="secondary" disabled={busy || !author.trim() || !declaration.trim()}>{retcon ? '수정 선언 저장' : '작가 선언 추가'}</button>{retcon && <button type="button" className="secondary" disabled={busy} onClick={() => { setRetcon(null); setDeclaration(''); }}>수정 취소</button>}</div></form>
      </details>
      <details><summary>장면 예약 {detail.commands.length}개</summary><p>이 분기에서 실행할 장면을 예약해요. 원고가 성공적으로 완성되면 사용 완료로 표시해요.</p><ul className="story-records">{detail.commands.map(command => <li key={command.id}><strong>{command.label}</strong> · {({ pending: '예약됨', consumed: '사용 완료', failed: '실패 · 재시도 가능', cancelled: '취소됨' })[command.status]}<p>{command.request}</p>{['pending', 'failed'].includes(command.status) && <div className="form-actions"><button type="button" className="secondary" disabled={busy || Boolean(command.runId && command.status === 'pending')} onClick={() => runCommand(command.id)}>{command.runId && command.status === 'pending' ? '실행 요청됨' : '이 장면 쓰기'}</button><button type="button" className="secondary" disabled={busy} onClick={() => void act(`/scene-commands/${id(command.id)}/cancel`)}>예약 취소</button></div>}</li>)}</ul>
        <form className="editor-grid" onSubmit={event => { event.preventDefault(); void act(`${base}/scene-commands`, { label: commandLabel, request: commandText, branchId, idempotencyKey: commandKey.current }, () => { setCommandLabel(''); setCommandText(''); commandKey.current = crypto.randomUUID(); }); }}><label>예약 이름<input required maxLength={160} value={commandLabel} onChange={event => { setCommandLabel(event.target.value); commandKey.current = crypto.randomUUID(); }} disabled={busy}/></label><label className="full">장면 요청<textarea required maxLength={10000} value={commandText} onChange={event => { setCommandText(event.target.value); commandKey.current = crypto.randomUUID(); }} disabled={busy}/></label><button className="secondary" disabled={busy || !commandLabel.trim() || !commandText.trim()}>장면 예약 추가</button></form>
      </details></>}
  </section>;
}

export function StorySourceState({ sourceId, refreshKey }: { sourceId: string; refreshKey?: unknown }) {
  return <SourceState key={sourceId} sourceId={sourceId} refreshKey={refreshKey}/>;
}
function SourceState({ sourceId, refreshKey }: { sourceId: string; refreshKey?: unknown }) {
  const refresh = useRef({ value: refreshKey, generation: 0 });
  if (!Object.is(refresh.current.value, refreshKey)) { refresh.current.value = refreshKey; refresh.current.generation++; }
  const capture = useScope(`${sourceId}/${refresh.current.generation}`); const generation = useRef(0);
  const [detail, setDetail] = useState<{ state: StoryState | null; status: string; jobs: StoryJob[] } | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [pattern, setPattern] = useState(''); const [flags, setFlags] = useState('g'); const [replacement, setReplacement] = useState(''); const [preview, setPreview] = useState<string | null>(null);
  async function load() { const valid = capture(), current = ++generation.current; try { const next = await api<NonNullable<typeof detail>>(`/sources/${id(sourceId)}/story`); if (valid() && generation.current === current) { setDetail(next); setError(''); } } catch (caught) { if (valid() && generation.current === current) setError((caught as Error).message); } }
  useEffect(() => { setBusy(false); void load(); }, [sourceId, refreshKey]);
  useEffect(() => { if (!detail || !pending(detail.jobs)) return; const timer = setInterval(() => { void load(); }, 1500); return () => clearInterval(timer); }, [detail, sourceId]);
  return <div className="story-source-state">{error && <p role="alert" className="error">{error}<button type="button" className="secondary" onClick={() => void load()}>다시 확인</button></p>}{detail && detail.status !== 'disabled' && <details><summary>이 원고의 상태 · {readiness[detail.status] ?? detail.status}</summary><StateValues state={detail.state}/><JobList jobs={detail.jobs} busy={busy}/></details>}
    <details><summary>표시 문구 바꾸기</summary><p className="muted">원문을 보존하는 텍스트 미리보기예요. 정규식 치환은 입력한 문자열을 그대로 넣어요($1 등 치환 기호 미지원). HTML도 글자로 표시해요.</p><form className="editor-grid" onSubmit={async event => { event.preventDefault(); if (busy) return; const valid = capture(); setBusy(true); setPreview(null); setError(''); try { const result = await api<{ ok: boolean; text: string; error?: string }>(`/sources/${id(sourceId)}/presentation`, { rules: [{ pattern, flags, replacement }] }); if (valid()) { setPreview(result.text); if (!result.ok) setError(`표시 변환을 적용하지 못했어요. 원문을 유지해요. (${result.error ?? '오류'})`); } } catch (caught) { if (valid()) setError((caught as Error).message); } finally { if (valid()) setBusy(false); } }}><label>찾을 정규식<input required maxLength={512} value={pattern} onChange={event => setPattern(event.target.value)} disabled={busy}/></label><label>옵션 (g, i, m, s, u)<input maxLength={5} value={flags} onChange={event => setFlags(event.target.value)} disabled={busy}/></label><label className="full">넣을 문자열<input maxLength={2048} value={replacement} onChange={event => setReplacement(event.target.value)} disabled={busy}/></label><button className="secondary" disabled={busy || !pattern}>{busy ? '미리보기 만드는 중' : '텍스트 미리보기'}</button></form>{preview !== null && <pre className="story-text-preview" aria-label="표시 문구 미리보기">{preview}</pre>}</details>
  </div>;
}
