import { t, useI18n } from './i18n.js';
import { legacyUiMessage } from './ui-message.js';
import { useState } from 'react';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import type { ConnectionCatalogState } from './connection-catalog.js';
import { CheckIcon, SearchIcon } from './ui-icons.js';
import type { Connection } from '../core/product.js';
import { supportedModels } from '../core/model-capabilities.js';

type CatalogModel = Connection['catalog'][number];
export function ProviderCatalogPicker({
  connection,
  selectedId,
  busy,
  catalogState,
  onChoose,
  onRefresh,
}: {
  connection: Connection | undefined;
  selectedId: string;
  busy: boolean;
  catalogState: ConnectionCatalogState;
  onChoose: (model: CatalogModel) => void;
  onRefresh: (connection: Connection) => void;
}) {
  useI18n();
  const [query, setQuery] = useState(''),
    [limit, setLimit] = useState(24);
  if (!connection) return null;
  const local: CatalogModel[] = supportedModels(connection.protocol).map((item) => ({
    id: item.id,
    name: item.name,
    capabilities: {},
    priceRevision: null,
  }));
  const catalog = [
    ...new Map([...local, ...connection.catalog].map((item) => [item.id, item])).values(),
  ];
  const needle = query.trim().toLocaleLowerCase(),
    models = catalog.filter(
      (item) => !needle || `${item.name} ${item.id}`.toLocaleLowerCase().includes(needle)
    );
  return (
    <section className="provider-catalog full" aria-label={t('providers.m310')}>
      {connection.catalogError && <NoticeBanner tone="error">{t('providers.m316')}</NoticeBanner>}
      <details className="provider-catalog-disclosure">
        <summary>{t('providers.m311')}</summary>
        <div className="provider-section-heading">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onRefresh(connection)}
          >
            {t('providers.m110')}
          </button>
        </div>
        {(catalogState.loading || catalogState.error) && (
          <LoadingState
            presentation="inline"
            loading={catalogState.loading}
            error={legacyUiMessage(catalogState.error)}
            onRetry={catalogState.retry}
          />
        )}
        {catalog.length > 0 ? (
          <>
            <label className="provider-search">
              <SearchIcon size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label={t('providers.m317')}
                placeholder={t('providers.m318')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(24);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                }}
              />
            </label>
            <div className="provider-catalog-grid">
              {models.slice(0, limit).map((item) => (
                <button
                  type="button"
                  className={`secondary provider-catalog-choice ${selectedId === item.id ? 'selected' : ''}`}
                  key={item.id}
                  aria-pressed={selectedId === item.id}
                  disabled={busy}
                  onClick={() => onChoose(item)}
                >
                  <strong>{item.name}</strong>
                  {item.name !== item.id && <small>{item.id}</small>}

                  {selectedId === item.id && <CheckIcon size={16} aria-hidden="true" />}
                </button>
              ))}
            </div>
            {!models.length && <p className="muted">{t('providers.m319')}</p>}
            {models.length > limit && (
              <button
                type="button"
                className="secondary"
                onClick={() => setLimit((value) => value + 24)}
              >
                {t('providers.m574', { value0: limit, value1: models.length })}
              </button>
            )}
          </>
        ) : (
          !catalogState.loading &&
          !catalogState.error && <p className="muted">{t('providers.m321')}</p>
        )}
      </details>
    </section>
  );
}
