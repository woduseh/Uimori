import type { RequestImage } from '../core/request-images.js';
import { StoredRequestImages } from './RequestImages.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  editHint = '수정한 요청으로 새 채팅에서 생성해요.',
  maxLength = REQUEST_TEXT_MAX_CHARS,
  compactActions = 'always',
}: {
  editHint?: string;
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
            aria-label="요청 수정 내용"
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
                ? '이전 전송의 수락 여부를 확인해 주세요. 같은 요청으로 확인해요.'
                : onSave
                  ? '이후 생성 문맥에 반영해요. 이미 생성된 장면은 유지돼요.'
                  : editHint}
            </small>
            <div className="request-edit-buttons">
              <IconButton
                icon={X}
                label={onConfirm ? '요청 편집 닫기' : '요청 수정 취소'}
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
                  수정 후 재생성
                </button>
              )}
              <IconButton
                icon={onConfirm ? RefreshCw : onSave ? Save : ArrowUp}
                label={
                  busy
                    ? '처리 중'
                    : onConfirm
                      ? '이전 요청 확인'
                      : onSave
                        ? '입력 저장'
                        : '수정한 요청 보내기'
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
                    {shownRequest.slice(0, 240)}… <span>전체 보기</span>
                  </span>
                  <span className="request-collapse">접기</span>
                </summary>
                <p>{shownRequest}</p>
              </details>
            ) : (
              <p>{shownRequest}</p>
            )}
          </div>
          {originalRequest !== undefined && originalRequest !== request && (
            <details className="request-transform-details">
              <summary>수정 전 입력 보기</summary>
              <dl>
                <div>
                  <dt>장면 생성 당시 입력</dt>
                  <dd>{originalRequest}</dd>
                </div>
              </dl>
            </details>
          )}
          {shownRequest !== request && (
            <details className="request-transform-details">
              <summary>표시 변환됨 · 원래 요청 보기</summary>
              <dl>
                <div>
                  <dt>원래 요청 · 편집 기준</dt>
                  <dd>{request}</dd>
                </div>
              </dl>
            </details>
          )}
          <div className="request-message-actions">
            <IconButton
              icon={copyState === 'copied' ? Check : Copy}
              label={copyState === 'copied' ? '요청 복사됨' : '요청 복사'}
              className="secondary"
              disabled={copyState === 'copying'}
              onClick={() => void copyRequest()}
            />
            <span className="sr-only" role="status">
              {copyState === 'copied' ? '요청을 복사했어요.' : ''}
            </span>
            {onRewrite && (
              <button
                type="button"
                className="secondary"
                disabled={rewriteDisabled}
                onClick={onRewrite}
              >
                <RefreshCw size={18} aria-hidden="true" />
                다시 쓰기
              </button>
            )}
            {!onSave && !onToggleRequest && !onToggleScene && onSubmit && (
              <IconButton
                ref={trigger}
                icon={Pencil}
                label="요청 편집"
                className="secondary"
                disabled={disabled && !onConfirm}
                onClick={openEditor}
              />
            )}
            {(onSave || onToggleRequest || onToggleScene) && (
              <ActionMenu label="요청과 문맥 메뉴" placement="top" viewport>
                {(onSubmit || onSave) && (
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
                    {onSave ? '문맥용 요청 수정' : '요청 편집'}
                  </button>
                )}
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
                    {requestEnabled ? '입력을 문맥에서 제외' : '입력을 문맥에 포함'}
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
                    {sceneEnabled ? '장면을 문맥에서 제외' : '장면을 문맥에 포함'}
                  </button>
                )}
              </ActionMenu>
            )}
          </div>
          {copyState === 'failed' && (
            <p className="error request-copy-error" role="alert">
              요청을 복사하지 못했어요. 브라우저의 클립보드 권한을 확인해 주세요.
            </p>
          )}
        </>
      )}
    </div>
  );
}
