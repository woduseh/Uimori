import { t, useI18n, getLocale } from './i18n.js';
import type { LoreContextSnapshot } from '../core/lore-context.js';
import './lore-context.css';

const reasons = (): Record<string, string> => ({
  disabled: t('settings.m248'),
  'new-scene': t('settings.m249'),
  'source-or-canon-changed': t('settings.m250'),
  'provided-as-pinned': t('settings.m251'),
  'resource-scope-or-revision-changed': t('settings.m252'),
  'retention-budget': t('settings.m253'),
});

export function LoreContextDiagnostics({
  snapshot,
  reset = false,
  label = t('settings.m254'),
}: {
  snapshot?: LoreContextSnapshot;
  reset?: boolean;
  label?: string;
}) {
  useI18n();
  if (!snapshot) return <p className="muted">{t('settings.m255')}</p>;
  return (
    <section className="lore-context-result" aria-label={label}>
      <h4>{label}</h4>
      <p className="muted">{t('settings.m256')}</p>
      <dl className="lore-context-stats">
        <div>
          <dt>{t('settings.m257')}</dt>
          <dd>
            {t('settings.flow14', {
              v0: snapshot.stats.retainedEntries.toLocaleString(getLocale()),
              v1: snapshot.policy.maxRetainedEntries.toLocaleString(getLocale()),
            })}
          </dd>
        </div>
        <div>
          <dt>{t('settings.m258')}</dt>
          <dd>
            {t('settings.flow15', {
              v0: snapshot.stats.retainedTokens.toLocaleString(getLocale()),
              v1: snapshot.policy.maxRetainedTokens.toLocaleString(getLocale()),
            })}
          </dd>
        </div>
        <div>
          <dt>{t('settings.m260')}</dt>
          <dd>
            {t('settings.flow16', { v0: snapshot.stats.appendedChars.toLocaleString(getLocale()) })}
          </dd>
        </div>
        <div>
          <dt>{t('settings.m262')}</dt>
          <dd>
            {t('settings.flow17', {
              v0: snapshot.stats.droppedEntries.toLocaleString(getLocale()),
            })}
          </dd>
        </div>
        <div>
          <dt>{t('settings.m263')}</dt>
          <dd>
            {t('settings.flow18', {
              v0: snapshot.policy.maxPinnedTokens.toLocaleString(getLocale()),
            })}
          </dd>
        </div>
      </dl>
      {reset && <p>{t('settings.m264')}</p>}
      {snapshot.stats.reasons.length > 0 && (
        <ul className="lore-context-reasons">
          {snapshot.stats.reasons.map((reason) => (
            <li key={reason}>{reasons()[reason] ?? reason}</li>
          ))}
        </ul>
      )}
      {!!snapshot.entries.length && (
        <details>
          <summary>{t('settings.flow19', { v0: snapshot.entries.length })}</summary>
          <ol className="lore-context-entries">
            {snapshot.entries.map((entry, index) => (
              <li key={`${entry.id}:${entry.revision}:${entry.start}:${entry.end}:${index}`}>
                <strong>{entry.title || entry.id}</strong>
                <span>
                  {t('settings.flow20', {
                    v0: entry.revision,
                    v1: entry.start.toLocaleString(getLocale()),
                    v2: entry.end.toLocaleString(getLocale()),
                    v3: entry.text.length.toLocaleString(getLocale()),
                  })}
                </span>
                <small>
                  {t('settings.flow21', {
                    v0: entry.origin.sourceRevision,
                    v1: entry.origin.runId,
                  })}
                </small>
                <details>
                  <summary>{t('settings.m267')}</summary>
                  <pre>{entry.text}</pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
      )}
      <small className="muted">{t('settings.m268')}</small>
    </section>
  );
}
