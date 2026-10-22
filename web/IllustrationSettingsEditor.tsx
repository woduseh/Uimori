import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { IllustrationPresetSettings } from './IllustrationPresetSettings.js';
import type {
  IllustrationPresetScope,
  IllustrationPresetGenerator,
} from '../core/illustration-presets.js';
import {
  useSettingsSaveHandler,
  useSettingsSaveGroup,
  type SettingsSaveRegistration,
} from './useSettingsSaveHandler.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshIcon } from './ui-icons.js';
import type { Library, ModelRef } from '../core/product.js';
import type { IllustrationSettings } from '../core/illustration.js';
import { api, ApiError } from './api.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { Switch } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useModelSelection } from './model-selection.js';
import { useTestMode } from './useTestMode.js';
import { illustrationErrorMessage } from './illustration-labels.js';
import './settings-actions.css';
import './settings-layout.css';
import './illustrations.css';

type Draft = Omit<IllustrationSettings, 'revision'> & { revision: number };
type TestResult =
  | {
      ok: true;
      system: { os: string | null; comfyuiVersion: string | null };
      devices: { name: string; vramTotal: number | null }[];
    }
  | { ok: false; code: string; nodeErrors?: unknown };

/** Global illustration settings. Frozen into each job at reservation; running jobs keep their copy. */
function IllustrationEnvironmentEditor({
  library,
  activeGenerator,
  onDirtyChange,
  onSaveHandlerChange,
  onSavedChange,
}: {
  library: Library;
  activeGenerator: IllustrationPresetGenerator;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onSavedChange: (settings: IllustrationSettings) => void;
}) {
  useI18n();
  const [saved, setSaved] = useState<IllustrationSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [operation, setOperation] = useState<'save' | 'reload' | null>(null);
  const busy = operation !== null;
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [message, setMessage] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const lock = useRef(false);
  const testMode = useTestMode();
  const { canSelect } = useModelSelection(library.models, library.connections);
  const load = useCallback(async () => {
    try {
      const value = await api<IllustrationSettings>('/illustration-settings');
      setSaved(value);
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (saved) onSavedChange(saved);
  }, [saved, onSavedChange]);
  useEffect(() => {
    if (saved && !dirty && !busy) setDraft(structuredClone(saved));
  }, [saved, dirty, busy]);
  useEffect(() => {
    onDirtyChange(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, async () => (!draft ? false : save()));
  if (!draft)
    return (
      <LoadingState
        presentation="region"
        loading={!loadError}
        error={translateMessage(loadError)}
        label={t('visuals.m041')}
        onRetry={() => void load()}
      />
    );
  const conflict = !!saved && saved.revision > draft.revision;
  const change = (next: Draft) => {
    setDraft(next);
    setDirty(true);
    setMessage('');
  };
  const codexModels = library.models.filter(
    (model) =>
      library.connections.find((connection) => connection.id === model.connectionId)?.protocol ===
      'codex-app-server-v1'
  );
  const selector = (
    label: string,
    selected: ModelRef | null,
    models: Library['models'],
    onChange: (ref: ModelRef | null) => void,
    emptyLabel = t('visuals.m042'),
    description = ''
  ) => {
    const model = library.models.find((item) => item.id === selected?.id);
    return (
      <label className="settings-row">
        <span className="settings-row-copy">
          <span>{label}</span>
          {description && <small>{description}</small>}
        </span>
        <span className="settings-row-control">
          <select
            aria-label={label}
            value={selected?.id ?? ''}
            onChange={(event) => onChange(event.target.value ? { id: event.target.value } : null)}
          >
            <option value="">{emptyLabel}</option>
            {selected && !models.some((item) => item.id === selected.id) && (
              <option value={selected.id}>{t('visuals.m043')}</option>
            )}
            {models
              .filter((item) => canSelect(item) || item.id === selected?.id)
              .map((item) => (
                <option key={item.id} value={item.id} disabled={!canSelect(item)}>
                  {item.title} ·{' '}
                  {canSelect(item)
                    ? library.connections.find((connection) => connection.id === item.connectionId)
                        ?.title
                    : t('visuals.m044')}
                </option>
              ))}
          </select>
          {selected && (!model || !canSelect(model)) && (
            <small role="status">{t('visuals.m045')}</small>
          )}
        </span>
      </label>
    );
  };
  const numberField = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (value: number) => void,
    step = 1,
    description = ''
  ) => (
    <label className="settings-row">
      <span className="settings-row-copy">
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
      <span className="settings-row-control">
        <input
          aria-label={label}
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ''}
          onChange={(event) => onChange(event.target.valueAsNumber)}
        />
      </span>
    </label>
  );
  const valid =
    Number.isInteger(draft.maxPerSource) &&
    draft.maxPerSource >= 1 &&
    draft.maxPerSource <= 8 &&
    Number.isInteger(draft.automaticMaxTargets) &&
    draft.automaticMaxTargets >= 1 &&
    draft.automaticMaxTargets <= 8 &&
    Number.isInteger(draft.maxAutoRetries) &&
    draft.maxAutoRetries >= 0 &&
    draft.maxAutoRetries <= 5 &&
    Number.isInteger(draft.comfyui.timeoutMs) &&
    draft.comfyui.timeoutMs >= 10_000 &&
    Number.isInteger(draft.comfyui.pollIntervalMs) &&
    draft.comfyui.pollIntervalMs >= 250;
  const save = async () => {
    if (lock.current || !valid) return false;
    if (conflict) {
      setSaveConflict(true);
      return false;
    }
    if (!dirty) return true;
    lock.current = true;
    setOperation('save');
    setSaveError('');
    setMessage('');
    const { revision, ...body } = draft;
    return api<IllustrationSettings>(
      '/illustration-settings',
      { expectedRevision: revision, ...body },
      'PUT'
    )
      .then(async (accepted) => {
        setSaved(accepted);
        setDraft(structuredClone(accepted));
        setDirty(false);
        setMessage(uiMessage('visuals.m046'));
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
  };
  const reload = async () => {
    if (lock.current) return;
    lock.current = true;
    setOperation('reload');
    setLoadError('');
    setMessage('');
    try {
      const value = await api<IllustrationSettings>('/illustration-settings');
      setSaved(value);
      setDraft(structuredClone(value));
      setDirty(false);
      setSaveError('');
      setMessage('');
      setConfirmReload(false);
    } catch {
      setLoadError(uiMessage('visuals.m047'));
    } finally {
      lock.current = false;
      setOperation(null);
    }
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const result = await api<{
        system: { os: string | null; comfyuiVersion: string | null };
        devices: { name: string; vramTotal: number | null }[];
      }>('/illustration-settings/comfyui/test', {
        baseUrl: draft.comfyui.baseUrl,
        authorizationEnv: draft.comfyui.authorizationEnv,
      });
      setTest({ ok: true, ...result });
    } catch (error) {
      const raw = error instanceof ApiError ? error.message : '';
      let code = 'COMFYUI_UNREACHABLE';
      try {
        const parsed = JSON.parse(raw) as { code?: string };
        if (typeof parsed.code === 'string') code = parsed.code;
      } catch {
        if (error instanceof ApiError && error.status === 400) code = 'COMFYUI_BASE_URL_INVALID';
      }
      setTest({ ok: false, code });
    } finally {
      setTesting(false);
    }
  };
  return (
    <section
      aria-label={t('visuals.m048')}
      className="settings-section settings-group illustration-settings illustration-environment"
    >
      <div className="settings-group-heading">
        <div>
          <h3>{t('visuals.m049')}</h3>
          <p>{t('settings.sharedIllustrationEnvironment')}</p>
        </div>
      </div>
      <fieldset disabled={busy} className="illustration-environment-fields">
        <div className="settings-group-body illustration-automatic-settings">
          {testMode && (
            <label className="settings-row">
              <span className="settings-row-copy">{t('visuals.m051')}</span>
              <span className="settings-row-control">
                <select
                  aria-label={t('visuals.m052')}
                  value={draft.generator === 'fixture' ? 'fixture' : ''}
                  onChange={(event) =>
                    change({
                      ...draft,
                      generator: event.target.value === 'fixture' ? 'fixture' : undefined,
                    })
                  }
                >
                  <option value="">{t('visuals.m053')}</option>
                  <option value="fixture">{t('visuals.m054')}</option>
                </select>
              </span>
            </label>
          )}
          <label className="settings-row settings-row-toggle">
            <span className="settings-row-copy">
              <span>{t('visuals.m055')}</span>
              <small>{t('visuals.m056')}</small>
            </span>
            <span className="settings-row-control">
              <Switch
                aria-label={t('visuals.m057')}
                checked={draft.automatic}
                onChange={(event) => change({ ...draft, automatic: event.target.checked })}
              />
            </span>
          </label>
          {numberField(
            t('visuals.m058'),
            draft.maxPerSource,
            1,
            8,
            (value) =>
              change({
                ...draft,
                maxPerSource: value,
                automaticMaxTargets:
                  Number.isInteger(value) && value >= 1 && value <= 8
                    ? Math.min(value, draft.automaticMaxTargets)
                    : draft.automaticMaxTargets,
              }),
            1,
            t('visuals.m059')
          )}
          {draft.automatic &&
            numberField(
              t('visuals.m060'),
              draft.automaticMaxTargets,
              1,
              draft.maxPerSource,
              (value) => change({ ...draft, automaticMaxTargets: value })
            )}
          {numberField(
            t('visuals.m061'),
            draft.maxAutoRetries,
            0,
            5,
            (value) => change({ ...draft, maxAutoRetries: value }),
            1,
            t('visuals.m062')
          )}
        </div>
        <details
          className="illustration-preset-disclosure illustration-environment-disclosure"
          open={activeGenerator === 'codex'}
        >
          <summary>
            {t('visuals.m063')}
            {activeGenerator === 'codex' && <small>{t('visuals.m064')}</small>}
          </summary>
          <fieldset className="settings-group-body illustration-environment-options">
            {selector(
              t('visuals.m065'),
              draft.codex.model,
              codexModels,
              (ref) => change({ ...draft, codex: { ...draft.codex, model: ref } }),
              codexModels.length ? t('visuals.m042') : t('visuals.m066'),
              t('visuals.m067')
            )}
            <label className="settings-row settings-row-toggle">
              <span className="settings-row-copy">{t('visuals.m068')}</span>
              <span className="settings-row-control">
                <Switch
                  aria-label={t('visuals.m068')}
                  checked={draft.codex.useReferences}
                  onChange={(event) =>
                    change({
                      ...draft,
                      codex: {
                        ...draft.codex,
                        useReferences: event.target.checked,
                      },
                    })
                  }
                />
              </span>
            </label>
          </fieldset>
        </details>
        <details
          className="illustration-preset-disclosure illustration-environment-disclosure"
          open={activeGenerator === 'comfyui'}
        >
          <summary>
            {t('visuals.m069')}
            {activeGenerator === 'comfyui' && <small>{t('visuals.m064')}</small>}
          </summary>
          <fieldset className="settings-group-body illustration-environment-options">
            <label className="settings-row">
              <span className="settings-row-copy">{t('visuals.m070')}</span>
              <span className="settings-row-control">
                <input
                  aria-label={t('visuals.m070')}
                  type="url"
                  placeholder="http://192.168.0.10:8188"
                  value={draft.comfyui.baseUrl}
                  onChange={(event) =>
                    change({
                      ...draft,
                      comfyui: {
                        ...draft.comfyui,
                        baseUrl: event.target.value,
                      },
                    })
                  }
                />
              </span>
            </label>
            <label className="settings-row">
              <span className="settings-row-copy">
                {t('visuals.m071')}
                <small>{t('visuals.m072')}</small>
              </span>
              <span className="settings-row-control">
                <input
                  aria-label={t('visuals.m073')}
                  type="text"
                  placeholder="UIMORI_COMFYUI_AUTHORIZATION"
                  value={draft.comfyui.authorizationEnv}
                  onChange={(event) =>
                    change({
                      ...draft,
                      comfyui: {
                        ...draft.comfyui,
                        authorizationEnv: event.target.value,
                      },
                    })
                  }
                />
              </span>
            </label>
            <div className="illustration-test full">
              <button
                type="button"
                className="secondary"
                disabled={testing || !draft.comfyui.baseUrl.trim()}
                onClick={() => void runTest()}
              >
                {testing ? t('visuals.m074') : t('visuals.m075')}
              </button>
              {test && (
                <span className="illustration-test-result" role="status">
                  {test.ok
                    ? t('visuals.m076', {
                        v0: test.system.comfyuiVersion ?? t('visuals.unknownVersion'),
                        v1: test.system.os ?? '',
                        v2: test.devices.map((device) => device.name).join(', '),
                      })
                    : `${illustrationErrorMessage(test.code)} (${test.code})`}
                </span>
              )}
            </div>
            {selector(
              t('visuals.m077'),
              draft.comfyui.promptModel,
              library.models,
              (ref) =>
                change({
                  ...draft,
                  comfyui: { ...draft.comfyui, promptModel: ref },
                }),
              t('visuals.m042'),
              t('visuals.m078')
            )}
            {numberField(
              t('visuals.m079'),
              draft.comfyui.timeoutMs / 1000,
              10,
              1800,
              (value) =>
                change({
                  ...draft,
                  comfyui: {
                    ...draft.comfyui,
                    timeoutMs: Math.round(value * 1000),
                  },
                }),
              1
            )}
          </fieldset>
        </details>
        <div className="form-actions settings-save-actions full">
          <IconButton
            icon={RefreshIcon}
            label={t('visuals.m080')}
            className="secondary"
            aria-busy={busy}
            onClick={() => (dirty ? setConfirmReload(true) : void reload())}
          />
          <SaveButton
            type="button"
            label={t('visuals.m081')}
            aria-busy={operation === 'save'}
            disabled={!dirty || !valid}
            onClick={save}
          />
        </div>
      </fieldset>
      <SaveConflictDialog
        open={saveConflict}
        title={t('visuals.m082')}
        onClose={() => setSaveConflict(false)}
        readSaved={async () => {
          const value = await api<IllustrationSettings>('/illustration-settings');
          return () => [
            { label: t('visuals.m083'), value: String(value.maxPerSource) },
            { label: t('visuals.m084'), value: String(value.automaticMaxTargets) },
            { label: t('visuals.m085'), value: String(value.maxAutoRetries) },
            { label: t('visuals.m070'), value: value.comfyui.baseUrl },
          ];
        }}
      />
      <Dialog
        open={confirmReload}
        title={t('visuals.m086')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!busy) setConfirmReload(false);
        }}
      >
        <p>{t('visuals.m087')}</p>
        {loadError && <NoticeBanner tone="error">{translateMessage(loadError)}</NoticeBanner>}
        <DraftDiscardActions
          open={confirmReload}
          disabled={busy}
          onContinue={() => setConfirmReload(false)}
          onDiscard={reload}
          discardLabel={t('visuals.m088')}
        />
      </Dialog>
      {conflict && dirty && <NoticeBanner tone="error">{t('visuals.m089')}</NoticeBanner>}
      {saveError && (
        <NoticeBanner tone="error">
          {t('visuals.draftError', { error: translateMessage(saveError) })}
        </NoticeBanner>
      )}
      <TransientNotice message={message} />
      {loadError && !confirmReload && (
        <NoticeBanner tone="error">{translateMessage(loadError)}</NoticeBanner>
      )}
    </section>
  );
}

