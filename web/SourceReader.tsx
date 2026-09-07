import { containedImageAnchors, resolveInlineImage, IMAGE_POSITION_UNAVAILABLE } from './image-placement.js';
import { StorySourceState } from './StoryPanel.js';
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Asset } from '../core/product.js';
import type { Job, Source } from '../core/types.js';
import { api, labels } from './api.js';
import { Prose } from './Prose.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { HiddenStoryReader, type HiddenTranslationView } from './HiddenStoryReader.js';
import { parseHiddenStory, validateHiddenTranslation, type HiddenStoryConfig } from '../core/hidden-story.js';
import { PackageStateCards, usePackagePresentation } from './PackagePresentation.js';

type ReaderMode = 'original' | 'translation';
type ReaderProps = {
  source: Source; index: number; jobs: Job[]; assets: Asset[];
  refresh: () => Promise<void>; onError: (error: string) => void;
  onFork: (sourceId: string) => Promise<void>;
  request?: string;
  packageStart?: {mode:'authored'|'generate';title:string};
  onInspect?: (runId: string) => void;
  hiddenConfig?: HiddenStoryConfig;
  hasPackages?: boolean;
  presentationRefreshKey?: string | number;
};
type AnchorPosition = { anchors: string[]; top: number; scrollport: HTMLElement };

