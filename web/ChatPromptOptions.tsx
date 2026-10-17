import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloseIcon } from './ui-icons.js';
import type { Library, PromptWorkspace } from '../core/product.js';
import { resolvePromptValues, type PromptControl, type PromptValue } from '../core/risu-prompt.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
import { api, ApiError } from './api.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { promptControls } from '../core/risu-prompt.js';
import { PromptControlFields } from './PromptControlFields.js';
import { ChatOptionSettings } from './ChatOptionSettings.js';
import { NoticeBanner } from './NoticeBanner.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { reviewGlobalOptionDraft } from './global-option-review.js';
import './chat-prompt-options.css';
type Props = {
  open: boolean;
  modal?: boolean;
  workspace: PromptWorkspace | null;
  workspaceError?: string;
  onRetryWorkspace?: () => void;
  promptRevision?: string;
  library: Library | null;
  disabled: boolean;
  chatId?: string;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
};
export function ChatPromptOptions(props: Props) {
  const contextKey = props.chatId ?? '';
  const [scope, setScope] = useState<'global' | 'chat'>('chat');
  const [contexts, setContexts] = useState<{ key: string; chatId: string }[]>([]);
  const [dirtyScopes, setDirtyScopes] = useState<Record<string, boolean>>({});
  const [busyScopes, setBusyScopes] = useState<Record<string, boolean>>({});
  const reportDirty = useCallback((key: string, value: boolean) => {
    setDirtyScopes((current) => (current[key] === value ? current : { ...current, [key]: value }));
  }, []);
  const reportBusy = useCallback((key: string, value: boolean) => {
    setBusyScopes((current) => (current[key] === value ? current : { ...current, [key]: value }));
  }, []);
  const globalDirty = useCallback((value: boolean) => reportDirty('global', value), [reportDirty]);
  const globalBusy = useCallback((value: boolean) => reportBusy('global', value), [reportBusy]);
  useEffect(() => {
    if (!props.open || !contextKey || !props.chatId) return;
    const chatId = props.chatId;
    setContexts((current) =>
      current.some((item) => item.key === contextKey)
        ? current
        : [...current, { key: contextKey, chatId }]
    );
  }, [props.open, contextKey, props.chatId]);
  useEffect(
    () => props.onDirtyChange(Object.values(dirtyScopes).some(Boolean)),
    [dirtyScopes, props.onDirtyChange]
  );
  useEffect(
    () => props.onBusyChange(Object.values(busyScopes).some(Boolean)),
    [busyScopes, props.onBusyChange]
  );
  const selectedScope = contextKey ? scope : 'global';
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.open) closeButton.current?.focus();
  }, [props.open]);
  useEffect(() => {
    if (!props.open) return;
    const background = [
      ...document.querySelectorAll<HTMLElement>(
        '.app-shell > .sidebar, .app-shell > .story-workspace'
      ),
    ];
    const update = () => {
      for (const node of background) node.inert = props.modal ?? false;
    };
    update();
    return () => {
      for (const node of background) node.inert = false;
    };
  }, [props.open, props.modal]);
  return (
    <aside
      id="chat-prompt-options"
      className="chat-prompt-options"
      hidden={!props.open}
      role={props.modal ? 'dialog' : 'region'}
      aria-modal={props.modal && props.open ? true : undefined}
      aria-label="창작 옵션 패널"
      onKeyDown={(event) => {
        if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          props.onClose();
        }
        if (event.key === 'Tab' && props.modal) {
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
          <small>{selectedScope === 'chat' ? '이 채팅' : '모든 채팅'} · 다음 생성부터 적용</small>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          aria-label="창작 옵션 닫기"
          onClick={props.onClose}
        >
          <CloseIcon size={20} />
        </button>
      </header>
      {contextKey && (
        <div
          className="chat-options-scope"
          role="tablist"
          aria-label="창작 옵션 범위"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 'global'
                : event.key === 'End'
                  ? 'chat'
                  : selectedScope === 'chat'
                    ? 'global'
                    : 'chat';
            setScope(next);
            event.currentTarget
              .querySelectorAll<HTMLButtonElement>('button')
              [next === 'global' ? 0 : 1]?.focus();
          }}
        >
          {(['global', 'chat'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`chat-options-${value}-tab`}
              aria-controls={
                value === 'chat'
                  ? `chat-options-chat-panel-${contextKey}`
                  : 'chat-options-global-panel'
              }
              aria-selected={selectedScope === value}
              tabIndex={selectedScope === value ? 0 : -1}
              onClick={() => setScope(value)}
            >
              {value === 'global' ? '모든 채팅' : '이 채팅'}
            </button>
          ))}
        </div>
      )}
      <div
        id="chat-options-global-panel"
        className="chat-options-scope-panel"
        role="tabpanel"
        aria-label="모든 채팅 옵션"
        hidden={selectedScope !== 'global'}
      >
        {props.workspace ? (
          <OptionsEditor
            {...props}
            workspace={props.workspace}
            onDirtyChange={globalDirty}
            onBusyChange={globalBusy}
          />
        ) : (
          <LoadingState
            presentation="placeholder"
            loading={!props.workspaceError}
            error={props.workspaceError}
            label="현재 프롬프트를 불러오는 중이에요…"
            onRetry={props.onRetryWorkspace}
          />
        )}
      </div>
      {contexts.map((context) => (
        <ChatScopeEditor
          key={context.key}
          context={context}
          active={props.open && selectedScope === 'chat' && context.key === contextKey}
          visible={selectedScope === 'chat' && context.key === contextKey}
          disabled={props.disabled}
          workspaceRevision={props.workspace?.revision}
          promptRevision={context.key === contextKey ? props.promptRevision : undefined}
          onDirtyChange={reportDirty}
          onBusyChange={reportBusy}
        />
      ))}
    </aside>
  );
}

