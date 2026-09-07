import { useEffect, useRef, useState } from 'react';
import { compilePromptProgram, resolvePromptValues, validateChatPromptControls, validatePromptProgram, type ChatPromptControls, type PromptBlock, type PromptCompilation, type PromptControl, type PromptExpression, type PromptProgram, type PromptTemplate, type PromptValue } from '../core/prompt-program.js';
import { api, saveDownload } from './api.js';
import './prompt-composer.css';

type Props = {
  program: PromptProgram;
  onChange: (program: PromptProgram) => void;
  onError: (message: string) => void;
  chatId?: string;
  branchId?: string;
  role?: 'main' | 'translation';
  controlState?: ChatPromptControls;
  onSaveControls?: (state: ChatPromptControls) => Promise<void>;
};
type Preview = { compilation: PromptCompilation; provider: { protocol: string; modelId: string; kind?:'exact-request-body'|'mapping-only';body?:unknown;messages?: unknown; system?: unknown; options?: unknown; diagnostics?: unknown } | null; error?: string };
const emptyControls = (): ChatPromptControls => ({ values: {}, combinations: [] });
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const roleLabels = { system: 'system · 지침', user: 'user · 사용자', assistant: 'assistant · 응답' };
const kindLabels = { message: '메시지', slot: '참조 자료', history: '대화 범위', current: '현재 입력', cache: '캐시 기준점' };
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function createDefaultPromptProgram(text: string): PromptProgram {
  return { version: 1, controls: [], blocks: [
    { id: 'instructions', title: '역할 지침', kind: 'message', role: 'system', template: [{ kind: 'text', text }] },
    { id: 'bot', title: '봇 설정', kind: 'slot', role: 'system', slot: 'description' },
    { id: 'persona', title: '페르소나', kind: 'slot', role: 'system', slot: 'persona' },
    { id: 'lorebook', title: '로어', kind: 'slot', role: 'system', slot: 'lorebook' },
    { id: 'memory', title: '기억', kind: 'slot', role: 'user', slot: 'memory' },
    { id: 'history', title: '현재 입력을 포함한 대화', kind: 'history', from: 0, to: 'end' },
  ] };
}
function freshBlock(kind: PromptBlock['kind'], id = newId('block'), title = '새 블록'): PromptBlock {
  if (kind === 'message') return { id, title, kind, role: 'system', template: [{ kind: 'text', text: '' }], completion: 'complete' };
  if (kind === 'slot') return { id, title, kind, role: 'system', slot: 'description' };
  if (kind === 'history') return { id, title, kind, from: 0, to: 'end' };
  if (kind === 'cache') return { id, title, kind, depth: 1, role: 'all', policy: 'prefer' };
  return { id, title, kind };
}

