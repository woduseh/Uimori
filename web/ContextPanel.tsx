import { t, translateMessage, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import { SOURCE_TEXT_MAX_CHARS as CONTEXT_SUMMARY_MAX_CHARS } from '../core/content-limits.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { SummaryEditor } from './SummaryEditor.js';
import { useEffect, useRef, useState } from 'react';
import type { ContextDetail, ContextJob as StoredContextJob } from '../core/context-plan.js';
import type { AuthorNote } from '../core/notes.js';
import { AuthorNotesEditor } from './AuthorNotesEditor.js';
import { api, ApiError } from './api.js';
import { useLiveRefresh } from './live-stream.js';
import { contextJobPollDelay } from './poll-delays.js';
import { useUnsavedInput } from './unsaved-input.js';
import './context.css';

type ContextJob = Omit<StoredContextJob, 'snapshot'>;
type SummaryDraft = { text: string; revision: number; headRevision: string | null };
const id = encodeURIComponent;
const pending = (job: ContextJob) => job.status === 'queued' || job.status === 'running';
const origins = () => ({
  automatic: t('settings.m269'),
  manual: t('settings.m270'),
  edit: t('settings.m271'),
  model: t('settings.m272'),
});

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
  useI18n();
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
  const [readFailed, setReadFailed] = useState(false);
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
  const editing = mode === 'full' && draft !== null;
  const editTrigger = useRef<HTMLButtonElement>(null);
  const editorInput = useRef<HTMLTextAreaElement>(null);
  const focusEditor = useRef(false);
  const returnFocus = useRef(false);
  const triggerEnabled = !busy && current;
  useEffect(() => {
    if (editing && focusEditor.current) {
      focusEditor.current = false;
      editorInput.current?.focus();
    }
    if (!editing && returnFocus.current && triggerEnabled && editTrigger.current) {
      returnFocus.current = false;
      editTrigger.current.focus();
    }
  }, [editing, triggerEnabled]);
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
  useUnsavedInput(notesDirty ? { domain: 'notes', chatId } : null);
  function report(caught: unknown) {
    const text = caught instanceof Error ? caught.message : t('settings.m273');
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
      setReadFailed(false);
      if (result.notesRevision !== notesCache.current.revision) await onRefreshStory();
    } catch (caught) {
      if (
        alive.current &&
        generation === scope.current.generation &&
        sequence === readSequence.current
      ) {
        setReadFailed(true);
        report(caught);
      }
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scope/event changes refresh server data without resetting editor state or depending on render-local callbacks.
  useEffect(() => {
    if (active) void load();
  }, [active, chatId, headRevision, refreshKey]);
  useLiveRefresh({
    enabled: active,
    match: (frame) =>
      frame.event === 'chats' && frame.chatId === chatId && frame.kind.startsWith('context.'),
    refresh: load,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a pending compact job needs periodic refresh; editing and hidden panels do not restart its timer.
  useEffect(() => {
    if (!active || !working) return;
    const timer = setInterval(() => {
      void load();
    }, contextJobPollDelay);
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
      t('settings.m274'),
      true
    );
  }
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (busy || actionLock.current) return false;
    if (notesDirty && !(await notesSave.current?.())) return false;
    return saveSummary();
  });
  return (
    <section
      className={`context-panel${mode === 'compact' ? ' context-panel-compact' : ''}`}
      aria-label={t('settings.m275')}
      data-testid="context-panel"
    >
      <div className="context-heading">
        <h4>{t('reader.storySummary')}</h4>
      </div>
      <div className="context-content">
        {detail && error && (
          <NoticeBanner
            tone="error"
            actions={
              readFailed ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    void refreshAll();
                  }}
                >
                  {t('shared.retry')}
                </button>
              ) : undefined
            }
          >
            {translateMessage(error)}
          </NoticeBanner>
        )}
        <TransientNotice message={message} />
        {!detail ? (
          <LoadingState
            presentation="placeholder"
            loading={!error}
            error={translateMessage(error)}
            label={t('settings.m278')}
            onRetry={() => {
              setError('');
              void refreshAll();
            }}
          />
        ) : (
          <>
            {editing && !conflict ? null : summary ? (
              <div className="context-summary">
                {!detail.usable && (
                  <NoticeBanner>
                    {t('settings.flow22', { v0: detail.invalidReason ?? t('settings.m280') })}
                  </NoticeBanner>
                )}
                <small>
                  {t('settings.flow23', {
                    v0: origins()[detail.checkpoint!.origin],
                    v1: detail.checkpoint!.plan.compacted.length,
                  })}
                </small>
                <p className="context-text" data-testid="context-summary-text">
                  {summary}
                </p>
              </div>
            ) : (
              <p className="muted">{t('settings.m282')}</p>
            )}
            {mode === 'full' && draft && (
              <SummaryEditor
                value={draft.text}
                saved={summary ?? ''}
                busy={busy}
                conflict={conflict}
                conflictMessage={t('settings.m305')}
                saveDisabled={busy || conflict || !current || !draft.text.trim()}
                rebaseDisabled={busy || !current}
                inputRef={editorInput}
                onChange={(text) => setDraft({ ...draft, text })}
                onRebase={() => {
                  setDraft({ ...draft, revision: detail.activeRevision, headRevision });
                  setError('');
                }}
                onCancel={() => {
                  returnFocus.current = true;
                  setDraft(null);
                  setError('');
                }}
                onSave={() => {
                  returnFocus.current = true;
                  void saveSummary();
                }}
              />
            )}
            {!current && <LoadingState presentation="inline" label={t('settings.m283')} />}
            <details className="context-priorities">
              <summary>{t('settings.m284')}</summary>
              <label>
                <span className="sr-only">{t('settings.m285')}</span>
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={priorities}
                  disabled={busy || Boolean(working)}
                  placeholder={t('settings.m286')}
                  onChange={(event) => setPriorities(event.target.value)}
                />
              </label>
            </details>
            <div className="form-actions">
              {mode === 'full' && !draft && (
                <button
                  ref={editTrigger}
                  type="button"
                  className="secondary"
                  disabled={!triggerEnabled}
                  onClick={() => {
                    focusEditor.current = true;
                    setDraft({ text: summary, revision: detail.activeRevision, headRevision });
                    setError('');
                    setMessage('');
                  }}
                >
                  {summary ? t('settings.m289') : t('settings.m290')}
                </button>
              )}
              {!working ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || Boolean(draft) || notesDirty || !current}
                  onClick={() =>
                    void write(`${base}/compact`, keyed(command()), 'POST', t('settings.m291'))
                  }
                >
                  {t('settings.m292')}
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
                      t('settings.m293')
                    )
                  }
                >
                  {t('settings.m294')}
                </button>
              )}
            </div>
            {working ? (
              <LoadingState
                presentation="inline"
                key={working.id}
                label={t('settings.m295', {
                  v0: working.status === 'queued' ? t('settings.m296') : t('settings.m297'),
                })}
              />
            ) : (
              latest && (
                <div className="context-job-result" role="status">
                  {latest.noop
                    ? t('settings.m298')
                    : latest.status === 'completed'
                      ? t('settings.m299')
                      : latest.status === 'cancelled'
                        ? t('settings.m300')
                        : latest.status === 'interrupted'
                          ? t('settings.m301')
                          : t('settings.m302')}
                  {latest.error && (
                    <details>
                      <summary>{t('settings.m303')}</summary>
                      <p>{latest.error}</p>
                    </details>
                  )}
                </div>
              )
            )}
          </>
        )}
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