function initialMode(sourceId: string, hasTranslation: boolean): ReaderMode {
  if (!hasTranslation) return 'original';
  try {
    const saved = sessionStorage.getItem(`reader-mode:${sourceId}`);
    if (saved === 'original' || saved === 'translation') return saved;
    return localStorage.getItem('uimori:reading-language') === 'original' ? 'original' : 'translation';
  } catch { return 'translation'; }
}
function currentAnchor(container: HTMLElement | null): AnchorPosition | undefined {
  const scrollport = container?.closest<HTMLElement>('[data-reader-scrollport], .reader-scrollport');
  if (!container || !scrollport) return;
  const viewport = scrollport.getBoundingClientRect();
  const nearest = [...container.querySelectorAll<HTMLElement>('[data-block-anchor]')].find(element => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  return nearest ? { anchors: nearest.dataset.blockAnchor!.split(' '), top: nearest.getBoundingClientRect().top, scrollport } : undefined;
}
const retryable = (status: string) => ['failed', 'cancelled', 'partial', 'interrupted'].includes(status);
const activeJob = (job: Job) => job.status === 'queued' || job.status === 'running';
const jobTitle = (job: Job) => job.kind === 'translation' ? '한국어 번역' : job.kind === 'status' ? '장면 상태' : '이미지 표시';

export function SourceReader(props: ReaderProps) {
  return <SourceReaderContent key={props.source.id} {...props}/>;
}
function latestTranslation(source: Source, jobs: Job[]) {
  return jobs.filter(job => job.kind === 'translation' && job.sourceRevision === source.id && job.sourceHash === source.hash && job.status !== 'stale').sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1)).at(0);
}
function SourceReaderContent({ source, index, jobs, assets, refresh: refreshSource, onFork, request, packageStart, onInspect, hiddenConfig, hasPackages, presentationRefreshKey }: ReaderProps) {
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = async () => { if (mounted.current) await refreshSource(); };
  const container = useRef<HTMLElement>(null);
  const restoreAnchor = useRef<AnchorPosition | undefined>(undefined);
  const translation = latestTranslation(source, jobs);
  const latestImageJob = jobs.filter(job=>job.kind==='image'&&job.sourceRevision===source.id).sort((a,b)=>(b.revision??1)-(a.revision??1))[0];
  const presentation = usePackagePresentation(source, translation, hasPackages === true, `${presentationRefreshKey ?? ''}:${jobs.map(job => `${job.id}:${job.status}`).join(',')}`);
  const projected = !hiddenConfig ? presentation?.data : undefined;
  const [mode, setMode] = useState<ReaderMode>(() => initialMode(source.id, !!translation?.result));
  const [editor, setEditor] = useState<ReaderMode | null>(null);
  const requestPending = useRef(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pending, setPending] = useState('');
  const [actionError, setActionError] = useState('');
  const validTranslation = translation?.result?.sourceRevision === source.id && translation.result.sourceHash === source.hash ? translation.result : null;
  const blocks = source.blocks?.length ? source.blocks : [{ anchor: 'full', index: 0, text: source.text, start: 0, end: source.text.length }];
  const segments = validTranslation?.segments ?? validTranslation?.blocks?.map(block => ({ anchors: [block.anchor], text: block.text }));
  const displayJobs = jobs.filter(job => job.sourceHash === source.hash && (job.kind !== 'translation' || job.id === translation?.id));
  const attentionJobs = displayJobs.filter(job => activeJob(job) || retryable(job.status));
  const image = jobs.filter(job => job.kind === 'image' && job.sourceRevision === source.id && job.sourceHash === source.hash && job.status !== 'stale').sort((a,b)=>(b.revision ?? 1)-(a.revision ?? 1)).at(0);
  const annotations = image?.status === 'completed' && image.result?.sourceRevision === source.id && image.result.sourceHash === source.hash ? image.result.annotations ?? [] : [];
  const status = jobs.filter(job => job.kind === 'status' && job.status === 'completed').at(-1);
  const sceneStatus = status?.result?.sourceRevision === source.id && status.result.sourceHash === source.hash ? status.result.label ?? status.result.text : '';

  const previousHash = useRef(source.hash);
  useLayoutEffect(() => {
    if (previousHash.current !== source.hash) { previousHash.current = source.hash; setMode('original'); }
  }, [source.hash]);

  useLayoutEffect(() => {
    const previous = restoreAnchor.current;
    restoreAnchor.current = undefined;
    if (!previous) return;
    const target = [...(container.current?.querySelectorAll<HTMLElement>('[data-block-anchor]') ?? [])].find(element => element.dataset.blockAnchor?.split(' ').some(anchor => previous.anchors.includes(anchor)));
    if (target) previous.scrollport.scrollTop += target.getBoundingClientRect().top - previous.top;
  }, [mode, source.hash]);

  const switchMode = (next: ReaderMode) => {
    if (next === mode) return;
    restoreAnchor.current = currentAnchor(container.current);
    setMode(next);
    try { sessionStorage.setItem(`reader-mode:${source.id}`, next); } catch { /* Reading is available when storage is restricted. */ }
  };
  const action = async (name: string, operation: () => Promise<unknown>) => {
    if (requestPending.current) return;
    requestPending.current = true;
    setPending(name); setActionError('');
    try { await operation(); } catch (error) {
      const message = error instanceof Error ? error.message : '요청을 완료하지 못했어요.';
      if (mounted.current) setActionError(message);
    } finally { requestPending.current = false; setPending(''); }
  };
  const viewTranslation = () => {
    switchMode('translation');
    if (validTranslation || (translation && activeJob(translation))) return;
    void action('translation', async () => { await api(`/sources/${source.id}/translation`, {}); await refresh(); });
  };
  const inline = (anchor: string) => annotations.filter(annotation => annotation.blockAnchor === anchor).map(annotation => {
    const asset = resolveInlineImage(assets, source.chatId, annotation);
    return asset ? <figure className="inline-asset" key={`${anchor}:${asset.id}`} data-testid="inline-annotation" data-asset-ref={asset.id}><img src={asset.url} alt={asset.description || asset.title} loading="lazy"/><figcaption>{annotation.caption || asset.title}</figcaption></figure> : null;
  });
  return <article ref={container} className="source" id={`source-${source.id}`} data-testid="source" data-source-id={source.id}>
    {packageStart?.mode === 'authored' && <p className="muted" data-testid="authored-start">작성된 도입문 · {packageStart.title}</p>}
    {packageStart?.mode !== 'authored' && request && <div className="request-message" data-testid="source-request"><span className="request-label">내 요청</span>{request.length > 280 ? <details><summary>{request.slice(0, 240)}… <span>전체 보기</span></summary><p>{request}</p></details> : <p>{request}</p>}</div>}
    <div className="source-heading"><span className="folio">장면 {index + 1}</span><small>{mode === 'translation' ? '한국어 번역' : '원문'}</small></div>
    <div className="reader-toolbar"><div className="segmented" role="group" aria-label="원문과 번역 보기"><button type="button" className={mode === 'translation' ? '' : 'secondary'} aria-pressed={mode === 'translation'} disabled={pending === 'translation'} onClick={viewTranslation}>번역 보기</button><button type="button" className={mode === 'original' ? '' : 'secondary'} aria-pressed={mode === 'original'} onClick={() => switchMode('original')}>원문 보기</button></div>

    </div>
    {editor && <TextEditor key={editor} role={editor} source={source} translation={translation} onCancel={() => setEditor(null)} onSaved={async () => { await refresh(); if (mounted.current) { setEditor(null); if (editor === 'translation') switchMode('translation'); } }}/>}
    {validTranslation?.manual && mode === 'translation' && <p className="muted">직접 수정한 번역</p>}
    {hiddenConfig && (mode === 'original' || validTranslation) ? <NativeHiddenBody source={source} config={hiddenConfig} translationText={mode === 'translation' ? validTranslation?.text ?? segments?.map(segment => segment.text).join('\n\n') ?? '' : undefined} blocks={blocks} inline={inline}/> : mode === 'original' && projected?.original.changed ? <div className="prose" data-testid="source-text"><div className="source-block" data-block-anchor={blocks.map(block=>block.anchor).join(' ')}><Prose text={projected.original.text}/></div>{annotations.length > 0 && <p className="muted" role="status">{IMAGE_POSITION_UNAVAILABLE}</p>}</div> : mode === 'translation' && validTranslation && projected?.translation?.changed ? <div className="prose translated" data-testid="translation-text"><div className="source-block" data-block-anchor={blocks.map(block=>block.anchor).join(' ')}><Prose text={projected.translation.text}/></div>{annotations.length > 0 && <p className="muted" role="status">{IMAGE_POSITION_UNAVAILABLE}</p>}</div> : mode === 'original' ? <div className="prose" data-testid="source-text">{source.text.slice(0, blocks[0].start)}{blocks.map((block, position) => <Fragment key={block.anchor}><div className="source-block" data-block-anchor={block.anchor} id={`block-${source.id}-${block.anchor}`}><Prose text={source.text.slice(block.start, blocks[position + 1]?.start ?? source.text.length)}/></div>{inline(block.anchor)}</Fragment>)}</div> : validTranslation ? <div className="prose translated" data-testid="translation-text">{segments?.length ? segments.map((segment, position) => <Fragment key={`${segment.anchors.join('-')}:${position}`}><div className="source-block" data-block-anchor={segment.anchors.join(' ')}><Prose text={segment.text}/></div>{segment.anchors.flatMap(inline)}</Fragment>) : <div className="source-block" data-block-anchor={blocks.map(block => block.anchor).join(' ')}><Prose text={validTranslation.text ?? ''}/>{annotations.length > 0 && <p className="muted" role="status">번역의 문단 위치를 확인할 수 없어 이미지를 생략했어요.</p>}</div>}</div> : <div className="translation-placeholder" role="status"><p>{translation ? activeJob(translation) ? '한국어 번역을 준비하고 있어요. 원문은 저장됐어요.' : '한국어 번역이 아직 준비되지 않았어요. 원문은 보존돼요.' : '이 장면에는 아직 한국어 번역이 없어요.'}</p><button type="button" className="secondary" onClick={() => switchMode('original')}>원문부터 읽기</button></div>}
    {presentation?.error && <p className="error" role="alert">{presentation.error}</p>}
    <PackageStateCards data={presentation?.data}/>
    {sceneStatus && <aside className="scene-status" aria-label="현재 장면의 표시 상태"><small>장면 상태</small><span>{sceneStatus}</span></aside>}
    <div className="derived-summary" aria-label="이 장면의 후속 작업">
      {attentionJobs.length ? attentionJobs.map(job => <div className={retryable(job.status) ? 'job-summary has-error' : 'job-summary'} key={job.id} data-job-id={job.id}><span>{jobTitle(job)} · {labels[job.status]}{retryable(job.status) ? ' · 원문 보존됨' : ''}</span><JobActions job={job} refresh={refresh} onError={setActionError} compact/></div>) : jobs.length > 0 && <p className="muted">{displayJobs.map(job => `${jobTitle(job)} ${labels[job.status]}`).join(' · ')}</p>}
    </div>
    <StorySourceState sourceId={source.id} refreshKey={`${source.hash}:${jobs.map(job=>job.status).join(',')}`}/><div className="source-actions">
      <button type="button" className="secondary" disabled={!!pending} onClick={() => { void action('fork', () => onFork(source.id)); }}>{pending === 'fork' ? '이야기 복사 중…' : '여기서 새 이야기로 이어가기'}</button>
      <button type="button" className="secondary" disabled={!!editor || !!pending} onClick={() => setEditor('original')}>원문 수정</button>
      <button type="button" className="secondary" disabled={!!editor || !!pending} onClick={() => setEditor('translation')}>번역 수정</button>
      <button type="button" className="secondary" disabled={!!editor || !!pending || !!latestImageJob&&activeJob(latestImageJob)&&latestImageJob.sourceHash===source.hash} onClick={()=>void action('images',async()=>{await api(`/sources/${source.id}/images`,{expectedSourceHash:source.hash,expectedRevision:latestImageJob?.revision??0});await refresh();})}>{pending==='images'?'이미지 선택을 예약하는 중…':latestImageJob?'이미지 다시 선택':'이미지 선택'}</button>
      {onInspect && <button type="button" className="secondary" onClick={() => onInspect(source.runId)}>실행 상세</button>}
    </div>
    {actionError && <p className="error" role="alert">{actionError}</p>}
    <details className="source-job-details" onToggle={event => setDetailsOpen(event.currentTarget.open)}><summary>작업 상세{jobs.length ? ` · ${jobs.length}개` : ''}</summary>{detailsOpen && <><div className="derived">{displayJobs.map(job => <JobCard key={job.id} job={job} refresh={refresh} onError={setActionError} hideText={job.kind === 'translation'}/>)}</div><details className="inspector"><summary>원문 연결 정보</summary><dl><dt>source revision</dt><dd>{source.id}</dd><dt>parent revision</dt><dd>{source.parentRevision || '시작'}</dd><dt>SHA-256</dt><dd>{source.hash}</dd></dl><details><summary>현재 원문</summary><pre data-testid="source-raw">{source.text}</pre></details><p>제목·강조·목록·인용·링크·코드를 표시해요. 속성 없는 ruby의 본문과 rt만 읽기 표기로 표시하고, 나머지 HTML과 Markdown 이미지는 문자로 남겨요.</p></details></>}</details>
  </article>;
}

