import { ExpandIcon, ExternalLinkIcon, ResetIcon, SaveIcon, CloseIcon } from './ui-icons.js';
import { useEffect, useRef, useState } from 'react';
import type { Library, PromptRole, PromptWorkspace } from '../core/product.js';
import type { WorkspaceDraftModel } from '../core/edit-drafts.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { resolvePromptValues } from '../core/prompt-program.js';
import { api } from './api.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { PromptControlFields } from './PromptControlFields.js';
import { Switch } from './BooleanControls.js';
import { ActionMenu } from './ActionMenu.js';
import { DeleteButton } from './DeleteButton.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import {
  EditorDraftProvider,
  EditorDraftStatus,
  useServerEditDraft,
} from './editor-workspace-context.js';
import './prompt-editor.css';
import './prompt-composer.css';
import './toggle-row.css';

export function PromptWorkspaceEditor({
  library,
  reload,
  onDirtyChange,
  onEditPrompt,
  navigationDisabled = false,
}: {
  library: Library;
  reload?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onEditPrompt?: (presetId?: string) => void;
  navigationDisabled?: boolean;
}) {
  const { workspace, error, refresh } = usePromptWorkspace();
  const [draft, setDraft] = useState<PromptWorkspace | null>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const [role, setRole] = useState<PromptRole>('main');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [message, setMessage] = useState('');
  const [generation, setGeneration] = useState(0);
  const version = useRef(0);
  const acknowledged = useRef(0);
  const lock = useRef(false);
  const [comboName, setComboName] = useState('');
  const [savingCombo, setSavingCombo] = useState(false);
  const [comboOpen, setComboOpen] = useState(false);
  const [manageCombinations, setManageCombinations] = useState(false);
  const [comboError, setComboError] = useState('');
  const [selectedCombo, setSelectedCombo] = useState('');
  const [emptyModel] = useState<WorkspaceDraftModel>(() => ({
    main: { title: '', program: createDefaultPromptProgram('', 'main'), values: {} },
    translation: { title: '', program: createDefaultPromptProgram('', 'translation'), values: {} },
  }));
  const shared = useServerEditDraft({
    editorKey: 'prompt-workspace:current',
    kind: 'prompt-workspace',
    targetId: 'current',
    model: draft ? { main: draft.main, translation: draft.translation } : emptyModel,
    enabled: !!workspace,
    onRestore: (restored) => {
      if (lock.current) return;
      const base = workspace ?? currentDraft.current;
      if (!base) return;
      const model = restored.model as WorkspaceDraftModel;
      const next = { ...base, ...model, revision: restored.baseRevision! };
      currentDraft.current = next;
      setDraft(next);
      const restoredDirty = JSON.stringify(model) !== JSON.stringify(restored.baseModel);
      setDirty(restoredDirty);
      if (!restoredDirty) {
        acknowledged.current = version.current;
        setSaveError('');
      }
    },
  });
  useEffect(() => {
    if (!shared.state.ready && !dirty && !busy) setDraft(workspace);
  }, [workspace, shared.state.ready, dirty, busy]);
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // A save acknowledges only the input it sent. Restored drafts require explicit retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: save reads latest input via refs; edits and completed saves alone schedule a write.
  useEffect(() => {
    if (
      !generation ||
      generation <= acknowledged.current ||
      busy ||
      saveError ||
      !shared.state.ready ||
      shared.state.conflict
    )
      return;
    const timer = setTimeout(() => {
      void save();
    }, 300);
    return () => clearTimeout(timer);
  }, [generation, busy, saveError, shared.state.ready, shared.state.conflict]);

  async function save() {
    const next = currentDraft.current;
    if (!next || lock.current || shared.state.conflict) return;
    lock.current = true;
    setBusy(true);
    setSaveError('');
    const sentVersion = version.current;
    try {
      const accepted = (
        await shared.session.save({ main: next.main, translation: next.translation })
      ).saved as PromptWorkspace;
      acknowledged.current = sentVersion;
      const latest = currentDraft.current!;
      const unsaved = shared.session.snapshot().dirty || version.current !== sentVersion;
      if (unsaved && version.current === sentVersion) {
        version.current++;
        setGeneration(version.current);
      }
      const updated = unsaved
        ? { ...accepted, main: latest.main, translation: latest.translation }
        : accepted;
      currentDraft.current = updated;
      setDraft(updated);
      setDirty(unsaved);
      setMessage('변경사항을 자동 저장했어요.');
      await refresh();
    } catch (caught) {
      setSaveError(`${(caught as Error).message} 선택한 옵션은 유지했어요.`);
      await refresh();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function edit(next: PromptWorkspace) {
    currentDraft.current = next;
    setDraft(next);
    setDirty(true);
    setMessage('');
    version.current++;
    setGeneration(version.current);
    shared.session.setModel({ main: next.main, translation: next.translation });
  }
  async function applyPreset(presetId: string) {
    if (!draft || lock.current || dirty) return;
    lock.current = true;
    setBusy(true);
    setApplying(true);
    setSaveError('');
    try {
      await shared.session.flush();
      const accepted = await api<PromptWorkspace>('/prompt-workspace/apply', {
        expectedRevision: draft.revision,
        role,
        presetId,
      });
      await shared.session.reloadSaved();
      const restored = shared.session.snapshot().draft!;
      const reloaded = {
        ...accepted,
        ...(restored.model as WorkspaceDraftModel),
        revision: restored.baseRevision!,
      };
      currentDraft.current = reloaded;
      setDraft(reloaded);
      setDirty(false);
      setSelectedCombo('');
      setMessage('프롬프트와 기본 옵션을 적용했어요.');
      await refresh();
    } catch (caught) {
      setSaveError((caught as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
      setApplying(false);
    }
  }
  if (!draft || !shared.state.ready)
    return (
      <p role="status">
        {error || '현재 프롬프트를 불러오는 중이에요…'}{' '}
        <IconButton icon={ResetIcon} label="다시 불러오기" onClick={() => void refresh()} />
      </p>
    );
  const current = draft[role];
  const conflict = !!workspace && workspace.revision > draft.revision && !busy;
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
  const showRecovery =
    shared.state.conflict || !!saveError || (dirty && generation <= acknowledged.current);
  return (
    <EditorDraftProvider value={shared}>
      <section aria-label="현재 프롬프트 설정" className="prompt-editor prompt-current-settings">
        <p className="muted">변경사항은 자동 저장하며 모든 채팅의 다음 요청부터 사용해요.</p>
        {showRecovery && <EditorDraftStatus value={shared} hideSyncError />}
        <div className="prompt-editor-fields">
          <label>
            역할
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
          <label>
            프롬프트
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
          <details className="pc-composer-fold">
            <summary>
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
            {current.program.controls.length || combinations.length ? (
              <div className="prompt-current-options">
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
                        edit({
                          ...currentDraft.current!,
                          [role]: {
                            ...currentDraft.current![role],
                            values:
                              id === 'default'
                                ? defaultValues
                                : resolvePromptValues(current.program, item!.values),
                          },
                        });
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
                <fieldset
                  className="prompt-editor-fields"
                  disabled={applying || conflict || shared.state.conflict}
                >
                  <PromptControlFields
                    program={current.program}
                    values={current.values}
                    onChange={(id, value) => {
                      setSelectedCombo('');
                      edit({
                        ...currentDraft.current!,
                        [role]: {
                          ...currentDraft.current![role],
                          values: { ...currentDraft.current![role].values, [id]: value },
                        },
                      });
                    }}
                  />
                </fieldset>
              </div>
            ) : (
              <p className="muted">이 프롬프트에는 선택할 옵션이 없어요.</p>
            )}
          </details>
          {role === 'main' && (
            <label className="toggle-row full">
              <span className="toggle-row-text">
                <span>에이전트 협업</span>
                {!current.program.collaboration?.agents.length && (
                  <small>프롬프트 편집에서 협업을 구성해 주세요.</small>
                )}
              </span>
              <Switch
                aria-label="협업 사용"
                checked={current.program.collaboration?.enabled ?? false}
                disabled={!current.program.collaboration?.agents.length || busy || conflict}
                onChange={(event) =>
                  edit({
                    ...draft,
                    main: {
                      ...current,
                      program: {
                        ...current.program,
                        collaboration: {
                          ...current.program.collaboration!,
                          enabled: event.target.checked,
                        },
                      },
                    },
                  })
                }
              />
            </label>
          )}
        </div>
        {(conflict || saveError || shared.state.error) && (
          <p role="alert">
            {conflict
              ? '다른 곳에서 현재 프롬프트가 바뀌었어요. 현재 선택을 보존했어요. 복구 메뉴에서 저장본을 확인해 주세요.'
              : saveError || shared.state.error}
          </p>
        )}
        {(saveError || (dirty && !busy && generation <= acknowledged.current)) && (
          <button
            type="button"
            className="secondary"
            disabled={busy || conflict || shared.state.conflict}
            onClick={() => void save()}
          >
            다시 저장
          </button>
        )}
        {conflict && !showRecovery && <EditorDraftStatus value={shared} hideSyncError />}
        <p role="status" className="muted">
          {busy || (dirty && !showRecovery) ? '저장 중…' : message || error}
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
              disabled={!comboName.trim() || savingCombo}
              onClick={async () => {
                setSavingCombo(true);
                try {
                  await api('/prompt-combinations', {
                    title: comboName.trim(),
                    role,
                    values: current.values,
                    workspaceRevision: draft.revision,
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
    </EditorDraftProvider>
  );
}
