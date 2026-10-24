import { useI18n, translateMessage, formatDate, message as uiMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { StoryDetail } from '../core/story.js';
import {
  defaultStoryGuideConfig,
  STORY_GUIDE_LIMITS,
  type StoryGuideConfig,
  type StoryGuideDetail,
} from '../core/story-guide.js';
import { api, ApiError } from './api.js';
import { AuthorNotesEditor } from './AuthorNotesEditor.js';
import { SelectionCheckbox, Switch } from './BooleanControls.js';
import { LoadingState } from './LoadingState.js';
import { Prose, safeProseLink } from './Prose.js';
import { SaveButton } from './SaveButton.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { TransientNotice } from './TransientNotice.js';
import {
  useSettingsSaveGroup,
  useSettingsSaveHandler,
  type SettingsSaveRegistration,
} from './useSettingsSaveHandler.js';
import './story-guide.css';

const saveSections = ['notes'] as const;
type Props = {
  chatId: string;
  headRevision: string | null;
  profileRevision?: number;
  refreshKey: number;
  active: boolean;
  onChanged: () => void;
  onOpenHelper?: () => void;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
};

export function StoryGuidePanel(props: Props) {
  return <StoryGuideEditor key={props.chatId} {...props} />;
}

function StoryGuideEditor({
  chatId,
  headRevision,
  profileRevision,
  refreshKey,
  active,
  onChanged,
  onOpenHelper,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
}: Props) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<StoryGuideDetail | null>(null);
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [draft, setDraft] = useState(defaultStoryGuideConfig);
  const [draftRevision, setDraftRevision] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  const baseline = useRef(draft);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [notesDirty, setNotesDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflictOpen, setConflictOpen] = useState(false);
  const reviewed = useRef<StoryGuideDetail | null>(null);
  const alive = useRef(true);
  const loadSequence = useRef(0);
  const readRequest = useRef<AbortController | null>(null);
  const saveGroup = useSettingsSaveGroup(saveSections);
  const base = `/chats/${encodeURIComponent(chatId)}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readRequest.current?.abort();
      onDirtyChange(false);
    };
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChange(dirty || notesDirty || saving);
  }, [dirty, notesDirty, saving, onDirtyChange]);

  function report(caught: unknown) {
    const text =
      caught instanceof Error
        ? caught.message
        : uiMessage('prompts.uiUnableToLoadCanonAndCharacterReferences');
    setError(text);
    onError(text);
  }
  function acceptSaved(value: StoryGuideDetail) {
    baseline.current = value.config;
    dirtyRef.current = false;
    setDraft(value.config);
    setDraftRevision(value.revision);
    setDirty(false);
  }
  async function load() {
    const sequence = ++loadSequence.current;
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    try {
      const [value, notes] = await Promise.all([
        api<StoryGuideDetail>(`${base}/story-guide`, undefined, 'GET', controller.signal),
        api<StoryDetail>(`${base}/story`, undefined, 'GET', controller.signal),
      ]);
      if (!alive.current || controller.signal.aborted || sequence !== loadSequence.current) return;
      setLoaded(value);
      setStory(notes);
      setSettingsOpen((open) => open ?? value.revision === 0);
      if (!dirtyRef.current && !savingRef.current) acceptSaved(value);
    } catch (caught) {
      if (alive.current && !controller.signal.aborted && sequence === loadSequence.current)
        report(caught);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload on server changes or re-entry without replacing an edited draft.
  useEffect(() => {
    if (active) void load();
  }, [active, headRevision, profileRevision, refreshKey]);
  function update<K extends keyof StoryGuideConfig>(key: K, value: StoryGuideConfig[K]) {
    const next = { ...draft, [key]: value };
    dirtyRef.current = JSON.stringify(next) !== JSON.stringify(baseline.current);
    setDraft(next);
    setDirty(dirtyRef.current);
    setMessage('');
  }
  async function save() {
    if (savingRef.current || !loaded) return false;
    if (!dirtyRef.current) return true;
    if (draftRevision !== loaded.revision) {
      setConflictOpen(true);
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const value = await api<StoryGuideDetail>(
        `${base}/story-guide`,
        { expectedRevision: draftRevision, config: draft },
        'PUT'
      );
      if (!alive.current) return false;
      loadSequence.current++;
      setLoaded(value);
      acceptSaved(value);
      setMessage(uiMessage('prompts.uiCanonAndCharacterReferencesSavedTheyApplyFromThe'));
      onError('');
      onChanged();
      return true;
    } catch (caught) {
      if (!alive.current) return false;
      report(caught);
      if (caught instanceof ApiError && caught.status === 409) setConflictOpen(true);
      return false;
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (!(await save())) return false;
    return saveGroup.save({ notes: notesDirty });
  });

  if (!loaded)
    return (
      <LoadingState
        presentation="region"
        loading={!error}
        error={translateMessage(error)}
        label={t('prompts.uiLoadingCanonAndCharacterReferences')}
        errorLabel={t('prompts.uiUnableToLoadCanonAndCharacterReferences')}
        onRetry={() => {
          setError('');
          void load();
        }}
      />
    );
  const busy = saving;
  return (
    <section className="story-guide" aria-label={t('prompts.uiCanonAndCharacterReferenceContent')}>
      <form
        className="settings-group"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="story-guide-config">
          <label className="settings-row settings-row-toggle">
            <span className="settings-row-copy">
              <strong>{t('prompts.uiConsultCanonAndCharactersBeforeWriting')}</strong>
              <small>{t('prompts.uiOptionalGeneratingABriefMayAddAModelCall')}</small>
            </span>
            <span className="settings-row-control">
              <Switch
                aria-label={t('prompts.uiConsultCanonAndCharactersBeforeWriting')}
                checked={draft.enabled}
                onChange={(event) => update('enabled', event.target.checked)}
              />
            </span>
          </label>
          <details
            className="story-guide-settings"
            open={settingsOpen ?? false}
            onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
          >
            <summary>
              {t('prompts.uiReferenceSettings')}
              {!settingsOpen && draft.work && <small>{draft.work}</small>}
            </summary>
            <div className="story-guide-fields">
              <label>
                {t('prompts.uiWorkEditionOrSetting')}
                <input
                  value={draft.work}
                  maxLength={STORY_GUIDE_LIMITS.work}
                  placeholder={t('prompts.uiWorkTitleEditionOrSettingToReference')}
                  onChange={(event) => update('work', event.target.value)}
                />
              </label>
              <label>
                {t('prompts.uiReferencePointAndSpoilerLimits')}
                <textarea
                  value={draft.position}
                  maxLength={STORY_GUIDE_LIMITS.position}
                  rows={2}
                  placeholder={t('prompts.uiExampleThroughVolume2DoNotRevealLaterEvents')}
                  onChange={(event) => update('position', event.target.value)}
                />
              </label>
              <label className="story-guide-check">
                <SelectionCheckbox
                  checked={draft.followCanon}
                  onChange={(event) => update('followCanon', event.target.checked)}
                />
                <span>{t('prompts.uiAlsoConsultCanonPlotEvents')}</span>
              </label>
              <label className="story-guide-check">
                <SelectionCheckbox
                  aria-label={t('prompts.uiVerifyCanonWithWebSearch')}
                  checked={draft.webSearch}
                  onChange={(event) => update('webSearch', event.target.checked)}
                />
                <span className="settings-row-copy">
                  <span>{t('prompts.uiVerifyCanonWithWebSearch')}</span>
                  <small>{t('prompts.uiStoryGuideWebSearchScope')}</small>
                </span>
              </label>
              <details className="story-guide-reference">
                <summary>{t('prompts.uiAdditionalReferences')}</summary>
                <p className="muted">
                  {t('prompts.uiExistingCardsAndLoreAreAlsoConsultedAddOnly')}
                </p>
                <label>
                  {t('prompts.uiAdditionalReferenceText')}
                  <textarea
                    value={draft.reference}
                    maxLength={STORY_GUIDE_LIMITS.reference}
                    rows={6}
                    onChange={(event) => update('reference', event.target.value)}
                  />
                </label>
              </details>
            </div>
          </details>
        </fieldset>
        {dirty && (
          <div className="form-actions">
            <SaveButton
              label={t('prompts.uiSaveCanonAndCharacterReferences')}
              aria-busy={saving}
              disabled={busy}
            />
            <small className="muted">{t('prompts.uiSavedChangesApplyFromTheNextRequest')}</small>
          </div>
        )}
      </form>
      {error && (
        <p className="error" role="alert">
          {translateMessage(error)}
        </p>
      )}
      <TransientNotice message={message} />
      <section className="story-guide-section" aria-label={t('prompts.uiLastWritingBrief')}>
        {loaded.brief ? (
          <details className="story-guide-last-brief">
            <summary>{t('prompts.uiLastWritingBrief')}</summary>
            <p className="muted ui-meta-row">
              <span>{formatDate(loaded.brief.createdAt)}</span>
              <span>{loaded.brief.modelTitle}</span>
              {loaded.brief.configRevision !== loaded.revision &&
                t('prompts.uiBriefCreatedWithPreviousSettings')}
            </p>
            <div className="story-guide-result" aria-label={t('prompts.uiLastWritingBriefContent')}>
              <Prose text={loaded.brief.text} />
            </div>
            {loaded.brief.webSearch && (
              <section aria-label={t('prompts.uiStoryGuideWebSources')}>
                <p className="muted">
                  {t(
                    loaded.brief.webSearch.performed
                      ? loaded.brief.webSearch.sources.length
                        ? 'prompts.uiStoryGuideWebSources'
                        : 'prompts.uiStoryGuideWebSearchNoSources'
                      : 'prompts.uiStoryGuideWebSearchNotPerformed'
                  )}
                </p>
                {loaded.brief.webSearch.sources.length > 0 && (
                  <ul>
                    {loaded.brief.webSearch.sources.map((source) => (
                      <li key={source.url}>
                        <a
                          href={safeProseLink(source.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {source.title || source.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                {loaded.brief.webSearch.searchEntryPoint && (
                  <iframe
                    title={t('prompts.uiStoryGuideSearchSuggestions')}
                    srcDoc={loaded.brief.webSearch.searchEntryPoint}
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    referrerPolicy="no-referrer"
                    style={{ width: '100%', height: 160, border: 0 }}
                  />
                )}
              </section>
            )}
          </details>
        ) : (
          <p className="muted">{t('prompts.uiNoWritingBriefHasBeenUsedYet')}</p>
        )}
        {loaded.latestRun?.error && (
          <p className="muted">
            {t(
              loaded.latestRun.error === 'STORY_GUIDE_WEB_SEARCH_UNSUPPORTED'
                ? 'prompts.uiStoryGuideWebSearchUnsupported'
                : loaded.latestRun.error === 'STORY_GUIDE_WEB_SEARCH_NOT_PERFORMED'
                  ? 'prompts.uiStoryGuideWebSearchNotPerformed'
                  : loaded.latestRun.error === 'STORY_GUIDE_WEB_SEARCH_NO_SOURCES'
                    ? 'prompts.uiStoryGuideWebSearchNoSources'
                    : 'prompts.uiTheLatestWritingProceededWithoutABriefCheckThe'
            )}
          </p>
        )}
      </section>
      {onOpenHelper && (
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onOpenHelper}>
            {t('prompts.uiAskHelper2')}
          </button>
        </div>
      )}
      {story && (
        <AuthorNotesEditor
          headRevision={headRevision}
          notes={story.notes}
          revision={story.notesRevision}
          disabled={busy}
          onSave={async (command) => {
            await api(`${base}/notes`, command);
          }}
          onRefresh={async () => {
            await load();
            if (!alive.current) return;
            onChanged();
          }}
          onError={onError}
          onDirtyChange={setNotesDirty}
          onSaveHandlerChange={saveGroup.registrations.notes}
        />
      )}
      <SaveConflictDialog
        open={conflictOpen}
        title={t('prompts.uiReferenceSaveConflict')}
        onClose={() => {
          setConflictOpen(false);
          reviewed.current = null;
        }}
        readSaved={async () => {
          const value = await api<StoryGuideDetail>(`${base}/story-guide`);
          reviewed.current = value;
          return () => [
            {
              label: t('prompts.uiUseForWriting'),
              value: value.config.enabled ? t('prompts.uiOn') : t('prompts.uiOff'),
            },
            { label: t('prompts.uiWorkEditionOrSetting'), value: value.config.work },
            { label: t('prompts.uiReferencePointAndSpoilerLimits'), value: value.config.position },
            {
              label: t('prompts.uiAlsoConsultCanonPlotEvents'),
              value: value.config.followCanon ? t('prompts.uiYes') : t('prompts.uiNo'),
            },
            {
              label: t('prompts.uiVerifyCanonWithWebSearch'),
              value: value.config.webSearch ? t('prompts.uiOn') : t('prompts.uiOff'),
            },
            { label: t('prompts.uiAdditionalReferences'), value: value.config.reference },
          ];
        }}
        onAcceptSaved={() => {
          if (!reviewed.current) return;
          setLoaded(reviewed.current);
          setDraftRevision(reviewed.current.revision);
          setError('');
        }}
      />
    </section>
  );
}