export function NativeHiddenBody({source,config,translationText,blocks,inline}:{source:Source;config:HiddenStoryConfig;translationText?:string;blocks:{anchor:string;start:number;end:number}[];inline:(anchor:string)=>ReactNode[]}){
  const original={sourceRevision:source.id,sourceHash:source.hash,text:source.text};
  let translation:HiddenTranslationView|undefined,error='';
  if(translationText!==undefined){try{
    const checked=validateHiddenTranslation(original,translationText);if(!checked.ok)throw new Error('Hidden translation boundaries differ');
    const raw=parseHiddenStory(original),translated=parseHiddenStory({...original,text:translationText});
    translation={sourceRevision:source.id,sourceHash:source.hash,segments:Object.fromEntries(raw.segments.map((segment,index)=>{const target=translated.segments[index];if(!target||target.kind!==segment.kind)throw new Error('Hidden translation structure differs');return[segment.id,{body:translationText.slice(target.bodyRange.start,target.bodyRange.end),...(target.title?{title:target.title}:{}),...(target.scene?{scene:target.scene}:{})}];}))};
  }catch{error='번역의 히든 구간 경계를 확인할 수 없어 이 장면은 원문으로 표시해요. 번역과 원문은 보존돼요.';}}
  const emitted=new Set<string>();
  return <div className={`prose${translation?' translated':''}`} data-testid={translation?'translation-text':'source-text'}>{error&&<p role="alert">{error}</p>}<HiddenStoryReader source={original} config={config} translation={translation} renderText={(text,segment)=>{
    const anchors=blocks.filter(block=>block.start<segment.range.end&&segment.range.start<block.end).map(block=>block.anchor);
    const images=containedImageAnchors(blocks,segment.bodyRange).filter(anchor=>!emitted.has(anchor));images.forEach(anchor=>emitted.add(anchor));
    return <div className="source-block" data-block-anchor={anchors.join(' ')}><Prose text={text}/>{images.flatMap(inline)}</div>;
  }}/></div>;
}

