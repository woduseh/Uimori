import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { ModelPreset } from '../core/product.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { api } from './api.js';
import { ProviderRejectionNotice, rejectionMessage } from './provider-rejection.js';
import { VERTEX_LOCATION_CHOICES } from '../core/vertex-location.js';
import { vertexLocationLabel } from './vertex-location-label.js';
import './ProviderModelTest.css';

type TestDisplay = {
  pending: boolean;
  idempotencyKey: string;
  result?: ProviderConnectionTest;
  error?: string;
};
export const testKey = (model: Pick<ModelPreset, 'id' | 'revision'>, location?: string) =>
  `${model.id}@${model.revision}${location === undefined ? '' : `#${location}`}`;
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Results are keyed by the settings token at test start, independent of filtered cards and open forms. */
export function useProviderModelTests() {
  useI18n();
  const [records, setRecords] = useState<Record<string, TestDisplay>>({});
  const current = useRef(records),
    controllers = useRef(new Map<string, AbortController>());
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
    },
    []
  );
  function save(key: string, value: TestDisplay) {
    current.current = { ...current.current, [key]: value };
    setRecords(current.current);
  }
  async function start(model: ModelPreset, location?: string) {
    const key = testKey(model, location);
    if (controllers.current.has(key)) return;
    const previous = current.current[key],
      controller = new AbortController();
    controllers.current.set(key, controller);
    // An uncertain submission is recovered with the same key; a finished test starts a new explicit test.
    const recovery = previous?.error !== undefined;
    const idempotencyKey = recovery ? previous.idempotencyKey : crypto.randomUUID();
    let result = recovery ? previous.result : undefined;
    save(key, { pending: true, idempotencyKey, ...(result ? { result } : {}) });
    const active = () => !controller.signal.aborted && controllers.current.get(key) === controller;
    try {
      result = result
        ? await api<ProviderConnectionTest>(
            `/provider-management/tests/${encodeURIComponent(result.id)}`
          )
        : await api<ProviderConnectionTest>(
            `/provider-management/models/${encodeURIComponent(model.id)}/test`,
            {
              expectedRevision: model.revision,
              idempotencyKey,
              ...(location === undefined ? {} : { location }),
            }
          );
      while (active()) {
        if (
          result.modelId !== model.id ||
          result.modelRevision !== model.revision ||
          result.location !== location
        ) {
          result = undefined;
          throw new Error(uiMessage('providers.m292'));
        }
        save(key, { pending: result.status === 'running', idempotencyKey, result });
        if (result.status !== 'running') return;
        await pause(controller.signal);
        if (!active()) return;
        result = await api<ProviderConnectionTest>(
          `/provider-management/tests/${encodeURIComponent(result.id)}`
        );
      }
    } catch (error) {
      if (active())
        save(key, {
          pending: false,
          idempotencyKey,
          ...(result ? { result } : {}),
          error: error instanceof Error ? error.message : uiMessage('providers.m293'),
        });
    } finally {
      if (controllers.current.get(key) === controller) controllers.current.delete(key);
    }
  }
  return { records, start };
}

const statusLabel: Record<ProviderConnectionTest['status'], string> = {
  get running() {
    return t('providers.m294');
  },
  get completed() {
    return t('providers.m295');
  },
  get refused() {
    return t('providers.m296');
  },
  get partial() {
    return t('providers.m297');
  },
  get error() {
    return t('providers.m298');
  },
  get cancelled() {
    return t('providers.m299');
  },
  get interrupted() {
    return t('providers.m300');
  },
};
function locationOutcome(record: TestDisplay | undefined): string {
  const result = record?.result;
  if (record?.pending || result?.status === 'running') return t('providers.m294');
  if (record?.error || !result) return t('providers.m300');
  if (result.status === 'completed' && result.latencyMs !== null)
    return t('providers.vertexCompareSeconds', { value0: (result.latencyMs / 1000).toFixed(1) });
  if (result.error === 'HTTP_404') return t('providers.vertexCompareUnavailable');
  if (result.error === 'HTTP_429') return t('providers.vertexCompareBusy');
  if (result.error === 'HTTP_503') return t('providers.vertexCompareDown');
  if (result.error === 'TIMEOUT') return t('providers.vertexCompareTimeout');
  return result.error ? translateMessage(result.error) : statusLabel[result.status];
}

