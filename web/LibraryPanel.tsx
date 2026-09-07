import { useEffect, useRef, useState } from 'react';
import { defaultCreative, type Content, type ContentKind, type CreativePreset, type Library, type ModelPreset } from '../core/product.js';
import { api } from './api.js';
import { CreativeEditor } from './CreativeEditor.js';
import { PromptEditor } from './PromptEditor.js';
import './library.css';

export const contentLabels: Record<ContentKind, string> = { bot: '봇', persona: '페르소나', lore: '로어', canon: '작가 설정', skill: '창작 스킬', glossary: '명칭집' };
export const refValue = (item: { id: string; revision: number }) => `${item.id}@${item.revision}`;
const freshContent = (kind: ContentKind): Omit<Content, 'id' | 'revision'> => ({ kind, title: '', description: '', text: '', loading: ['bot', 'persona', 'canon'].includes(kind) ? 'pinned' : 'discoverable', relatedIds: [] });
type EditorProps = { library: Library; reload: () => Promise<void>; onError: (error: string) => void };
type LibraryTab = ContentKind | 'presets' | 'prompts';
const libraryTabs: { id: LibraryTab; title: string }[] = [{ id: 'bot', title: '봇' }, { id: 'persona', title: '페르소나' }, { id: 'lore', title: '로어' }, { id: 'presets', title: '창작 프리셋' }, { id: 'prompts', title: '프롬프트' }, { id: 'canon', title: '작가 설정' }, { id: 'skill', title: '창작 스킬' }, { id: 'glossary', title: '명칭집' }];

