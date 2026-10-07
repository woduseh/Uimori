import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { promptControls } from '../core/risu-prompt.js';
import { ExpandIcon, ExternalLinkIcon, ResetIcon, SaveIcon, CloseIcon } from './ui-icons.js';
import { useCallback, useEffect, useState } from 'react';
import type { Library, PromptRole, PromptWorkspace } from '../core/product.js';
import type { WorkspaceEditModel } from '../core/resource-editing.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { resolvePromptValues } from '../core/risu-prompt.js';
import { api } from './api.js';
import { ResourceEditorSession } from './resource-editor-session.js';
import { PromptControlFields } from './PromptControlFields.js';
import { Switch } from './BooleanControls.js';
import { ActionMenu } from './ActionMenu.js';
import { DeleteButton } from './DeleteButton.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import {
  ResourceEditorProvider,
  ResourceEditorStatus,
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
      setMessage('변경사항을 자동 저장했어요.');
      return !session.snapshot().dirty;
    } catch {
      return false;
    }
  }, [session, applying]);
  useSettingsSaveHandler(onSaveHandlerChange, save);

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
      setMessage('프롬프트와 기본 옵션을 적용했어요.');
    } catch (caught) {
      setApplyError((caught as Error).message);
      await session.refresh().catch(() => {});
    } finally {
      setApplying(false);
    }
  }
  if (!state.ready)
    return (
      <p role="status">
        {state.error || '현재 프롬프트를 불러오는 중이에요…'}{' '}
        <IconButton
          icon={ResetIcon}
          label="다시 불러오기"
          onClick={() => void session.open().catch(() => {})}
        />
      </p>
    );
  const current = draft[role];
  const preset = library.promptPresets?.find(
    (item) => item.id === current.presetId && item.role === role
  );
  const combinations =
    library.promptCombinations?.filter((item) =>
      matchesPromptCombination(item, combinationOwner(current, role), role, current.program)
    ) ?? [];
  const defaultValues = resolvePromptValues(current.program, current.defaultValues ?? {});
  const values = resolvePromptValues(current.program, current.values);
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
      <section aria-label="현재 프롬프트 설정" className="prompt-editor prompt-current-settings">
        <p className="muted">변경사항은 자동 저장하며 모든 채팅의 다음 요청부터 사용해요.</p>
        {showRecovery && <ResourceEditorStatus value={shared} hideSyncError />}
        <div className="prompt-editor-fields">
          <section className="settings-group">
            <div className="settings-group-heading">
              <h4>프롬프트 선택</h4>
            </div>
            <div className="settings-group-body">
              <label className="settings-row">
                <span className="settings-row-copy">역할</span>
                <select
                  aria-label="현재 프롬프트 역할"
                  value={role}
                  disabled={busy || dirty}
                  onChange={(event) => {
                    setRole(event.target.value as PromptRole);
                    setSelectedCombo('');
                  }}
                >
                  <option value="main">작문</option>
                  <option value="translation">번역</option>
                </select>
              </label>
              <label className="settings-row">
                <span className="settings-row-copy">프롬프트</span>
                <select
                  aria-label="현재 프롬프트 프리셋"
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
              </label>
              <div className="prompt-current-links">
                {preset && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy || dirty || conflict}
                    onClick={() => void applyPreset(preset.id)}
                  >
                    최신 버전 적용
                  </button>
                )}
                {onEditPrompt && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy || dirty || navigationDisabled}
                    onClick={() => onEditPrompt(preset?.id)}
                  >
                    <ExternalLinkIcon size={16} aria-hidden="true" /> 프롬프트 편집
                  </button>
                )}
              </div>
            </div>
          </section>
          <details className="pc-composer-fold settings-group">
            <summary className="settings-group-heading">
              <ExpandIcon className="pc-disclosure-icon" size={16} aria-hidden="true" />
              <strong>창작 옵션</strong>
              <small>
                {comboValue === 'default'
                  ? '기본값'
                  : comboValue === 'custom'
                    ? '사용자 설정'
                    : selected?.title}
              </small>
            </summary>
            {promptControls(current.program).length || combinations.length ? (
              <div className="settings-group-body prompt-current-options">
                <div className="prompt-combination-toolbar">
                  <label>
                    옵션 조합
                    <select
                      aria-label="옵션 조합"
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
                                ? defaultValues
                                : resolvePromptValues(current.program, item!.values),
                          },
                        }));
                      }}
                    >
                      <option value="default">기본값</option>
                      <option value="custom" disabled>
                        사용자 설정
                      </option>
                      {combinations.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ActionMenu label="옵션 조합 메뉴">
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
                      현재 선택을 새 조합으로 저장
                    </button>
                    <button type="button" onClick={() => setManageCombinations(true)}>
                      조합 관리
                    </button>
                  </ActionMenu>
                </div>
                <fieldset className="prompt-editor-fields" disabled={applying || conflict}>
                  <PromptControlFields
                    program={current.program}
                    values={current.values}
                    onChange={(id, value) => {
                      setSelectedCombo('');
                      edit((draft) => ({
                        ...draft,
                        [role]: {
                          ...draft[role],
                          values: { ...draft[role].values, [id]: value },
                        },
                      }));
                    }}
                  />
                </fieldset>
              </div>
            ) : (
              <p className="muted">이 프롬프트에는 선택할 옵션이 없어요.</p>
            )}
          </details>
          {role === 'main' && (
            <div className="settings-group-body">
              <label className="settings-row settings-row-toggle full">
                <span className="settings-row-copy">
                  <span>에이전트 협업</span>
                  {!current.program.collaboration?.agents.length && (
                    <small>프롬프트 편집에서 협업을 구성해 주세요.</small>
                  )}
                </span>
                <span className="settings-row-control">
                  <Switch
                    aria-label="협업 사용"
                    checked={current.program.collaboration?.enabled ?? false}
                    disabled={!current.program.collaboration?.agents.length || busy || conflict}
                    onChange={(event) =>
                      edit((draft) => ({
                        ...draft,
                        main: {
                          ...draft.main,
                          program: {
                            ...draft.main.program,
                            collaboration: {
                              ...draft.main.program.collaboration!,
                              enabled: event.target.checked,
                            },
                          },
                        },
                      }))
                    }
                  />
                </span>
              </label>
            </div>
          )}
        </div>
        {(conflict || saveError) && (
          <p role="alert">
            {conflict
              ? '다른 곳에서 현재 프롬프트가 바뀌었어요. 현재 선택을 보존했어요. 복구 메뉴에서 저장본을 확인해 주세요.'
              : saveError}
          </p>
        )}
        {(saveError || (dirty && !busy && !state.autosavePending)) && (
          <button
            type="button"
            className="secondary"
            disabled={busy || conflict}
            onClick={() => void save()}
          >
            다시 저장
          </button>
        )}
        {conflict && !showRecovery && <ResourceEditorStatus value={shared} hideSyncError />}
        <p role="status" className="muted">
          {busy || (dirty && !showRecovery) ? '저장 중…' : message}
        </p>
        <Dialog
          open={manageCombinations}
          title="옵션 조합 관리"
          onClose={() => setManageCombinations(false)}
        >
          {combinations.length ? (
            combinations.map((item) => (
              <div key={item.id} className="prompt-combination-toolbar">
                <span>{item.title}</span>
                <DeleteButton
                  path={`/prompt-combinations/${item.id}`}
                  revision={item.revision}
                  title={item.title}
                  onDeleted={async () => {
                    await reload?.();
                  }}
                />
              </div>
            ))
          ) : (
            <p>저장한 조합이 없어요.</p>
          )}
        </Dialog>
        <Dialog
          open={comboOpen}
          title="옵션 조합 저장"
          onClose={() => {
            if (!savingCombo) setComboOpen(false);
          }}
        >
          <label>
            조합 이름
            <input
              aria-label="조합 이름"
              value={comboName}
              maxLength={200}
              disabled={savingCombo}
              onChange={(event) => setComboName(event.target.value)}
            />
          </label>
          {comboError && <p role="alert">{comboError}</p>}
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={savingCombo}
              onClick={() => setComboOpen(false)}
            >
              <CloseIcon size={18} aria-hidden="true" />
              취소
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
              {savingCombo ? '저장 중…' : '저장'}
            </button>
          </div>
        </Dialog>
      </section>
    </ResourceEditorProvider>
  );
}
