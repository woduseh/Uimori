import { useRef, useState, type ReactNode } from 'react';
import { Pencil, Save, Trash2, X } from 'lucide-react';
import { ActionMenu } from './ActionMenu.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { HelperMessageProse } from './HelperMessageProse.js';
import { t, useI18n } from './i18n.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';

export type HelperDeleteScope = 'pair' | 'following';

export function HelperDeleteActions({
  disabled,
  revision,
  onDelete,
}: {
  disabled: boolean;
  revision: number;
  onDelete: (scope: HelperDeleteScope, revision: number) => Promise<boolean>;
}) {
  useI18n();
  const [target, setTarget] = useState<{ scope: HelperDeleteScope; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const lock = useRef(false);
  const label = (scope: HelperDeleteScope) =>
    t(scope === 'pair' ? 'helpers.deletePair' : 'helpers.deleteFollowing');
  return (
    <div className="action-menu-group">
      {(['pair', 'following'] as const).map((scope) => (
        <button
          key={scope}
          type="button"
          disabled={disabled || busy}
          aria-haspopup="dialog"
          onClick={() => {
            setError(false);
            setTarget({ scope, revision });
          }}
        >
          <Trash2 size={18} aria-hidden="true" />
          {label(scope)}
        </button>
      ))}
      <Dialog
        open={!!target}
        title={target ? label(target.scope) : ''}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!lock.current) setTarget(null);
        }}
      >
        <p>{t('helpers.deleteWarning')}</p>
        {error && (
          <p className="error" role="alert">
            {t('helpers.deleteFailed')}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setTarget(null)}
          >
            {t('shared.cancel')}
          </button>
          <button
            type="button"
            className="delete-button"
            disabled={busy || disabled}
            onClick={async () => {
              if (!target || lock.current) return;
              lock.current = true;
              setBusy(true);
              try {
                if (await onDelete(target.scope, target.revision)) setTarget(null);
                else setError(true);
              } finally {
                lock.current = false;
                setBusy(false);
              }
            }}
          >
            {busy ? t('shared.deleting') : target ? label(target.scope) : ''}
          </button>
        </div>
      </Dialog>
    </div>
  );
}

export function HelperResponseEditor({
  id,
  text,
  disabled,
  onSave,
  onEditingChange,
  onDelete,
  revision,
  copy,
}: {
  id: string;
  text: string;
  disabled: boolean;
  onSave: (text: string) => Promise<boolean>;
  onEditingChange: (editing: boolean) => void;
  onDelete: (scope: HelperDeleteScope, revision: number) => Promise<boolean>;
  revision: number;
  copy: ReactNode;
}) {
  useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const close = () => {
    const article = form.current?.closest('article');
    setEditing(false);
    onEditingChange(false);
    requestAnimationFrame(() =>
      article?.querySelector<HTMLElement>('.action-menu > summary')?.focus({ preventScroll: true })
    );
  };
  const key = `helper-response-edit:${id}`;
  const persist = (value?: string) => {
    try {
      if (value === undefined) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch {
      /* The in-memory draft still works. */
    }
  };
  const open = () => {
    try {
      setDraft(sessionStorage.getItem(key) ?? text);
    } catch {
      setDraft(text);
    }
    onEditingChange(true);
    setEditing(true);
  };
  if (editing)
    return (
      <form
        ref={form}
        className="request-message-editor helper-response-editor"
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current || disabled || !draft.trim()) return;
          lock.current = true;
          setBusy(true);
          try {
            if (await onSave(draft)) {
              persist();
              close();
            }
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing && !lock.current) {
            event.preventDefault();
            event.stopPropagation();
            persist();
            close();
          }
        }}
      >
        <textarea
          autoFocus
          aria-label={t('helpers.editResponse')}
          rows={5}
          maxLength={REQUEST_TEXT_MAX_CHARS}
          value={draft}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value);
            persist(event.target.value);
          }}
        />
        <div className="request-edit-footer">
          <span />
          <div className="request-edit-buttons">
            <IconButton
              icon={X}
              label={t('shared.cancel')}
              className="secondary"
              disabled={busy}
              onClick={() => {
                persist();
                close();
              }}
            />
            <IconButton
              icon={Save}
              label={busy ? t('reader.processing') : t('reader.saveInput')}
              type="submit"
              disabled={busy || disabled || !draft.trim()}
            />
          </div>
        </div>
      </form>
    );
  return (
    <>
      <HelperMessageProse text={text} />
      <div className="helper-response-actions">
        {copy}
        <ActionMenu label={t('helpers.messageMenu')} placement="top" viewport>
          <div className="action-menu-group">
            <button type="button" disabled={disabled} onClick={open}>
              <Pencil size={18} aria-hidden="true" />
              {t('helpers.editResponse')}
            </button>
          </div>
          <HelperDeleteActions disabled={disabled} revision={revision} onDelete={onDelete} />
        </ActionMenu>
      </div>
    </>
  );
}
