import { themeBodyScroll, readerLocation } from './theme-body-scroll.js';
import { BookmarkButton } from './Bookmarks.js';
import { captureReaderLocation } from './useReadingSync.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { ThemeFrame } from './ThemeFrame.js';
import { canRejudgeTranslation } from '../core/translation-recovery.js';
import { displayTranslationJob } from './translation-display.js';
import { resolveInlineImage, IMAGE_POSITION_UNAVAILABLE } from './image-placement.js';
import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Asset } from '../core/product.js';
import type { Illustration } from '../core/illustration.js';
import type { ImageTarget, Job, ReaderRun, Source } from '../core/types.js';
import { useIllustrationLayout } from './IllustrationStrip.js';
import { illustrationActive } from './illustration-labels.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { formatUsd } from './pricing-display.js';
import { api, labels } from './api.js';
import { auxiliaryErrorDiagnostic } from './auxiliary-error.js';
import { ProviderRejectionNotice } from './provider-rejection.js';
import { Prose } from './Prose.js';
import { selectedReaderText } from './reader-dom.js';
import { RisuMessageSurface } from './RisuMessageSurface.js';
import { retainReaderNavigation } from './reader-navigation-scroll.js';
import { RisuInteractionDialog } from './RisuInteractionDialog.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { CopyIcon, EditIcon, IllustrationIcon, ImagesIcon, RefreshIcon } from './ui-icons.js';
import {
  GitFork,
  Info,
  Languages,
  MessageCircleQuestion,
  ReceiptText,
  Save,
  X,
} from 'lucide-react';
import { Dialog } from './Dialog.js';
import { CodexContentWarningDialog } from './CodexContentWarningDialog.js';
import { useCodexContentWarning } from './useCodexContentWarning.js';

import { PackagePresentationIssues, usePackagePresentation } from './PackagePresentation.js';
import './source-edit.css';
import { SourceVersions } from './SourceVersions.js';
import { RequestMessage } from './RequestMessage.js';
import { SelectionRevision } from './SelectionRevision.js';

type ReaderMode = 'original' | 'translation';
/** Scene header pieces the activity panel places inside its summary row. */
type SceneHeaderSlots = { leading: ReactNode; badges: ReactNode };
type ReaderProps = {
  portrait?: ReactNode;
  requestPersona?: ReactNode;
  readerTarget?: ReaderTarget;
  source: Source;
  index: number;
  sceneNumber?: number;
  jobs: Job[];
  /** Scene illustrations attached to this response; absent while the feature is unused. */
  illustrations?: Illustration[];
  illustrationsCollapsed?: boolean;
  assets: Asset[];
  refresh: () => Promise<void>;
  onError: (error: string) => void;
  onNativeNotice?: (messages: string[]) => void;
  onFork: (sourceId: string) => Promise<void>;
  onRetry?: (mode?: 'replace' | 'copy') => Promise<void>;
  retryCanReplace?: boolean;
  onModelSettings?: () => void;
  retryDisabled?: boolean;
  onEditingChange?: (sourceId: string, editing: boolean) => void;
  request?: string;
  /** The newest scene keeps its request actions standing on narrow widths. */
  latest?: boolean;
  onEditRequest?: (text: string) => Promise<boolean>;
  onCheckRequest?: () => Promise<boolean>;
  onAskHelper?: (sourceId: string, text: string) => void;
  contextSummary?: ReaderRun['contextSummary'];
  estimatedCost?: ReaderRun['estimatedCost'];
  packageStart?: { mode: 'authored'; title: string };
  /** Wraps the scene header in the per-response activity panel; falsy keeps a plain header. */
  activity?: (slots: SceneHeaderSlots) => ReactNode;
  hasPackages?: boolean;
  presentationRefreshKey?: string | number;
  nativeInteractionRevision?: number;
};
type AnchorPosition = { anchors: string[]; top: number; scrollport: HTMLElement };
type EditorOrigin = {
  button: HTMLElement;
  scrollport: HTMLElement;
  offset: number;
  body?: HTMLElement;
  bodyTop?: number;
};

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
  const outer = container?.closest<HTMLElement>('[data-reader-scrollport], .reader-scrollport');
  if (!container || !outer) return;
  if (!themeBodyScroll(container)) {
    const viewport = outer.getBoundingClientRect();
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
          scrollport: outer,
        }
      : undefined;
  }
  const location = readerLocation(outer, container);
  return location?.block
    ? {
        anchors: location.block.dataset.blockAnchor!.split(' '),
        top: location.block.getBoundingClientRect().top,
        scrollport: location.scrollport,
      }
    : undefined;
}
const retryable = (status: string) =>
  ['failed', 'cancelled', 'partial', 'interrupted'].includes(status);
