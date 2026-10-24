import { useRef, useState } from 'react';
import { api, definiteRejection } from './api.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
import { DeleteIcon } from './ui-icons.js';
import { t, useI18n, translateMessage } from './i18n.js';
import type { SceneDeletionImpact, SceneDeletionResult } from '../core/scene-deletion.js';

type Pending = { impact: SceneDeletionImpact; scope: 'only' | 'following'; idempotencyKey: string };
export function SceneDeleteAction({
  chatId,
  sourceId,
  disabled,
  onDeleted,
}: {
  chatId: string;
  sourceId: string;
  disabled?: boolean;
  onDeleted: (result: SceneDeletionResult) => Promise<void>;
}) {
  useI18n();
  const [impact, setImpact] = useState<SceneDeletionImpact | null>(null);
  const [scope, setScope] = useState<'only' | 'following'>('only');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const locked = useRef(false);
  const path = `/chats/${encodeURIComponent(chatId)}/sources/${encodeURIComponent(sourceId)}`;
  const storageKey = `scene-delete:${chatId}:${sourceId}`;
  async function open() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        const previous = JSON.parse(stored) as Pending;
        setPending(previous);
        setImpact(previous.impact);
        setScope(previous.scope);
      } else {
        setImpact(await api<SceneDeletionImpact>(`${path}/deletion-impact`));
        setScope('only');
        setPending(null);
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function remove() {
    if (!impact || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const command = pending ?? { impact, scope, idempotencyKey: crypto.randomUUID() };
    let accepted: SceneDeletionResult | undefined;
    try {
      // Persist the exact admission before sending, including across dialog re-entry.
      sessionStorage.setItem(storageKey, JSON.stringify(command));
      setPending(command);
      accepted = await api<SceneDeletionResult>(
        path,
        { ...command.impact.request, scope: command.scope, idempotencyKey: command.idempotencyKey },
        'DELETE'
      );
      sessionStorage.removeItem(storageKey);
      setPending(null);
      setImpact(null);
    } catch (cause) {
      if (definiteRejection(cause)) {
        sessionStorage.removeItem(storageKey);
        setPending(null);
        setImpact(null);
        setError((cause as Error).message);
      } else setError(t('chatmanage.unknown'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
    // A refresh failure does not turn an acknowledged delete into an uncertain write.
    if (accepted) await onDeleted(accepted);
  }
  const count = scope === 'only' ? 1 : (impact?.followingCount ?? 0);
  return (
    <span className="delete-control">
      <button
        type="button"
        className="secondary delete-button"
        disabled={disabled || busy}
        onClick={() => void open()}
        aria-haspopup="dialog"
      >
        <DeleteIcon size={18} aria-hidden="true" />
        {t('chatmanage.deleteScene')}
      </button>
      {!impact && error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      <Dialog
        open={!!impact}
        title={t('chatmanage.deleteTitle')}
        role="alertdialog"
        variant="confirmation"
        onClose={() => {
          if (!busy) setImpact(null);
        }}
      >
        <p>{t('chatmanage.deleteHelp')}</p>
        <fieldset disabled={busy || !!pending} className="scene-delete-scopes">
          <label>
            <input
              type="radio"
              name={`delete-${sourceId}`}
              checked={scope === 'only'}
              onChange={() => setScope('only')}
            />
            {t('chatmanage.only')}
          </label>
          <label>
            <input
              type="radio"
              name={`delete-${sourceId}`}
              checked={scope === 'following'}
              onChange={() => setScope('following')}
            />
            {t('chatmanage.following', { count: impact?.followingCount ?? 0 })}
          </label>
        </fieldset>
        <p className="muted">{t('chatmanage.memoryHelp')}</p>
        {scope === 'only' && (impact?.followingCount ?? 0) > 1 && (
          <p className="muted">{t('chatmanage.variablesHelp')}</p>
        )}
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setImpact(null)}
          >
            {t('shared.cancel')}
          </button>
          <button
            type="button"
            className="delete-button"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy
              ? t('shared.deleting')
              : pending
                ? t('chatmanage.confirmOutcome')
                : t('chatmanage.confirmDelete', { count })}
          </button>
        </div>
      </Dialog>
    </span>
  );
}
