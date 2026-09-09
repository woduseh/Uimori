import { Save, Copy, RotateCcw } from 'lucide-react';
import { IconButton } from './IconButton.js';
import './settings-actions.css';
import { ActionMenu } from './ActionMenu.js';
import './prompt-editor.css';
import { DismissibleError } from './DismissibleError.js';
import { useEffect, useId, useRef, useState } from 'react';
import type { Library, PromptRole, PromptWorkspace } from '../core/product.js';
import { api } from './api.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { PromptComposer } from './PromptComposer.js';
import { AgentCollaborationEditor } from './AgentCollaborationEditor.js';
import { combinationOwner } from '../core/prompt-combinations.js';
import { booleanPromptDraft } from './prompt-boolean-draft.js';
import {
  EditorDraftProvider,
  EditorDraftStatus,
  useServerEditDraft,
} from './editor-workspace-context.js';
import type { WorkspaceDraftModel } from '../core/edit-drafts.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';

export function PromptWorkspaceEditor({
  library,
  reload,
  onDirtyChange,
  chatId,
  branchId,
}: {
  library: Library;
  reload?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  chatId?: string;
  branchId?: string;
}) {
  const saveTooltipId = useId();
  const { workspace, error, refresh } = usePromptWorkspace();
  const [draft, setDraft] = useState<PromptWorkspace | null>(null);
  const [role, setRole] = useState<PromptRole>('main');
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [editorVersion, setEditorVersion] = useState(0);
  const emptyModel = useMemoWorkspaceModel();
  const model: WorkspaceDraftModel = draft
    ? { main: draft.main, translation: draft.translation }
    : emptyModel;
  const shared = useServerEditDraft({
    editorKey: 'prompt-workspace:current',
    kind: 'prompt-workspace',
    targetId: 'current',
    model,
    enabled: !!workspace,
    onRestore: (restored) => {
      const current = workspace ?? draft;
      if (!current) return;
      const restoredModel = restored.model as WorkspaceDraftModel;
      setDraft({ ...current, ...restoredModel, revision: restored.baseRevision! });
      setDirty(JSON.stringify(restoredModel) !== JSON.stringify(restored.baseModel));
      setEditorVersion((value) => value + 1);
    },
  });
  useEffect(() => {
    if (!shared.state.ready && !dirty && !busy && !pending) setDraft(workspace);
  }, [workspace, dirty, busy, pending, shared.state.ready]);
  useEffect(() => {
    onDirtyChange?.(dirty || pending || busy);
  }, [dirty, pending, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  async function work(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage('');
    setSaveError('');
    try {
      await action();
    } catch (caught) {
      setSaveError((caught as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!draft || !shared.state.ready)
    return (
      <p role="status" className="settings-loading-status">
        {error || '현재 프롬프트를 불러오는 중이에요…'}{' '}
        <IconButton icon={RotateCcw} label="다시 불러오기" onClick={() => void refresh()} />
      </p>
    );
  const current = draft[role];
  const conflict = !!workspace && workspace.revision > draft.revision;
  const edit = (next: PromptWorkspace) => {
    setDraft(next);
    setDirty(true);
    setMessage('');
  };
  return (
    <EditorDraftProvider value={shared}>
      <section aria-label="현재 프롬프트 설정" className="prompt-editor">
        <EditorDraftStatus value={shared} />
        <p>
          현재 프롬프트는 모든 채팅의 다음 요청에 사용해요. 프리셋을 불러오면 내용과 옵션을
          복사해요.
        </p>
        <fieldset className="prompt-editor-fields" disabled={busy}>
          <label>
            역할
            <select
              aria-label="현재 프롬프트 역할"
              value={role}
              disabled={pending}
              onChange={(event) => setRole(event.target.value as PromptRole)}
            >
              <option value="main">작문</option>
              <option value="translation">번역</option>
            </select>
          </label>
          <label>
            프리셋 불러오기
            <select
              aria-label="현재 프롬프트 프리셋"
              value=""
              disabled={dirty || pending || conflict}
              onChange={(event) => {
                const presetId = event.target.value;
                if (presetId)
                  void work(async () => {
                    await shared.session.flush();
                    const accepted = await api<PromptWorkspace>('/prompt-workspace/apply', {
                      expectedRevision: draft.revision,
                      role,
                      presetId,
                    });
                    setDraft(accepted);
                    await shared.session.reloadSaved();
                    setEditorVersion((value) => value + 1);
                    await refresh();
                    setMessage('프리셋의 내용과 옵션을 현재 프롬프트에 복사했어요.');
                  });
              }}
            >
              <option value="">저장된 프리셋 선택</option>
              {library.promptPresets
                ?.filter((item) => item.role === role)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            현재 프롬프트 이름
            <input
              value={current.title}
              maxLength={160}
              onChange={(event) =>
                edit({ ...draft, [role]: { ...current, title: event.target.value } })
              }
            />
          </label>
          <PromptComposer
            key={`${role}:${editorVersion}`}
            program={current.program}
            role={role}
            chatId={chatId}
            branchId={branchId}
            controlState={{ values: current.values, combinations: [] }}
            savedCombinations={library.promptCombinations}
            combinationOwner={combinationOwner(current, role)}
            onPendingDraftChange={setPending}
            onControlDraftChange={(state) =>
              edit({ ...draft, [role]: { ...current, values: state.values } })
            }
            onSaveCombination={
              workspace &&
              !pending &&
              !conflict &&
              !current.program.controls.some(
                (control) => control.type === 'boolean' && control.default === null
              ) &&
              current.presetId === workspace[role].presetId &&
              JSON.stringify(current.program.controls) ===
                JSON.stringify(workspace[role].program.controls)
                ? async (title, values) => {
                    await api('/prompt-combinations', {
                      title,
                      role,
                      values,
                      workspaceRevision: draft.revision,
                    });
                    await reload?.();
                  }
                : undefined
            }
            onChange={(program) => edit({ ...draft, [role]: { ...current, program } })}
          />
          {role === 'main' && (
            <AgentCollaborationEditor
              value={current.program.collaboration}
              controls={current.program.controls}
              models={library.models}
              onChange={(collaboration) =>
                edit({
                  ...draft,
                  main: { ...current, program: { ...current.program, collaboration } },
                })
              }
            />
          )}
          <div className="form-actions prompt-workspace-actions">
            <span className="prompt-save-control">
              <IconButton
                label="현재 설정 저장"
                icon={Save}
                title=""
                aria-describedby={saveTooltipId}
                disabled={!dirty || pending || conflict}
                onClick={() =>
                  void work(async () => {
                    const accepted = (
                      await shared.session.save({
                        main: {
                          ...draft.main,
                          ...booleanPromptDraft(draft.main.program, draft.main.values),
                        },
                        translation: {
                          ...draft.translation,
                          ...booleanPromptDraft(
                            draft.translation.program,
                            draft.translation.values
                          ),
                        },
                      })
                    ).saved as PromptWorkspace;
                    setDraft(accepted);
                    setDirty(false);
                    setEditorVersion((value) => value + 1);
                    await refresh();
                    setMessage('현재 프롬프트와 옵션을 저장했어요.');
                  })
                }
              />
              <span id={saveTooltipId} className="prompt-save-tooltip" role="tooltip">
                현재 설정 저장
              </span>
            </span>
            <ActionMenu label="현재 프롬프트 저장 메뉴" placement="top">
              <button
                type="button"
                disabled={pending || !current.title.trim()}
                onClick={() =>
                  void work(async () => {
                    await shared.session.copy('prompt-preset', {
                      role,
                      title: current.title,
                      ...booleanPromptDraft(current.program, current.values),
                    });
                    await reload?.();
                    setMessage('독립된 프리셋으로 저장했어요.');
                  })
                }
              >
                <Copy size={18} aria-hidden="true" /> 새 프리셋으로 저장
              </button>
              <button
                type="button"
                onClick={() =>
                  void work(async () => {
                    await shared.session.reloadSaved();
                    setDirty(false);
                    setPending(false);
                    await refresh();
                  })
                }
              >
                <RotateCcw size={18} aria-hidden="true" /> 저장본으로 되돌리기
              </button>
            </ActionMenu>
          </div>
        </fieldset>
        {conflict && (
          <p role="alert">
            다른 곳에서 현재 프롬프트가 바뀌었어요. 현재 입력은 유지했어요. 편집 초안 메뉴에서 최신
            저장본과 비교한 뒤 적용해 주세요.
          </p>
        )}
        <DismissibleError
          message={saveError ? `${saveError} 초안은 유지했어요.` : ''}
          onDismiss={() => setSaveError('')}
        />
        <p role="status">{message || error}</p>
      </section>
    </EditorDraftProvider>
  );
}

function useMemoWorkspaceModel(): WorkspaceDraftModel {
  const [model] = useState<WorkspaceDraftModel>(() => ({
    main: { title: '', program: createDefaultPromptProgram('', 'main'), values: {} },
    translation: { title: '', program: createDefaultPromptProgram('', 'translation'), values: {} },
  }));
  return model;
}
