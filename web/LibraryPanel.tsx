import { PackageTransfer } from './PackageTransfer.js';
import { useEffect, useRef, useState } from 'react';
import type { Content, ContentKind, Library } from '../core/product.js';
import { api, saveDownload } from './api.js';
import { PackageFields, packageFromContent } from './PackageFields.js';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import { PromptEditor } from './PromptEditor.js';
import { DeleteButton } from './DeleteButton.js';
import { Dialog } from './Dialog.js';
import './library.css';

export const contentLabels: Record<ContentKind, string> = { bot: '봇', persona: '페르소나', module: '모듈', lore: '로어', canon: '작가 설정', skill: '창작 스킬', glossary: '명칭집' };
export const refValue = (item: { id: string; revision: number }) => `${item.id}@${item.revision}`;
const freshContent = (kind: ContentKind): Omit<Content, 'id' | 'revision'> => ({ kind, title: '', description: '', text: '', loading: ['bot', 'persona', 'module', 'canon'].includes(kind) ? 'pinned' : 'discoverable', relatedIds: [], ...(['bot','persona','module'].includes(kind) ? { package: packageFromContent({title:'',description:'',text:''}) } : {}) });
type EditorProps = { library: Library; reload: () => Promise<void>; onError: (error: string) => void };
export type PrimaryLibraryTab = 'bot' | 'persona' | 'module' | 'prompts';
type LibraryTab = PrimaryLibraryTab | 'other';
const libraryTabs: { id: LibraryTab; title: string }[] = [{ id: 'bot', title: '봇' }, { id: 'persona', title: '페르소나' }, { id: 'module', title: '모듈' }, { id: 'prompts', title: '프롬프트' }, { id: 'other', title: '기타 자료' }];

