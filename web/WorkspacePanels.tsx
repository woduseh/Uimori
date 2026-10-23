import { LanguageSelect } from './LanguageSelect.js';
import { t, useI18n, translateMessage } from './i18n.js';
import { PushSettings } from './PushSettings.js';
import { AutoTranslationDefaults } from './AutoTranslationDefaults.js';
import { LoadingState } from './LoadingState.js';
import { InstallApp } from './InstallApp.js';
import { UsagePanel } from './UsagePanel.js';
import { ThemeSettings } from './ThemeSettings.js';
import { ChartNoAxesColumn, Palette, type LucideIcon } from 'lucide-react';
import { useSettingsSaveGroup } from './useSettingsSaveHandler.js';
import type { ReactNode } from 'react';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { ModelWorkspaceEditor } from './ModelWorkspaceEditor.js';
import { PromptWorkspaceEditor } from './PromptWorkspaceEditor.js';
import { discardActiveEditor, ResourceEditorLeaveWarning } from './resource-editor.js';
import { ActivityDetails } from './ActivityStatus.js';
import { CodexAgentSettings } from './CodexAgentSettings.js';
import { AppAbout } from './AppAbout.js';
import { Info } from 'lucide-react';
import './recovery-settings.css';
import './settings-layout.css';
import { IllustrationSettingsEditor } from './IllustrationSettingsEditor.js';
import { LoreContextDefaultsEditor } from './LoreContextDefaultsEditor.js';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { useCompactLayout } from './useCompactLayout.js';
import { useSettingsHistory } from './useSettingsHistory.js';
import {
  SettingsIcon,
  ConnectionIcon,
  ModelIcon,
  PromptIcon,
  AgentIcon,
  DataIcon,
  BackIcon,
  IllustrationIcon,
  LibraryIcon,
} from './ui-icons.js';
import type { Job, ReaderRun } from '../core/types.js';
import type { StoryState } from './useStory.js';
import { api } from './api.js';
import { ConnectionEditor } from './ProviderManagement.js';
import { ArchivePanel } from './ArchivePanel.js';
import { AttemptInspector } from './AttemptInspector.js';
import { RunTaskDetails } from './RunTaskDetails.js';

