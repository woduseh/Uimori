import { t, translateMessage, useI18n } from './i18n.js';
import { useEffect, useState } from 'react';
import type { AutoTranslationDefaults as Defaults } from '../core/chat-settings.js';
import { api } from './api.js';
import { Switch } from './BooleanControls.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';

/** Unlike device-only reading preferences, translation jobs use the saved server choice. */
export function AutoTranslationDefaults() {
  useI18n();
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry explicitly re-issues a read.
  useEffect(() => {
    let alive = true;
    void api<Defaults>('/auto-translation-defaults')
      .then((value) => {
        if (alive) {
          setDefaults(value);
          setError('');
        }
      })
      .catch((cause) => {
        if (alive) setError((cause as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reload]);
  async function change(autoTranslate: boolean) {
    if (!defaults || saving) return;
    setSaving(true);
    setError('');
    // Show the chosen state immediately; a rejected write restores the saved choice.
    setDefaults({ ...defaults, autoTranslate });
    try {
      setDefaults(
        await api<Defaults>(
          '/auto-translation-defaults',
          { expectedRevision: defaults.revision, autoTranslate },
          'PUT'
        )
      );
    } catch (cause) {
      setDefaults(defaults);
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="settings-group-body">
      <LoadingState
        presentation="placeholder"
        loading={loading}
        error={!defaults ? error : ''}
        label={t('settings.m99')}
        errorLabel={t('settings.m100')}
        onRetry={() => {
          setLoading(true);
          setReload((value) => value + 1);
        }}
      />
      {defaults && (
        <label className="settings-row settings-row-toggle">
          <span className="settings-row-copy">
            <strong>{t('settings.m85')}</strong>
          </span>
          <span className="settings-row-control">
            <Switch
              aria-label={t('settings.m102')}
              checked={defaults.autoTranslate}
              disabled={saving || loading || !!error}
              onChange={(event) => void change(event.target.checked)}
            />
          </span>
        </label>
      )}
      {defaults && error && (
        <NoticeBanner tone="error">
          {translateMessage(error)}{' '}
          <button
            type="button"
            className="link-button"
            disabled={saving}
            onClick={() => {
              setLoading(true);
              setReload((value) => value + 1);
            }}
          >
            {t('settings.m103')}
          </button>
        </NoticeBanner>
      )}
    </div>
  );
}