export function LibraryPanel({ library, reload, onError, onStartStory, initialTab = 'bot', onTabChange, onDirtyChange }: { library: Library | null; reload: () => Promise<void>; onError: (error: string) => void; onStartStory?: (bot: Content) => void; initialTab?: PrimaryLibraryTab; onTabChange?: (tab: PrimaryLibraryTab) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const [dirty, setDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{tab:LibraryTab;closeOnly?:boolean} | null>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(pendingNavigation)continueButton.current?.focus();},[pendingNavigation]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const externalTab = useRef<LibraryTab>(initialTab);
  useEffect(() => { if (externalTab.current !== initialTab) { externalTab.current = initialTab; navigate(initialTab); } }, [initialTab]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ kind: ContentKind; item: Content | null } | null>(null);
  const opening = useRef(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => () => { opening.current++; }, []);
  function switchTab(next:LibraryTab, closeOnly=false) { cancelOpening(); setEditing(null); setDirty(false); if (!closeOnly) { setTab(next); externalTab.current=next;if(next!=='other')onTabChange?.(next); } }
  function navigate(next:LibraryTab, closeOnly=false) { if(next===tab&&!closeOnly&&!editing)return; if (dirty) setPendingNavigation({tab:next,closeOnly}); else switchTab(next,closeOnly); }
  function cancelOpening() { opening.current++; setLoading(false); }
  async function openContent(item: Content, start = false) {
    const request = ++opening.current; setLoading(true);
    try {
      const full = library?.contentBodiesOmitted || item.hasPackage && !item.package ? await api<Content>(`/revisions/content/${item.id}/${item.revision}`) : item;
      if (request !== opening.current) return;
      if (start) onStartStory?.(full); else setEditing({ kind: full.kind, item: full });
    } catch (error) { if (request === opening.current) onError((error as Error).message); }
    finally { if (request === opening.current) setLoading(false); }
  }
  const filtered = library?.contents.filter(item => (tab==='other'?!['bot','persona','module'].includes(item.kind):item.kind === tab) && `${item.title} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  function openNew() { cancelOpening(); if (tab !== 'prompts') setEditing({ kind: tab==='other'?'lore':tab, item: null }); }
  function continueEditing() { setPendingNavigation(null); externalTab.current=tab; if(tab!=='other')onTabChange?.(tab); }
  return <section className="library-page" data-testid="library-panel" aria-label="서재">
    <header className="library-heading"><div><h1>서재</h1><p className="muted">봇·페르소나·모듈에 인물과 세계, 로어와 지침을 담아요.</p></div>{!editing && tab !== 'prompts' && <button type="button" className="secondary" onClick={openNew} disabled={!library}>새로 만들기</button>}</header>
    <Dialog open={!!pendingNavigation} title="미저장 자료 확인" role="alertdialog" className="library-discard-dialog" onClose={continueEditing}>
      <p>저장하지 않은 편집 내용이 있어요.</p><p className="muted">이동하면 현재 초안이 사라져요.</p>
      <div className="library-discard-actions"><button type="button" className="secondary" ref={continueButton} onClick={continueEditing}>계속 편집</button><button type="button" onClick={()=>{if(!pendingNavigation)return;switchTab(pendingNavigation.tab,pendingNavigation.closeOnly);setPendingNavigation(null);}}>초안 버리고 이동</button></div>
    </Dialog>
    {loading && <p role="status">자료 본문을 불러오는 중이에요…</p>}
    {!library ? <p role="status">서재를 불러오는 중이에요…</p> : editing ? <ContentEditor key={editing.item ? refValue(editing.item) : `new-${editing.kind}`} library={library} reload={reload} onError={onError} initial={editing.item} kind={editing.kind} onClose={() => navigate(tab,true)} onDeleted={()=>switchTab(tab,true)} onDirtyChange={setDirty} onStartStory={onStartStory}/> : <>
      <div className="library-tabs" role="tablist" aria-label="서재 분류" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = libraryTabs.findIndex(item => item.id === tab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? libraryTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + libraryTabs.length) % libraryTabs.length;
        navigate(libraryTabs[next].id); (event.currentTarget.querySelectorAll('button')[next] as HTMLButtonElement).focus();
      }}>{libraryTabs.map(item => <button type="button" role="tab" id={`library-tab-${item.id}`} aria-controls="library-results" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="secondary" key={item.id} onClick={() => { navigate(item.id); }}>{item.title}</button>)}</div>
      {tab !== 'prompts' && <div className="library-search"><label><span className="sr-only">서재 검색</span><input type="search" aria-label="서재 검색" placeholder="이름이나 설명으로 찾기" value={query} onChange={event => setQuery(event.target.value)}/></label><span className="muted">{filtered.length}개</span></div>}
      <div id="library-results" role="tabpanel" aria-labelledby={`library-tab-${tab}`} className={tab === 'prompts' ? 'library-prompt-editor' : 'library-cards'}>
        {tab === 'prompts' ? <PromptEditor library={library} reload={reload} onError={onError} onDirtyChange={setDirty}/> : filtered.map(item => <article className="library-card" key={refValue(item)}><div className="library-avatar" aria-hidden="true">{item.coverImage?<img src={item.coverImage.url} alt="" loading="lazy" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:Array.from(item.title.trim())[0] ?? '·'}</div><h2><button type="button" className="library-title-button" onClick={() => void openContent(item)} aria-label={`${item.title} 자료 편집`}>{item.title}</button></h2><p>{item.description || '아직 설명이 없어요.'}</p><small>{item.loading === 'pinned' ? '항상 포함' : '모델이 필요할 때 읽기'}</small>{(item.kind === 'bot' || item.package || item.hasPackage) && onStartStory ? <button type="button" className="secondary" onClick={() => void openContent(item, true)} aria-label={`${item.title} 봇으로 시작`}>{item.kind === 'bot' ? '채팅 시작' : '이 자료를 봇으로 시작'}</button> : <button type="button" className="secondary" onClick={() => void openContent(item)}>자료 살펴보기</button>}<DeleteButton path={`/content/${encodeURIComponent(item.id)}`} revision={item.revision} title={item.title} onDeleted={async()=>{cancelOpening();await reload();}} onError={onError}/></article>)}
        {tab !== 'prompts' && filtered.length === 0 && <div className="library-empty"><h2>{query ? '찾는 자료가 없어요' : `아직 ${tab==='other'?'기타':contentLabels[tab]} 자료가 없어요`}</h2><p>{query ? '다른 이름이나 설명으로 찾아보세요.' : '직접 만든 설정을 보관하고 여러 이야기에서 함께 사용할 수 있어요.'}</p><button type="button" className="secondary" onClick={openNew}>새로 만들기</button></div>}
      </div>
    </>}
  </section>;
}

function ContentEditor({ library, reload, onError, initial, kind, onClose, onDeleted, onStartStory, onDirtyChange }: EditorProps & { initial: Content | null; kind: ContentKind; onClose: () => void; onDeleted: () => void; onStartStory?: (bot: Content) => void; onDirtyChange: (dirty:boolean)=>void }) {
  const [selected, setSelected] = useState(initial);
  const [value, setValue] = useState<Omit<Content, 'id' | 'revision'>>(initial ?? freshContent(kind));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [baseline,setBaseline] = useState(() => JSON.stringify(initial ?? freshContent(kind)));
  const [importedPackage,setImportedPackage] = useState<ContentPackage|null>(null);
  const [behaviorDraftDirty,setBehaviorDraftDirty] = useState(false);
  const dirty = JSON.stringify(value) !== baseline;
  useEffect(()=>{onDirtyChange(dirty || !!importedPackage || behaviorDraftDirty);},[dirty,importedPackage,behaviorDraftDirty,onDirtyChange]);
  const packageSnapshot = () => validateContentPackage({...value.package,title:value.title,description:value.description,body:value.text});
  async function saveContent(copyKind?: 'bot'|'persona'|'module') {
    if(behaviorDraftDirty){setError('패키지의 초안을 먼저 검증하고 적용해 주세요.');return;}
    setBusy(true); onError(''); setSaved(''); setError('');
    try {
      const copying=!!copyKind;
      const pkg=value.package ? packageSnapshot() : copying ? packageFromContent(value) : undefined;
      const item=await api<Content>(!copying&&selected ? '/content/'+selected.id : '/content', {kind:copyKind??value.kind,title:copying?value.title+' 사본':value.title,description:value.description,text:value.text,loading:value.loading,relatedIds:[],...(pkg?{package:pkg}:{}),...(!copying&&selected?{expectedRevision:selected.revision}:{})},!copying&&selected?'PUT':'POST');
      setSelected(item);setValue(item);setBaseline(JSON.stringify(item));setSaved(item.title+' · v'+item.revision+' 저장됨');await reload();
    } catch(caught){const message=(caught as Error).message;setError(message);onError(message);}finally{setBusy(false);}
  }
  return <section className="library-detail" aria-label="자료 상세">
    <div className="library-detail-heading"><button type="button" className="secondary" disabled={busy} onClick={onClose}>← 서재 목록</button><h2>{selected ? selected.title : '새 자료'}</h2>{selected && (selected.kind === 'bot' || selected.package) && onStartStory && <button type="button" className="secondary" disabled={busy || dirty || !!importedPackage || behaviorDraftDirty} onClick={() => onStartStory(selected)}>{selected.kind === 'bot' ? '채팅 시작' : '이 자료를 봇으로 시작'}</button>}</div>
    {selected&&<DeleteButton path={`/content/${encodeURIComponent(selected.id)}`} revision={selected.revision} title={selected.title} label="자료 삭제" disabled={busy} description="이 자료의 모든 저장 버전과 현재 편집 초안을 삭제해요. 되돌릴 수 없고, 다른 자료나 채팅에서 사용 중이면 삭제할 수 없어요." onError={onError} onDeleted={async()=>{onDeleted();await reload();}}/>}
    <form className="editor-grid" onSubmit={async event => {
      event.preventDefault(); await saveContent();
    }}>
      <fieldset className="editor-fields full" disabled={busy}>
        <label>자료 종류<select aria-label="자료 종류" value={value.kind} disabled={!!selected} onChange={event => { const next = event.target.value as ContentKind; setValue({ ...value, kind: next, loading: freshContent(next).loading, ...(!value.package && ['bot','persona','module'].includes(next)?{package:packageFromContent(value)}:{}) }); }}>{Object.entries(contentLabels).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
        <label>자료 이름<input aria-label="자료 이름" value={value.title} maxLength={160} required onChange={event => setValue({ ...value, title: event.target.value })}/></label>
        <label className="full">자료 설명<input aria-label="자료 설명" value={value.description} maxLength={1000} onChange={event => setValue({ ...value, description: event.target.value })}/></label>
        <label className="full">자료 본문<textarea aria-label="자료 본문" rows={10} value={value.text} maxLength={100000} required={!value.package} onChange={event => setValue({ ...value, text: event.target.value })}/></label>
        {value.package ? <PackageFields value={value.package} onChange={pkg=>setValue(current=>({...current,package:pkg}))} onBehaviorDraftChange={setBehaviorDraftDirty}/> : ['bot','persona','module'].includes(value.kind) && <button type="button" className="secondary" onClick={()=>setValue({...value,package:packageFromContent(value)})}>공통 패키지로 확장</button>}
        <details className="library-package-tools full"><summary>패키지 가져오기·내보내기와 역할 사본</summary><div className="library-package-tools-body"><PackageTransfer getPackage={packageSnapshot} onPrepared={pkg=>{setImportedPackage(pkg);setError('' );}} onError={setError} disabled={behaviorDraftDirty}/>{importedPackage && <div className="library-import-preview"><p>{importedPackage.title} · 로어 {importedPackage.lore.length}개 · 지침 {importedPackage.instructions.length}개</p><button type="button" onClick={()=>{setValue({...value,title:importedPackage.title,description:importedPackage.description,text:importedPackage.body??'',package:importedPackage});setImportedPackage(null);}}>가져온 패키지로 초안 바꾸기</button><button type="button" className="ghost" onClick={()=>setImportedPackage(null)}>가져오기 취소</button></div>}<section className="library-package-copies"><h3>다른 역할로 사본 만들기</h3><p className="muted">로어와 지침을 함께 복사해요. 인물 관점과 역할별 지침은 직접 조정해 주세요.</p>{!value.title.trim()&&<p className="muted">자료 이름을 입력하면 사본을 만들 수 있어요.</p>}<div className="form-actions">{(['bot','persona','module'] as const).filter(role=>role!==value.kind).map(role=><button type="button" className="secondary" key={role} disabled={!value.title.trim()} onClick={()=>void saveContent(role)}>{contentLabels[role]}로 사본 만들기</button>)}</div></section></div></details>
        <label className="library-loading full">이 자료를 읽는 방법<select aria-label="기본 로딩" value={value.loading} onChange={event => setValue({ ...value, loading: event.target.value as Content['loading'] })}><option value="pinned">항상 포함</option><option value="discoverable">모델이 필요할 때 읽기</option></select></label>
      </fieldset>
      {error && <p className="error full" role="alert">{error} 입력한 내용은 유지했어요.</p>}
      {behaviorDraftDirty&&<p className="full muted">패키지에 미적용 초안이 있어요. 검증 후 적용하면 자료를 저장할 수 있어요.</p>}
      <div className="library-savebar form-actions full"><button disabled={busy || !!importedPackage || behaviorDraftDirty}>{busy ? '저장 중…' : selected ? '새 revision 저장' : '자료 등록'}</button><span role="status">{saved}</span></div>
      {selected && <><small className="full">서재에서 수정해도 기존 이야기에 장착된 버전은 유지돼요.</small><details className="library-diagnostics full"><summary>자료 저장 정보</summary><p>현재 버전 v{selected.revision}</p><code>{selected.id}</code></details></>}
    </form>
  </section>;
}

export { ConnectionEditor } from './ProviderSettings.js';
