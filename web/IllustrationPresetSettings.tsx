import { t, useI18n, translateMessage, messageRef, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Plus,
  Upload,
  Download,
  Copy,
  Trash2,
  RefreshCw,
  Check,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  emptyIllustrationPreset,
  illustrationPresetDefinition,
  illustrationPresetFile,
  parseIllustrationPresetFile,
  resolveIllustrationPreset,
  validateIllustrationPreset,
  ILLUSTRATION_PRESET_FILE_MAX_BYTES,
  ILLUSTRATION_WORKFLOW_MAX_CHARS,
  type IllustrationPreset,
  type IllustrationPresetCatalog,
  type IllustrationPresetDefinition,
  type IllustrationPresetScope,
  type IllustrationPresetGenerator,
} from '../core/illustration-presets.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { Library } from '../core/product.js';
import type { IllustrationSettings } from '../core/illustration.js';
import { isModelSelectable } from './model-selection.js';
import { api, ApiError, saveDownload } from './api.js';
import { Dialog } from './Dialog.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { illustrationErrorMessage } from './illustration-labels.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import './illustration-presets.css';
import './settings-layout.css';

type Draft = {
  id: string | null;
  revision?: number;
  model: IllustrationPresetDefinition;
};
const changedKey = 'uimori:illustration-presets-changed';
const messageOf = (error: unknown) => {
  const message = (error as Error).message;
  return /^COMFYUI_/u.test(message) ? illustrationErrorMessage(message) : message;
};
// Keep nested UI errors distinct from authored preset names and instructions.
function preservedError(error: string): string {
  return uiMessage('visualpanels.preservedError', { message: messageRef(error) });
}
export function IllustrationPresetSettings({
  library,
  environment,
  scope,
  onDirtyChange,
  onSaveHandlerChange,
  onGeneratorChange,
}: {
  library: Library;
  environment: IllustrationSettings | null;
  scope: IllustrationPresetScope;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onGeneratorChange?: (generator: IllustrationPresetGenerator) => void;
}) {
  useI18n();
  const [catalog, setCatalog] = useState<IllustrationPresetCatalog | null>(null);
  const [target, setTarget] = useState<'global' | 'bot' | 'chat'>('global');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [operation, setOperation] = useState<'save' | 'other' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [deleting, setDeleting] = useState<IllustrationPreset | null>(null);
  const [discard, setDiscard] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLElement>(null);
  const [workflowError, setWorkflowError] = useState('');
  const editorId = useId();
  function resetEditorDetails() {
    setWorkflowError('');
    editor.current?.querySelectorAll('details').forEach((details) => {
      details.open = false;
    });
  }
  const locked = useRef(false);
  const alive = useRef(true);
  const epoch = useRef(0);
  const dirty = !!draft && JSON.stringify(draft.model) !== baseline;
  const refresh = useCallback(async (notify = false) => {
    const version = ++epoch.current;
    try {
      const next = await api<IllustrationPresetCatalog>('/illustration-presets');
      if (alive.current && version === epoch.current) {
        setCatalog(next);
        setLoadError('');
      }
    } catch (cause) {
      if (alive.current && version === epoch.current) setLoadError(messageOf(cause));
    }
    if (notify) {
      try {
        localStorage.setItem(changedKey, `${Date.now()}:${Math.random()}`);
      } catch {
        /* Saving is already durable on the server. */
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const focus = () => {
      void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === changedKey) focus();
    };
    window.addEventListener('focus', focus);
    window.addEventListener('uimori-illustration-presets-changed', focus);
    window.addEventListener('storage', storage);
    return () => {
      alive.current = false;
      epoch.current++;
      window.removeEventListener('focus', focus);
      window.removeEventListener('uimori-illustration-presets-changed', focus);
      window.removeEventListener('storage', storage);
    };
  }, [refresh]);
  useEffect(() => {
    onDirtyChange(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if ((target === 'bot' && !scope.botId) || (target === 'chat' && !scope.chatId))
      setTarget('global');
  }, [target, scope.botId, scope.chatId]);
  async function action(work: () => Promise<void>, saveAttempt = false): Promise<boolean> {
    if (locked.current) return false;
    locked.current = true;
    setOperation(saveAttempt ? 'save' : 'other');
    setError('');
    setNotice('');
    setImportNotice('');
    try {
      await work();
      return true;
    } catch (cause) {
      setError(draft ? preservedError(messageOf(cause)) : messageOf(cause));
      if (cause instanceof ApiError && cause.status === 409) {
        await refresh();
        if (saveAttempt) setSaveConflict(true);
      }
      return false;
    } finally {
      locked.current = false;
      setOperation(null);
    }
  }
  async function save(asCopy = false): Promise<boolean> {
    if (!draft || (!dirty && !asCopy)) return true;
    setWorkflowError('');
    setError('');
    setNotice('');
    setImportNotice('');
    let model: IllustrationPresetDefinition;
    try {
      model = validateIllustrationPreset(
        asCopy ? { ...draft.model, title: `${draft.model.title.slice(0, 97)} 사본` } : draft.model
      );
    } catch (cause) {
      const message = messageOf(cause);
      setError(preservedError(message));
      if (cause instanceof Error && /^COMFYUI_WORKFLOW_|^ComfyUI 워크플로:/u.test(cause.message)) {
        setWorkflowError(message);
        requestAnimationFrame(() => {
          const field =
            editor.current?.querySelector<HTMLTextAreaElement>('[data-workflow-editor]');
          const details = field?.closest('details');
          if (details instanceof HTMLDetailsElement) details.open = true;
          field?.focus();
        });
      }
      return false;
    }
    return action(async () => {
      const { saved } = await api<{ saved: IllustrationPreset }>('/resources/save', {
        kind: 'illustration-preset',
        id: asCopy ? null : draft.id,
        expectedRevision: asCopy ? undefined : draft.revision,
        model,
      });
      const accepted = illustrationPresetDefinition(saved);
      setDraft({ id: saved.id, revision: saved.revision, model: accepted });
      setBaseline(JSON.stringify(accepted));
      setNotice(
        draft.id && !asCopy
          ? '저장했어요. 다음 생성부터 적용돼요.'
          : '저장했어요. 사용할 범위에 적용해 주세요.'
      );
      await refresh(true);
    }, !asCopy);
  }
  useSettingsSaveHandler(onSaveHandlerChange, () => save());
  function edit(preset?: IllustrationPreset, copy = false) {
    if (dirty) {
      setError('현재 편집을 저장하거나 닫은 뒤 다른 프리셋을 열어 주세요.');
      return;
    }
    resetEditorDetails();
    const isCopy = copy || !!preset?.id.startsWith('builtin:');
    const model = preset
      ? structuredClone(illustrationPresetDefinition(preset))
      : emptyIllustrationPreset();
    if (preset && isCopy) model.title = `${model.title.slice(0, 97)} 사본`;
    setDraft({
      id: preset && !isCopy ? preset.id : null,
      revision: preset && !isCopy ? preset.revision : undefined,
      model,
    });
    setBaseline(preset && !isCopy ? JSON.stringify(model) : '');
    setError('');
    setNotice('');
    setImportNotice('');
  }
  function patch(patch: Partial<IllustrationPresetDefinition>) {
    setDraft((current) =>
      current ? { ...current, model: { ...current.model, ...patch } } : current
    );
    setNotice('');
    setImportNotice('');
  }
  async function importFile(file: File) {
    if (dirty) {
      setError('현재 편집을 저장하거나 닫은 뒤 가져와 주세요.');
      return;
    }
    await action(async () => {
      if (file.size > ILLUSTRATION_PRESET_FILE_MAX_BYTES)
        throw new Error(uiMessage('visualpanels.importAnIllustrationPresetFileNoLarger'));
      const model = parseIllustrationPresetFile(JSON.parse(await file.text()));
      resetEditorDetails();
      setDraft({ id: null, model });
      setBaseline('');
      setImportNotice('가져왔어요. 내용을 확인한 뒤 저장해 주세요.');
    });
  }
  useEffect(() => {
    if (catalog) onGeneratorChange?.(resolveIllustrationPreset(catalog, scope).generator);
  }, [catalog, scope, onGeneratorChange]);
  if (!catalog)
    return (
      <section
        className="settings-loading-region"
        aria-label={t('visualpanels.illustrationPresets')}
      >
        <LoadingState
          presentation="region"
          loading={!loadError}
          error={translateMessage(loadError)}
          label={t('visualpanels.loadingIllustrationPresets')}
          onRetry={() => void refresh()}
          retryLabel={t('visualpanels.reloadPresets')}
        />
      </section>
    );
  const p = catalog.preferences;
  const selectedId =
    target === 'global'
      ? p.defaultPresetId
      : target === 'bot'
        ? p.botPresets[scope.botId ?? '']
        : p.chatPresets[scope.chatId ?? ''];
  const effective = resolveIllustrationPreset(catalog, scope);
  const modelRef =
    environment &&
    (effective.generator === 'codex' ? environment.codex.model : environment.comfyui.promptModel);
  const model = library.models.find((item) => item.id === modelRef?.id);
  const modelReady = !!model && isModelSelectable(model, library.models, library.connections);
  const codexConnection =
    model && library.connections.find((item) => item.id === model.connectionId);
  const readiness = !environment
    ? t('visualpanels.openTheDefaultGenerationEnvironmentToCheck')
    : !modelReady
      ? t('visualpanels.setupNeededSelectAModelAndEnable')
      : effective.generator === 'codex' && codexConnection?.protocol !== 'codex-app-server-v1'
        ? t('visualpanels.setupNeededSelectAModelFromA')
        : effective.generator === 'comfyui' && !environment.comfyui.baseUrl.trim()
          ? t('visualpanels.setupNeededEnterAComfyuiAddressIn')
          : effective.generator === 'comfyui' && !effective.comfyui.workflow.trim()
            ? t('visualpanels.setupNeededSaveAComfyuiWorkflowIn')
            : t('visualpanels.requiredSettingsCompleteConnectionAndLoginAre');
  const conflict =
    !!draft?.id &&
    !!catalog.presets.find((item) => item.id === draft.id && item.revision !== draft.revision);
  const deleted = !!draft?.id && !catalog.presets.some((item) => item.id === draft.id);
  const choose = (presetId: string | null) =>
    action(async () => {
      await api('/illustration-presets/selection', {
        scope: target,
        targetId: target === 'bot' ? scope.botId : target === 'chat' ? scope.chatId : undefined,
        presetId,
        expectedRevision: p.revision,
      });
      await refresh(true);
      setNotice('프리셋을 변경했어요. 다음 생성부터 적용돼요.');
    });
  return (
    <section
      className="illustration-preset-settings illustration-settings"
      aria-label={t('visualpanels.illustrationPresets')}
    >
      <section
        className="settings-card illustration-current-summary illustration-preset-current"
        aria-label={t('visualpanels.currentIllustrationSettings')}
      >
        <h3>{t('visualpanels.currentIllustrationSettings')}</h3>
        <p className="ui-meta-row">
          <span>
            {scope.chatId
              ? t('visualpanels.currentChat')
              : scope.botId
                ? t('visualpanels.currentBot')
                : t('visualpanels.workspaceDefault')}
          </span>
          <strong>
            {effective.id.startsWith('builtin:')
              ? translateMessage(effective.title)
              : effective.title}
          </strong>
        </p>
        <p>
          {t('visualpanels.generator', {
            v0: effective.generator === 'comfyui' ? 'ComfyUI' : 'Codex',
          })}
        </p>
        <p className="ui-meta-row">
          <span>
            {effective.generator === 'comfyui'
              ? t('visualpanels.promptModel')
              : t('visualpanels.illustrationModel')}
          </span>
          <span>
            {model?.title ??
              (environment ? t('visualpanels.noModelSelected') : t('visualpanels.checking'))}
          </span>
        </p>
        <p role="status">{readiness}</p>
      </section>
      <details className="illustration-preset-disclosure">
        <summary>{t('visualpanels.managePresetsAndScopes')}</summary>
        <div className="illustration-preset-heading">
          <div className="illustration-preset-list-actions">
            <button
              className="primary"
              aria-label={t('visualpanels.newIllustrationPreset')}
              disabled={busy || dirty}
              onClick={() => edit()}
            >
              <Plus size={16} aria-hidden="true" /> {t('visualpanels.newPreset')}{' '}
            </button>
            <button
              aria-label={t('visualpanels.importPreset')}
              disabled={busy || dirty}
              onClick={() => input.current?.click()}
            >
              <Upload size={16} aria-hidden="true" /> {t('visualpanels.import')}{' '}
            </button>
          </div>
        </div>
        <div className="illustration-preset-toolbar settings-group-body">
          <div className="settings-row">
            <div className="settings-row-copy">
              <span>{t('visualpanels.scope')}</span>
            </div>
            <div className="settings-row-control">
              <select
                aria-label={t('visualpanels.illustrationPresetScope')}
                value={target}
                disabled={busy || dirty}
                onChange={(event) => setTarget(event.target.value as typeof target)}
              >
                <option value="global">{t('visualpanels.workspaceDefault')}</option>
                {scope.botId && <option value="bot">{t('visualpanels.currentBotDefault')}</option>}
                {scope.chatId && <option value="chat">{t('visualpanels.thisChatOnly')}</option>}
              </select>
              {target !== 'global' && (
                <button disabled={busy || dirty || !selectedId} onClick={() => void choose(null)}>
                  <RotateCcw size={16} aria-hidden="true" />{' '}
                  {t('visualpanels.inheritParentSettings')}{' '}
                </button>
              )}
            </div>
          </div>
        </div>
        {(error || loadError) && (
          <NoticeBanner tone="error">{translateMessage(error || loadError)}</NoticeBanner>
        )}
        {loadError && (
          <button onClick={() => void refresh()}>
            <RefreshCw size={16} aria-hidden="true" /> {t('visualpanels.reload')}{' '}
          </button>
        )}
        <TransientNotice message={notice} />
        {importNotice && <NoticeBanner>{translateMessage(importNotice)}</NoticeBanner>}
        <div
          className="illustration-preset-grid"
          aria-label={t('visualpanels.savedIllustrationPresets')}
        >
          {catalog.presets.map((preset) => (
            <article
              className={`illustration-preset-card${selectedId === preset.id ? ' selected' : ''}`}
              key={preset.id}
            >
              <button
                className="illustration-preset-apply"
                aria-label={t('visualpanels.applyIllustrationPreset', {
                  v0: preset.id.startsWith('builtin:')
                    ? translateMessage(preset.title)
                    : preset.title,
                })}
                aria-pressed={selectedId === preset.id}
                disabled={busy || dirty}
                onClick={() => void choose(preset.id)}
              >
                <div className="illustration-preset-title">
                  <strong>
                    {preset.id.startsWith('builtin:')
                      ? translateMessage(preset.title)
                      : preset.title}
                  </strong>
                  {selectedId === preset.id && (
                    <span className="illustration-preset-selected">
                      <Check size={14} aria-hidden="true" /> {t('visualpanels.selected')}{' '}
                    </span>
                  )}
                </div>
                {(preset.id.startsWith('builtin:') || preset.description) && (
                  <span>
                    {preset.id.startsWith('builtin:')
                      ? t('visualpanels.drawsAccordingToTheSceneAndCharacters')
                      : preset.description}
                  </span>
                )}
                <small>
                  {preset.generator === 'codex'
                    ? t('visualpanels.codexSharedIllustrationModel')
                    : preset.comfyui.workflow.trim()
                      ? t('visualpanels.comfyuiWorkflowIncluded')
                      : t('visualpanels.comfyuiWorkflowSetupNeeded')}
                </small>
              </button>
              <div className="illustration-preset-actions">
                {preset.id.startsWith('builtin:') ? (
                  <button
                    disabled={busy || dirty}
                    aria-label={t('visualpanels.editIllustrationPreset', {
                      v0: preset.id.startsWith('builtin:')
                        ? translateMessage(preset.title)
                        : preset.title,
                    })}
                    title={t('visualpanels.duplicateAndEditIllustrationPreset', {
                      v0: preset.id.startsWith('builtin:')
                        ? translateMessage(preset.title)
                        : preset.title,
                    })}
                    onClick={() => edit(preset)}
                  >
                    <Copy size={16} aria-hidden="true" /> {t('visualpanels.duplicateAndEdit2')}{' '}
                  </button>
                ) : (
                  <IconButton
                    disabled={busy || dirty}
                    label={t('visualpanels.editIllustrationPreset', {
                      v0: preset.id.startsWith('builtin:')
                        ? translateMessage(preset.title)
                        : preset.title,
                    })}
                    icon={Pencil}
                    onClick={() => edit(preset)}
                  />
                )}
                <ActionMenu
                  label={t('visualpanels.presetMenu', {
                    v0: preset.id.startsWith('builtin:')
                      ? translateMessage(preset.title)
                      : preset.title,
                  })}
                  viewport
                >
                  <div className="action-menu-group">
                    {!preset.id.startsWith('builtin:') && (
                      <button
                        disabled={busy || dirty}
                        aria-label={t('visualpanels.duplicateIllustrationPreset', {
                          v0: preset.id.startsWith('builtin:')
                            ? translateMessage(preset.title)
                            : preset.title,
                        })}
                        onClick={() => edit(preset, true)}
                      >
                        <Copy size={16} aria-hidden="true" /> {t('visualpanels.duplicate2')}{' '}
                      </button>
                    )}
                    <button
                      disabled={busy}
                      aria-label={t('visualpanels.exportIllustrationPreset', {
                        v0: preset.id.startsWith('builtin:')
                          ? translateMessage(preset.title)
                          : preset.title,
                      })}
                      onClick={() => {
                        void action(async () =>
                          saveDownload(
                            `${preset.title}.uimori-illustration.json`,
                            illustrationPresetFile(preset)
                          )
                        );
                      }}
                    >
                      <Download size={16} aria-hidden="true" /> {t('visualpanels.export2')}{' '}
                    </button>
                  </div>
                  {!preset.id.startsWith('builtin:') && (
                    <div className="action-menu-group">
                      <button
                        disabled={busy || dirty}
                        className="danger"
                        aria-label={t('visualpanels.deleteIllustrationPreset', {
                          v0: preset.id.startsWith('builtin:')
                            ? translateMessage(preset.title)
                            : preset.title,
                        })}
                        onClick={() => {
                          setError('');
                          setDeleting(preset);
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" /> {t('visualpanels.delete2')}{' '}
                      </button>
                    </div>
                  )}
                </ActionMenu>
              </div>
            </article>
          ))}
        </div>
        <input
          ref={input}
          type="file"
          accept=".json"
          hidden
          aria-label={t('visualpanels.illustrationPresetFile')}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFile(file);
          }}
        />
        {draft && (
          <section
            ref={editor}
            className="settings-group illustration-preset-editor"
            aria-label={t('visualpanels.illustrationPresetEditor')}
          >
            <div className="illustration-preset-heading">
              <h4>{draft.id ? t('visualpanels.editPreset') : t('visualpanels.createPreset')}</h4>
              {dirty && <small>{t('visualpanels.unsavedChanges')}</small>}
            </div>
            {(conflict || deleted) && (
              <NoticeBanner tone="error">
                {t('visualpanels.yourEditsArePreservedSaveACopy', {
                  v0: deleted
                    ? t('visualpanels.thisPresetWasDeletedElsewhere')
                    : t('visualpanels.theSavedPresetChangedElsewhere'),
                })}
              </NoticeBanner>
            )}
            <fieldset
              className="control-grid settings-group-body illustration-preset-editor-body"
              disabled={busy}
            >
              <label className="full">
                {t('visualpanels.presetName')}{' '}
                <input
                  aria-label={t('visualpanels.illustrationPresetName')}
                  value={draft.model.title}
                  maxLength={100}
                  onChange={(event) => patch({ title: event.target.value })}
                />
              </label>
              <label className="full">
                {t('visualpanels.descriptionOptional')}{' '}
                <input
                  aria-label={t('visualpanels.illustrationPresetDescription')}
                  value={draft.model.description}
                  maxLength={2000}
                  onChange={(event) => patch({ description: event.target.value })}
                />
              </label>
              <label className="full">
                {t('visualpanels.generator2')}{' '}
                <select
                  aria-label={t('visualpanels.presetIllustrationGenerator')}
                  value={draft.model.generator}
                  onChange={(event) =>
                    patch({
                      generator: event.target.value as IllustrationPresetGenerator,
                    })
                  }
                >
                  <option value="codex">
                    {t('visualpanels.codexImageGenerationWithAChatgptSubscription')}
                  </option>
                  <option value="comfyui">{t('visualpanels.comfyuiRemotePcApi')}</option>
                </select>
                <small>{t('visualpanels.applyingAPresetUsesTheSharedConnection')}</small>
              </label>
              <label className="full">
                {t('visualpanels.illustrationInstructions')}{' '}
                <textarea
                  aria-label={t('visualpanels.illustrationStyleInstructions')}
                  aria-describedby={`${editorId}-style-help`}
                  className="illustration-style-guidance"
                  rows={8}
                  maxLength={SOURCE_TEXT_MAX_CHARS}
                  value={draft.model.styleGuidance}
                  placeholder={t('visualpanels.exampleCalmColorsSoftLightCleanLinework')}
                  onChange={(event) => patch({ styleGuidance: event.target.value })}
                />
                <small id={`${editorId}-style-help`}>
                  {t('visualpanels.describeTheStyleRenderingRequirementsAndThings')}
                </small>
              </label>
              <details className="full illustration-preset-disclosure">
                <summary>{t('visualpanels.writingExamples')}</summary>
                <div className="illustration-preset-help">
                  <p>{t('visualpanels.includeOnlyWhatYouNeedTheExamples')}</p>
                  <pre>{t('visualpanels.keyFeaturesCalmColorsSoftDirectionalLighting', {})}</pre>
                  <p>{t('visualpanels.theseInstructionsMayReduceArtifactsAndBloom')}</p>
                  <p>
                    <strong>{t('visualpanels.animaExample')}</strong>{' '}
                    {t('visualpanels.stateWhichModelAnyModelSpecificSyntax')}{' '}
                  </p>
                  <pre>{t('visualpanels.whenWritingPromptsForAnimaInComfyui', {})}</pre>
                  <p>{t('visualpanels.pasteOrdinaryStyleJsonIntoTheIllustration')}</p>
                </div>
              </details>
              {(draft.model.generator === 'comfyui' || workflowError) && (
                <details className="full illustration-preset-disclosure">
                  <summary>
                    {t('visualpanels.comfyuiSettings')}{' '}
                    <small>
                      {draft.model.comfyui.workflow.trim()
                        ? t('settings.workflowEntered')
                        : t('visualpanels.noWorkflow')}
                    </small>
                  </summary>
                  <fieldset className="control-grid">
                    <small className="full">
                      {draft.model.generator === 'comfyui'
                        ? t('settings.workflowCompatibility')
                        : t('visualpanels.codexDoesNotUseTheseSettingsWorkflow')}
                    </small>
                    <label className="full">
                      {t('visualpanels.additionalNegativeGuidance')}{' '}
                      <textarea
                        aria-label={t('visualpanels.comfyuiNegativePromptInstructions')}
                        aria-describedby={`${editorId}-negative-help`}
                        rows={3}
                        maxLength={SOURCE_TEXT_MAX_CHARS}
                        value={draft.model.comfyui.negativeGuidance}
                        onChange={(event) =>
                          patch({
                            comfyui: {
                              ...draft.model.comfyui,
                              negativeGuidance: event.target.value,
                            },
                          })
                        }
                      />
                      <small id={`${editorId}-negative-help`}>
                        {t('visualpanels.additionalThingsToAvoidBeyondTheIllustration', {
                          v0: '{{negative}}',
                        })}
                      </small>
                    </label>
                    <label className="full">
                      {t('visualpanels.workflowJsonApiFormat')}{' '}
                      <textarea
                        aria-label={t('visualpanels.comfyuiWorkflowJson')}
                        data-workflow-editor
                        aria-invalid={workflowError ? true : undefined}
                        aria-describedby={workflowError ? `${editorId}-workflow-error` : undefined}
                        rows={10}
                        maxLength={ILLUSTRATION_WORKFLOW_MAX_CHARS}
                        value={draft.model.comfyui.workflow}
                        placeholder={t('visualpanels.apiFormatJsonExportedFromComfyui')}
                        onChange={(event) => {
                          setWorkflowError('');
                          patch({
                            comfyui: {
                              ...draft.model.comfyui,
                              workflow: event.target.value,
                            },
                          });
                        }}
                      />
                      {workflowError && (
                        <small id={`${editorId}-workflow-error`} className="error">
                          {translateMessage(workflowError)}
                        </small>
                      )}
                    </label>
                    <details className="full">
                      <summary>{t('visualpanels.workflowAuthoringAndSharingHelp')}</summary>
                      <p>
                        {t('visualpanels.inStringInputsBecomesTheImageDescription', {
                          v0: '{{prompt}}',
                          v1: '{{negative}}',
                          v2: '{{seed}}',
                        })}
                      </p>
                      <p>{t('visualpanels.theReceivingComfyuiNeedsTheSameModels')}</p>
                    </details>
                  </fieldset>
                </details>
              )}
              <small className="full">
                {t('visualpanels.savedChangesApplyFromTheNextGeneration')}
              </small>
              <div className="illustration-preset-actions illustration-preset-editor-actions full">
                <SaveButton
                  type="button"
                  className="ui-icon-button"
                  label={t('visualpanels.savePreset')}
                  text=""
                  aria-busy={operation === 'save'}
                  disabled={!dirty || conflict || deleted}
                  onClick={() => void save()}
                />
                {draft.id && (
                  <button
                    className="illustration-preset-copy-save"
                    aria-label={t('visualpanels.saveAsCopy')}
                    title={t('visualpanels.saveAsCopy')}
                    onClick={() => void save(true)}
                  >
                    <Copy size={16} aria-hidden="true" /> {t('visualpanels.saveCopy')}{' '}
                  </button>
                )}
                <IconButton
                  label={t('visualpanels.closeEditor')}
                  icon={X}
                  onClick={() => {
                    if (dirty) setDiscard(true);
                    else setDraft(null);
                  }}
                />
              </div>
            </fieldset>
          </section>
        )}
      </details>
      <SaveConflictDialog
        open={saveConflict}
        title={t('visualpanels.reviewSavedIllustrationPreset')}
        onClose={() => setSaveConflict(false)}
        readSaved={async () => {
          const value = (
            await api<IllustrationPresetCatalog>('/illustration-presets')
          ).presets.find((preset) => preset.id === draft?.id);
          if (!value)
            throw new Error(uiMessage('visualpanels.savedVersionUnavailableYourCurrentInputIs'));
          return () => [
            { label: t('visualpanels.name'), value: value.title },
            {
              label: t('visualpanels.generator2'),
              value: value.generator === 'comfyui' ? 'ComfyUI' : 'Codex',
            },
            { label: t('visualpanels.description'), value: value.description },
            { label: t('visualpanels.illustrationInstructions'), value: value.styleGuidance },
          ];
        }}
      />
      <Dialog
        open={discard}
        title={t('visualpanels.closePresetEditor')}
        role="alertdialog"
        variant="confirmation"
        onClose={() => setDiscard(false)}
      >
        <p>{t('visualpanels.unsavedEditsWillBeLostTheSaved')}</p>
        <DraftDiscardActions
          open={discard}
          onContinue={() => setDiscard(false)}
          onDiscard={() => {
            setDraft(null);
            setDiscard(false);
            setError('');
          }}
          discardLabel={t('visualpanels.discardChangesAndClose')}
        />
      </Dialog>
      <Dialog
        open={!!deleting}
        title={t('visualpanels.deleteIllustrationPreset2')}
        role="alertdialog"
        variant="confirmation"
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
      >
        <p>{t('visualpanels.deletePresetBotsAndChatsUsingIt', { v0: deleting?.title ?? '' })}</p>
        <p>{t('visualpanels.theNextGenerationUsesTheReplacementPreset')}</p>
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
        <div className="form-actions">
          <button autoFocus disabled={busy} onClick={() => setDeleting(null)}>
            {t('visualpanels.cancel')}
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (deleting)
                void action(async () => {
                  await api(
                    `/illustration-presets/${encodeURIComponent(deleting.id)}`,
                    { expectedRevision: deleting.revision },
                    'DELETE'
                  );
                  if (draft?.id === deleting.id) setDraft(null);
                  setDeleting(null);
                  await refresh(true);
                  setNotice('프리셋을 삭제했어요.');
                });
            }}
          >
            {t('visualpanels.deletePreset')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
