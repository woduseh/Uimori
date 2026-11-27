import { t, useI18n } from './i18n.js';
import { formatUiMessage, uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { useState } from 'react';
import type { AutoTranslationDefaults as Defaults } from '../core/chat-settings.js';
import {
  isWrittenLanguage,
  WRITTEN_LANGUAGES,
  type WrittenLanguage,
} from '../core/written-language.js';
import { translationEndpoints } from '#contracts';
import { callEndpoint } from './api.js';
import { Switch } from './BooleanControls.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useRetryableEffect } from './useRetryableEffect.js';

const LANGUAGE_NAMES: Record<WrittenLanguage, string> = {
  ko: '한국어',
  en: 'English',
  ja: '日本語',
  zh: '中文',
};

export function AutoTranslationDefaults() {
  useI18n();
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [error, setError] = useState<UiMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const retry = useRetryableEffect(() => {
    let alive = true;
    void callEndpoint(translationEndpoints.readAutoTranslationDefaults)
      .then((value) => {
        if (alive) {
          setDefaults(value);
          setError(null);
        }
      })
      .catch((cause) => {
        if (alive) setError(toUiMessage(cause, 'settings.m100'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  async function change(next: Pick<Defaults, 'autoTranslate' | 'translationLanguage'>) {
    if (!defaults || saving) return;
    setSaving(true);
    setError(null);
    setDefaults({ ...defaults, ...next });
    try {
      setDefaults(
        await callEndpoint(translationEndpoints.saveAutoTranslationDefaults, {
          expectedRevision: defaults.revision,
          ...next,
        })
      );
    } catch (cause) {
      setDefaults(defaults);
      setError(toUiMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="settings-group-body">
      <LoadingState
        presentation="placeholder"
        loading={loading}
        error={!defaults ? error : null}
        label={uiMessage('settings.m99')}
        errorLabel={uiMessage('settings.m100')}
        onRetry={() => {
          setLoading(true);
          retry();
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
              onChange={(event) =>
                void change({
                  autoTranslate: event.target.checked,
                  translationLanguage: defaults.translationLanguage,
                })
              }
            />
          </span>
        </label>
      )}
      {defaults && (
        <label className="settings-row">
          <span className="settings-row-copy">
            <strong>{t('settings.autoTranslationLanguage')}</strong>
            <small>{t('settings.autoTranslationLanguageHint')}</small>
          </span>
          <select
            aria-label={t('settings.autoTranslationLanguage')}
            value={defaults.translationLanguage ?? ''}
            disabled={saving || loading || !!error}
            onChange={(event) =>
              void change({
                autoTranslate: defaults.autoTranslate,
                translationLanguage: isWrittenLanguage(event.target.value)
                  ? event.target.value
                  : null,
              })
            }
          >
            {WRITTEN_LANGUAGES.map((language) => (
              <option key={language} value={language} lang={language}>
                {LANGUAGE_NAMES[language]}
              </option>
            ))}
            <option value="">{t('settings.autoTranslationLanguageNone')}</option>
          </select>
        </label>
      )}
      {defaults && error && (
        <NoticeBanner tone="error">
          {formatUiMessage(error)}{' '}
          <button
            type="button"
            className="link-button"
            disabled={saving}
            onClick={() => {
              setLoading(true);
              retry();
            }}
          >
            {t('settings.m103')}
          </button>
        </NoticeBanner>
      )}
    </div>
  );
}
