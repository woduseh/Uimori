import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { BookmarkPlus } from 'lucide-react';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { diffText, TEXT_DIFF_LIMITS } from '../core/text-diff.js';
import { ApiError } from './api.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { CodexContentWarningDialog } from './CodexContentWarningDialog.js';
import { t, translateMessage, useI18n, message as legacyDescriptor } from './i18n.js';
import { uiMessage } from './ui-message.js';
import { IconButton } from './IconButton.js';
import { useFocusFallback } from './useFocusFallback.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { ProseHunk } from './TextDiffView.js';
import {
  placeBeside,
  placeDocked,
  sceneSelection,
  uniqueTextRange,
  visibleArea,
  type SceneSelection,
} from './reader-selection.js';
import { themeBodyScroll } from './theme-body-scroll.js';
import { TransientNotice } from './TransientNotice.js';
import { CheckIcon, CopyIcon, EditIcon, HelperIcon, RefreshIcon, StopIcon } from './ui-icons.js';
import { useSelectionRevision, type SelectionRevisionTarget } from './useSelectionRevision.js';
import './reader-selection.css';

export type ReaderRevisionTarget = {
  representation: 'original' | 'translation';
  text: string;
  request: Omit<SelectionRevisionTarget, 'draft' | 'start' | 'end'>;
  parts: { source: string; translation: string };
};

const TOUCH_SETTLE_MS = 250;
const BAR_PRESS_RELEASE_MS = 500;
const pointer = { down: false, type: '' };
let pointerTracked = false;
function trackPointer() {
  if (pointerTracked) return;
  pointerTracked = true;
  document.addEventListener(
    'pointerdown',
    (event) => {
      pointer.down = true;
      pointer.type = event.pointerType;
    },
    true
  );
  const release = () => {
    pointer.down = false;
  };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  document.addEventListener(
    'keydown',
    () => {
      pointer.type = 'keyboard';
    },
    true
  );
}

const sameSelection = (a: SceneSelection | null, b: SceneSelection | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.text === b.text &&
    a.range.startContainer === b.range.startContainer &&
    a.range.startOffset === b.range.startOffset &&
    a.range.endContainer === b.range.endContainer &&
    a.range.endOffset === b.range.endOffset);

const composing = (event: KeyboardEvent | ReactKeyboardEvent) =>
  ('nativeEvent' in event ? event.nativeEvent.isComposing : event.isComposing) ||
  event.keyCode === 229;

function restoreSelection(range: Range) {
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  try {
    selection.setBaseAndExtent(
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset
    );
    return true;
  } catch {
    return false;
  }
}

function focusScene(body: HTMLElement | null) {
  ((body && themeBodyScroll(body)) ?? body)?.focus({ preventScroll: true });
}

type Opened = { range: Range; parts: ReaderRevisionTarget['parts']; translation: boolean };

