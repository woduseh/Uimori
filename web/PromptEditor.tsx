import { promptControls } from '../core/risu-prompt.js';
import { DismissibleError } from './DismissibleError.js';
import { DeleteButton } from './DeleteButton.js';
import { ActionMenu } from './ActionMenu.js';
import { CopyIcon, SaveIcon } from './ui-icons.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NativeRisuPresetEditor } from './NativeRisuPresetEditor.js';
import { RisuExportButton } from './RisuExportButton.js';
import type {
  ContentRef,
  Library,
  PromptPreset,
  PromptPresetSummary,
  PromptRole,
} from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { validateRisuPrompt, reconcilePromptValues } from '../core/risu-prompt.js';
import { AgentCollaborationEditor, agentCollaborationIssue } from './AgentCollaborationEditor.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import {
  ResourceEditorProvider,
  ResourceEditorStatus,
  ResourceEditorActions,
  useResourceEditor,
  useEditorSaveCommand,
} from './resource-editor.js';
import { editableResource, type PromptEditModel } from '../core/resource-editing.js';
import { ResourceEditorSession } from './resource-editor-session.js';
import './prompt-editor.css';

const labels: Record<PromptRole, string> = { main: '작문', translation: '번역' };
const defaults: Record<PromptRole, string> = {
  main: DEFAULT_MAIN_PROMPT,
  translation: DEFAULT_TRANSLATION_PROMPT,
};
const roles = ['main', 'translation'] as const;
const keyOf = (value: ContentRef) => `${value.id}@${value.revision}`;
type Props = {
  heading?: ReactNode;
  headingTrailing?: ReactNode;
  initialRole?: PromptRole;
  initialPreset?: PromptPreset | null;
  onSaved?: (preset: PromptPreset, created: boolean) => Promise<void>;
  library: Library;
  reload?: () => Promise<void>;
  onError: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  chatId?: string;
};
function createSession(role: PromptRole, preset?: PromptPreset | PromptPresetSummary | null) {
  return new ResourceEditorSession({
    editorKey: preset
      ? `prompt-preset:${preset.id}`
      : `new:prompt-preset:${role}:${preset === null ? 'new' : 'builtin'}`,
    kind: 'prompt-preset',
    targetId: preset?.id ?? null,
    initialModel:
      preset && 'program' in preset
        ? editableResource('prompt-preset', preset)
        : {
            title: preset?.title ?? (preset === null ? '' : `${labels[role]} 사용자 프롬프트`),
            role,
            program: createDefaultRisuPrompt(defaults[role], role),
            values: {},
          },
  });
}