function ChatScopeEditor({
  context,
  active,
  visible,
  disabled,
  workspaceRevision,
  promptRevision,
  onDirtyChange,
  onBusyChange,
}: {
  context: { key: string; chatId: string };
  active: boolean;
  visible: boolean;
  disabled: boolean;
  workspaceRevision?: number;
  promptRevision?: string;
  onDirtyChange: (key: string, value: boolean) => void;
  onBusyChange: (key: string, value: boolean) => void;
}) {
  const dirty = useCallback(
    (value: boolean) => onDirtyChange(context.key, value),
    [context.key, onDirtyChange]
  );
  const busy = useCallback(
    (value: boolean) => onBusyChange(context.key, value),
    [context.key, onBusyChange]
  );
  return (
    <div
      id={`chat-options-chat-panel-${context.key}`}
      className="chat-options-scope-panel"
      role="tabpanel"
      aria-label="이 채팅 옵션"
      hidden={!visible}
    >
      <ChatOptionSettings
        chatId={context.chatId}
        active={active}
        disabled={disabled}
        workspaceRevision={workspaceRevision}
        promptRevision={promptRevision}
        onDirtyChange={dirty}
        onBusyChange={busy}
      />
    </div>
  );
}

function OptionsEditor({ workspace, ...props }: Props & { workspace: PromptWorkspace }) {
  const [saveConflict, setSaveConflict] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [base, setBase] = useState(workspace);
  const [values, setValues] = useState(workspace.main.values);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const current = useRef({ base, values });
  current.current = { base, values };
  const dirty = JSON.stringify(values) !== JSON.stringify(base.main.values);
  const conflict = needsReview || workspace.revision > base.revision;
  const combinations =
    props.library?.promptCombinations?.filter((item) =>
      matchesPromptCombination(item, combinationOwner(base.main, 'main'), 'main', base.main.program)
    ) ?? [];
  useEffect(() => {
    if (!dirty && !busy && !needsReview && workspace.revision >= base.revision) {
      setBase(workspace);
      setValues(workspace.main.values);
    }
  }, [workspace, dirty, busy, needsReview, base.revision]);
  useEffect(() => {
    props.onDirtyChange(dirty || needsReview);
    return () => props.onDirtyChange(false);
  }, [dirty, needsReview, props.onDirtyChange]);
  useEffect(() => {
    if (!dirty && !needsReview) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty, needsReview]);
  async function save() {
    if (lock.current || props.disabled) return;
    if (conflict) {
      setSaveConflict(true);
      return;
    }
    lock.current = true;
    setBusy(true);
    props.onBusyChange(true);
    setError('');
    try {
      const accepted = await api<PromptWorkspace>(
        '/prompt-workspace',
        {
          expectedRevision: base.revision,
          main: { ...base.main, program: base.main.program, values },
        },
        'PUT'
      );
      setBase(accepted);
      setValues(accepted.main.values);
      setNeedsReview(false);
      setMessage('현재 옵션을 적용했어요.');
    } catch (caught) {
      const uncertain = !(caught instanceof ApiError) || caught.status >= 500;
      setError(
        uncertain
          ? '저장 여부를 확인하지 못했어요. 저장본을 확인해 주세요. 입력한 옵션은 유지했어요.'
          : `${(caught as Error).message} 입력한 옵션은 유지했어요.`
      );
      if (uncertain || (caught instanceof ApiError && caught.status === 409)) {
        setNeedsReview(true);
        setSaveConflict(true);
      }
    } finally {
      lock.current = false;
      setBusy(false);
      props.onBusyChange(false);
    }
  }
  return (
    <>
      <SaveConflictDialog
        open={saveConflict}
        title="프롬프트 옵션 저장 내용 확인"
        onClose={() => setSaveConflict(false)}
        readSaved={async () => {
          const draft = current.current;
          const saved = await api<PromptWorkspace>('/prompt-workspace');
          const controls = promptControls(saved.main.program);
          const previousControls = promptControls(draft.base.main.program);
          const review = reviewGlobalOptionDraft(draft.base.main, draft.values, saved.main);
          const adopt = (keepInput: boolean) => {
            setBase(saved);
            setValues(keepInput ? review.values : saved.main.values);
            setNeedsReview(false);
            setError('');
            setMessage(keepInput ? '입력을 확인한 뒤 적용해 주세요.' : '저장본을 불러왔어요.');
            setSaveConflict(false);
          };
          return {
            content: (
              <>
                <div className="settings-row">
                  <span className="settings-row-copy">프롬프트</span>
                  <span className="settings-row-control">{saved.main.title}</span>
                </div>
                {controls.map((control) => (
                  <div className="settings-row" key={control.id}>
                    <span className="settings-row-copy">{control.label}</span>
                    <span className="settings-row-control">
                      {optionText(control, saved.main.values[control.id])}
                    </span>
                  </div>
                ))}
                {review.discarded.length > 0 && (
                  <section aria-label="유지할 수 없는 입력">
                    <h3>유지할 수 없는 입력</h3>
                    <p>계속 편집하면 아래 입력은 제외해요. 필요한 내용은 먼저 복사해 두세요.</p>
                    {review.discarded.map((item) => {
                      const control = previousControls.find((entry) => entry.id === item.id);
                      return (
                        <div className="settings-row" key={item.id}>
                          <span className="settings-row-copy">
                            {item.label}
                            <small>{item.reason}</small>
                          </span>
                          <span className="settings-row-control">
                            {item.unset
                              ? '프롬프트 기본값으로'
                              : control
                                ? optionText(control, item.value)
                                : String(item.value ?? '') || '비어 있음'}
                          </span>
                        </div>
                      );
                    })}
                  </section>
                )}
                <p className="muted">저장본을 불러오면 작성 중인 옵션 입력을 버려요.</p>
              </>
            ),
            actions: (
              <>
                <button type="button" className="secondary" onClick={() => adopt(false)}>
                  입력 버리고 저장본 불러오기
                </button>
                <button type="button" className="primary" onClick={() => adopt(true)}>
                  입력 유지하고 계속 편집
                </button>
              </>
            ),
          };
        }}
      />
      <div className="chat-options-body">
        <h3>{base.main.title}</h3>
        <fieldset disabled={busy || props.disabled} className="chat-options-fields">
          <label>
            이 프롬프트의 옵션 조합
            <select
              aria-label="이 프롬프트의 옵션 조합"
              value=""
              onChange={(event) => {
                const preset = combinations.find((item) => item.id === event.target.value);
                if (preset) {
                  setValues(resolvePromptValues(base.main.program, preset.values));
                  setMessage('이 프롬프트의 옵션 조합을 불러왔어요. 저장하면 적용돼요.');
                }
              }}
            >
              <option value="">현재 옵션에 불러오기</option>
              {combinations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <PromptControlFields
            program={base.main.program}
            values={values}
            onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
          />
          <button type="button" className="secondary" onClick={() => setValues({})}>
            프롬프트 기본값으로
          </button>
        </fieldset>
        {workspace.revision > base.revision && dirty && (
          <NoticeBanner tone="error">
            다른 곳에서 현재 프롬프트가 바뀌었어요. 입력은 유지했어요. 적용할 때 변경 내용을 확인해
            주세요.
          </NoticeBanner>
        )}
        <TransientNotice message={message} />
        {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
        {props.workspaceError && (
          <NoticeBanner tone="error">
            {props.workspaceError}
            {props.onRetryWorkspace && (
              <button type="button" disabled={busy} onClick={props.onRetryWorkspace}>
                다시 불러오기
              </button>
            )}
          </NoticeBanner>
        )}
      </div>
      <footer className="chat-options-footer">
        <small>
          {dirty ? '저장하지 않은 변경이 있어요.' : '현재 옵션은 모든 채팅의 다음 요청에 사용해요.'}
        </small>
        {dirty && !conflict && (
          <button type="button" disabled={busy} onClick={() => setConfirmDiscard(true)}>
            변경 취소
          </button>
        )}
        <button
          type="button"
          disabled={(!dirty && !needsReview) || busy || props.disabled}
          onClick={() => void save()}
        >
          {busy ? '적용 중…' : '현재 옵션 적용'}
        </button>
      </footer>
      <Dialog
        open={confirmDiscard}
        title="전역 옵션 변경 취소"
        variant="confirmation"
        role="alertdialog"
        onClose={() => setConfirmDiscard(false)}
      >
        <p>저장하지 않은 옵션 입력을 버릴까요?</p>
        <DraftDiscardActions
          open={confirmDiscard}
          onContinue={() => setConfirmDiscard(false)}
          onDiscard={() => {
            setValues(base.main.values);
            setError('');
            setMessage('');
            setConfirmDiscard(false);
          }}
          discardLabel="변경 버리기"
        />
      </Dialog>
    </>
  );
}

function optionText(control: PromptControl, value: PromptValue | undefined): string {
  const current = value ?? control.default;
  const choice = control.options?.find((option) => option.value === current);
  if (choice) return choice.label;
  if (typeof current === 'boolean') return current ? '켬' : '끔';
  return current === '' || current === null ? '비어 있음' : String(current);
}
