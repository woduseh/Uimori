import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatVariableState } from '../core/chat-variables.js';
import { api, ApiError } from './api.js';
import { RefreshIcon, SearchIcon, ResetIcon } from './ui-icons.js';
import './chat-variables.css';

type VariableView = ChatVariableState & {
  defaults: Record<string, string>;
  resolved: Record<string, string>;
  sourceHash: string | null;
  pending: boolean;
  variableDefaultsError?: string;
};
type SaveBody = {
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
      JSON.stringify(pendingValues) === JSON.stringify(draftValues)
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

/** Chat overrides are an explicit user edit. Background refreshes only update the
 * comparison base; they never adopt, discard, or replay the draft. */
export function ChatVariables({ chatId, refreshKey, onChange }: Props) {
  useI18n();
  const storageKey = `uimori:chat-variable-draft:${chatId}`;
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
  const readEndpoint = endpoint;
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
        setError(cause instanceof Error ? cause.message : uiMessage('chatsettings.m158'));
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
      setError(uiMessage('chatsettings.m159'));
    }
    setNotice('');
  }

  async function save() {
    if (!view || !draft || saving.current) return;
    const parsed = parseValues(draft.text);
    if (!parsed) {
      setError(uiMessage('chatsettings.m160'));
      return;
    }
    const conflict = draft.revision !== view.revision || draft.sourceHash !== view.sourceHash;
    if (conflict && !draft.pending) return;
    const body: SaveBody =
      draft.pending ??
      ({
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
      setError(uiMessage('chatsettings.m161'));
      return;
    }
    try {
      const saved = await api<VariableView>(endpoint, body, 'PUT');
      if (!alive.current) return;
      readEpoch.current++;
      setLoading(false);
      setView(saved);
      setDraft(null);
      try {
        rememberDraft(storageKey, null);
      } catch {
        /* The committed response is authoritative even when local cleanup is unavailable. */
      }
      setNotice(uiMessage('chatsettings.m162'));
      onChange?.();
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : uiMessage('chatsettings.m163'));
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
    <section className="chat-variables" aria-label={t('chatsettings.m164')}>
      <header className="chat-variable-heading">
        {view && (
          <small>
            {t('chatsettings.overrides', {
              count: Object.keys(view.values).length,
            })}
          </small>
        )}
        <IconButton
          type="button"
          className="ghost"
          icon={RefreshIcon}
          label={t('chatsettings.m168')}
          disabled={loading || busy}
          onClick={() => void load()}
        />
      </header>
      <p className="muted">{t('chatsettings.m169')}</p>
      {loading && <LoadingState presentation="placeholder" label={t('chatsettings.m170')} />}
      {view?.pending && <p role="status">{t('chatsettings.m171')}</p>}
      {view?.variableDefaultsError && (
        <p role="alert" className="error">
          {t('chatsettings.defaultsError', { error: translateMessage(view.variableDefaultsError) })}
        </p>
      )}
      {conflict && !hasUncertainSave && (
        <div className="behavior-action-result" role="alert">
          <p>{t('chatsettings.m173')}</p>
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
                setError(uiMessage('chatsettings.m159'));
              }
            }}
          >
            {t('chatsettings.m174')}
          </button>
        </div>
      )}
      {hasUncertainSave && <p role="status">{t('chatsettings.m175')}</p>}
      <TransientNotice message={notice} />
      {error && (
        <p role="alert" className="error">
          {translateMessage(error)}
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
          <label className="chat-variable-search">
            <SearchIcon size={18} aria-hidden="true" />
            <input
              type="search"
              aria-label={t('chatsettings.m176')}
              placeholder={t('chatsettings.m176')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="ghost"
            disabled={Boolean(draft && !parsed)}
            onClick={() => setRaw(!showJson)}
          >
            {showJson ? t('chatsettings.m177') : t('chatsettings.m178')}
          </button>
        </div>
        <div hidden={showJson}>
          <div className="chat-variable-rows settings-group-body">
            {visibleKeys.map((key) => {
              const overridden = Object.hasOwn(overrides ?? {}, key);
              return (
                <div className="chat-variable-row" key={key}>
                  <label>
                    <span className="chat-variable-identity">
                      <span className="chat-variable-key">{key}</span>
                      <span className="chat-variable-origin">
                        {overridden ? t('chatsettings.m179') : t('chatsettings.m180')}
                      </span>
                    </span>
                    <input
                      aria-label={t('chatsettings.variableValue', { key })}
                      value={overridden ? overrides![key] : (view?.defaults[key] ?? '')}
                      disabled={locked}
                      onChange={(event) => changeValue(key, event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost chat-variable-reset"
                    title={t('chatsettings.resetVariable', { key })}
                    disabled={locked || !overridden}
                    aria-label={t('chatsettings.resetVariable', { key })}
                    onClick={() => removeOverride(key)}
                  >
                    <ResetIcon size={18} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          {!loading && view && !visibleKeys.length && (
            <p className="muted">{query ? t('chatsettings.m181') : t('chatsettings.m182')}</p>
          )}
          <details className="chat-variable-add">
            <summary>{t('chatsettings.m183')}</summary>
            <div className="chat-variable-toolbar">
              <label>
                {t('chatsettings.m184')}
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
                {t('chatsettings.m185')}
              </button>
            </div>
          </details>
        </div>
        <div hidden={!showJson}>
          <label>
            {t('chatsettings.m186')}
            <textarea
              aria-label={t('chatsettings.m186')}
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
        {draft && !parsed && <small className="error">{t('chatsettings.m187')}</small>}
        <div className="form-actions">
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
              setNotice(uiMessage('chatsettings.m188'));
            }}
          >
            <ResetIcon size={16} aria-hidden="true" /> {t('chatsettings.m189')}
          </button>

          <SaveButton
            type="submit"
            label={hasUncertainSave ? t('chatsettings.m190') : t('chatsettings.m191')}
            text={hasUncertainSave ? t('chatsettings.m190') : t('shared.save')}
            aria-busy={busy}
            disabled={
              !view ||
              (loading && !hasUncertainSave) ||
              busy ||
              !parsed ||
              (!hasUncertainSave && (!dirty || conflict || view.pending))
            }
          />
        </div>
      </form>
      {view && (
        <div className="chat-variable-readbacks">
          <details>
            <summary>
              {t('chatsettings.effectiveCount', { count: Object.keys(view.resolved).length })}
            </summary>
            <pre>{encodeValues(view.resolved)}</pre>
          </details>
          <details>
            <summary>
              {t('chatsettings.defaultCount', { count: Object.keys(view.defaults).length })}
            </summary>
            <pre>{encodeValues(view.defaults)}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
