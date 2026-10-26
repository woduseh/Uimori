import { t, useI18n, translateMessage, message as retainedMessage } from './i18n.js';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Copy, LoaderCircle } from 'lucide-react';
import type { Chat } from '../core/types.js';
import { ActionMenu } from './ActionMenu.js';
import { DeleteButton } from './DeleteButton.js';
import { Dialog } from './Dialog.js';
import { SaveButton } from './SaveButton.js';
import { CloseIcon, EditIcon } from './ui-icons.js';
import { api } from './api.js';

type ChatActions = {
  chat: Chat;
  disabled?: boolean;
  onCopyChat?: (chatId: string) => void;
  copying?: boolean;
  onChatsChanged: () => Promise<void>;
  onError: (message: string) => void;
};

/** Both navigation views keep the same chat actions and confirmation boundaries. */
export function ChatActionMenu({
  chat,
  disabled = false,
  onCopyChat,
  copying = false,
  onRename,
  onChatsChanged,
  onError,
}: ChatActions & { onRename: () => void }) {
  useI18n();
  function rename(event: MouseEvent<HTMLButtonElement>) {
    const menu = event.currentTarget.closest('details');
    if (menu) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
    onRename();
  }
  return (
    <ActionMenu label={t('transfer.d013', { v0: chat.title || t('helpers.m260') })} viewport>
      <div className="action-menu-group">
        {onCopyChat && (
          <button type="button" disabled={copying} onClick={() => onCopyChat(chat.id)}>
            {copying ? (
              <LoaderCircle size={18} aria-hidden="true" />
            ) : (
              <Copy size={18} aria-hidden="true" />
            )}
            {t(copying ? 'recent.copyingChat' : 'recent.copyChat')}
          </button>
        )}
        <button type="button" onClick={rename}>
          <EditIcon size={18} aria-hidden="true" />
          {t('transfer.m239')}
        </button>
      </div>
      <div className="action-menu-group">
        <DeleteButton
          path={`/chats/${encodeURIComponent(chat.id)}`}
          preparePath={`/chats/${encodeURIComponent(chat.id)}/deletion-impact`}
          title={chat.title}
          label={t('transfer.m240')}
          disabled={disabled}
          description={t('transfer.m241')}
          onError={onError}
          onDeleted={onChatsChanged}
        />
      </div>
    </ActionMenu>
  );
}

export function ChatTitleDialog({
  chat,
  disabled = false,
  onChatsChanged,
  onClose,
}: {
  chat: Chat | undefined;
  disabled?: boolean;
  onChatsChanged: () => Promise<void>;
  onClose: () => void;
}) {
  useI18n();
  return (
    <Dialog
      open={!!chat}
      title={t('transfer.m257')}
      onClose={onClose}
      className="bot-organize-dialog"
    >
      {chat && (
        <div className="bot-chat-menu">
          <ChatTitleEditor
            key={chat.id}
            chat={chat}
            disabled={disabled}
            onChatsChanged={onChatsChanged}
            onClose={onClose}
          />
        </div>
      )}
    </Dialog>
  );
}

function ChatTitleEditor({
  chat,
  disabled,
  onChatsChanged,
  onClose,
}: {
  chat: Chat;
  disabled: boolean;
  onChatsChanged: () => Promise<void>;
  onClose: () => void;
}) {
  useI18n();
  const [draft, setDraft] = useState(chat.title);
  const [baseTitle, setBaseTitle] = useState(chat.title);
  const [baseTitleRevision, setBaseTitleRevision] = useState(chat.titleRevision ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const observedTitleRevision = useRef(chat.titleRevision ?? 0);
  const dirty = draft !== baseTitle;
  // Background refreshes may publish an automatic title while the user is typing.
  // Only adopt it when there is no manual draft to preserve.
  useEffect(() => {
    const changed = observedTitleRevision.current !== (chat.titleRevision ?? 0);
    observedTitleRevision.current = chat.titleRevision ?? 0;
    if (changed && !dirty && !saving) {
      setDraft(chat.title);
      setBaseTitle(chat.title);
      setBaseTitleRevision(chat.titleRevision ?? 0);
    }
  }, [chat.title, chat.titleRevision, dirty, saving]);
  async function save() {
    if (lock.current || !draft.trim()) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const updated = await api<Chat>(
        `/chats/${encodeURIComponent(chat.id)}/title`,
        { title: draft.trim(), expectedTitleRevision: baseTitleRevision },
        'PATCH'
      );
      setDraft(updated.title);
      setBaseTitle(updated.title);
      setBaseTitleRevision(updated.titleRevision ?? 0);
      await onChatsChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : retainedMessage('transfer.m258'));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <form
      className="bot-chat-title-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        {t('transfer.m221')}
        <input
          aria-label={t('transfer.m221')}
          value={draft}
          maxLength={200}
          required
          disabled={disabled || saving}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={saving}
          onClick={() => {
            setDraft(chat.title);
            setBaseTitle(chat.title);
            setBaseTitleRevision(chat.titleRevision ?? 0);
            setError('');
            onClose();
          }}
        >
          <CloseIcon size={18} aria-hidden="true" />
          {t('transfer.m206')}
        </button>
        <SaveButton
          label={t('transfer.m260')}
          disabled={disabled || !dirty || !draft.trim()}
          aria-busy={saving}
        />
      </div>
      {dirty && (chat.titleRevision ?? 0) !== baseTitleRevision && (
        <small>{t('transfer.m261')}</small>
      )}
      {error && (
        <p className="error" role="alert">
          {translateMessage(error)}
        </p>
      )}
    </form>
  );
}