function LocationComparison({
  model,
  records,
  current,
  disabled,
  onStart,
}: {
  model: ModelPreset;
  records: Record<string, TestDisplay>;
  current: string;
  disabled: boolean;
  onStart: (model: ModelPreset, location?: string) => Promise<void>;
}) {
  const rows = VERTEX_LOCATION_CHOICES.map((location) => ({
    location,
    record: records[testKey(model, location)],
  }));
  const comparing = rows.some((row) => row.record?.pending);
  const timed = rows.flatMap(({ location, record }) =>
    record?.result?.status === 'completed' && record.result.latencyMs !== null && !record.pending
      ? [{ location, latencyMs: record.result.latencyMs }]
      : []
  );
  const fastest = timed.length
    ? timed.reduce((best, row) => (row.latencyMs < best.latencyMs ? row : best)).location
    : undefined;
  return (
    <div className="provider-location-compare">
      <div className="provider-actions">
        <button
          type="button"
          className="secondary"
          disabled={disabled || comparing}
          onClick={() => {
            for (const { location } of rows) void onStart(model, location);
          }}
        >
          {comparing ? t('providers.m294') : t('providers.vertexCompare')}
        </button>
        <small>{t('providers.vertexCompareCost', { value0: rows.length })}</small>
      </div>
      {rows.some((row) => row.record) && (
        <ul
          className="provider-location-results"
          aria-label={t('providers.vertexCompareResults', { value0: model.title })}
        >
          {rows.map(({ location, record }) => (
            <li key={location}>
              <span className="provider-location-name">
                {vertexLocationLabel(location)}
                {location === current && <small>{t('providers.vertexCompareCurrent')}</small>}
                {location === fastest && <small>{t('providers.vertexCompareFastest')}</small>}
              </span>
              <span className="provider-location-outcome">{locationOutcome(record)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ProviderModelTest({
  model,
  records,
  vertexLocation,
  available,
  busy,
  onStart,
}: {
  model: ModelPreset;
  records: Record<string, TestDisplay>;
  /** The saved location of the model's Vertex connection; absent for other providers. */
  vertexLocation?: string;
  available: boolean;
  busy: boolean;
  onStart: (model: ModelPreset, location?: string) => Promise<void>;
}) {
  useI18n();
  const record = records[testKey(model)];
  const result = record?.result;
  return (
    <section
      className="provider-model-test"
      aria-label={t('providers.m572', { value0: model.title })}
    >
      <div className="provider-actions">
        <button
          type="button"
          className="secondary"
          disabled={!available || busy || record?.pending}
          aria-label={t('providers.m573', { value0: model.title })}
          onClick={() => {
            void onStart(model);
          }}
        >
          {record?.pending
            ? t('providers.m294')
            : record?.error
              ? t('providers.m303')
              : t('providers.m304')}
        </button>
      </div>
      {!available && <small>{t('providers.m305')}</small>}
      {vertexLocation !== undefined && (
        <LocationComparison
          model={model}
          records={records}
          current={vertexLocation}
          disabled={!available || busy}
          onStart={onStart}
        />
      )}
      {record?.error ? (
        <div className="provider-test-result" role="alert">
          <p>{t('providers.m306')}</p>
          <details>
            <summary>{t('providers.m307')}</summary>
            <p>{translateMessage(record.error)}</p>
          </details>
        </div>
      ) : (
        result && (
          <div className="provider-test-result" role="status">
            <p>{statusLabel[result.status]}</p>
            {result.status !== 'completed' && result.status !== 'running' && (
              <>
                {result.rejection ? (
                  <p>{rejectionMessage(result.rejection)}</p>
                ) : result.error === 'ENDPOINT_NOT_APPROVED' ? (
                  <p>{t('providers.m308')}</p>
                ) : null}
                {(result.error || result.rejection) && (
                  <details>
                    <summary>{t('providers.m307')}</summary>
                    {result.rejection && <ProviderRejectionNotice rejection={result.rejection} />}
                    {result.error && <p className="error">{translateMessage(result.error)}</p>}
                  </details>
                )}
              </>
            )}
          </div>
        )
      )}
    </section>
  );
}
