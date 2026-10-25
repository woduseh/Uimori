import { useI18n } from './i18n.js';
import { useEffect, useState } from 'react';
import { NoticeBanner } from './NoticeBanner.js';
import './app-about.css';
import { api } from './api.js';
import { ExternalLinkIcon } from './ui-icons.js';
import license from '../LICENSE?raw';
import notices from '../THIRD_PARTY_NOTICES.md?raw';

type AppBuild = { version: string; buildId: string };

export function AppAbout() {
  const { t } = useI18n();
  const [build, setBuild] = useState<AppBuild | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts a fresh request after a failed health lookup.
  useEffect(() => {
    let active = true;
    setError(false);
    setBuild(null);
    void api<AppBuild>('/health')
      .then((result) => {
        if (active) setBuild(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    <section className="app-about" aria-label={t('outside.aboutLabel')}>
      <div className="recovery-settings-brand">
        <img src="/favicon.svg" width={56} height={56} alt="" aria-hidden="true" />
        <div>
          <h3>Uimori</h3>
        </div>
      </div>
      <div className="settings-group-body app-about-details">
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>{t('outside.version')}</strong>
          </div>
          <code data-testid="app-version">
            {build ? `v${build.version}` : error ? t('outside.checkFailed') : t('outside.checking')}
          </code>
        </div>
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>{t('outside.buildId')}</strong>
          </div>
          <code className="muted app-about-build-id" data-testid="app-build-id">
            {build?.buildId ?? (error ? t('outside.checkFailed') : t('outside.checking'))}
          </code>
        </div>
        {error && (
          <NoticeBanner
            tone="error"
            actions={
              <button
                type="button"
                className="secondary"
                onClick={() => setRefresh((value) => value + 1)}
              >
                {t('outside.recheck')}
              </button>
            }
          >
            {t('outside.versionFailure')}
          </NoticeBanner>
        )}
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>{t('outside.license')}</strong>
            <p className="muted">GNU Affero General Public License v3</p>
          </div>
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
            <ExternalLinkIcon size={16} aria-hidden="true" /> {t('outside.readFull')}
          </a>
        </div>
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>{t('outside.sourceRepo')}</strong>
          </div>
          <a href="https://github.com/woduseh/Uimori" target="_blank" rel="noreferrer">
            <ExternalLinkIcon size={16} aria-hidden="true" /> {t('outside.viewSource')}
          </a>
        </div>
      </div>
      <details className="recovery-settings-disclosure">
        <summary>{t('outside.fullLicense')}</summary>
        <pre className="app-about-document">{license}</pre>
      </details>
      <details className="recovery-settings-disclosure">
        <summary>{t('outside.notices')}</summary>
        <pre className="app-about-document">{notices}</pre>
      </details>
    </section>
  );
}
