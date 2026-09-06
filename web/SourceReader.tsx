import { Fragment, useRef, useState } from 'react';
import type { Asset } from '../core/product.js';
import type { Job, Source } from '../core/types.js';
import { api, labels } from './api.js';

export function SourceReader({ source, index, jobs, assets, refresh, onError, onBranch }: { source: Source; index: number; jobs: Job[]; assets: Asset[]; refresh: () => Promise<void>; onError: (error: string) => void; onBranch: (sourceId: string) => Promise<void> }) {
  const container = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<'original' | 'translation'>(() => sessionStorage.getItem(`reader-mode:${source.id}`) === 'translation' ? 'translation' : 'original');
  const [translationId, setTranslationId] = useState('');
  const translations = jobs.filter(job => job.kind === 'translation').sort((a, b) => (a.revision ?? 1) - (b.revision ?? 1));
  const translation = translations.find(job => job.id === translationId) ?? translations.findLast(job => job.result !== null) ?? translations.at(-1);
  const blocks = source.blocks?.length ? source.blocks : [{ anchor: 'full', index: 0, text: source.text, start: 0, end: source.text.length }];
  const segments = translation?.result?.segments ?? translation?.result?.blocks?.map(block => ({ anchors: [block.anchor], text: block.text }));
  const displayJobs = jobs.filter(job => job.kind !== 'translation' || job.id === translation?.id || ['queued', 'running', 'failed', 'partial'].includes(job.status));
  const image = jobs.filter(job => job.kind === 'image' && job.status === 'completed').at(-1);
  const annotations = image?.result?.sourceRevision === source.id && image.result.sourceHash === source.hash ? image.result.annotations ?? [] : [];
  const switchMode = (next: typeof mode) => {
    const nearest = [...(container.current?.querySelectorAll<HTMLElement>('[data-block-anchor]') ?? [])].find(element => element.getBoundingClientRect().bottom > 60);
    const anchors = nearest?.dataset.blockAnchor?.split(' ');
    setMode(next); sessionStorage.setItem(`reader-mode:${source.id}`, next);
    if (anchors) requestAnimationFrame(() => { const target = [...(container.current?.querySelectorAll<HTMLElement>('[data-block-anchor]') ?? [])].find(element => element.dataset.blockAnchor?.split(' ').some(anchor => anchors.includes(anchor))); target?.scrollIntoView({ block: 'start' }); });
  };
  const inline = (anchor: string) => annotations.filter(annotation => annotation.blockAnchor === anchor).map(annotation => {
    const asset = assets.find(item => item.id === annotation.assetRef && item.chatId === source.chatId && item.allowedUse !== 'profile');
    return asset ? <figure className="inline-asset" key={`${anchor}:${asset.id}`} data-testid="inline-annotation" data-asset-ref={asset.id}><img src={asset.url} alt={asset.description || asset.title} loading="lazy"/><figcaption>{annotation.caption || asset.title}</figcaption></figure> : null;
  });
  return <article ref={container} className="source" key={source.id} id={`source-${source.id}`} data-testid="source" data-source-id={source.id}>
    <div className="source-heading"><span className="folio">{String(index + 1).padStart(2, '0')} / 원문</span><small>확정된 원고</small></div>
    <div className="reader-toolbar"><div className="segmented" role="group" aria-label="원문과 번역 보기"><button type="button" className={mode === 'original' ? '' : 'secondary'} aria-pressed={mode === 'original'} onClick={() => switchMode('original')}>원문 보기</button><button type="button" className={mode === 'translation' ? '' : 'secondary'} aria-pressed={mode === 'translation'} disabled={!translation?.result} onClick={() => switchMode('translation')}>번역 보기</button></div>{translations.length > 1 && <label>번역 revision<select aria-label="번역 revision" value={translation?.id || ''} onChange={event => setTranslationId(event.target.value)}>{translations.map(job => <option key={job.id} value={job.id}>v{job.revision ?? 1} · {labels[job.status]}</option>)}</select></label>}</div>
    {mode === 'original' ? <div className="prose" data-testid="source-text">{source.text.slice(0, blocks[0].start)}{blocks.map((block, position) => <Fragment key={block.anchor}><span className="source-block" data-block-anchor={block.anchor} id={`block-${source.id}-${block.anchor}`}>{source.text.slice(block.start, blocks[position + 1]?.start ?? source.text.length)}</span>{inline(block.anchor)}</Fragment>)}</div> : <div className="prose translated" data-testid="translation-text">{segments?.length ? segments.map((segment, position) => <Fragment key={`${segment.anchors.join('-')}:${position}`}><span className="source-block" data-block-anchor={segment.anchors.join(' ')}>{segment.text}{position + 1 < segments.length ? '\n\n' : ''}</span>{segment.anchors.flatMap(inline)}</Fragment>) : translation?.result?.text}</div>}
    <div className="derived">{displayJobs.map(job => <JobCard key={job.id} job={job} refresh={refresh} onError={onError} hideText={job.kind === 'translation' && (mode === 'translation' || !!job.result?.segments?.length)}/>)}</div>
    <div className="source-actions"><button className="secondary" onClick={() => { void onBranch(source.id).catch(error => onError(error.message)); }}>여기서 새 분기</button><button className="secondary" onClick={() => { if (translation?.result) setTranslationId(translation.id); void api(`/sources/${source.id}/retranslate`, {}).then(refresh).catch(error => onError(error.message)); }}>새 revision으로 재번역</button></div>
    <details className="inspector"><summary>원문 연결 정보</summary><dl><dt>source revision</dt><dd>{source.id}</dd><dt>parent revision</dt><dd>{source.parentRevision || '시작'}</dd><dt>SHA-256</dt><dd>{source.hash}</dd></dl></details>
  </article>;
}