type Draft = { text: string; expectedRevision: number; expectedSourceHash: string };
function draftKey(sourceId: string, role: ReaderMode) { return `uimori:text-draft:${sourceId}:${role}`; }
function readDraft(key: string, fallback: Draft): Draft {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Partial<Draft> | null;
    if (value && typeof value.text === 'string' && Number.isInteger(value.expectedRevision) && typeof value.expectedSourceHash === 'string') return value as Draft;
  } catch { /* Editing also works when browser storage is unavailable. */ }
  return fallback;
}
function TextEditor({ role, source, translation, onCancel, onSaved }: { role: ReaderMode; source: Source; translation?: Job; onCancel: () => void; onSaved: () => Promise<void> }) {
  const key = draftKey(source.id, role);
  const savedText = role === 'original' ? source.text : translation?.result?.text ?? translation?.result?.segments?.map(segment => segment.text).join('\n\n') ?? translation?.result?.blocks?.map(block => block.text).join('\n\n') ?? '';
  const revision = role === 'original' ? source.editRevision ?? 0 : translation?.revision ?? source.translationRevision ?? (translation ? 1 : 0);
  const [draft, setDraft] = useState(() => readDraft(key, { text: savedText, expectedRevision: revision, expectedSourceHash: source.hash }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const title = role === 'original' ? '원문' : '번역';
  const conflict = draft.expectedSourceHash !== source.hash || draft.expectedRevision !== revision;
  const persist = (next: Draft) => { setDraft(next); try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the in-memory draft. */ } };
  const clear = () => { try { sessionStorage.removeItem(key); } catch { /* Storage may be restricted. */ } };
  return <form className="source-text-editor" onSubmit={async event => {
    event.preventDefault(); if (busy.current) return; busy.current = true; setSaving(true); setError('');
    try {
      await api(`/sources/${source.id}/${role === 'original' ? 'text' : 'translation'}`, role === 'original' ? { text: draft.text, expectedRevision: draft.expectedRevision } : draft, 'PUT');
      await onSaved(); clear();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '저장하지 못했어요. 작성한 내용은 유지돼요.'); }
    finally { busy.current = false; setSaving(false); }
  }}>
    <label>{title} 수정<textarea aria-label={`${title} 수정 내용`} rows={12} maxLength={2000000} value={draft.text} disabled={saving} onChange={event => persist({ ...draft, text: event.target.value })}/></label>
    <small>{role === 'original' ? '수정한 원문은 다음 요청에 사용하고, 번역 보기를 누르면 새로 번역해요.' : '직접 저장한 번역은 모델을 호출하지 않아요.'}</small>
    {conflict && <div role="alert" className="error"><p>편집 중 저장된 내용이 바뀌었어요. 작성한 내용은 유지돼요.</p><details><summary>현재 저장된 {title} 확인</summary><pre>{savedText || '저장된 번역 없음'}</pre></details><button type="button" className="secondary" disabled={saving} onClick={() => { persist({ text: savedText, expectedRevision: revision, expectedSourceHash: source.hash }); setError(''); }}>작성한 내용을 버리고 저장된 내용 다시 불러오기</button></div>}
    <div className="form-actions"><button type="submit" disabled={saving || conflict || !draft.text.trim()}>{saving ? '저장 중…' : `${title} 저장`}</button><button type="button" className="secondary" disabled={saving} onClick={() => { clear(); onCancel(); }}>수정 취소</button></div>
    {error && <p className="error" role="alert">{error} 작성한 내용은 유지돼요.</p>}
  </form>;
}

