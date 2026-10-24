import { useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { promptControls } from '../core/risu-prompt.js';
import { ExpandIcon, EditIcon, SaveIcon, CloseIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { useCallback, useEffect, useId, useState } from 'react';
import type { Library, PromptRole, PromptWorkspace } from '../core/product.js';
import type { WorkspaceEditModel } from '../core/resource-editing.js';
import {
  combinationOwner,
  matchesPromptCombination,
  ownsPromptCombination,
} from '../core/prompt-combinations.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { resolvePromptValues } from '../core/risu-prompt.js';
import { api } from './api.js';
import { ResourceEditorSession } from './resource-editor-session.js';
import { PromptControlFields } from './PromptControlFields.js';
import { ActionMenu } from './ActionMenu.js';
import { PromptCombinationManager } from './PromptCombinationManager.js';
import { Dialog } from './Dialog.js';
import {
  ResourceEditorProvider,
  ResourceEditorStatus,
  ResourceEditorActions,
  requestResourceConflictReview,
  useResourceEditor,
} from './resource-editor.js';
import './prompt-editor.css';
import './prompt-composer.css';
import './toggle-row.css';

export function PromptWorkspaceEditor({
  library,
  reload,
  onDirtyChange,
  onSaveHandlerChange,
  onEditPrompt,
  navigationDisabled = false,
}: {
  library: Library;
  reload?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onEditPrompt?: (presetId?: string) => void;
  navigationDisabled?: boolean;
}) {
  const { t } = useI18n();
  const presetId = useId();
  const [role, setRole] = useState<PromptRole>('main');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [message, setMessage] = useState('');
  const [comboName, setComboName] = useState('');
  const [savingCombo, setSavingCombo] = useState(false);
  const [comboOpen, setComboOpen] = useState(false);
  const [manageCombinations, setManageCombinations] = useState(false);
  const [comboError, setComboError] = useState('');
  const [selectedCombo, setSelectedCombo] = useState('');
  const [session] = useState(
    () =>
      new ResourceEditorSession({
        editorKey: 'prompt-workspace:current',
        kind: 'prompt-workspace',
        targetId: 'current',
        initialModel: {
          main: { title: '', program: createDefaultRisuPrompt('', 'main'), values: {} },
          translation: {
            title: '',
            program: createDefaultRisuPrompt('', 'translation'),
            values: {},
          },
        },
      })
  );
  const shared = useResourceEditor<WorkspaceEditModel>(session);
  const { model: draft, setModel, state } = shared;
  const { dirty, conflict } = state;
  const busy = state.saving || applying;
  const saveError = state.error || applyError;
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const save = useCallback(async () => {
    const current = session.snapshot();
    if (!current.ready || current.saving || current.conflict || applying) return false;
    setApplyError('');
    try {
      await session.save();
      setMessage(uiMessage('prompts.uiChangesSavedAutomatically'));
      return !session.snapshot().dirty;
    } catch {
      return false;
    }
  }, [session, applying]);
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (session.snapshot().conflict) {
      requestResourceConflictReview(session);
      return false;
    }
    const result = await save();
    if (!result) requestResourceConflictReview(session);
    return result;
  });

  // The session distinguishes new edits from recovered input and acknowledges only
  // the model sent by a save. Later edits schedule the next save when that one finishes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each model edit restarts the autosave debounce.
  useEffect(() => {
    if (!state.autosavePending || busy || saveError || conflict) return;
    const timer = setTimeout(() => void save(), 300);
    return () => clearTimeout(timer);
  }, [draft, state.autosavePending, busy, saveError, conflict, save]);

  function edit(update: (current: WorkspaceEditModel) => WorkspaceEditModel) {
    setModel(update);
    setMessage('');
  }
  async function applyPreset(presetId: string) {
    const current = session.snapshot();
    if (applying || current.saving || current.dirty || current.conflict) return;
    setApplying(true);
    setApplyError('');
    try {
      await api<PromptWorkspace>('/prompt-workspace/apply', {
        expectedRevision: current.document.baseRevision,
        role,
        presetId,
      });
      await session.reloadSaved();
      setSelectedCombo('');
      setMessage(uiMessage('prompts.uiBuiltInPromptSelected'));
    } catch (caught) {
      setApplyError((caught as Error).message);
      await session.refresh().catch(() => {});
    } finally {
      setApplying(false);
    }
  }
  if (!state.ready)
    return (
      <LoadingState
        presentation="region"
        loading={!state.error}
        error={translateMessage(state.error)}
        label={t('prompts.uiLoadingCurrentPrompts')}
        onRetry={() => void session.open().catch(() => {})}
      />
    );
  const current = draft[role];
  const preset = library.promptPresets?.find(
    (item) => item.id === current.presetId && item.role === role
  );
  const combinations =
    library.promptCombinations?.filter((item) =>
      matchesPromptCombination(item, combinationOwner(current, role), role, current.program)
    ) ?? [];
  const ownedCombinations =
    library.promptCombinations?.filter((item) =>
      ownsPromptCombination(item, combinationOwner(current, role), role)
    ) ?? [];
  const defaultValues = resolvePromptValues(current.program, current.defaultValues ?? {});
  const values = resolvePromptValues(current.program, { ...defaultValues, ...current.values });
  const selected = combinations.find((item) => item.id === selectedCombo);
  const equalValues = (other: typeof values) =>
    Object.keys(values).every((key) => JSON.stringify(values[key]) === JSON.stringify(other[key]));
  const comboValue =
    selected && equalValues(resolvePromptValues(current.program, selected.values))
      ? selected.id
      : equalValues(defaultValues)
        ? 'default'
        : 'custom';
  const showRecovery = conflict || !!saveError || (dirty && !state.autosavePending);
  return (
    <ResourceEditorProvider value={shared}>
      <section
        aria-label={t('prompts.uiCurrentPromptSettings')}
        className="prompt-editor prompt-current-settings"
      >
        <p className="muted">{t('prompts.uiUsesTheLatestSavedPresetDefaultOptionChangesApply')}</p>
        {showRecovery && <ResourceEditorActions value={shared} hideSyncError />}
        <div className="prompt-editor-fields">
          <section className="settings-group">
            <div className="settings-group-body">
              <label className="settings-row">
                <span className="settings-row-copy">{t('prompts.uiRole')}</span>
                <select
                  aria-label={t('prompts.uiCurrentPromptRole')}
                  value={role}
                  disabled={busy || dirty}
                  onChange={(event) => {
                    setRole(event.target.value as PromptRole);
                    setSelectedCombo('');
                  }}
                >
                  <option value="main">{t('prompts.uiWriting')}</option>
                  <option value="translation">{t('prompts.uiTranslation')}</option>
                </select>
              </label>
              <div className="settings-row">
                <label className="settings-row-copy" htmlFor={presetId}>
                  {t('prompts.uiPrompts')}
                </label>
                <div className="settings-row-control prompt-current-preset">
                  <select
                    id={presetId}
                    aria-label={t('prompts.uiCurrentPromptPreset')}
                    value={preset?.id ?? ''}
                    disabled={busy || dirty || conflict}
                    onChange={(event) => {
                      if (event.target.value) void applyPreset(event.target.value);
                    }}
                  >
                    {!preset && <option value="">{current.title}</option>}
                    {library.promptPresets
                      ?.filter((item) => item.role === role)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.id === current.presetId ? current.title : item.title}
                        </option>
                      ))}
                  </select>
                  {onEditPrompt && (
                    <IconButton
                      icon={EditIcon}
                      label={t('prompts.uiEditPrompt')}
                      className="secondary"
                      disabled={busy || dirty || navigationDisabled}
                      onClick={() => onEditPrompt(preset?.id)}
                    />
                  )}
                </div>
              </div>
            </div>
          </section>
          <details className="pc-composer-fold settings-group">
            <summary className="settings-group-heading">
              <ExpandIcon className="pc-disclosure-icon" size={16} aria-hidden="true" />
              <strong>{t('prompts.uiWritingOptions')}</strong>
              <small>
                {comboValue === 'default'
                  ? t('prompts.uiDefault')
                  : comboValue === 'custom'
                    ? t('prompts.uiCustom')
                    : selected?.title}
              </small>
            </summary>
            {promptControls(current.program).length || ownedCombinations.length ? (
              <div className="settings-group-body prompt-current-options">
                <div className="prompt-combination-toolbar">
                  <label>
                    {t('prompts.uiOptionCombination')}
                    <select
                      aria-label={t('prompts.uiOptionCombination')}
                      value={comboValue}
                      disabled={applying || !!saveError || conflict}
                      onChange={(event) => {
                        const id = event.target.value;
                        if (id === 'custom') return;
                        const item = combinations.find((entry) => entry.id === id);
                        setSelectedCombo(item?.id ?? '');
                        edit((draft) => ({
                          ...draft,
                          [role]: {
                            ...draft[role],
                            values:
                              id === 'default'
                                ? {}
                                : resolvePromptValues(current.program, item!.values),
                            optionValues: id === 'default' ? {} : item!.values,
                          },
                        }));
                      }}
                    >
                      <option value="default">{t('prompts.uiDefault')}</option>
                      <option value="custom" disabled>
                        {t('prompts.uiCustom')}
                      </option>
                      {combinations.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ActionMenu label={t('prompts.uiOptionCombinationMenu')}>
                    <button
                      type="button"
                      disabled={dirty || busy || conflict}
                      onClick={() => {
                        setComboName('');
                        setComboError('');
                        setComboOpen(true);
                      }}
                    >
                      <SaveIcon size={18} aria-hidden="true" />
                      {t('prompts.uiSaveSelectionAsANewCombination')}
                    </button>
                    <button type="button" onClick={() => setManageCombinations(true)}>
                      {t('prompts.uiManageCombinations2')}
                    </button>
                  </ActionMenu>
                </div>
                <fieldset className="prompt-editor-fields" disabled={applying || conflict}>
                  <PromptControlFields
                    program={current.program}
                    values={values}
                    onChange={(id, value) => {
                      setSelectedCombo('');
                      edit((draft) => ({
                        ...draft,
                        [role]: {
                          ...draft[role],
                          values: { ...draft[role].values, [id]: value },
                          optionValues: { ...draft[role].optionValues, [id]: value },
                        },
                      }));
                    }}
                  />
                </fieldset>
              </div>
            ) : (
              <p className="muted">{t('prompts.uiThisPromptHasNoSelectableOptions')}</p>
            )}
          </details>
        </div>
        {(conflict || saveError) && (
          <NoticeBanner tone="error">
            {conflict
              ? t('prompts.uiThePromptChangedElsewhereYourSelectionIsPreservedCheck')
              : translateMessage(saveError)}
          </NoticeBanner>
        )}
        {(saveError || (dirty && !busy && !state.autosavePending)) && (
          <button
            type="button"
            className="secondary"
            disabled={busy || conflict}
            onClick={() => void save()}
          >
            {t('prompts.uiSaveAgain')}
          </button>
        )}
        {conflict && !showRecovery && <ResourceEditorStatus value={shared} hideSyncError />}
        {(busy || (dirty && !showRecovery)) && (
          <p role="status" className="muted">
            {t('prompts.uiSaving')}
          </p>
        )}
        <TransientNotice message={busy || dirty ? '' : message} />
        <PromptCombinationManager
          open={manageCombinations}
          onClose={() => setManageCombinations(false)}
          current={current}
          role={role}
          workspaceRevision={state.document.baseRevision ?? 0}
          combinations={library.promptCombinations ?? []}
          reload={reload}
        />
        <Dialog
          open={comboOpen}
          title={t('prompts.uiSaveOptionCombination')}
          onClose={() => {
            if (!savingCombo) setComboOpen(false);
          }}
        >
          <label>
            {t('prompts.uiCombinationName')}
            <input
              aria-label={t('prompts.uiCombinationName')}
              value={comboName}
              maxLength={200}
              disabled={savingCombo}
              onChange={(event) => setComboName(event.target.value)}
            />
          </label>
          {comboError && <NoticeBanner tone="error">{comboError}</NoticeBanner>}
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={savingCombo}
              onClick={() => setComboOpen(false)}
            >
              <CloseIcon size={18} aria-hidden="true" />
              {t('prompts.uiCancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!comboName.trim() || savingCombo}
              onClick={async () => {
                setSavingCombo(true);
                try {
                  await api('/prompt-combinations', {
                    title: comboName.trim(),
                    role,
                    values: current.values,
                    workspaceRevision: state.document.baseRevision,
                  });
                  await reload?.();
                  setComboOpen(false);
                } catch (caught) {
                  setComboError((caught as Error).message);
                } finally {
                  setSavingCombo(false);
                }
              }}
            >
              {savingCombo ? t('prompts.uiSaving') : t('prompts.uiSave')}
            </button>
          </div>
        </Dialog>
      </section>
    </ResourceEditorProvider>
  );
}