/** Each JSON field owns its unaccepted text. Failed parsing never changes the applied value. */
function JsonDraft({ label, value, onApply, onError, allowEmpty = false }: { label: string; value: unknown; onApply: (value: unknown) => void; onError: (message: string) => void; allowEmpty?: boolean }) {
  const serialized = value === undefined ? '' : pretty(value);
  const [draft, setDraft] = useState(serialized);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const original = useRef(serialized);
  useEffect(() => { if (!dirty) { setDraft(serialized); original.current = serialized; } }, [serialized, dirty]);
  function apply() {
    try { const parsed = allowEmpty && !draft.trim() ? undefined : JSON.parse(draft); onApply(parsed); setDirty(false); setError(''); }
    catch (caught) { const message = errorMessage(caught); setError(message); onError(message); }
  }
  return <div className="pc-json"><label>{label}<textarea aria-label={label} spellCheck={false} value={draft} onChange={event => { setDraft(event.target.value); setDirty(true); setError(''); }} /></label>
    {dirty && original.current !== serialized && <p className="muted">적용된 값이 바뀌었어요. 아래 초안은 유지하고 있어요.</p>}
    <div className="pc-actions"><button type="button" className="secondary" disabled={!dirty} onClick={apply}>JSON 적용</button><button type="button" className="ghost" disabled={!dirty} onClick={() => { setDraft(serialized); original.current = serialized; setDirty(false); setError(''); }}>적용된 값으로 되돌리기</button>{dirty && <small>미적용 초안</small>}</div>
    {error && <p className="error" role="alert">{error} · 초안은 유지했어요.</p>}
  </div>;
}
function ValueInput({ control, value, onChange, label }: { control: PromptControl; value: PromptValue; onChange: (value: PromptValue) => void; label: string }) {
  if (control.type === 'select') return <label>{label}<select aria-label={label} value={pretty(value)} onChange={event => onChange(JSON.parse(event.target.value) as PromptValue)}><option value="null">미설정 (null)</option>{control.options?.map((option, index) => <option key={index} value={pretty(option.value)}>{option.label}</option>)}</select></label>;
  if (control.type === 'boolean') return <label>{label}<select aria-label={label} value={pretty(value)} onChange={event => onChange(JSON.parse(event.target.value) as PromptValue)}><option value="null">미설정 (null)</option><option value="true">켜기</option><option value="false">끄기</option></select></label>;
  return <div className="pc-value"><label>{label}{control.type === 'number' ? <input aria-label={label} type="number" min={control.min} max={control.max} value={value === null ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))} /> : <textarea aria-label={label} rows={2} value={value === null ? '' : String(value)} onChange={event => onChange(event.target.value)} />}</label><button type="button" className="ghost" disabled={value === null} onClick={() => onChange(null)}>미설정으로</button>{value === null && <small>현재 값은 null이에요.</small>}</div>;
}
function FieldDraft({ label, value, onApply, onError }: { label: string; value: string; onApply: (value: string) => void; onError: (message: string) => void }) {
  const [draft, setDraft] = useState(value); const [dirty, setDirty] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (!dirty) setDraft(value); }, [value, dirty]);
  const apply = () => { if (!dirty) return; try { onApply(draft); setDirty(false); setError(''); } catch (caught) { const message = errorMessage(caught); setError(message); onError(message); } };
  return <label>{label}<input aria-label={label} value={draft} onChange={event => { setDraft(event.target.value); setDirty(true); setError(''); }} onBlur={apply} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } }} />{dirty && <small>입력을 마치면 적용해요.</small>}{error && <small className="error">{error}</small>}</label>;
}
function TemplateEditor({ template, onChange, onError, label }: { template: PromptTemplate; onChange: (template: PromptTemplate) => void; onError: (message: string) => void; label: string }) {
  const plain = template.length === 0 || template.length === 1 && template[0]!.kind === 'text';
  return <div className="pc-template">
    {plain ? <label>{label}<textarea aria-label={label} value={template.map(node => node.kind === 'text' ? node.text : '').join('')} onChange={event => { try { onChange([{ kind: 'text', text: event.target.value }]); } catch (caught) { onError(errorMessage(caught)); } }} /></label> : <p className="muted">조건·값·참조가 있는 템플릿이에요. 아래 JSON에서 구조를 그대로 편집해요.</p>}
    <details open={!plain}><summary>템플릿 JSON · 고급 편집</summary><JsonDraft label={`${label} JSON`} value={template} onApply={value => onChange(value as PromptTemplate)} onError={onError} /></details>
  </div>;
}
function BlockEditor({ block, onChange: commit, onError }: { block: PromptBlock; onChange: (block: PromptBlock) => void; onError: (message: string) => void }) {
  const onChange = (next: PromptBlock) => { try { commit(next); } catch (caught) { onError(errorMessage(caught)); } };
  const [nextKind, setNextKind] = useState(block.kind);
  useEffect(() => { setNextKind(block.kind); }, [block.kind]);
  return <div className="pc-block-fields">
    <div className="pc-grid"><label>블록 이름<input value={block.title} maxLength={200} onChange={event => onChange({ ...block, title: event.target.value })} /></label><label>종류<select value={nextKind} onChange={event => setNextKind(event.target.value as PromptBlock['kind'])}>{Object.entries(kindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label></div>
    {nextKind !== block.kind && <button type="button" className="secondary" onClick={() => onChange({ ...freshBlock(nextKind, block.id, block.title), ...(block.enabled === undefined ? {} : { enabled: block.enabled }), ...(block.when === undefined ? {} : { when: block.when }) })}>선택한 종류의 새 설정으로 바꾸기</button>}
    <label className="pc-checkbox"><input type="checkbox" checked={block.enabled !== false} onChange={event => onChange({ ...block, enabled: event.target.checked })} />이 블록 사용</label>
    {(block.kind === 'message' || block.kind === 'slot') && <label>메시지 역할<select value={block.role} onChange={event => onChange({ ...block, role: event.target.value as 'system' | 'user' | 'assistant', ...(block.kind === 'message' && event.target.value !== 'assistant' ? { completion: 'complete' as const } : {}) })}>{Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></label>}
    {block.kind === 'message' && <>
      {block.role === 'assistant' && <label>응답 메시지 형식<select value={block.completion ?? 'complete'} onChange={event => onChange({ ...block, completion: event.target.value as 'complete' | 'prefill' })}><option value="complete">완결된 assistant 메시지</option><option value="prefill">미완성 assistant prefill · 마지막 메시지</option></select></label>}
      <TemplateEditor label={`${block.title || block.id} 본문`} template={block.template} onChange={template => commit({ ...block, template })} onError={onError} />
    </>}
    {block.kind === 'slot' && <>
      <label>참조 이름<input value={block.slot} list="pc-slot-names" onChange={event => onChange({ ...block, slot: event.target.value })} /></label>
      <p className="muted">참조가 비어 있으면 블록 전체를 생략해요.</p>
      {block.template ? <TemplateEditor label={`${block.title || block.id} 감싸는 템플릿`} template={block.template} onChange={template => commit({ ...block, template })} onError={onError} /> : <button type="button" className="secondary" onClick={() => onChange({ ...block, template: [{ kind: 'slot', name: block.slot }] })}>감싸는 템플릿 추가</button>}
    </>}
    {block.kind === 'history' && <><div className="pc-grid"><FieldDraft label="시작 위치" value={String(block.from)} onError={onError} onApply={value => { if (!/^-?\d+$/u.test(value)) throw new Error('시작 위치는 정수로 입력해 주세요.'); commit({ ...block, from: Number(value) }); }} /><FieldDraft label="끝 위치" value={String(block.to)} onError={onError} onApply={value => { if (value !== 'end' && !/^-?\d+$/u.test(value)) throw new Error('끝 위치는 정수 또는 end로 입력해 주세요.'); commit({ ...block, to: value === 'end' ? 'end' : Number(value) }); }} /></div><p className="muted">0부터 세고 끝 위치는 포함하지 않아요. 음수는 뒤에서 세며 end는 마지막까지예요. 현재 입력도 대화에 포함돼요.</p></>}
    {block.kind === 'current' && <p className="muted">현재 입력 한 개를 넣어요. 다른 대화 범위에 같은 입력이 있으면 미리보기에서 중복 오류를 표시해요.</p>}
    {block.kind === 'cache' && <div className="pc-grid"><FieldDraft label="앞에서 찾을 메시지 수" value={String(block.depth)} onError={onError} onApply={value => { if (!/^[1-4]$/u.test(value)) throw new Error('캐시 대상 수는 1부터 4까지 입력해 주세요.'); commit({ ...block, depth: Number(value) }); }} /><label>대상 역할<select value={block.role} onChange={event => onChange({ ...block, role: event.target.value as 'all' | 'user' | 'assistant' })}><option value="all">모든 역할</option><option value="user">user</option><option value="assistant">assistant</option></select></label><label>지원 조건<select value={block.policy} onChange={event => onChange({ ...block, policy: event.target.value as 'prefer' | 'require' })}><option value="prefer">지원하면 적용</option><option value="require">지원 필수</option></select></label></div>}
    <details><summary>블록 적용 조건</summary><p className="muted">비워두면 항상 적용해요. 예: {'{"control":"control-id"}'}</p><JsonDraft label={`${block.title || block.id} 조건 JSON`} value={block.when} allowEmpty onApply={value => { const next = { ...block }; if (value === undefined) delete next.when; else next.when = value as PromptExpression; commit(next); }} onError={onError} /></details>
    <small className="pc-id">ID: {block.id}</small>
  </div>;
}
function ControlEditor({ control, onChange: commit, onError }: { control: PromptControl; onChange: (control: PromptControl) => void; onError: (message: string) => void }) {
  const onChange = (next: PromptControl) => { try { commit(next); } catch (caught) { onError(errorMessage(caught)); } };
  return <div className="pc-control-fields"><div className="pc-grid"><label>제어 이름<input value={control.label} onChange={event => onChange({ ...control, label: event.target.value })} /></label><label>값 종류<select value={control.type} onChange={event => { const type = event.target.value as PromptControl['type']; onChange({ id: control.id, label: control.label, type, default: null, ...(control.description ? { description: control.description } : {}), ...(type === 'select' ? { options: [{ label: '기본 선택', value: '0' }] } : {}) }); }}><option value="select">선택 목록</option><option value="boolean">켜기 / 끄기</option><option value="text">텍스트</option><option value="number">숫자</option></select></label></div>
    <ValueInput control={control} label={`${control.label} 기본값`} value={control.default} onChange={value => onChange({ ...control, default: value })} />
    {control.type === 'select' && <JsonDraft label={`${control.label} 선택지 JSON`} value={control.options ?? []} onApply={value => commit({ ...control, options: value as PromptControl['options'] })} onError={onError} />}
    {control.type === 'number' && <div className="pc-grid">{(['min','max'] as const).map(key => <label key={key}>{key === 'min' ? '최솟값' : '최댓값'}<input type="number" value={control[key] ?? ''} onChange={event => { const next = { ...control }; if (event.target.value === '') delete next[key]; else next[key] = Number(event.target.value); onChange(next); }} /></label>)}</div>}
    <label>설명<textarea rows={2} value={control.description ?? ''} maxLength={4000} onChange={event => onChange({ ...control, description: event.target.value })} /></label>
    <details><summary>제어 정의 JSON</summary><JsonDraft label={`${control.label} 정의 JSON`} value={control} onApply={value => commit(value as PromptControl)} onError={onError} /></details><small className="pc-id">ID: {control.id}</small>
  </div>;
}

export function PromptComposer({ program, onChange, onError, chatId, branchId, role = 'main', controlState, onSaveControls }: Props) {
  const scope = `${chatId ?? 'local'}:${branchId ?? 'root'}:${role}`;
  const [drafts, setDrafts] = useState<Record<string, ChatPromptControls>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const controls = drafts[scope] ?? controlState ?? emptyControls();
  const savedControls = saved[scope] ?? pretty(controlState ?? emptyControls());
  const controlsDirty = pretty(controls) !== savedControls;
  const knownControls = new Set(program.controls.map(control => control.id));
  const hasRemovedValues = [controls.values, ...controls.combinations.map(combination => combination.values)].some(values => Object.keys(values).some(id => !knownControls.has(id)));
  const [combinationName, setCombinationName] = useState('');
  const [importedCombination, setImportedCombination] = useState<ChatPromptControls['combinations'][number] | null>(null);
  const [request, setRequest] = useState('다음 장면을 이어 써 주세요.');
  const [preview, setPreview] = useState<{ value: Preview; fingerprint: string; synthetic: boolean } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const undo = useRef<PromptProgram[]>([]);
  useEffect(() => { undo.current = []; setImportedCombination(null); }, [scope]);
  const sequence = useRef(0);
  const fingerprint = pretty({ program, values: controls.values, request, scope });
  const latest = useRef({ fingerprint, scope }); latest.current = { fingerprint, scope };
  useEffect(() => () => { sequence.current++; }, []);
  const report = (message: string) => { setError(message); onError(message); };
  const change = (next: PromptProgram) => {
    const validated = validatePromptProgram(next); undo.current = [...undo.current.slice(-19), structuredClone(program)]; onChange(validated); setError(''); setStatus('프롬프트 초안을 바꿨어요. 상위 편집기에서 저장할 수 있어요.');
  };
  const edit = (next: PromptProgram) => { try { change(next); } catch (caught) { report(errorMessage(caught)); } };
  const changeBlock = (index: number, block: PromptBlock) => change({ ...program, blocks: program.blocks.map((item, i) => i === index ? block : item) });
  const editBlock = (index: number, block: PromptBlock) => { try { changeBlock(index, block); } catch (caught) { report(errorMessage(caught)); throw caught; } };
  const editControls = (next: ChatPromptControls) => { setDrafts(current => ({ ...current, [scope]: next })); setStatus('선택값과 조합은 아직 저장하지 않았어요.'); setError(''); };
  const safe = (work: () => void) => { try { work(); } catch (caught) { report(errorMessage(caught)); } };
  function move(index: number, direction: number) {
    const blocks = [...program.blocks]; const target = index + direction;
    if (target < 0 || target >= blocks.length) return;
    [blocks[index], blocks[target]] = [blocks[target]!, blocks[index]!]; edit({ ...program, blocks });
  }
  async function saveControls() {
    if (!onSaveControls) return; const activeScope = scope; const snapshot = structuredClone(controls);
    setSaving(true); setError('');
    try { validateChatPromptControls(snapshot); resolvePromptValues(program, snapshot.values); for (const combination of snapshot.combinations) resolvePromptValues(program, combination.values); await onSaveControls(snapshot); setSaved(current => ({ ...current, [activeScope]: pretty(snapshot) })); if (latest.current.scope === activeScope) setStatus('이 이야기의 선택값과 조합을 저장했어요.'); }
    catch (caught) { report(errorMessage(caught)); }
    finally { setSaving(false); }
  }
  function addCombination() {
    if (!combinationName.trim()) return;
    if (controls.combinations.length >= 50) { report('조합은 최대 50개까지 저장할 수 있어요.'); return; }
    editControls({ ...controls, combinations: [...controls.combinations, { id: newId('combination'), title: combinationName.trim(), values: structuredClone(controls.values) }] }); setCombinationName('');
  }
  async function runPreview() {
    const turn = ++sequence.current; const sourceFingerprint = fingerprint; setPreviewBusy(true); setError('');
    try {
      let result: Preview;
      if (chatId) result = await api<Preview>(`/chats/${encodeURIComponent(chatId)}/prompt-preview`, { program, request, values: controls.values, ...(branchId ? { branchId } : {}), role });
      else {
        const slots: Record<string, string> = { char: '합성 인물' };
        const walk = (nodes: PromptTemplate) => { for (const node of nodes) { if (node.kind === 'slot') slots[node.name] ??= `합성 ${node.name} 자료`; if (node.kind === 'if') { walk(node.then); if (node.else) walk(node.else); } } };
        for (const block of program.blocks) { if (block.kind === 'slot') { slots[block.slot] ??= `합성 ${block.slot} 자료`; if (block.template) walk(block.template); } if (block.kind === 'message') walk(block.template); }
        result = { compilation: compilePromptProgram(program, { values: controls.values, slots, history: [{ id: 'preview-user-1', role: 'user', text: '합성 이전 입력' }, { id: 'preview-assistant-1', role: 'assistant', text: '합성 이전 응답' }, { id: 'preview-current', role: 'user', text: request, current: true }] }), provider: null };
      }
      if (turn === sequence.current && sourceFingerprint === latest.current.fingerprint) { setPreview({ value: result, fingerprint: sourceFingerprint, synthetic: !chatId }); setStatus('미리보기를 갱신했어요.'); }
    } catch (caught) { if (turn === sequence.current && sourceFingerprint === latest.current.fingerprint) report(errorMessage(caught)); }
    finally { if (turn === sequence.current) setPreviewBusy(false); }
  }
  async function importFile(file: File) {
    const activeScope = scope;
    try {
      if (file.size > 1_500_000) throw new Error('JSON 파일은 1.5 MB 이하여야 해요.');
      const parsed = JSON.parse(await file.text()) as unknown;
      if (latest.current.scope !== activeScope) return;
      const wrapper = parsed && typeof parsed === 'object' && 'program' in parsed ? parsed as { program: unknown; suggestedCombination?: unknown } : null;
      const next = validatePromptProgram(wrapper ? wrapper.program : parsed);
      let suggestion = null;
      if (wrapper?.suggestedCombination) { const state = validateChatPromptControls({ values: {}, combinations: [wrapper.suggestedCombination] }); resolvePromptValues(next, state.combinations[0]!.values); suggestion = state.combinations[0]!; }
      change(next); setImportedCombination(suggestion); setStatus('JSON을 편집 초안으로 불러왔어요.');
    } catch (caught) { report(errorMessage(caught)); }
  }
  return <section className="prompt-composer" aria-label="프롬프트 구성" data-testid="prompt-composer">
    <div className="pc-heading"><div><h3>프롬프트 구성</h3><p className="muted">메시지 순서와 조건, 참조 자료를 편집해요. 실행 기록의 스냅샷과는 별도예요.</p></div><span className="pc-badge">{program.blocks.length}개 블록 · {program.controls.length}개 제어</span></div>
    <div className="pc-actions"><label className="pc-file">JSON 불러오기<input aria-label="프롬프트 구성 JSON 불러오기" type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} /></label><button type="button" className="secondary" onClick={() => saveDownload('uimori-prompt-program.json', program)}>JSON 내보내기</button><button type="button" className="ghost" disabled={!undo.current.length} onClick={() => { const previous = undo.current.pop(); if (previous) { onChange(previous); setStatus('이전 프롬프트 초안으로 되돌렸어요.'); } }}>이전 편집으로</button></div>
    <datalist id="pc-slot-names">{['description','persona','lorebook','memory','authorNote','globalNote','postEverything','char'].map(name => <option key={name} value={name} />)}</datalist>
    <div className="pc-block-list">{program.blocks.map((block, index) => <details className={`pc-block${block.enabled === false ? ' pc-disabled' : ''}`} key={block.id}><summary><span className="pc-order">{index + 1}</span><span className="pc-block-title">{block.title || block.id}<small>{kindLabels[block.kind]}{'role' in block ? ` · ${block.role}` : ''}{block.when !== undefined ? ' · 조건 있음' : ''}{block.enabled === false ? ' · 사용 안 함' : ''}</small></span></summary><div className="pc-block-body"><div className="pc-actions"><button type="button" className="ghost" aria-label={`${block.title} 위로`} disabled={index === 0} onClick={() => move(index, -1)}>↑ 위로</button><button type="button" className="ghost" aria-label={`${block.title} 아래로`} disabled={index === program.blocks.length - 1} onClick={() => move(index, 1)}>↓ 아래로</button><button type="button" className="ghost" onClick={() => edit({ ...program, blocks: program.blocks.filter((_, i) => i !== index) })}>블록 삭제</button></div><BlockEditor block={block} onChange={next => editBlock(index, next)} onError={report} /></div></details>)}</div>
    <div className="pc-actions"><button type="button" className="secondary" disabled={program.blocks.length >= 300} onClick={() => edit({ ...program, blocks: [...program.blocks, freshBlock('message')] })}>블록 추가</button></div>
    <details className="pc-section"><summary>제어 정의 · {program.controls.length}개</summary><div className="pc-stack">{program.controls.map((control, index) => <details className="pc-control" key={control.id}><summary>{control.label}<small> · {control.type}</small></summary><ControlEditor control={control} onError={report} onChange={next => change({ ...program, controls: program.controls.map((item, i) => i === index ? next : item) })} /><button type="button" className="ghost" onClick={() => edit({ ...program, controls: program.controls.filter((_, i) => i !== index) })}>제어 삭제</button></details>)}<button type="button" className="secondary" disabled={program.controls.length >= 150} onClick={() => edit({ ...program, controls: [...program.controls, { id: newId('control'), label: '새 제어', type: 'boolean', default: null }] })}>제어 추가</button></div></details>
    <details className="pc-section" open={program.controls.length > 0}><summary>이야기별 선택값과 조합</summary><div className="pc-stack"><p className="muted">값을 바꾼 뒤 저장 버튼을 눌러 적용해요. 프롬프트의 기본값은 제어 정의에서 바꿀 수 있어요.</p><div className="pc-control-values">{program.controls.map(control => <ValueInput key={control.id} control={control} label={control.label} value={Object.hasOwn(controls.values, control.id) ? controls.values[control.id]! : control.default} onChange={value => editControls({ ...controls, values: { ...controls.values, [control.id]: value }, selectedCombinationId: undefined })} />)}</div>
      <label>저장한 조합<select aria-label="프롬프트 선택 조합" value={controls.selectedCombinationId ?? ''} onChange={event => { const combination = controls.combinations.find(item => item.id === event.target.value); if (combination) editControls({ ...controls, values: structuredClone(combination.values), selectedCombinationId: combination.id }); }}><option value="">직접 선택</option>{controls.combinations.map(combination => <option key={combination.id} value={combination.id}>{combination.title}</option>)}</select></label>
      <div className="pc-actions"><button type="button" className="ghost" onClick={() => editControls({ ...controls, values: {}, selectedCombinationId: undefined })}>선택값을 프롬프트 기본값으로</button></div>
      {hasRemovedValues && <div className="pc-stack"><p className="muted">현재 프롬프트에 없는 제어의 선택값이 남아 있어요.</p><button type="button" className="secondary" onClick={() => { const keep = (values: Record<string, PromptValue>) => Object.fromEntries(Object.entries(values).filter(([id]) => knownControls.has(id))); editControls({ ...controls, values: keep(controls.values), combinations: controls.combinations.map(combination => ({ ...combination, values: keep(combination.values) })) }); }}>정의가 없는 선택값만 정리</button></div>}
      <div className="pc-grid"><label>새 조합 이름<input value={combinationName} maxLength={200} onChange={event => setCombinationName(event.target.value)} /></label><button type="button" className="secondary" disabled={!combinationName.trim() || controls.combinations.length >= 50} onClick={addCombination}>현재 값으로 조합 만들기</button></div>
      {controls.selectedCombinationId && <div className="pc-actions"><button type="button" className="ghost" onClick={() => editControls({ ...controls, combinations: controls.combinations.filter(item => item.id !== controls.selectedCombinationId), selectedCombinationId: undefined })}>선택 조합 삭제</button></div>}
      {controls.combinations.length > 0 && <details><summary>조합 이름과 내용 관리 · {controls.combinations.length} / 50</summary><div className="pc-stack">{controls.combinations.map(combination => <div className="pc-control" key={combination.id}><div className="pc-control-fields"><label>조합 이름<input aria-label={`${combination.title} 조합 이름`} maxLength={200} value={combination.title} onChange={event => editControls({ ...controls, combinations: controls.combinations.map(item => item.id === combination.id ? { ...item, title: event.target.value } : item) })} /></label><div className="pc-actions"><button type="button" className="secondary" onClick={() => editControls({ ...controls, combinations: controls.combinations.map(item => item.id === combination.id ? { ...item, values: structuredClone(controls.values) } : item) })}>현재 선택값으로 바꾸기</button><button type="button" className="ghost" onClick={() => editControls({ ...controls, combinations: controls.combinations.filter(item => item.id !== combination.id), ...(controls.selectedCombinationId === combination.id ? { selectedCombinationId: undefined } : {}) })}>이 조합 삭제</button></div></div></div>)}</div></details>}
      {importedCombination && <button type="button" className="secondary" disabled={controls.combinations.length >= 50} onClick={() => safe(() => { resolvePromptValues(program, importedCombination.values); editControls({ ...controls, combinations: [...controls.combinations, { ...importedCombination, id: newId('combination') }] }); setImportedCombination(null); })}>가져온 권장 조합을 목록에 추가</button>}
      <div className="pc-actions"><button type="button" disabled={!onSaveControls || !controlsDirty || saving} onClick={() => void saveControls()}>{saving ? '저장 중…' : '이야기 선택값과 조합 저장'}</button>{controlsDirty && <small>미저장 변경 있음</small>}{!onSaveControls && <small>지금은 미리보기에만 사용해요.</small>}</div>
    </div></details>
    <details className="pc-section"><summary>전체 구성 JSON · 고급 편집</summary><JsonDraft label="전체 프롬프트 구성 JSON" value={program} onApply={value => change(validatePromptProgram(value))} onError={report} /></details>
    <section className="pc-preview" aria-label="프롬프트 미리보기"><h3>전송 미리보기</h3><label>현재 요청<textarea aria-label="미리보기 현재 요청" value={request} onChange={event => setRequest(event.target.value)} /></label><div className="pc-actions"><button type="button" disabled={previewBusy || !request.trim()} onClick={() => void runPreview()}>{previewBusy ? '구성 중…' : '미리보기 갱신'}</button><small>{chatId ? '이 이야기의 자료와 대화를 사용해요. 모델을 호출하지 않아요.' : '합성 자료와 대화로 구성 순서를 확인해요.'}</small></div>
      {preview && <div className="pc-preview-result">{preview.fingerprint !== fingerprint && <p className="pc-stale" role="status">설정이나 요청이 바뀌었어요. 아래는 이전 미리보기예요.</p>}<p className="muted">{preview.synthetic ? '합성 미리보기' : '이야기 미리보기'} · 메시지 {preview.value.compilation.messages.length}개 · 캐시 기준 {preview.value.compilation.cachePlan.length}개</p>
        <ol className="pc-message-list">{preview.value.compilation.messages.map((message, index) => <li key={message.id}><details><summary>{index + 1}. {message.role} · {message.completion}<small>{program.blocks.find(block => block.id === message.provenance.blockId)?.title ?? message.provenance.blockId} · {message.provenance.origin}</small></summary><pre>{message.content.map(part => part.text).join('\n')}</pre></details></li>)}</ol>
        <details><summary>블록별 조건과 포함 결과</summary><div className="pc-table-wrap"><table><thead><tr><th>블록</th><th>결과</th><th>메시지 수</th></tr></thead><tbody>{preview.value.compilation.trace.map(trace => <tr key={trace.blockId}><td>{trace.blockId}</td><td>{trace.included ? '적용' : trace.reason === 'disabled' ? '사용 안 함' : '조건 불일치'}</td><td>{trace.messageIds.length}</td></tr>)}</tbody></table></div></details>
        <details><summary>캐시 기준과 지원 제한</summary><pre>{pretty({ cachePlan: preview.value.compilation.cachePlan, warnings: preview.value.compilation.warnings, providerDiagnostics: preview.value.provider?.diagnostics ?? null })}</pre></details>
        {preview.value.error && <p className="error" role="alert">{preview.value.error}</p>}
        {preview.value.provider ? <details><summary>공급자 전송 구성 · {preview.value.provider.protocol} · {preview.value.provider.modelId}</summary><p className="muted">{preview.value.provider.kind==='exact-request-body'?'현재 미리보기 스냅샷의 인코더 본문이에요. 실제 실행에서는 실행 ID와 무작위 선택, 최신 설정이 달라질 수 있어요. 인증 정보는 없고, 전송이나 과금은 발생하지 않아요.':'역할 변환만 확인하는 미리보기예요. 실행 시 보호된 번역 구간·도구·출력 형식이 추가되므로 실제 요청 본문과 달라요.'}</p><pre>{pretty(preview.value.provider)}</pre></details> : <p className="muted">공급자별 전송 구성은 표시되지 않았어요.</p>}
      </div>}
    </section>
    {error && <p className="error" role="alert">{error}</p>}<p className="pc-status" role="status">{status}</p>
  </section>;
}
