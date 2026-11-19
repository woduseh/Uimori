import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import { Activity as TestIcon, Globe as LocationIcon } from 'lucide-react';
import type { ModelPreset } from '../core/product.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { api } from './api.js';
import { ProviderRejectionNotice, rejectionMessage } from './provider-rejection.js';
import { VERTEX_LOCATION_CHOICES } from '../core/vertex-location.js';
import { vertexLocationLabel } from './vertex-location-label.js';
import { IconButton } from './IconButton.js';
import { CloseIcon } from './ui-icons.js';
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
  function dismiss(model: ModelPreset) {
    const own = testKey(model);
    current.current = Object.fromEntries(
      Object.entries(current.current).filter(
        ([key, record]) => record.pending || !(key === own || key.startsWith(`${own}#`))
      )
    );
    setRecords(current.current);
  }
  return { records, start, dismiss };
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

function LocationResults({
  model,
  records,
  current,
}: {
  model: ModelPreset;
  records: Record<string, TestDisplay>;
  current: string;
}) {
  const rows = VERTEX_LOCATION_CHOICES.map((location) => ({
    location,
    record: records[testKey(model, location)],
  }));
  if (!rows.some((row) => row.record)) return null;
  const timed = rows.flatMap(({ location, record }) =>
    record?.result?.status === 'completed' && record.result.latencyMs !== null && !record.pending
      ? [{ location, latencyMs: record.result.latencyMs }]
      : []
  );
  const fastest = timed.length
    ? timed.reduce((best, row) => (row.latencyMs < best.latencyMs ? row : best)).location
    : undefined;
  return (
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
  );
}

type TestProps = {
  model: ModelPreset;
  records: Record<string, TestDisplay>;
  /** The saved location of the model's Vertex connection; absent for other providers. */
  vertexLocation?: string;
  available: boolean;
  busy: boolean;
  onStart: (model: ModelPreset, location?: string) => Promise<void>;
};

/** Menu items of a model card; results appear beside the card only after a test ran. */
export function ProviderModelTestActions({
  model,
  records,
  vertexLocation,
  available,
  busy,
  onStart,
}: TestProps) {
  useI18n();
  const record = records[testKey(model)];
  const comparing = VERTEX_LOCATION_CHOICES.some(
    (location) => records[testKey(model, location)]?.pending
  );
  const unavailable = available ? undefined : t('providers.m305');
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={!available || busy || record?.pending}
        title={unavailable}
        aria-label={t('providers.m573', { value0: model.title })}
        onClick={() => {
          void onStart(model);
        }}
      >
        <TestIcon size={18} aria-hidden="true" />
        {record?.pending
          ? t('providers.m294')
          : record?.error
            ? t('providers.m303')
            : t('providers.m304')}
      </button>
      {vertexLocation !== undefined && (
        <button
          type="button"
          className="secondary"
          disabled={!available || busy || comparing}
          title={
            unavailable ??
            t('providers.vertexCompareCost', { value0: VERTEX_LOCATION_CHOICES.length })
          }
          onClick={() => {
            for (const location of VERTEX_LOCATION_CHOICES) void onStart(model, location);
          }}
        >
          <LocationIcon size={18} aria-hidden="true" />
          {comparing ? t('providers.m294') : t('providers.vertexCompare')}
        </button>
      )}
    </>
  );
}

export function ProviderModelTest({
  model,
  records,
  vertexLocation,
  onDismiss,
}: Pick<TestProps, 'model' | 'records' | 'vertexLocation'> & {
  onDismiss: (model: ModelPreset) => void;
}) {
  useI18n();
  const record = records[testKey(model)];
  const result = record?.result;
  const compared =
    vertexLocation !== undefined &&
    VERTEX_LOCATION_CHOICES.some((location) => records[testKey(model, location)]);
  if (!record && !compared) return null;
  const pending =
    record?.pending ||
    VERTEX_LOCATION_CHOICES.some((location) => records[testKey(model, location)]?.pending);
  return (
    <section
      className="provider-model-test dismissible"
      aria-label={t('providers.m572', { value0: model.title })}
    >
      <div className="provider-model-test-content">
        {record?.pending && !result && <p role="status">{t('providers.m294')}</p>}
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
        {compared && <LocationResults model={model} records={records} current={vertexLocation} />}
      </div>
      <IconButton
        icon={CloseIcon}
        label={t('providers.dismissTestResult', { value0: model.title })}
        disabled={pending}
        onClick={() => onDismiss(model)}
      />
    </section>
  );
}
