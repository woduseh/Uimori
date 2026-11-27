import { SettingsSearch, hasSettingsSearch } from './SettingsSearch.js';
import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { useSettingsSaveGroup } from './useSettingsSaveHandler.js';
import { readSettingsLocation, rememberSettingsLocation } from './settings-location.js';
import { SaveButton } from './SaveButton.js';
import { LoadingState } from './LoadingState.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { SectionNavigation } from './SectionNavigation.js';
import { ProfileEditor, type ProfileSection } from './ProfileEditor.js';
import { StoryPanel } from './StoryPanel.js';
import { StoryGuidePanel } from './StoryGuidePanel.js';
import { AssetEditor } from './AssetEditor.js';
import { IllustrationReferencesEditor } from './IllustrationReferences.js';
import { SettingsEditor } from './RuntimeSettings.js';
import { ChatVariables } from './ChatVariables.js';
import { api } from './api.js';
import { useCompactLayout } from './useCompactLayout.js';
import { useSettingsHistory } from './useSettingsHistory.js';
import type { StoryState } from './useStory.js';
import { useComposerDraftText } from './composer-draft.js';
import {
  BackIcon,
  BotIcon,
  OptionsIcon,
  CanonIcon,
  MemoryIcon,
  ImagesIcon,
  BehaviorIcon,
  ExpandIcon,
  UndoIcon,
} from './ui-icons.js';
import './chat-settings.css';
import './settings-layout.css';
import { readOptionalStorage } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';

const saveSections = ['story', 'guide', 'profile', 'image', 'reference', 'runtime'] as const;
const generationSections = ['profile', 'runtime'] as const;

export type Section = ProfileSection | 'story' | 'guide' | 'images' | 'runtime' | 'packages';
function getCategories() {
  return [
    {
      id: 'characters',
      terms: t('chatsettings.searchCharacters'),
      title: t('chatsettings.peopleAndMaterials'),
      icon: BotIcon,
      group: t('chatsettings.m85'),
    },
    {
      id: 'prompts',
      terms: `${t('chatsettings.searchPrompts')} ${t('storyUi.enable')} ${t('storyUi.style')}`,
      title: t('chatsettings.promptsModelsAndTranslation'),
      icon: OptionsIcon,
      group: t('chatsettings.m85'),
    },
    {
      id: 'guide',
      terms: t('chatsettings.searchGuide'),
      title: t('chatsettings.m88'),
      icon: CanonIcon,
      group: t('chatsettings.m85'),
    },
    {
      id: 'story',
      terms: t('chatsettings.searchStory'),
      title: t('chatsettings.memoryNotesAndLore'),
      icon: MemoryIcon,
      group: t('chatsettings.m92'),
    },
    {
      id: 'images',
      terms: t('chatsettings.searchImages'),
      title: t('chatsettings.imagesAndReferences'),
      icon: ImagesIcon,
      group: t('chatsettings.m92'),
    },
    {
      id: 'packages',
      terms: t('chatsettings.searchPackages'),
      title: t('chatsettings.m95'),
      icon: BehaviorIcon,
      group: t('chatsettings.m92'),
    },
  ] as const;
}
const isProfile = (section: Section): section is ProfileSection =>
  ['characters', 'prompts', 'models', 'story', 'images'].includes(section);

