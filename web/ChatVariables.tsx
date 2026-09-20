import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatVariableState } from '../core/chat-variables.js';
import { api, ApiError } from './api.js';
import { ResetIcon } from './ui-icons.js';
import './chat-variables.css';

type VariableView = ChatVariableState & {
  defaults: Record<string, string>;
  resolved: Record<string, string>;
  sourceHash: string | null;
  pending: boolean;
  variableDefaultsError?: string;
};
type SaveBody = {
  branchId?: string;
  expectedRevision: number;
  expectedSourceHash: string | null;
  idempotencyKey: string;
  values: Record<string, string>;
};
type Draft = {
  text: string;
  revision: number;
  sourceHash: string | null;
  pending?: SaveBody;
};
type Props = {
  chatId: string;
  branchId?: string;
  refreshKey?: unknown;
  onChange?: () => void;
};

const encodeValues = (values: Record<string, string>) => JSON.stringify(values, null, 2);
const definitelyRejected = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;

function stringMap(value: unknown): Record<string, string> | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}
function parseValues(text: string): Record<string, string> | null {
  try {
    return stringMap(JSON.parse(text));
  } catch {
    return null;
  }
}
function readDraft(key: string): Draft | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Partial<Draft> | null;
    if (
      !value ||
      typeof value.text !== 'string' ||
      !Number.isSafeInteger(value.revision) ||
      !(value.sourceHash === null || typeof value.sourceHash === 'string')
    )
      return null;
    const draft: Draft = {
      text: value.text,
      revision: value.revision as number,
      sourceHash: value.sourceHash,
    };
    const pending = value.pending;
    const pendingValues = pending && stringMap(pending.values);
    const draftValues = parseValues(value.text);
    if (
      pending &&
      typeof pending.idempotencyKey === 'string' &&
      Number.isSafeInteger(pending.expectedRevision) &&
      (pending.expectedSourceHash === null || typeof pending.expectedSourceHash === 'string') &&
      pendingValues &&
      draftValues &&
      JSON.stringify(pendingValues) === JSON.stringify(draftValues) &&
      (pending.branchId === undefined || typeof pending.branchId === 'string')
    )
      draft.pending = pending;
    return draft;
  } catch {
    return null;
  }
}
function rememberDraft(key: string, value: Draft | null) {
  if (typeof sessionStorage === 'undefined') throw new Error('SESSION_STORAGE_UNAVAILABLE');
  if (value) sessionStorage.setItem(key, JSON.stringify(value));
  else sessionStorage.removeItem(key);
}

/** Current-branch overrides are an explicit user edit. Background refreshes only update the
 * comparison base; they never adopt, discard, or replay the draft. */
