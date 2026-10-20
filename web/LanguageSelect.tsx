import { useState } from 'react';
import { UI_LOCALES, useI18n } from './i18n.js';

const names = { ko: '한국어', en: 'English', ja: '日本語', zh: '简体中文' };
export function LanguageSelect() {
  const { t, locale, setLocale } = useI18n();
  const [failed, setFailed] = useState(false);
  return (
    <div className="ui-language-setting">
      <label className="settings-row">
        <span className="settings-row-copy">
          <strong>{t('common.uiLanguage')}</strong>
        </span>
        <select
          aria-label={t('common.uiLanguage')}
          value={locale}
          onChange={(event) => setFailed(!setLocale(event.target.value as typeof locale))}
        >
          {UI_LOCALES.map((code) => (
            <option key={code} value={code} lang={code}>
              {names[code]}
            </option>
          ))}
        </select>
      </label>
      {failed && <p role="alert">{t('common.languageNotSaved')}</p>}
    </div>
  );
}
