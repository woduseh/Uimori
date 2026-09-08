import { displayTranslationJob } from './translation-display.js';
import {
  containedImageAnchors,
  resolveInlineImage,
  IMAGE_POSITION_UNAVAILABLE,
} from './image-placement.js';
import { StorySourceState } from './StoryPanel.js';
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Asset } from '../core/product.js';
import type { Job, ReaderRun, Source } from '../core/types.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { api, labels } from './api.js';
import { auxiliaryErrorDiagnostic } from './auxiliary-error.js';
import { Prose } from './Prose.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { ActionMenu } from './ActionMenu.js';
import { CopyIcon, EditIcon, ImagesIcon } from './ui-icons.js';
import { SourceSegmentsReader } from './SourceSegmentsReader.js';
import type { SourceSegmentPolicy } from '../core/source-segments.js';
import { PackageStateCards, usePackagePresentation } from './PackagePresentation.js';
import './source-edit.css';

type ReaderMode = 'original' | 'translation';
type ReaderProps = {
  source: Source;
  index: number;
  jobs: Job[];
  assets: Asset[];
  refresh: () => Promise<void>;
  onError: (error: string) => void;
  onFork: (sourceId: string) => Promise<void>;
  onRetry?: () => Promise<void>;
  retryDisabled?: boolean;
  onEditingChange?: (sourceId: string, editing: boolean) => void;
  request?: string;
  contextSummary?: ReaderRun['contextSummary'];
  packageStart?: { mode: 'authored' | 'generate'; title: string };
  activity?: ReactNode;
  sourceSegments?: SourceSegmentPolicy;
  hasPackages?: boolean;
  presentationRefreshKey?: string | number;
};
type AnchorPosition = { anchors: string[]; top: number; scrollport: HTMLElement };
type EditorOrigin = { button: HTMLElement; scrollport: HTMLElement; offset: number };

function initialMode(sourceId: string, hasTranslation: boolean): ReaderMode {
  if (!hasTranslation) return 'original';
  try {
    const saved = sessionStorage.getItem(`reader-mode:${sourceId}`);
    if (saved === 'original' || saved === 'translation') return saved;
    return localStorage.getItem('uimori:reading-language') === 'original'
      ? 'original'
      : 'translation';
  } catch {
    return 'translation';
  }
}
function currentAnchor(container: HTMLElement | null): AnchorPosition | undefined {
  const scrollport = container?.closest<HTMLElement>(
    '[data-reader-scrollport], .reader-scrollport'
  );
  if (!container || !scrollport) return;
  const viewport = scrollport.getBoundingClientRect();
  const nearest = [...container.querySelectorAll<HTMLElement>('[data-block-anchor]')].find(
    (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    }
  );
  return nearest
    ? {
        anchors: nearest.dataset.blockAnchor!.split(' '),
        top: nearest.getBoundingClientRect().top,
        scrollport,
      }
    : undefined;
}
const retryable = (status: string) =>
  ['failed', 'cancelled', 'partial', 'interrupted'].includes(status);
const activeJob = (job: Job) => job.status === 'queued' || job.status === 'running';
const jobTitle = (job: Job) =>
  job.kind === 'translation' ? '한국어 번역' : job.kind === 'status' ? '장면 상태' : '이미지 표시';

