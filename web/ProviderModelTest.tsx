import { t, useI18n } from './i18n.js';
import { formatUiMessage, UiError, type UiMessage, uiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { providerEndpoints } from '#contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { Activity as TestIcon, Globe as LocationIcon } from 'lucide-react';
import type { ModelPreset } from '../core/product.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { callEndpoint, definiteRejection } from './api.js';
import { ProviderRejectionNotice, rejectionMessage } from './provider-rejection.js';
import { providerFailureKey } from './provider-failure.js';
import { vertexLocationOptions } from '../core/vertex-location.js';
import { vertexLocationLabel } from './vertex-location-label.js';
import { IconButton } from './IconButton.js';
import { CloseIcon } from './ui-icons.js';
import './ProviderModelTest.css';

type TestDisplay = {
  pending: boolean;
  idempotencyKey: string;
  result?: ProviderConnectionTest;
  error?: UiMessage;
  rejected?: boolean;
  cancelled?: boolean;
};
export const testKey = (model: Pick<ModelPreset, 'id' | 'revision'>, location?: string) =>
  `${model.id}@${model.revision}${location === undefined ? '' : `#${location}`}`;
function shownLocations(
  model: ModelPreset,
  records: Record<string, TestDisplay>,
  current: string
): string[] {
  const prefix = `${testKey(model)}#`,
    locations = vertexLocationOptions(current);
  for (const key of Object.keys(records))
    if (key.startsWith(prefix) && !locations.includes(key.slice(prefix.length)))
      locations.push(key.slice(prefix.length));
  return locations;
}
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
    const recovery =
      (previous?.error !== undefined && !previous.rejected) || previous?.cancelled === true;
    const idempotencyKey = recovery ? previous.idempotencyKey : crypto.randomUUID();
    let result = recovery ? previous.result : undefined;
    save(key, { pending: true, idempotencyKey, ...(result ? { result } : {}) });
    const active = () => !controller.signal.aborted && controllers.current.get(key) === controller;
    try {
      result = result
        ? await callEndpoint(
            providerEndpoints.readConnectionTest,
            { id: result.id },
            controller.signal
          )
        : await callEndpoint(
            providerEndpoints.startModelTest,
            { id: model.id, expectedRevision: model.revision, idempotencyKey, location },
            controller.signal
          );
      while (active()) {
        if (
          result.modelId !== model.id ||
          result.modelRevision !== model.revision ||
          result.location !== location
        ) {
          result = undefined;
          throw new UiError(uiMessage('providers.m292'));
        }
        save(key, { pending: result.status === 'running', idempotencyKey, result });
        if (result.status !== 'running') return;
        await pause(controller.signal);
        if (!active()) return;
        result = await callEndpoint(
          providerEndpoints.readConnectionTest,
          { id: result.id },
          controller.signal
        );
      }
    } catch (error) {
      if (active())
        save(key, {
          pending: false,
          idempotencyKey,
          ...(result ? { result } : {}),
          error: toUiMessage(error, 'providers.m293'),
          ...(!result && definiteRejection(error) ? { rejected: true } : {}),
        });
    } finally {
      if (controllers.current.get(key) === controller) controllers.current.delete(key);
    }
  }
  function cancel(model: ModelPreset) {
    const prefix = `${testKey(model)}#`;
    for (const [key, controller] of controllers.current) {
      if (!key.startsWith(prefix)) continue;
      controller.abort();
      controllers.current.delete(key);
      const { result, idempotencyKey } = current.current[key];
      save(key, { pending: false, idempotencyKey, ...(result ? { result } : {}), cancelled: true });
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
  return { records, start, cancel, dismiss };
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
function responded(record: TestDisplay | undefined): record is TestDisplay & {
  result: ProviderConnectionTest & { latencyMs: number };
} {
  return (
    !!record &&
    !record.pending &&
    !record.cancelled &&
    record.error === undefined &&
    record.result?.status === 'completed' &&
    record.result.latencyMs !== null
  );
}
function locationOutcome(record: TestDisplay | undefined): string {
  const result = record?.result;
  if (record?.pending) return t('providers.m294');
  if (record?.cancelled) return t('providers.vertexCompareCancelled');
  if (result?.status === 'running') return t('providers.m294');
  if (record?.rejected && record.error) return formatUiMessage(record.error);
  if (record?.error || !result) return t('providers.m300');
  if (result.status === 'completed' && result.latencyMs !== null)
    return t('providers.vertexCompareSeconds', { value0: (result.latencyMs / 1000).toFixed(1) });
  if (result.error === 'HTTP_404') return t('providers.vertexCompareUnavailable');
  if (result.error === 'HTTP_429') return t('providers.vertexCompareBusy');
  if (result.error === 'HTTP_503') return t('providers.vertexCompareDown');
  if (result.error === 'TIMEOUT') return t('providers.vertexCompareTimeout');
  return (result.error && connectionTestFailure(result.error)) || statusLabel[result.status];
}
function connectionTestFailure(code: string): string | undefined {
  if (code === 'ENDPOINT_NOT_APPROVED') return t('providers.m308');
  if (code === 'SERVER_RESTARTED' || code === 'SERVER_STOPPING') return t('providers.m334');
  const key = providerFailureKey(code);
  return key === 'shared.responseFailure' ? undefined : t(key);
}

function LocationResults({
  model,
  records,
  current,
  disabled,
  onRetry,
  onCancel,
  onChangeLocation,
}: {
  model: ModelPreset;
  records: Record<string, TestDisplay>;
  current: string;
  disabled: boolean;
  onRetry: (location: string) => void;
  onCancel: () => void;
  onChangeLocation: (location: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null),
    requested = useRef<string | null>(null);
  useEffect(() => {
    if (requested.current !== current) return;
    requested.current = null;
    if (!list.current?.contains(document.activeElement)) list.current?.focus();
  }, [current]);
  const rows = shownLocations(model, records, current).map((location) => ({
    location,
    record: records[testKey(model, location)],
  }));
  if (!rows.some((row) => row.record)) return null;
  const timed = rows.flatMap(({ location, record }) =>
    responded(record) ? [{ location, latencyMs: record.result.latencyMs }] : []
  );
  const fastest = timed.length
    ? timed.reduce((best, row) => (row.latencyMs < best.latencyMs ? row : best)).location
    : undefined;
  const pending = rows.some(({ record }) => record?.pending);
  return (
    <>
      <ul
        ref={list}
        tabIndex={-1}
        className="provider-location-results"
        aria-label={t('providers.vertexCompareResults', { value0: model.title })}
      >
        {rows.map(({ location, record }) => {
          const label = vertexLocationLabel(location);
          const retry =
            !!record &&
            !record.pending &&
            !responded(record) &&
            (record.cancelled || record.error !== undefined || record.result?.error !== 'HTTP_404');
          return (
            <li key={location}>
              <span className="provider-location-name">
                {label}
                {location === current && <small>{t('providers.vertexCompareCurrent')}</small>}
                {location === fastest && <small>{t('providers.vertexCompareFastest')}</small>}
              </span>
              <span className="provider-location-outcome">
                {locationOutcome(record)}
                {responded(record) && location !== current && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={disabled}
                    aria-label={t('providers.vertexUseLocationNamed', { value0: label })}
                    onClick={() => {
                      requested.current = location;
                      onChangeLocation(location);
                    }}
                  >
                    {t('providers.vertexUseLocation')}
                  </button>
                )}
                {retry && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={disabled}
                    aria-label={t('providers.vertexCompareRetry', { value0: label })}
                    onClick={() => onRetry(location)}
                  >
                    {t('shared.retry')}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {pending && (
        <div className="provider-location-actions">
          <button
            type="button"
            className="secondary"
            aria-label={t('providers.vertexCompareCancel', { value0: model.title })}
            onClick={onCancel}
          >
            {t('shared.cancel')}
          </button>
        </div>
      )}
    </>
  );
}

type TestProps = {
  model: ModelPreset;
  records: Record<string, TestDisplay>;
  vertexLocation?: string;
  available: boolean;
  busy: boolean;
  onStart: (model: ModelPreset, location?: string) => Promise<void>;
};

export function ProviderModelTestActions({
  model,
  records,
  vertexLocation,
  available,
  busy,
  onStart,
}: TestProps) {
  useI18n();
  const costId = useId();
  const record = records[testKey(model)];
  const locations = vertexLocation === undefined ? [] : vertexLocationOptions(vertexLocation);
  const comparing = locations.some((location) => records[testKey(model, location)]?.pending);
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
          : record?.error && !record.rejected
            ? t('providers.m303')
            : t('providers.m304')}
      </button>
      {vertexLocation !== undefined && (
        <button
          type="button"
          className="secondary"
          disabled={!available || busy || comparing}
          title={unavailable}
          aria-label={comparing ? t('providers.m294') : t('providers.vertexCompare')}
          aria-describedby={costId}
          onClick={() => {
            for (const location of locations) void onStart(model, location);
          }}
        >
          <LocationIcon size={18} aria-hidden="true" />
          <span className="provider-menu-item-text">
            {comparing ? t('providers.m294') : t('providers.vertexCompare')}
            <small id={costId}>
              {t('providers.vertexCompareCost', { value0: locations.length })}
            </small>
          </span>
        </button>
      )}
    </>
  );
}

export function ProviderModelTest({
  model,
  records,
  vertexLocation,
  available,
  busy,
  onStart,
  onCancel,
  onDismiss,
  onChangeLocation,
}: TestProps & {
  onCancel: (model: ModelPreset) => void;
  onDismiss: (model: ModelPreset) => void;
  onChangeLocation: (model: ModelPreset, location: string) => void;
}) {
  useI18n();
  const record = records[testKey(model)];
  const result = record?.result;
  const locations =
    vertexLocation === undefined ? [] : shownLocations(model, records, vertexLocation);
  const compared = locations.some((location) => records[testKey(model, location)]);
  if (!record && !compared) return null;
  const pending =
    record?.pending || locations.some((location) => records[testKey(model, location)]?.pending);
  return (
    <section
      className="provider-model-test dismissible"
      aria-label={t('providers.m572', { value0: model.title })}
    >
      <div className="provider-model-test-content">
        {record?.pending && !result && <p role="status">{t('providers.m294')}</p>}
        {record?.error && record.rejected ? (
          <div className="provider-test-result" role="alert">
            <p>{formatUiMessage(record.error)}</p>
          </div>
        ) : record?.error ? (
          <div className="provider-test-result" role="alert">
            <p>{t('providers.m306')}</p>
            <details>
              <summary>{t('providers.m307')}</summary>
              <p>{formatUiMessage(record.error)}</p>
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
                  ) : result.error && connectionTestFailure(result.error) ? (
                    <p>{connectionTestFailure(result.error)}</p>
                  ) : null}
                  {(result.error || result.rejection) && (
                    <details>
                      <summary>{t('providers.m307')}</summary>
                      {result.rejection && <ProviderRejectionNotice rejection={result.rejection} />}
                      {result.error && <p className="error">{result.error}</p>}
                    </details>
                  )}
                </>
              )}
            </div>
          )
        )}
        {compared && vertexLocation !== undefined && (
          <LocationResults
            model={model}
            records={records}
            current={vertexLocation}
            disabled={!available || busy}
            onRetry={(location) => {
              void onStart(model, location);
            }}
            onCancel={() => onCancel(model)}
            onChangeLocation={(location) => onChangeLocation(model, location)}
          />
        )}
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