export function TasksPanel({
  state,
  inspectedRun,
  onInspect,
  onClose,
}: {
  state: StoryState;
  inspectedRun: string | null;
  onInspect: (runId: string) => void;
  onClose: () => void;
}) {
  useI18n();
  const [pending, setPending] = useState<string[]>([]);
  const detail = state.detail;
  const [jobs, setJobs] = useState<
    Pick<Job, 'id' | 'sourceRevision' | 'kind' | 'status' | 'error' | 'attempt'>[] | null
  >(null);
  const [jobsError, setJobsError] = useState('');
  const [runList, setRunList] = useState<{
    chatId: string;
    runs: ReaderRun[] | null;
    loading: boolean;
    error: string;
  } | null>(null);
  const [runRetry, setRunRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Full summaries are fetched only while this panel is mounted, on chat/event changes or explicit retry.
  useEffect(() => {
    if (!detail) return;
    let alive = true;
    const chatId = detail.chat.id;
    setRunList((old) => ({
      chatId,
      runs: old?.chatId === chatId ? old.runs : null,
      loading: true,
      error: '',
    }));
    void api<ReaderRun[]>(`/chats/${chatId}/reader-runs`)
      .then((runs) => {
        if (alive) setRunList({ chatId, runs, loading: false, error: '' });
      })
      .catch((error) => {
        if (alive)
          setRunList((old) => ({
            chatId,
            runs: old?.chatId === chatId ? old.runs : null,
            loading: false,
            error: error.message,
          }));
      });
    return () => {
      alive = false;
    };
  }, [detail?.chat.id, detail?.reader.cursor, runRetry]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Job reads follow the chat and event cursor, not unrelated reader snapshot changes.
  useEffect(() => {
    let alive = true;
    setJobs(null);
    setJobsError('');
    if (detail)
      void api<Pick<Job, 'id' | 'sourceRevision' | 'kind' | 'status' | 'error' | 'attempt'>[]>(
        `/chats/${detail.chat.id}/jobs`
      )
        .then((value) => {
          if (alive) setJobs(value);
        })
        .catch((error) => {
          if (alive) setJobsError(error.message);
        });
    return () => {
      alive = false;
    };
  }, [detail?.chat.id, detail?.reader.cursor]);
  if (!detail) return <p className="muted">{t('chatsettings.m0')}</p>;
  const listed = runList?.chatId === detail.chat.id ? runList : null;
  const allRuns = listed?.runs ?? null;
  const runs = inspectedRun
    ? (allRuns?.filter((run) => run.id === inspectedRun) ?? [])
    : (allRuns ?? []);
  const refresh = () => state.refresh(detail.chat.id);
  async function perform(key: string, operation: () => Promise<unknown>) {
    if (pending.includes(key)) return;
    setPending((old) => [...old, key]);
    state.setError('');
    try {
      await operation();
    } catch (error) {
      state.setError((error as Error).message);
    } finally {
      setPending((old) => old.filter((item) => item !== key));
    }
  }
  return (
    <section className="tasks-panel" aria-label={t('chatsettings.m1')}>
      <div className="panel-intro">
        <p className="muted">{t('chatsettings.taskIntro', { title: detail.chat.title })}</p>
        {inspectedRun && (
          <button type="button" className="secondary" onClick={() => onInspect('')}>
            {t('chatsettings.m3')}
          </button>
        )}
      </div>
      {!state.connected && (
        <p className="connection-notice" role="status">
          {t('chatsettings.m4')}
        </p>
      )}
      <ActivityDetails activities={detail.reader.activity ?? []} />
      <LoadingState
        presentation={allRuns ? 'inline' : 'placeholder'}
        loading={!listed || listed.loading}
        error={listed?.error}
        label={t('chatsettings.m5')}
        errorLabel={t('chatsettings.m6')}
        onRetry={() => setRunRetry((value) => value + 1)}
        retryLabel={t('chatsettings.m7')}
      />
      {allRuns && !listed?.loading && !listed?.error && !runs.length && (
        <p className="muted">{inspectedRun ? t('chatsettings.m8') : t('chatsettings.m9')}</p>
      )}
      {runs.some((run) => run.sourceRevision) && <p className="muted">{t('chatsettings.m10')}</p>}
      <div className="runs">
        {runs.map((run) => (
          <article key={run.id} data-testid="run" data-run-id={run.id} className="run">
            <p className="task-request">{run.request}</p>
            <RunTaskDetails
              run={run}
              jobs={jobs ?? []}
              revision={detail.reader.cursor}
              refresh={refresh}
              onError={state.setError}
              initiallyInspect={!!inspectedRun}
              presentation="list"
            >
              <div className="form-actions">
                {run.sourceRevision && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      state.chooseSource(run.sourceRevision!);
                      onClose();
                    }}
                  >
                    <LibraryIcon size={18} aria-hidden="true" />
                    {t('chatsettings.m11')}
                  </button>
                )}
                {run.sourceRevision && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending.includes(run.id)}
                    onClick={() => {
                      void perform(run.id, async () => {
                        await state.fork(run.sourceRevision!);
                      });
                    }}
                  >
                    {t('chatsettings.m12')}
                  </button>
                )}
              </div>
            </RunTaskDetails>
          </article>
        ))}
      </div>
      <LoadingState
        presentation="inline"
        loading={!jobs && !jobsError}
        error={translateMessage(jobsError)}
        label={t('chatsettings.m13')}
        errorLabel={t('chatsettings.m14')}
      />
      {allRuns && (
        <AttemptInspector
          key={detail.chat.id}
          chatId={detail.chat.id}
          revision={detail.reader.cursor}
          runs={allRuns}
        />
      )}
    </section>
  );
}

const appSaveSections = [
  'archive',
  'connection',
  'model',
  'prompt',
  'lore',
  'illustration',
  'themes',
] as const;