export function ReaderSelectionTools({
  body,
  chatId,
  sourceId,
  enabled,
  revision: target,
  onAskHelper,
  onBookmark,
  onApply,
}: {
  body: RefObject<HTMLElement | null>;
  chatId: string;
  sourceId: string;
  enabled: boolean;
  revision: ReaderRevisionTarget | null;
  onAskHelper?: (text: string) => void;
  onBookmark: () => void;
  onApply: (request: SelectionRevisionTarget, text: string) => Promise<void>;
}) {
  useI18n();
  const [selected, setSelected] = useState<SceneSelection | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [copied, setCopied] = useState(0);
  const [copyFailed, setCopyFailed] = useState(false);
  const identity = target
    ? `${target.representation}:${target.parts.source}:${target.parts.translation}`
    : null;
  const revision = useSelectionRevision({ chatId, sourceId, identity });
  const focusBar = useRef(false);
  const current = useRef<SceneSelection | null>(null);
  const [touch, setTouch] = useState(false);
  const barPress = useRef(false);
  useEffect(() => {
    if (!enabled) {
      current.current = null;
      setSelected(null);
      return;
    }
    trackPointer();
    let frame = 0;
    let settle = 0;
    const read = () => {
      if (barPress.current) return;
      const node = body.current;
      const next = node && !pointer.down ? sceneSelection(node) : null;
      if (sameSelection(current.current, next)) return;
      current.current = next;
      setTouch(pointer.type === 'touch');
      setSelected(next);
      setDismissed(false);
      setCopyFailed(false);
    };
    const evaluate = () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      if (pointer.type === 'touch') settle = window.setTimeout(read, TOUCH_SETTLE_MS);
      else frame = requestAnimationFrame(read);
    };
    document.addEventListener('selectionchange', evaluate);
    document.addEventListener('pointerup', evaluate);
    document.addEventListener('pointercancel', evaluate);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      document.removeEventListener('selectionchange', evaluate);
      document.removeEventListener('pointerup', evaluate);
      document.removeEventListener('pointercancel', evaluate);
    };
  }, [enabled, body]);
  const targetText = target?.text ?? null;
  const match = useMemo(
    () => (selected && targetText !== null ? uniqueTextRange(targetText, selected.text) : null),
    [selected, targetText]
  );
  const barVisible = !!selected && !dismissed && !opened && enabled;
  useEffect(() => {
    if (!barVisible || !selected || !body.current) return;
    const node = body.current;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = sceneSelection(node);
        if (sameSelection(current.current, next)) return;
        current.current = next;
        setSelected(next);
        setCopyFailed(false);
      });
    };
    const observer = new MutationObserver(check);
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    const root = selected.range.startContainer.getRootNode();
    if (root instanceof ShadowRoot)
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [barVisible, selected, body]);
  const bar = useRef<HTMLDivElement>(null);
  const [barPosition, setBarPosition] = useState<{ top: number; left: number } | null>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number } | null>(
    null
  );
  useLayoutEffect(() => {
    if (!barVisible && !opened) return;
    let frame = 0;
    const place = () => {
      const node = body.current;
      if (!node) return;
      const area = visibleArea(node);
      if (opened && popover.current) {
        const size = popover.current.getBoundingClientRect();
        const next = placeBeside(opened.range, area, size, 'below');
        setPopoverPosition((previous) => {
          const fallback = previous ?? {
            top: Math.max(8, innerHeight - size.height - 16),
            left: Math.max(8, (innerWidth - size.width) / 2),
          };
          const value = next ?? fallback;
          const clamped = {
            top: Math.round(Math.min(Math.max(value.top, 8), innerHeight - size.height - 8)),
            left: Math.round(Math.min(Math.max(value.left, 8), innerWidth - size.width - 8)),
          };
          return previous?.top === clamped.top && previous.left === clamped.left
            ? previous
            : clamped;
        });
      } else if (selected && bar.current) {
        const size = bar.current.getBoundingClientRect();
        const next = touch
          ? placeDocked(selected.range, area, size)
          : placeBeside(selected.range, area, size, 'above');
        setBarPosition((previous) =>
          previous?.top === next?.top && previous?.left === next?.left ? previous : next
        );
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    if (popover.current) observer.observe(popover.current);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [barVisible, opened, selected, body, touch]);
  useLayoutEffect(() => {
    if (!barVisible || !barPosition || !focusBar.current) return;
    focusBar.current = false;
    bar.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [barVisible, barPosition]);
  function closePopover(returnToBar: boolean) {
    const range = opened?.range;
    revision.close();
    setOpened(null);
    setPopoverPosition(null);
    if (returnToBar && range && restoreSelection(range)) focusBar.current = true;
  }
  const closeRef = useRef(closePopover);
  closeRef.current = closePopover;
  const applying = useRef(false);
  useEffect(() => {
    if (!barVisible && !opened) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || composing(event)) return;
      const active = document.activeElement;
      if (event.key === 'Escape') {
        if (active instanceof Element && active.closest('dialog[open]')) return;
        event.preventDefault();
        event.stopPropagation();
        if (opened) {
          if (!applying.current) closeRef.current(true);
          return;
        }
        const inBar = !!active && !!bar.current?.contains(active);
        setDismissed(true);
        if (inBar) focusScene(body.current);
        return;
      }
      if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        !opened &&
        barPosition &&
        !bar.current?.contains(active) &&
        (!active ||
          active === document.body ||
          (body.current?.contains(active) &&
            !active.matches('input, textarea, select, [contenteditable]')))
      ) {
        event.preventDefault();
        bar.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [barVisible, opened, barPosition, body]);
  useEffect(() => {
    if (!enabled && opened) closeRef.current(false);
  }, [enabled, opened]);
  function liveSelection() {
    const next = body.current ? sceneSelection(body.current) : null;
    if (sameSelection(selected, next)) return next;
    if (!next && selected && barPress.current && restoreSelection(selected.range)) return selected;
    current.current = next;
    setSelected(next);
    return null;
  }
  function openRevision() {
    if (!selected || !target || !match || !liveSelection()) return;
    revision.open({
      ...target.request,
      draft: target.text,
      start: match.start,
      end: match.end,
    });
    setOpened({
      range: selected.range.cloneRange(),
      parts: target.parts,
      translation: target.representation === 'translation',
    });
  }
  const toolbarKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length].focus();
  };
  return (
    <>
      {copied > 0 && <TransientNotice key={copied} content={uiMessage('helpers.m129')} />}
      {barVisible &&
        selected &&
        createPortal(
          <div
            ref={bar}
            role="toolbar"
            aria-label={t('readerSelection.toolbar')}
            className="reader-selection-bar"
            data-placed={barPosition ? 'true' : 'false'}
            inert={!barPosition}
            style={barPosition ?? undefined}
            onPointerDown={(event) => {
              event.preventDefault();
              barPress.current = event.pointerType === 'touch';
            }}
            onPointerUp={() => {
              window.setTimeout(() => {
                barPress.current = false;
              }, BAR_PRESS_RELEASE_MS);
            }}
            onPointerCancel={() => {
              barPress.current = false;
            }}
            onClick={() => {
              barPress.current = false;
            }}
            onMouseDown={(event) => event.preventDefault()}
            onKeyDown={toolbarKeys}
          >
            {match && (
              <button type="button" onClick={openRevision}>
                <EditIcon size={16} aria-hidden="true" />
                {t('readerSelection.refine')}
              </button>
            )}
            {onAskHelper && (
              <button
                type="button"
                onClick={() => {
                  const live = liveSelection();
                  if (!live) return;
                  onAskHelper(live.text.trim());
                  setDismissed(true);
                }}
              >
                <HelperIcon size={16} aria-hidden="true" />
                {t('reader.askTheHelper')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (!liveSelection()) return;
                onBookmark();
                setDismissed(true);
              }}
            >
              <BookmarkPlus size={16} aria-hidden="true" />
              {t('readerSelection.bookmark')}
            </button>
            <button
              type="button"
              onClick={() => {
                const live = liveSelection();
                if (!live) return;
                void (async () => {
                  try {
                    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
                    await navigator.clipboard.writeText(live.text);
                    setCopyFailed(false);
                    setCopied((n) => n + 1);
                    setDismissed(true);
                  } catch {
                    setCopyFailed(true);
                  }
                })();
              }}
            >
              <CopyIcon size={16} aria-hidden="true" />
              {t('readerSelection.copy')}
            </button>
            {copyFailed && (
              <span className="reader-selection-copy-error" role="alert">
                {t('readerSelection.copyFailed')}
              </span>
            )}
          </div>,
          document.body
        )}
      {opened &&
        revision.captured &&
        createPortal(
          <RevisionPopover
            ref={popover}
            position={popoverPosition}
            revision={revision}
            opened={opened}
            current={target}
            onClose={() => closePopover(true)}
            onApply={async (text) => {
              applying.current = true;
              try {
                await onApply(revision.captured!, text);
              } finally {
                applying.current = false;
              }
              closePopover(false);
              focusScene(body.current);
            }}
          />,
          document.body
        )}
    </>
  );
}

function RevisionPopover({
  ref,
  position,
  revision,
  opened,
  current,
  onClose,
  onApply,
}: {
  ref: RefObject<HTMLDivElement | null>;
  position: { top: number; left: number } | null;
  revision: ReturnType<typeof useSelectionRevision>;
  opened: Opened;
  current: ReaderRevisionTarget | null;
  onClose: () => void;
  onApply: (text: string) => Promise<void>;
}) {
  useI18n();
  const captured = revision.captured!;
  const { proposal, busy, stale } = revision;
  const [instruction, setInstruction] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [saveError, setSaveError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const diffRegion = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const placed = !!position;
  useLayoutEffect(() => {
    if (placed) field.current?.focus({ preventScroll: true });
  }, [placed]);
  const rememberFocus = useFocusFallback(
    () =>
      busy
        ? [cancelButton.current]
        : [applyButton.current, diffRegion.current, field.current, closeButton.current],
    `${busy}:${proposal !== null}:${saving}:${conflicted}`
  );
  const selectedText = captured.draft.slice(captured.start, captured.end);
  const diff = useMemo(
    () =>
      proposal === null
        ? null
        : diffText(selectedText, proposal, 'prose', {
            ...TEXT_DIFF_LIMITS,
            context: selectedText.length + proposal.length,
          }),
    [selectedText, proposal]
  );
  const staleNotice = stale
    ? !current || current.parts.source !== opened.parts.source
      ? t('readerSelection.sourceChanged')
      : t('readerSelection.translationChanged')
    : conflicted
      ? t('readerSelection.savedChanged')
      : '';
  async function apply() {
    if (proposal === null || saving || !revision.isCurrent()) return;
    setSaving(true);
    setSaveError('');
    setConflicted(false);
    try {
      await onApply(
        captured.draft.slice(0, captured.start) + proposal + captured.draft.slice(captured.end)
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setConflicted(true);
      else
        setSaveError(
          cause instanceof Error
            ? cause.message
            : legacyDescriptor('reader.couldNotSaveYourEditsArePreserved')
        );
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('readerSelection.refineTitle')}
      className="reader-revision-popover"
      data-keyboard-overlay
      data-placed={position ? 'true' : 'false'}
      style={position ?? undefined}
      onFocus={rememberFocus}
    >
      <label>
        {t('readerSelection.instruction')}
        <textarea
          ref={field}
          rows={2}
          maxLength={REQUEST_TEXT_MAX_CHARS}
          value={instruction}
          disabled={busy || saving}
          placeholder={t('reader.keepTheMeaningButReduceSentencesThatDirectlyExplain')}
          onChange={(event) => {
            setInstruction(event.target.value);
            revision.clearProposal();
            setConflicted(false);
          }}
        />
      </label>
      <label className="check">
        <SelectionCheckbox
          checked={revision.context === 'nearby'}
          disabled={busy || saving}
          onChange={(event) => revision.chooseContext(event.target.checked ? 'nearby' : 'scene')}
        />
        {t('readerSelection.nearbyContext')}
      </label>
      {proposal !== null && diff && (
        <div
          ref={diffRegion}
          className="reader-revision-diff"
          role="region"
          aria-label={t('readerSelection.diff')}
          tabIndex={0}
          data-testid="reader-revision-proposal"
        >
          {'hunks' in diff && diff.hunks.length ? (
            diff.hunks.map((hunk) => (
              <ProseHunk key={`${hunk.beforeOffset}:${hunk.afterOffset}`} hunk={hunk} />
            ))
          ) : (
            <p className="helper-diff-prose">{proposal}</p>
          )}
        </div>
      )}
      {proposal !== null && opened.translation && (
        <p className="reader-revision-note">{t('readerSelection.translationEffects')}</p>
      )}
      {staleNotice && <NoticeBanner>{staleNotice}</NoticeBanner>}
      {(revision.error || saveError) && (
        <NoticeBanner tone="error">{translateMessage(revision.error || saveError)}</NoticeBanner>
      )}
      {busy && (
        <LoadingState
          presentation="inline"
          label={uiMessage('reader.refiningTheSelectedPassage')}
        />
      )}
      <div className="reader-revision-actions">
        <button
          ref={closeButton}
          type="button"
          className="secondary"
          disabled={saving}
          onClick={onClose}
        >
          {t('readerSelection.close')}
        </button>
        {busy ? (
          <button ref={cancelButton} type="button" className="secondary" onClick={revision.cancel}>
            <StopIcon size={16} aria-hidden="true" />
            {t('reader.cancelRevisionRequest')}
          </button>
        ) : proposal !== null ? (
          <>
            <IconButton
              label={t('reader.getAnotherSuggestion')}
              icon={RefreshIcon}
              className="secondary"
              disabled={saving || stale || !instruction.trim()}
              onClick={() => void revision.requestProposal(instruction)}
            />
            <button
              ref={applyButton}
              type="button"
              className="primary"
              disabled={saving || stale || conflicted}
              aria-busy={saving}
              onClick={() => void apply()}
            >
              <CheckIcon size={16} aria-hidden="true" />
              {saving ? t('reader.saving') : t('readerSelection.apply')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={stale || !instruction.trim()}
            onClick={() => void revision.requestProposal(instruction)}
          >
            <EditIcon size={16} aria-hidden="true" />
            {t('reader.getSuggestion')}
          </button>
        )}
      </div>
      <CodexContentWarningDialog gate={revision.codexWarning} />
    </div>
  );
}