const activeJob = (job: Job) => job.status === 'queued' || job.status === 'running';
const jobTitle = (job: Job) =>
  job.kind === 'translation'
    ? '한국어 번역'
    : job.kind === 'status'
      ? '이전 보조 작업'
      : `${job.imageTarget?.mode === 'translation' ? '번역' : '원문'} 이미지 배치`;
const translationPlaceholderMessages: Partial<Record<Job['status'], string>> = {
  queued: '한국어 번역을 준비하고 있어요. 원문은 저장됐어요.',
  running: '한국어 번역을 준비하고 있어요. 원문은 저장됐어요.',
  failed: '한국어 번역을 완료하지 못했어요. 원문은 보존돼요.',
  cancelled: '한국어 번역을 취소했어요. 원문은 보존돼요.',
  interrupted: '한국어 번역이 중단됐어요. 원문은 보존돼요.',
  partial: '한국어 번역이 일부만 생성됐어요. 원문은 보존돼요.',
};

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
  portrait,
  requestPersona,
  readerTarget,
  source,
  index,
  sceneNumber,
  jobs,
  illustrations = [],
  illustrationsCollapsed = false,
  assets,
  refresh: refreshSource,
  onError,
  onNativeNotice,
  onFork,
  onRetry,
  retryCanReplace = false,
  onModelSettings,
  retryDisabled,
  onEditingChange,
  request,
  latest,
  onEditRequest,
  onCheckRequest,
  onAskHelper,
  contextSummary,
  estimatedCost,
  packageStart,
  activity,
  hasPackages,
  presentationRefreshKey,
  nativeInteractionRevision,
}: ReaderProps) {
  const onRequestEditing = useCallback(
    (editing: boolean) => {
      onEditingChange?.(`${source.id}:request`, editing);
    },
    [onEditingChange, source.id]
  );
  const codexWarning = useCodexContentWarning();
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
  const presentation = usePackagePresentation(
    source,
    displayTranslation,
    hasPackages === true,
    String(presentationRefreshKey ?? '')
  );
  const projected = presentation?.data;
  const nativeAction = async (kind: 'trigger' | 'button', name: string) => {
    if (!projected?.nativeAction) return;
    try {
      const result = await api<{ notifications?: { kind: string; message: string }[] }>(
        `/chats/${source.chatId}/sources/${source.id}/risu-action`,
        {
          ...projected.nativeAction,
          kind,
          name,
          idempotencyKey: crypto.randomUUID(),
        }
      );
      if (result.notifications?.length)
        onNativeNotice?.(result.notifications.map((notice) => notice.message));
      await refresh();
    } catch (error) {
      onError((error as Error).message);
      throw error;
    }
  };
  const [mode, setMode] = useState<ReaderMode>(() =>
    initialMode(source.id, !!displayTranslation?.result)
  );
  const appliedTarget = useRef<ReaderTarget | undefined>(undefined);
  const targetTranslationAvailable = !!displayTranslation?.result;
  useLayoutEffect(() => {
    if (appliedTarget.current === readerTarget) return;
    appliedTarget.current = readerTarget;
    if (readerTarget?.sourceId === source.id)
      setMode(
        readerTarget.representation === 'translation' && targetTranslationAvailable
          ? 'translation'
          : 'original'
      );
  }, [readerTarget, source.id, targetTranslationAvailable]);
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
    let release: (() => void) | undefined;
    const frame = requestAnimationFrame(() => {
      const { button, scrollport, offset } = origin;
      if (!button.isConnected || !scrollport.isConnected) return;
      let focused = false;
      release = retainReaderNavigation(
        scrollport,
        {
          kind: 'source',
          element: button,
          ...(origin.body?.isConnected ? { bodyTop: origin.bodyTop } : {}),
          offset: Math.max(
            0,
            Math.min(offset, scrollport.clientHeight - button.getBoundingClientRect().height - 8)
          ),
        },
        () => button.isConnected && scrollport.isConnected,
        () => {
          if (!focused) button.focus({ preventScroll: true });
          focused = true;
        }
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      release?.();
    };
  }, [editor]);
  const openEditor = (role: ReaderMode, button: HTMLButtonElement) => {
    const menu = button.closest<HTMLDetailsElement>('.action-menu');
    const origin = menu?.querySelector('summary') ?? button;
    const scrollport = origin.closest<HTMLElement>('[data-reader-scrollport]');
    const body = themeBodyScroll(container.current);
    editorOrigin.current = scrollport
      ? {
          button: origin,
          scrollport,
          offset: origin.getBoundingClientRect().top - scrollport.getBoundingClientRect().top,
          ...(body ? { body, bodyTop: body.scrollTop } : {}),
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
  const [costOpen, setCostOpen] = useState(false);
  const openInfo = (button: HTMLButtonElement, kind: 'details' | 'cost') => {
    const menu = button.closest<HTMLDetailsElement>('.action-menu');
    if (menu) {
      menu.open = false;
      menu.querySelector('summary')?.focus({ preventScroll: true });
    }
    if (kind === 'details') setDetailsOpen(true);
    else setCostOpen(true);
  };
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
  const imageTarget: ImageTarget | undefined =
    mode === 'original'
      ? { mode: 'original', textHash: source.hash }
      : validTranslation && displayTranslation?.translationLayout
        ? {
            mode: 'translation',
            textHash: displayTranslation.translationLayout.textHash,
            translationJobId: displayTranslation.id,
            translationRevision: displayTranslation.revision ?? 1,
          }
        : undefined;
  const matchesImageTarget = (target?: ImageTarget) =>
    !!imageTarget &&
    !!target &&
    target.mode === imageTarget.mode &&
    target.textHash === imageTarget.textHash &&
    (target.mode === 'original' ||
      (imageTarget.mode === 'translation' &&
        target.translationJobId === imageTarget.translationJobId &&
        target.translationRevision === imageTarget.translationRevision));
  const latestImageJob = jobs
    .filter(
      (job) =>
        job.kind === 'image' &&
        job.sourceRevision === source.id &&
        (job.imageTarget?.mode ?? 'original') === mode
    )
    .sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1))[0];
  const displayJobs = jobs.filter(
    (job) =>
      job.sourceHash === source.hash &&
      (job.kind !== 'translation' || job.id === translation?.id) &&
      job.kind !== 'status' &&
      (job.kind !== 'image' ||
        (job.id === latestImageJob?.id && matchesImageTarget(job.imageTarget)))
  );
  const attentionJobs = displayJobs.filter((job) => activeJob(job) || retryable(job.status));
  const image =
    latestImageJob && matchesImageTarget(latestImageJob.imageTarget) ? latestImageJob : undefined;
  const annotations =
    image?.status === 'completed' &&
    image.result?.sourceRevision === source.id &&
    image.result.sourceHash === source.hash &&
    matchesImageTarget(image.result.imageTarget)
      ? (image.result.annotations ?? [])
      : [];
  const translationText = validTranslation?.text ?? '';
  const translationBlocks = displayTranslation?.translationLayout?.blocks ?? [];
  const displayedNative = mode === 'original' ? projected?.original : projected?.translation;
  const [nativeAnchors, setNativeAnchors] = useState<{ html?: string; anchors: string[] }>({
    anchors: [],
  });
  const receiveNativeAnchors = useCallback(
    (anchors: string[]) => {
      setNativeAnchors({ html: displayedNative?.html, anchors });
    },
    [displayedNative?.html]
  );
  const illustrationLayout = useIllustrationLayout({
    sourceId: source.id,
    sourceHash: source.hash,
    illustrations,
    mode,
    translationHash:
      mode === 'translation' ? displayTranslation?.translationLayout?.textHash : undefined,
    anchors: (mode === 'original' ? blocks : translationBlocks).map((block) => block.anchor),
    canInline:
      projected?.format === 'risu-html' ||
      !(mode === 'original' ? projected?.original.changed : projected?.translation?.changed),
    inlineAnchors:
      projected?.format === 'risu-html'
        ? nativeAnchors.html === displayedNative?.html
          ? nativeAnchors.anchors
          : []
        : undefined,
    defaultCollapsed: illustrationsCollapsed,
    refresh,
    onError: setActionError,
  });
  const [illustrationDialog, setIllustrationDialog] = useState(false);
  const [retryDialog, setRetryDialog] = useState(false);
  const [illustrationCount, setIllustrationCount] = useState(1);
  const illustrationRequestKey = useRef('');
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
    if (validTranslation || (translation && activeJob(translation))) {
      switchMode('translation');
      return;
    }
    void action('translation', async () => {
      const proceed = await codexWarning.check(
        `/sources/${source.id}/codex-content-preflight`,
        {},
        'translation'
      );
      if (!proceed || !mounted.current) return;
      switchMode('translation');
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
  const showToggle = !!translation || mode === 'translation';
  const leading = (
    <span className="folio">
      {packageStart?.mode === 'authored'
        ? '첫 메시지 · ' + packageStart.title
        : '장면 ' + (sceneNumber ?? index + 1)}
    </span>
  );
  const badges =
    validTranslation?.manual && mode === 'translation' ? (
      <span className="scene-badge">직접 수정한 번역</span>
    ) : null;
  const trailing = (
    <div className="segmented compact" role="group" aria-label="원문과 번역 보기">
      <button
        type="button"
        aria-label="번역 보기"
        aria-pressed={mode === 'translation'}
        disabled={pending === 'translation'}
        onClick={viewTranslation}
      >
        {showToggle ? '번역' : '번역 보기'}
      </button>
      {showToggle && (
        <button
          type="button"
          aria-label="원문 보기"
          aria-pressed={mode === 'original'}
          onClick={() => switchMode('original')}
        >
          원문
        </button>
      )}
    </div>
  );
  const activityNode = activity?.({ leading, badges }) || null;
  const canRetranslate = !!translation && !activeJob(translation) && !retryable(translation.status);
  // The menu entry names the scope, the existing translation stays until the new one lands,
  // and the turn's task panel cancels a running translation. No extra confirmation step.
  const retranslate = () => {
    void action('translation', async () => {
      const proceed = await codexWarning.check(
        `/sources/${source.id}/codex-content-preflight`,
        {},
        'translation'
      );
      if (!proceed || !mounted.current) return;
      await api(`/sources/${source.id}/retranslate`, {});
      switchMode('translation');
      await refresh();
    });
  };
  const otherEditor: ReaderMode = mode === 'translation' ? 'original' : 'translation';
  const editorLabel = (role: ReaderMode) => (role === 'translation' ? '번역 수정' : '원문 수정');
  const copyCurrent = () =>
    void action('copy', async () => {
      const text = mode === 'translation' ? (validTranslation?.text ?? '') : source.text;
      if (!navigator.clipboard) throw new Error('이 브라우저에서는 복사를 지원하지 않아요.');
      await navigator.clipboard.writeText(text);
    });
  return (
    <article
      ref={container}
      className="source"
      id={`source-${source.id}`}
      data-testid="source"
      data-source-id={source.id}
      data-representation={mode}
      data-content-hash={
        mode === 'translation' ? displayTranslation?.translationLayout?.textHash : source.hash
      }
      data-uimori-part="scene"
    >
      <CodexContentWarningDialog gate={codexWarning} />
      {latest && projected?.format === 'risu-html' && (
        <RisuInteractionDialog
          chatId={source.chatId}
          refreshKey={nativeInteractionRevision}
          onError={onError}
        />
      )}
      <ThemeFrame
        portrait={portrait}
        requestPersona={request && packageStart?.mode !== 'authored' ? requestPersona : undefined}
      >
        <div slot="request" data-uimori-part="request">
          {packageStart?.mode !== 'authored' && request && (
            <RequestMessage
              runId={source.runId}
              request={request}
              displayText={presentation?.data?.request?.text}
              compactActions={latest ? 'always' : 'tap'}
              onSubmit={onEditRequest}
              onConfirm={onCheckRequest}
              disabled={retryDisabled}
              onEditingChange={onRequestEditing}
            />
          )}
        </div>
        <div slot="heading" data-uimori-part="heading">
          <div className="scene-header">
            {activityNode ?? (
              <div className="scene-header-lead">
                {leading}
                {badges}
              </div>
            )}
            <div className="scene-header-tools">{trailing}</div>
          </div>
          {!activityNode && <ContextSummaryStatus summary={contextSummary} />}
        </div>
        <div slot="body" data-uimori-part="body">
          {editor && (
            <TextEditor
              key={editor}
              role={editor}
              source={source}
              translation={translation}
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
          <div hidden={!!editor} className="source-reading-content">
            {illustrationLayout.header}
            {validTranslation && translation?.status !== 'completed' && mode === 'translation' && (
              <p role="status">이전 완료 번역을 표시하고 있어요. 새 번역이 성공하면 교체돼요.</p>
            )}
            {hasPackages && !presentation ? (
              <p role="status">봇 화면을 준비하고 있어요.</p>
            ) : projected?.format === 'risu-html' &&
              (mode === 'original' ||
                (validTranslation && projected.translation?.html !== undefined)) ? (
              <div
                data-testid={mode === 'original' ? 'source-text' : 'translation-text'}
                data-block-anchor={(mode === 'original' ? blocks : translationBlocks)
                  .map((block) => block.anchor)
                  .join(' ')}
              >
                <RisuMessageSurface
                  html={displayedNative?.html ?? ''}
                  css={displayedNative?.css}
                  onAction={nativeAction}
                  disabled={presentation?.pending}
                  revisionKey={`${source.id}:${projected.nativeAction?.expectedHeadRevision ?? ''}:${projected.nativeAction?.expectedVariableRevision ?? ''}`}
                  onIllustrationAnchors={receiveNativeAnchors}
                  illustrations={(nativeAnchors.html === displayedNative?.html
                    ? nativeAnchors.anchors
                    : []
                  ).flatMap((anchor) => {
                    const content = illustrationLayout.inline(anchor);
                    return content ? [{ anchor, content }] : [];
                  })}
                />
              </div>
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
                    {illustrationLayout.inline(block.anchor)}
                  </Fragment>
                ))}
              </div>
            ) : validTranslation ? (
              <div className="prose translated" data-testid="translation-text">
                {translationBlocks.length ? (
                  <>
                    {translationText.slice(0, translationBlocks[0].start)}
                    {translationBlocks.map((block, position) => (
                      <Fragment key={block.anchor}>
                        <div className="source-block" data-block-anchor={block.anchor}>
                          <Prose
                            text={
                              block.text +
                              translationText.slice(
                                block.end,
                                translationBlocks[position + 1]?.start ?? translationText.length
                              )
                            }
                          />
                        </div>
                        {inline(block.anchor)}
                        {illustrationLayout.inline(block.anchor)}
                      </Fragment>
                    ))}
                  </>
                ) : (
                  <div className="source-block">
                    <Prose text={translationText} />
                  </div>
                )}
              </div>
            ) : (
              <div className="translation-placeholder" role="status">
                <p>
                  {translation
                    ? (translationPlaceholderMessages[translation.status] ??
                      '한국어 번역이 아직 준비되지 않았어요. 원문은 보존돼요.')
                    : '이 장면에는 아직 한국어 번역이 없어요.'}
                </p>
                <div className="form-actions">
                  {translation && retryable(translation.status) && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={!!editor || !!pending || retryDisabled}
                      onClick={viewTranslation}
                    >
                      번역 다시 시도
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => switchMode('original')}
                  >
                    원문부터 읽기
                  </button>
                </div>
              </div>
            )}
            {illustrationLayout.footer}
          </div>
          {presentation?.error && (
            <p className="error" role="alert">
              {presentation.error}
            </p>
          )}
          <PackagePresentationIssues data={presentation?.data} />
          {!activityNode && (
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
                      {job.error && <AuxiliaryError error={job.error} />}
                      <JobActions job={job} refresh={refresh} onError={setActionError} compact />
                    </div>
                  ))
                : jobs.length > 0 && (
                    <p className="muted">
                      {displayJobs
                        .map((job) => `${jobTitle(job)} ${labels[job.status]}`)
                        .join(' · ')}
                    </p>
                  )}
            </div>
          )}
        </div>
        <div slot="actions" data-uimori-part="actions" className="source-actions">
          <IconButton
            label="본문 복사"
            icon={CopyIcon}
            size={18}
            className="scene-action"
            disabled={!!editor || !!pending}
            onClick={copyCurrent}
          />
          <IconButton
            label={editorLabel(mode)}
            icon={EditIcon}
            size={18}
            className="scene-action"
            disabled={!!editor || !!pending}
            onClick={(event) => openEditor(mode, event.currentTarget)}
          />
          <BookmarkButton
            title={sceneNumber ? `장면 ${sceneNumber}` : '첫 메시지'}
            disabled={!!editor || !!pending}
            capture={() => {
              const article = container.current;
              const scrollport = article?.closest<HTMLElement>('[data-reader-scrollport]');
              if (!article || !scrollport) return null;
              const target = captureReaderLocation(scrollport, source.chatId, article);
              return target
                ? {
                    target,
                    quote: (
                      selectedReaderText(article) ||
                      (mode === 'translation' ? translationText : source.text)
                    ).slice(0, 300),
                  }
                : null;
            }}
          />
          <ActionMenu label="장면 작업 메뉴" placement="top">
            {onAskHelper && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  const selected = selectedReaderText(container.current);
                  onAskHelper(source.id, selected || source.text);
                }}
              >
                <MessageCircleQuestion size={18} aria-hidden="true" />
                도우미에게 물어보기
              </button>
            )}
            {onRetry && (
              <button
                type="button"
                className="secondary"
                disabled={!!editor || !!pending || retryDisabled}
                onClick={() => {
                  if (retryCanReplace) setRetryDialog(true);
                  else void action('retry', () => onRetry('copy'));
                }}
              >
                <RefreshIcon size={18} aria-hidden="true" />
                현재 설정으로 다시 요청
              </button>
            )}
            {canRetranslate && (
              <button
                type="button"
                className="secondary"
                disabled={!!pending || !!editor}
                onClick={retranslate}
              >
                <Languages size={18} aria-hidden="true" />
                현재 설정으로 새 번역
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
              <GitFork size={18} aria-hidden="true" />
              {pending === 'fork' ? '채팅 복사 중…' : '이 장면까지 새 채팅으로 복사'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!!editor || !!pending}
              onClick={(event) => openEditor(otherEditor, event.currentTarget)}
            >
              <EditIcon size={18} aria-hidden="true" />
              {editorLabel(otherEditor)}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!!editor || !!pending || !imageTarget || (!!image && activeJob(image))}
              onClick={() =>
                void action('images', async () => {
                  await api(`/sources/${source.id}/images`, {
                    target: mode,
                    expectedSourceHash: source.hash,
                    expectedRevision: latestImageJob?.revision ?? 0,
                    ...(imageTarget?.mode === 'translation'
                      ? {
                          expectedTranslationJobId: imageTarget.translationJobId,
                          expectedTranslationRevision: imageTarget.translationRevision,
                        }
                      : {}),
                  });
                  await refresh();
                })
              }
            >
              <ImagesIcon size={18} aria-hidden="true" />
              {pending === 'images' || (image && activeJob(image))
                ? '이미지를 배치하는 중…'
                : image?.status === 'completed'
                  ? '이미지 다시 배치'
                  : '이미지 자동 배치'}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="illustrate"
              disabled={
                !!editor ||
                !!pending ||
                illustrations.some(
                  (item) =>
                    item.sourceHash === source.hash &&
                    item.task === 'plan' &&
                    illustrationActive(item)
                )
              }
              onClick={() => {
                illustrationRequestKey.current = crypto.randomUUID();
                setIllustrationDialog(true);
              }}
            >
              <IllustrationIcon size={18} aria-hidden="true" />
              {illustrations.some(
                (item) =>
                  item.sourceHash === source.hash &&
                  item.task === 'plan' &&
                  illustrationActive(item)
              )
                ? '삽화 구간을 고르는 중…'
                : illustrations.some((item) => item.images.length > 0)
                  ? '새 삽화 생성'
                  : '삽화 생성'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={(event) => openInfo(event.currentTarget, 'details')}
            >
              <Info size={18} aria-hidden="true" />
              {activityNode ? '원문 연결 정보' : '작업 상세'}
            </button>
            {estimatedCost && estimatedCost.attemptCount > 0 && (
              <button
                type="button"
                className="secondary"
                onClick={(event) => openInfo(event.currentTarget, 'cost')}
              >
                <ReceiptText size={18} aria-hidden="true" />
                본문 추정 비용
              </button>
            )}
          </ActionMenu>
          <Dialog
            open={retryDialog}
            onClose={() => setRetryDialog(false)}
            title="현재 설정으로 다시 요청"
            className="source-retry-dialog"
          >
            <p>새 응답을 어디에 남길까요?</p>
            <p className="muted">
              기존 응답 교체는 새 생성이 성공했을 때만 적용해요. 실패하거나 취소하면 기존 응답을
              유지해요.
            </p>
            <div className="form-actions">
              <button type="button" className="secondary" onClick={() => setRetryDialog(false)}>
                취소
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!!pending || retryDisabled}
                onClick={() => {
                  setRetryDialog(false);
                  void action('retry', () => onRetry?.('copy') ?? Promise.resolve());
                }}
              >
                <GitFork size={18} aria-hidden="true" />새 채팅에서 다시 요청
              </button>
              <button
                type="button"
                disabled={!!pending || retryDisabled || !retryCanReplace}
                onClick={() => {
                  setRetryDialog(false);
                  void action('retry', () => onRetry?.('replace') ?? Promise.resolve());
                }}
              >
                <RefreshIcon size={18} aria-hidden="true" />
                기존 응답 교체
              </button>
            </div>
          </Dialog>
          <Dialog
            open={illustrationDialog}
            onClose={() => {
              if (pending !== 'illustrate') setIllustrationDialog(false);
            }}
            title="삽화 생성"
          >
            <p>
              응답에서 서로 다른 순간을 골라요. 대표 컷은 맨 위에, 나머지는 해당 문단 뒤에 넣어요.
            </p>
            <label>
              최대 컷 수
              <select
                aria-label="최대 컷 수"
                value={illustrationCount}
                disabled={pending === 'illustrate'}
                onChange={(event) => {
                  setIllustrationCount(Number(event.target.value));
                  illustrationRequestKey.current = crypto.randomUUID();
                }}
              >
                {Array.from({ length: 8 }, (_, index) => (
                  <option key={index + 1} value={index + 1}>
                    {index + 1}컷
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              그릴 만한 순간이 적으면 더 적게 만들어요. 응답당 남은 한도 안에서 예약하며, 생성
              중에도 다음 채팅을 이어갈 수 있어요.
            </p>
            {actionError && (
              <p className="error" role="alert">
                {actionError}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={pending === 'illustrate'}
                onClick={() => setIllustrationDialog(false)}
              >
                닫기
              </button>
              <button
                type="button"
                disabled={pending === 'illustrate'}
                onClick={() =>
                  void action('illustrate', async () => {
                    await api(`/sources/${source.id}/illustrations`, {
                      expectedSourceHash: source.hash,
                      maxTargets: illustrationCount,
                      idempotencyKey: illustrationRequestKey.current,
                    });
                    setIllustrationDialog(false);
                    await refresh();
                  })
                }
              >
                {pending === 'illustrate' ? '예약 중…' : '삽화 만들기'}
              </button>
            </div>
          </Dialog>
          <Dialog
            open={detailsOpen}
            onClose={() => setDetailsOpen(false)}
            title={activityNode ? '원문 연결 정보' : '작업 상세'}
            className="source-info-dialog"
          >
            {detailsOpen && (
              <>
                {!activityNode && (
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
                    제목·강조·목록·인용·링크·코드를 표시해요. 속성 없는 ruby의 본문과 rt만 읽기
                    표기로 표시하고, 나머지 HTML과 Markdown 이미지는 문자로 남겨요.
                  </p>
                </div>
              </>
            )}
          </Dialog>
        </div>
        {estimatedCost && estimatedCost.attemptCount > 0 && (
          <Dialog
            open={costOpen}
            onClose={() => setCostOpen(false)}
            title="본문 추정 비용"
            className="source-info-dialog"
          >
            <p className="source-cost-value">
              {estimatedCost.usd !== null && estimatedCost.unknownCount === 0
                ? formatUsd(estimatedCost.usd)
                : `· 확인분 부분합 ${estimatedCost.subtotalUsd === 0 && estimatedCost.unknownCount === estimatedCost.attemptCount ? '미확인' : formatUsd(estimatedCost.subtotalUsd)} · 미확인 ${estimatedCost.unknownCount}회 포함`}
            </p>
            <p>
              호출 후 프로바이더가 보고한 토큰과 호출에 고정된 요금으로 계산해요. 참고용 추정
              금액이며 실제 청구액과 다를 수 있어요.
            </p>
            <p>본문과 작문 보조 호출 기준 · 번역·제목 등 후속 작업은 작업 현황에서 확인해요.</p>
            {estimatedCost.unknownCount > 0 && (
              <p>부분합은 확인된 금액만 더한 값이며 전체 추정 비용은 아직 미확인이에요.</p>
            )}
          </Dialog>
        )}
        {actionError && (
          <p className="error source-action-error" role="alert">
            {actionError}
            {onModelSettings && (
              <button type="button" className="secondary" onClick={onModelSettings}>
                전역 모델 설정
              </button>
            )}
          </p>
        )}
      </ThemeFrame>
    </article>
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
  const savedText = role === 'original' ? source.text : (displayed?.result?.text ?? '');
  const revision =
    role === 'original'
      ? (source.editRevision ?? 0)
      : (translation?.revision ?? source.translationRevision ?? (translation ? 1 : 0));
  const [draft, setDraft] = useState(() =>
    readDraft(key, { text: savedText, expectedRevision: revision, expectedSourceHash: source.hash })
  );
  const [saving, setSaving] = useState(false);
  const draftVersion = useRef(0);
  const [selection, setSelection] = useState({ start: 0, end: 0, version: 0 });
  const [error, setError] = useState('');
  const busy = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = input.current;
    field?.focus({ preventScroll: true });
    // Focus stays in the user-triggered update so touch keyboards can open;
    // scrolling waits for the parent to release the composer's screen space.
    const frame = requestAnimationFrame(() => {
      const form = field?.form;
      const reader = form?.closest<HTMLElement>('[data-reader-scrollport], .reader-scrollport');
      if (!form || !reader) return;
      // scrollIntoView also moves overflow-hidden ancestors, including the app shell.
      // Only the marked theme body and reader own this editor's scroll position.
      const body = themeBodyScroll(form);
      if (body)
        body.scrollTop += form.getBoundingClientRect().top - body.getBoundingClientRect().top;
      reader.scrollTop +=
        form.getBoundingClientRect().top - reader.getBoundingClientRect().top - 12;
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const title = role === 'original' ? '원문' : '번역';
  const conflict = draft.expectedSourceHash !== source.hash || draft.expectedRevision !== revision;
  const persist = (next: Draft) => {
    draftVersion.current++;
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
          onSelect={(event) => {
            const { selectionStart: start, selectionEnd: end } = event.currentTarget;
            setSelection((previous) =>
              previous.start === start && previous.end === end
                ? previous
                : { start, end, version: previous.version + 1 }
            );
          }}
        />
      </label>
      {role === 'original' && (
        <SourceVersions
          sourceId={source.id}
          revision={draft.expectedRevision}
          draft={draft.text}
          disabled={saving || conflict}
          onApply={(text) => persist({ ...draft, text })}
        />
      )}
      {role === 'original' && (
        <SelectionRevision
          sourceId={source.id}
          chatId={source.chatId}
          text={draft.text}
          draftVersion={draftVersion.current}
          selection={selection}
          expectedRevision={draft.expectedRevision}
          expectedSourceHash={draft.expectedSourceHash}
          disabled={saving || conflict}
          onApply={(text, start, end) => {
            persist({ ...draft, text });
            requestAnimationFrame(() => {
              input.current?.focus({ preventScroll: true });
              input.current?.setSelectionRange(start, end);
            });
          }}
        />
      )}
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
      <div className="form-actions source-edit-actions">
        <IconButton
          icon={X}
          label="수정 취소"
          className="secondary"
          disabled={saving}
          onClick={cancel}
        />
        <IconButton
          icon={Save}
          className="source-edit-save"
          label={saving ? '저장 중…' : `${title} 저장`}
          type="submit"
          disabled={saving || conflict || !draft.text.trim()}
        />
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
  const perform = async (operation: 'retry' | 'cancel' | 'rejudge') => {
    setPending(true);
    setError('');
    onError('');
    try {
      await api(`/jobs/${job.id}/${operation}`, {});
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
      {canRejudgeTranslation(job) && (
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={() => void perform('rejudge')}
        >
          번역 판정만 다시 시도
        </button>
      )}
      {job.kind !== 'status' && retryable(job.status) && (
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
      {job.kind !== 'status' && activeJob(job) && (
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
      {job.rejection && <ProviderRejectionNotice rejection={job.rejection} />}
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