type SettingsDestination = { label: string; terms: string; anchor?: string };
type SettingsCategory = {
  key: string;
  label: string;
  icon: LucideIcon;
  terms?: string;
  destinations?: SettingsDestination[];
};

function getSettingsCategories(): SettingsCategory[] {
  return [
    {
      key: 'general',
      label: t('chatsettings.m15'),
      icon: SettingsIcon,
      destinations: [
        {
          label: t('chatsettings.m16'),
          terms: t('chatsettings.m17'),
          anchor: 'display',
        },
        {
          label: t('chatsettings.m18'),
          terms: t('chatsettings.m19'),
          anchor: 'generation',
        },
        {
          label: t('chatsettings.m11'),
          terms: t('chatsettings.m20'),
          anchor: 'reading',
        },
        { label: t('chatsettings.m21'), terms: t('chatsettings.m22'), anchor: 'services' },
        { label: t('chatsettings.m23'), terms: t('chatsettings.m24'), anchor: 'session' },
      ],
    },
    { key: 'themes', label: t('chatsettings.m25'), icon: Palette, terms: t('chatsettings.m26') },
    {
      key: 'models',
      label: t('chatsettings.m27'),
      icon: ModelIcon,
      terms: t('chatsettings.m28'),
    },
    {
      key: 'prompts',
      label: t('chatsettings.m29'),
      icon: PromptIcon,
      terms: t('chatsettings.m30'),
    },
    {
      key: 'connections',
      label: t('chatsettings.m31'),
      icon: ConnectionIcon,
      terms: t('chatsettings.m32'),
    },
    { key: 'lore', label: t('chatsettings.m33'), icon: LibraryIcon, terms: t('chatsettings.m34') },
    { key: 'agents', label: t('chatsettings.m35'), icon: AgentIcon, terms: t('chatsettings.m36') },
    {
      key: 'illustrations',
      label: t('chatsettings.m37'),
      icon: IllustrationIcon,
      terms: t('chatsettings.m38'),
    },
    {
      key: 'usage',
      label: t('chatsettings.m39'),
      icon: ChartNoAxesColumn,
      terms: t('chatsettings.m40'),
    },
    {
      key: 'data',
      label: t('chatsettings.m41'),
      icon: DataIcon,
      destinations: [
        {
          label: t('chatsettings.m42'),
          terms: t('chatsettings.m43'),
        },
      ],
    },
    { key: 'about', label: t('chatsettings.m44'), icon: Info, terms: t('chatsettings.m45') },
  ];
}

function getLibrarySettingsSubjects(): Record<string, string> {
  return {
    models: t('chatsettings.m46'),
    prompts: t('chatsettings.m47'),
    connections: t('chatsettings.m48'),
    illustrations: t('chatsettings.m49'),
  };
}

function searchText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
}

function matchesSearch(value: string, query: string) {
  const text = searchText(value);
  return query
    .trim()
    .split(/[\s/·-]+/)
    .filter(Boolean)
    .every((term) => text.includes(searchText(term)));
}

