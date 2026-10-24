import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { IllustrationReferenceRole, IllustrationReferences } from '../core/illustration.js';
import { api } from './api.js';
import { SaveButton } from './SaveButton.js';
import { RefreshIcon } from './ui-icons.js';
import './settings-actions.css';
import './illustrations.css';

type Candidate = {
  ref: string;
  title: string;
  url: string;
  mime: string;
  role: IllustrationReferenceRole | null;
};
type Loaded = IllustrationReferences & { candidates: Candidate[] };

/** Per-chat reference roles for Codex illustration turns; ComfyUI ignores them for now. */
export function IllustrationReferencesEditor({
  chatId,
  refreshKey,
  onDirtyChange,
  onSaveHandlerChange,
  onError,
}: {
  chatId: string;
  refreshKey: string | number;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onError: (message: string) => void;
}) {
  useI18n();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [roles, setRoles] = useState<Record<string, IllustrationReferenceRole | ''>>({});
  const [dirty, setDirty] = useState(false);
  const dirtyDraft = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const lock = useRef(false);
  const load = useCallback(async () => {
    setLoadError('');
    try {
      const value = await api<Loaded>(
        `/chats/${encodeURIComponent(chatId)}/illustration-references`
      );
      setLoaded(value);
      return value;
    } catch (error) {
      setLoadError((error as Error).message);
      return null;
    }
  }, [chatId]);
  const refresh = useCallback(async () => {
    const value = await load();
    // Role edits made while the read was pending still own the draft.
    if (value && !dirtyDraft.current)
      setRoles(Object.fromEntries(value.candidates.map((item) => [item.ref, item.role ?? ''])));
  }, [load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reader asset changes reload candidates; a dirty draft keeps its roles.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, async () => (!loaded ? false : save()));
  if (!loaded)
    return (
      <section className="illustration-references" aria-label={t('visuals.m028')}>
        <h4>{t('visuals.m028')}</h4>
        <LoadingState
          presentation="placeholder"
          loading={!loadError}
          error={translateMessage(loadError)}
          label={t('visuals.m029')}
          errorLabel={t('visuals.m030')}
          onRetry={() => void refresh()}
        />
      </section>
    );
  const selected = loaded.candidates.filter((item) => roles[item.ref]);
  const save = async () => {
    if (lock.current) return false;
    if (!dirty) return true;
    lock.current = true;
    setSaving(true);
    setMessage('');
    try {
      const value = await api<IllustrationReferences>(
        `/chats/${encodeURIComponent(chatId)}/illustration-references`,
        {
          expectedRevision: loaded.revision,
          references: selected.map((item) => ({ ref: item.ref, role: roles[item.ref] })),
        },
        'PUT'
      );
      setLoaded({ ...loaded, revision: value.revision, references: value.references });
      dirtyDraft.current = false;
      setDirty(false);
      setMessage(uiMessage('visuals.m031'));
      return true;
    } catch (error) {
      onError((error as Error).message);
      return false;
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  return (
    <section
      className="illustration-references"
      aria-label={t('visuals.m028')}
      data-testid="illustration-references"
    >
      <h4>{t('visuals.m028')}</h4>
      {!!loaded.candidates.length && <small>{t('visuals.m032')}</small>}
      {loadError && (
        <NoticeBanner
          tone="error"
          actions={
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={() => void refresh()}
            >
              <RefreshIcon size={18} aria-hidden="true" />
              {t('visuals.m033')}
            </button>
          }
        >
          {t('visuals.referenceRefreshError', { error: translateMessage(loadError) })}
        </NoticeBanner>
      )}
      {!loaded.candidates.length && <p className="muted">{t('visuals.m035')}</p>}
      <div className="asset-grid illustration-reference-options">
        {loaded.candidates.map((item) => (
          <figure key={item.ref}>
            <img src={item.url} alt={item.title} loading="lazy" />
            <figcaption>{item.title}</figcaption>
            <select
              aria-label={t('visuals.m036', { v0: item.title })}
              value={roles[item.ref] ?? ''}
              disabled={saving || (!roles[item.ref] && selected.length >= 8)}
              onChange={(event) => {
                dirtyDraft.current = true;
                setRoles({
                  ...roles,
                  [item.ref]: event.target.value as IllustrationReferenceRole | '',
                });
                setDirty(true);
                setMessage('');
              }}
            >
              <option value="">{t('visuals.m037')}</option>
              <option value="character">{t('visuals.m038')}</option>
              <option value="style">{t('visuals.m039')}</option>
            </select>
          </figure>
        ))}
      </div>
      {(loaded.candidates.length > 0 || dirty) && (
        <div className="form-actions settings-save-actions">
          <SaveButton
            type="button"
            label={t('visuals.m040')}
            aria-busy={saving}
            disabled={!dirty || saving}
            onClick={() => void save()}
          />
        </div>
      )}
      <TransientNotice message={message} />
    </section>
  );
}
