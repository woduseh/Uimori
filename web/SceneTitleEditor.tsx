import { t, useI18n, translateMessage } from './i18n.js';
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import type { ReaderNavigationItem } from '../core/types.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { ReaderEditingContext } from './Bookmarks.js';

export function SceneTitleEditor({
  item,
  onClose,
}: {
  item: ReaderNavigationItem;
  onClose: () => void;
}) {
  useI18n();
  const [title, setTitle] = useState(item.title ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const lock = useRef(false);
  const dirty = title !== (item.title ?? '');
  const registerEditing = useContext(ReaderEditingContext);
  useLayoutEffect(() => {
    if (!dirty && !busy) return;
    const id = `scene-title:${item.id}`;
    registerEditing(id, true);
    return () => registerEditing(id, false);
  }, [dirty, busy, item.id, registerEditing]);
  async function save() {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/sources/${item.id}/title`, { title, expectedTitle: item.title ?? '' }, 'PATCH');
      onClose();
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      throw cause;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open={discard}
        title={t('reader.unsavedSceneName')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!lock.current) setDiscard(false);
        }}
      >
        <p>{t('reader.discardTheUnsavedSceneName')}</p>
        <DraftDiscardActions
          open={discard}
          disabled={busy}
          discardLabel={t('reader.discardEditsAndClose')}
          saveLabel={t('reader.saveAndClose')}
          onContinue={() => setDiscard(false)}
          onDiscard={onClose}
          onSave={save}
        />
      </Dialog>
      <Dialog
        open
        title={t('reader.sceneName')}
        onClose={() => {
          if (lock.current) return;
          if (dirty) setDiscard(true);
          else onClose();
        }}
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await save();
            } catch {
              /* Keep the name and error for correction. */
            }
          }}
        >
          <fieldset disabled={busy}>
            <label>
              {t('reader.sceneName')}
              <input
                value={title}
                maxLength={200}
                placeholder={item.label}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <small>{t('reader.leaveBlankToShowTheLinkedConfigurationTitleOr')}</small>
            <div className="form-actions">
              <button type="submit" disabled={!dirty}>
                {busy ? t('reader.saving') : t('reader.saveName')}
              </button>
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="error">
              {translateMessage(error)}
            </p>
          )}
        </form>
      </Dialog>
    </>
  );
}
