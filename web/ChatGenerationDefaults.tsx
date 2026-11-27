import { useRef, useState } from 'react';
import {
  isAutoRefusalRetryCount,
  MAX_AUTO_REFUSAL_RETRIES,
  MAX_MAIN_MODEL_CALLS,
  type ChatGenerationDefaults as Defaults,
} from '../core/chat-settings.js';
import { api } from './api.js';
import { Switch } from './BooleanControls.js';
import { t, useI18n } from './i18n.js';
import { formatUiMessage, uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { StoryUiStyleSelect } from './StoryUiStyleSelect.js';
import { useRetryableEffect } from './useRetryableEffect.js';

type Values = Omit<Defaults, 'revision'>;

export function ChatGenerationDefaults() {
  useI18n();
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [maxCallsDraft, setMaxCallsDraft] = useState('');
  const [retriesDraft, setRetriesDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UiMessage | null>(null);
  const confirmed = useRef<Defaults | null>(null);
  const requested = useRef<Defaults | null>(null);
  const saves = useRef(Promise.resolve());
  const retryRead = useRetryableEffect(() => {
    let active = true;
    void api<Defaults>('/chat-generation-defaults')
      .then((next) => {
        if (!active) return;
        confirmed.current = requested.current = next;
        setDefaults(next);
        setMaxCallsDraft(String(next.maxCalls));
        setRetriesDraft(String(next.autoRefusalMaxRetries));
        setError(null);
      })
      .catch((cause) => {
        if (active) setError(toUiMessage(cause, 'settings.newChatDefaultsLoadFailed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  function change(patch: Partial<Values>) {
    if (!requested.current) return;
    const target = { ...requested.current, ...patch };
    requested.current = target;
    setDefaults(target);
    setError(null);
    saves.current = saves.current.then(() => persist(target));
  }
  async function persist(target: Defaults) {
    const base = confirmed.current;
    if (!base || requested.current !== target) return;
    try {
      const saved = await api<Defaults>(
        '/chat-generation-defaults',
        {
          expectedRevision: base.revision,
          maxCalls: target.maxCalls,
          storyUi: target.storyUi,
          storyUiStyle: target.storyUiStyle,
          autoRefusalRetryEnabled: target.autoRefusalRetryEnabled,
          autoRefusalMaxRetries: target.autoRefusalMaxRetries,
        },
        'PUT'
      );
      confirmed.current = saved;
      if (requested.current === target) {
        requested.current = saved;
        setDefaults(saved);
      }
    } catch (cause) {
      requested.current = confirmed.current;
      setDefaults(confirmed.current);
      setMaxCallsDraft(String(base.maxCalls));
      setRetriesDraft(String(base.autoRefusalMaxRetries));
      setError(toUiMessage(cause));
    }
  }
  function commitMaxCalls() {
    if (!requested.current) return;
    const maxCalls = Number(maxCallsDraft);
    if (maxCalls === requested.current.maxCalls) return;
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_MAIN_MODEL_CALLS) {
      setMaxCallsDraft(String(requested.current.maxCalls));
      setError(uiMessage('settings.m78'));
      return;
    }
    change({ maxCalls });
  }
  function commitRetries() {
    if (!requested.current) return;
    const autoRefusalMaxRetries = Number(retriesDraft);
    if (autoRefusalMaxRetries === requested.current.autoRefusalMaxRetries) return;
    if (!retriesDraft.trim() || !isAutoRefusalRetryCount(autoRefusalMaxRetries)) {
      setRetriesDraft(String(requested.current.autoRefusalMaxRetries));
      setError(uiMessage('settings.autoRefusalRetryRange', { max: MAX_AUTO_REFUSAL_RETRIES }));
      return;
    }
    change({ autoRefusalMaxRetries });
  }
  function retry() {
    setLoading(true);
    retryRead();
  }
  return (
    <section className="settings-group" aria-label={t('settings.newChatDefaults')}>
      <h4>{t('settings.newChatDefaults')}</h4>
      <LoadingState
        presentation="placeholder"
        loading={loading}
        error={!defaults ? error : null}
        label={uiMessage('settings.newChatDefaultsLoading')}
        errorLabel={uiMessage('settings.newChatDefaultsLoadFailed')}
        onRetry={retry}
      />
      {defaults && (
        <fieldset disabled={loading}>
          <div className="settings-group-body">
            <label className="settings-row">
              <span className="settings-row-copy">
                <strong>{t('settings.m92')}</strong>
                <small>{t('settings.m93')}</small>
              </span>
              <input
                aria-label={t('settings.m92')}
                type="number"
                min={1}
                max={MAX_MAIN_MODEL_CALLS}
                step={1}
                required
                value={maxCallsDraft}
                onChange={(event) => setMaxCallsDraft(event.target.value)}
                onBlur={commitMaxCalls}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitMaxCalls();
                }}
              />
            </label>
            <label className="settings-row settings-row-toggle">
              <span className="settings-row-copy">
                <strong>{t('storyUi.enable')}</strong>
              </span>
              <span className="settings-row-control">
                <Switch
                  aria-label={t('storyUi.enable')}
                  checked={defaults.storyUi}
                  onChange={(event) => change({ storyUi: event.target.checked })}
                />
              </span>
            </label>
            {defaults.storyUi && (
              <label className="settings-row">
                <span className="settings-row-copy">
                  <strong>{t('storyUi.style')}</strong>
                </span>
                <StoryUiStyleSelect
                  aria-label={t('storyUi.style')}
                  value={defaults.storyUiStyle}
                  onChange={(storyUiStyle) => change({ storyUiStyle })}
                />
              </label>
            )}
            <label className="settings-row settings-row-toggle">
              <span className="settings-row-copy">
                <strong>{t('settings.autoRefusalRetry')}</strong>
                <small>{t('settings.autoRefusalRetryDefaultHint')}</small>
              </span>
              <span className="settings-row-control">
                <Switch
                  aria-label={t('settings.autoRefusalRetry')}
                  checked={defaults.autoRefusalRetryEnabled}
                  onChange={(event) => change({ autoRefusalRetryEnabled: event.target.checked })}
                />
              </span>
            </label>
            {defaults.autoRefusalRetryEnabled && (
              <label className="settings-row">
                <span className="settings-row-copy">
                  <strong>{t('settings.autoRefusalMaxRetries')}</strong>
                  <small>
                    {t('settings.autoRefusalMaxRetriesHint', { max: MAX_AUTO_REFUSAL_RETRIES })}
                  </small>
                </span>
                <input
                  aria-label={t('settings.autoRefusalMaxRetries')}
                  type="number"
                  min={0}
                  max={MAX_AUTO_REFUSAL_RETRIES}
                  step={1}
                  required
                  value={retriesDraft}
                  onChange={(event) => setRetriesDraft(event.target.value)}
                  onBlur={commitRetries}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRetries();
                  }}
                />
              </label>
            )}
          </div>
        </fieldset>
      )}
      {defaults && error && (
        <NoticeBanner tone="error">
          {formatUiMessage(error)}{' '}
          <button type="button" className="link-button" onClick={retry}>
            {t('settings.m103')}
          </button>
        </NoticeBanner>
      )}
    </section>
  );
}
