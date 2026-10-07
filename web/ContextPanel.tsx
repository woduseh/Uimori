import { SOURCE_TEXT_MAX_CHARS as CONTEXT_SUMMARY_MAX_CHARS } from '../core/content-limits.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { CheckIcon, CloseIcon } from './ui-icons.js';
import { useEffect, useRef, useState } from 'react';
import type { ContextDetail, ContextJob as StoredContextJob } from '../core/context-plan.js';
import type { AuthorNote } from '../core/notes.js';
import { AuthorNotesEditor } from './AuthorNotesEditor.js';
import { api, ApiError } from './api.js';
import './context.css';

type ContextJob = Omit<StoredContextJob, 'snapshot'>;
type SummaryDraft = { text: string; revision: number; headRevision: string | null };
const id = encodeURIComponent;
const pending = (job: ContextJob) => job.status === 'queued' || job.status === 'running';
const origins = {
  automatic: '자동 압축',
  manual: '수동 압축',
  edit: '직접 편집',
  model: '모델 작성',
};

/** Mounted across scope refreshes so a new source or event never discards a local editor. */
export function ContextPanel({
  mode = 'full',
  chatId,
  headRevision,
  notes,
  notesRevision,
  active,
  refreshKey,
  onRefreshStory,
  onChanged,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
}: {
  mode?: 'full' | 'compact';
  chatId: string;
  headRevision: string | null;
  notes?: AuthorNote[];
  notesRevision?: number;
  active: boolean;
  refreshKey?: unknown;
  onRefreshStory: () => Promise<void>;
  onChanged: () => void;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
}) {
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [draft, setDraft] = useState<SummaryDraft | null>(null);
  const [notesDirty, setNotesDirty] = useState(false);
  const [priorities, setPriorities] = useState('');
  const notesSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerNotesSave = useRef((handler: (() => Promise<boolean>) | null) => {
    notesSave.current = handler;
  }).current;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const readSequence = useRef(0);
  const actionLock = useRef(false);
  const scope = useRef({ key: '', generation: 0 });
  const scopeKey = JSON.stringify([chatId, headRevision]);
  if (scope.current.key !== scopeKey)
    scope.current = { key: scopeKey, generation: scope.current.generation + 1 };
  const notesCache = useRef({ notes: notes ?? [], revision: notesRevision ?? 0 });
  if (notes !== undefined && notesRevision !== undefined)
    notesCache.current = { notes, revision: notesRevision };
  const commandKey = useRef({ fingerprint: '', key: crypto.randomUUID() });
  const base = `/chats/${id(chatId)}/context`;
  const current = detail?.headRevision === headRevision;
  const working = detail?.jobs.find(pending);
  const latest = [...(detail?.jobs ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  )[0];
  const summary = detail?.checkpoint?.plan.summary ?? '';
  const conflict = Boolean(
    draft &&
      detail &&
      (draft.revision !== detail.activeRevision || draft.headRevision !== headRevision)
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
    };
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChange(draft !== null || notesDirty || busy);
  }, [draft, notesDirty, busy, onDirtyChange]);
  function report(caught: unknown) {
    const text = caught instanceof Error ? caught.message : '컨텍스트를 불러오지 못했어요.';
    setError(text);
    onError(text);
  }
  async function load() {
    const generation = scope.current.generation;
    const sequence = ++readSequence.current;
    try {
      const result = await api<ContextDetail>(base);
      if (
        !alive.current ||
        generation !== scope.current.generation ||
        sequence !== readSequence.current
      )
        return;
      setDetail(result);
      if (result.notesRevision !== notesCache.current.revision) await onRefreshStory();
    } catch (caught) {
      if (
        alive.current &&
        generation === scope.current.generation &&
        sequence === readSequence.current
      )
        report(caught);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scope/event changes refresh server data without resetting editor state or depending on render-local callbacks.
  useEffect(() => {
    if (active) void load();
  }, [active, chatId, headRevision, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a running compact job needs periodic refresh; editing and hidden panels do not restart its timer.
  useEffect(() => {
    if (!active || !working) return;
    const timer = setInterval(() => {
      void load();
    }, 1000);
    return () => clearInterval(timer);
  }, [active, working?.id, chatId, headRevision]);
  function keyed(command: Record<string, unknown>) {
    const fingerprint = JSON.stringify(command);
    if (commandKey.current.fingerprint !== fingerprint)
      commandKey.current = { fingerprint, key: crypto.randomUUID() };
    return { ...command, idempotencyKey: commandKey.current.key };
  }
  async function write(
    path: string,
    body: unknown,
    method: 'POST' | 'PUT',
    success: string,
    clearDraft = false
  ) {
    if (actionLock.current) return false;
    actionLock.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const generation = scope.current.generation;
    try {
      await api(path, body, method);
      if (!alive.current) return false;
      commandKey.current = { fingerprint: '', key: crypto.randomUUID() };
      if (path === `${base}/compact`) setPriorities('');
      if (clearDraft) setDraft(null);
      setMessage(success);
      if (generation === scope.current.generation) await load();
      onChanged();
      return true;
    } catch (caught) {
      if (!alive.current) return false;
      report(caught);
      if (caught instanceof ApiError && caught.status === 409) await load();
      return false;
    } finally {
      actionLock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const command = () => ({
    expectedRevision: detail!.activeRevision,
    expectedHeadRevision: headRevision,
    ...(priorities.trim() ? { priorities } : {}),
  });
  async function refreshAll() {
    await Promise.all([load(), onRefreshStory()]);
  }
  async function saveSummary() {
    if (!draft) return true;
    if (
      busy ||
      conflict ||
      !current ||
      !draft.text.trim() ||
      draft.text.length > CONTEXT_SUMMARY_MAX_CHARS
    )
      return false;
    return write(
      `${base}/summary`,
      keyed({
        expectedRevision: draft.revision,
        expectedHeadRevision: draft.headRevision,
        summary: draft.text,
      }),
      'PUT',
      '요약을 저장했어요. 이후 요청부터 반영해요.',
      true
    );
  }
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (busy || actionLock.current) return false;
    if (notesDirty && !(await notesSave.current?.())) return false;
    return saveSummary();
  });
  return (
    <section className="context-panel" aria-label="컨텍스트 관리" data-testid="context-panel">
      <div className="context-heading">
        <h4>컨텍스트 요약</h4>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setError('');
            void refreshAll();
          }}
        >
          새로 확인
        </button>
      </div>
      <div className="context-content">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {!detail ? (
          <p className="muted">컨텍스트를 불러오고 있어요.</p>
        ) : (
          <>
            {summary ? (
              <div className="context-summary">
                {!detail.usable && (
                  <p role="status">
                    이전 요약을 보존하고 있어요.{' '}
                    {detail.invalidReason ?? '현재 요청에는 원문을 사용해요.'}
                  </p>
                )}
                <small>
                  {origins[detail.checkpoint!.origin]} · 요약한 장면{' '}
                  {detail.checkpoint!.plan.compacted.length}개
                </small>
                <p className="context-text" data-testid="context-summary-text">
                  {summary}
                </p>
              </div>
            ) : (
              <p className="muted">아직 저장된 요약이 없어요. 원문을 그대로 사용해요.</p>
            )}
            {!current && (
              <p role="status">
                대상 장면의 최신 컨텍스트를 확인하고 있어요. 작성 중인 초안은 유지해요.
              </p>
            )}
            <details className="context-priorities">
              <summary>이번 압축에서 우선할 내용 · 선택</summary>
              <label>
                압축 우선순위
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={priorities}
                  disabled={busy || Boolean(working)}
                  placeholder="예: 인물별로 알고 있는 사실과 아직 풀리지 않은 약속을 자세히 남겨 주세요."
                  onChange={(event) => setPriorities(event.target.value)}
                />
              </label>
              <small className="muted">
                이번 압축에만 사용해요. 새 설정이나 사건을 추가하는 메모는 아니에요.
              </small>
            </details>
            <p className="muted">정리할 구간이 있으면 컨텍스트 모델을 호출해요.</p>
            <div className="form-actions">
              {mode === 'full' && !draft && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !current}
                  onClick={() => {
                    setDraft({ text: summary, revision: detail.activeRevision, headRevision });
                    setError('');
                    setMessage('');
                  }}
                >
                  {summary ? '요약 편집' : '요약 작성'}
                </button>
              )}
              {!working ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || Boolean(draft) || notesDirty || !current}
                  onClick={() =>
                    void write(
                      `${base}/compact`,
                      keyed(command()),
                      'POST',
                      '컨텍스트 압축을 요청했어요.'
                    )
                  }
                >
                  지금 압축
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void write(
                      `${base}/jobs/${id(working.id)}/cancel`,
                      {},
                      'POST',
                      '압축 취소를 요청했어요.'
                    )
                  }
                >
                  압축 취소
                </button>
              )}
            </div>
            {working ? (
              <p role="status">
                {working.status === 'queued'
                  ? '컨텍스트 압축을 기다리고 있어요.'
                  : '컨텍스트를 정리하고 있어요.'}{' '}
                이 화면을 닫아도 작업은 계속돼요.
              </p>
            ) : (
              latest && (
                <div className="context-job-result" role="status">
                  {latest.noop
                    ? '정리할 구간이 없어 원문과 요약을 유지했어요.'
                    : latest.status === 'completed'
                      ? '컨텍스트 압축을 마쳤어요.'
                      : latest.status === 'cancelled'
                        ? '압축을 취소했어요. 마지막 유효한 요약을 유지해요.'
                        : latest.status === 'interrupted'
                          ? '작업이 중단됐어요. 자동으로 다시 실행하지 않아요.'
                          : '컨텍스트를 정리하지 못했어요. 기존 요약을 유지해요.'}
                  {latest.error && (
                    <details>
                      <summary>오류 상세</summary>
                      <p>{latest.error}</p>
                    </details>
                  )}
                </div>
              )
            )}
            {mode === 'full' && draft && (
              <form
                className="context-summary-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSummary();
                }}
              >
                {conflict && (
                  <div className="context-conflict" role="alert">
                    <p>
                      저장된 요약이나 대상 장면이 바뀌었어요. 위의 최신 요약과 입력한 내용을 비교해
                      주세요.
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !current}
                      onClick={() => {
                        setDraft({ ...draft, revision: detail.activeRevision, headRevision });
                        setError('');
                      }}
                    >
                      최신 요약을 확인했어요 · 내 초안 유지
                    </button>
                  </div>
                )}
                <label>
                  편집할 컨텍스트 요약
                  <textarea
                    rows={8}
                    required
                    maxLength={CONTEXT_SUMMARY_MAX_CHARS}
                    value={draft.text}
                    disabled={busy}
                    onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                  />
                </label>
                <div className="form-actions">
                  <button
                    className="primary"
                    disabled={busy || conflict || !current || !draft.text.trim()}
                  >
                    <CheckIcon size={18} aria-hidden="true" />
                    요약 저장{' '}
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
                    편집 취소
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        <details className="context-help">
          <summary>컨텍스트 관리 도움말</summary>
          <p className="muted">사용할 수 있는 요약과 그 이후의 원문을 다음 요청에 사용해요.</p>
          <p className="muted">압축해도 원문은 그대로 보존해요.</p>
          {mode === 'full' && <p className="muted">지속적인 설정 정정은 아래 메모에 남겨요.</p>}
        </details>
      </div>
      {mode === 'full' && (
        <AuthorNotesEditor
          headRevision={headRevision}
          notes={notesCache.current.notes}
          revision={notesCache.current.revision}
          disabled={notes === undefined || busy}
          onSave={async (value) => {
            await api(`/chats/${id(chatId)}/notes`, value);
          }}
          onRefresh={async () => {
            await refreshAll();
            onChanged();
          }}
          onError={onError}
          onDirtyChange={setNotesDirty}
          onSaveHandlerChange={registerNotesSave}
        />
      )}
    </section>
  );
}
