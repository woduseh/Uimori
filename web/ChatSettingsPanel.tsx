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
import {
  BackIcon,
  BotIcon,
  PromptIcon,
  LoreIcon,
  ImagesIcon,
  BehaviorIcon,
  ExpandIcon,
} from './ui-icons.js';
import './chat-settings.css';
import './settings-layout.css';

const saveSections = ['story', 'guide', 'profile', 'image', 'reference', 'runtime'] as const;

export type Section = ProfileSection | 'story' | 'guide' | 'images' | 'runtime' | 'packages';
// Two groups: the basics every chat needs, then the advanced automation sections.
// Reading settings live in their own dialog (chat ⋯ menu), not here.
function getCategories() {
  return [
    {
      id: 'characters',
      title: t('chatsettings.peopleAndMaterials'),
      icon: BotIcon,
      group: t('chatsettings.m85'),
    },
    {
      id: 'prompts',
      title: t('chatsettings.promptsModelsAndTranslation'),
      icon: PromptIcon,
      group: t('chatsettings.m85'),
    },
    {
      id: 'guide',
      title: t('chatsettings.m88'),
      icon: LoreIcon,
      group: t('chatsettings.m85'),
    },
    {
      id: 'story',
      title: t('chatsettings.memoryNotesAndLore'),
      icon: LoreIcon,
      group: t('chatsettings.m92'),
    },
    {
      id: 'images',
      title: t('chatsettings.imagesAndReferences'),
      icon: ImagesIcon,
      group: t('chatsettings.m92'),
    },
    {
      id: 'packages',
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
  /** Explicit destinations override the remembered section. */
  initialSection?: Section;
  onGlobalSettings: (section: 'models' | 'prompts') => void;
  onOpenHelper: () => void;
  onAskHelper?: (request: string) => void;
}) {
  useI18n();
  const categories = getCategories();
  const requestedSection =
    initialSection ??
    (readSettingsLocation(
      'uimori:chat-settings-section',
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
    requestAnimationFrame(() => document.getElementById(`${id}-${active}-tab`)?.focus());
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
  function select(section: Section) {
    rememberPosition();
    setActive(section);
    if (isProfile(section)) setProfileTab(section);
    setVisited((old) => (old.includes(section) ? old : [...old, section]));
    setDetailOpen(true);
    requestAnimationFrame(() => {
      const pane = document.getElementById(panelId(section));
      if (pane) {
        pane.scrollTop = scroll.current.get(section) ?? 0;
        if (compact) {
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
    // Validate both native forms before the first independent write.
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
    rememberSettingsLocation('uimori:chat-settings-section', active);
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
    let hasDraft = false;
    try {
      hasDraft = sessionStorage.getItem(`uimori:chat-variable-draft:${state.selected}`) !== null;
    } catch {
      // The server-owned feature checks still work when browser draft storage is unavailable.
    }
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
        <SectionNavigation
          label={t('chatsettings.m100')}
          items={visibleCategories.map((item) => ({
            ...item,
            panelId: panelId(item.id),
          }))}
          value={active}
          onSelect={select}
          compact={compact}
          idPrefix={id}
          hidden={compact && detailOpen}
        />
        <div className="settings-pages" hidden={!showingDetail}>
          <section
            className="settings-page"
            role="tabpanel"
            id={panelId('characters')}
            aria-labelledby={`${id}-${profileTab}-tab`}
            hidden={!isProfile(active) || !showingDetail}
            tabIndex={0}
          >
            {!compact && (
              <h3 className="settings-page-title">
                {categories.find((item) => item.id === profileTab)!.title}
              </h3>
            )}
            {visited.includes('prompts') && detail && (
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
                />
              </div>
            )}
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
                onGlobalSettings={(section) => requestClose(() => onGlobalSettings(section))}
                nextRequest={state.pendingRequest ?? state.draft}
                loreContextReset={state.loreContextReset}
              />
            )}
            {profileTab === 'prompts' && (
              <div className="form-actions settings-save-actions">
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
            .map(({ id: section, title: label }) => (
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
                    {!compact && <h3 className="settings-page-title">{label}</h3>}
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
    </Dialog>
  );
}