export function SourceReader(props: ReaderProps) {
  return <SourceReaderContent key={props.source.id} {...props} />;
}
function latestTranslation(source: Source, jobs: Job[]) {
  return jobs
    .filter(
      (job) =>
        job.kind === 'translation' &&
        job.sourceRevision === source.id &&
        job.sourceHash === source.hash &&
        job.status !== 'stale'
    )
    .sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1))
    .at(0);
}
function SourceReaderContent({
  source,
  index,
  jobs,
  assets,
  refresh: refreshSource,
  onFork,
  onRetry,
  retryDisabled,
  onEditingChange,
  request,
  contextSummary,
  packageStart,
  activity,
  sourceSegments,
  hasPackages,
  presentationRefreshKey,
}: ReaderProps) {
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = async () => {
    if (mounted.current) await refreshSource();
  };
  const container = useRef<HTMLElement>(null);
  const restoreAnchor = useRef<AnchorPosition | undefined>(undefined);
  const translation = latestTranslation(source, jobs);
  const displayTranslation = displayTranslationJob(source, translation);
  const latestStatus = jobs
    .filter(
      (job) =>
        job.kind === 'status' && job.sourceRevision === source.id && job.sourceHash === source.hash
    )
    .sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1))[0];
  const latestImageJob = jobs
    .filter((job) => job.kind === 'image' && job.sourceRevision === source.id)
    .sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1))[0];
  const presentation = usePackagePresentation(
    source,
    displayTranslation,
    hasPackages === true,
    `${presentationRefreshKey ?? ''}:${jobs.map((job) => `${job.id}:${job.status}`).join(',')}`
  );
  const projected = !sourceSegments ? presentation?.data : undefined;
  const [mode, setMode] = useState<ReaderMode>(() =>
    initialMode(source.id, !!displayTranslation?.result)
  );
  const [editor, setEditor] = useState<ReaderMode | null>(null);
  const editorOrigin = useRef<EditorOrigin | undefined>(undefined);
  const restoreEditor = useRef(false);
  useLayoutEffect(() => {
    if (!editor) return;
    onEditingChange?.(source.id, true);
    return () => onEditingChange?.(source.id, false);
  }, [editor, onEditingChange, source.id]);
  useLayoutEffect(() => {
    if (editor || !restoreEditor.current) return;
    restoreEditor.current = false;
    const origin = editorOrigin.current;
    editorOrigin.current = undefined;
    if (!origin) return;
    // The parent restores the composer when editing ends. Wait for that layout
    // before returning to the control beside the passage the reader was viewing.
    const frame = requestAnimationFrame(() => {
      const { button, scrollport, offset } = origin;
      if (!button.isConnected || !scrollport.isConnected) return;
      scrollport.scrollTop +=
        button.getBoundingClientRect().top - scrollport.getBoundingClientRect().top - offset;
      button.focus({ preventScroll: true });
      button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [editor]);
  const openEditor = (role: ReaderMode, button: HTMLButtonElement) => {
    const menu = button.closest<HTMLDetailsElement>('.action-menu');
    const origin = menu?.querySelector('summary') ?? button;
    const scrollport = origin.closest<HTMLElement>('[data-reader-scrollport]');
    editorOrigin.current = scrollport
      ? {
          button: origin,
          scrollport,
          offset: origin.getBoundingClientRect().top - scrollport.getBoundingClientRect().top,
        }
      : undefined;
    if (menu) menu.open = false;
    setEditor(role);
  };
  const closeEditor = () => {
    restoreEditor.current = true;
    setEditor(null);
  };
  const requestPending = useRef(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pending, setPending] = useState('');
  const [actionError, setActionError] = useState('');
  const validTranslation =
    displayTranslation?.result?.sourceRevision === source.id &&
    displayTranslation.result.sourceHash === source.hash
      ? displayTranslation.result
      : null;
  const blocks = source.blocks?.length
    ? source.blocks
    : [{ anchor: 'full', index: 0, text: source.text, start: 0, end: source.text.length }];
  const displayJobs = jobs.filter(
    (job) =>
      job.sourceHash === source.hash &&
      (job.kind !== 'translation' || job.id === translation?.id) &&
      (job.kind !== 'status' || job.id === latestStatus?.id)
  );
  const attentionJobs = displayJobs.filter((job) => activeJob(job) || retryable(job.status));
  const image = jobs
    .filter(
      (job) =>
        job.kind === 'image' &&
        job.sourceRevision === source.id &&
        job.sourceHash === source.hash &&
        job.status !== 'stale'
    )
    .sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1))
    .at(0);
  const annotations =
    image?.status === 'completed' &&
    image.result?.sourceRevision === source.id &&
    image.result.sourceHash === source.hash
      ? (image.result.annotations ?? [])
      : [];
  const status = latestStatus?.status === 'completed' ? latestStatus : undefined;
  const sceneStatus =
    status?.result?.sourceRevision === source.id && status.result.sourceHash === source.hash
      ? (status.result.label ?? status.result.text)
      : '';

  const previousHash = useRef(source.hash);
  useLayoutEffect(() => {
    if (previousHash.current !== source.hash) {
      previousHash.current = source.hash;
      setMode('original');
    }
  }, [source.hash]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore the captured scroll anchor after a reader mode or source hash change.
  useLayoutEffect(() => {
    const previous = restoreAnchor.current;
    restoreAnchor.current = undefined;
    if (!previous) return;
    const target = [
      ...(container.current?.querySelectorAll<HTMLElement>('[data-block-anchor]') ?? []),
    ].find((element) =>
      element.dataset.blockAnchor?.split(' ').some((anchor) => previous.anchors.includes(anchor))
    );
    if (target) previous.scrollport.scrollTop += target.getBoundingClientRect().top - previous.top;
  }, [mode, source.hash]);

  const switchMode = (next: ReaderMode) => {
    if (next === mode) return;
    restoreAnchor.current = currentAnchor(container.current);
    setMode(next);
    try {
      sessionStorage.setItem(`reader-mode:${source.id}`, next);
    } catch {
      /* Reading is available when storage is restricted. */
    }
  };
  const action = async (name: string, operation: () => Promise<unknown>) => {
    if (requestPending.current) return;
    requestPending.current = true;
    setPending(name);
    setActionError('');
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : '요청을 완료하지 못했어요.';
      if (mounted.current) setActionError(message);
    } finally {
      requestPending.current = false;
      setPending('');
    }
  };
  const viewTranslation = () => {
    switchMode('translation');
    if (validTranslation || (translation && activeJob(translation))) return;
    void action('translation', async () => {
      await api(`/sources/${source.id}/translation`, {});
      await refresh();
    });
  };
  const inline = (anchor: string) =>
    annotations
      .filter((annotation) => annotation.blockAnchor === anchor)
      .map((annotation) => {
        const asset = resolveInlineImage(assets, source.chatId, annotation);
        return asset ? (
          <figure
            className="inline-asset"
            key={`${anchor}:${asset.id}`}
            data-testid="inline-annotation"
            data-asset-ref={asset.id}
          >
            <img src={asset.url} alt={asset.description || asset.title} loading="lazy" />
            <figcaption>{annotation.caption || asset.title}</figcaption>
          </figure>
        ) : null;
      });
  return (
    <article
      ref={container}
      className="source"
      id={`source-${source.id}`}
      data-testid="source"
      data-source-id={source.id}
    >
      {packageStart?.mode === 'authored' && (
        <p className="muted" data-testid="authored-start">
          작성된 도입문 · {packageStart.title}
        </p>
      )}
      {packageStart?.mode !== 'authored' && request && (
        <div className="request-message" data-testid="source-request">
          <span className="request-label">내 요청</span>
          {request.length > 280 ? (
            <details>
              <summary>
                {request.slice(0, 240)}… <span>전체 보기</span>
              </summary>
              <p>{request}</p>
            </details>
          ) : (
            <p>{request}</p>
          )}
        </div>
      )}
      {activity}
      <div className="source-heading">
        <span className="folio">장면 {index + 1}</span>
        <small>{mode === 'translation' ? '한국어 번역' : '원문'}</small>
      </div>
      <div className="reader-toolbar">
        <div className="segmented" role="group" aria-label="원문과 번역 보기">
          <button
            type="button"
            className={mode === 'translation' ? '' : 'secondary'}
            aria-pressed={mode === 'translation'}
            disabled={pending === 'translation'}
            onClick={viewTranslation}
          >
            번역 보기
          </button>
          <button
            type="button"
            className={mode === 'original' ? '' : 'secondary'}
            aria-pressed={mode === 'original'}
            onClick={() => switchMode('original')}
          >
            원문 보기
          </button>
        </div>
      </div>
      {translation && !activeJob(translation) && !retryable(translation.status) && (
        <button
          type="button"
          className="secondary"
          disabled={!!pending || !!editor}
          onClick={() => {
            void action('translation', async () => {
              await api(`/sources/${source.id}/retranslate`, {});
              switchMode('translation');
              await refresh();
            });
          }}
        >
          현재 설정으로 새 번역
        </button>
      )}
      {!activity && <ContextSummaryStatus summary={contextSummary} />}
      {editor && (
        <TextEditor
          key={editor}
          role={editor}
          source={source}
          onCancel={closeEditor}
          onSaved={async () => {
            await refresh();
            if (mounted.current) {
              closeEditor();
              if (editor === 'translation') switchMode('translation');
            }
          }}
        />
      )}
      {validTranslation && translation?.status !== 'completed' && mode === 'translation' && (
        <p role="status">이전 완료 번역을 표시하고 있어요. 새 번역이 성공하면 교체돼요.</p>
      )}
      {validTranslation?.manual && mode === 'translation' && (
        <p className="muted">직접 수정한 번역</p>
      )}
      {sourceSegments && mode === 'original' ? (
        <SourceSegmentBody
          source={source}
          config={sourceSegments}
          blocks={blocks}
          inline={inline}
        />
      ) : mode === 'original' && projected?.original.changed ? (
        <div className="prose" data-testid="source-text">
          <div
            className="source-block"
            data-block-anchor={blocks.map((block) => block.anchor).join(' ')}
          >
            <Prose text={projected.original.text} />
          </div>
          {annotations.length > 0 && (
            <p className="muted" role="status">
              {IMAGE_POSITION_UNAVAILABLE}
            </p>
          )}
        </div>
      ) : mode === 'translation' && validTranslation && projected?.translation?.changed ? (
        <div className="prose translated" data-testid="translation-text">
          <div className="source-block">
            <Prose text={projected.translation.text} />
          </div>
          {annotations.length > 0 && (
            <p className="muted" role="status">
              {IMAGE_POSITION_UNAVAILABLE}
            </p>
          )}
        </div>
      ) : mode === 'original' ? (
        <div className="prose" data-testid="source-text">
          {source.text.slice(0, blocks[0].start)}
          {blocks.map((block, position) => (
            <Fragment key={block.anchor}>
              <div
                className="source-block"
                data-block-anchor={block.anchor}
                id={`block-${source.id}-${block.anchor}`}
              >
                <Prose
                  text={source.text.slice(
                    block.start,
                    blocks[position + 1]?.start ?? source.text.length
                  )}
                />
              </div>
              {inline(block.anchor)}
            </Fragment>
          ))}
        </div>
      ) : validTranslation ? (
        <div className="prose translated" data-testid="translation-text">
          <div className="source-block">
            <Prose text={validTranslation.text ?? ''} />
          </div>
          {annotations.length > 0 && (
            <p className="muted" role="status">
              {IMAGE_POSITION_UNAVAILABLE}
            </p>
          )}
        </div>
      ) : (
        <div className="translation-placeholder" role="status">
          <p>
            {translation
              ? activeJob(translation)
                ? '한국어 번역을 준비하고 있어요. 원문은 저장됐어요.'
                : '한국어 번역이 아직 준비되지 않았어요. 원문은 보존돼요.'
              : '이 장면에는 아직 한국어 번역이 없어요.'}
          </p>
          <button type="button" className="secondary" onClick={() => switchMode('original')}>
            원문부터 읽기
          </button>
        </div>
      )}
      {presentation?.error && (
        <p className="error" role="alert">
          {presentation.error}
        </p>
      )}
      <PackageStateCards data={presentation?.data} />
      {sceneStatus && (
        <aside className="scene-status" aria-label="현재 장면의 표시 상태">
          <small>장면 상태</small>
          <span>{sceneStatus}</span>
        </aside>
      )}
      {!activity && (
        <div className="derived-summary" aria-label="이 장면의 후속 작업">
          {attentionJobs.length
            ? attentionJobs.map((job) => (
                <div
                  className={retryable(job.status) ? 'job-summary has-error' : 'job-summary'}
                  key={job.id}
                  data-job-id={job.id}
                >
                  <span>
                    {jobTitle(job)} · {labels[job.status]}
                    {retryable(job.status) ? ' · 원문 보존됨' : ''}
                  </span>
                  {job.kind === 'translation' &&
                    job.error &&
                    /INPUT_CONTEXT_LIMIT_EXCEEDED|CONTEXT_WINDOW_EXCEEDED|TIMEOUT|AUXILIARY_PROVIDER_PARTIAL/.test(
                      job.error
                    ) && (
                      <p className="error">
                        {job.error.includes('TIMEOUT')
                          ? '번역 제한 시간이 초과됐어요.'
                          : job.error.includes('PARTIAL')
                            ? '모델 응답이 끝까지 완료되지 않았어요. 출력 한도와 공급자 진단을 확인해 주세요.'
                            : '번역 요청이 모델 입력 한도를 초과했어요.'}{' '}
                        구간을 자동으로 나누지 않았어요. 모델의 입력·출력 한도를 확인한 뒤 새 번역을
                        요청해 주세요.
                      </p>
                    )}
                  <JobActions job={job} refresh={refresh} onError={setActionError} compact />
                </div>
              ))
            : jobs.length > 0 && (
                <p className="muted">
                  {displayJobs.map((job) => `${jobTitle(job)} ${labels[job.status]}`).join(' · ')}
                </p>
              )}
        </div>
      )}
      <StorySourceState
        sourceId={source.id}
        refreshKey={`${source.hash}:${jobs.map((job) => job.status).join(',')}`}
      />
      <div className="source-actions">
        <ActionMenu label="장면 작업 메뉴" placement="top">
          {onRetry && (
            <button
              type="button"
              className="secondary"
              disabled={!!editor || !!pending || retryDisabled}
              onClick={() => void action('retry', onRetry)}
            >
              현재 설정으로 다시 요청
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={!!editor || !!pending}
            onClick={() => {
              void action('fork', () => onFork(source.id));
            }}
          >
            <CopyIcon size={18} aria-hidden="true" />
            {pending === 'fork' ? '이야기 복사 중…' : '여기서 새 이야기로 이어가기'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!!editor || !!pending}
            onClick={(event) => openEditor('original', event.currentTarget)}
          >
            <EditIcon size={18} aria-hidden="true" />
            원문 수정
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!!editor || !!pending}
            onClick={(event) => openEditor('translation', event.currentTarget)}
          >
            <EditIcon size={18} aria-hidden="true" />
            번역 수정
          </button>
          <button
            type="button"
            className="secondary"
            disabled={
              !!editor ||
              !!pending ||
              (!!latestImageJob &&
                activeJob(latestImageJob) &&
                latestImageJob.sourceHash === source.hash)
            }
            onClick={() =>
              void action('images', async () => {
                await api(`/sources/${source.id}/images`, {
                  expectedSourceHash: source.hash,
                  expectedRevision: latestImageJob?.revision ?? 0,
                });
                await refresh();
              })
            }
          >
            <ImagesIcon size={18} aria-hidden="true" />
            {pending === 'images'
              ? '이미지 선택을 예약하는 중…'
              : latestImageJob
                ? '이미지 다시 선택'
                : '이미지 선택'}
          </button>
        </ActionMenu>
      </div>
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      <details
        className="source-job-details"
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary>
          {activity ? '원문 연결 정보' : `작업 상세${jobs.length ? ` · ${jobs.length}개` : ''}`}
        </summary>
        {detailsOpen && (
          <>
            {!activity && (
              <div className="derived">
                {displayJobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    refresh={refresh}
                    onError={setActionError}
                    hideText={job.kind === 'translation'}
                  />
                ))}
              </div>
            )}
            <div className="inspector">
              <dl>
                <dt>source revision</dt>
                <dd>{source.id}</dd>
                <dt>parent revision</dt>
                <dd>{source.parentRevision || '시작'}</dd>
                <dt>SHA-256</dt>
                <dd>{source.hash}</dd>
              </dl>
              <details>
                <summary>현재 원문</summary>
                <pre data-testid="source-raw">{source.text}</pre>
              </details>
              <p>
                제목·강조·목록·인용·링크·코드를 표시해요. 속성 없는 ruby의 본문과 rt만 읽기 표기로
                표시하고, 나머지 HTML과 Markdown 이미지는 문자로 남겨요.
              </p>
            </div>
          </>
        )}
      </details>
    </article>
  );
}

