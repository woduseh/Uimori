import { useEffect, useState } from 'react';
import type { ContentRef, Library, PromptPreset, PromptRole } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { api } from './api.js';
import './prompt-editor.css';

const labels: Record<PromptRole, string> = { main: '작문', translation: '번역' };
const defaults: Record<PromptRole, string> = { main: DEFAULT_MAIN_PROMPT, translation: DEFAULT_TRANSLATION_PROMPT };
const roles = ['main', 'translation'] as const;
const keyOf = (value: ContentRef) => `${value.id}@${value.revision}`;
type Draft = { source: string; base: PromptPreset | null; title: string; text: string; dirty: boolean };
type Props = { library: Library; reload?: () => Promise<void>; onError: (message: string) => void; selections?: Partial<Record<PromptRole, ContentRef | null>>; onApply?: (role: PromptRole, reference: ContentRef | null) => Promise<boolean>; onDirtyChange?: (dirty: boolean) => void };
const draftFor = (role: PromptRole, preset?: PromptPreset): Draft => ({ source: preset ? keyOf(preset) : 'builtin', base: preset ?? null, title: preset?.title ?? `${labels[role]} 사용자 프롬프트`, text: preset ? preset.text : defaults[role], dirty: false });

export function PromptEditor({ library, reload, onError, selections, onApply, onDirtyChange }: Props) {
  const [role, setRole] = useState<PromptRole>('main');
  const [localPresets, setLocalPresets] = useState<PromptPreset[]>([]);
  const [drafts, setDrafts] = useState<Record<PromptRole, Draft>>(() => Object.fromEntries(roles.map(role => {
    const ref = selections?.[role]; const preset = library.promptPresets?.find(item => item.role === role && ref && keyOf(item) === keyOf(ref));
    return [role, ref && !preset ? { ...draftFor(role), source: keyOf(ref), text: '' } : draftFor(role, preset)];
  })) as Record<PromptRole, Draft>);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const presets = [...(library.promptPresets ?? []), ...localPresets.filter(item => !library.promptPresets?.some(latest => keyOf(latest) === keyOf(item)))];
  const dirty = Object.values(drafts).some(draft => draft.dirty);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    let alive = true;
    const missing = roles.flatMap(role => { const ref = selections?.[role]; return ref && !library.promptPresets?.some(item => keyOf(item) === keyOf(ref)) && !localPresets.some(item => keyOf(item) === keyOf(ref)) ? [{ role, ref }] : []; });
    void Promise.all(missing.map(async ({ role, ref }) => ({ role, item: await api<PromptPreset>(`/revisions/prompt-preset/${ref.id}/${ref.revision}`) }))).then(results => {
      if (!alive || !results.length) return;
      setLocalPresets(current => [...current, ...results.map(result => result.item).filter(item => !current.some(prior => keyOf(prior) === keyOf(item)))]);
      setDrafts(current => { const next = { ...current }; for (const { role, item } of results) if (!current[role].dirty && current[role].source === keyOf(item)) next[role] = draftFor(role, item); return next; });
    }).catch(caught => { if (alive) { setError(caught.message); onError(caught.message); } });
    return () => { alive = false; };
  }, [selections, library.promptPresets, localPresets, onError]);
  const draft = drafts[role];
  const edit = (changes: Partial<Draft>) => { setDrafts(current => ({ ...current, [role]: { ...current[role], ...changes, dirty: true } })); setError(''); setStatus(''); };
  function choose(source: string) {
    const preset = presets.find(item => item.role === role && keyOf(item) === source);
    setDrafts(current => ({ ...current, [role]: source === 'new' ? { source: 'new', base: null, title: '', text: '', dirty: true } : draftFor(role, preset) })); setError(''); setStatus('');
  }
  async function apply(reference: ContentRef | null) {
    if (!onApply) return;
    setBusy(true); setError(''); setStatus(''); onError('');
    try { if (await onApply(role, reference)) setStatus(reference ? '선택한 프롬프트를 이야기에 적용했어요.' : '앱 기본 프롬프트를 이야기에 적용했어요.'); }
    catch (caught) { const message = (caught as Error).message; setError(message); onError(message); }
    finally { setBusy(false); }
  }
  async function save(update: boolean, alsoApply: boolean) {
    if (!draft.title.trim() || update && !draft.base) return;
    setBusy(true); setError(''); setStatus(''); onError('');
    try {
      const accepted = await api<PromptPreset>(update ? `/prompt-presets/${draft.base!.id}` : '/prompt-presets', { title: draft.title.trim(), role, text: draft.text, ...(update ? { expectedRevision: draft.base!.revision } : {}) }, update ? 'PUT' : 'POST');
      setLocalPresets(current => [...current.filter(item => keyOf(item) !== keyOf(accepted)), accepted]);
      setDrafts(current => ({ ...current, [role]: draftFor(role, accepted) }));
      setStatus('프롬프트를 저장했어요.');
      await reload?.();
      if (alsoApply && onApply) { const applied = await onApply(role, { id: accepted.id, revision: accepted.revision }); setStatus(applied ? '프롬프트를 저장하고 이야기에 적용했어요.' : '프롬프트는 저장했어요. 이야기 적용을 다시 시도해 주세요.'); }
    } catch (caught) { const message = (caught as Error).message; setError(message); onError(message); }
    finally { setBusy(false); }
  }
  const selected = selections?.[role];
  const selectedPreset = selected ? presets.find(item => keyOf(item) === keyOf(selected)) : null;
  const pendingSavedText = draft.source !== 'builtin' && draft.source !== 'new' && !draft.base;
  return <section className={`prompt-editor${expanded ? ' prompt-editor-expanded' : ''}`} data-testid="prompt-editor" aria-label="전체 프롬프트 편집">
    <p className="muted">작문과 번역의 역할 지침 전체를 바꿔요. 창작 제어와 인물·자료 선택은 각각의 설정을 사용해요.</p>
    <fieldset className="prompt-editor-fields" disabled={busy}>
      <div className="prompt-editor-row"><label>역할<select aria-label="프롬프트 역할" value={role} onChange={event => { setRole(event.target.value as PromptRole); setError(''); setStatus(''); }}><option value="main">작문</option><option value="translation">번역</option></select></label><label>불러올 프롬프트<select aria-label="불러올 프롬프트" value={draft.source} onChange={event => choose(event.target.value)}><option value="builtin">앱 기본 프롬프트</option><option value="new">새 프롬프트</option>{presets.filter(item => item.role === role).map(item => <option key={keyOf(item)} value={keyOf(item)}>{item.title}{library.promptPresets?.some(latest => latest.id === item.id && latest.revision > item.revision) ? ' · 보관된 버전' : ''} · v{item.revision}</option>)}{pendingSavedText && <option value={draft.source}>선택한 프롬프트 불러오는 중…</option>}</select></label></div>
      {onApply && <p className="prompt-applied">이 이야기에서 사용: <strong>{selected ? selectedPreset?.title ?? '저장된 프롬프트' : '앱 기본 프롬프트'}</strong>{selectedPreset?.text === '' && ' · 빈 지침'}</p>}
      <label>프롬프트 이름<input aria-label="프롬프트 이름" maxLength={160} value={draft.title} onChange={event => edit({ title: event.target.value })}/></label>
      <div className="prompt-editor-tools"><button type="button" className="secondary" disabled={pendingSavedText} onClick={() => edit({ text: defaults[role] })}>기본 전체 불러오기</button><label className="prompt-file">텍스트 파일 불러오기<input type="file" aria-label="프롬프트 파일 불러오기" accept=".txt,.md,text/plain,text/markdown" onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        setBusy(true); setError(''); setStatus('');
        try {
          if (!/\.(?:txt|md)$/iu.test(file.name) || file.size > 800000) throw new Error('UTF-8 .txt 또는 .md 파일을 선택해 주세요.');
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
          if (text.length > 200000) throw new Error('프롬프트는 200,000자까지 불러올 수 있어요.');
          edit({ text, ...(draft.source === 'new' && !draft.title ? { title: file.name.replace(/\.(?:txt|md)$/iu, '') } : {}) });
          setStatus('파일 내용을 편집기에 불러왔어요. 저장하면 사용할 수 있어요.');
        } catch (caught) { const message = (caught as Error).message; setError(message); onError(message); }
        finally { setBusy(false); }
      }}/></label><button type="button" className="secondary" aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '편집 영역 줄이기' : '편집 영역 넓히기'}</button></div>
      <label className="prompt-text-label">{labels[role]} 전체 프롬프트<textarea aria-label={`${labels[role]} 전체 프롬프트`} spellCheck={false} value={draft.text} disabled={pendingSavedText} maxLength={200000} rows={14} onChange={event => edit({ text: event.target.value })}/></label>
      <p className="prompt-text-note">{draft.text.length.toLocaleString()}자 · {draft.text === '' && draft.source !== 'builtin' ? '빈 사용자 지침으로 저장할 수 있어요. ' : ''}텍스트를 그대로 저장해요. RisuAI 템플릿 문법(CBS)은 실행하지 않아요.</p>
      <div className="prompt-save-actions"><button type="button" disabled={pendingSavedText || !draft.title.trim()} onClick={() => void save(false, false)}>새 프롬프트로 저장</button>{draft.base && <button type="button" className="secondary" disabled={!draft.dirty} onClick={() => void save(true, false)}>기존 프롬프트 수정 저장</button>}{onApply && <><button type="button" className="secondary" disabled={pendingSavedText || draft.dirty || draft.source === 'new'} onClick={() => void apply(draft.base ? { id: draft.base.id, revision: draft.base.revision } : null)}>이야기에 선택 적용</button>{draft.dirty && <button type="button" disabled={pendingSavedText || !draft.title.trim()} onClick={() => void save(Boolean(draft.base), true)}>저장하고 이야기에 적용</button>}</>}</div>
    </fieldset>
    {draft.dirty && <p className="muted prompt-unsaved">편집 중인 프롬프트를 아직 저장하지 않았어요.</p>}
    {error && <p className="error" role="alert">{error} 편집 내용은 유지했어요.</p>}
    <p role="status" className="prompt-status">{busy ? '처리 중…' : status}</p>
  </section>;
}
