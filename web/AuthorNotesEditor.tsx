import { useEffect, useRef, useState } from 'react';
import type { AuthorNote } from '../core/notes.js';
import { ApiError } from './api.js';

export type AuthorNoteCommand = {
  branchId: string;
  expectedHeadRevision: string | null;
  expectedRevision: number;
  idempotencyKey: string;
  author: string;
  text: string;
  replacesId?: string;
  retired?: true;
};
type NoteDraft = {
  originalId: string | null;
  revision: number;
  headRevision: string | null;
  text: string;
  author: string;
};

/** User-authored instructions remain separate from derived summaries and fictional events. */
export function AuthorNotesEditor({
  branchId,
  headRevision,
  notes,
  revision,
  onSave,
  onRefresh,
  onError,
  onDirtyChange,
  disabled = false,
}: {
  branchId: string;
  headRevision: string | null;
  notes: AuthorNote[];
  revision: number;
  onSave: (command: AuthorNoteCommand) => Promise<void>;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [retiring, setRetiring] = useState<NoteDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const locked = useRef(false);
  const commandKey = useRef({ fingerprint: '', key: crypto.randomUUID() });
  const editing = draft ?? retiring;
  const originalExists =
    !editing?.originalId || notes.some((note) => note.id === editing.originalId);
  const conflict = Boolean(
    editing &&
      (editing.revision !== revision || editing.headRevision !== headRevision || !originalExists)
  );
  useEffect(() => {
    onDirtyChange(draft !== null || retiring !== null || busy);
  }, [draft, retiring, busy, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
    };
  }, [onDirtyChange]);
  const fromNote = (note?: AuthorNote): NoteDraft => ({
    originalId: note?.id ?? null,
    revision,
    headRevision,
    text: note?.text ?? '',
    author: note?.declaration.author ?? '사용자',
  });
  function begin(note?: AuthorNote) {
    setDraft(fromNote(note));
    setRetiring(null);
    setError('');
    setMessage('');
  }
  async function refresh() {
    try {
      await onRefresh();
    } catch {
      if (!alive.current) return;
      const text = '메모 목록을 새로 불러오지 못했어요. 입력한 내용과 저장 결과는 유지했어요.';
      setError(text);
      onError(text);
    }
  }
  async function save(value: NoteDraft, retired = false) {
    if (locked.current || conflict || disabled) return;
    const command = {
      branchId,
      expectedRevision: value.revision,
      expectedHeadRevision: value.headRevision,
      text: retired ? '' : value.text,
      author: value.author,
      ...(value.originalId ? { replacesId: value.originalId } : {}),
      ...(retired ? { retired: true as const } : {}),
    };
    const fingerprint = JSON.stringify(command);
    if (commandKey.current.fingerprint !== fingerprint)
      commandKey.current = { fingerprint, key: crypto.randomUUID() };
    locked.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await onSave({ ...command, idempotencyKey: commandKey.current.key });
      if (!alive.current) return;
      setDraft(null);
      setRetiring(null);
      commandKey.current = { fingerprint: '', key: crypto.randomUUID() };
      setMessage(
        retired
          ? '이 분기의 이후 요청에서 이 메모를 사용하지 않아요.'
          : '메모를 저장했어요. 이후 요청부터 반영해요.'
      );
      await refresh();
    } catch (caught) {
      if (!alive.current) return;
      const text = caught instanceof Error ? caught.message : '메모를 저장하지 못했어요.';
      setError(text);
      onError(text);
      if (caught instanceof ApiError && caught.status === 409) await refresh();
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <details className="context-notes" data-testid="context-notes">
      <summary>사용자 메모·정정 {notes.length}개</summary>
      <p className="muted">
        이후 요청에서 지킬 설정이나 정정을 직접 남겨요. 원문과 요약은 별도로 보존해요.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {notes.length > 0 ? (
        <ul className="story-records">
          {notes.map((note) => (
            <li key={note.id}>
              <p>{note.text}</p>
              <small>
                작성자: {note.declaration.author} ·{' '}
                {note.atRevision ? '원문에 연결된 메모' : '첫 장면 전 메모'}
              </small>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  aria-label={`메모 수정: ${note.text.slice(0, 60)}`}
                  disabled={busy || disabled || editing !== null}
                  onClick={() => begin(note)}
                >
                  수정
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`메모 사용 중단: ${note.text.slice(0, 60)}`}
                  disabled={busy || disabled || editing !== null}
                  onClick={() => {
                    setRetiring(fromNote(note));
                    setError('');
                    setMessage('');
                  }}
                >
                  사용 중단
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">아직 직접 남긴 메모가 없어요.</p>
      )}
      {!editing && (
        <button type="button" className="secondary" disabled={disabled} onClick={() => begin()}>
          메모 추가
        </button>
      )}
      {conflict && (
        <div className="context-conflict" role="alert">
          <p>
            저장된 메모나 대상 장면이 바뀌었어요. 입력한 내용은 유지했어요. 위의 최신 메모를 확인해
            주세요.
          </p>
          {originalExists ? (
            <button
              type="button"
              className="secondary"
              disabled={busy || disabled}
              onClick={() => {
                const update = (current: NoteDraft | null) =>
                  current ? { ...current, revision, headRevision } : null;
                setDraft(update);
                setRetiring(update);
                setError('');
              }}
            >
              최신 내용을 확인했어요 · 내 초안 유지
            </button>
          ) : (
            draft && (
              <button
                type="button"
                className="secondary"
                disabled={busy || disabled}
                onClick={() => {
                  setDraft({ ...draft, originalId: null, revision, headRevision });
                  setError('');
                }}
              >
                내 초안을 새 메모로 남기기
              </button>
            )
          )}
        </div>
      )}
      {draft && (
        <form
          className="editor-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
        >
          <label>
            메모 작성자
            <input
              required
              maxLength={200}
              value={draft.author}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, author: event.target.value })}
            />
          </label>
          <label className="full">
            메모·정정 내용
            <textarea
              required
              maxLength={32000}
              value={draft.text}
              disabled={busy}
              rows={5}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
          </label>
          <div className="form-actions full">
            <button
              className="secondary"
              disabled={busy || disabled || conflict || !draft.text.trim() || !draft.author.trim()}
            >
              {draft.originalId ? '메모 수정 저장' : '새 메모 저장'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setError('');
              }}
            >
              편집 취소
            </button>
          </div>
        </form>
      )}
      {retiring && (
        <div role="group" aria-label="메모 사용 중단 확인">
          <p>이 분기의 이후 요청에서 이 메모를 제외해요. 이전 실행과 메모 이력은 보존해요.</p>
          <blockquote>{retiring.text}</blockquote>
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || disabled || conflict}
              onClick={() => void save(retiring, true)}
            >
              확인했어요 · 사용 중단
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setRetiring(null);
                setError('');
              }}
            >
              돌아가기
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