function JobActions({ job, refresh, onError, compact = false }: { job: Job; refresh: () => Promise<void>; onError: (error: string) => void; compact?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const perform = async (operation: 'retry' | 'cancel') => {
    setPending(true); setError('');
    try { await api(`/jobs/${job.id}/${operation}`, {}); await refresh(); }
    catch (error) { const message = error instanceof Error ? error.message : '요청을 완료하지 못했어요.'; setError(message); onError(message); }
    finally { setPending(false); }
  };
  return <>{retryable(job.status) && <button type="button" className="secondary" disabled={pending} onClick={() => { void perform('retry'); }}>{compact ? job.kind === 'translation' ? '번역만 다시 시도' : `${jobTitle(job)} 재시도` : '이 작업만 재시도'}</button>}{activeJob(job) && <button type="button" className="secondary" disabled={pending} onClick={() => { void perform('cancel'); }}>{jobTitle(job)} 취소</button>}{error && <small className="error" role="alert">{error}</small>}</>;
}

export function JobCard({ job, refresh, onError, hideText = false }: { job: Job; refresh: () => Promise<void>; onError: (error: string) => void; hideText?: boolean }) {
  const title = jobTitle(job);
  return <section className="job" data-testid={`job-${job.kind}`} data-source-id={job.sourceRevision} data-job-id={job.id}>
    <h3>{job.result?.mock ? '모의 ' : ''}{title} <small>{labels[job.status]}</small></h3>
    {!hideText && job.result && <p>{job.result.text || job.result.label || (job.kind === 'image' ? `${job.result.annotations?.length ?? 0}개 이미지 표시` : '')}</p>}
    {job.error && <p className="error">보조 작업이 실패했어요. 원문은 보존돼요.</p>}
    <JobActions job={job} refresh={refresh} onError={onError}/>
    {job.chunks && job.chunks.length > 1 && <details className="chunk-details"><summary>번역 구간별 상태</summary><ol className="chunk-list">{job.chunks.map((chunk, index) => <li key={chunk.id}><span>구간 {index + 1} · {labels[chunk.status] || chunk.status} · 시도 {chunk.attempt}</span>{retryable(chunk.status) && <ChunkRetry jobId={job.id} chunkId={chunk.id} refresh={refresh} onError={onError}/>}</li>)}</ol></details>}
    <LazyDiagnostics<Job & {input?:unknown}> path={`/jobs/${job.id}`} revision={`${job.status}:${job.attempt}:${job.revision}`} title="보조 작업의 실제 입력과 도구">{value=><pre>{JSON.stringify({jobId:value.id,sourceRevision:value.sourceRevision,sourceHash:value.sourceHash,input:value.input,chunks:value.chunks},null,2)}</pre>}</LazyDiagnostics>
    {job.kind === 'status' && <small>현재 장면의 표시예요. 다음 이야기의 사실에는 반영하지 않아요.</small>}
  </section>;
}

function ChunkRetry({ jobId, chunkId, refresh, onError }: { jobId: string; chunkId: string; refresh: () => Promise<void>; onError: (error: string) => void }) {
  const [pending, setPending] = useState(false);
  return <button type="button" className="secondary" disabled={pending} onClick={() => { setPending(true); void api(`/jobs/${jobId}/retry`, { chunkId }).then(refresh).catch(error => onError(error.message)).finally(() => setPending(false)); }}>이 구간만 재시도</button>;
}
