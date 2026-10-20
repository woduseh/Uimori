import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { helperResourceEditResources, type HelperResourceEdit } from '../core/helper.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { editorContextChanged, hasUnsavedResourceEditor } from './resource-editor.js';
import './helper-resource-undo.css';

const hasUnsavedEditResource = (edit: HelperResourceEdit) =>
  helperResourceEditResources(edit).some((resource) =>
    hasUnsavedResourceEditor(resource.kind, resource.id)
  );

/** The server owns the saved edit and its revision; this control only selects its receipt. */
export function HelperResourceUndo({
  conversationId,
  edit,
  disabled,
  refresh,
}: {
  conversationId: string;
  edit: HelperResourceEdit;
  disabled: boolean;
  refresh: () => Promise<void>;
}) {
  useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(false);
  const [dirty, setDirty] = useState(() => hasUnsavedEditResource(edit));
  const alive = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    if (edit.undone) {
      setError('');
      setConfirming(false);
    }
  }, [edit.undone]);
  useEffect(() => {
    alive.current = true;
    const changed = () => setDirty(hasUnsavedEditResource(edit));
    changed();
    window.addEventListener(editorContextChanged, changed);
    return () => {
      alive.current = false;
      window.removeEventListener(editorContextChanged, changed);
    };
  }, [edit]);
  const resources = helperResourceEditResources(edit);
  const title =
    resources.length > 1
      ? t('helpers.m151', { v0: edit.title, v1: formatNumber(resources.length - 1) })
      : edit.title;
  const undone = restored || edit.undone;
  const reason = dirty ? t('helpers.m152') : edit.reason;
  const unavailable = disabled || busy || dirty || !edit.canUndo || !!undone;
  async function undo() {
    if (unavailable || locked.current) return;
    if (hasUnsavedEditResource(edit)) {
      setDirty(true);
      return;
    }
    locked.current = true;
    setBusy(true);
    setError('');
    let accepted = false;
    try {
      const result = await api<HelperResourceEdit>(
        `/helper/conversations/${encodeURIComponent(conversationId)}/undo-resource`,
        { editSeq: edit.editSeq }
      );
      accepted = result.undone === true;
      if (!accepted) throw new Error(uiMessage('helpers.m153'));
      // Notify other saved-resource owners even if this conversation was switched meanwhile.
      window.dispatchEvent(new Event('uimori-helper-updated'));
      if (resources.some((resource) => resource.kind === 'theme'))
        window.dispatchEvent(new Event('uimori-themes-changed'));
      if (resources.some((resource) => resource.kind === 'illustration-preset'))
        window.dispatchEvent(new Event('uimori-illustration-presets-changed'));
      if (alive.current) {
        setRestored(true);
        setConfirming(false);
      }
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : uiMessage('helpers.m153'));
    } finally {
      // A lost response is reconciled by a read, never by automatically posting again.
      try {
        await refresh();
      } catch {
        if (alive.current)
          setError(accepted ? uiMessage('helpers.m154') : uiMessage('helpers.m155'));
      }
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="helper-resource-undo" aria-label={t('helpers.m156')}>
      <div>
        <span role={undone ? 'status' : undefined}>
          {undone ? t('helpers.m157') : t('helpers.m158')} · {title}
        </span>
        {!undone && (
          <IconButton
            icon={Undo2}
            label={t('helpers.m159')}
            title={reason ? translateMessage(reason) : t('helpers.m160')}
            disabled={unavailable}
            className="secondary"
            onClick={() => setConfirming(true)}
          />
        )}
      </div>
      {!undone && reason && <small>{translateMessage(reason)}</small>}
      {error && (
        <p className="error" role="alert">
          {translateMessage(error)}
        </p>
      )}
      <Dialog
        open={confirming && !undone}
        title={t('helpers.m161')}
        variant="confirmation"
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        {resources.length > 1 ? (
          <>
            <p>{t('helpers.m322', { count: formatNumber(resources.length) })}</p>
            <ul>
              {resources.map((resource) => (
                <li key={`${resource.kind}:${resource.id}`}>{resource.title}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>{t('helpers.m323', { title: edit.title })}</p>
        )}
        {reason && <p role="status">{translateMessage(reason)}</p>}
        {error && (
          <p className="error" role="alert">
            {translateMessage(error)}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            {t('helpers.m165')}
          </button>
          <button type="button" disabled={unavailable} onClick={() => void undo()}>
            {busy ? t('helpers.m166') : t('helpers.m167')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