export function JobCard({ job, refresh, onError, hideText = false }: { job: Job; refresh: () => Promise<void>; onError: (error: string) => void; hideText?: boolean }) {
  const title = job.kind === 'translation' ? '한국어 번역' : job.kind === 'status' ? '표시 상태' : '이미지 표시';
  const active = job.status === 'queued' || job.status === 'running';
  return <section className="job" data-testid={`job-${job.kind}`} data-source-id={job.sourceRevision} data-job-id={job.id}>
    <h3>{job.result?.mock !== false ? '모의 ' : ''}{title} <small>{labels[job.status]}{job.revision ? ` · v${job.revision}` : ''}</small></h3>
    {!hideText && job.result && <p>{job.result.text || job.result.label || (job.kind === 'image' ? `${job.result.annotations?.length ?? 0}개 이미지 표시` : '')}</p>}
    {job.error && <p className="error">보조 작업이 실패했어요. 원문은 보존돼요.</p>}
    {job.chunks && job.chunks.length > 1 && <ol className="chunk-list">{job.chunks.map((chunk, index) => <li key={chunk.id}><span>구간 {index + 1} · {labels[chunk.status] || chunk.status} · 시도 {chunk.attempt}</span>{['failed', 'cancelled', 'partial', 'interrupted'].includes(chunk.status) && <button className="secondary" onClick={() => { void api(`/jobs/${job.id}/retry`, { chunkId: chunk.id }).then(refresh).catch(error => onError(error.message)); }}>이 구간만 재시도</button>}</li>)}</ol>}
    {['failed', 'cancelled', 'partial', 'interrupted'].includes(job.status) && <button className="secondary" onClick={() => { void api(`/jobs/${job.id}/retry`, {}).then(refresh).catch(error => onError(error.message)); }}>이 작업만 재시도</button>}
    {active && <button className="secondary" onClick={() => { void api(`/jobs/${job.id}/cancel`, {}).then(refresh).catch(error => onError(error.message)); }}>{title} 취소</button>}
    <details className="inspector"><summary>보조 작업의 실제 입력과 도구</summary><pre>{JSON.stringify({ jobId: job.id, sourceRevision: job.sourceRevision, sourceHash: job.sourceHash, input: (job as Job & { input?: unknown }).input, chunks: job.chunks }, null, 2)}</pre></details>
    {job.kind === 'status' && <small>표시용 annotation · 다음 이야기의 사실에 반영하지 않아요.</small>}
  </section>;
}
