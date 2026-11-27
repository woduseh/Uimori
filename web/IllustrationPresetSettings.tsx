import { t, useI18n } from './i18n.js';
import { copiedTitle } from './copy-title.js';
import { UiError, formatUiMessage, uiMessage, type UiMessage } from './ui-message.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Plus, Upload, Download, Copy, Trash2, Check, Pencil, RotateCcw, X } from 'lucide-react';
import {
  emptyIllustrationPreset,
  illustrationPresetDefinition,
  illustrationPresetFile,
  parseIllustrationPresetFile,
  resolveIllustrationPreset,
  validateIllustrationPreset,
  ILLUSTRATION_PRESET_FILE_MAX_BYTES,
  ILLUSTRATION_PRESET_TITLE_MAX_CHARS,
  ILLUSTRATION_WORKFLOW_MAX_CHARS,
  type IllustrationPreset,
  type IllustrationPresetCatalog,
  type IllustrationPresetDefinition,
  type IllustrationPresetScope,
  type IllustrationPresetGenerator,
} from '../core/illustration-presets.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { Library } from '../core/product.js';
import type { IllustrationSettingsView } from '../core/illustration.js';
import { isModelSelectable } from './model-selection.js';
import { resourceEditorEndpoints } from '#contracts';
import { api, ApiError, callEndpoint, saveDownload } from './api.js';
import { toUiMessage } from './api-errors.js';
import { IllustrationError } from '../core/illustration-errors.js';
import { ValidationError } from '../core/validation-error.js';
import { Dialog } from './Dialog.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { illustrationErrorUiMessage, illustrationGeneratorLabels } from './illustration-labels.js';
import { illustrationPresetText, illustrationPresetTitle } from './builtin-labels.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import './illustration-presets.css';
import './settings-layout.css';
import { presentationFrame } from './live-frames.js';
import { watchLive } from './live-stream.js';
import { parseJsonInput } from './json-input.js';

type Draft = {
  id: string | null;
  revision?: number;
  model: IllustrationPresetDefinition;
};
const localizedDefinition = (preset: IllustrationPreset): IllustrationPresetDefinition => ({
  ...illustrationPresetDefinition(preset),
  ...illustrationPresetText(preset),
});
const messageOf = (error: unknown): UiMessage =>
  error instanceof IllustrationError ? illustrationErrorUiMessage(error.code) : toUiMessage(error);
const isWorkflowError = (error: unknown) =>
  error instanceof IllustrationError
    ? error.code.startsWith('COMFYUI_WORKFLOW_')
    : error instanceof ValidationError &&
      error.code === 'ILLUSTRATION_PRESET_FIELD_TOO_LONG' &&
      (error.params as { field: string }).field === 'comfyui.workflow';