export function AppSettingsPanel({
  initialTab = 'general',
  state,
  theme,
  setTheme,
  enterSend,
  setEnterSend,
  panelWidth,
  setPanelWidth,
  sidebarWidth,
  setSidebarWidth,
  readingSettings,
  onClose,
  onEditPrompt,
}: {
  initialTab?: string;
  state: StoryState;
  theme: 'system' | 'dark' | 'light';
  setTheme: (theme: 'system' | 'dark' | 'light') => void;
  enterSend: boolean;
  setEnterSend: (value: boolean) => void;
  panelWidth: number;
  setPanelWidth: (value: number) => void;
  sidebarWidth: number;
  setSidebarWidth: (value: number) => void;
  readingSettings: ReactNode;
  onClose: () => void;
  onEditPrompt?: (presetId?: string) => void;
}) {
  useI18n();
  const settingsCategories = getSettingsCategories();
  const librarySettingsSubjects = getLibrarySettingsSubjects();
  const [signingOut, setSigningOut] = useState(false);
  const [active, setActive] = useState(initialTab);
  const [visited, setVisited] = useState([initialTab]);
  const [modelToEdit, setModelToEdit] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const compact = useCompactLayout();
  const [detail, setDetail] = useState(initialTab !== 'general');
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [modelDirty, setModelDirty] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const [archiveDirty, setArchiveDirty] = useState(false);
  const [themeDirty, setThemeDirty] = useState(false);
  const [illustrationDirty, setIllustrationDirty] = useState(false);
  const [loreDirty, setLoreDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [savingClose, setSavingClose] = useState(false);
  const saveGroup = useSettingsSaveGroup(appSaveSections);
  const [discardError, setDiscardError] = useState('');
  const dirty =
    connectionDirty ||
    archiveDirty ||
    modelDirty ||
    promptDirty ||
    loreDirty ||
    illustrationDirty ||
    themeDirty;
  const root = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const wasCompact = useRef(compact);
  const id = useId();
  const query = searchText(search).replace(/[\/·-]/g, '');
  const results: { key: string; label: string; section: string; anchor?: string }[] = query
    ? settingsCategories.flatMap((category) => {
        if (matchesSearch(`${category.label} ${category.terms ?? ''}`, search))
          return [{ key: category.key, label: category.label, section: '' }];
        return (category.destinations ?? [])
          .filter((destination) =>
            matchesSearch(`${category.label} ${destination.label} ${destination.terms}`, search)
          )
          .map((destination) => ({
            key: category.key,
            label: destination.label,
            section: category.label,
            anchor: destination.anchor,
          }));
      })
    : [];
  const title =
    settingsCategories.find((item) => item.key === active)?.label ?? t('chatsettings.m15');
  const showingDetail = !compact || detail;
  function backToList() {
    setDetail(false);
    requestAnimationFrame(() => {
      if (query) searchInput.current?.focus();
      else document.getElementById(`${id}-${active}-tab`)?.focus();
    });
  }
  const closeHistory = useSettingsHistory(() => {
    if (savingClose) return true;
    const nested = root.current
      ?.closest('dialog')
      ?.querySelector<HTMLDialogElement>('dialog[open]');
    if (nested) {
      nested.dispatchEvent(new Event('cancel', { cancelable: true }));
      return true;
    }
    if (compact && detail) {
      backToList();
      return true;
    }
    if (dirty) {
      setDiscard(true);
      return true;
    }
    return false;
  }, onClose);
  function requestClose() {
    if (savingClose) return;
    if (dirty) setDiscard(true);
    else closeHistory();
  }
  useEffect(() => {
    if (compact && !wasCompact.current) setDetail(true);
    wasCompact.current = compact;
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        root.current?.contains(focused) &&
        !focused.checkVisibility()
      )
        document.getElementById(`${id}-${active}-panel`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [compact, active, id]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener('beforeunload', guard);
    return () => removeEventListener('beforeunload', guard);
  }, [dirty]);
  function select(key: string, target?: string) {
    setActive(key);
    setDetail(true);
    setVisited((previous) => (previous.includes(key) ? previous : [...previous, key]));
    if (compact || target)
      requestAnimationFrame(() => {
        const destination = document.getElementById(`${id}-${key}-${target ?? 'panel'}`);
        destination?.focus({ preventScroll: true });
        if (target && target !== 'panel') destination?.scrollIntoView({ block: 'start' });
      });
  }
  return (
    <Dialog
      open
      title={t('chatsettings.m50')}
      onClose={requestClose}
      wide
      className="settings-dialog"
      headerTitle={compact && detail ? title : undefined}
      headerLeading={
        compact && detail ? (
          <IconButton label={t('chatsettings.m51')} icon={BackIcon} onClick={backToList} />
        ) : undefined
      }
    >
      <section ref={root} className="app-settings-panel" aria-label={t('chatsettings.m52')}>
        <div
          className="settings-navigation"
          hidden={compact && detail}
          role="navigation"
          aria-label={t('chatsettings.m53')}
        >
          <input
            ref={searchInput}
            type="search"
            className="settings-search"
            aria-label={t('chatsettings.m54')}
            placeholder={t('chatsettings.m54')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div
            className="settings-navigation-list"
            hidden={!!query}
            role={compact ? undefined : 'tablist'}
            aria-label={compact ? undefined : t('chatsettings.m55')}
            aria-orientation={compact ? undefined : 'vertical'}
            onKeyDown={(event) => {
              if (compact) return;
              const index = settingsCategories.findIndex((item) => item.key === active);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? settingsCategories.length - 1
                    : ['ArrowDown', 'ArrowRight'].includes(event.key)
                      ? (index + 1) % settingsCategories.length
                      : ['ArrowUp', 'ArrowLeft'].includes(event.key)
                        ? (index + settingsCategories.length - 1) % settingsCategories.length
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              select(settingsCategories[next].key);
              event.currentTarget
                .querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus();
            }}
          >
            {settingsCategories.map(({ key, label, icon: Icon }) => (
              <button
                type="button"
                role={compact ? undefined : 'tab'}
                key={key}
                id={`${id}-${key}-tab`}
                aria-controls={`${id}-${key}-panel`}
                aria-selected={compact ? undefined : active === key}
                tabIndex={compact || active === key ? 0 : -1}
                onClick={() => select(key)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
          {query && (
            <div className="settings-search-results" aria-label={t('chatsettings.m56')}>
              {results.length ? (
                results.map(({ key, label, section, anchor }) => (
                  <button
                    type="button"
                    key={`${key}-${label}`}
                    onClick={() => {
                      select(key, anchor ?? 'panel');
                      setSearch('');
                    }}
                  >
                    <span>{label}</span>
                    {section && <small>{section}</small>}
                  </button>
                ))
              ) : (
                <p className="muted" role="status">
                  {t('chatsettings.m57')}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="settings-pages" hidden={!showingDetail}>
          {settingsCategories.map(({ key, label }) => (
            <section
              className="settings-page"
              data-settings-section={key}
              role="tabpanel"
              id={`${id}-${key}-panel`}
              aria-labelledby={`${id}-${key}-tab`}
              hidden={active !== key || !showingDetail}
              tabIndex={0}
              key={key}
            >
              {visited.includes(key) && (
                <>
                  {!compact && <h3 className="settings-page-title">{label}</h3>}
                  {key === 'themes' && (
                    <ThemeSettings
                      appearanceMode={theme}
                      onAppearanceModeChange={setTheme}
                      active={active === 'themes' && showingDetail}
                      onDirtyChange={setThemeDirty}
                      onSaveHandlerChange={saveGroup.registrations.themes}
                    />
                  )}
                  {key === 'about' && <AppAbout />}
                  {librarySettingsSubjects[key] && !state.library && (
                    <LoadingState
                      presentation="region"
                      loading={!state.libraryError}
                      error={state.libraryError}
                      label={t(`chatsettings.${key}Loading`)}
                      errorLabel={t(`chatsettings.${key}Error`)}
                      onRetry={() => void state.retryLibrary().catch(() => {})}
                    />
                  )}
                  {key === 'general' && (
                    <section
                      id={`${id}-general-display`}
                      tabIndex={-1}
                      className="settings-section settings-group"
                    >
                      <h3>
                        {t('chatsettings.m16')}
                        <span className="scope-badge">{t('chatsettings.m58')}</span>
                      </h3>
                      <div className="settings-group-body">
                        <LanguageSelect />
                        <label className="settings-row">
                          <span className="settings-row-copy">
                            <strong>{t('chatsettings.m59')}</strong>
                          </span>
                          <select
                            aria-label={t('chatsettings.m60')}
                            value={theme}
                            onChange={(event) =>
                              setTheme(event.target.value as 'system' | 'dark' | 'light')
                            }
                          >
                            <option value="system">{t('chatsettings.m61')}</option>
                            <option value="dark">{t('chatsettings.m62')}</option>
                            <option value="light">{t('chatsettings.m63')}</option>
                          </select>
                        </label>
                        <label className="settings-row">
                          <span className="settings-row-copy">
                            <strong>{t('settings.sendKey')}</strong>
                            <small>
                              {t('settings.newlineKey')}{' '}
                              <kbd>{enterSend ? 'Shift + Enter' : 'Enter'}</kbd>
                            </small>
                          </span>
                          <span className="settings-row-control">
                            <select
                              aria-label={t('settings.sendKey')}
                              value={enterSend ? 'enter' : 'modifier'}
                              onChange={(event) => setEnterSend(event.target.value === 'enter')}
                            >
                              <option value="enter">Enter</option>
                              <option value="modifier">Ctrl / Cmd + Enter</option>
                            </select>
                          </span>
                        </label>
                      </div>
                      <h4>{t('settings.desktopPanels')}</h4>
                      <div className="settings-group-body">
                        <label className="settings-row">
                          <span className="settings-row-copy">
                            <strong>{t('chatsettings.m67')}</strong>
                          </span>
                          <select
                            aria-label={t('chatsettings.m67')}
                            value={sidebarWidth}
                            onChange={(event) => setSidebarWidth(Number(event.target.value))}
                          >
                            <option value={248}>{t('chatsettings.m69')}</option>
                            <option value={320}>{t('chatsettings.m70')}</option>
                            <option value={400}>{t('chatsettings.m71')}</option>
                          </select>
                        </label>
                        <label className="settings-row">
                          <span className="settings-row-copy">
                            <strong>{t('settings.utilityPanelWidth')}</strong>
                            <small>{t('settings.panelOverlap')}</small>
                          </span>
                          <select
                            aria-label={t('settings.utilityPanelWidth')}
                            value={panelWidth}
                            onChange={(event) => setPanelWidth(Number(event.target.value))}
                          >
                            <option value={360}>{t('chatsettings.m74')}</option>
                            <option value={384}>{t('chatsettings.m69')}</option>
                            <option value={480}>{t('chatsettings.m70')}</option>
                          </select>
                        </label>
                      </div>
                    </section>
                  )}
                  {key === 'general' && (
                    <section
                      id={`${id}-general-generation`}
                      tabIndex={-1}
                      className="settings-section settings-group"
                    >
                      <h3>
                        {t('chatsettings.m18')}
                        <span className="scope-badge">{t('chatsettings.m75')}</span>
                      </h3>
                      <AutoTranslationDefaults />
                    </section>
                  )}
                  {key === 'general' && (
                    <section
                      id={`${id}-general-reading`}
                      tabIndex={-1}
                      className="settings-section"
                    >
                      <h3>
                        {t('chatsettings.m11')}
                        <span className="scope-badge">{t('chatsettings.m58')}</span>
                      </h3>
                      {readingSettings}
                    </section>
                  )}
                  {key === 'general' && (
                    <section
                      id={`${id}-general-services`}
                      tabIndex={-1}
                      className="settings-section settings-services"
                      aria-label={t('chatsettings.m21')}
                    >
                      <h3>
                        {t('chatsettings.m21')}
                        <span className="scope-badge">{t('chatsettings.m58')}</span>
                      </h3>
                      <InstallApp />
                      <PushSettings />
                    </section>
                  )}
                  {key === 'usage' && <UsagePanel connections={state.library?.connections} />}
                  {key === 'models' && state.library && (
                    <ModelWorkspaceEditor
                      library={state.library}
                      onDirtyChange={setModelDirty}
                      onSaveHandlerChange={saveGroup.registrations.model}
                      onManage={() => select('connections')}
                      onEditModel={(modelId) => {
                        setModelToEdit(modelId);
                        select('connections');
                      }}
                    />
                  )}
                  {key === 'prompts' && state.library && (
                    <PromptWorkspaceEditor
                      library={state.library}
                      reload={state.loadLibrary}
                      onDirtyChange={setPromptDirty}
                      onSaveHandlerChange={saveGroup.registrations.prompt}
                      onEditPrompt={onEditPrompt}
                      navigationDisabled={dirty}
                    />
                  )}
                  {key === 'connections' && (
                    <div data-testid="connection-settings">
                      {state.library && (
                        <ConnectionEditor
                          library={state.library}
                          reload={state.loadLibrary}
                          onError={state.setError}
                          onDirtyChange={setConnectionDirty}
                          onSaveHandlerChange={saveGroup.registrations.connection}
                          modelToEdit={modelToEdit}
                          onModelEditHandled={() => setModelToEdit(null)}
                        />
                      )}
                    </div>
                  )}
                  {key === 'agents' && (
                    <CodexAgentSettings
                      active={active === 'agents' && showingDetail}
                      onOpenModels={() => select('connections')}
                    />
                  )}
                  {key === 'lore' && (
                    <LoreContextDefaultsEditor
                      onDirtyChange={setLoreDirty}
                      onSaveHandlerChange={saveGroup.registrations.lore}
                    />
                  )}
                  {key === 'illustrations' && state.library && (
                    <IllustrationSettingsEditor
                      library={state.library}
                      scope={{
                        chatId:
                          state.destination === 'story' ? state.selected || undefined : undefined,
                        botId:
                          state.destination === 'story'
                            ? state.chats.find((chat) => chat.id === state.selected)?.botId
                            : undefined,
                      }}
                      onDirtyChange={setIllustrationDirty}
                      onSaveHandlerChange={saveGroup.registrations.illustration}
                    />
                  )}
                  {key === 'data' && (
                    <>
                      <ArchivePanel
                        expanded
                        onImported={async () => {
                          await Promise.all([state.loadChats(), state.loadLibrary()]);
                          if (state.selected) await state.refresh(state.selected);
                        }}
                        onError={state.setError}
                        onDirtyChange={setArchiveDirty}
                        onSaveHandlerChange={saveGroup.registrations.archive}
                      />
                    </>
                  )}
                  {key === 'general' && (
                    <section
                      id={`${id}-general-session`}
                      tabIndex={-1}
                      className="settings-section"
                    >
                      <h3>{t('chatsettings.m76')}</h3>
                      <div className="settings-row">
                        <div className="settings-row-copy">
                          <span>{t('chatsettings.m77')}</span>
                          <p className="muted">{t('chatsettings.m78')}</p>
                        </div>
                        <div className="settings-row-control">
                          <button
                            type="button"
                            className="secondary"
                            disabled={signingOut}
                            onClick={() => {
                              setSigningOut(true);
                              void api('/session', {}, 'DELETE')
                                .then(() => location.reload())
                                .catch((error) => {
                                  state.setError(error.message);
                                  setSigningOut(false);
                                });
                            }}
                          >
                            {t('chatsettings.m23')}
                          </button>
                        </div>
                      </div>
                    </section>
                  )}
                </>
              )}
            </section>
          ))}
        </div>
      </section>
      {state.error && (
        <p className="error" role="alert">
          {translateMessage(state.error)}
        </p>
      )}
      <Dialog
        open={discard}
        title={t('chatsettings.m79')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!discarding && !savingClose) setDiscard(false);
        }}
      >
        <p>{t('chatsettings.m80')}</p>
        {promptDirty && <ResourceEditorLeaveWarning />}
        {discardError && (
          <p role="alert" className="error">
            {translateMessage(discardError)}
          </p>
        )}
        <DraftDiscardActions
          open={discard}
          disabled={discarding}
          onSavingChange={setSavingClose}
          saveLabel={t('chatsettings.m81')}
          onSave={async () => {
            if (
              !(await saveGroup.save({
                archive: archiveDirty,
                connection: connectionDirty,
                model: modelDirty,
                prompt: promptDirty,
                lore: loreDirty,
                illustration: illustrationDirty,
                themes: themeDirty,
              }))
            )
              return false;
            setDiscard(false);
            closeHistory();
            return true;
          }}
          onContinue={() => setDiscard(false)}
          onDiscard={async () => {
            setDiscarding(true);
            setDiscardError('');
            try {
              if (promptDirty) await discardActiveEditor('prompt-workspace:current');
              setDiscard(false);
              closeHistory();
            } catch (error) {
              setDiscardError((error as Error).message);
            } finally {
              setDiscarding(false);
            }
          }}
          discardLabel={t('chatsettings.m82')}
        />
      </Dialog>
    </Dialog>
  );
}
