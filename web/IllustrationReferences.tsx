import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IllustrationCharacterProfile,
  IllustrationReferenceRole,
  IllustrationReferences,
} from '../core/illustration.js';
import { api, ApiError } from './api.js';
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
const rolesOf = (value: Loaded): Record<string, IllustrationReferenceRole | ''> =>
  Object.fromEntries([
    ...value.references.map((item) => [item.ref, item.role]),
    ...value.candidates.map((item) => [item.ref, item.role ?? '']),
  ]);

/** Per-chat visual identities and reference roles. */
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
  const [profiles, setProfiles] = useState<IllustrationCharacterProfile[]>([]);
  const [dirty, setDirty] = useState(false);
  const dirtyDraft = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [reviewConflict, setReviewConflict] = useState(false);
  const lock = useRef(false);
  const loadEpoch = useRef(0);
  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoadError('');
    try {
      const value = await api<Loaded>(
        `/chats/${encodeURIComponent(chatId)}/illustration-references`
      );
      if (epoch !== loadEpoch.current) return null;
      setLoaded((current) =>
        current && dirtyDraft.current
          ? {
              ...value,
              revision: current.revision,
              references: current.references,
              characterProfiles: current.characterProfiles,
            }
          : value
      );
      return value;
    } catch (error) {
      if (epoch === loadEpoch.current) setLoadError((error as Error).message);
      return null;
    }
  }, [chatId]);
  const refresh = useCallback(async () => {
    const value = await load();
    // Edits made while the read was pending still own the draft.
    if (value && !dirtyDraft.current) {
      setRoles(rolesOf(value));
      setProfiles(value.characterProfiles);
    }
  }, [load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reader asset changes reload candidates; a dirty draft keeps its roles.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === chatId) void refresh();
    };
    window.addEventListener('uimori-illustration-references-changed', changed);
    return () => window.removeEventListener('uimori-illustration-references-changed', changed);
  }, [chatId, refresh]);
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
  const candidates = new Set(loaded.candidates.map((item) => item.ref));
  const unavailable = loaded.references.filter((item) => !candidates.has(item.ref));
  const selected = [...loaded.candidates, ...unavailable].filter((item) => roles[item.ref]);
  const linked = new Set(profiles.flatMap((item) => item.referenceRef ?? []));
  const used = new Set([...selected.map((item) => item.ref), ...linked]);
  const markDirty = () => {
    dirtyDraft.current = true;
    setDirty(true);
    setMessage('');
  };
  const editProfile = (id: string, patch: Partial<IllustrationCharacterProfile>) => {
    setProfiles((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
    markDirty();
  };
  const save = async () => {
    if (lock.current) return false;
    if (!dirty) return true;
    if (conflict) {
      setReviewConflict(true);
      return false;
    }
    if (profiles.some((item) => !item.name.trim() || !item.appearance.trim())) {
      onError(uiMessage('visuals.profileRequired'));
      return false;
    }
    lock.current = true;
    setSaving(true);
    setMessage('');
    try {
      const value = await api<IllustrationReferences>(
        `/chats/${encodeURIComponent(chatId)}/illustration-references`,
        {
          expectedRevision: loaded.revision,
          references: selected.map((item) => ({ ref: item.ref, role: roles[item.ref] })),
          characterProfiles: profiles,
        },
        'PUT'
      );
      loadEpoch.current++;
      setLoaded({
        ...loaded,
        revision: value.revision,
        references: value.references,
        characterProfiles: value.characterProfiles,
      });
      dirtyDraft.current = false;
      setDirty(false);
      setConflict(false);
      setMessage(uiMessage('visuals.m031'));
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        setReviewConflict(true);
      } else onError((error as Error).message);
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
      {conflict && (
        <NoticeBanner
          tone="error"
          actions={
            <button type="button" className="secondary" onClick={() => setReviewConflict(true)}>
              {t('shared.reviewSaved')}
            </button>
          }
        >
          {t('visuals.m089')}
        </NoticeBanner>
      )}
      <div className="illustration-character-profiles">
        <h5>{t('visuals.characterProfiles')}</h5>
        {profiles.map((profile, index) => (
          <fieldset key={profile.id} className="illustration-character-profile">
            <legend>{t('visuals.characterProfileNumber', { count: index + 1 })}</legend>
            <label>
              {t('visuals.characterName')}
              <input
                type="text"
                required
                maxLength={200}
                value={profile.name}
                disabled={saving}
                onChange={(event) => editProfile(profile.id, { name: event.target.value })}
              />
            </label>
            <label>
              {t('visuals.characterAppearance')}
              <textarea
                required
                maxLength={2000}
                rows={3}
                value={profile.appearance}
                disabled={saving}
                onChange={(event) => editProfile(profile.id, { appearance: event.target.value })}
              />
            </label>
            <label className="settings-row">
              <span className="settings-row-copy">{t('visuals.characterReference')}</span>
              <select
                aria-label={t('visuals.characterReference')}
                value={profile.referenceRef ?? ''}
                disabled={saving}
                onChange={(event) => {
                  const ref = event.target.value;
                  editProfile(profile.id, { referenceRef: ref || undefined });
                }}
              >
                <option value="">{t('visuals.noCharacterReference')}</option>
                {profile.referenceRef &&
                  !loaded.candidates.some((item) => item.ref === profile.referenceRef) && (
                    <option value={profile.referenceRef}>
                      {t('visuals.unavailableCharacterReference')}
                    </option>
                  )}
                {loaded.candidates.map((item) => (
                  <option
                    key={item.ref}
                    value={item.ref}
                    disabled={!used.has(item.ref) && used.size >= 8}
                  >
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => {
                  setProfiles((current) => current.filter((item) => item.id !== profile.id));
                  markDirty();
                }}
              >
                {t('visuals.removeCharacterProfile')}
              </button>
            </div>
          </fieldset>
        ))}
        <button
          type="button"
          className="secondary illustration-profile-add"
          disabled={saving || profiles.length >= 32}
          onClick={() => {
            setProfiles((current) => [
              ...current,
              { id: crypto.randomUUID(), name: '', appearance: '' },
            ]);
            markDirty();
          }}
        >
          {t('visuals.addCharacterProfile')}
        </button>
      </div>
      <h5>{t('visuals.referenceImages')}</h5>
      {!loaded.candidates.length && <p className="muted">{t('visuals.m035')}</p>}
      {unavailable.map((item, index) => (
        <label className="settings-row" key={item.ref}>
          <span className="settings-row-copy">
            {t('visuals.unavailableReferenceNumber', { count: index + 1 })}
          </span>
          <select
            aria-label={t('visuals.unavailableReferenceNumber', { count: index + 1 })}
            value={linked.has(item.ref) ? 'character' : (roles[item.ref] ?? '')}
            disabled={saving || linked.has(item.ref)}
            onChange={(event) => {
              setRoles((current) => ({
                ...current,
                [item.ref]: event.target.value as IllustrationReferenceRole | '',
              }));
              markDirty();
            }}
          >
            <option value="">{t('visuals.m037')}</option>
            <option value="character" disabled={item.role !== 'character'}>
              {t('visuals.m038')}
            </option>
            <option value="style" disabled={item.role !== 'style'}>
              {t('visuals.m039')}
            </option>
          </select>
        </label>
      ))}
      <div className="asset-grid illustration-reference-options">
        {loaded.candidates.map((item) => (
          <figure key={item.ref}>
            <img src={item.url} alt={item.title} loading="lazy" />
            <figcaption>{item.title}</figcaption>
            <select
              aria-label={t('visuals.m036', { v0: item.title })}
              value={linked.has(item.ref) ? 'character' : (roles[item.ref] ?? '')}
              disabled={saving || linked.has(item.ref) || (!used.has(item.ref) && used.size >= 8)}
              onChange={(event) => {
                setRoles({
                  ...roles,
                  [item.ref]: event.target.value as IllustrationReferenceRole | '',
                });
                markDirty();
              }}
            >
              <option value="">{t('visuals.m037')}</option>
              <option value="character">{t('visuals.m038')}</option>
              <option value="style">{t('visuals.m039')}</option>
            </select>
          </figure>
        ))}
      </div>
      {(loaded.candidates.length > 0 || profiles.length > 0 || dirty) && (
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
      <SaveConflictDialog
        open={reviewConflict}
        title={t('visuals.reviewReferences')}
        onClose={() => setReviewConflict(false)}
        readSaved={async () => {
          const value = await api<Loaded>(
            `/chats/${encodeURIComponent(chatId)}/illustration-references`
          );
          const adopt = (keepDraft: boolean) => {
            loadEpoch.current++;
            setLoaded(keepDraft ? { ...value, references: loaded.references } : value);
            if (!keepDraft) {
              setRoles(rolesOf(value));
              setProfiles(value.characterProfiles);
              dirtyDraft.current = false;
              setDirty(false);
            }
            setConflict(false);
            setLoadError('');
            setReviewConflict(false);
          };
          return () => ({
            content: (
              <>
                {value.characterProfiles.map((profile) => (
                  <div className="settings-row" key={profile.id}>
                    <span className="settings-row-copy">{profile.name}</span>
                    <span className="settings-row-control">
                      {profile.appearance}
                      {profile.referenceRef && (
                        <>
                          {' '}
                          —{' '}
                          {value.candidates.find((item) => item.ref === profile.referenceRef)
                            ?.title ?? t('visuals.unavailableCharacterReference')}
                        </>
                      )}
                    </span>
                  </div>
                ))}
                {value.references.map((reference) => (
                  <div className="settings-row" key={reference.ref}>
                    <span className="settings-row-copy">
                      {value.candidates.find((item) => item.ref === reference.ref)?.title ??
                        t('visuals.unavailableCharacterReference')}
                    </span>
                    <span className="settings-row-control">
                      {t(reference.role === 'character' ? 'visuals.m038' : 'visuals.m039')}
                    </span>
                  </div>
                ))}
              </>
            ),
            actions: (
              <>
                <button type="button" className="secondary" onClick={() => adopt(false)}>
                  {t('visuals.useSavedReferences')}
                </button>
                <button type="button" className="primary" onClick={() => adopt(true)}>
                  {t('visuals.keepReferenceDraft')}
                </button>
              </>
            ),
          });
        }}
      />
    </section>
  );
}
