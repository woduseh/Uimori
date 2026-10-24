import {
  t,
  useI18n,
  translateMessage,
  formatNumber,
  message as uiMessage,
  messageRef,
} from './i18n.js';
import type { RequestImage } from '../core/request-images.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { imageOwnerDisplayText } from '../core/image-placement.js';
import { compileReadingMarkdown, projectReadingText } from '../core/reading-markdown.js';
import { themeBodyScroll, readerLocation } from './theme-body-scroll.js';
import { BookmarkButton } from './Bookmarks.js';
import { captureReaderLocation } from './useReadingSync.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { ThemeFrame } from './ThemeFrame.js';
import { canRejudgeTranslation } from '../core/translation-recovery.js';
import { displayTranslationJob } from '../core/translation-display.js';
import { resolveInlineImage, IMAGE_POSITION_UNAVAILABLE } from './image-placement.js';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Asset } from '../core/product.js';
import type { Illustration } from '../core/illustration.js';
import type { ChatDetail, ImageTarget, Job, ReaderRun, Source } from '../core/types.js';
import { useIllustrationLayout } from './IllustrationStrip.js';
import { illustrationActive } from './illustration-labels.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { formatUsd } from './pricing-display.js';
import { api, ApiError, labels } from './api.js';
import { auxiliaryErrorDiagnostic } from './auxiliary-error.js';
import { ProviderRejectionNotice } from './provider-rejection.js';
import { Prose } from './Prose.js';
import { selectedReaderText } from './reader-dom.js';
import { RisuMessageSurface } from './RisuMessageSurface.js';
import { retainReaderNavigation } from './reader-navigation-scroll.js';
import { RisuInteractionDialog } from './RisuInteractionDialog.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { LoadingState } from './LoadingState.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { CopyIcon, EditIcon, IllustrationIcon, ImagesIcon, RefreshIcon } from './ui-icons.js';
import {
  Check,
  Eye,
  EyeOff,
  GitFork,
  Info,
  Languages,
  ListRestart,
  MessageCircleQuestion,
  ReceiptText,
  Save,
  X,
} from 'lucide-react';
import { Dialog } from './Dialog.js';
import { PackageStartPicker, type PackageStartSelection } from './PackageStartPicker.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { CodexContentWarningDialog } from './CodexContentWarningDialog.js';
import { useCodexContentWarning } from './useCodexContentWarning.js';
import { activityViewedEvent } from './useActivityFeed.js';

import { PackagePresentationIssues, usePackagePresentation } from './PackagePresentation.js';
import './source-edit.css';
import { SourceVersions } from './SourceVersions.js';
import { RequestMessage } from './RequestMessage.js';
import { StoredRequestImages } from './RequestImages.js';
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
  imageOwner?: boolean;
  refresh: () => Promise<void>;
  onError: (error: string) => void;
  onNativeNotice?: (messages: string[]) => void;
  onFork: (sourceId: string) => Promise<void>;
  onRetry?: (mode?: 'replace' | 'copy', text?: string) => Promise<boolean>;
  retryCanReplace?: boolean;
  onModelSettings?: () => void;
  retryDisabled?: boolean;
  onEditingChange?: (sourceId: string, editing: boolean) => void;
  request?: string;
  requestImages?: RequestImage[];
  /** The newest scene keeps frequent reading and request actions directly available. */
  latest?: boolean;
  onCheckRequest?: () => Promise<boolean>;
  onAskHelper?: (sourceId: string, text: string) => void;
  contextSummary?: ReaderRun['contextSummary'];
  estimatedCost?: ReaderRun['estimatedCost'];
  packageStart?: { mode: 'authored'; title: string };
  startSelection?: PackageStartSelection;
  onStartChanged?: () => void;
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
    ? t('reader.koreanTranslation')
    : job.kind === 'status'
      ? t('reader.previousAuxiliaryTask')
      : t('reader.valueImagePlacement', {
          v0:
            job.imageTarget?.mode === 'translation'
              ? t('reader.translation')
              : t('reader.original'),
        });
const translationPlaceholderMessages: Partial<Record<Job['status'], string>> = {
  failed: 'reader.couldNotCompleteTheKoreanTranslationTheOriginalIs',
  cancelled: 'reader.koreanTranslationCancelledTheOriginalIsPreserved',
  interrupted: 'reader.koreanTranslationInterruptedTheOriginalIsPreserved',
  partial: 'reader.koreanTranslationIsPartialTheOriginalIsPreserved',
};