export function ChatSettingsPanel({
  state,
  onClose,
  initialSection,
  onGlobalSettings,
  onOpenHelper,
  onAskHelper,
}: {
  state: StoryState;
  onClose: () => void;
  initialSection?: Section;
  onGlobalSettings: (section: 'models' | 'prompts') => void;
  onOpenHelper: () => void;
  onAskHelper?: (request: string) => void;
}) {
  useI18n();
  const draft = useComposerDraftText(state.composerDraft);
  const categories = getCategories();
  const requestedSection =
    initialSection ??
    (readSettingsLocation(
      storageKeys.chatSettingsSection,
      categories.map((item) => item.id),
      'characters'
    ) as Section);
  const startSection =
    requestedSection === 'models' || requestedSection === 'runtime' ? 'prompts' : requestedSection;
  const [active, setActive] = useState<Section>(startSection);
  const [profileTab, setProfileTab] = useState<ProfileSection>(
    isProfile(startSection) ? startSection : 'characters'
  );
  const [visited, setVisited] = useState<Section[]>([startSection]);
  const [detailOpen, setDetailOpen] = useState(true);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const searching = hasSettingsSearch(search);
  const [profileDirty, setProfileDirty] = useState(false);
  const [storyDirty, setStoryDirty] = useState(false);
  const [guideDirty, setGuideDirty] = useState(false);
  const [imageDirty, setImageDirty] = useState(false);
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [packageFeatures, setPackageFeatures] = useState<boolean | null>(null);
  const [discard, setDiscard] = useState(false);
  const [savingClose, setSavingClose] = useState(false);
  const [savingPage, setSavingPage] = useState(false);
  const [saveNotice, setSaveNotice] = useState('');
  const savingPageRef = useRef(false);
  const saveGroup = useSettingsSaveGroup(saveSections);
  const discardGroup = useSettingsSaveGroup(generationSections);
  const [confirmGenerationDiscard, setConfirmGenerationDiscard] = useState(false);
  const dirty =
    profileDirty || storyDirty || guideDirty || imageDirty || referenceDirty || runtimeDirty;
  const compact = useCompactLayout();
  const showingDetail = !compact || detailOpen;
  const root = useRef<HTMLElement>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const wasCompact = useRef(compact);
  const scroll = useRef(new Map<Section, number>());
  const positions = useRef(
    new Map<Section, { element: HTMLElement; start: number | null; end: number | null }>()
  );
  const lastFocused = useRef<HTMLElement | null>(null);
  const lastRootFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const panelId = (section: Section) => `${id}-${isProfile(section) ? 'profile' : section}-panel`;
  const title = categories.find((item) => item.id === active)!.title;
  function backToList() {
    rememberPosition();
    setDetailOpen(false);
    requestAnimationFrame(() => {
      if (searching) searchInput.current?.focus();
      else document.getElementById(`${id}-${active}-tab`)?.focus();
    });
  }
  const closeHistory = useSettingsHistory(
    () => {
      if (savingClose || savingPageRef.current) return true;
      const nested = root.current
        ?.closest('dialog')
        ?.querySelector<HTMLDialogElement>('dialog[open]');
      if (nested) {
        nested.dispatchEvent(new Event('cancel', { cancelable: true }));
        return true;
      }
      if (compact && detailOpen) {
        backToList();
        return true;
      }
      if (dirty) {
        setDiscard(true);
        return true;
      }
      return false;
    },
    () => {
      onClose();
      afterClose.current?.();
    }
  );
  function requestClose(next?: () => void) {
    if (savingClose || savingPageRef.current) return;
    afterClose.current = next ?? null;
    if (dirty) setDiscard(true);
    else closeHistory();
  }
  function select(section: Section, fromSearch = false) {
    rememberPosition();
    setActive(section);
    if (isProfile(section)) setProfileTab(section);
    setVisited((old) => (old.includes(section) ? old : [...old, section]));
    setDetailOpen(true);
    requestAnimationFrame(() => {
      const pane = document.getElementById(panelId(section));
      if (pane) {
        pane.scrollTop = scroll.current.get(section) ?? 0;
        if (compact || fromSearch) {
          const position = positions.current.get(section);
          if (position?.element.isConnected && position.element.checkVisibility()) {
            position.element.focus({ preventScroll: true });
            if (
              position.start !== null &&
              position.end !== null &&
              (position.element instanceof HTMLInputElement ||
                position.element instanceof HTMLTextAreaElement)
            )
              position.element.setSelectionRange(position.start, position.end);
          } else pane.focus({ preventScroll: true });
        }
      }
    });
  }
  function rememberPosition() {
    const current = document.getElementById(panelId(active));
    if (!current?.checkVisibility()) return;
    scroll.current.set(active, current.scrollTop);
    const element = lastFocused.current;
    if (element && current.contains(element)) {
      const input =
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element
          : null;
      positions.current.set(active, {
        element,
        start: input?.selectionStart ?? null,
        end: input?.selectionEnd ?? null,
      });
    }
  }
  async function saveGeneration() {
    if (savingPageRef.current || savingClose) return;
    for (const form of root.current?.querySelectorAll<HTMLFormElement>(
      '.settings form, .profile-editor form'
    ) ?? [])
      if (!form.reportValidity()) return;
    savingPageRef.current = true;
    setSavingPage(true);
    setSaveNotice('');
    try {
      if (await saveGroup.save({ profile: profileDirty, runtime: runtimeDirty }))
        setSaveNotice(uiMessage('library.chatSettingsSaved'));
      else
        requestAnimationFrame(() => {
          root.current
            ?.querySelector<HTMLElement>('.settings [role="alert"], .profile-editor [role="alert"]')
            ?.scrollIntoView({ block: 'nearest' });
        });
    } finally {
      savingPageRef.current = false;
      setSavingPage(false);
    }
  }
  useEffect(() => {
    rememberSettingsLocation(storageKeys.chatSettingsSection, active);
  }, [active]);
  useEffect(() => {
    state.setProfileDirty(dirty);
    return () => state.setProfileDirty(false);
  }, [dirty, state.setProfileDirty]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener('beforeunload', guard);
    return () => removeEventListener('beforeunload', guard);
  }, [dirty]);
  useEffect(() => {
    if (compact && !wasCompact.current) setDetailOpen(true);
    wasCompact.current = compact;
    const frame = requestAnimationFrame(() => {
      const focused =
        document.activeElement === document.body ? lastRootFocus.current : document.activeElement;
      if (
        focused instanceof HTMLElement &&
        root.current?.contains(focused) &&
        !focused.checkVisibility()
      )
        root.current?.querySelector<HTMLElement>('.settings-page:not([hidden])')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [compact]);
  const detail = state.detail;
  const library = state.library;
  const packageScope = state.selected;
  const packageAvailabilityKey = `${detail?.profile?.revision ?? 0}:${detail?.reader.cursor ?? 0}`;
  const previousPackageScope = useRef(packageScope);
  useEffect(() => {
    let current = true;
    if (previousPackageScope.current !== packageScope) {
      previousPackageScope.current = packageScope;
      setPackageFeatures(null);
    }
    void packageAvailabilityKey;
    const hasDraft =
      readOptionalStorage('session', storageKeys.chatVariableDraft(state.selected)) !== null;
    void Promise.allSettled([
      api<{
        values: Record<string, string>;
        defaults: Record<string, string>;
        variableDefaultsError?: string;
      }>(`/chats/${encodeURIComponent(state.selected)}/variables`),
    ]).then(([variableResult]) => {
      if (!current) return;
      const variables = variableResult.status === 'fulfilled' ? variableResult.value : null;
      setPackageFeatures(
        hasDraft ||
          Boolean(
            variables &&
              (Object.keys(variables.values).length > 0 ||
                Object.keys(variables.defaults).length > 0 ||
                variables.variableDefaultsError)
          )
      );
    });
    return () => {
      current = false;
    };
  }, [packageAvailabilityKey, packageScope, state.selected]);
  useEffect(() => {
    if (active === 'packages' && packageFeatures === false) {
      setActive('characters');
      setProfileTab('characters');
      setVisited((old) => (old.includes('characters') ? old : [...old, 'characters']));
    }
  }, [active, packageFeatures]);
  const visibleCategories = categories.filter((item) => item.id !== 'packages' || packageFeatures);
  return (
    <Dialog
      open
      title={t('chatsettings.m97')}
      onClose={() => requestClose()}
      wide
      className="settings-dialog chat-settings-dialog"
      headerTitle={compact && detailOpen ? title : undefined}
      headerLeading={
        compact && detailOpen ? (
          <IconButton label={t('chatsettings.m98')} icon={BackIcon} onClick={backToList} />
        ) : undefined
      }
      headerActions={
        compact && detailOpen ? (
          <select
            className="settings-section-select"
            aria-label={t('chatsettings.sectionSelector')}
            value={active}
            onChange={(event) => select(event.target.value as Section)}
          >
            <button type="button">
              <span>{title}</span>
            </button>
            {categories
              .filter((item) => item.id !== 'packages' || packageFeatures || active === 'packages')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        ) : undefined
      }
    >
      <section
        className="chat-settings-panel"
        ref={root}
        aria-label={t('chatsettings.m99')}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement) {
            lastRootFocus.current = event.target;
            if (event.target.closest('.settings-page')) lastFocused.current = event.target;
          }
        }}
      >
        <div
          className="settings-navigation"
          hidden={compact && detailOpen}
          role="navigation"
          aria-label={t('chatsettings.m53')}
        >
          <SettingsSearch
            value={search}
            onChange={setSearch}
            inputRef={searchInput}
            items={visibleCategories.map((item) => ({
              id: item.id,
              label: item.title,
              terms: item.terms,
            }))}
            onSelect={(section) => select(section as Section, true)}
          />
          <SectionNavigation
            label={t('chatsettings.m100')}
            items={visibleCategories.map((item) => ({
              ...item,
              panelId: panelId(item.id),
            }))}
            value={active}
            onSelect={(section) => select(section)}
            compact={compact}
            idPrefix={id}
            hidden={searching}
          />
        </div>
        <div className="settings-pages" hidden={!showingDetail}>
          <section
            className="settings-page"
            role="tabpanel"
            id={panelId('characters')}
            aria-labelledby={`${id}-${profileTab}-tab`}
            hidden={!isProfile(active) || !showingDetail}
            tabIndex={0}
          >
            {detail?.profile && library && (
              <ProfileEditor
                profile={detail.profile}
                library={library}
                activeTab={profileTab}
                hideNavigation
                hideSaveActions={profileTab === 'prompts'}
                disabled={savingPage}
                onSaveRequest={profileTab === 'prompts' ? () => void saveGeneration() : undefined}
                onSaved={() => state.refresh(state.selected)}
                onError={state.setError}
                onDirtyChange={setProfileDirty}
                onSaveHandlerChange={saveGroup.registrations.profile}
                onDiscardHandlerChange={discardGroup.registrations.profile}
                onGlobalSettings={(section) => requestClose(() => onGlobalSettings(section))}
                nextRequest={state.pendingRequestText ?? draft}
                loreContextReset={state.loreContextReset}
                generationSettings={
                  visited.includes('prompts') && (
                    <div hidden={profileTab !== 'prompts'}>
                      <SettingsEditor
                        chat={detail.chat}
                        onSaved={() => state.refresh(state.selected)}
                        onError={state.setError}
                        hideHeading
                        hideSaveActions
                        disabled={savingPage}
                        onSaveRequest={() => void saveGeneration()}
                        onDirtyChange={setRuntimeDirty}
                        onSaveHandlerChange={saveGroup.registrations.runtime}
                        onDiscardHandlerChange={discardGroup.registrations.runtime}
                      />
                    </div>
                  )
                }
              />
            )}
            {profileTab === 'prompts' && (
              <div className="form-actions settings-save-actions">
                {(profileDirty || runtimeDirty) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={savingPage || savingClose}
                    onClick={() => setConfirmGenerationDiscard(true)}
                  >
                    <UndoIcon size={18} aria-hidden="true" />
                    {t('settings.m94')}
                  </button>
                )}
                <SaveButton
                  type="button"
                  label={t('library.saveChatSettings')}
                  disabled={savingPage || savingClose || !(profileDirty || runtimeDirty)}
                  aria-busy={savingPage}
                  onClick={() => void saveGeneration()}
                />
              </div>
            )}
            {visited.includes('story') && detail && (
              <div hidden={profileTab !== 'story'} className="chat-settings-memory">
                <StoryPanel
                  onAskHelper={
                    onAskHelper ? (request) => requestClose(() => onAskHelper(request)) : undefined
                  }
                  chatId={state.selected}
                  refreshKey={state.detail?.reader.cursor ?? 0}
                  headRevision={detail.chat.headRevision}
                  settingsRevision={detail.chat.settingsRevision}
                  profileRevision={detail.profile?.revision}
                  active={active === 'story' && showingDetail}
                  hideHeading
                  onDirtyChange={setStoryDirty}
                  onSaveHandlerChange={saveGroup.registrations.story}
                  onChanged={() => {
                    void state.refresh(state.selected);
                  }}
                  onError={state.setError}
                />
              </div>
            )}
            {visited.includes('images') && detail && (
              <div hidden={profileTab !== 'images'} className="chat-settings-images">
                <details className="chat-settings-image-management">
                  <summary>
                    <ExpandIcon size={16} aria-hidden="true" />
                    {t('chatsettings.m102')}{' '}
                    <small>
                      {t('chatsettings.imagesCount', { count: (detail.assets ?? []).length })}
                    </small>
                  </summary>
                  <AssetEditor
                    chatId={state.selected}
                    assets={detail.assets ?? []}
                    expanded
                    refresh={() => state.refresh(state.selected)}
                    onError={state.setError}
                    onDirtyChange={setImageDirty}
                    onSaveHandlerChange={saveGroup.registrations.image}
                  />
                </details>
                <IllustrationReferencesEditor
                  chatId={state.selected}
                  refreshKey={`${detail.profile?.revision ?? 0}:${(detail.assets ?? []).length}`}
                  onDirtyChange={setReferenceDirty}
                  onSaveHandlerChange={saveGroup.registrations.reference}
                  onError={state.setError}
                />
              </div>
            )}
          </section>
          {categories
            .filter((item) => !isProfile(item.id))
            .map(({ id: section }) => (
              <section
                key={section}
                className="settings-page"
                role="tabpanel"
                id={panelId(section)}
                aria-labelledby={`${id}-${section}-tab`}
                hidden={active !== section || !showingDetail}
                tabIndex={0}
              >
                {visited.includes(section) && detail && library && (
                  <>
                    {section === 'guide' && (
                      <StoryGuidePanel
                        chatId={state.selected}
                        headRevision={detail.chat.headRevision}
                        profileRevision={detail.profile?.revision}
                        refreshKey={detail.reader.cursor}
                        active={active === 'guide' && showingDetail}
                        onOpenHelper={() => requestClose(onOpenHelper)}
                        onChanged={() => {
                          void state.refresh(state.selected);
                        }}
                        onError={state.setError}
                        onDirtyChange={setGuideDirty}
                        onSaveHandlerChange={saveGroup.registrations.guide}
                      />
                    )}
                    {section === 'packages' && packageFeatures && (
                      <ChatVariables
                        key={packageScope}
                        chatId={state.selected}
                        active={active === 'packages' && showingDetail}
                        refreshKey={state.detail?.reader.cursor ?? 0}
                        onChange={() => {
                          void state.refresh(state.selected);
                        }}
                      />
                    )}
                    {section === 'packages' && packageFeatures === null && (
                      <LoadingState presentation="region" loading />
                    )}
                  </>
                )}
              </section>
            ))}
        </div>
      </section>
      {state.error && (
        <p role="alert" className="error">
          {translateMessage(state.error)}
        </p>
      )}
      <TransientNotice message={saveNotice} />
      <Dialog
        open={discard}
        title={t('chatsettings.m105')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (savingClose) return;
          setDiscard(false);
          afterClose.current = null;
        }}
      >
        <p>{t('chatsettings.m80')}</p>
        <DraftDiscardActions
          open={discard}
          onSavingChange={setSavingClose}
          saveLabel={t('chatsettings.m81')}
          onSave={async () => {
            if (
              !(await saveGroup.save({
                profile: profileDirty,
                story: storyDirty,
                guide: guideDirty,
                image: imageDirty,
                reference: referenceDirty,
                runtime: runtimeDirty,
              }))
            )
              return false;
            setDiscard(false);
            closeHistory();
            return true;
          }}
          onContinue={() => {
            setDiscard(false);
            afterClose.current = null;
          }}
          onDiscard={() => {
            setDiscard(false);
            closeHistory();
          }}
          discardLabel={t('chatsettings.m82')}
        />
      </Dialog>
      <Dialog
        open={confirmGenerationDiscard}
        title={t('settings.m96')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => setConfirmGenerationDiscard(false)}
      >
        <p>{t('settings.m97')}</p>
        <DraftDiscardActions
          open={confirmGenerationDiscard}
          disabled={savingPage}
          onContinue={() => setConfirmGenerationDiscard(false)}
          onDiscard={async () => {
            await discardGroup.save({ profile: profileDirty, runtime: runtimeDirty });
            setConfirmGenerationDiscard(false);
          }}
          discardLabel={t('settings.m98')}
        />
      </Dialog>
    </Dialog>
  );
}
