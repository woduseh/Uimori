import { t, useI18n } from './i18n.js';
import type { RequestImage } from '../core/request-images.js';
import { StoredRequestImages } from './RequestImages.js';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { ArrowUp, Check, Copy, Eye, EyeOff, Pencil, RefreshCw, Save, X } from 'lucide-react';
import { IconButton } from './IconButton.js';
import { ActionMenu, SHEET_MEDIA } from './ActionMenu.js';
import './request-message.css';

export function RequestMessage({
  runId,
  request,
  originalRequest,
  images,
  displayText,
  disabled,
  onSubmit,
  onSave,
  requestEnabled = true,
  onToggleRequest,
  sceneEnabled = true,
  onToggleScene,
  onRewrite,
  rewriteDisabled = disabled,
  onConfirm,
  onEditingChange,
  editHint = t('reader.generateInANewChatWithTheEditedRequest'),
  saveHint,
  menuActions,
  maxLength = REQUEST_TEXT_MAX_CHARS,
  compactActions = 'always',
}: {
  editHint?: string;
  saveHint?: string;
  menuActions?: ReactNode;
  maxLength?: number;
  /** Narrow widths: keep the edit action standing ('always') or show it when the bubble is tapped ('tap'). */
  compactActions?: 'always' | 'tap';
  runId: string;
  request: string;
  /** Frozen input originally used to generate this response. */
  originalRequest?: string;
  images?: RequestImage[];
  displayText?: string;
  disabled?: boolean;
  onSubmit?: (text: string) => Promise<boolean>;
  onSave?: (text: string) => Promise<boolean>;
  requestEnabled?: boolean;
  onToggleRequest?: () => Promise<void>;
  sceneEnabled?: boolean;
  onToggleScene?: () => Promise<void>;
  onRewrite?: () => void;
  rewriteDisabled?: boolean;
  onConfirm?: () => Promise<boolean>;
  onEditingChange?: (editing: boolean) => void;
}) {
  useI18n();
  const key = `${onSave ? 'request-context-edit' : 'request-edit'}:${runId}`;
  const shownRequest = displayText ?? request;
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState(request);
  const [busy, setBusy] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const copyVersion = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different stored request invalidates clipboard completion and its feedback.
  useLayoutEffect(() => {
    copyVersion.current++;
    setCopyState('idle');
    return () => {
      copyVersion.current++;
    };
  }, [runId, request]);
  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = setTimeout(() => setCopyState('idle'), 1800);
    return () => clearTimeout(timer);
  }, [copyState]);
  const copyRequest = async () => {
    const version = ++copyVersion.current;
    setCopyState('copying');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(request);
      if (copyVersion.current === version) setCopyState('copied');
    } catch {
      if (copyVersion.current === version) setCopyState('failed');
    }
  };
  const lock = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const saveDraft = (value?: string) => {
    try {
      if (value === undefined) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch {
      /* Keep editing available when browser storage is restricted. */
    }
  };
  const editingCallback = useRef(onEditingChange);
  useLayoutEffect(() => {
    editingCallback.current = onEditingChange;
  });
  useLayoutEffect(() => {
    if (!editing) return;
    input.current?.focus({ preventScroll: true });
    input.current?.scrollIntoView({ block: 'nearest' });
    editingCallback.current?.(true);
    return () => editingCallback.current?.(false);
  }, [editing]);
  const close = () => {
    if (lock.current) return;
    if (!onConfirm) saveDraft();
    setEditing(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  };
  const openEditor = () => {
    try {
      setDraft(sessionStorage.getItem(key) ?? request);
    } catch {
      setDraft(request);
    }
    setEditing(true);
  };
  return (
    <div
      className={`request-message-wrap${compactActions === 'tap' ? ' request-actions-tap' : ''}${revealed ? ' request-actions-revealed' : ''}`}
    >
      {editing ? (
        <form
          className="request-message request-message-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              lock.current ||
              (!onConfirm &&
                (disabled || (!draft.trim() && !images?.length) || (!onSave && !onSubmit)))
            )
              return;
            lock.current = true;
            setBusy(true);
            try {
              if (await (onConfirm ? onConfirm() : onSave ? onSave(draft) : onSubmit!(draft))) {
                saveDraft();
                setEditing(false);
              }
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <StoredRequestImages images={images} />
          <textarea
            ref={input}
            aria-label={t('reader.editedRequestText')}
            rows={5}
            maxLength={maxLength}
            value={draft}
            disabled={busy || !!onConfirm}
            onChange={(event) => {
              setDraft(event.target.value);
              saveDraft(event.target.value);
            }}
          />
          <div className="request-edit-footer">
            <small>
              {onConfirm
                ? t('reader.checkWhetherThePreviousSubmissionWasAcceptedCheckUsing')
                : onSave
                  ? (saveHint ??
                    t('reader.appliesToFutureGenerationContextExistingScenesArePreserved'))
                  : editHint}
            </small>
            <div className="request-edit-buttons">
              <IconButton
                icon={X}
                label={
                  onConfirm ? t('reader.closeRequestEditor') : t('reader.cancelRequestEditing')
                }
                className="secondary"
                disabled={busy}
                onClick={close}
              />
              {onSave && onSubmit && !onConfirm && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || disabled || (!draft.trim() && !images?.length)}
                  onClick={async () => {
                    if (lock.current) return;
                    lock.current = true;
                    setBusy(true);
                    try {
                      if (await onSubmit(draft)) {
                        saveDraft();
                        setEditing(false);
                      }
                    } finally {
                      lock.current = false;
                      setBusy(false);
                    }
                  }}
                >
                  {t('reader.editAndRegenerate')}
                </button>
              )}
              <IconButton
                icon={onConfirm ? RefreshCw : onSave ? Save : ArrowUp}
                label={
                  busy
                    ? t('reader.processing')
                    : onConfirm
                      ? t('reader.checkPreviousRequest')
                      : onSave
                        ? t('reader.saveInput')
                        : t('reader.sendEditedRequest')
                }
                type="submit"
                disabled={busy || (!onConfirm && (disabled || (!draft.trim() && !images?.length)))}
              />
            </div>
          </div>
        </form>
      ) : (
        <>
          <div
            className={`request-message${!requestEnabled ? ' request-context-disabled' : ''}`}
            data-testid="source-request"
            onClick={() => {
              // Narrow widths keep earlier requests quiet; tapping the bubble shows its actions.
              if (compactActions === 'tap' && matchMedia(SHEET_MEDIA).matches)
                setRevealed((value) => !value);
            }}
          >
            <StoredRequestImages images={images} />
            {shownRequest.length > 280 ? (
              <details>
                <summary>
                  <span className="request-preview">
                    {shownRequest.slice(0, 240)}… <span>{t('reader.viewAll')}</span>
                  </span>
                  <span className="request-collapse">{t('reader.collapse')}</span>
                </summary>
                <p>{shownRequest}</p>
              </details>
            ) : (
              <p>{shownRequest}</p>
            )}
          </div>
          {originalRequest !== undefined && originalRequest !== request && (
            <details className="request-transform-details">
              <summary>{t('reader.viewInputBeforeEditing')}</summary>
              <dl>
                <div>
                  <dt>{t('reader.inputWhenThisSceneWasGenerated')}</dt>
                  <dd>{originalRequest}</dd>
                </div>
              </dl>
            </details>
          )}
          {shownRequest !== request && (
            <details className="request-transform-details">
              <summary>{t('reader.displayTransformedViewOriginalRequest')}</summary>
              <dl>
                <div>
                  <dt>{t('reader.originalRequestEditingSource')}</dt>
                  <dd>{request}</dd>
                </div>
              </dl>
            </details>
          )}
          <div className="request-message-actions">
            <IconButton
              icon={copyState === 'copied' ? Check : Copy}
              label={copyState === 'copied' ? t('reader.requestCopied') : t('reader.copyRequest')}
              className="secondary"
              disabled={copyState === 'copying'}
              onClick={() => void copyRequest()}
            />
            <span className="sr-only" role="status">
              {copyState === 'copied' ? t('reader.requestCopied2') : ''}
            </span>
            {onRewrite && (
              <IconButton
                icon={RefreshCw}
                label={t('reader.rewrite')}
                size={18}
                className="secondary"
                disabled={rewriteDisabled}
                onClick={onRewrite}
              />
            )}
            {!onSave && !onToggleRequest && !onToggleScene && onSubmit && (
              <IconButton
                ref={trigger}
                icon={Pencil}
                label={t('reader.editRequest')}
                className="secondary"
                disabled={disabled && !onConfirm}
                onClick={openEditor}
              />
            )}
            {(onSave || onToggleRequest || onToggleScene) && (
              <ActionMenu label={t('reader.requestAndContextMenu')} placement="top" viewport>
                {(onSubmit || onSave) && (
                  <div className="action-menu-group">
                    <button
                      ref={trigger}
                      type="button"
                      className="secondary"
                      disabled={disabled && !onConfirm}
                      onClick={(event) => {
                        const menu = event.currentTarget.closest('details');
                        if (menu) menu.open = false;
                        openEditor();
                      }}
                    >
                      <Pencil size={18} aria-hidden="true" />
                      {onSave ? t('reader.editContextRequest') : t('reader.editRequest')}
                    </button>
                  </div>
                )}
                {menuActions}
                {(onToggleRequest || onToggleScene) && (
                  <div className="action-menu-group">
                    {onToggleRequest && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={disabled}
                        onClick={() => void onToggleRequest()}
                      >
                        {requestEnabled ? (
                          <EyeOff size={18} aria-hidden="true" />
                        ) : (
                          <Eye size={18} aria-hidden="true" />
                        )}
                        {requestEnabled
                          ? t('reader.excludeInputFromContext')
                          : t('reader.includeInputInContext')}
                      </button>
                    )}
                    {onToggleScene && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={disabled}
                        onClick={() => void onToggleScene()}
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
                  </div>
                )}
              </ActionMenu>
            )}
          </div>
          {copyState === 'failed' && (
            <p className="error request-copy-error" role="alert">
              {t('reader.couldNotCopyTheRequestCheckYourBrowsersClipboard')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
