import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Pencil, RefreshCw, X } from 'lucide-react';
import { IconButton } from './IconButton.js';
import './request-message.css';

export function RequestMessage({
  runId,
  request,
  disabled,
  onSubmit,
  onConfirm,
  onEditingChange,
  editHint = '수정한 요청으로 새 분기에서 생성해요.',
  maxLength = 4000,
}: {
  editHint?: string;
  maxLength?: number;
  runId: string;
  request: string;
  disabled?: boolean;
  onSubmit?: (text: string) => Promise<boolean>;
  onConfirm?: () => Promise<boolean>;
  onEditingChange?: (editing: boolean) => void;
}) {
  const key = `request-edit:${runId}`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(request);
  const [busy, setBusy] = useState(false);
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
  return (
    <div className="request-message-wrap">
      {editing ? (
        <form
          className="request-message request-message-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            if (lock.current || (!onConfirm && (disabled || !draft.trim() || !onSubmit))) return;
            lock.current = true;
            setBusy(true);
            try {
              if (await (onConfirm ? onConfirm() : onSubmit!(draft))) {
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
              <IconButton
                icon={onConfirm ? RefreshCw : ArrowUp}
                label={busy ? '요청 전송 중' : onConfirm ? '이전 요청 확인' : '수정한 요청 보내기'}
                type="submit"
                disabled={busy || (!onConfirm && (disabled || !draft.trim()))}
              />
            </div>
          </div>
        </form>
      ) : (
        <>
          <div className="request-message" data-testid="source-request">
            {request.length > 280 ? (
              <details>
                <summary>
                  <span className="request-preview">
                    {request.slice(0, 240)}… <span>전체 보기</span>
                  </span>
                  <span className="request-collapse">접기</span>
                </summary>
                <p>{request}</p>
              </details>
            ) : (
              <p>{request}</p>
            )}
          </div>
          {onSubmit && (
            <div className="request-message-actions">
              <IconButton
                ref={trigger}
                icon={Pencil}
                label="요청 편집"
                className="secondary"
                disabled={disabled && !onConfirm}
                onClick={() => {
                  try {
                    setDraft(sessionStorage.getItem(key) ?? request);
                  } catch {
                    setDraft(request);
                  }
                  setEditing(true);
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