export function SourceSegmentBody({
  source,
  config,
  blocks,
  inline,
}: {
  source: Source;
  config: SourceSegmentPolicy;
  blocks: { anchor: string; start: number; end: number }[];
  inline: (anchor: string) => ReactNode[];
}) {
  const original = { sourceRevision: source.id, sourceHash: source.hash, text: source.text };
  const emitted = new Set<string>();
  return (
    <div className="prose" data-testid="source-text">
      <SourceSegmentsReader
        source={original}
        policy={config}
        renderText={(text, segment) => {
          const anchors = blocks
            .filter((block) => block.start < segment.range.end && segment.range.start < block.end)
            .map((block) => block.anchor);
          const images = containedImageAnchors(blocks, segment.bodyRange).filter(
            (anchor) => !emitted.has(anchor)
          );
          images.forEach((anchor) => {
            emitted.add(anchor);
          });
          return (
            <div className="source-block" data-block-anchor={anchors.join(' ')}>
              <Prose text={text} />
              {images.flatMap(inline)}
            </div>
          );
        }}
      />
    </div>
  );
}

type Draft = { text: string; expectedRevision: number; expectedSourceHash: string };
function draftKey(sourceId: string, role: ReaderMode) {
  return `uimori:text-draft:${sourceId}:${role}`;
}
function readDraft(key: string, fallback: Draft): Draft {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Partial<Draft> | null;
    if (
      value &&
      typeof value.text === 'string' &&
      Number.isInteger(value.expectedRevision) &&
      typeof value.expectedSourceHash === 'string'
    )
      return value as Draft;
  } catch {
    /* Editing also works when browser storage is unavailable. */
  }
  return fallback;
}
function TextEditor({
  role,
  source,
  translation,
  onCancel,
  onSaved,
}: {
  role: ReaderMode;
  source: Source;
  translation?: Job;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const key = draftKey(source.id, role);
  const displayed = displayTranslationJob(source, translation);
  const savedText =
    role === 'original'
      ? source.text
      : (displayed?.result?.text ??
        displayed?.result?.segments?.map((segment) => segment.text).join('\n\n') ??
        displayed?.result?.blocks?.map((block) => block.text).join('\n\n') ??
        '');
  const revision =
    role === 'original'
      ? (source.editRevision ?? 0)
      : (translation?.revision ?? source.translationRevision ?? (translation ? 1 : 0));
  const [draft, setDraft] = useState(() =>
    readDraft(key, { text: savedText, expectedRevision: revision, expectedSourceHash: source.hash })
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = input.current;
    field?.focus({ preventScroll: true });
    // Focus stays in the user-triggered update so touch keyboards can open;
    // scrolling waits for the parent to release the composer's screen space.
    const frame = requestAnimationFrame(() =>
      field?.form?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' })
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  const title = role === 'original' ? '원문' : '번역';
  const conflict = draft.expectedSourceHash !== source.hash || draft.expectedRevision !== revision;
  const persist = (next: Draft) => {
    setDraft(next);
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Keep the in-memory draft. */
    }
  };
  const clear = () => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Storage may be restricted. */
    }
  };
  const cancel = () => {
    if (busy.current) return;
    clear();
    onCancel();
  };
  return (
    <form
      className="source-text-editor"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229)
          return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy.current) return;
        busy.current = true;
        setSaving(true);
        setError('');
        try {
          await api(
            `/sources/${source.id}/${role === 'original' ? 'text' : 'translation'}`,
            role === 'original'
              ? { text: draft.text, expectedRevision: draft.expectedRevision }
              : draft,
            'PUT'
          );
          await onSaved();
          clear();
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : '저장하지 못했어요. 작성한 내용은 유지돼요.'
          );
        } finally {
          busy.current = false;
          setSaving(false);
        }
      }}
    >
      <label>
        {title} 수정
        <textarea
          ref={input}
          aria-label={`${title} 수정 내용`}
          rows={12}
          maxLength={2000000}
          value={draft.text}
          disabled={saving}
          onChange={(event) => persist({ ...draft, text: event.target.value })}
        />
      </label>
      <small>
        {role === 'original'
          ? '수정한 원문은 다음 요청에 사용하고, 번역 보기를 누르면 새로 번역해요.'
          : '직접 저장한 번역은 모델을 호출하지 않아요.'}
      </small>
      {conflict && (
        <div role="alert" className="error">
          <p>편집 중 저장된 내용이 바뀌었어요. 작성한 내용은 유지돼요.</p>
          <details>
            <summary>현재 저장된 {title} 확인</summary>
            <pre>{savedText || '저장된 번역 없음'}</pre>
          </details>
          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={() => {
              persist({
                text: savedText,
                expectedRevision: revision,
                expectedSourceHash: source.hash,
              });
              setError('');
            }}
          >
            작성한 내용을 버리고 저장된 내용 다시 불러오기
          </button>
        </div>
      )}
      <div className="form-actions">
        <button type="submit" disabled={saving || conflict || !draft.text.trim()}>
          {saving ? '저장 중…' : `${title} 저장`}
        </button>
        <button type="button" className="secondary" disabled={saving} onClick={cancel}>
          수정 취소
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error} 작성한 내용은 유지돼요.
        </p>
      )}
    </form>
  );
}