export function SourceReader(props: ReaderProps) {
  useI18n();
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
  imageOwner = false,
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
  requestImages,
  latest,
  onCheckRequest,
  onAskHelper,
  contextSummary,
  estimatedCost,
  packageStart,
  startSelection,
  onStartChanged,
  activity,
  hasPackages,
  presentationRefreshKey,
  nativeInteractionRevision,
}: ReaderProps) {
  useI18n();
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
  useEffect(() => {
    // Re-entering a visible scene with a new deep link must emit a fresh inspection;
    // defer until the requested original/translation representation is rendered.
    if (readerTarget?.sourceId === source.id && readerTarget.representation !== mode) return;
    const node = container.current;
    if (!node || !('IntersectionObserver' in window)) return;
    let sent = false;
    const observer = new IntersectionObserver((entries) => {
      if (sent || !entries.some((entry) => entry.isIntersecting)) return;
      sent = true;
      window.dispatchEvent(
        new CustomEvent(activityViewedEvent, {
          detail: { chatId: source.chatId, sourceId: source.id, representation: mode },
        })
      );
      observer.disconnect();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [source.chatId, source.id, mode, readerTarget]);
  const appliedTarget = useRef<ReaderTarget | undefined>(undefined);
  const targetTranslationAvailable = !!displayTranslation?.result;
  const translationPreviouslyAvailable = useRef(targetTranslationAvailable);
  useEffect(() => {
    const justCompleted = !translationPreviouslyAvailable.current && targetTranslationAvailable;
    translationPreviouslyAvailable.current = targetTranslationAvailable;
    if (!justCompleted || readerTarget?.sourceId === source.id) return;
    try {
      // Honor a manual choice made while translation was running.
      if (sessionStorage.getItem(`reader-mode:${source.id}`)) return;
      if (localStorage.getItem('uimori:reading-language') === 'original') return;
      setMode('translation');
    } catch {
      /* Reading remains available without browser storage. */
    }
  }, [readerTarget?.sourceId, source.id, targetTranslationAvailable]);
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
  const context = source.sceneContext;
  const sceneEnabled = context?.sceneEnabled !== false;
  const requestEnabled = context?.requestEnabled !== false;
  const effectiveRequest = context?.requestText ?? request ?? '';
  const saveSceneContext = async (change: {
    requestText?: string;
    requestEnabled?: boolean;
    sceneEnabled?: boolean;
  }): Promise<boolean> => {
    try {
      await api(
        `/sources/${source.id}/scene-context`,
        { expectedRevision: context?.revision ?? 0, ...change },
        'PATCH'
      );
      await refresh();
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : uiMessage('reader.couldNotUpdateTheRecord'));
      return false;
    }
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
  const translationLoading = pending === 'translation' || !!(translation && activeJob(translation));
  const validTranslation =
    displayTranslation?.result?.sourceRevision === source.id &&
    displayTranslation.result.sourceHash === source.hash
      ? displayTranslation.result
      : null;
  const blocks = useMemo(
    () =>
      source.blocks?.length
        ? source.blocks
        : [{ anchor: 'full', index: 0, text: source.text, start: 0, end: source.text.length }],
    [source.blocks, source.text]
  );
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
    imageOwner &&
    image?.status === 'completed' &&
    image.result?.sourceRevision === source.id &&
    image.result.sourceHash === source.hash &&
    matchesImageTarget(image.result.imageTarget)
      ? (image.result.annotations ?? [])
      : [];
  const translationText = validTranslation?.text ?? '';
  const displayText = (text: string) =>
    imageOwnerDisplayText(text, { image: imageOwner, chatId: source.chatId }, assets);
  const allowedImageUrls = useMemo(
    () =>
      imageOwner
        ? []
        : assets
            .filter((asset) => asset.chatId === source.chatId && asset.allowedUse !== 'profile')
            .map((asset) => asset.url),
    [assets, imageOwner, source.chatId]
  );
  const translationBlocks = useMemo(
    () => displayTranslation?.translationLayout?.blocks ?? [],
    [displayTranslation?.translationLayout?.blocks]
  );
  const nativeDisplay =
    projected?.format === 'risu-html' &&
    (mode === 'original' || (!!validTranslation && projected.translation?.html !== undefined));
  const plainBlockDisplay =
    !nativeDisplay &&
    !(mode === 'original' ? projected?.original.changed : projected?.translation?.changed);
  const plainProjection = useMemo(
    () =>
      !plainBlockDisplay
        ? { text: '', blocks: [] }
        : projectReadingText(
            mode === 'original' ? source.text : translationText,
            mode === 'original' ? blocks : translationBlocks,
            (text) =>
              imageOwnerDisplayText(text, { image: imageOwner, chatId: source.chatId }, assets)
          ),
    [
      plainBlockDisplay,
      mode,
      source.text,
      source.chatId,
      translationText,
      blocks,
      translationBlocks,
      imageOwner,
      assets,
    ]
  );
  const plainDocument = useMemo(
    () =>
      !plainBlockDisplay
        ? { html: '', inlineAnchors: [] }
        : compileReadingMarkdown(plainProjection.text, plainProjection.blocks, allowedImageUrls),
    [plainBlockDisplay, plainProjection, allowedImageUrls]
  );
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
      nativeDisplay ||
      !(mode === 'original' ? projected?.original.changed : projected?.translation?.changed),
    inlineAnchors: nativeDisplay
      ? nativeAnchors.html === displayedNative?.html
        ? nativeAnchors.anchors
        : []
      : plainDocument.inlineAnchors,
    defaultCollapsed: illustrationsCollapsed,
    refresh,
    onError: setActionError,
  });
  const [illustrationDialog, setIllustrationDialog] = useState(false);
  const [retryDialog, setRetryDialog] = useState(false);
  const [rewriteText, setRewriteText] = useState('');
  const rewriteInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (retryDialog) rewriteInput.current?.focus({ preventScroll: true });
  }, [retryDialog]);
  const rewriteKey = `request-edit:${source.runId}`;
  const openRewrite = () => {
    try {
      setRewriteText(sessionStorage.getItem(rewriteKey) ?? effectiveRequest);
    } catch {
      setRewriteText(effectiveRequest);
    }
    setRetryDialog(true);
  };
  const rewrite = (mode: 'replace' | 'copy') =>
    void action('retry', async () => {
      const accepted = onCheckRequest ? await onCheckRequest() : await onRetry?.(mode, rewriteText);
      if (accepted === false || !mounted.current) return;
      try {
        sessionStorage.removeItem(rewriteKey);
      } catch {
        /* The accepted request remains authoritative when browser storage is unavailable. */
      }
      setRetryDialog(false);
    });
  const [startPickerOpen, setStartPickerOpen] = useState(false);
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
      const message =
        error instanceof Error ? error.message : uiMessage('reader.couldNotCompleteTheRequest');
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
  const translationActionLabel =
    validTranslation || (translation && activeJob(translation))
      ? t('reader.viewTranslation')
      : translation
        ? t('reader.retryTranslation')
        : t('reader.generateTranslation');
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
        ? t('reader.openingTitle', { title: packageStart.title })
        : t('reader.sceneValue', { v0: formatNumber(sceneNumber ?? index + 1) })}
    </span>
  );
  const badges = (
    <>
      {!sceneEnabled && <span className="scene-badge">{t('reader.excludedFromContext')}</span>}
      {validTranslation?.manual && mode === 'translation' && (
        <span className="scene-badge">{t('reader.manuallyEditedTranslation')}</span>
      )}
    </>
  );
  // Past scenes stay quiet while reading, but pending work and recovery keep their
  // original controls visible beside the affected scene instead of inside a menu.
  const directRepresentation =
    latest ||
    pending === 'translation' ||
    (translation && (activeJob(translation) || retryable(translation.status)));
  const trailing = directRepresentation ? (
    <div
      className="segmented compact"
      role="group"
      aria-label={t('reader.originalAndTranslationView')}
    >
      <button
        type="button"
        aria-label={translationActionLabel}
        aria-pressed={mode === 'translation'}
        disabled={pending === 'translation'}
        onClick={viewTranslation}
      >
        {translationActionLabel}
      </button>
      {showToggle && (
        <button
          type="button"
          aria-label={t('reader.viewOriginal')}
          aria-pressed={mode === 'original'}
          onClick={() => switchMode('original')}
        >
          {t('reader.original')}
        </button>
      )}
    </div>
  ) : (
    <span className="scene-badge" data-testid="scene-representation">
      {mode === 'translation' ? t('reader.translation') : t('reader.original')}
    </span>
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
  const editorLabel = (role: ReaderMode) =>
    role === 'translation' ? t('reader.editTranslation') : t('reader.editOriginal');
  const copyCurrent = () =>
    void action('copy', async () => {
      const text = mode === 'translation' ? (validTranslation?.text ?? '') : source.text;
      if (!navigator.clipboard)
        throw new Error(uiMessage('reader.copyingIsUnavailableInThisBrowser'));
      await navigator.clipboard.writeText(text);
    });
  return (
    <article
      ref={container}
      className={`source${!sceneEnabled ? ' scene-context-muted' : ''}`}
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
          {packageStart?.mode !== 'authored' && (request || requestImages?.length) && (
            <RequestMessage
              runId={source.runId}
              request={effectiveRequest}
              originalRequest={request}
              images={requestImages}
              displayText={
                context?.requestText == null ? presentation?.data?.request?.text : undefined
              }
              requestEnabled={requestEnabled}
              onSave={(value) => saveSceneContext({ requestText: value })}
              onToggleRequest={async () => {
                await saveSceneContext({ requestEnabled: !requestEnabled });
              }}
              sceneEnabled={sceneEnabled}
              onToggleScene={async () => {
                await saveSceneContext({ sceneEnabled: !sceneEnabled });
              }}
              compactActions={latest ? 'always' : 'tap'}
              onRewrite={onRetry || onCheckRequest ? openRewrite : undefined}
              rewriteDisabled={retryDisabled && !onCheckRequest}
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
          {!sceneEnabled && (
            <p className="scene-context-notice" role="status">
              {t('reader.thisScenesRequestAndTextAreExcludedFromFuture')}
            </p>
          )}
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
              <p role="status">
                {t('reader.showingThePreviousCompletedTranslationItWillBeReplaced')}
              </p>
            )}
            {hasPackages && !presentation ? (
              <LoadingState presentation="placeholder" label={t('reader.preparingTheBotView')} />
            ) : nativeDisplay ? (
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
                  revisionKey={`${source.id}:${source.hash}:${projected.nativeAction?.expectedHeadRevision ?? ''}:${projected.nativeAction?.expectedVariableRevision ?? ''}`}
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
                  <Prose
                    text={displayText(projected.original.text)}
                    allowedImageUrls={allowedImageUrls}
                  />
                </div>
                {annotations.length > 0 && (
                  <p className="muted" role="status">
                    {translateMessage(IMAGE_POSITION_UNAVAILABLE)}
                  </p>
                )}
              </div>
            ) : mode === 'translation' && validTranslation && projected?.translation?.changed ? (
              <div className="prose translated" data-testid="translation-text">
                <div className="source-block">
                  <Prose
                    text={displayText(projected.translation.text)}
                    allowedImageUrls={allowedImageUrls}
                  />
                </div>
                {annotations.length > 0 && (
                  <p className="muted" role="status">
                    {translateMessage(IMAGE_POSITION_UNAVAILABLE)}
                  </p>
                )}
              </div>
            ) : mode === 'original' ? (
              <div className="prose" data-testid="source-text">
                <Prose
                  text={plainProjection.text}
                  blocks={plainProjection.blocks}
                  compiled={plainDocument}
                  sourceId={source.id}
                  allowedImageUrls={allowedImageUrls}
                  afterBlock={(anchor) => (
                    <>
                      {inline(anchor)}
                      {illustrationLayout.inline(anchor)}
                    </>
                  )}
                />
                {blocks
                  .filter((block) => !plainDocument.inlineAnchors.includes(block.anchor))
                  .map((block) => (
                    <Fragment key={block.anchor}>{inline(block.anchor)}</Fragment>
                  ))}
              </div>
            ) : validTranslation ? (
              <div className="prose translated" data-testid="translation-text">
                <Prose
                  text={plainProjection.text}
                  blocks={plainProjection.blocks}
                  compiled={plainDocument}
                  allowedImageUrls={allowedImageUrls}
                  afterBlock={(anchor) => (
                    <>
                      {inline(anchor)}
                      {illustrationLayout.inline(anchor)}
                    </>
                  )}
                />
                {translationBlocks
                  .filter((block) => !plainDocument.inlineAnchors.includes(block.anchor))
                  .map((block) => (
                    <Fragment key={block.anchor}>{inline(block.anchor)}</Fragment>
                  ))}
              </div>
            ) : (
              <div
                className={`translation-placeholder${translationLoading ? ' is-loading' : ''}`}
                role={translationLoading ? undefined : 'status'}
              >
                {translationLoading ? (
                  <LoadingState
                    presentation="placeholder"
                    label={t('reader.preparingTheKoreanTranslationTheOriginalIsSaved')}
                  />
                ) : (
                  <p>
                    {translation
                      ? t(
                          translationPlaceholderMessages[translation.status] ??
                            'reader.theKoreanTranslationIsNotReadyYetTheOriginal'
                        )
                      : t('reader.thisSceneHasNoKoreanTranslationYet')}
                  </p>
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => switchMode('original')}
                  >
                    {t('reader.readTheOriginalFirst')}
                  </button>
                </div>
              </div>
            )}
            {illustrationLayout.footer}
          </div>
          {presentation?.error && (
            <p className="error" role="alert">
              {translateMessage(presentation.error)}
            </p>
          )}
          <PackagePresentationIssues data={presentation?.data} />
          {!activityNode && (
            <div className="derived-summary" aria-label={t('reader.followUpTasksForThisScene')}>
              {attentionJobs.length
                ? attentionJobs.map((job) => (
                    <div
                      className={retryable(job.status) ? 'job-summary has-error' : 'job-summary'}
                      key={job.id}
                      data-job-id={job.id}
                    >
                      <span className="ui-meta-row">
                        <span>{jobTitle(job)}</span>
                        <span>
                          {labels[job.status]}
                          {retryable(job.status) ? t('reader.originalPreserved') : ''}
                        </span>
                      </span>
                      {job.error && <AuxiliaryError error={job.error} />}
                      <JobActions job={job} refresh={refresh} onError={setActionError} compact />
                    </div>
                  ))
                : jobs.length > 0 && (
                    <p className="muted ui-meta-row">
                      {displayJobs.map((job) => (
                        <span key={job.id}>
                          {jobTitle(job)} {labels[job.status]}
                        </span>
                      ))}
                    </p>
                  )}
            </div>
          )}
        </div>
        <div slot="actions" data-uimori-part="actions" className="source-actions">
          {latest && (
            <>
              <IconButton
                label={t('reader.copyText')}
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
            </>
          )}
          <BookmarkButton
            title={
              sceneNumber
                ? t('reader.sceneValue', { v0: formatNumber(sceneNumber) })
                : t('reader.openingMessage2')
            }
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
          <ActionMenu label={t('reader.sceneActions')} placement="top" viewport>
            {!latest && (
              <>
                <button
                  type="button"
                  className="secondary"
                  disabled={!!editor || !!pending}
                  onClick={copyCurrent}
                >
                  <CopyIcon size={18} aria-hidden="true" />
                  {t('reader.copyText')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!!editor || !!pending}
                  onClick={(event) => openEditor(mode, event.currentTarget)}
                >
                  <EditIcon size={18} aria-hidden="true" />
                  {editorLabel(mode)}
                </button>
                {!directRepresentation && (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      aria-pressed={
                        validTranslation || (translation && activeJob(translation))
                          ? mode === 'translation'
                          : undefined
                      }
                      disabled={!!editor || !!pending}
                      onClick={(event) => {
                        if (!validTranslation && !(translation && activeJob(translation))) {
                          const menu = event.currentTarget.closest('details');
                          if (menu) {
                            menu.open = false;
                            menu.querySelector('summary')?.focus({ preventScroll: true });
                          }
                        }
                        viewTranslation();
                      }}
                    >
                      {mode === 'translation' ? (
                        <Check size={18} aria-hidden="true" />
                      ) : (
                        <Languages size={18} aria-hidden="true" />
                      )}
                      {translationActionLabel}
                    </button>
                    {showToggle && (
                      <button
                        type="button"
                        className="secondary"
                        aria-pressed={mode === 'original'}
                        disabled={!!editor || !!pending}
                        onClick={() => switchMode('original')}
                      >
                        {mode === 'original' ? (
                          <Check size={18} aria-hidden="true" />
                        ) : (
                          <Eye size={18} aria-hidden="true" />
                        )}
                        {t('reader.viewOriginal')}
                      </button>
                    )}
                  </>
                )}
              </>
            )}
            {startSelection && (
              <button
                type="button"
                className="secondary"
                disabled={!!editor || !!pending || retryDisabled}
                onClick={(event) => {
                  const menu = event.currentTarget.closest('details');
                  if (menu) {
                    menu.open = false;
                    menu.querySelector('summary')?.focus({ preventScroll: true });
                  }
                  setStartPickerOpen(true);
                }}
              >
                <ListRestart size={18} aria-hidden="true" />
                {t('reader.changeOpeningMessage')}
              </button>
            )}
            {(packageStart?.mode === 'authored' || (!request && !requestImages?.length)) && (
              <button
                type="button"
                className="secondary"
                disabled={!!editor || !!pending || retryDisabled}
                onClick={() =>
                  void action('scene-context', async () => {
                    await saveSceneContext({ sceneEnabled: !sceneEnabled });
                  })
                }
              >
                {sceneEnabled ? (
                  <EyeOff size={18} aria-hidden="true" />
                ) : (
                  <Eye size={18} aria-hidden="true" />
                )}
                {sceneEnabled
                  ? t('reader.excludeSceneFromContext')
                  : t('reader.includeSceneInContext')}
              </button>
            )}
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
                {t('reader.askTheHelper')}
              </button>
            )}
            {(onRetry || onCheckRequest) && (
              <button
                type="button"
                className="secondary"
                disabled={!!editor || !!pending || (retryDisabled && !onCheckRequest)}
                onClick={() => {
                  openRewrite();
                }}
              >
                <RefreshIcon size={18} aria-hidden="true" />
                {t('reader.rewrite')}
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
                {t('reader.newTranslationWithCurrentSettings')}
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
              {pending === 'fork'
                ? t('reader.copyingChat')
                : t('reader.copyThroughThisSceneToANewChat')}
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
            {imageOwner && (
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
                  ? t('reader.placingImages')
                  : image?.status === 'completed'
                    ? t('reader.placeImagesAgain')
                    : t('reader.placeImagesAutomatically')}
              </button>
            )}
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
                ? t('reader.choosingIllustrationPassages')
                : illustrations.some((item) => item.images.length > 0)
                  ? t('reader.generateNewIllustrations')
                  : t('reader.generateIllustrations')}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={(event) => openInfo(event.currentTarget, 'details')}
            >
              <Info size={18} aria-hidden="true" />
              {activityNode ? t('reader.originalLinkageDetails') : t('reader.taskDetails')}
            </button>
            {estimatedCost && estimatedCost.attemptCount > 0 && (
              <button
                type="button"
                className="secondary"
                onClick={(event) => openInfo(event.currentTarget, 'cost')}
              >
                <ReceiptText size={18} aria-hidden="true" />
                {t('reader.estimatedTextCost')}
              </button>
            )}
          </ActionMenu>
          {startSelection && (
            <PackageStartPicker
              open={startPickerOpen}
              onClose={() => setStartPickerOpen(false)}
              source={source}
              selection={startSelection}
              disabled={!!editor || !!pending || retryDisabled}
              refresh={refresh}
              onError={onError}
              onChanged={onStartChanged}
            />
          )}
          <Dialog
            open={retryDialog}
            onClose={() => {
              if (!pending) setRetryDialog(false);
            }}
            title={t('reader.rewrite')}
            className="source-retry-dialog"
          >
            <StoredRequestImages images={requestImages} />
            <label>
              {t('reader.requestToUseForGeneration')}
              <textarea
                ref={rewriteInput}
                aria-label={t('reader.requestToRewrite')}
                rows={6}
                maxLength={REQUEST_TEXT_MAX_CHARS}
                value={rewriteText}
                disabled={!!pending || !!onCheckRequest}
                onChange={(event) => {
                  setRewriteText(event.target.value);
                  try {
                    sessionStorage.setItem(rewriteKey, event.target.value);
                  } catch {
                    /* Keep the in-memory draft. */
                  }
                }}
              />
            </label>
            <p>{t('reader.sendThisTextWithTheCurrentSettingsThisIs')}</p>
            <p className="muted">
              {t('reader.replaceTheExistingResponseOnlyWhenGenerationSucceedsFailure')}
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={!!pending}
                onClick={() => setRetryDialog(false)}
              >
                {t('reader.close')}
              </button>
              {onCheckRequest ? (
                <button type="button" disabled={!!pending} onClick={() => rewrite('copy')}>
                  {t('reader.checkPreviousRequest')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      !!pending || retryDisabled || (!rewriteText.trim() && !requestImages?.length)
                    }
                    onClick={() => rewrite('copy')}
                  >
                    <GitFork size={18} aria-hidden="true" />
                    {t('reader.requestAgainInANewChat')}
                  </button>
                  <button
                    type="button"
                    disabled={
                      !!pending ||
                      retryDisabled ||
                      !retryCanReplace ||
                      (!rewriteText.trim() && !requestImages?.length)
                    }
                    onClick={() => rewrite('replace')}
                  >
                    <RefreshIcon size={18} aria-hidden="true" />
                    {t('reader.replaceExistingResponse')}
                  </button>
                </>
              )}
            </div>
            {actionError && (
              <p className="error" role="alert">
                {translateMessage(actionError)}
              </p>
            )}
          </Dialog>
          <Dialog
            open={illustrationDialog}
            onClose={() => {
              if (pending !== 'illustrate') setIllustrationDialog(false);
            }}
            title={t('reader.generateIllustrations')}
          >
            <p>{t('reader.chooseDifferentMomentsFromTheResponseTheMainImage')}</p>
            <label>
              {t('reader.maximumImages')}
              <select
                aria-label={t('reader.maximumImages')}
                value={illustrationCount}
                disabled={pending === 'illustrate'}
                onChange={(event) => {
                  setIllustrationCount(Number(event.target.value));
                  illustrationRequestKey.current = crypto.randomUUID();
                }}
              >
                {Array.from({ length: 8 }, (_, index) => (
                  <option key={index + 1} value={index + 1}>
                    {t('reader.imageCount', { count: index + 1 })}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">{t('reader.fewerImagesAreMadeIfFewerMomentsSuitIllustration')}</p>
            {actionError && (
              <p className="error" role="alert">
                {translateMessage(actionError)}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={pending === 'illustrate'}
                onClick={() => setIllustrationDialog(false)}
              >
                {t('reader.close')}
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
                {pending === 'illustrate' ? t('reader.reserving') : t('reader.createIllustrations')}
              </button>
            </div>
          </Dialog>
          <Dialog
            open={detailsOpen}
            onClose={() => setDetailsOpen(false)}
            title={activityNode ? t('reader.originalLinkageDetails') : t('reader.taskDetails')}
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
                    <dd>{source.parentRevision || t('reader.start')}</dd>
                    <dt>SHA-256</dt>
                    <dd>{source.hash}</dd>
                  </dl>
                  <details>
                    <summary>{t('reader.currentOriginal')}</summary>
                    <pre data-testid="source-raw">{source.text}</pre>
                  </details>
                  <p>{t('reader.displaysHeadingsEmphasisListsQuotesLinksAndCodeOnly')}</p>
                </div>
              </>
            )}
          </Dialog>
        </div>
        {estimatedCost && estimatedCost.attemptCount > 0 && (
          <Dialog
            open={costOpen}
            onClose={() => setCostOpen(false)}
            title={t('reader.estimatedTextCost')}
            className="source-info-dialog"
          >
            <p className="source-cost-value">
              {estimatedCost.usd !== null && estimatedCost.unknownCount === 0
                ? formatUsd(estimatedCost.usd)
                : t('reader.knownSubtotalValueIncludesValueUnpricedCalls', {
                    v0:
                      estimatedCost.subtotalUsd === 0 &&
                      estimatedCost.unknownCount === estimatedCost.attemptCount
                        ? t('reader.unknown')
                        : formatUsd(estimatedCost.subtotalUsd),
                    v1: estimatedCost.unknownCount,
                  })}
            </p>
            <p>{t('reader.calculatedFromProviderReportedTokensAndThePriceFixed')}</p>
            <p>{t('reader.coversTextAndWritingAssistanceCallsSeeTaskActivity')}</p>
            {estimatedCost.unknownCount > 0 && (
              <p>{t('reader.theSubtotalAddsOnlyKnownAmountsTheTotalEstimate')}</p>
            )}
          </Dialog>
        )}
        {actionError && (
          <p className="error source-action-error" role="alert">
            {translateMessage(actionError)}
            {onModelSettings && (
              <button type="button" className="secondary" onClick={onModelSettings}>
                {t('reader.globalModelSettings')}
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
  useI18n();
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
  const [conflictOpen, setConflictOpen] = useState(false);
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
  const title = role === 'original' ? t('reader.original') : t('reader.translation');
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
        if (event.target instanceof Element && event.target.closest('dialog')) return;
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229)
          return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy.current) return;
        if (conflict) {
          setConflictOpen(true);
          return;
        }
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
          if (cause instanceof ApiError && cause.status === 409) setConflictOpen(true);
          setError(
            cause instanceof Error
              ? cause.message
              : uiMessage('reader.couldNotSaveYourEditsArePreserved')
          );
        } finally {
          busy.current = false;
          setSaving(false);
        }
      }}
    >
      <label>
        {t('reader.editRole', { role })}
        <textarea
          ref={input}
          aria-label={t('reader.editValueText', { v0: title })}
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
          <p>{t('reader.theSavedTextChangedWhileYouWereEditingYour')}</p>
          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={() => setConflictOpen(true)}
          >
            {t('reader.reviewSaveConflict')}
          </button>
        </div>
      )}
      <div className="form-actions source-edit-actions">
        <IconButton
          icon={X}
          label={t('reader.cancelEditing')}
          className="secondary"
          disabled={saving}
          onClick={cancel}
        />
        <IconButton
          icon={Save}
          className="source-edit-save"
          label={saving ? t('reader.saving') : t('reader.saveValue', { v0: title })}
          type="submit"
          disabled={saving || !draft.text.trim()}
        />
      </div>
      <SaveConflictDialog
        open={conflictOpen}
        title={t('reader.valueSaveConflict', { v0: title })}
        onClose={() => setConflictOpen(false)}
        readSaved={async () => {
          const detail = await api<ChatDetail>(`/chats/${source.chatId}`);
          const current = detail.sources.find((item) => item.id === source.id);
          if (!current)
            throw new Error(uiMessage('reader.couldNotFindTheCurrentSceneYourEditsAre'));
          const currentTranslation = displayTranslationJob(
            current,
            latestTranslation(current, detail.jobs)
          );

          return () => {
            const text =
              role === 'original'
                ? current.text
                : (currentTranslation?.result?.text ?? t('reader.noSavedTranslation'));
            return {
              content: (
                <>
                  <p className="source-saved-review-text">{text}</p>
                  <p className="muted">{t('reader.copyYourEditsFirstCancelEditingReturnsToThe')}</p>
                </>
              ),
            };
          };
        }}
      />
      {error && (
        <p className="error" role="alert">
          {t('reader.errorEditsPreserved', { error: translateMessage(error) })}
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
  useI18n();
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
      const message =
        error instanceof Error ? error.message : uiMessage('reader.couldNotCompleteTheRequest');
      setError(message);
      onError(
        uiMessage('reader.jobFailure', {
          kind: job.kind,
          mode: job.imageTarget?.mode ?? 'original',
          error: messageRef(message),
        })
      );
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
          {t('reader.retryTranslationJudgmentOnly')}
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
            ? t('reader.retryTranslationWithCurrentSettings')
            : compact
              ? t('reader.retryValue', { v0: jobTitle(job) })
              : t('reader.retryThisTaskOnly')}
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
          {t('reader.cancelJob', { title: jobTitle(job) })}
        </button>
      )}
      {error && (
        <small className="error" role="alert">
          {translateMessage(error)}
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
  useI18n();
  const title = jobTitle(job);
  return (
    <section
      className="job"
      data-testid={`job-${job.kind}`}
      data-source-id={job.sourceRevision}
      data-job-id={job.id}
    >
      <h3>
        {t('reader.jobHeading', { mock: !!job.result?.mock, title })}{' '}
        <small>{labels[job.status]}</small>
      </h3>
      {!hideText && job.result && (job.kind !== 'translation' || job.status === 'completed') && (
        <p>
          {job.result.text ||
            job.result.label ||
            (job.kind === 'image'
              ? t('reader.valueImagesDisplayed', { v0: job.result.annotations?.length ?? 0 })
              : '')}
        </p>
      )}
      {job.error && <AuxiliaryError error={job.error} />}
      {job.rejection && <ProviderRejectionNotice rejection={job.rejection} />}
      <JobActions job={job} refresh={refresh} onError={onError} />
      <LazyDiagnostics<Job & { input?: unknown }>
        path={`/jobs/${job.id}`}
        revision={`${job.status}:${job.attempt}:${job.revision}`}
        title={t('reader.actualAuxiliaryTaskInputAndTools')}
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
  useI18n();
  const diagnostic = auxiliaryErrorDiagnostic(error);
  return (
    <div className="error" role="alert">
      <p>{t('reader.errorOriginalPreserved', { error: translateMessage(diagnostic.message) })}</p>
      <p>{translateMessage(diagnostic.action)}</p>
      {diagnostic.code && <small>{t('reader.diagnosticCode', { code: diagnostic.code })}</small>}
    </div>
  );
}
