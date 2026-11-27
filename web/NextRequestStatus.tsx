import { useCallback, useEffect, useRef, useState } from 'react';
import { BookText, ListTree, SlidersHorizontal, X } from 'lucide-react';
import { ActionMenu } from './ActionMenu.js';
import { chatSettingsEndpoints } from '#contracts';
import { api, callEndpoint } from './api.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { toUiMessage } from './api-errors.js';
import { formatUiMessage, type UiMessage } from './ui-message.js';
import { IconButton } from './IconButton.js';
import { OUTLINE_REFRESH_EVENT } from './outline-helper.js';
import type { OutlineFocus } from '../core/outline.js';

type NextRequestState = {
  focus: OutlineFocus;
  pendingOptions: boolean;
  storyGuide: boolean;
};

export function NextRequestStatus({
  chatId,
  refreshKey,
  compact,
  onOpenOutline,
  onOpenOptions,
  onOpenStoryGuide,
}: {
  chatId: string;
  refreshKey: string | null;
  compact: boolean;
  onOpenOutline: (nodeId: string) => void;
  onOpenOptions: () => void;
  onOpenStoryGuide: () => void;
}) {
  useI18n();
  const [state, setState] = useState<NextRequestState>({
    focus: null,
    pendingOptions: false,
    storyGuide: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiMessage | null>(null);
  const generation = useRef(0);
  const base = `/chats/${encodeURIComponent(chatId)}`;
  const load = useCallback(async () => {
    const current = ++generation.current;
    const [focus, options, guide] = await Promise.allSettled([
      api<OutlineFocus>(`${base}/outline/focus`),
      callEndpoint(chatSettingsEndpoints.readOptions, { chatId }),
      callEndpoint(chatSettingsEndpoints.readStoryGuide, { chatId }),
    ]);
    if (current !== generation.current) return;
    setState((old) => ({
      focus: focus.status === 'fulfilled' ? focus.value : old.focus,
      pendingOptions:
        options.status === 'fulfilled' ? options.value.pending.length > 0 : old.pendingOptions,
      storyGuide: guide.status === 'fulfilled' ? guide.value.config.enabled : old.storyGuide,
    }));
  }, [base, chatId]);
  useEffect(() => {
    const refresh = () => void load();
    for (const event of [OUTLINE_REFRESH_EVENT, 'chat-options-changed', 'focus'])
      addEventListener(event, refresh);
    return () => {
      generation.current++;
      for (const event of [OUTLINE_REFRESH_EVENT, 'chat-options-changed', 'focus'])
        removeEventListener(event, refresh);
    };
  }, [load]);
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (refreshKey === null || refreshKey === loadedKey.current) return;
    loadedKey.current = refreshKey;
    void load();
  }, [load, refreshKey]);
  const { focus, pendingOptions, storyGuide } = state;
  const count = (focus ? 1 : 0) + (pendingOptions ? 1 : 0) + (storyGuide ? 1 : 0);
  if (!count) return null;
  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/outline/focus`, { nodeId: null }, 'PUT');
      generation.current++;
      setState((old) => ({ ...old, focus: null }));
      dispatchEvent(new Event(OUTLINE_REFRESH_EVENT));
    } catch (cause) {
      setError(toUiMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const failure = error && (
    <span className="error" role="alert">
      {formatUiMessage(error)}
    </span>
  );
  if (compact)
    return (
      <div className="next-request-status">
        <ActionMenu
          className="next-request-menu"
          placement="top"
          viewport
          label={t('main.nextRequestMenu', { count })}
          summary={
            <span className="next-request-summary">
              {t('main.nextRequestCount', { count: formatNumber(count) })}
            </span>
          }
        >
          <div className="action-menu-group">
            {focus && (
              <button type="button" onClick={() => onOpenOutline(focus.nodeId)}>
                <ListTree size={18} aria-hidden="true" />
                {t('prompts.outlineFocusNotice')}: {t(`prompts.level.${focus.level}`)} {focus.title}
              </button>
            )}
            {pendingOptions && (
              <button type="button" onClick={onOpenOptions}>
                <SlidersHorizontal size={18} aria-hidden="true" />
                {t('main.nextRequestOptions')}
              </button>
            )}
            {storyGuide && (
              <button type="button" onClick={onOpenStoryGuide}>
                <BookText size={18} aria-hidden="true" />
                {t('main.nextRequestGuide')}
              </button>
            )}
          </div>
          {focus && (
            <div className="action-menu-group">
              <button type="button" disabled={busy} onClick={() => void clear()}>
                <X size={18} aria-hidden="true" />
                {t('prompts.outlineClearFocusAccessible')}
              </button>
            </div>
          )}
        </ActionMenu>
        {failure}
      </div>
    );
  return (
    <div
      className="composer-status next-request-status"
      role="group"
      aria-label={t('main.nextRequestLabel')}
    >
      {focus && (
        <span className="next-request-item outline-focus-status">
          <ListTree size={14} aria-hidden="true" />
          <span>{t('prompts.outlineFocusNotice')}</span>
          <button
            type="button"
            className="link-button"
            aria-label={t('prompts.outlineOpenFocus', { title: focus.title })}
            onClick={() => onOpenOutline(focus.nodeId)}
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
        </span>
      )}
      {pendingOptions && (
        <button type="button" className="link-button next-request-item" onClick={onOpenOptions}>
          <SlidersHorizontal size={14} aria-hidden="true" />
          {t('main.nextRequestOptions')}
        </button>
      )}
      {storyGuide && (
        <button type="button" className="link-button next-request-item" onClick={onOpenStoryGuide}>
          <BookText size={14} aria-hidden="true" />
          {t('main.nextRequestGuide')}
        </button>
      )}
      {failure}
    </div>
  );
}
