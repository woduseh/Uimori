import { useCallback, useEffect, useRef, useState } from 'react';
import { ListTree, X } from 'lucide-react';
import { api } from './api.js';
import { translateMessage, useI18n } from './i18n.js';
import { IconButton } from './IconButton.js';
import { OUTLINE_REFRESH_EVENT } from './outline-helper.js';
import type { OutlineFocus } from '../core/outline.js';

export function OutlineFocusStatus({
  chatId,
  headRevision,
  onOpen,
}: {
  chatId: string;
  headRevision: string | null | undefined;
  onOpen: (nodeId: string) => void;
}) {
  const { t } = useI18n();
  const [focus, setFocus] = useState<OutlineFocus>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const value = await api<OutlineFocus>(`/chats/${chatId}/outline/focus`);
      if (current === generation.current) setFocus(value);
    } catch {
      /* The next scene or outline change reads again. */
    }
  }, [chatId]);
  useEffect(() => {
    const refresh = () => void load();
    addEventListener(OUTLINE_REFRESH_EVENT, refresh);
    return () => {
      generation.current++;
      removeEventListener(OUTLINE_REFRESH_EVENT, refresh);
    };
  }, [load]);
  useEffect(() => {
    if (headRevision !== undefined) void load();
  }, [headRevision, load]);
  if (!focus) return null;
  async function clear() {
    setBusy(true);
    setError('');
    try {
      await api(`/chats/${chatId}/outline/focus`, { nodeId: null }, 'PUT');
      generation.current++;
      setFocus(null);
      dispatchEvent(new Event(OUTLINE_REFRESH_EVENT));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <p className="composer-status fork-notice outline-focus-status" role="status">
      <ListTree size={14} aria-hidden="true" />
      <span>{t('prompts.outlineFocusNotice')}</span>
      <button
        type="button"
        className="link-button"
        aria-label={t('prompts.outlineOpenFocus', { title: focus.title })}
        onClick={() => onOpen(focus.nodeId)}
      >
        {t(`prompts.level.${focus.level}`)} {focus.title}
      </button>
      <IconButton
        label={t('prompts.outlineClearFocusAccessible')}
        icon={X}
        size={14}
        className="fork-notice-close"
        disabled={busy}
        onClick={() => void clear()}
      />
      {error && (
        <span className="error" role="alert">
          {translateMessage(error)}
        </span>
      )}
    </p>
  );
}
