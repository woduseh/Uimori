import { useEffect, useRef, useState } from 'react';
import type { Library, PromptRole, PromptWorkspace } from '../core/product.js';
import { api } from './api.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { PromptComposer } from './PromptComposer.js';
import { AgentCollaborationEditor } from './AgentCollaborationEditor.js';

export function PromptWorkspaceEditor({
  library,
  reload,
  onError,
  onDirtyChange,
  chatId,
  branchId,
}: {
  library: Library;
  reload?: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  chatId?: string;
  branchId?: string;
}) {
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
  useEffect(() => {
    if (!dirty && !busy && !pending) setDraft(workspace);
  }, [workspace, dirty, busy, pending]);
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
      onError('');
    } catch (caught) {
      setSaveError((caught as Error).message);
      onError((caught as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!draft)
    return (
      <p role="status">
        {error || '현재 프롬프트를 불러오는 중이에요…'}{' '}
        <button type="button" onClick={() => void refresh()}>
          다시 불러오기
        </button>
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
    <section aria-label="현재 프롬프트 설정" className="prompt-editor">
      <p>
        현재 프롬프트는 모든 채팅의 다음 요청에 사용해요. 프리셋을 불러오면 내용과 옵션을 복사해요.
      </p>
      <fieldset disabled={busy}>
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
                  const accepted = await api<PromptWorkspace>('/prompt-workspace/apply', {
                    expectedRevision: draft.revision,
                    role,
                    presetId,
                  });
                  setDraft(accepted);
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
          onPendingDraftChange={setPending}
          onControlDraftChange={(state) =>
            edit({ ...draft, [role]: { ...current, values: state.values } })
          }
          onSaveCombination={async (title, values) => {
            await api('/prompt-combinations', { title, role, values });
            await reload?.();
          }}
          onChange={(program) => edit({ ...draft, [role]: { ...current, program } })}
          onError={onError}
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
        {role === 'translation' && (
          <fieldset>
            <legend>번역 거절 감지와 재요청</legend>
            <label>
              거절 판정 모델
              <select
                aria-label="번역 거절 판정 모델"
                value={draft.translationPolicy.refusalModel?.id ?? ''}
                onChange={(event) =>
                  edit({
                    ...draft,
                    translationPolicy: {
                      ...draft.translationPolicy,
                      refusalModel: event.target.value ? { id: event.target.value } : null,
                    },
                  })
                }
              >
                <option value="">판정 모델 미지정</option>
                {library.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.title} · {model.modelId}
                  </option>
                ))}
              </select>
            </label>
            <label>
              자동 재요청 횟수
              <input
                aria-label="번역 자동 재요청 횟수"
                type="number"
                min={0}
                max={5}
                step={1}
                value={draft.translationPolicy.maxRetries}
                onChange={(event) =>
                  edit({
                    ...draft,
                    translationPolicy: {
                      ...draft.translationPolicy,
                      maxRetries: event.target.valueAsNumber,
                    },
                  })
                }
              />
            </label>
            <small>최초 번역 이후 추가 요청 횟수예요. 기본 1회, 0이면 자동 재요청을 꺼요.</small>
            <label>
              번역 작업 전체 호출 한도
              <input
                aria-label="번역 전체 호출 한도"
                type="number"
                min={2}
                max={64}
                step={1}
                value={draft.translationPolicy.maxCalls}
                onChange={(event) =>
                  edit({
                    ...draft,
                    translationPolicy: {
                      ...draft.translationPolicy,
                      maxCalls: event.target.valueAsNumber,
                    },
                  })
                }
              />
            </label>
          </fieldset>
        )}
        <div className="form-actions">
          <button
            type="button"
            disabled={!dirty || pending || conflict}
            onClick={() =>
              void work(async () => {
                const accepted = await api<PromptWorkspace>(
                  '/prompt-workspace',
                  {
                    expectedRevision: draft.revision,
                    main: draft.main,
                    translation: draft.translation,
                    translationPolicy: draft.translationPolicy,
                  },
                  'PUT'
                );
                setDraft(accepted);
                setDirty(false);
                setEditorVersion((value) => value + 1);
                await refresh();
                setMessage('현재 프롬프트와 옵션을 저장했어요.');
              })
            }
          >
            현재 설정 저장
          </button>
          <button
            type="button"
            disabled={pending || !current.title.trim()}
            onClick={() =>
              void work(async () => {
                await api('/prompt-presets', {
                  role,
                  title: current.title,
                  program: current.program,
                  values: current.values,
                });
                await reload?.();
                setMessage('독립된 프리셋으로 저장했어요.');
              })
            }
          >
            현재 내용을 새 프리셋으로 저장
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(workspace);
              setDirty(false);
              setPending(false);
              setEditorVersion((value) => value + 1);
              void refresh();
            }}
          >
            저장된 설정 다시 불러오기
          </button>
        </div>
      </fieldset>
      {conflict && dirty && (
        <p role="alert">
          다른 곳에서 현재 프롬프트가 바뀌었어요. 초안은 유지했어요. 최신 설정을 다시 불러온 뒤
          적용해 주세요.
        </p>
      )}
      {saveError && <p role="alert">{saveError} 초안은 유지했어요.</p>}
      <p role="status">{message || error}</p>
    </section>
  );
}
