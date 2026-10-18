import { useCallback, useEffect, useRef, useState } from 'react';
import { CloseIcon } from './ui-icons.js';
import type { Library, PromptWorkspace } from '../core/product.js';
import { ChatOptionSettings } from './ChatOptionSettings.js';
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

/** Composer options always belong to the selected chat. Global defaults live in settings. */
export function ChatPromptOptions(props: Props) {
  const [contexts, setContexts] = useState<string[]>([]);
  const [dirtyScopes, setDirtyScopes] = useState<Record<string, boolean>>({});
  const [busyScopes, setBusyScopes] = useState<Record<string, boolean>>({});
  const closeButton = useRef<HTMLButtonElement>(null);
  const reportDirty = useCallback((key: string, value: boolean) => {
    setDirtyScopes((current) => (current[key] === value ? current : { ...current, [key]: value }));
  }, []);
  const reportBusy = useCallback((key: string, value: boolean) => {
    setBusyScopes((current) => (current[key] === value ? current : { ...current, [key]: value }));
  }, []);
  useEffect(() => {
    if (!props.open || !props.chatId) return;
    const id = props.chatId;
    setContexts((current) => (current.includes(id) ? current : [...current, id]));
  }, [props.open, props.chatId]);
  useEffect(
    () => props.onDirtyChange(Object.values(dirtyScopes).some(Boolean)),
    [dirtyScopes, props.onDirtyChange]
  );
  useEffect(
    () => props.onBusyChange(Object.values(busyScopes).some(Boolean)),
    [busyScopes, props.onBusyChange]
  );
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
    for (const node of background) node.inert = props.modal ?? false;
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
          <small>이 채팅 · 다음 생성부터 적용</small>
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
      {contexts.map((chatId) => (
        <ChatScopeEditor
          key={chatId}
          chatId={chatId}
          visible={chatId === props.chatId}
          active={props.open && chatId === props.chatId}
          disabled={props.disabled}
          workspaceRevision={props.workspace?.revision}
          promptRevision={chatId === props.chatId ? props.promptRevision : undefined}
          onDirtyChange={reportDirty}
          onBusyChange={reportBusy}
        />
      ))}
    </aside>
  );
}

function ChatScopeEditor({
  chatId,
  visible,
  active,
  disabled,
  workspaceRevision,
  promptRevision,
  onDirtyChange,
  onBusyChange,
}: {
  chatId: string;
  visible: boolean;
  active: boolean;
  disabled: boolean;
  workspaceRevision?: number;
  promptRevision?: string;
  onDirtyChange: (key: string, value: boolean) => void;
  onBusyChange: (key: string, value: boolean) => void;
}) {
  const dirty = useCallback(
    (value: boolean) => onDirtyChange(chatId, value),
    [chatId, onDirtyChange]
  );
  const busy = useCallback((value: boolean) => onBusyChange(chatId, value), [chatId, onBusyChange]);
  return (
    <div className="chat-options-scope-panel" aria-label="이 채팅 옵션" hidden={!visible}>
      <ChatOptionSettings
        chatId={chatId}
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
