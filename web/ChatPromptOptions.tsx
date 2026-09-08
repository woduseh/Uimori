import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type {
  ChatProfile,
  Library,
  PromptPreset,
  SavedPromptCombination,
} from '../core/product.js';
import {
  resolvePromptValues,
  reconcilePromptValues,
  validateChatPromptControls,
  type ChatPromptControls,
  type PromptValue,
} from '../core/prompt-program.js';
import { api } from './api.js';
import { PromptControlFields } from './PromptControlFields.js';
import './chat-prompt-options.css';

const keyOf = (ref: { id: string; revision: number }) => `${ref.id}@${ref.revision}`;
const empty = (): ChatPromptControls => ({ values: {}, combinations: [] });
type Draft = { base: ChatProfile; state: ChatPromptControls; origin?: string };
type Props = {
  open: boolean;
  profile?: ChatProfile;
  library: Library | null;
  disabled: boolean;
  onClose: () => void;
  onSaved: (chatId: string) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
};

export function ChatPromptOptions(props: Props) {
  // Keep drafts in memory across closing, chat navigation and prompt switches.
  const drafts = useRef(new Map<string, Draft>());
  const [revisions, setRevisions] = useState<PromptPreset[]>([]);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const reference = props.profile?.prompts?.main;
  const preset = [...(props.library?.promptPresets ?? []), ...revisions]
    .sort((a, b) => b.revision - a.revision)
    .find((item) => item.id === reference?.id && item.revision >= (reference?.revision ?? 0));
  const referenceId = reference?.id,
    referenceRevision = reference?.revision,
    hasPreset = !!preset;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the selected current prompt; reference changes invalidate previous reads.
  useEffect(() => {
    let alive = true;
    setLoadError('');
    if (referenceId !== undefined && !hasPreset)
      void api<PromptPreset>(`/prompt-presets/${referenceId}`)
        .then((item) => {
          if (alive) setRevisions((current) => [...current, item]);
        })
        .catch(() => {
          if (alive) setLoadError('선택한 프롬프트를 불러오지 못했어요.');
        });
    return () => {
      alive = false;
    };
  }, [referenceId, referenceRevision, hasPreset, retry]);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.open) closeButton.current?.focus();
  }, [props.open]);
  useEffect(() => {
    if (!props.open) return;
    const media = matchMedia('(max-width:1100px)');
    const background = [
      ...document.querySelectorAll<HTMLElement>(
        '.app-shell > .sidebar, .app-shell > .story-workspace'
      ),
    ];
    const update = () => {
      for (const node of background) node.inert = media.matches;
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
      for (const node of background) node.inert = false;
    };
  }, [props.open]);
  return (
    <aside
      id="chat-prompt-options"
      className="chat-prompt-options"
      hidden={!props.open}
      role="region"
      aria-label="창작 옵션 패널"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          props.onClose();
        }
        if (event.key === 'Tab' && matchMedia('(max-width:1100px)').matches) {
          const nodes = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button,input,textarea,select,summary'
            ),
          ].filter((node) => !node.matches(':disabled') && node.checkVisibility());
          const first = nodes[0],
            last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="chat-options-header">
        <div>
          <h2>창작 옵션</h2>
          <small>이 채팅 · 다음 생성부터 적용</small>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          aria-label="창작 옵션 닫기"
          onClick={props.onClose}
        >
          <X size={20} />
        </button>
      </header>
      {!!props.profile?.optionAdjustments?.length && (
        <p role="status" className="chat-options-body">
          현재 옵션과 맞지 않는 이전 선택값은 기본값으로 조정했어요.{' '}
          {props.profile.optionAdjustments.join(' · ')}
        </p>
      )}
      {props.profile && preset ? (
        <OptionsEditor
          key={`${props.profile.chatId}:${keyOf(preset)}`}
          {...props}
          profile={props.profile}
          preset={preset}
          drafts={drafts.current}
        />
      ) : (
        <div className="chat-options-body">
          <p role="status">
            {loadError ||
              (reference
                ? '프롬프트를 불러오는 중이에요…'
                : '현재 프롬프트에는 창작 옵션이 없어요. 채팅 설정에서 옵션이 있는 프롬프트를 선택해 주세요.')}
          </p>
          {loadError && (
            <button
              type="button"
              className="secondary"
              onClick={() => setRetry((value) => value + 1)}
            >
              다시 불러오기
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function OptionsEditor({
  profile,
  preset,
  drafts,
  ...props
}: Props & { profile: ChatProfile; preset: PromptPreset; drafts: Map<string, Draft> }) {
  const promptKey = keyOf(preset),
    cacheKey = `${profile.chatId}:${promptKey}`;
  const fresh = useCallback(
    (): Draft => ({
      base: profile,
      state: structuredClone(profile.promptControls?.[promptKey] ?? empty()),
    }),
    [profile, promptKey]
  );
  const [draft, setDraft] = useState<Draft>(() => drafts.get(cacheKey) ?? fresh());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const lock = useRef(false);
  const baseline = draft.base.promptControls?.[promptKey] ?? empty();
  const dirty = JSON.stringify(draft.state) !== JSON.stringify(baseline);
  const conflict = profile.revision > draft.base.revision;
  const combinations =
    props.library?.promptCombinations?.filter((item) => item.prompt.id === preset.id) ?? [];
  const resolved = (values: Record<string, PromptValue>) =>
    resolvePromptValues(preset.program, values);
  const matches = (item: SavedPromptCombination) => {
    try {
      const a = resolved(draft.state.values),
        b = reconcilePromptValues(preset.program, item.values).values;
      return preset.program.controls.every((control) => a[control.id] === b[control.id]);
    } catch {
      return false;
    }
  };
  const matching = combinations.find(matches);
  const origin = combinations.find((item) => item.id === draft.origin);
  let changed = 0;
  try {
    const a = resolved(draft.state.values),
      b = resolved(baseline.values);
    changed = preset.program.controls.filter((control) => a[control.id] !== b[control.id]).length;
  } catch {
    /* Invalid values are reported on apply. */
  }
  useEffect(() => {
    drafts.set(cacheKey, draft);
  }, [cacheKey, draft, drafts]);
  useEffect(() => {
    if (!dirty && !busy && profile.revision > draft.base.revision) setDraft(fresh());
  }, [profile, dirty, busy, draft.base.revision, fresh]);
  useEffect(() => {
    props.onDirtyChange(dirty);
    return () => props.onDirtyChange(false);
  }, [dirty, props.onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);
  function edit(state: ChatPromptControls, originId = draft.origin ?? matching?.id) {
    setDraft({ ...draft, state, origin: originId });
    setError('');
    setMessage('');
  }
  async function save() {
    if (lock.current || props.disabled || !dirty || conflict) return;
    lock.current = true;
    setBusy(true);
    props.onBusyChange(true);
    setError('');
    setMessage('');
    try {
      const state = validateChatPromptControls(draft.state);
      resolved(state.values);
      const base = draft.base;
      const accepted = await api<ChatProfile>(
        `/chats/${base.chatId}/profile`,
        {
          expectedRevision: base.revision,
          attachments: base.attachments,
          personaReference: base.personaReference,
          routes: base.routes,
          image: base.image,
          promptControls: { [promptKey]: state },
        },
        'PUT'
      );
      const next = {
        ...draft,
        base: accepted,
        state: structuredClone(accepted.promptControls?.[promptKey] ?? state),
      };
      drafts.set(cacheKey, next);
      setDraft(next);
      setMessage('이 채팅에 적용했어요. 다음 생성부터 사용해요.');
      await props.onSaved(base.chatId);
    } catch (caught) {
      setError(
        `${caught instanceof Error ? caught.message : '저장하지 못했어요.'} 입력한 옵션은 유지했어요.`
      );
      await props.onSaved(profile.chatId).catch(() => undefined);
    } finally {
      lock.current = false;
      setBusy(false);
      props.onBusyChange(false);
    }
  }
  return (
    <>
      <div className="chat-options-body">
        <h3>{preset.title}</h3>
        <fieldset disabled={busy || props.disabled} className="chat-options-fields">
          <label>
            창작 프리셋
            <select
              aria-label="창작 옵션 프리셋"
              value={matching?.id ?? ''}
              onChange={(event) => {
                const item = combinations.find((item) => item.id === event.target.value);
                if (item) {
                  const reconciled = reconcilePromptValues(preset.program, item.values);
                  edit(
                    {
                      ...draft.state,
                      values: reconciled.values,
                      selectedCombinationId: undefined,
                    },
                    item.id
                  );
                  if (reconciled.resetKeys.length)
                    setMessage('현재 옵션과 맞지 않는 이전 선택값은 기본값으로 조정했어요.');
                }
              }}
            >
              <option value="">{origin ? `${origin.title} · 수정됨` : '직접 설정'}</option>
              {combinations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          {preset.program.controls.length ? (
            <PromptControlFields
              program={preset.program}
              values={draft.state.values}
              onChange={(id, value) =>
                edit({
                  ...draft.state,
                  values: { ...draft.state.values, [id]: value },
                  selectedCombinationId: undefined,
                })
              }
            />
          ) : (
            <p>이 프롬프트에는 창작 옵션이 없어요.</p>
          )}
          {!!preset.program.controls.length && (
            <button
              type="button"
              className="secondary"
              onClick={() => edit({ ...draft.state, values: {}, selectedCombinationId: undefined })}
            >
              프롬프트 기본값으로
            </button>
          )}
        </fieldset>
        {props.disabled && (
          <p role="status">다른 설정 편집이나 요청 처리를 마친 뒤 옵션을 적용할 수 있어요.</p>
        )}
        {conflict && dirty && (
          <div role="alert" className="error">
            <p>다른 곳에서 채팅 설정이 바뀌었어요. 입력한 옵션은 유지했어요.</p>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setDraft({ ...draft, base: profile });
                setError('');
              }}
            >
              최신 채팅 설정에 내 옵션 유지
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setDraft(fresh());
                setError('');
              }}
            >
              최신 설정 다시 불러오기
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <footer className="chat-options-footer">
        <small role="status">
          {message ||
            (dirty
              ? `변경 ${changed}개 · 적용 전에는 저장된 옵션으로 생성해요.`
              : '저장된 옵션이에요. 진행 중인 생성은 바뀌지 않아요.')}
        </small>
        <div>
          <button
            type="button"
            className="secondary"
            disabled={!dirty || busy}
            onClick={() => {
              setDraft({ base: draft.base, state: structuredClone(baseline) });
              setError('');
              setMessage('');
            }}
          >
            편집 전으로 되돌리기
          </button>
          <button
            type="button"
            disabled={!dirty || busy || props.disabled || conflict}
            onClick={() => void save()}
          >
            {busy ? '적용 중…' : '이 채팅에 적용'}
          </button>
        </div>
      </footer>
    </>
  );
}
