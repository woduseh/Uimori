import { ScrollStrip } from './ScrollStrip.js';
import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { SettingsIcon } from './ui-icons.js';
import { SaveButton } from './SaveButton.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatProfile, Library } from '../core/product.js';
import type { ExternalJudgmentProvider } from '../core/judgment-settings.js';
import { promptEndpoints } from '#contracts';
import { api, callEndpoint } from './api.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { isModelSelectable } from './model-selection.js';
import { modelLabel } from './storyLabels.js';
import { ContentAttachments } from './ContentAttachments.js';
import { LoreContextPolicyEditor } from './LoreContextPolicyEditor.js';
import type { LoreContextPolicy } from '../core/lore-context.js';
import './library.css';
import './settings-actions.css';
import { useRetryableEffect } from './useRetryableEffect.js';

export type ProfileSection = 'characters' | 'prompts' | 'models' | 'story' | 'images';
const judgmentProviderLabels: Record<ExternalJudgmentProvider, string> = {
  openai: 'OpenAI Decisions',
  gemini: 'Gemini Decisions',
  'openai-compatible': 'OpenAI Decisions',
  'typesafe-compatible': 'TypeSafe System One',
};
const sections: { id: ProfileSection; titleKey: string }[] = [
  {
    id: 'characters',
    titleKey: 'library.conversationSetup',
  },
  {
    id: 'prompts',
    titleKey: 'library.promptsAndModels',
  },
  {
    id: 'story',
    titleKey: 'library.memoryAndLore',
  },
  {
    id: 'images',
    titleKey: 'library.images',
  },
];

