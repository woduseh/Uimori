import { t, translateMessage, useI18n, getLocale, message as legacyDescriptor } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { useEffect, useId, useRef, useState } from 'react';
import type { Library, ModelRef, ModelWorkspace } from '../core/product.js';
import {
  DEFAULT_HELPER_TASK_TIMEOUT_MINUTES,
  MAX_HELPER_TASK_TIMEOUT_MINUTES,
} from '../core/helper.js';
import {
  DEFAULT_JUDGMENT_SELECTION,
  OFFICIAL_JUDGMENT_MODELS,
  isJudgmentConnection,
  judgmentPriceFor,
  judgmentPriceKey,
  judgmentPriceTarget,
  type JudgmentPriceEntry,
  type JudgmentPriceTarget,
  type JudgmentSelection,
} from '../core/judgment-settings.js';
import {
  DEFAULT_SUMMARY_LENGTH,
  SUMMARY_LENGTH_VALUES,
  type SummaryLength,
} from '../core/summary-length.js';
import { promptEndpoints } from '#contracts';
import { ApiError, callEndpoint } from './api.js';
import { MAX_TRANSLATION_PREVIOUS_SCENE_TOKENS } from '../core/translation-settings.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { useModelSelection } from './model-selection.js';
import { EditIcon, RefreshIcon, SettingsIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { Switch } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { JudgmentPricingEditor, judgmentPricingPayload } from './ModelPricingEditor.js';
import { pricingDraft, type ModelDraft } from './provider-model-draft.js';
import './settings-actions.css';

type PriceDraft = { target: JudgmentPriceTarget; draft: ModelDraft['pricing'] };
type EditableWorkspace = ModelWorkspace & { judgmentPriceDrafts: Record<string, PriceDraft> };
const editable = (workspace: ModelWorkspace): EditableWorkspace => ({
  ...workspace,
  judgmentPriceDrafts: Object.fromEntries(
    (workspace.judgmentPricing ?? []).map(({ pricing, ...target }) => [
      judgmentPriceKey(target),
      { target, draft: pricingDraft(pricing) },
    ])
  ),
});
function judgmentPricesPayload(
  workspace: EditableWorkspace,
  currentKey: string
): JudgmentPriceEntry[] | null {
  const entries: JudgmentPriceEntry[] = [];
  for (const [key, { target, draft }] of Object.entries(workspace.judgmentPriceDrafts)) {
    const payload = judgmentPricingPayload(target.provider, draft);
    const pricing =
      payload === null ? judgmentPriceFor(workspace.judgmentPricing, target) : payload.pricing;
    if (payload === null && key === currentKey) return null;
    if (pricing) entries.push({ ...target, pricing });
  }
  return entries;
}

const judgmentProviderNames: Record<string, string> = {
  typesafe: 'TypeSafe AI / JEV',
  openai: 'OpenAI Decisions',
  gemini: 'Gemini Decisions',
};

export function ModelWorkspaceEditor({
  library,
  onDirtyChange,
  onSaveHandlerChange,
  onManage,
  onEditModel,
}: {
  library: Library;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onManage: () => void;
  onEditModel: (id: string) => void;
}) {
  useI18n();
  const { workspace, error, refresh } = usePromptWorkspace();
  const id = useId();
  const [draft, setDraft] = useState<EditableWorkspace | null>(null);
  const [dirty, setDirty] = useState(false);
  const [judgmentEdited, setJudgmentEdited] = useState(false);
  const [operation, setOperation] = useState<'save' | 'reload' | null>(null);
  const busy = operation !== null;
  const lock = useRef(false);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saveConflict, setSaveConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloadError, setReloadError] = useState('');
  const { canSelect, choices } = useModelSelection(library.models, library.connections);
  useEffect(() => {
    if (workspace && !dirty && !busy)
      setDraft((current) =>
        current && current.revision > workspace.revision
          ? current
          : editable({
              revision: workspace.revision,
              judgment: workspace.judgment ?? DEFAULT_JUDGMENT_SELECTION,
              judgmentPricing: workspace.judgmentPricing ?? [],
              summaryLength: workspace.summaryLength ?? DEFAULT_SUMMARY_LENGTH,
              titleModel: workspace.titleModel ?? null,
              helperModel: workspace.helperModel ?? null,
              helperTaskTimeoutMinutes: workspace.helperTaskTimeoutMinutes,
              helperConfirmPaidGeneration: workspace.helperConfirmPaidGeneration === true,
              contextModel: workspace.contextModel ?? null,
              scriptModel: workspace.scriptModel ?? null,
              routes: workspace.modelRoutes,
              mainJudgmentEnabled: workspace.mainJudgmentEnabled === true,
              mainJudgmentThreshold: workspace.mainJudgmentThreshold ?? 0.9,
              translationPolicy: workspace.translationPolicy,
            })
      );
  }, [workspace, dirty, busy]);
  useEffect(() => {
    onDirtyChange(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, async () => (!draft ? false : save()));
  if (!draft)
    return (
      <LoadingState
        presentation="region"
        loading={!error}
        error={translateMessage(error)}
        label={t('settings.m0')}
        onRetry={() => void refresh()}
      />
    );
  const conflict = !!workspace && workspace.revision > draft.revision;
  const judgment = draft.judgment ?? DEFAULT_JUDGMENT_SELECTION;
  const priceTarget = judgmentPriceTarget(judgment);
  const priceKey = judgmentPriceKey(priceTarget);
  const judgmentPrices = judgmentPricesPayload(draft, priceKey);
  const compatible =
    judgment.provider === 'openai-compatible' || judgment.provider === 'typesafe-compatible';
  const judgmentConnections =
    judgment.provider === 'typesafe'
      ? []
      : library.connections.filter((connection) =>
          isJudgmentConnection(judgment.provider, connection)
        );
  const judgmentConnection =
    judgment.provider === 'typesafe'
      ? undefined
      : judgmentConnections.find((connection) => connection.id === judgment.connectionId);
  const helperTaskTimeoutMinutes =
    draft.helperTaskTimeoutMinutes ?? DEFAULT_HELPER_TASK_TIMEOUT_MINUTES;
  const invalidHelperTaskTimeout =
    !Number.isInteger(helperTaskTimeoutMinutes) ||
    helperTaskTimeoutMinutes < 1 ||
    helperTaskTimeoutMinutes > MAX_HELPER_TASK_TIMEOUT_MINUTES;
  const previousSceneTokens = draft.translationPolicy.previousSceneTokens;
  const invalidPreviousSceneTokens =
    previousSceneTokens !== undefined &&
    (!Number.isInteger(previousSceneTokens) ||
      previousSceneTokens < 0 ||
      previousSceneTokens > MAX_TRANSLATION_PREVIOUS_SCENE_TOKENS);
  const retryProviderRefusal =
    draft.translationPolicy.retryProviderRefusal ??
    draft.translationPolicy.judgment.enabled !== false;
  const translationJudgmentEnabled = draft.translationPolicy.judgment.enabled !== false;
  const invalidMainThreshold =
    !Number.isFinite(draft.mainJudgmentThreshold) ||
    (draft.mainJudgmentThreshold ?? 0.9) <= 0.5 ||
    (draft.mainJudgmentThreshold ?? 0.9) > 1;
  const invalidTranslationThreshold =
    !Number.isFinite(draft.translationPolicy.judgment.threshold) ||
    draft.translationPolicy.judgment.threshold <= 0.5 ||
    draft.translationPolicy.judgment.threshold > 1;
  const invalidMaxCalls =
    !Number.isInteger(draft.translationPolicy.maxCalls) ||
    draft.translationPolicy.maxCalls < 2 ||
    draft.translationPolicy.maxCalls > 64;
  const invalidRetries =
    !Number.isInteger(draft.translationPolicy.maxRetries) ||
    draft.translationPolicy.maxRetries < 0 ||
    draft.translationPolicy.maxRetries > 5;
  const invalid =
    invalidHelperTaskTimeout ||
    invalidPreviousSceneTokens ||
    judgmentPrices === null ||
    (judgmentEdited &&
      judgment.provider !== 'typesafe' &&
      (!judgmentConnection || !judgment.modelId.trim())) ||
    invalidMainThreshold ||
    invalidRetries ||
    invalidMaxCalls ||
    invalidTranslationThreshold;
  async function save() {
    if (!draft || lock.current || invalid) return false;
    if (conflict) {
      setSaveConflict(true);
      return false;
    }
    if (!dirty) return true;
    lock.current = true;
    setOperation('save');
    setSaveError('');
    setMessage('');
    return callEndpoint(promptEndpoints.updateModelWorkspace, {
      expectedRevision: draft.revision,
      routes: draft.routes,
      judgment,
      judgmentPricing: judgmentPrices ?? [],
      mainJudgmentEnabled: draft.mainJudgmentEnabled === true,
      mainJudgmentThreshold: draft.mainJudgmentThreshold,
      titleModel: draft.titleModel ?? null,
      helperModel: draft.helperModel ?? null,
      helperTaskTimeoutMinutes,
      helperConfirmPaidGeneration: draft.helperConfirmPaidGeneration === true,
      contextModel: draft.contextModel ?? null,
      summaryLength: draft.summaryLength ?? DEFAULT_SUMMARY_LENGTH,
      scriptModel: draft.scriptModel ?? null,
      translationPolicy: draft.translationPolicy,
    })
      .then((accepted) => {
        setDraft(editable(accepted as ModelWorkspace));
        setJudgmentEdited(false);
        setDirty(false);
        setMessage(legacyDescriptor('settings.m1'));
        void refresh();
        return true;
      })
      .catch((caught: Error) => {
        setSaveError(caught.message);
        if (caught instanceof ApiError && caught.status === 409) setSaveConflict(true);
        return false;
      })
      .finally(() => {
        lock.current = false;
        setOperation(null);
      });
  }
  function change(next: EditableWorkspace) {
    setDraft(next);
    setDirty(true);
    setMessage('');
  }
  function changeJudgment(next: JudgmentSelection) {
    if (!draft) return;
    setJudgmentEdited(true);
    change({ ...draft, judgment: next });
  }
  async function reload() {
    if (lock.current) return;
    lock.current = true;
    setOperation('reload');
    setReloadError('');
    try {
      const accepted = (await callEndpoint(promptEndpoints.readModelWorkspace)) as ModelWorkspace;
      setDraft(editable(accepted));
      setJudgmentEdited(false);
      setDirty(false);
      setSaveError('');
      setMessage('');
      setConfirmReload(false);
      void refresh();
    } catch {
      setReloadError(legacyDescriptor('settings.m2'));
    } finally {
      lock.current = false;
      setOperation(null);
    }
  }
  const selector = (
    role: string,
    label: string,
    selected: ModelRef | null,
    onChange: (ref: ModelRef | null) => void
  ) => {
    const model = library.models.find((item) => item.id === selected?.id);
    const displayLabel = label;
    const fieldId = `${id}-model-${role}`;
    return (
      <div className="settings-row model-role-setting">
        <div className="settings-row-copy">
          <label htmlFor={fieldId}>{displayLabel}</label>
          {selected && (!model || !canSelect(model)) && (
            <small role="status">{t('settings.m5')}</small>
          )}
        </div>
        <div className="settings-row-control">
          <select
            id={fieldId}
            aria-label={role === 'main' ? t('settings.m3') : label}
            value={selected?.id ?? ''}
            onChange={(event) => onChange(event.target.value ? { id: event.target.value } : null)}
          >
            <option value="">{t('settings.m6')}</option>
            {selected && !model && <option value={selected.id}>{t('settings.m7')}</option>}
            {library.models
              .filter((item) => canSelect(item) || item.id === selected?.id)
              .map((item) => (
                <option key={item.id} value={item.id} disabled={!canSelect(item)}>
                  {item.title} (
                  {canSelect(item)
                    ? library.connections.find((connection) => connection.id === item.connectionId)
                        ?.title
                    : t('settings.m8')}
                  )
                </option>
              ))}
          </select>
          {model && (
            <IconButton
              icon={EditIcon}
              label={t('settings.m9', { v0: displayLabel })}
              className="secondary"
              onClick={() => onEditModel(model.id)}
            />
          )}
        </div>
      </div>
    );
  };
  const judgmentProviderName = compatible
    ? t('settings.judgmentCompatible')
    : judgmentProviderNames[judgment.provider];
  const enabledJudgments =
    Number(draft.mainJudgmentEnabled === true) + Number(translationJudgmentEnabled);
  return (
    <section aria-label={t('settings.m13')} className="settings-section model-workspace-settings">
      <fieldset disabled={busy} className="control-grid model-workspace-controls">
        <fieldset className="settings-group full model-primary-settings">
          <legend className="sr-only">{t('settings.m15')}</legend>
          <div className="settings-group-body">
            {selector('main', t('settings.m4'), draft.routes.main, (ref) =>
              change({ ...draft, routes: { ...draft.routes, main: ref } })
            )}
            {selector('translation', t('settings.m16'), draft.routes.translation, (ref) =>
              change({ ...draft, routes: { ...draft.routes, translation: ref } })
            )}
            {choices.length === 0 && (
              <div className="settings-row model-setup-prompt">
                <div className="settings-row-copy">
                  <small>{t('settings.m17')}</small>
                </div>
                <div className="settings-row-control">
                  <button type="button" className="secondary" onClick={onManage}>
                    <SettingsIcon size={18} aria-hidden="true" />
                    {t('settings.m18')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </fieldset>
        <fieldset className="settings-group full model-primary-settings">
          <legend>{t('settings.m19')}</legend>
          <div className="settings-group-body">
            {selector('helper', t('settings.m20'), draft.helperModel ?? null, (ref) =>
              change({ ...draft, helperModel: ref })
            )}
            <div className="settings-row">
              <div className="settings-row-copy">
                <label htmlFor={`${id}-helper-task-timeout`}>
                  {t('settings.helperTaskTimeout')}
                </label>
                {invalidHelperTaskTimeout && (
                  <small id={`${id}-helper-task-timeout-hint`}>
                    {t('settings.helperTaskTimeoutRange', { max: MAX_HELPER_TASK_TIMEOUT_MINUTES })}
                  </small>
                )}
              </div>
              <div className="settings-row-control">
                <input
                  id={`${id}-helper-task-timeout`}
                  aria-describedby={
                    invalidHelperTaskTimeout ? `${id}-helper-task-timeout-hint` : undefined
                  }
                  aria-invalid={invalidHelperTaskTimeout || undefined}
                  type="number"
                  min={1}
                  max={MAX_HELPER_TASK_TIMEOUT_MINUTES}
                  value={Number.isNaN(helperTaskTimeoutMinutes) ? '' : helperTaskTimeoutMinutes}
                  onChange={(event) =>
                    change({ ...draft, helperTaskTimeoutMinutes: event.target.valueAsNumber })
                  }
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <label htmlFor={`${id}-helper-paid-confirmation`}>
                  {t('settings.helperConfirmPaidGeneration')}
                </label>
                <small>{t('settings.helperConfirmPaidGenerationHint')}</small>
              </div>
              <div className="settings-row-control">
                <Switch
                  id={`${id}-helper-paid-confirmation`}
                  checked={draft.helperConfirmPaidGeneration === true}
                  onChange={(event) =>
                    change({ ...draft, helperConfirmPaidGeneration: event.target.checked })
                  }
                />
              </div>
            </div>
            {selector('context', t('settings.m22'), draft.contextModel ?? null, (ref) =>
              change({ ...draft, contextModel: ref })
            )}
            {(['conversation', 'helper'] as const).map((role) => {
              const label = role === 'conversation' ? t('settings.m24') : t('settings.m25');
              const selected = (draft.summaryLength ?? DEFAULT_SUMMARY_LENGTH)[role];
              return (
                <div key={role} className="settings-row">
                  <div className="settings-row-copy">
                    <label htmlFor={`${id}-summary-${role}`}>{label}</label>
                  </div>
                  <div className="settings-row-control">
                    <select
                      id={`${id}-summary-${role}`}
                      aria-label={label}
                      value={String(selected)}
                      onChange={(event) => {
                        const value: SummaryLength =
                          event.target.value === 'auto'
                            ? 'auto'
                            : (Number(event.target.value) as Exclude<SummaryLength, 'auto'>);
                        change({
                          ...draft,
                          summaryLength: {
                            ...(draft.summaryLength ?? DEFAULT_SUMMARY_LENGTH),
                            [role]: value,
                          },
                        });
                      }}
                    >
                      {SUMMARY_LENGTH_VALUES.map((value) => (
                        <option key={value} value={value}>
                          {value === 'auto'
                            ? t('settings.m26')
                            : t('settings.m27', { v0: value.toLocaleString(getLocale()) })}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
            {selector('title', t('settings.m30'), draft.titleModel ?? null, (ref) =>
              change({ ...draft, titleModel: ref })
            )}
            {selector('script', t('settings.m34'), draft.scriptModel ?? null, (ref) =>
              change({ ...draft, scriptModel: ref })
            )}
          </div>
        </fieldset>
        <details className="settings-group full model-secondary-settings task-behavior-settings">
          <summary className="settings-group-heading">
            {t('settings.m36')}
            <small>
              {t('settings.flow0', {
                v0: Number.isFinite(draft.translationPolicy.maxCalls)
                  ? draft.translationPolicy.maxCalls
                  : t('settings.m38'),
                v1: enabledJudgments,
              })}
            </small>
          </summary>
          <div className="settings-group-body task-behavior-settings-body">
            <section aria-labelledby="translation-task-heading" className="task-behavior-section">
              <h4 id="translation-task-heading">{t('settings.m41')}</h4>
              <label>
                {t('settings.m42')}
                <select
                  aria-label={t('settings.m42')}
                  value={draft.translationPolicy.contextMode ?? 'full'}
                  onChange={(event) =>
                    change({
                      ...draft,
                      translationPolicy: {
                        ...draft.translationPolicy,
                        contextMode: event.target.value as 'full' | 'source-only',
                      },
                    })
                  }
                >
                  <option value="full">{t('settings.m43')}</option>
                  <option value="source-only">{t('settings.m44')}</option>
                </select>
              </label>
              {(draft.translationPolicy.contextMode !== 'source-only' ||
                invalidPreviousSceneTokens) && (
                <div className="refusal-field-row">
                  <label htmlFor="translation-previous-scene-tokens">
                    {t('settings.translationPreviousSceneTokens')}
                  </label>
                  <input
                    id="translation-previous-scene-tokens"
                    aria-invalid={invalidPreviousSceneTokens}
                    type="number"
                    min={0}
                    max={MAX_TRANSLATION_PREVIOUS_SCENE_TOKENS}
                    step={1}
                    value={previousSceneTokens ?? ''}
                    placeholder={t('settings.translationUnbounded')}
                    onChange={(event) =>
                      change({
                        ...draft,
                        translationPolicy: {
                          ...draft.translationPolicy,
                          previousSceneTokens:
                            event.target.value === '' ? undefined : event.target.valueAsNumber,
                        },
                      })
                    }
                  />
                </div>
              )}
              <div className="refusal-field-row">
                <label htmlFor="translation-call-limit">{t('settings.m46')}</label>
                <input
                  id="translation-call-limit"
                  aria-label={t('settings.m46')}
                  aria-invalid={invalidMaxCalls || undefined}
                  type="number"
                  min={2}
                  max={64}
                  step={1}
                  value={
                    Number.isFinite(draft.translationPolicy.maxCalls)
                      ? draft.translationPolicy.maxCalls
                      : ''
                  }
                  onChange={(event) =>
                    change({
                      ...draft,
                      translationPolicy: {
                        ...draft.translationPolicy,
                        maxCalls: event.target.valueAsNumber,
                      },
                    })
                  }
                />
              </div>
            </section>
            <section aria-labelledby="refusal-settings-heading" className="task-behavior-section">
              <h4 id="refusal-settings-heading">{t('settings.m40')}</h4>
              <section aria-label={t('settings.m49')} className="refusal-role">
                <div className="refusal-role-heading">
                  <h5>{t('settings.m50')}</h5>
                  <Switch
                    aria-label={t('settings.m51')}
                    checked={draft.mainJudgmentEnabled === true}
                    onChange={(event) =>
                      change({ ...draft, mainJudgmentEnabled: event.target.checked })
                    }
                  />
                </div>
                {(draft.mainJudgmentEnabled === true || invalidMainThreshold) && (
                  <div className="refusal-field-row">
                    <label htmlFor="main-refusal-threshold">{t('settings.m52')}</label>
                    <input
                      id="main-refusal-threshold"
                      aria-label={t('settings.m53')}
                      aria-invalid={invalidMainThreshold || undefined}
                      type="number"
                      min="0.51"
                      max="1"
                      step="0.01"
                      value={
                        Number.isFinite(draft.mainJudgmentThreshold)
                          ? draft.mainJudgmentThreshold
                          : ''
                      }
                      onChange={(event) =>
                        change({ ...draft, mainJudgmentThreshold: event.target.valueAsNumber })
                      }
                    />
                  </div>
                )}
              </section>
              <section aria-label={t('settings.m55')} className="refusal-role">
                <div className="refusal-role-heading">
                  <h5>{t('settings.m37')}</h5>
                  <Switch
                    aria-label={t('settings.m56')}
                    checked={translationJudgmentEnabled}
                    onChange={(event) =>
                      change({
                        ...draft,
                        translationPolicy: {
                          ...draft.translationPolicy,
                          retryProviderRefusal,
                          judgment: {
                            ...draft.translationPolicy.judgment,
                            enabled: event.target.checked,
                          },
                        },
                      })
                    }
                  />
                </div>
                {(translationJudgmentEnabled || invalidTranslationThreshold) && (
                  <div className="refusal-field-row">
                    <label htmlFor="translation-refusal-threshold">{t('settings.m52')}</label>
                    <input
                      id="translation-refusal-threshold"
                      aria-label={t('settings.m57')}
                      aria-invalid={invalidTranslationThreshold || undefined}
                      type="number"
                      min="0.51"
                      max="1"
                      step="0.01"
                      value={
                        Number.isFinite(draft.translationPolicy.judgment.threshold)
                          ? draft.translationPolicy.judgment.threshold
                          : ''
                      }
                      onChange={(event) =>
                        change({
                          ...draft,
                          translationPolicy: {
                            ...draft.translationPolicy,
                            judgment: {
                              ...draft.translationPolicy.judgment,
                              threshold: event.target.valueAsNumber,
                            },
                          },
                        })
                      }
                    />
                  </div>
                )}
                <div className="refusal-role-heading">
                  <label htmlFor="translation-provider-refusal-retry">
                    {t('settings.translationProviderRefusalRetry')}
                  </label>
                  <Switch
                    id="translation-provider-refusal-retry"
                    checked={retryProviderRefusal}
                    onChange={(event) =>
                      change({
                        ...draft,
                        translationPolicy: {
                          ...draft.translationPolicy,
                          retryProviderRefusal: event.target.checked,
                        },
                      })
                    }
                  />
                </div>
                {(translationJudgmentEnabled || retryProviderRefusal || invalidRetries) && (
                  <div className="refusal-field-row">
                    <label htmlFor="translation-refusal-retries">{t('settings.m58')}</label>
                    <input
                      id="translation-refusal-retries"
                      aria-label={t('settings.m59')}
                      aria-invalid={invalidRetries || undefined}
                      type="number"
                      min={0}
                      max={5}
                      step={1}
                      value={
                        Number.isFinite(draft.translationPolicy.maxRetries)
                          ? draft.translationPolicy.maxRetries
                          : ''
                      }
                      onChange={(event) =>
                        change({
                          ...draft,
                          translationPolicy: {
                            ...draft.translationPolicy,
                            maxRetries: event.target.valueAsNumber,
                          },
                        })
                      }
                    />
                  </div>
                )}
              </section>
            </section>
          </div>
        </details>
        <details className="settings-group full model-secondary-settings">
          <summary className="settings-group-heading">
            {t('settings.judgmentProvider')}
            <small>{judgmentProviderName}</small>
          </summary>
          <div className="settings-group-body">
            <div className="settings-row">
              <div className="settings-row-copy">
                <label htmlFor={`${id}-judgment-provider`}>{t('settings.judgmentProvider')}</label>
              </div>
              <div className="settings-row-control">
                <select
                  id={`${id}-judgment-provider`}
                  value={compatible ? 'compatible' : judgment.provider}
                  onChange={(event) => {
                    const provider = event.target.value;
                    if (provider === 'typesafe') changeJudgment(DEFAULT_JUDGMENT_SELECTION);
                    else if (provider === 'openai' || provider === 'gemini')
                      changeJudgment({
                        provider,
                        connectionId: '',
                        modelId: OFFICIAL_JUDGMENT_MODELS[provider],
                        images: false,
                      });
                    else
                      changeJudgment({
                        provider: 'openai-compatible',
                        connectionId: '',
                        modelId: '',
                        images: false,
                      });
                  }}
                >
                  <option value="typesafe">{judgmentProviderNames.typesafe}</option>
                  <option value="openai">{judgmentProviderNames.openai}</option>
                  <option value="gemini">{judgmentProviderNames.gemini}</option>
                  <option value="compatible">{t('settings.judgmentCompatible')}</option>
                </select>
              </div>
            </div>
            {judgment.provider !== 'typesafe' && (
              <>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <label htmlFor={`${id}-judgment-connection`}>
                      {t('settings.judgmentConnection')}
                    </label>
                    {judgmentConnections.length === 0 && (
                      <small>{t('settings.judgmentConnectionRequired')}</small>
                    )}
                  </div>
                  <div className="settings-row-control">
                    <select
                      id={`${id}-judgment-connection`}
                      value={judgment.connectionId}
                      onChange={(event) =>
                        changeJudgment({ ...judgment, connectionId: event.target.value })
                      }
                    >
                      <option value="">{t('settings.judgmentConnectionPlaceholder')}</option>
                      {judgment.connectionId && !judgmentConnection && (
                        <option value={judgment.connectionId} disabled>
                          {t('settings.judgmentUnavailable')}
                        </option>
                      )}
                      {judgmentConnections.map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.title}
                        </option>
                      ))}
                    </select>
                    {judgmentConnections.length === 0 && (
                      <button type="button" className="secondary" onClick={onManage}>
                        <SettingsIcon size={18} aria-hidden="true" />
                        {t('settings.m18')}
                      </button>
                    )}
                  </div>
                </div>
                {compatible && (
                  <div className="settings-row">
                    <div className="settings-row-copy">
                      <label htmlFor={`${id}-judgment-protocol`}>
                        {t('settings.judgmentProtocol')}
                      </label>
                    </div>
                    <div className="settings-row-control">
                      <select
                        id={`${id}-judgment-protocol`}
                        value={judgment.provider}
                        onChange={(event) =>
                          changeJudgment({
                            ...judgment,
                            provider:
                              event.target.value === 'typesafe-compatible'
                                ? 'typesafe-compatible'
                                : 'openai-compatible',
                          })
                        }
                      >
                        <option value="openai-compatible">OpenAI Decisions</option>
                        <option value="typesafe-compatible">TypeSafe System One</option>
                      </select>
                    </div>
                  </div>
                )}
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <label htmlFor={`${id}-judgment-model`}>{t('settings.judgmentModelId')}</label>
                  </div>
                  <div className="settings-row-control">
                    <input
                      id={`${id}-judgment-model`}
                      value={judgment.modelId}
                      readOnly={!compatible}
                      maxLength={200}
                      onChange={(event) =>
                        changeJudgment({ ...judgment, modelId: event.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <label htmlFor={`${id}-judgment-images`}>{t('settings.judgmentImages')}</label>
                  </div>
                  <div className="settings-row-control">
                    <Switch
                      id={`${id}-judgment-images`}
                      checked={judgment.images}
                      onChange={(event) =>
                        changeJudgment({ ...judgment, images: event.target.checked })
                      }
                    />
                  </div>
                </div>
              </>
            )}
            <JudgmentPricingEditor
              target={priceTarget}
              value={draft.judgmentPriceDrafts[priceKey]?.draft ?? pricingDraft()}
              onChange={(price) =>
                change({
                  ...draft,
                  judgmentPriceDrafts: {
                    ...draft.judgmentPriceDrafts,
                    [priceKey]: { target: priceTarget, draft: price },
                  },
                })
              }
            />
          </div>
        </details>
        <div className="form-actions settings-save-actions full">
          {(dirty || conflict) && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setReloadError('');
                if (dirty) setConfirmReload(true);
                else void reload();
              }}
            >
              <RefreshIcon size={18} aria-hidden="true" />
              {t('settings.m62')}
            </button>
          )}
          <SaveButton
            type="button"
            label={t('settings.m63')}
            aria-busy={operation === 'save'}
            disabled={!dirty || invalid}
            onClick={() => void save()}
          />
        </div>
      </fieldset>
      <Dialog
        open={confirmReload}
        title={t('settings.m64')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!busy) setConfirmReload(false);
        }}
      >
        <p>{t('settings.m65')}</p>
        {reloadError && <NoticeBanner tone="error">{translateMessage(reloadError)}</NoticeBanner>}
        <DraftDiscardActions
          open={confirmReload}
          disabled={busy}
          onContinue={() => setConfirmReload(false)}
          onDiscard={reload}
          discardLabel={t('settings.m66')}
        />
      </Dialog>
      <SaveConflictDialog
        open={saveConflict}
        title={t('settings.m67')}
        onClose={() => setSaveConflict(false)}
        readSaved={async () => {
          const value = (await callEndpoint(promptEndpoints.readModelWorkspace)) as ModelWorkspace;
          const modelName = (ref: ModelRef | null | undefined) =>
            library.models.find((model) => model.id === ref?.id)?.title ??
            (ref ? t('settings.m38') : t('settings.m68'));
          const savedJudgment = value.judgment ?? DEFAULT_JUDGMENT_SELECTION;
          return () => [
            { label: t('settings.m4'), value: modelName(value.routes.main) },
            { label: t('settings.m16'), value: modelName(value.routes.translation) },
            {
              label: t('settings.judgmentProvider'),
              value:
                savedJudgment.provider === 'openai-compatible' ||
                savedJudgment.provider === 'typesafe-compatible'
                  ? t('settings.judgmentCompatible')
                  : judgmentProviderNames[savedJudgment.provider],
            },
            { label: t('settings.m69'), value: modelName(value.titleModel) },
            { label: t('settings.m20'), value: modelName(value.helperModel) },
            { label: t('settings.m70'), value: modelName(value.contextModel) },
            { label: t('settings.m71'), value: modelName(value.scriptModel) },
            {
              label: t('settings.m72'),
              value: value.mainJudgmentEnabled ? t('settings.m73') : t('settings.m74'),
            },
            { label: t('settings.m59'), value: String(value.translationPolicy.maxRetries) },
          ];
        }}
      />
      {conflict && dirty && <NoticeBanner tone="error">{t('settings.m75')}</NoticeBanner>}
      {saveError && <NoticeBanner tone="error">{translateMessage(saveError)}</NoticeBanner>}
      <TransientNotice content={message} />
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      {!confirmReload && reloadError && (
        <NoticeBanner tone="error">{translateMessage(reloadError)}</NoticeBanner>
      )}
      {choices.length > 0 && (
        <button type="button" className="secondary" onClick={onManage}>
          <SettingsIcon size={18} aria-hidden="true" />
          {t('settings.m18')}
        </button>
      )}
    </section>
  );
}