function JobActions({
  job,
  refresh,
  onError,
  compact = false,
}: {
  job: Job;
  refresh: () => Promise<void>;
  onError: (error: string) => void;
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const perform = async (operation: 'retry' | 'cancel' | 'status') => {
    setPending(true);
    setError('');
    onError('');
    try {
      if (operation === 'status')
        await api(`/sources/${job.sourceRevision}/status`, {
          expectedSourceHash: job.sourceHash,
          expectedJobId: job.id,
        });
      else await api(`/jobs/${job.id}/${operation}`, {});
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : '요청을 완료하지 못했어요.';
      setError(message);
      onError(`${jobTitle(job)}: ${message}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {retryable(job.status) && (
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={() => {
            void perform('retry');
          }}
        >
          {job.kind === 'translation'
            ? '현재 설정으로 번역 재시도'
            : compact
              ? `${jobTitle(job)} 재시도`
              : '이 작업만 재시도'}
        </button>
      )}
      {activeJob(job) && (
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={() => {
            void perform('cancel');
          }}
        >
          {jobTitle(job)} 취소
        </button>
      )}
      {job.kind === 'status' && retryable(job.status) && (
        <>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => void perform('status')}
          >
            현재 설정으로 장면 상태 새로 실행
          </button>
          {!compact && (
            <small>
              채팅 설정에서 표시 상태 모델을 저장한 뒤 새로 실행해요. 기존 작업 재시도는 당시 설정을
              사용해요.
            </small>
          )}
        </>
      )}
      {error && (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}

export function JobCard({
  job,
  refresh,
  onError,
  hideText = false,
}: {
  job: Job;
  refresh: () => Promise<void>;
  onError: (error: string) => void;
  hideText?: boolean;
}) {
  const title = jobTitle(job);
  return (
    <section
      className="job"
      data-testid={`job-${job.kind}`}
      data-source-id={job.sourceRevision}
      data-job-id={job.id}
    >
      <h3>
        {job.result?.mock ? '모의 ' : ''}
        {title} <small>{labels[job.status]}</small>
      </h3>
      {!hideText && job.result && (job.kind !== 'translation' || job.status === 'completed') && (
        <p>
          {job.result.text ||
            job.result.label ||
            (job.kind === 'image' ? `${job.result.annotations?.length ?? 0}개 이미지 표시` : '')}
        </p>
      )}
      {job.error && <AuxiliaryError error={job.error} />}
      {job.kind === 'translation' &&
        job.error &&
        /INPUT_CONTEXT_LIMIT_EXCEEDED|CONTEXT_WINDOW_EXCEEDED|TIMEOUT|AUXILIARY_PROVIDER_PARTIAL/.test(
          job.error
        ) && (
          <p className="error">
            {job.error.includes('TIMEOUT')
              ? '번역 제한 시간이 초과됐어요.'
              : job.error.includes('PARTIAL')
                ? '모델 응답이 끝까지 완료되지 않았어요. 출력 한도와 공급자 진단을 확인해 주세요.'
                : '번역 요청이 모델 입력 한도를 초과했어요.'}{' '}
            구간을 자동으로 나누지 않았어요. 모델의 입력·출력 한도를 확인한 뒤 새 번역을 요청해
            주세요.
          </p>
        )}
      <JobActions job={job} refresh={refresh} onError={onError} />
      <LazyDiagnostics<Job & { input?: unknown }>
        path={`/jobs/${job.id}`}
        revision={`${job.status}:${job.attempt}:${job.revision}`}
        title="보조 작업의 실제 입력과 도구"
      >
        {(value) => (
          <pre>
            {JSON.stringify(
              {
                jobId: value.id,
                sourceRevision: value.sourceRevision,
                sourceHash: value.sourceHash,
                error: auxiliaryErrorDiagnostic(value.error).code,
                input: value.input,
              },
              null,
              2
            )}
          </pre>
        )}
      </LazyDiagnostics>
      {job.kind === 'status' && (
        <small>현재 장면의 표시예요. 다음 이야기의 사실에는 반영하지 않아요.</small>
      )}
    </section>
  );
}

function AuxiliaryError({ error }: { error: string }) {
  const diagnostic = auxiliaryErrorDiagnostic(error);
  return (
    <div className="error" role="alert">
      <p>{diagnostic.message} 원문은 보존돼요.</p>
      <p>{diagnostic.action}</p>
      {diagnostic.code && <small>오류 코드: {diagnostic.code}</small>}
    </div>
  );
}
