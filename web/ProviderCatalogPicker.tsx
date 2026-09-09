import { useState } from 'react';
import { CheckIcon, SearchIcon } from './ui-icons.js';
import type { Connection } from '../core/product.js';
import { supportedModels } from '../core/model-capabilities.js';

type CatalogModel = Connection['catalog'][number];
/** Local support metadata and cached catalog selection. Refresh alone owns network access. */
export function ProviderCatalogPicker({
  connection,
  selectedId,
  busy,
  onChoose,
}: {
  connection: Connection | undefined;
  selectedId: string;
  busy: boolean;
  onChoose: (model: CatalogModel) => void;
}) {
  const [query, setQuery] = useState(''),
    [limit, setLimit] = useState(24);
  if (!connection) return <p className="muted full">프로바이더를 먼저 선택해 주세요.</p>;
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
    <section className="provider-catalog full" aria-label="저장된 모델 목록에서 선택">
      <div className="provider-section-heading">
        <h4>모델 목록에서 선택</h4>
      </div>
      {catalog.length > 0 ? (
        <>
          <label className="provider-search">
            <SearchIcon size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="모델 목록 검색"
              placeholder="모델 이름 또는 ID"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(24);
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
                <small>{item.id}</small>

                {selectedId === item.id && <CheckIcon size={16} aria-hidden="true" />}
              </button>
            ))}
          </div>
          {!models.length && (
            <p className="muted">검색 결과가 없어요. 아래에서 모델 ID를 직접 입력할 수 있어요.</p>
          )}
          {models.length > limit && (
            <button
              type="button"
              className="secondary"
              onClick={() => setLimit((value) => value + 24)}
            >
              모델 더 보기 · {limit} / {models.length}
            </button>
          )}
        </>
      ) : (
        <p className="muted">
          저장된 목록이 없어요. 목록을 새로고침하거나 모델 ID를 직접 입력하세요.
        </p>
      )}
    </section>
  );
}