export function LibraryPanel({ library, reload, onError, onStartStory }: { library: Library | null; reload: () => Promise<void>; onError: (error: string) => void; onStartStory?: (bot: Content) => void }) {
  const [tab, setTab] = useState<LibraryTab>('bot');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ kind: ContentKind; item: Content | null } | null>(null);
  const [presetEditing, setPresetEditing] = useState<CreativePreset | 'new' | null>(null);
  const opening = useRef(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => () => { opening.current++; }, []);
  function cancelOpening() { opening.current++; setLoading(false); }
  async function openContent(item: Content, start = false) {
    const request = ++opening.current; setLoading(true);
    try {
      const full = library?.contentBodiesOmitted ? await api<Content>(`/revisions/content/${item.id}/${item.revision}`) : item;
      if (request !== opening.current) return;
      if (start) onStartStory?.(full); else setEditing({ kind: full.kind, item: full });
    } catch (error) { if (request === opening.current) onError((error as Error).message); }
    finally { if (request === opening.current) setLoading(false); }
  }
  const filtered = library?.contents.filter(item => item.kind === tab && `${item.title} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const presets = library?.presets.filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  function openNew() { cancelOpening(); if (tab === 'prompts') return; if (tab === 'presets') setPresetEditing('new'); else setEditing({ kind: tab, item: null }); }
  return <section className="library-page" data-testid="library-panel" aria-label="서재">
    <header className="library-heading"><div><h1>서재</h1><p className="muted">이야기에 함께할 인물과 세계를 골라요.</p></div>{!editing && !presetEditing && tab !== 'prompts' && <button type="button" className="secondary" onClick={openNew} disabled={!library}>새로 만들기</button>}</header>
    {loading && <p role="status">자료 본문을 불러오는 중이에요…</p>}
    {!library ? <p role="status">서재를 불러오는 중이에요…</p> : editing ? <ContentEditor key={editing.item ? refValue(editing.item) : `new-${editing.kind}`} library={library} reload={reload} onError={onError} initial={editing.item} kind={editing.kind} onClose={() => setEditing(null)} onStartStory={onStartStory}/> : presetEditing ? <PresetEditor key={presetEditing === 'new' ? 'new' : refValue(presetEditing)} library={library} reload={reload} onError={onError} initial={presetEditing === 'new' ? undefined : presetEditing} onClose={() => setPresetEditing(null)}/> : <>
      <div className="library-tabs" role="tablist" aria-label="서재 분류" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = libraryTabs.findIndex(item => item.id === tab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? libraryTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + libraryTabs.length) % libraryTabs.length;
        cancelOpening(); setTab(libraryTabs[next].id); (event.currentTarget.querySelectorAll('button')[next] as HTMLButtonElement).focus();
      }}>{libraryTabs.map(item => <button type="button" role="tab" id={`library-tab-${item.id}`} aria-controls="library-results" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="secondary" key={item.id} onClick={() => { cancelOpening(); setTab(item.id); }}>{item.title}</button>)}</div>
      {tab !== 'prompts' && <div className="library-search"><label><span className="sr-only">서재 검색</span><input type="search" aria-label="서재 검색" placeholder="이름이나 설명으로 찾기" value={query} onChange={event => setQuery(event.target.value)}/></label><span className="muted">{tab === 'presets' ? presets.length : filtered.length}개</span></div>}
      <div id="library-results" role="tabpanel" aria-labelledby={`library-tab-${tab}`} className={tab === 'prompts' ? 'library-prompt-editor' : 'library-cards'}>
        {tab === 'prompts' ? <PromptEditor library={library} reload={reload} onError={onError}/> : tab === 'presets' ? presets.map(item => <article className="library-card" key={refValue(item)}><div className="library-avatar" aria-hidden="true">Aa</div><h2>{item.title}</h2><p>{item.controls.mode === 'novel' ? '소설' : 'RP'} · {item.controls.language === 'ko' ? '한국어' : '영어'} · {item.controls.style === 'calm' ? '차분한 문체' : item.controls.style === 'vivid' ? '선명한 문체' : '자동 문체'}</p><button type="button" className="secondary" onClick={() => setPresetEditing(item)} aria-label={`${item.title} 프리셋 살펴보기`}>살펴보기 · 사본 만들기</button></article>) : filtered.map(item => <article className="library-card" key={refValue(item)}><div className="library-avatar" aria-hidden="true">{Array.from(item.title.trim())[0] ?? '·'}</div><h2><button type="button" className="library-title-button" onClick={() => void openContent(item)} aria-label={`${item.title} 자료 편집`}>{item.title}</button></h2><p>{item.description || '아직 설명이 없어요.'}</p><small>{item.loading === 'pinned' ? '항상 포함' : '모델이 필요할 때 읽기'}</small>{item.kind === 'bot' && onStartStory ? <button type="button" className="secondary" onClick={() => void openContent(item, true)} aria-label={`${item.title} 봇으로 시작`}>이 봇으로 시작</button> : <button type="button" className="secondary" onClick={() => void openContent(item)}>자료 살펴보기</button>}</article>)}
        {tab !== 'prompts' && (tab === 'presets' ? presets : filtered).length === 0 && <div className="library-empty"><h2>{query ? '찾는 자료가 없어요' : `아직 ${tab === 'presets' ? '창작 프리셋이' : `${contentLabels[tab]} 자료가`} 없어요`}</h2><p>{query ? '다른 이름이나 설명으로 찾아보세요.' : '직접 만든 설정을 보관하고 여러 이야기에서 함께 사용할 수 있어요.'}</p><button type="button" className="secondary" onClick={openNew}>새로 만들기</button></div>}
      </div>
    </>}
  </section>;
}

function ContentEditor({ library, reload, onError, initial, kind, onClose, onStartStory }: EditorProps & { initial: Content | null; kind: ContentKind; onClose: () => void; onStartStory?: (bot: Content) => void }) {
  const [selected, setSelected] = useState(initial);
  const [value, setValue] = useState<Omit<Content, 'id' | 'revision'>>(initial ?? freshContent(kind));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [relatedQuery, setRelatedQuery] = useState('');
  const related = library.contents.filter(item => item.id !== selected?.id && `${item.title} ${item.description}`.toLocaleLowerCase().includes(relatedQuery.toLocaleLowerCase()));
  const missingRelated = value.relatedIds.filter(id => !library.contents.some(item => item.id === id));
  return <section className="library-detail" aria-label="자료 상세">
    <div className="library-detail-heading"><button type="button" className="secondary" disabled={busy} onClick={onClose}>← 서재 목록</button><h2>{selected ? selected.title : '새 자료'}</h2>{selected?.kind === 'bot' && onStartStory && <button type="button" className="secondary" disabled={busy} onClick={() => onStartStory(selected)}>이 봇으로 시작</button>}</div>
    <form className="editor-grid" onSubmit={async event => {
      event.preventDefault(); setBusy(true); onError(''); setSaved(''); setError('');
      try {
        const item = await api<Content>(selected ? `/content/${selected.id}` : '/content', { kind: value.kind, title: value.title, description: value.description, text: value.text, loading: value.loading, relatedIds: value.relatedIds, ...(selected ? { expectedRevision: selected.revision } : {}) }, selected ? 'PUT' : 'POST');
        setSelected(item); setValue(item); setSaved(`${item.title} · v${item.revision} 저장됨`); await reload();
      } catch (caught) { const message = (caught as Error).message; setError(message); onError(message); } finally { setBusy(false); }
    }}>
      <fieldset className="editor-fields full" disabled={busy}>
        <label>자료 종류<select aria-label="자료 종류" value={value.kind} disabled={!!selected} onChange={event => { const next = event.target.value as ContentKind; setValue({ ...value, kind: next, loading: freshContent(next).loading }); }}>{Object.entries(contentLabels).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
        <label>자료 이름<input aria-label="자료 이름" value={value.title} maxLength={160} required onChange={event => setValue({ ...value, title: event.target.value })}/></label>
        <label className="full">자료 설명<input aria-label="자료 설명" value={value.description} maxLength={1000} onChange={event => setValue({ ...value, description: event.target.value })}/></label>
        <label className="full">자료 본문<textarea aria-label="자료 본문" rows={10} value={value.text} maxLength={100000} required onChange={event => setValue({ ...value, text: event.target.value })}/></label>
        <label className="full">이 자료를 읽는 방법<select aria-label="기본 로딩" value={value.loading} onChange={event => setValue({ ...value, loading: event.target.value as Content['loading'] })}><option value="pinned">항상 포함</option><option value="discoverable">모델이 필요할 때 읽기</option></select></label>
        <fieldset className="related-selector full"><legend>관련 자료</legend><input type="search" aria-label="관련 자료 검색" placeholder="자료 이름으로 찾기" value={relatedQuery} onChange={event => setRelatedQuery(event.target.value)}/><div className="related-options">{related.map(item => <label className="check" key={item.id}><input type="checkbox" checked={value.relatedIds.includes(item.id)} onChange={event => setValue({ ...value, relatedIds: event.target.checked ? [...value.relatedIds, item.id] : value.relatedIds.filter(id => id !== item.id) })}/><span>{item.title}<small>{contentLabels[item.kind]}</small></span></label>)}{related.length === 0 && <p className="muted">선택할 자료가 없어요.</p>}{missingRelated.length > 0 && <small>목록에 없는 기존 연결 {missingRelated.length}개는 그대로 보존해요.</small>}</div></fieldset>
        {value.kind === 'canon' && <small className="full">작가가 선언한 과거·설정이에요. 실제로 생성한 대화 기록으로 바꾸지 않아요.</small>}
        {value.kind === 'skill' && <small className="full">창작 방법을 설명하는 자료예요. 읽기 도구나 앱의 권한을 늘리지 않아요.</small>}
      </fieldset>
      {error && <p className="error full" role="alert">{error} 입력한 내용은 유지했어요.</p>}
      <div className="form-actions full"><button disabled={busy}>{busy ? '저장 중…' : selected ? '새 revision 저장' : '자료 등록'}</button><span role="status">{saved}</span></div>
      {selected && <><small className="full">서재에서 수정해도 기존 이야기에 장착된 버전은 유지돼요.</small><details className="library-diagnostics full"><summary>자료 저장 정보</summary><p>현재 버전 v{selected.revision}</p><code>{selected.id}</code></details></>}
    </form>
  </section>;
}

function PresetEditor({ library, reload, onError, initial, onClose }: EditorProps & { initial?: CreativePreset; onClose: () => void }) {
  const [title, setTitle] = useState(initial ? `${initial.title} 사본` : '');
  const [controls, setControls] = useState(() => initial ? structuredClone(initial.controls) : defaultCreative());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [from, setFrom] = useState(initial ? refValue(initial) : '');
  return <section className="library-detail" aria-label="창작 프리셋 상세"><div className="library-detail-heading"><button type="button" className="secondary" disabled={busy} onClick={onClose}>← 서재 목록</button><h2>{initial ? initial.title : '새 창작 프리셋'}</h2></div><p className="muted">창작 제어를 새 프리셋으로 저장해요. 현재 이야기와 원본 프리셋은 그대로 유지해요.</p><form className="editor-grid" onSubmit={async event => {
    event.preventDefault(); setBusy(true); onError(''); setError(''); setSaved('');
    try { const result = await api<CreativePreset>('/creative-presets', { title, controls }); setSaved(`${result.title} 저장됨`); await reload(); }
    catch (caught) { const message = (caught as Error).message; setError(message); onError(message); } finally { setBusy(false); }
  }}>
    <fieldset className="editor-fields full" disabled={busy}>
      <label className="full">프리셋에서 시작<select aria-label="프리셋에서 시작" value={from} onChange={event => { setFrom(event.target.value); const preset = library.presets.find(item => refValue(item) === event.target.value); setControls(preset ? structuredClone(preset.controls) : defaultCreative()); setTitle(preset ? `${preset.title} 사본` : ''); }}><option value="">기본값</option>{library.presets.map(item => <option key={refValue(item)} value={refValue(item)}>{item.title} · v{item.revision}</option>)}</select></label>
      <label className="full">새 창작 프리셋 이름<input aria-label="새 창작 프리셋 이름" value={title} maxLength={160} required onChange={event => setTitle(event.target.value)}/></label>
      <CreativeEditor value={controls} onChange={setControls} prefix="preset"/>
    </fieldset>
    {error && <p className="error full" role="alert">{error}</p>}
    <div className="form-actions full"><button disabled={busy}>창작 프리셋 저장</button><span role="status">{saved}</span></div>
  </form></section>;
}

export { ConnectionEditor } from './ProviderSettings.js';