export function PromptEditor({
  heading,
  headingTrailing,
  initialRole = 'main',
  initialPreset,
  onSaved,
  library,
  reload,
  onError,
  onDirtyChange,
}: Props) {
  const [role, setRole] = useState<PromptRole>(initialRole);
  const [localPresets, setLocalPresets] = useState<PromptPreset[]>([]);
  // Tabs retain session owners, never copies of their models or dirty flags.
  const [selectedSessions, setSelectedSessions] = useState<
    Record<PromptRole, ResourceEditorSession>
  >(
    () =>
      Object.fromEntries(
        roles.map((role) => [
          role,
          createSession(role, role === initialRole ? initialPreset : undefined),
        ])
      ) as Record<PromptRole, ResourceEditorSession>
  );
  const cache = useRef(
    new Map(Object.values(selectedSessions).map((session) => [session.editorKey, session]))
  );
  const session = selectedSessions[role];
  const shared = useResourceEditor<PromptEditModel>(session);
  const { model, state, setModel } = shared;
  const base: PromptPreset | null = state.document.targetId
    ? {
        ...(state.document.baseModel as PromptEditModel),
        id: state.document.targetId,
        revision: state.document.baseRevision!,
      }
    : null;
  const draft = {
    ...model,
    base,
    source: base ? keyOf(base) : session.options.editorKey.split(':').at(-1)!,
    dirty: state.dirty,
  };
  const [placing, setPlacing] = useState(false);
  const busy = state.saving || placing;
  const pendingTemplate = state.local.unappliedFields.length > 0;
  const [collaborationExpanded, setCollaborationExpanded] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const presets = [
    ...new Map(
      [...(library.promptPresets ?? []), ...localPresets]
        .sort((a, b) => a.revision - b.revision)
        .map((item) => [item.id, item])
    ).values(),
  ];
  const dirty = [...cache.current.values()].some((session) => session.snapshot().dirty);
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    const document = session.snapshot().document;
    const latest = [...(library.promptPresets ?? []), ...localPresets].find(
      (item) => item.id === document.targetId && item.revision > (document.baseRevision ?? 0)
    );
    if (latest && document.baseRevision !== null)
      void session.refresh().catch((cause) => setError((cause as Error).message));
  }, [session, library.promptPresets, localPresets]);
  const collaborationIssue =
    role === 'main'
      ? agentCollaborationIssue(model.program.collaboration, promptControls(model.program))
      : '';
  const edit = (
    action: Partial<PromptEditModel> | ((current: PromptEditModel) => PromptEditModel)
  ) => {
    setModel((current) =>
      typeof action === 'function' ? action(current) : { ...current, ...action }
    );
    setError('');
    setStatus('');
  };
  function choose(source: string) {
    if (pendingTemplate || busy) return;
    const preset = presets.find((item) => item.role === role && keyOf(item) === source);
    const key = preset ? `prompt-preset:${preset.id}` : `new:prompt-preset:${role}:${source}`;
    let next = cache.current.get(key);
    if (!next) {
      next = createSession(role, source === 'new' ? null : preset);
      cache.current.set(next.editorKey, next);
    }
    setSelectedSessions((current) => ({ ...current, [role]: next }));
    setError('');
    setStatus('');
  }
  async function save(update: boolean) {
    if (busy || !state.ready || collaborationIssue || !model.title.trim() || (update && !base))
      return false;
    setError('');
    setStatus('');
    try {
      const previousKey = session.editorKey;
      const saveModel: PromptEditModel = {
        ...model,
        title: model.title.trim(),
        program: validateRisuPrompt(model.program),
      };
      const accepted = (await session.save(saveModel, { copy: !update && !!base }))
        .saved as PromptPreset;
      cache.current.delete(previousKey);
      cache.current.set(session.editorKey, session);
      setLocalPresets((current) => [
        ...current.filter((item) => item.id !== accepted.id),
        accepted,
      ]);
      setStatus('프롬프트를 저장했어요.');
      // Placement is a separate write; neither it nor a list read can undo this save.
      setPlacing(true);
      const warnings: string[] = [];
      try {
        await onSaved?.(accepted, !update);
      } catch (caught) {
        warnings.push(
          `프롬프트는 저장됐어요. 폴더에 배치하지 못했어요. ${(caught as Error).message}`
        );
      }
      try {
        await reload?.();
      } catch (caught) {
        warnings.push(
          `프롬프트는 저장됐어요. 목록을 다시 불러오지 못했어요. ${(caught as Error).message}`
        );
      }
      if (warnings.length) {
        const warning = warnings.join('\n');
        setError(warning);
        onError(warning);
      }
      return !session.snapshot().dirty;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    } finally {
      setPlacing(false);
    }
  }
  useEditorSaveCommand(session, () => {
    if ([...cache.current.values()].some((other) => other !== session && other.snapshot().dirty))
      throw new Error(
        '다른 역할이나 프리셋에도 미저장 초안이 있어요. 계속 편집에서 각 초안을 저장한 뒤 이동해 주세요.'
      );
    return save(!!base);
  });
  if (!state.ready) return <ResourceEditorStatus value={shared} />;
  const saveActions = (
    <div className="prompt-save-actions">
      <div className="prompt-save-buttons">
        <button
          type="button"
          disabled={
            busy || !!collaborationIssue || !draft.title.trim() || (!!draft.base && !draft.dirty)
          }
          className="primary native-editor-save"
          onClick={() => void save(!!draft.base)}
        >
          <SaveIcon size={18} aria-hidden="true" /> <span>프리셋 저장</span>
        </button>
        {draft.base && (
          <ActionMenu label="프롬프트 관리" className="prompt-management-menu">
            <RisuExportButton
              kind="prompt-presets"
              id={draft.base.id}
              revision={draft.base.revision}
              title={draft.base.title}
              disabled={busy || draft.dirty || pendingTemplate}
              onError={setError}
            />
            {draft.base && (
              <button
                type="button"
                className="secondary"
                disabled={busy || !!collaborationIssue || !draft.title.trim()}
                onClick={() => void save(false)}
              >
                <CopyIcon size={18} aria-hidden="true" /> 복사본으로 저장
              </button>
            )}
            {draft.base && (
              <DeleteButton
                path={`/prompt-presets/${encodeURIComponent(draft.base.id)}`}
                revision={draft.base.revision}
                title={draft.base.title}
                label="프롬프트 삭제"
                disabled={busy}
                onError={onError}
                onDeleted={async () => {
                  const removed = draft.base!.id;
                  setLocalPresets((current) => current.filter((item) => item.id !== removed));
                  for (const [key, cached] of cache.current) {
                    if (cached.snapshot().document.targetId === removed) cache.current.delete(key);
                  }
                  setSelectedSessions(
                    (current) =>
                      Object.fromEntries(
                        roles.map((role) => {
                          if (current[role].snapshot().document.targetId !== removed)
                            return [role, current[role]];
                          const next = createSession(role);
                          cache.current.set(next.editorKey, next);
                          return [role, next];
                        })
                      ) as Record<PromptRole, ResourceEditorSession>
                  );
                  await reload?.();
                  setStatus('프롬프트를 삭제했어요.');
                }}
              />
            )}
          </ActionMenu>
        )}
      </div>
    </div>
  );
  const metadata = (
    <div className="prompt-metadata-fields">
      <div className="prompt-editor-row">
        <label>
          역할
          <select
            aria-label="프롬프트 역할"
            disabled={busy || pendingTemplate || !!initialPreset}
            value={role}
            onChange={(event) => {
              setRole(event.target.value as PromptRole);
              setError('');
              setStatus('');
            }}
          >
            <option value="main">작문</option>
            <option value="translation">번역</option>
          </select>
        </label>
        {initialPreset === undefined && (
          <label>
            불러올 프롬프트
            <select
              aria-label="불러올 프롬프트"
              disabled={busy || pendingTemplate}
              value={draft.source === 'builtin' || draft.source === 'new' ? '' : draft.source}
              onChange={(event) => choose(event.target.value)}
            >
              <option value="" disabled>
                저장된 프롬프트 선택
              </option>
              {presets
                .filter((item) => item.role === role)
                .map((item) => (
                  <option key={keyOf(item)} value={keyOf(item)}>
                    {item.title}
                  </option>
                ))}
              {draft.base && !presets.some((item) => keyOf(item) === draft.source) && (
                <option value={draft.source}>{draft.title} · 편집 중</option>
              )}
            </select>
          </label>
        )}
        {initialPreset === undefined && (
          <button
            type="button"
            className="secondary"
            disabled={busy || pendingTemplate}
            onClick={() => choose('new')}
          >
            새 프롬프트 생성
          </button>
        )}
      </div>
      <label>
        프롬프트 이름
        <input
          aria-label="프롬프트 이름"
          maxLength={160}
          value={draft.title}
          onChange={(event) => edit({ title: event.target.value })}
        />
      </label>
    </div>
  );
  return (
    <ResourceEditorProvider value={shared}>
      <section
        className="prompt-editor"
        data-testid="prompt-editor"
        aria-label="전체 프롬프트 편집"
      >
        <div className="prompt-editor-heading">
          {heading ?? <h2>{draft.title || '프롬프트 편집'}</h2>}
          <ResourceEditorActions value={shared} hideSyncError />
          {saveActions}
          {headingTrailing}
        </div>
        {initialPreset === undefined && (
          <p className="muted">
            본문·메시지 구성과 옵션을 독립된 프리셋으로 저장해요. 현재 프롬프트에서 불러와 사용할 수
            있어요.
          </p>
        )}
        <fieldset
          className={`prompt-editor-fields${initialPreset !== undefined ? ' prompt-preset-fields' : ''}`}
          disabled={busy}
        >
          {initialPreset === undefined && metadata}
          <fieldset className="prompt-composer-frame">
            <NativeRisuPresetEditor
              key={`${role}:${session.options.editorKey}`}
              program={draft.program}
              metadata={initialPreset !== undefined ? metadata : undefined}
              values={model.values}
              onValuesChange={(values) => edit({ values })}
              onChange={(program) =>
                edit((current) => ({
                  ...current,
                  program,
                  values: reconcilePromptValues(program, current.values).values,
                }))
              }
              collaboration={
                role === 'main' ? (
                  <AgentCollaborationEditor
                    expanded={collaborationExpanded}
                    onExpandedChange={setCollaborationExpanded}
                    value={draft.program.collaboration}
                    controls={promptControls(draft.program)}
                    models={library.models}
                    onChange={(collaboration) =>
                      edit((current) => ({
                        ...current,
                        program: { ...current.program, collaboration },
                      }))
                    }
                  />
                ) : undefined
              }
            />
          </fieldset>
        </fieldset>
        <p role="status" className="prompt-status">
          {busy ? '처리 중…' : status}
        </p>
        {pendingTemplate && (
          <p className="muted">
            원문 입력은 저장할 때 함께 검증해요. 오류가 있으면 입력을 유지하고 알려드려요.
          </p>
        )}
        {draft.dirty && (
          <p className="muted prompt-unsaved">편집 중인 프롬프트를 아직 저장하지 않았어요.</p>
        )}
        <DismissibleError
          message={error ? `${error} 편집 내용은 유지했어요.` : ''}
          onDismiss={() => setError('')}
        />
      </section>
    </ResourceEditorProvider>
  );
}
