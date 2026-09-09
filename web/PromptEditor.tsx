import { DismissibleError } from './DismissibleError.js';
import { DeleteButton } from './DeleteButton.js';
import { ActionMenu } from './ActionMenu.js';
import { CopyIcon } from './ui-icons.js';
import { Save } from 'lucide-react';
import { matchesPromptCombination } from '../core/prompt-combinations.js';
import { booleanPromptDraft } from './prompt-boolean-draft.js';
import { useEffect, useRef, useState } from 'react';
import type {
  ContentRef,
  Library,
  PromptPreset,
  PromptRole,
  SavedPromptCombination,
} from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import {
  validatePromptProgram,
  type ChatPromptControls,
  type PromptProgram,
} from '../core/prompt-program.js';
import { PromptComposer } from './PromptComposer.js';
import { AgentCollaborationEditor, agentCollaborationIssue } from './AgentCollaborationEditor.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { api } from './api.js';
import {
  EditorDraftProvider,
  EditorDraftStatus,
  useServerEditDraft,
} from './editor-workspace-context.js';
import type { PromptDraftModel } from '../core/edit-drafts.js';
import './prompt-editor.css';

const labels: Record<PromptRole, string> = { main: '작문', translation: '번역' };
const defaults: Record<PromptRole, string> = {
  main: DEFAULT_MAIN_PROMPT,
  translation: DEFAULT_TRANSLATION_PROMPT,
};
const roles = ['main', 'translation'] as const;
const keyOf = (value: ContentRef) => `${value.id}@${value.revision}`;
type Draft = {
  source: string;
  base: PromptPreset | null;
  title: string;
  dirty: boolean;
  program: PromptProgram;
};
type Props = {
  initialRole?: PromptRole;
  initialPreset?: PromptPreset | null;
  onSaved?: (preset: PromptPreset, created: boolean) => Promise<void>;
  library: Library;
  reload?: () => Promise<void>;
  onError: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  chatId?: string;
  branchId?: string;
};
const draftFor = (role: PromptRole, preset?: PromptPreset): Draft => ({
  source: preset ? keyOf(preset) : 'builtin',
  base: preset ?? null,
  title: preset?.title ?? `${labels[role]} 사용자 프롬프트`,
  dirty: false,
  program: preset
    ? structuredClone(preset.program)
    : createDefaultPromptProgram(defaults[role], role),
});

