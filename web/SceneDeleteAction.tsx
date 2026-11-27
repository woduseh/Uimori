import { tryParseJson } from './json.js';
import { useEffect, useRef, useState } from 'react';
import { api, definiteRejection } from './api.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
import { t, useI18n, translateMessage, message as descriptor } from './i18n.js';
import { UiError, uiMessage } from './ui-message.js';
import type { SceneDeletionImpact, SceneDeletionResult } from '../core/scene-deletion.js';
import { storageKeys } from './storage-keys.js';

type Pending = { impact: SceneDeletionImpact; scope: 'only' | 'following'; idempotencyKey: string };

export function pendingSceneDeletions(chatId: string): string[] {
  if (!chatId) return [];
  const prefix = storageKeys.sceneDeletion(chatId, '');
  try {
    const sources: string[] = [];
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix) && key.length > prefix.length)
        sources.push(key.slice(prefix.length));
    }
    return sources;
  } catch {
    return [];
  }
}

export function SceneDeleteDialog({
  chatId,
  sourceId,
  visible,
  onClose,
  onError,
  onPendingChange,
  onDeleted,
}: {
  chatId: string;
  sourceId: string;
  visible: boolean;
  onClose: () => void;
  onError: (error: string) => void;
  onPendingChange: () => void;
  onDeleted: (result: SceneDeletionResult) => Promise<void>;
}) {
  useI18n();
  const [impact, setImpact] = useState<SceneDeletionImpact | null>(null);
  const [scope, setScope] = useState<'only' | 'following'>('only');
  const [pending, setPending] = useState<{ command: Pending; raw: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const locked = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onClose, onError, onPendingChange });
  callbacks.current = { onClose, onError, onPendingChange };
  const path = `/chats/${encodeURIComponent(chatId)}/sources/${encodeURIComponent(sourceId)}`;
  const storageKey = storageKeys.sceneDeletion(chatId, sourceId);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const open = async () => {
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw !== null) {
          const previous = tryParseJson(raw, null) as Pending | null;
          if (
            !previous?.impact?.request ||
            previous.impact.sourceId !== sourceId ||
            (previous.scope !== 'only' && previous.scope !== 'following') ||
            typeof previous.idempotencyKey !== 'string' ||
            !previous.idempotencyKey
          )
            throw new UiError(uiMessage('chatmanage.unknown'));
          if (!active) return;
          setPending({ command: previous, raw });
          setImpact(previous.impact);
          setScope(previous.scope);
        } else {
          const next = await api<SceneDeletionImpact>(`${path}/deletion-impact`);
          if (active) setImpact(next);
        }
      } catch (cause) {
        if (!active) return;
        callbacks.current.onError((cause as Error).message);
        callbacks.current.onClose();
      }
    };
    void open();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [path, sourceId, storageKey]);

  async function remove() {
    if (!impact || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const command = pending?.command ?? { impact, scope, idempotencyKey: crypto.randomUUID() };
    const raw = pending?.raw ?? JSON.stringify(command);
    let sent = false;
    let accepted: SceneDeletionResult | undefined;
    const clearOwnRecord = () => {
      if (sessionStorage.getItem(storageKey) === raw) sessionStorage.removeItem(storageKey);
      callbacks.current.onPendingChange();
    };
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored !== null && stored !== raw) {
        setError(descriptor('chatmanage.unknown'));
        callbacks.current.onPendingChange();
        return;
      }
      sessionStorage.setItem(storageKey, raw);
      setPending({ command, raw });
      callbacks.current.onPendingChange();
      sent = true;
      accepted = await api<SceneDeletionResult>(
        path,
        { ...command.impact.request, scope: command.scope, idempotencyKey: command.idempotencyKey },
        'DELETE'
      );
    } catch (cause) {
      if (!sent) {
        if (mounted.current) setError((cause as Error).message);
      } else if (!pending && definiteRejection(cause)) {
        try {
          clearOwnRecord();
        } catch {}
        if (mounted.current) {
          callbacks.current.onError((cause as Error).message);
          callbacks.current.onClose();
        }
      } else if (mounted.current) setError(descriptor('chatmanage.unknown'));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
    if (!accepted) return;
    try {
      clearOwnRecord();
    } catch (cause) {
      if (mounted.current) callbacks.current.onError((cause as Error).message);
    }
    if (mounted.current) callbacks.current.onClose();
    await onDeleted(accepted);
  }

  const count = scope === 'only' ? 1 : (impact?.followingCount ?? 0);
  return (
    <Dialog
      open={visible && !!impact}
      title={t('chatmanage.deleteTitle')}
      role="alertdialog"
      variant="confirmation"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>{t('chatmanage.deleteHelp')}</p>
      {!(impact && impact.followingCount <= 1) && (
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
      )}
      <p className="muted">{t('chatmanage.memoryHelp')}</p>
      {scope === 'only' && (impact?.followingCount ?? 0) > 1 && (
        <p className="muted">{t('chatmanage.variablesHelp')}</p>
      )}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>
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
  );
}
