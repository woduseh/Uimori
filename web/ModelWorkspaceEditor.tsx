import { t, translateMessage, useI18n, getLocale, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { useEffect, useId, useRef, useState } from 'react';
import type { Library, ModelRef, ModelWorkspace } from '../core/product.js';
import {
  DEFAULT_SUMMARY_LENGTH,
  SUMMARY_LENGTH_VALUES,
  type SummaryLength,
} from '../core/summary-length.js';
import { api, ApiError } from './api.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { useModelSelection } from './model-selection.js';
import { EditIcon, RefreshIcon, SettingsIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { Switch } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import './settings-actions.css';

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
  const [draft, setDraft] = useState<ModelWorkspace | null>(null);
  const [dirty, setDirty] = useState(false);
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
      // A successful explicit read must not be replaced by an older shared snapshot.
      setDraft((current) =>
        current && current.revision > workspace.revision
          ? current
          : {
              revision: workspace.revision,
              summaryLength: workspace.summaryLength ?? DEFAULT_SUMMARY_LENGTH,
              titleModel: workspace.titleModel ?? null,
              helperModel: workspace.helperModel ?? null,
              contextModel: workspace.contextModel ?? null,
              scriptModel: workspace.scriptModel ?? null,
              routes: workspace.modelRoutes,
              mainJudgmentEnabled: workspace.mainJudgmentEnabled === true,
              mainJudgmentThreshold: workspace.mainJudgmentThreshold ?? 0.9,
              translationPolicy: workspace.translationPolicy,
            }
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
  const invalid =
    !Number.isFinite(draft.mainJudgmentThreshold) ||
    (draft.mainJudgmentThreshold ?? 0.9) <= 0.5 ||
    (draft.mainJudgmentThreshold ?? 0.9) > 1 ||
    !Number.isInteger(draft.translationPolicy.maxRetries) ||
    draft.translationPolicy.maxRetries < 0 ||
    draft.translationPolicy.maxRetries > 5 ||
    !Number.isInteger(draft.translationPolicy.maxCalls) ||
    draft.translationPolicy.maxCalls < 2 ||
    draft.translationPolicy.maxCalls > 64 ||
    !Number.isFinite(draft.translationPolicy.judgment.threshold) ||
    draft.translationPolicy.judgment.threshold <= 0.5 ||
    draft.translationPolicy.judgment.threshold > 1;
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
    return api<ModelWorkspace>(
      '/model-workspace',
      {
        expectedRevision: draft.revision,
        routes: draft.routes,
        mainJudgmentEnabled: draft.mainJudgmentEnabled === true,
        mainJudgmentThreshold: draft.mainJudgmentThreshold,
        titleModel: draft.titleModel ?? null,
        helperModel: draft.helperModel ?? null,
        contextModel: draft.contextModel ?? null,
        summaryLength: draft.summaryLength ?? DEFAULT_SUMMARY_LENGTH,
        scriptModel: draft.scriptModel ?? null,
        translationPolicy: draft.translationPolicy,
      },
      'PUT'
    )
      .then(async (accepted) => {
        setDraft(accepted);
        setDirty(false);
        await refresh();
        setMessage(uiMessage('settings.m1'));
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
  function change(next: ModelWorkspace) {
    setDraft(next);
    setDirty(true);
    setMessage('');
  }
  async function reload() {
    if (lock.current) return;
    lock.current = true;
    setOperation('reload');
    setReloadError('');
    try {
      const accepted = await api<ModelWorkspace>('/model-workspace');
      setDraft(accepted);
      setDirty(false);
      setSaveError('');
      setMessage('');
      setConfirmReload(false);
      void refresh();
    } catch {
      setReloadError(uiMessage('settings.m2'));
    } finally {
      lock.current = false;
      setOperation(null);
    }
  }
  const selector = (
    role: string,
    label: string,
    selected: ModelRef | null,
    onChange: (ref: ModelRef | null) => void,
    description?: string
  ) => {
    const model = library.models.find((item) => item.id === selected?.id);
    const displayLabel = label;
    const fieldId = `${id}-model-${role}`;
    return (
      <div className="settings-row model-role-setting">
        <div className="settings-row-copy">
          <label htmlFor={fieldId}>{displayLabel}</label>
          {description && <small>{description}</small>}
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
  const configuredSummary = (values: Array<ModelRef | null | undefined>) => {
    const configured = values.filter(Boolean).length;
    if (configured === 0) return t('settings.m10');
    if (configured === values.length) return t('settings.m11', { v0: configured });
    return t('settings.m12', { v0: configured, v1: values.length });
  };
  const enabledJudgments =
    Number(draft.mainJudgmentEnabled === true) +
    Number(draft.translationPolicy.judgment.enabled !== false);
  return (
    <section aria-label={t('settings.m13')} className="settings-section model-workspace-settings">
      <p className="model-workspace-intro">{t('settings.m14')}</p>
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
        <details className="settings-group full model-secondary-settings">
          <summary className="settings-group-heading">
            {t('settings.m19')}
            <small>
              {configuredSummary([
                draft.helperModel,
                draft.contextModel,
                draft.titleModel,
                draft.scriptModel,
              ])}
            </small>
          </summary>
          <div className="settings-group-body">
            {selector(
              'helper',
              t('settings.m20'),
              draft.helperModel ?? null,
              (ref) => change({ ...draft, helperModel: ref }),
              t('settings.m21')
            )}
            {selector(
              'context',
              t('settings.m22'),
              draft.contextModel ?? null,
              (ref) => change({ ...draft, contextModel: ref }),
              t('settings.m23')
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
            <p className="model-summary-note">{t('settings.m28')}</p>
            {selector('title', t('settings.m30'), draft.titleModel ?? null, (ref) =>
              change({ ...draft, titleModel: ref })
            )}
            {selector(
              'script',
              t('settings.m34'),
              draft.scriptModel ?? null,
              (ref) => change({ ...draft, scriptModel: ref }),
              t('settings.m35')
            )}
          </div>
        </details>
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
                  aria-describedby="translation-context-help"
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
              <p id="translation-context-help" className="refusal-settings-help">
                {t('settings.m45')}
              </p>
              <div className="refusal-field-row">
                <label htmlFor="translation-call-limit">{t('settings.m46')}</label>
                <input
                  id="translation-call-limit"
                  aria-label={t('settings.m46')}
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
              <p className="refusal-settings-help">{t('settings.m47')}</p>
            </section>
            <section aria-labelledby="refusal-settings-heading" className="task-behavior-section">
              <h4 id="refusal-settings-heading">{t('settings.m40')}</h4>
              <p className="refusal-settings-help">{t('settings.m48')}</p>
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
                <div className="refusal-field-row">
                  <label htmlFor="main-refusal-threshold">{t('settings.m52')}</label>
                  <input
                    id="main-refusal-threshold"
                    aria-label={t('settings.m53')}
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
                <p className="refusal-settings-help">{t('settings.m54')}</p>
              </section>
              <section aria-label={t('settings.m55')} className="refusal-role">
                <div className="refusal-role-heading">
                  <h5>{t('settings.m37')}</h5>
                  <Switch
                    aria-label={t('settings.m56')}
                    checked={draft.translationPolicy.judgment.enabled !== false}
                    onChange={(event) =>
                      change({
                        ...draft,
                        translationPolicy: {
                          ...draft.translationPolicy,
                          judgment: {
                            ...draft.translationPolicy.judgment,
                            enabled: event.target.checked,
                          },
                        },
                      })
                    }
                  />
                </div>
                <div className="refusal-field-row">
                  <label htmlFor="translation-refusal-threshold">{t('settings.m52')}</label>
                  <input
                    id="translation-refusal-threshold"
                    aria-label={t('settings.m57')}
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
                <div className="refusal-field-row">
                  <label htmlFor="translation-refusal-retries">{t('settings.m58')}</label>
                  <input
                    id="translation-refusal-retries"
                    aria-label={t('settings.m59')}
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
                <p className="refusal-settings-help">{t('settings.m60')}</p>
              </section>
              <p className="refusal-settings-help">{t('settings.m61')}</p>
            </section>
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
          const value = await api<ModelWorkspace>('/model-workspace');
          const modelName = (ref: ModelRef | null | undefined) =>
            library.models.find((model) => model.id === ref?.id)?.title ??
            (ref ? t('settings.m38') : t('settings.m68'));
          return () => [
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
      {saveError && (
        <NoticeBanner tone="error">
          {t('settings.flow1', { v0: translateMessage(saveError) })}
        </NoticeBanner>
      )}
      <TransientNotice message={message} />
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      {!confirmReload && reloadError && (
        <NoticeBanner tone="error">{translateMessage(reloadError)}</NoticeBanner>
      )}
      {choices.length > 0 && (
        <button type="button" className="secondary" onClick={onManage}>
          <SettingsIcon size={18} aria-hidden="true" />
          {t('settings.m77')}{' '}
        </button>
      )}
    </section>
  );
}