export function ChatVariables({ chatId, branchId, refreshKey, onChange }: Props) {
  const storageKey = `uimori:chat-variable-draft:${chatId}:${branchId ?? 'current'}`;
  const [view, setView] = useState<VariableView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(() => readDraft(storageKey));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [raw, setRaw] = useState(false);
  const [query, setQuery] = useState('');
  const [newKey, setNewKey] = useState('');
  const alive = useRef(true);
  const readEpoch = useRef(0);
  const saving = useRef(false);
  const endpoint = `/chats/${encodeURIComponent(chatId)}/variables`;
  const readEndpoint = endpoint + (branchId ? `?branchId=${encodeURIComponent(branchId)}` : '');
  const load = useCallback(async () => {
    const epoch = ++readEpoch.current;
    setLoading(true);
    try {
      const next = await api<VariableView>(readEndpoint);
      if (alive.current && readEpoch.current === epoch) {
        setView(next);
        setError('');
      }
    } catch (cause) {
      if (alive.current && readEpoch.current === epoch)
        setError(cause instanceof Error ? cause.message : '공유 변수를 읽지 못했어요.');
    } finally {
      if (alive.current && readEpoch.current === epoch) setLoading(false);
    }
  }, [readEndpoint]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readEpoch.current++;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Story refreshes reload server state without replacing a local draft.
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  function updateDraft(text: string) {
    if (!view) return;
    const next: Draft = {
      text,
      revision: draft?.revision ?? view.revision,
      sourceHash: draft ? draft.sourceHash : view.sourceHash,
      ...(draft?.pending && text === draft.text ? { pending: draft.pending } : {}),
    };
    setDraft(next);
    try {
      rememberDraft(storageKey, next);
    } catch {
      setError('입력한 초안을 브라우저에 보관하지 못했어요. 이 화면을 닫지 말아 주세요.');
    }
    setNotice('');
  }

  async function save() {
    if (!view || !draft || saving.current) return;
    const parsed = parseValues(draft.text);
    if (!parsed) {
      setError('키와 문자열 값으로만 이루어진 JSON 객체를 입력해 주세요.');
      return;
    }
    const conflict = draft.revision !== view.revision || draft.sourceHash !== view.sourceHash;
    if (conflict && !draft.pending) return;
    const body: SaveBody =
      draft.pending ??
      ({
        ...(branchId ? { branchId } : {}),
        expectedRevision: draft.revision,
        expectedSourceHash: draft.sourceHash,
        idempotencyKey: crypto.randomUUID(),
        values: parsed,
      } satisfies SaveBody);
    saving.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const pendingDraft = { ...draft, pending: body };
    try {
      rememberDraft(storageKey, pendingDraft);
      setDraft(pendingDraft);
    } catch {
      setBusy(false);
      saving.current = false;
      setError('저장 요청을 보관하지 못했어요. 브라우저 저장 공간을 확인한 뒤 다시 시도해 주세요.');
      return;
    }
    try {
      const saved = await api<VariableView>(endpoint, body, 'PUT');
      if (!alive.current) return;
      readEpoch.current++;
      setView(saved);
      setDraft(null);
      try {
        rememberDraft(storageKey, null);
      } catch {
        /* The committed response is authoritative even when local cleanup is unavailable. */
      }
      setNotice('공유 변수를 저장했어요. 다음 생성부터 적용해요.');
      onChange?.();
    } catch (cause) {
      if (!alive.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : '저장 결과를 확인하지 못했어요. 다시 누르면 같은 요청을 확인해요.'
      );
      if (definitelyRejected(cause)) {
        const rejected: Draft = {
          text: pendingDraft.text,
          revision: pendingDraft.revision,
          sourceHash: pendingDraft.sourceHash,
        };
        setDraft(rejected);
        try {
          rememberDraft(storageKey, rejected);
        } catch {
          /* The in-memory draft remains available. */
        }
      }
      if (cause instanceof ApiError && cause.status === 409) await load();
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const parsed = draft ? parseValues(draft.text) : null;
  const conflict = Boolean(
    draft && view && (draft.revision !== view.revision || draft.sourceHash !== view.sourceHash)
  );
  const hasUncertainSave = Boolean(draft?.pending);
  const text = draft?.text ?? (view ? encodeValues(view.values) : '{}');
  const dirty = Boolean(draft && view && draft.text !== encodeValues(view.values));

  const overrides = draft ? parsed : (view?.values ?? {});
  const showJson = raw || Boolean(draft && !parsed);
  const locked = !view || loading || busy || Boolean(view?.pending) || hasUncertainSave;
  const keys = [
    ...new Set([...Object.keys(view?.defaults ?? {}), ...Object.keys(overrides ?? {})]),
  ];
  const visibleKeys = keys.filter((key) =>
    key.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  );
  const changeValue = (key: string, value: string) => {
    if (locked || !overrides) return;
    updateDraft(encodeValues({ ...overrides, [key]: value }));
  };
  const removeOverride = (key: string) => {
    if (locked || !overrides) return;
    updateDraft(
      encodeValues(Object.fromEntries(Object.entries(overrides).filter(([name]) => name !== key)))
    );
  };

  return (
    <section className="chat-variables" aria-label="카드 변수 편집">
      <header className="chat-variable-heading">
        <strong>현재 분기</strong>
        {view && (
          <small>
            재정의 {Object.keys(view.values).length}개 · 개정 {view.revision}
          </small>
        )}
      </header>
      <p className="muted">
        카드와 스크립트가 이 분기에서 함께 읽는 문자열 값이에요. 서재 원본은 바꾸지 않아요. 빈
        문자열도 값으로 저장하며, 키를 지우면 자료의 기본값을 다시 사용해요.
      </p>
      {loading && <p role="status">공유 변수를 읽고 있어요…</p>}
      {view?.pending && (
        <p role="status">
          원문 생성이나 자료 코드 작업이 현재 값을 사용하고 있어요. 새 편집과 저장은 완료 뒤 할 수
          있으며 입력한 초안은 유지돼요.
        </p>
      )}
      {view?.variableDefaultsError && (
        <p role="alert" className="error">
          자료 기본 변수를 적용하지 못했어요: {view.variableDefaultsError}
        </p>
      )}
      {conflict && !hasUncertainSave && (
        <div className="behavior-action-result" role="alert">
          <p>서버의 변수 개정이나 현재 원문이 바뀌었어요. 입력한 초안은 그대로 보존했어요.</p>
          <button
            type="button"
            className="secondary"
            disabled={!view || busy || view.pending}
            onClick={() => {
              if (!view || !draft) return;
              const next = { ...draft, revision: view.revision, sourceHash: view.sourceHash };
              setDraft(next);
              setError('');
              try {
                rememberDraft(storageKey, next);
              } catch {
                setError('입력한 초안을 브라우저에 보관하지 못했어요. 이 화면을 닫지 말아 주세요.');
              }
            }}
          >
            최신 상태 기준으로 초안 유지
          </button>
        </div>
      )}
      {hasUncertainSave && (
        <p role="status">
          이전 저장의 응답을 확인하지 못했어요. 값을 바꾸지 않고 다시 누르면 같은 저장 요청의 결과를
          확인해요.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <form
        className="chat-variable-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="chat-variable-toolbar">
          <label>
            변수 이름으로 찾기
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button
            type="button"
            className="ghost"
            disabled={Boolean(draft && !parsed)}
            onClick={() => setRaw(!showJson)}
          >
            {showJson ? '행 편집' : 'JSON 편집'}
          </button>
        </div>
        <div hidden={showJson}>
          <div className="chat-variable-rows">
            {visibleKeys.map((key) => {
              const overridden = Object.hasOwn(overrides ?? {}, key);
              return (
                <div className="chat-variable-row" key={key}>
                  <label>
                    <span className="chat-variable-identity">
                      <span className="chat-variable-key">{key}</span>
                      <span className="chat-variable-origin">
                        {overridden ? '이 분기' : '기본값'}
                      </span>
                    </span>
                    <input
                      aria-label={`${key} 문자열 값`}
                      value={overridden ? overrides![key] : (view?.defaults[key] ?? '')}
                      disabled={locked}
                      onChange={(event) => changeValue(key, event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost chat-variable-reset"
                    title={`${key} 재정의 해제`}
                    disabled={locked || !overridden}
                    aria-label={`${key} 재정의 해제`}
                    onClick={() => removeOverride(key)}
                  >
                    <ResetIcon size={18} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          {!visibleKeys.length && (
            <p className="muted">{query ? '일치하는 변수가 없어요.' : '현재 변수가 없어요.'}</p>
          )}
          <details className="chat-variable-add">
            <summary>변수 추가</summary>
            <div className="chat-variable-toolbar">
              <label>
                새 변수 이름
                <input
                  value={newKey}
                  disabled={locked}
                  onChange={(event) => setNewKey(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="secondary"
                disabled={locked || !newKey.trim() || keys.includes(newKey.trim())}
                onClick={() => {
                  changeValue(newKey.trim(), '');
                  setNewKey('');
                }}
              >
                빈 문자열로 추가
              </button>
            </div>
          </details>
        </div>
        <div hidden={!showJson}>
          <label>
            공유 변수 재정의 · JSON
            <textarea
              aria-label="공유 변수 재정의 · JSON"
              rows={6}
              spellCheck={false}
              value={text}
              disabled={!view || loading || busy || Boolean(view?.pending) || hasUncertainSave}
              onChange={(event) => {
                // A recovered invalid buffer also opens JSON. Keep that mode while it becomes valid.
                setRaw(true);
                updateDraft(event.target.value);
              }}
            />
          </label>
        </div>
        {draft && !parsed && (
          <small className="error">키와 문자열 값으로만 이루어진 JSON 객체여야 해요.</small>
        )}
        <div className="form-actions">
          <button
            type="submit"
            disabled={
              !view ||
              loading ||
              busy ||
              !parsed ||
              (!hasUncertainSave && (!dirty || conflict || view.pending))
            }
          >
            {hasUncertainSave ? '저장 결과 확인' : '공유 변수 저장'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!view || busy || hasUncertainSave}
            onClick={() => {
              if (!view) return;
              setDraft(null);
              try {
                rememberDraft(storageKey, null);
              } catch {
                /* The in-memory draft was explicitly reset. */
              }
              setError('');
              setNotice('서버에 저장된 값으로 되돌렸어요.');
            }}
          >
            서버 값으로 되돌리기
          </button>
          <button
            type="button"
            className="ghost"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            새로고침
          </button>
        </div>
      </form>
      {view && (
        <div className="chat-variable-readbacks">
          <details>
            <summary>현재 적용값 {Object.keys(view.resolved).length}개</summary>
            <pre>{encodeValues(view.resolved)}</pre>
          </details>
          <details>
            <summary>자료 기본값 {Object.keys(view.defaults).length}개</summary>
            <pre>{encodeValues(view.defaults)}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