const illustrationSections = ['presets', 'environment'] as const;
export function IllustrationSettingsEditor({
  library,
  scope,
  onDirtyChange,
  onSaveHandlerChange,
}: {
  library: Library;
  scope: IllustrationPresetScope;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
}) {
  useI18n();
  const [activeGenerator, setActiveGenerator] = useState<IllustrationPresetGenerator>('codex');
  const [environment, setEnvironment] = useState<IllustrationSettings | null>(null);
  const [presetsDirty, setPresetsDirty] = useState(false);
  const [environmentDirty, setEnvironmentDirty] = useState(false);
  const group = useSettingsSaveGroup(illustrationSections);
  useEffect(() => {
    onDirtyChange(presetsDirty || environmentDirty);
  }, [presetsDirty, environmentDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, () =>
    group.save({ presets: presetsDirty, environment: environmentDirty })
  );
  return (
    <>
      <IllustrationPresetSettings
        library={library}
        environment={environment}
        scope={scope}
        onGeneratorChange={setActiveGenerator}
        onDirtyChange={setPresetsDirty}
        onSaveHandlerChange={group.registrations.presets}
      />
      <details className="illustration-preset-disclosure">
        <summary>{t('visuals.m091')}</summary>
        <IllustrationEnvironmentEditor
          library={library}
          onSavedChange={setEnvironment}
          activeGenerator={activeGenerator}
          onDirtyChange={setEnvironmentDirty}
          onSaveHandlerChange={group.registrations.environment}
        />
      </details>
    </>
  );
}
