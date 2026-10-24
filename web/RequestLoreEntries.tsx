import type { RequestLore } from '../core/request-lore.js';
import { formatNumber, t, useI18n } from './i18n.js';
import './lore-context.css';

const viaLabels = {
  pinned: 'visualpanels.pinnedMaterial',
  selected: 'visualpanels.automaticallySelected',
  retained: 'visualpanels.includedInPreviousRequest',
  'tool-result': 'visualpanels.toolLookup',
} as const;
const deliveryLabels = {
  full: 'visualpanels.fullLoreText',
  excerpt: 'visualpanels.readExcerpt',
  summary: 'visualpanels.summaryOnly',
  unverified: 'visualpanels.inclusionUnconfirmed',
} as const;

/** Groups describe how material reached this saved request, not today's library state. */
export function RequestLoreEntries({ entries }: { entries: RequestLore['entries'] }) {
  useI18n();
  const groups = new Map<string, RequestLore['entries']>();
  for (const entry of entries) {
    const key = `${entry.via}:${entry.delivery}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return (
    <div className="request-lore-groups">
      {[...groups].map(([key, items]) => {
        const { via, delivery } = items[0];
        return (
          <section className="request-lore-group" key={key}>
            <h5 className="request-lore-group-heading">
              <span>{t(viaLabels[via])}</span>
              <span>{t(deliveryLabels[delivery])}</span>
              <span className="request-lore-count">{formatNumber(items.length)}</span>
            </h5>
            <ul className="scene-receipt-lore request-lore-entries">
              {items.map((entry, index) => (
                <li key={`${entry.id}:${index}`}>
                  <details>
                    <summary>
                      {entry.title || entry.id}
                      {entry.source &&
                        entries.some(
                          (other) =>
                            other !== entry &&
                            other.title === entry.title &&
                            other.source?.contentId !== entry.source?.contentId
                        ) && (
                          <small className="request-lore-source-name">
                            {entry.source.sourceName || entry.source.contentId}
                          </small>
                        )}
                    </summary>
                    <dl className="request-lore-identity">
                      {entry.source && (
                        <>
                          <dt>{t('visualpanels.loreSource')}</dt>
                          <dd>{entry.source.sourceName || entry.source.contentId}</dd>
                        </>
                      )}
                      <dt>{t('visualpanels.loreRecordId')}</dt>
                      <dd>{entry.id}</dd>
                      {entry.source && (
                        <>
                          <dt>{t('visualpanels.loreSourceId')}</dt>
                          <dd>{entry.source.contentId}</dd>
                          {entry.source.entryId && (
                            <>
                              <dt>{t('visualpanels.loreEntryId')}</dt>
                              <dd>{entry.source.entryId}</dd>
                            </>
                          )}
                        </>
                      )}
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
