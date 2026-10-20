import { useI18n, translateMessage } from './i18n.js';
import { useState, useSyncExternalStore } from 'react';
import { NoticeBanner } from './NoticeBanner.js';
import { Check, Download } from 'lucide-react';
import { installSnapshot, installServerSnapshot, promptInstall, subscribeInstall } from './pwa.js';

export function InstallApp() {
  const { t } = useI18n();
  const state = useSyncExternalStore(subscribeInstall, installSnapshot, installServerSnapshot);
  const [busy, setBusy] = useState(false);
  return (
    <section className="settings-service" aria-label={t('outside.install')}>
      <div className="settings-service-row">
        <div className="settings-service-copy">
          <h4>{t('outside.install')}</h4>
        </div>
        {state.installed ? (
          <span className="settings-inline-status" role="status">
            <Check size={16} aria-hidden="true" /> {t('outside.installed')}
          </span>
        ) : state.available ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void promptInstall().finally(() => setBusy(false));
            }}
          >
            <Download size={16} aria-hidden="true" />{' '}
            {busy ? t('outside.installing') : t('outside.installUimori')}
          </button>
        ) : null}
      </div>
      <details className="settings-install-help">
        <summary>{t('outside.installHelp')}</summary>
        <p className="muted">{t('outside.installDescription')}</p>
        {!state.installed && !state.available && (
          <p className="muted">
            {isSecureContext ? t('outside.browserInstall') : t('outside.secureInstall')}
          </p>
        )}
      </details>
      {state.error && <NoticeBanner tone="error">{translateMessage(state.error)}</NoticeBanner>}
    </section>
  );
}