export function PromptEditor({
  initialRole = 'main',
  initialPreset,
  onSaved,
  library,
  reload,
  onError,
  onDirtyChange,
  chatId,
  branchId,
}: Props) {
  const [role, setRole] = useState<PromptRole>(initialRole);
  const previewRequestCache = useRef<Record<string, string>>({});
  const [localPresets, setLocalPresets] = useState<PromptPreset[]>([]);
  const [drafts, setDrafts] = useState<Record<PromptRole, Draft>>(
    () =>
      Object.fromEntries(
        roles.map((role) => {
          if (initialPreset !== undefined && role === initialRole)
            return [
              role,
              initialPreset
                ? draftFor(role, initialPreset)
                : { ...draftFor(role), source: 'new', title: '' },
            ];
          return [role, draftFor(role)];
        })
      ) as Record<PromptRole, Draft>
  );
  const [busy, setBusy] = useState(false);
  const [composerDirty, setComposerDirty] = useState<Record<string, boolean>>({});
  const [pendingTemplate, setPendingTemplate] = useState(false);
  const [localCombinations, setLocalCombinations] = useState<SavedPromptCombination[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const draftCache = useRef<Record<string, Draft>>({});
  const controlDraftCache = useRef<Record<string, ChatPromptControls>>({});
  const presets = [
    ...new Map(
      [...(library.promptPresets ?? []), ...localPresets]
        .sort((a, b) => a.revision - b.revision)
        .map((item) => [item.id, item])
    ).values(),
  ];
  const dirty =
    Object.values(composerDirty).some(Boolean) ||
    [...Object.values(drafts), ...Object.values(draftCache.current)].some((draft) => draft.dirty);
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    setDrafts((current) => {
      let next = current;
      for (const role of roles) {
        const draft = current[role];
        const latest = [...(library.promptPresets ?? []), ...localPresets]
          .filter((item) => item.id === (draft.base?.id ?? draft.source.split('@')[0]))
          .sort((a, b) => b.revision - a.revision)[0];
        if (
          latest &&
          !draft.dirty &&
          !composerDirty[`${role}:${draft.source}`] &&
          keyOf(latest) !== keyOf(draft.base ?? { id: '', revision: 0 })
        )
          next = { ...next, [role]: draftFor(role, latest) };
      }
      return next;
    });
  }, [library.promptPresets, localPresets, composerDirty]);
  const draft = drafts[role];
  const model: PromptDraftModel = {
    title: draft.title,
    role,
    program: draft.program,
    values:
      controlDraftCache.current[`${role}:${draft.source}`]?.values ?? draft.base?.values ?? {},
  };
  const shared = useServerEditDraft({
    editorKey: draft.base
      ? `prompt-preset:${draft.base.id}`
      : `new:prompt-preset:${role}:${draft.source}`,
    kind: 'prompt-preset',
    targetId: draft.base?.id ?? null,
    model,
    onRestore: (restored) => {
      const restoredModel = restored.model as PromptDraftModel;
      const base = restored.targetId
        ? {
            ...(restored.baseModel as PromptDraftModel),
            id: restored.targetId,
            revision: restored.baseRevision!,
          }
        : null;
      const source = base ? keyOf(base) : draft.source;
      controlDraftCache.current[`${role}:${source}`] = {
        values: restoredModel.values ?? {},
        combinations: [],
      };
      setDrafts((current) => ({
        ...current,
        [role]: {
          source,
          base,
          title: restoredModel.title,
          program: restoredModel.program,
          dirty: JSON.stringify(restoredModel) !== JSON.stringify(restored.baseModel),
        },
      }));
    },
  });
  const ownedCombinations = [
    ...(library.promptCombinations ?? []),
    ...localCombinations.filter(
      (item) => !library.promptCombinations?.some((saved) => saved.id === item.id)
    ),
  ].filter(
    (item) =>
      draft.base &&
      item.role === role &&
      item.owner?.kind === 'preset' &&
      item.owner.id === draft.base.id
  );
  const collaborationIssue =
    role === 'main'
      ? agentCollaborationIssue(draft.program.collaboration, draft.program.controls)
      : '';
  const edit = (changes: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [role]: { ...current[role], ...changes, dirty: true } }));
    setError('');
    setStatus('');
  };
  function choose(source: string) {
    if (pendingTemplate) return;
    const preset = presets.find((item) => item.role === role && keyOf(item) === source);
    setDrafts((current) => {
      draftCache.current[`${role}:${current[role].source}`] = current[role];
      const cached = draftCache.current[`${role}:${source}`];
      return {
        ...current,
        [role]:
          cached ??
          (source === 'new'
            ? {
                source: 'new',
                base: null,
                title: '',
                dirty: true,
                program: createDefaultPromptProgram(defaults[role], role),
              }
            : draftFor(role, preset)),
      };
    });
    setError('');
    setStatus('');
  }
  async function save(update: boolean) {
    if (pendingTemplate || collaborationIssue || !draft.title.trim() || (update && !draft.base))
      return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const saveModel: PromptDraftModel = {
        title: draft.title.trim(),
        role,
        ...booleanPromptDraft(
          validatePromptProgram(draft.program),
          controlDraftCache.current[`${role}:${draft.source}`]?.values ?? draft.base?.values ?? {}
        ),
      };
      let accepted: PromptPreset;
      if (!update && draft.base) {
        accepted = (await shared.session.copy('prompt-preset', saveModel)).saved as PromptPreset;
      } else accepted = (await shared.session.save(saveModel)).saved as PromptPreset;
      setLocalPresets((current) => [
        ...current.filter((item) => keyOf(item) !== keyOf(accepted)),
        accepted,
      ]);
      const previewRequest = previewRequestCache.current[`${role}:${draft.source}`];
      if (previewRequest !== undefined)
        previewRequestCache.current[`${role}:${keyOf(accepted)}`] = previewRequest;
      const controlDraft = controlDraftCache.current[`${role}:${draft.source}`];
      if (controlDraft) controlDraftCache.current[`${role}:${keyOf(accepted)}`] = controlDraft;
      setComposerDirty((current) => {
        const next = { ...current };
        delete next[`${role}:${draft.source}`];
        return next;
      });
      setDrafts((current) => ({ ...current, [role]: draftFor(role, accepted) }));
      delete draftCache.current[`${role}:${draft.source}`];
      draftCache.current[`${role}:${keyOf(accepted)}`] = draftFor(role, accepted);
      setStatus('프롬프트를 저장했어요.');
      await onSaved?.(accepted, !update);
      await reload?.();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
    } finally {
      setBusy(false);
    }
  }
  const pendingSavedText = draft.source !== 'builtin' && draft.source !== 'new' && !draft.base;
  if (!shared.state.ready) return <EditorDraftStatus value={shared} />;
  return (
    <EditorDraftProvider value={shared}>
      <section
        className="prompt-editor"
        data-testid="prompt-editor"
        aria-label="전체 프롬프트 편집"
      >
        <EditorDraftStatus value={shared} />
        <p className="muted">
          본문·메시지 구성과 옵션을 독립된 프리셋으로 저장해요. 현재 프롬프트에서 불러와 사용할 수
          있어요.
        </p>
        <fieldset className="prompt-editor-fields" disabled={busy}>
          <div className="prompt-editor-row">
            <label>
              역할
              <select
                aria-label="프롬프트 역할"
                disabled={pendingTemplate || !!initialPreset}
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
                  disabled={pendingTemplate}
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
                  {pendingSavedText && (
                    <option value={draft.source}>선택한 프롬프트 불러오는 중…</option>
                  )}
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
                disabled={pendingTemplate}
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
          <fieldset className="prompt-composer-frame" disabled={pendingSavedText}>
            <PromptComposer
              key={`${role}:${draft.source}`}
              program={draft.program}
              initialPreviewRequest={previewRequestCache.current[`${role}:${draft.source}`]}
              onPreviewRequestChange={(value) => {
                previewRequestCache.current[`${role}:${draft.source}`] = value;
              }}
              initialControlDraft={controlDraftCache.current[`${role}:${draft.source}`]}
              onControlDraftChange={(state) => {
                controlDraftCache.current[`${role}:${draft.source}`] = state;
                edit({});
              }}
              onDirtyChange={(value) =>
                setComposerDirty((current) =>
                  current[`${role}:${draft.source}`] === value
                    ? current
                    : { ...current, [`${role}:${draft.source}`]: value }
                )
              }
              onPendingDraftChange={setPendingTemplate}
              savedCombinations={ownedCombinations}
              combinationOwner={draft.base ? { kind: 'preset', id: draft.base.id } : undefined}
              onSaveCombination={
                draft.base &&
                !draft.program.controls.some(
                  (control) => control.type === 'boolean' && control.default === null
                ) &&
                JSON.stringify(draft.program.controls) ===
                  JSON.stringify(draft.base.program.controls)
                  ? async (title, values) => {
                      const accepted = await api<SavedPromptCombination>(
                        '/prompt-combinations',
                        {
                          title,
                          role,
                          values,
                          owner: { kind: 'preset', id: draft.base!.id },
                          expectedRevision: draft.base!.revision,
                        },
                        'POST'
                      );
                      setLocalCombinations((current) => [...current, accepted]);
                      await reload?.();
                    }
                  : undefined
              }
              onChange={(program) => edit({ program })}
              chatId={chatId}
              branchId={branchId}
              role={role}
              controlState={
                draft.base ? { values: draft.base.values ?? {}, combinations: [] } : undefined
              }
            />
            {role === 'main' && (
              <AgentCollaborationEditor
                key={`collaboration:${role}:${draft.source}`}
                value={draft.program.collaboration}
                controls={draft.program.controls}
                models={library.models}
                onChange={(collaboration) => edit({ program: { ...draft.program, collaboration } })}
              />
            )}
          </fieldset>
          <div className="prompt-save-actions">
            <div className="prompt-save-buttons">
              <button
                type="button"
                disabled={
                  pendingSavedText ||
                  pendingTemplate ||
                  !!collaborationIssue ||
                  !draft.title.trim() ||
                  (!!draft.base && !draft.dirty)
                }
                onClick={() => void save(!!draft.base)}
              >
                <Save size={18} aria-hidden="true" /> 저장
              </button>
              <small className="prompt-save-scope">
                {draft.base
                  ? '프리셋에 저장해요. 현재 프롬프트는 바뀌지 않아요.'
                  : '새 프리셋으로 저장해요. 현재 프롬프트에 불러와 사용할 수 있어요.'}
              </small>
              {draft.base && (
                <ActionMenu label="프롬프트 관리" className="prompt-management-menu">
                  {draft.base && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        pendingSavedText ||
                        pendingTemplate ||
                        !!collaborationIssue ||
                        !draft.title.trim()
                      }
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
                        for (const key of Object.keys(draftCache.current))
                          if (draftCache.current[key].base?.id === removed)
                            delete draftCache.current[key];
                        setComposerDirty((current) =>
                          Object.fromEntries(
                            Object.entries(current).filter(([key]) => !key.includes(`:${removed}@`))
                          )
                        );
                        setDrafts(
                          (current) =>
                            Object.fromEntries(
                              roles.map((role) => [
                                role,
                                current[role].base?.id === removed ? draftFor(role) : current[role],
                              ])
                            ) as Record<PromptRole, Draft>
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
        </fieldset>
        <p role="status" className="prompt-status">
          {busy ? '처리 중…' : status}
        </p>
        <details className="prompt-saved-management">
          <summary>이 프롬프트의 옵션 조합 관리</summary>
          <div className="deletion-list">
            {ownedCombinations.map((item) => (
              <div className="deletion-row" key={item.id}>
                <span>
                  {item.title} · 옵션 조합
                  {draft.base &&
                    !matchesPromptCombination(
                      item,
                      { kind: 'preset', id: draft.base.id },
                      role,
                      draft.program
                    ) && <small>옵션 정의가 변경되어 불러올 수 없어요.</small>}
                </span>
                <DeleteButton
                  path={`/prompt-combinations/${encodeURIComponent(item.id)}`}
                  revision={item.revision}
                  title={item.title}
                  onError={onError}
                  onDeleted={async () => {
                    setLocalCombinations((current) =>
                      current.filter((saved) => saved.id !== item.id)
                    );
                    await reload?.();
                  }}
                />
              </div>
            ))}
            {!ownedCombinations.length && (
              <p className="muted">이 프롬프트에 저장된 옵션 조합이 없어요.</p>
            )}
          </div>
        </details>
        {pendingTemplate && (
          <p className="muted">
            미적용 문법 초안이 있어요. 해당 본문에서 적용하거나 되돌린 뒤 저장·전환해 주세요.
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
    </EditorDraftProvider>
  );
}
