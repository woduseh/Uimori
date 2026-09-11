import { CheckIcon, CloseIcon } from './ui-icons.js';
import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import type { HelperArtifact } from '../core/helper.js';
import { api, ApiError } from './api.js';
import { IconButton } from './IconButton.js';

export type HelperArtifactView = Omit<HelperArtifact, 'snapshot'>;
type Draft = { revision: number; text: string; requestKey?: string };
function storedDraft(key: string): Draft | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Draft | null;
    return value &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0 &&
      typeof value.text === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

/** The message keeps its original exact reference; this card can inspect or create another revision. */
export function HelperArtifactCard({
  id,
  revision,
  onRevise,
  readOnly = false,
}: {
  id: string;
  revision: number;
  readOnly?: boolean;
  onRevise: (artifact: HelperArtifactView) => void;
}) {
  const storageKey = `uimori:helper-artifact-draft:${id}:${revision}`;
  const [artifact, setArtifact] = useState<HelperArtifactView>();
  const [draft, setDraft] = useState<Draft | null>(() => storedDraft(storageKey));
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true),
    locked = useRef(false);
  const conflict = Boolean(draft && artifact && draft.revision !== artifact.revision);
  useEffect(() => {
    alive.current = true;
    const restored = storedDraft(storageKey);
    void api<HelperArtifactView>(
      `/helper/artifacts/${encodeURIComponent(id)}?revision=${restored?.revision ?? revision}`
    )
      .then((value) => {
        if (alive.current) setArtifact(value);
      })
      .catch((cause) => {
        if (alive.current) setError(cause.message);
      });
    return () => {
      alive.current = false;
    };
  }, [id, revision, storageKey]);
  useEffect(() => {
    try {
      if (draft) localStorage.setItem(storageKey, JSON.stringify(draft));
      else localStorage.removeItem(storageKey);
    } catch {
      /* The open editor still retains its local draft. */
    }
  }, [draft, storageKey]);
  async function latest() {
    const value = await api<HelperArtifactView>(`/helper/artifacts/${encodeURIComponent(id)}`);
    if (alive.current) setArtifact(value);
    return value;
  }
  async function save() {
    if (readOnly || !draft || locked.current || conflict) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const requestKey = draft.requestKey ?? crypto.randomUUID();
      const pending = { ...draft, requestKey };
      try {
        localStorage.setItem(storageKey, JSON.stringify(pending));
      } catch {
        throw new Error(
          '편집 요청을 보관하지 못했어요. 브라우저 저장 공간을 확인한 뒤 다시 저장해 주세요.'
        );
      }
      setDraft(pending);
      const value = await api<HelperArtifactView>(
        `/helper/artifacts/${encodeURIComponent(id)}`,
        {
          expectedRevision: draft.revision,
          text: draft.text,
          requestKey,
        },
        'PATCH'
      );
      if (!alive.current) return;
      setArtifact(value);
      setDraft(null);
      setMessage('편집한 장면을 새 개정으로 저장했어요.');
      window.dispatchEvent(new Event('uimori-helper-updated'));
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : '장면을 저장하지 못했어요.');
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          await latest();
        } catch {
          /* Preserve both the current card and local draft. */
        }
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="helper-artifact" aria-label="독립 가정 장면">
      <header>
        <strong>가정 장면</strong>
        <small>
          개정 {artifact?.revision ?? revision} ·{' '}
          {artifact?.origin === 'edit' ? '직접 편집' : '생성한 장면'} · 본편과 별도
        </small>
      </header>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {artifact ? (
        <>
          <div className="helper-prose">{artifact.text}</div>
          {draft ? (
            <form
              className="helper-artifact-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              {conflict && (
                <div className="context-conflict" role="alert">
                  <p>다른 개정이 저장됐어요. 위의 최신 장면과 입력한 초안을 비교해 주세요.</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDraft({ text: draft.text, revision: artifact.revision });
                      setError('');
                    }}
                  >
                    최신 장면을 확인했어요 · 내 초안 유지
                  </button>
                </div>
              )}
              <label>
                가정 장면 직접 편집
                <textarea
                  rows={10}
                  maxLength={500000}
                  value={draft.text}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ revision: draft.revision, text: event.target.value })
                  }
                />
              </label>
              <div className="form-actions">
                <button disabled={readOnly || busy || conflict || !draft.text.trim()}>
                  <CheckIcon size={18} aria-hidden="true" />
                  장면 편집 저장{' '}
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
                  <CloseIcon size={18} aria-hidden="true" />
                  장면 편집 취소
                </button>
              </div>
            </form>
          ) : (
            <footer>
              <IconButton
                label="가정 장면 복사"
                icon={Copy}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(artifact.text)
                    .catch(() => setError('복사하지 못했어요. 본문을 선택해 복사해 주세요.'))
                }
              />
              <button
                type="button"
                className="secondary"
                disabled={readOnly}
                onClick={() => {
                  setDraft({ revision: artifact.revision, text: artifact.text });
                  setError('');
                  setMessage('');
                }}
              >
                직접 편집
              </button>
              <button
                type="button"
                className="secondary"
                disabled={readOnly}
                onClick={() => onRevise(artifact)}
              >
                이 장면 수정 요청
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void latest().catch((cause) => setError(cause.message))}
              >
                최신 개정 확인
              </button>
            </footer>
          )}
        </>
      ) : (
        <p>가정 장면을 불러오는 중…</p>
      )}
    </section>
  );
}
