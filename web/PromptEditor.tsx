import { DeleteButton } from './DeleteButton.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { CopyIcon } from './ui-icons.js';
import { Maximize, Minimize, RotateCcw } from 'lucide-react';
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
  selections?: Partial<Record<PromptRole, ContentRef | null>>;
  onApply?: (role: PromptRole, reference: ContentRef | null) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
  chatId?: string;
  branchId?: string;
  promptControls?: Record<string, ChatPromptControls>;
  onSaveControls?: (reference: ContentRef, state: ChatPromptControls) => Promise<void>;
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
  selections,
  onApply,
  onDirtyChange,
  chatId,
  branchId,
  promptControls,
  onSaveControls,
}: Props) {
  const [role, setRole] = useState<PromptRole>(initialRole);
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
          const ref = selections?.[role];
          const preset = library.promptPresets?.find(
            (item) => item.role === role && ref && keyOf(item) === keyOf(ref)
          );
          return [
            role,
            ref && !preset ? { ...draftFor(role), source: keyOf(ref) } : draftFor(role, preset),
          ];
        })
      ) as Record<PromptRole, Draft>
  );
  const [busy, setBusy] = useState(false);
  const [composerDirty, setComposerDirty] = useState<Record<string, boolean>>({});
  const [pendingTemplate, setPendingTemplate] = useState(false);
  const [localCombinations, setLocalCombinations] = useState<SavedPromptCombination[]>([]);
  const [expanded, setExpanded] = useState(false);
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
    let alive = true;
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
    const missing = roles.flatMap((role) => {
      const ref = selections?.[role];
      return ref &&
        !library.promptPresets?.some((item) => item.id === ref.id) &&
        !localPresets.some((item) => item.id === ref.id)
        ? [{ role, ref }]
        : [];
    });
    void Promise.all(
      missing.map(async ({ role, ref }) => ({
        role,
        item: await api<PromptPreset>(`/prompt-presets/${ref.id}`),
      }))
    )
      .then((results) => {
        if (!alive || !results.length) return;
        setLocalPresets((current) => [
          ...current,
          ...results
            .map((result) => result.item)
            .filter((item) => !current.some((prior) => keyOf(prior) === keyOf(item))),
        ]);
        setDrafts((current) => {
          const next = { ...current };
          for (const { role, item } of results)
            if (!current[role].dirty && current[role].source.split('@')[0] === item.id)
              next[role] = draftFor(role, item);
          return next;
        });
      })
      .catch((caught) => {
        if (alive) {
          setError(caught.message);
          onError(caught.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [selections, library.promptPresets, localPresets, composerDirty, onError]);
  const draft = drafts[role];
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
  async function apply(reference: ContentRef | null) {
    if (!onApply) return;
    setBusy(true);
    setError('');
    setStatus('');
    onError('');
    try {
      if (await onApply(role, reference))
        setStatus(
          reference
            ? '선택한 프롬프트를 이야기에 적용했어요.'
            : '앱 기본 프롬프트를 이야기에 적용했어요.'
        );
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }
  async function save(update: boolean, alsoApply: boolean) {
    if (pendingTemplate || collaborationIssue || !draft.title.trim() || (update && !draft.base))
      return;
    setBusy(true);
    setError('');
    setStatus('');
    onError('');
    try {
      const accepted = await api<PromptPreset>(
        update ? `/prompt-presets/${draft.base!.id}` : '/prompt-presets',
        {
          title: draft.title.trim(),
          role,
          program: validatePromptProgram(draft.program),
          ...(update ? { expectedRevision: draft.base!.revision } : {}),
        },
        update ? 'PUT' : 'POST'
      );
      setLocalPresets((current) => [
        ...current.filter((item) => keyOf(item) !== keyOf(accepted)),
        accepted,
      ]);
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
      if (alsoApply && onApply) {
        const applied = await onApply(role, { id: accepted.id, revision: accepted.revision });
        setStatus(
          applied
            ? '프롬프트를 저장하고 이야기에 적용했어요.'
            : '프롬프트는 저장했어요. 이야기 적용을 다시 시도해 주세요.'
        );
      }
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }
  const selected = selections?.[role];
  const selectedPreset = selected ? presets.find((item) => keyOf(item) === keyOf(selected)) : null;
  const pendingSavedText = draft.source !== 'builtin' && draft.source !== 'new' && !draft.base;
  return (
    <section
      className={`prompt-editor${expanded ? ' prompt-editor-expanded' : ''}`}
      data-testid="prompt-editor"
      aria-label="전체 프롬프트 편집"
    >
      <p className="muted">
        본문과 메시지 구성을 하나의 프롬프트로 저장해요. 인물·자료와 이야기별 옵션은 선택한 설정을
        사용해요.
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
        {onApply && (
          <p className="prompt-applied">
            이 이야기에서 사용:{' '}
            <strong>
              {selected ? (selectedPreset?.title ?? '저장된 프롬프트') : '앱 기본 프롬프트'}
            </strong>
          </p>
        )}
        <label>
          프롬프트 이름
          <input
            aria-label="프롬프트 이름"
            maxLength={160}
            value={draft.title}
            onChange={(event) => edit({ title: event.target.value })}
          />
        </label>
        <div className="prompt-editor-tools">
          <IconButton
            label={expanded ? '편집 영역 줄이기' : '편집 영역 넓히기'}
            icon={expanded ? Minimize : Maximize}
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          />
        </div>
        <fieldset className="prompt-composer-frame" disabled={pendingSavedText}>
          <PromptComposer
            key={`${role}:${draft.source}`}
            program={draft.program}
            initialControlDraft={controlDraftCache.current[`${role}:${draft.source}`]}
            onControlDraftChange={(state) => {
              controlDraftCache.current[`${role}:${draft.source}`] = state;
            }}
            onDirtyChange={(value) =>
              setComposerDirty((current) =>
                current[`${role}:${draft.source}`] === value
                  ? current
                  : { ...current, [`${role}:${draft.source}`]: value }
              )
            }
            onPendingDraftChange={setPendingTemplate}
            promptReference={draft.base ?? undefined}
            savedCombinations={[
              ...(library.promptCombinations ?? []),
              ...localCombinations.filter(
                (item) => !library.promptCombinations?.some((saved) => saved.id === item.id)
              ),
            ]}
            onSaveCombination={
              draft.base && !draft.dirty
                ? async (title, values) => {
                    const accepted = await api<SavedPromptCombination>(
                      '/prompt-combinations',
                      {
                        title,
                        prompt: { id: draft.base!.id, revision: draft.base!.revision },
                        values,
                      },
                      'POST'
                    );
                    setLocalCombinations((current) => [...current, accepted]);
                    await reload?.();
                  }
                : undefined
            }
            onChange={(program) => edit({ program })}
            onError={(message) => {
              setError(message);
              onError(message);
            }}
            chatId={chatId}
            branchId={branchId}
            role={role}
            controlState={draft.base ? promptControls?.[keyOf(draft.base)] : undefined}
            onSaveControls={
              draft.base && !draft.dirty && onSaveControls
                ? (state) =>
                    onSaveControls({ id: draft.base!.id, revision: draft.base!.revision }, state)
                : undefined
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
          <small className="prompt-save-scope">
            {draft.base
              ? '수정 저장은 이 프롬프트를 사용하는 채팅의 다음 실행부터 반영돼요.'
              : '새 프롬프트로 저장해요. 사용할 채팅은 따로 선택해요.'}
            {onApply && ' 이 채팅에 적용하면 현재 채팅의 프롬프트 선택을 바꿔요.'}
          </small>
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
              onClick={() => void save(!!draft.base, false)}
            >
              {draft.base ? '수정 저장' : '새 프롬프트 저장'}
            </button>
            {onApply &&
              (draft.dirty ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    pendingSavedText ||
                    pendingTemplate ||
                    !!collaborationIssue ||
                    !draft.title.trim()
                  }
                  onClick={() => void save(Boolean(draft.base), true)}
                >
                  저장하고 적용
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={pendingSavedText || pendingTemplate || draft.source === 'new'}
                  onClick={() =>
                    void apply(
                      draft.base ? { id: draft.base.id, revision: draft.base.revision } : null
                    )
                  }
                >
                  이 채팅에 적용
                </button>
              ))}
            {(draft.base || onApply) && (
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
                    onClick={() => void save(false, false)}
                  >
                    <CopyIcon size={18} aria-hidden="true" /> 복사본으로 저장
                  </button>
                )}
                {onApply && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={pendingTemplate || !selected}
                    onClick={() => void apply(null)}
                  >
                    <RotateCcw size={18} aria-hidden="true" /> 앱 기본 프롬프트 사용
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
        <summary>저장된 창작 조합·프리셋 관리</summary>
        <div className="deletion-list">
          {[
            ...(library.promptCombinations ?? []),
            ...localCombinations.filter(
              (item) => !library.promptCombinations?.some((saved) => saved.id === item.id)
            ),
          ].map((item) => (
            <div className="deletion-row" key={item.id}>
              <span>{item.title} · 전역 조합</span>
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
          {!library.promptCombinations?.length && !localCombinations.length && (
            <p className="muted">저장된 조합이 없어요.</p>
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
      {error && (
        <p className="error" role="alert">
          {error} 편집 내용은 유지했어요.
        </p>
      )}
    </section>
  );
}