export function IllustrationPresetSettings({
  library,
  environment,
  scope,
  onDirtyChange,
  onSaveHandlerChange,
  onGeneratorChange,
}: {
  library: Library;
  environment: IllustrationSettingsView | null;
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
  const [error, setError] = useState<UiMessage | null>(null);
  const [loadError, setLoadError] = useState<UiMessage | null>(null);
  const [notice, setNotice] = useState<UiMessage | null>(null);
  const [importNotice, setImportNotice] = useState<UiMessage | null>(null);
  const [deleting, setDeleting] = useState<IllustrationPreset | null>(null);
  const [discard, setDiscard] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLElement>(null);
  const [workflowError, setWorkflowError] = useState<UiMessage | null>(null);
  const editorId = useId();
  function resetEditorDetails() {
    setWorkflowError(null);
    editor.current?.querySelectorAll('details').forEach((details) => {
      details.open = false;
    });
  }
  const locked = useRef(false);
  const alive = useRef(true);
  const epoch = useRef(0);
  const dirty = !!draft && JSON.stringify(draft.model) !== baseline;
  const refresh = useCallback(async () => {
    const version = ++epoch.current;
    try {
      const next = await api<IllustrationPresetCatalog>('/illustration-presets');
      if (alive.current && version === epoch.current) {
        setCatalog(next);
        setLoadError(null);
      }
    } catch (cause) {
      if (alive.current && version === epoch.current) setLoadError(messageOf(cause));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const live = watchLive({ match: presentationFrame('illustration-presets'), refresh });
    return () => {
      alive.current = false;
      epoch.current++;
      live.dispose();
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
    setError(null);
    setNotice(null);
    setImportNotice(null);
    try {
      await work();
      return true;
    } catch (cause) {
      setError(messageOf(cause));
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
    setWorkflowError(null);
    setError(null);
    setNotice(null);
    setImportNotice(null);
    let model: IllustrationPresetDefinition;
    try {
      model = validateIllustrationPreset(
        asCopy
          ? {
              ...draft.model,
              title: copiedTitle(draft.model.title, ILLUSTRATION_PRESET_TITLE_MAX_CHARS),
            }
          : draft.model
      );
    } catch (cause) {
      const failure = messageOf(cause);
      setError(failure);
      if (isWorkflowError(cause)) {
        setWorkflowError(failure);
        requestAnimationFrame(() => {
          editor.current?.querySelector<HTMLTextAreaElement>('[data-workflow-editor]')?.focus();
        });
      }
      return false;
    }
    return action(async () => {
      const result = await callEndpoint(resourceEditorEndpoints.saveResource, {
        kind: 'illustration-preset',
        id: asCopy ? null : draft.id,
        expectedRevision: asCopy ? undefined : draft.revision,
        model,
      });
      const saved = result.saved as IllustrationPreset;
      const accepted = illustrationPresetDefinition(saved);
      setDraft({ id: saved.id, revision: saved.revision, model: accepted });
      setBaseline(JSON.stringify(accepted));
      setNotice(
        draft.id && !asCopy
          ? uiMessage('visualpanels.savedAppliesFromTheNextGeneration')
          : uiMessage('visualpanels.savedApplyItToTheScopeYou')
      );
      await refresh();
    }, !asCopy);
  }
  useSettingsSaveHandler(onSaveHandlerChange, () => save());
  function edit(preset?: IllustrationPreset, copy = false) {
    if (dirty) {
      setError(uiMessage('visualpanels.saveOrCloseYourCurrentEditsBefore'));
      return;
    }
    resetEditorDetails();
    const isCopy = copy || !!preset?.id.startsWith('builtin:');
    const model = preset
      ? structuredClone(localizedDefinition(preset))
      : emptyIllustrationPreset(t('visualpanels.newIllustrationPreset'));
    if (preset && isCopy)
      model.title = copiedTitle(model.title, ILLUSTRATION_PRESET_TITLE_MAX_CHARS);
    setDraft({
      id: preset && !isCopy ? preset.id : null,
      revision: preset && !isCopy ? preset.revision : undefined,
      model,
    });
    setBaseline(preset && !isCopy ? JSON.stringify(model) : '');
    setError(null);
    setNotice(null);
    setImportNotice(null);
  }
  function patch(patch: Partial<IllustrationPresetDefinition>) {
    setDraft((current) =>
      current ? { ...current, model: { ...current.model, ...patch } } : current
    );
    setNotice(null);
    setImportNotice(null);
  }
  async function importFile(file: File) {
    if (dirty) {
      setError(uiMessage('visualpanels.saveOrCloseYourCurrentEditsBefore2'));
      return;
    }
    await action(async () => {
      if (file.size > ILLUSTRATION_PRESET_FILE_MAX_BYTES)
        throw new UiError(uiMessage('visualpanels.importAnIllustrationPresetFileNoLarger'));
      const model = parseIllustrationPresetFile(
        parseJsonInput(await file.text(), 'errors.ILLUSTRATION_PRESET_FILE_UNSUPPORTED')
      );
      resetEditorDetails();
      setDraft({ id: null, model });
      setBaseline('');
      setImportNotice(uiMessage('visualpanels.importedReviewTheContentAndSaveIt'));
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
          error={loadError}
          label={uiMessage('visualpanels.loadingIllustrationPresets')}
          onRetry={() => void refresh()}
          retryLabel={uiMessage('visualpanels.reloadPresets')}
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
    (effective.generator === 'codex'
      ? environment.codex.model
      : effective.generator === 'novelai'
        ? environment.novelai.promptModel
        : environment.comfyui.promptModel);
  const model = library.models.find((item) => item.id === modelRef?.id);
  const promptModelRef = effective.generator === 'codex' ? environment?.codex.promptModel : null;
  const promptModel = library.models.find((item) => item.id === promptModelRef?.id);
  const modelReady = !!model && isModelSelectable(model, library.models, library.connections);
  const promptModelReady =
    effective.generator !== 'codex' ||
    (!!promptModel && isModelSelectable(promptModel, library.models, library.connections));
  const codexConnection =
    model && library.connections.find((item) => item.id === model.connectionId);
  const readiness = !environment
    ? ''
    : !modelReady
      ? t('visualpanels.setupNeededSelectAModelAndEnable')
      : !promptModelReady
        ? t('visualpanels.setupNeededSelectPromptModel')
        : effective.generator === 'codex' && codexConnection?.protocol !== 'codex-app-server-v1'
          ? t('visualpanels.setupNeededSelectAModelFromA')
          : effective.generator === 'comfyui' && !environment.comfyui.baseUrl.trim()
            ? t('visualpanels.setupNeededEnterAComfyuiAddressIn')
            : effective.generator === 'comfyui' && !effective.comfyui.workflow.trim()
              ? t('visualpanels.setupNeededSaveAComfyuiWorkflowIn')
              : effective.generator === 'novelai' && !environment.novelaiTokenConfigured
                ? t('visuals.novelaiTokenMissing')
                : '';
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
      await refresh();
      setNotice(uiMessage('visualpanels.presetChangedAppliesFromTheNextGeneration'));
    });
  return (
    <section
      className="illustration-preset-settings illustration-settings"
      aria-label={t('visualpanels.illustrationPresets')}
    >
      <div className="illustration-preset-heading">
        <h3>{t('visualpanels.managePresetsAndScopes')}</h3>
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
            {effective.id !== selectedId && (
              <small className="illustration-preset-effective">
                {t('visualpanels.effectivePreset', {
                  v0: illustrationPresetTitle(effective),
                })}
              </small>
            )}
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
                <RotateCcw size={16} aria-hidden="true" /> {t(
                  'visualpanels.inheritParentSettings'
                )}{' '}
              </button>
            )}
          </div>
        </div>
      </div>
      {readiness && <NoticeBanner>{readiness}</NoticeBanner>}
      {(error || loadError) && (
        <NoticeBanner
          tone="error"
          actions={
            loadError ? (
              <button type="button" className="secondary" onClick={() => void refresh()}>
                {t('shared.retry')}
              </button>
            ) : undefined
          }
        >
          {formatUiMessage((error ?? loadError)!)}
        </NoticeBanner>
      )}
      <TransientNotice content={notice} />
      {importNotice && <NoticeBanner>{importNotice}</NoticeBanner>}
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
                v0: illustrationPresetTitle(preset),
              })}
              aria-pressed={selectedId === preset.id}
              disabled={busy || dirty}
              onClick={() => void choose(preset.id)}
            >
              <div className="illustration-preset-title">
                <strong>{illustrationPresetTitle(preset)}</strong>
                {selectedId === preset.id && (
                  <span className="illustration-preset-selected">
                    <Check size={14} aria-hidden="true" /> {t('visualpanels.selected')}{' '}
                  </span>
                )}
              </div>
              {!preset.id.startsWith('builtin:') && preset.description && (
                <span>{preset.description}</span>
              )}
              <small>
                {preset.generator === 'codex'
                  ? t('visualpanels.codexSharedIllustrationModel')
                  : preset.generator === 'novelai'
                    ? t('visualpanels.novelaiSharedEnvironment')
                    : preset.comfyui.workflow.trim()
                      ? t('visualpanels.comfyuiWorkflowIncluded')
                      : t('visualpanels.comfyuiWorkflowSetupNeeded')}
              </small>
            </button>
            <div className="illustration-preset-actions">
              <IconButton
                className="secondary"
                disabled={busy || dirty}
                size={18}
                label={t('visualpanels.editIllustrationPreset', {
                  v0: illustrationPresetTitle(preset),
                })}
                title={
                  preset.id.startsWith('builtin:')
                    ? t('visualpanels.duplicateAndEditIllustrationPreset', {
                        v0: illustrationPresetTitle(preset),
                      })
                    : undefined
                }
                icon={preset.id.startsWith('builtin:') ? Copy : Pencil}
                onClick={() => edit(preset)}
              />
              <ActionMenu
                label={t('visualpanels.presetMenu', {
                  v0: illustrationPresetTitle(preset),
                })}
                viewport
              >
                <div className="action-menu-group">
                  {!preset.id.startsWith('builtin:') && (
                    <button
                      disabled={busy || dirty}
                      aria-label={t('visualpanels.duplicateIllustrationPreset', {
                        v0: illustrationPresetTitle(preset),
                      })}
                      onClick={() => edit(preset, true)}
                    >
                      <Copy size={16} aria-hidden="true" /> {t('visualpanels.duplicate2')}{' '}
                    </button>
                  )}
                  <button
                    disabled={busy}
                    aria-label={t('visualpanels.exportIllustrationPreset', {
                      v0: illustrationPresetTitle(preset),
                    })}
                    onClick={() => {
                      void action(async () =>
                        saveDownload(
                          `${illustrationPresetTitle(preset)}.uimori-illustration.json`,
                          illustrationPresetFile(localizedDefinition(preset))
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
                        v0: illustrationPresetTitle(preset),
                      })}
                      onClick={() => {
                        setError(null);
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
                <option value="novelai">{t('visualpanels.novelaiPersistentToken')}</option>
              </select>
            </label>
            <label className="full">
              {t('visualpanels.illustrationInstructions')}{' '}
              <textarea
                aria-label={t('visualpanels.illustrationStyleInstructions')}
                className="illustration-style-guidance"
                rows={8}
                maxLength={SOURCE_TEXT_MAX_CHARS}
                value={draft.model.styleGuidance}
                placeholder={t('visualpanels.exampleCalmColorsSoftLightCleanLinework')}
                onChange={(event) => patch({ styleGuidance: event.target.value })}
              />
            </label>
            <details className="full illustration-preset-disclosure">
              <summary>{t('visualpanels.writingExamples')}</summary>
              <div className="illustration-preset-help">
                <pre>{t('visualpanels.keyFeaturesCalmColorsSoftDirectionalLighting', {})}</pre>
                <p>
                  <strong>{t('visualpanels.animaExample')}</strong>{' '}
                </p>
                <pre>{t('visualpanels.whenWritingPromptsForAnimaInComfyui', {})}</pre>
              </div>
            </details>
            {draft.model.generator === 'novelai' && (
              <fieldset
                className="full control-grid illustration-preset-novelai"
                aria-label={t('visualpanels.novelaiSettings')}
              >
                <label className="full">
                  {t('visualpanels.additionalNegativeGuidance')}{' '}
                  <textarea
                    aria-label={t('visualpanels.novelaiNegativePromptInstructions')}
                    rows={3}
                    maxLength={SOURCE_TEXT_MAX_CHARS}
                    value={draft.model.novelai.negativeGuidance}
                    onChange={(event) =>
                      patch({ novelai: { negativeGuidance: event.target.value } })
                    }
                  />
                </label>
              </fieldset>
            )}
            {(draft.model.generator === 'comfyui' || workflowError) && (
              <fieldset
                className="full control-grid illustration-preset-comfyui"
                aria-label={t('visualpanels.comfyuiSettings')}
              >
                <label className="full">
                  {t('visualpanels.additionalNegativeGuidance')}{' '}
                  <textarea
                    aria-label={t('visualpanels.comfyuiNegativePromptInstructions')}
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
                      setWorkflowError(null);
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
                      {formatUiMessage(workflowError)}
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
            )}
            <div className="illustration-preset-actions illustration-preset-editor-actions full">
              <SaveButton
                type="button"
                label={t('visualpanels.savePreset')}
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
      <SaveConflictDialog
        open={saveConflict}
        title={t('visualpanels.reviewSavedIllustrationPreset')}
        onClose={() => setSaveConflict(false)}
        readSaved={async () => {
          const value = (
            await api<IllustrationPresetCatalog>('/illustration-presets')
          ).presets.find((preset) => preset.id === draft?.id);
          if (!value)
            throw new UiError(uiMessage('visualpanels.savedVersionUnavailableYourCurrentInputIs'));
          return () => [
            { label: t('visualpanels.name'), value: value.title },
            {
              label: t('visualpanels.generator2'),
              value: illustrationGeneratorLabels[value.generator],
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
            setError(null);
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
        {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
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
                  await refresh();
                  setNotice(uiMessage('visualpanels.presetDeleted'));
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