export function ProfileEditor({
  profile,
  library,
  onSaved,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  onDiscardHandlerChange,
  onGlobalSettings,
  initialTab = 'characters',
  activeTab,
  hideNavigation = false,
  hideSaveActions = false,
  onSaveRequest,
  disabled = false,
  nextRequest = '',
  loreContextReset = false,
  generationSettings,
}: {
  profile: ChatProfile;
  library: Library;
  onSaved: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onDiscardHandlerChange?: SettingsSaveRegistration;
  onGlobalSettings: (section: 'models' | 'prompts') => void;
  initialTab?: ProfileSection;
  activeTab?: ProfileSection;
  hideNavigation?: boolean;
  hideSaveActions?: boolean;
  onSaveRequest?: () => void;
  disabled?: boolean;
  nextRequest?: string;
  loreContextReset?: boolean;
  generationSettings?: ReactNode;
}) {
  useI18n();
  const form = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState(profile);
  const [dirty, setDirty] = useState(false);
  const { workspace } = usePromptWorkspace();
  const judgment = workspace?.judgment;
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [lorePending, setLorePending] = useState(false),
    [loreResetVersion, setLoreResetVersion] = useState(0);
  const [loreDefaults, setLoreDefaults] = useState<LoreContextPolicy | null>(null);
  const [loreDefaultsError, setLoreDefaultsError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localTab, setTab] = useState<ProfileSection>(initialTab);
  const selectedTab = activeTab ?? localTab;
  const tab = selectedTab === 'models' ? 'prompts' : selectedTab;
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const retryLoreDefaults = useRetryableEffect(() => {
    let active = true;
    setLoreDefaultsError(false);
    void callEndpoint(promptEndpoints.readLoreContextDefaults)
      .then(({ revision: _revision, ...policy }) => {
        if (active) setLoreDefaults(policy);
      })
      .catch(() => {
        if (active) setLoreDefaultsError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty && !lorePending)
      setValue((current) =>
        profile.chatId !== current.chatId || profile.revision >= current.revision
          ? profile
          : current
      );
  }, [profile, dirty, lorePending]);
  useEffect(() => {
    onDirtyChange?.(dirty || lorePending || saving || attachmentPending);
  }, [dirty, lorePending, saving, attachmentPending, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (saving || attachmentPending || lorePending) return false;
    if (!dirty) return true;
    if (!form.current?.reportValidity()) return false;
    return save(() =>
      api<ChatProfile>(`/chats/${profile.chatId}/profile`, profileBody(value), 'PUT')
    );
  });
  useSettingsSaveHandler(onDiscardHandlerChange, async () => {
    if (saving) return false;
    discardChanges();
    return true;
  });
  const change = (next: ChatProfile) => {
    setValue(next);
    setDirty(true);
    setStatus('');
  };
  function discardChanges() {
    setValue(profile);
    setDirty(false);
    setLorePending(false);
    setLoreResetVersion((version) => version + 1);
    setError('');
    setStatus(uiMessage('library.latestSettingsLoaded'));
    onError('');
  }
  async function save(work: () => Promise<ChatProfile>, message = t('library.chatSettingsSaved')) {
    if (lorePending) {
      setError(uiMessage('library.checkTheNumbersInLoreSettingsBefore'));
      return false;
    }
    setSaving(true);
    onError('');
    setError('');
    setStatus('');
    try {
      const accepted = await work();
      setValue(accepted);
      setDirty(false);
      setStatus(message);
      setSaving(false);
      void onSaved().catch((caught) => onError((caught as Error).message));
      return true;
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      onError(message);
      return false;
    } finally {
      setSaving(false);
    }
  }
  const profileBody = (next: ChatProfile) => ({
    expectedRevision: next.revision,
    pinned: next.pinned ?? {},
    authorNote: next.authorNote ?? '',
    image: next.image,
    ...(next.packageAttachments ? { packageAttachments: next.packageAttachments } : {}),
    ...(next.loreContext ? { loreContext: next.loreContext } : {}),
  });
  const promptId = value.pinned?.mainPromptPresetId;
  const promptChoices = library.promptPresets?.filter((item) => item.role === 'main') ?? [];
  const pinnedPrompt = promptChoices.find((item) => item.id === promptId);
  const modelId = value.pinned?.mainModel?.id;
  const selectedModelId = modelId ?? workspace?.modelRoutes.main?.id;
  const selectedModel = library.models.find((item) => item.id === selectedModelId);
  const modelAvailable =
    !!selectedModel && isModelSelectable(selectedModel, library.models, library.connections);
  const modelChoices = library.models.filter((item) =>
    isModelSelectable(item, library.models, library.connections)
  );
  const globalModelSettingsAction = (
    <button type="button" className="secondary" onClick={() => onGlobalSettings('models')}>
      <SettingsIcon size={18} aria-hidden="true" />
      {t('library.globalModelSettings')}
    </button>
  );
  return (
    <section
      className="profile-editor"
      data-testid="profile-editor"
      aria-label={t('library.chatSettings')}
    >
      <ScrollStrip
        hidden={hideNavigation}
        className="profile-tabs"
        role="tablist"
        aria-label={t('library.chatSettingsCategories')}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = sections.findIndex((item) => item.id === tab);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? sections.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) %
                  sections.length;
          setTab(sections[next].id);
          (event.currentTarget.querySelectorAll('button')[next] as HTMLButtonElement).focus();
        }}
      >
        {sections.map((item) => (
          <button
            type="button"
            role="tab"
            id={`profile-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="profile-fields"
            tabIndex={tab === item.id ? 0 : -1}
            key={item.id}
            className="secondary"
            onClick={() => setTab(item.id)}
          >
            {t(item.titleKey)}
          </button>
        ))}
      </ScrollStrip>
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          if (onSaveRequest) return onSaveRequest();
          void save(() =>
            api<ChatProfile>(`/chats/${profile.chatId}/profile`, profileBody(value), 'PUT')
          );
        }}
      >
        <div
          id={hideNavigation ? undefined : 'profile-fields'}
          role={hideNavigation ? undefined : 'tabpanel'}
          aria-labelledby={hideNavigation ? undefined : `profile-tab-${tab}`}
        >
          <fieldset className="profile-fields" disabled={saving || disabled}>
            <div hidden={tab !== 'characters'} className="settings-group">
              <h3 className={hideNavigation ? 'sr-only' : 'settings-group-heading'}>
                {t('library.conversationResources')}
              </h3>
              <ContentAttachments
                profile={value}
                library={library}
                onChange={change}
                onError={onError}
                onPendingChange={setAttachmentPending}
              />
            </div>
            <div hidden={tab !== 'images'} className="chat-profile-image-options settings-group">
              <h3 className="settings-group-heading">{t('library.availableImagePlacement')}</h3>
              <div className="settings-group-body">
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{t('library.imagePlacementOwner')}</strong>
                  </span>
                  <span className="settings-row-control">
                    <select
                      aria-label={t('library.imagePlacementOwner')}
                      value={value.image ? 'jev' : 'writer'}
                      onChange={(event) =>
                        change({ ...value, image: event.target.value === 'jev' })
                      }
                    >
                      <option value="writer">{t('library.writingModel')}</option>
                      <option value="jev">{t('library.judgmentModel')}</option>
                    </select>
                  </span>
                </label>
              </div>
            </div>
            <div hidden={tab !== 'story'}>
              {!loreDefaults &&
                (loreDefaultsError ? (
                  <div>
                    <p className="error" role="alert">
                      {t('library.couldNotLoadGlobalLoreDefaultsYou')}
                    </p>
                    <button type="button" className="secondary" onClick={retryLoreDefaults}>
                      {t('library.reloadGlobalDefaults')}
                    </button>
                  </div>
                ) : (
                  <LoadingState
                    presentation="inline"
                    label={t('library.loadingGlobalLoreDefaults')}
                  />
                ))}
              <LoreContextPolicyEditor
                key={`${profile.chatId}:${loreResetVersion}`}
                value={value.loreContext}
                onChange={(loreContext) => change({ ...value, loreContext })}
                onPendingChange={setLorePending}
                chatId={profile.chatId}
                profileRevision={value.revision}
                request={nextRequest}
                reset={loreContextReset}
                defaults={loreDefaults}
              />
            </div>
            <div hidden={tab !== 'prompts'} className="chat-profile-model-options settings-group">
              <div className="settings-group-body">
                <label className="settings-row">
                  <strong>{t('library.storyModel')}</strong>
                  <select
                    aria-label={t('library.storyModelForThisChat')}
                    value={modelId ?? ''}
                    onChange={(event) =>
                      change({
                        ...value,
                        pinned: {
                          ...value.pinned,
                          mainModel: event.target.value ? { id: event.target.value } : undefined,
                        },
                      })
                    }
                  >
                    <option value="">
                      {t('library.globalValue', {
                        value:
                          library.models.find((item) => item.id === workspace?.modelRoutes.main?.id)
                            ?.title ?? t('library.notSetOrNeedsReview'),
                      })}
                    </option>
                    {modelId && !modelChoices.some((item) => item.id === modelId) && (
                      <option value={modelId}>
                        {t('library.unavailableValue', { value: selectedModel?.title ?? modelId })}
                      </option>
                    )}
                    {modelChoices.map((item) => (
                      <option key={item.id} value={item.id}>
                        {modelLabel(item, library)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {!modelAvailable && workspace ? (
                <NoticeBanner tone="error" actions={globalModelSettingsAction}>
                  {!selectedModelId
                    ? t('library.noStoryModelCannotGenerate')
                    : t('library.theSelectedStoryModelIsUnavailableChoose')}
                </NoticeBanner>
              ) : (
                <div className="form-actions">{globalModelSettingsAction}</div>
              )}
            </div>
            <div hidden={tab !== 'prompts'} className="chat-profile-prompt-options settings-group">
              <div className="settings-group-body">
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{t('library.writingPrompt')}</strong>
                  </span>
                  <select
                    aria-label={t('library.writingPromptForThisChat')}
                    value={promptId ?? ''}
                    onChange={(event) =>
                      change({
                        ...value,
                        pinned: {
                          ...value.pinned,
                          mainPromptPresetId: event.target.value || undefined,
                        },
                      })
                    }
                  >
                    <option value="">
                      {t('library.globalValue', {
                        value: workspace?.main.title ?? t('library.loading'),
                      })}
                    </option>
                    {promptId && !pinnedPrompt && (
                      <option value={promptId}>
                        {t('library.unavailableValue', { value: promptId })}
                      </option>
                    )}
                    {promptChoices.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
                {promptId && !pinnedPrompt && (
                  <p className="error" role="alert">
                    {t('library.thisChatSWritingPromptIsUnavailable')}
                  </p>
                )}
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{t('library.risuAuthorNote')}</strong>
                  </span>
                  <textarea
                    aria-label={t('library.risuAuthorNote')}
                    rows={5}
                    maxLength={32000}
                    value={value.authorNote ?? ''}
                    onChange={(event) => change({ ...value, authorNote: event.target.value })}
                  />
                </label>
              </div>
            </div>
          </fieldset>
        </div>
        {profile.revision > value.revision && dirty && (
          <p className="error" role="alert">
            {t('library.chatSettingsChangedInAnotherRequestYour')}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {translateMessage(error)}
          </p>
        )}
        <div
          className="profile-savebar form-actions settings-save-actions"
          hidden={hideSaveActions || (tab !== 'characters' && !dirty && !lorePending)}
        >
          {(dirty || lorePending) && (
            <button type="button" className="secondary" disabled={saving} onClick={discardChanges}>
              {t('library.discardChanges')}
            </button>
          )}
          {(saving || dirty || lorePending) && (
            <span role="status">
              {saving ? t('library.saving') : t('library.youHaveUnsavedChanges')}
            </span>
          )}
          <SaveButton
            label={t('library.saveChatSettings')}
            disabled={saving || !dirty || lorePending}
            aria-busy={saving}
          />
        </div>
        <TransientNotice content={hideSaveActions ? '' : status} />
      </form>
      {generationSettings}
      <div hidden={tab !== 'prompts'} className="settings-inherited settings-group">
        <h4 className="settings-group-heading">{t('library.modelsUsedByGlobalChatSettings')}</h4>
        <dl className="settings-group-body">
          <div>
            <dt>{t('library.translation')}</dt>
            <dd>
              {library.models.find((item) => item.id === workspace?.modelRoutes.translation?.id)
                ?.title ??
                (workspace
                  ? workspace.modelRoutes.translation?.id
                    ? t('library.unavailableRegisteredModelNotFound')
                    : t('library.noModelSelected')
                  : t('library.loading'))}
            </dd>
          </div>
          <div>
            <dt>{t('library.judgmentModel')}</dt>
            <dd>
              {!workspace
                ? t('library.loading')
                : judgment && judgment.provider !== 'typesafe'
                  ? `${judgmentProviderLabels[judgment.provider]} (${judgment.modelId})`
                  : 'JEV'}
            </dd>
          </div>
        </dl>
      </div>
      <div hidden={tab !== 'prompts'} className="settings-inherited settings-group">
        <h4 className="settings-group-heading">{t('library.promptsUsedByGlobalChatSettings')}</h4>
        <dl className="settings-group-body">
          <div>
            <dt>{t('library.translation')}</dt>
            <dd>{workspace?.translation.title ?? t('library.loading')}</dd>
          </div>
        </dl>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => onGlobalSettings('prompts')}>
            <SettingsIcon size={18} aria-hidden="true" />
            {t('library.globalPromptSettings')}
          </button>
        </div>
      </div>
    </section>
  );
}
