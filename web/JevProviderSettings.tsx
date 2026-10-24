import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { JEV_PROVIDER_DEFINITION, type JevProviderStatus } from '../core/jev-provider.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { api, ApiError } from './api.js';
import { SaveButton } from './SaveButton.js';
import { RefreshIcon } from './ui-icons.js';
import './JevProviderSettings.css';

type Attempt = { expectedRevision: number; idempotencyKey: string };
const path = '/provider-management/jev';

function testFailure(code: string | null): string {
  if (code === 'JEV_HTTP_401' || code === 'JEV_HTTP_403') return t('providers.m329');
  if (code === 'JEV_HTTP_429') return t('providers.m330');
  if (code === 'JEV_CREDENTIAL_REQUIRED') return t('providers.m331');
  if (code === 'JEV_CREDENTIAL_CHANGED') return t('providers.m332');
  if (code === 'JEV_TIMEOUT') return t('providers.m333');
  if (code === 'SERVER_RESTARTED' || code === 'SERVER_STOPPING') return t('providers.m334');
  return t('providers.m335');
}

function relevance(test: ProviderConnectionTest): number | null {
  try {
    const score: unknown = JSON.parse(test.text).scores?.relevant;
    return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1
      ? score
      : null;
  } catch {
    return null;
  }
}

export function JevProviderSettings({
  active,
  view,
  onConnectionOpen,
  onDirtyChange,
  onBusyChange,
  onStatusChange,
  onSaveHandlerChange,
}: {
  active: boolean;
  view: 'connection' | 'model';
  onConnectionOpen: () => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onStatusChange: (status: JevProviderStatus) => void;
}) {
  useI18n();
  const [status, setStatus] = useState<JevProviderStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<'save' | 'delete' | 'test' | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [test, setTest] = useState<ProviderConnectionTest | null>(null);
  const [testError, setTestError] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const polling = test?.status === 'running' && !testError;
  const busy = loading || operation !== null || polling;
  const unresolved = !!attempt || test?.status === 'running';
  const score = test ? relevance(test) : null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () => onDirtyChange(apiKey.length > 0 || busy || unresolved),
    [apiKey, busy, unresolved, onDirtyChange]
  );
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(() => {
    if (status) onStatusChange(status);
  }, [status, onStatusChange]);

  const acceptTest = useCallback((result: ProviderConnectionTest) => {
    setTest(result);
    setTestError('');
    if (result.status !== 'running') {
      attemptRef.current = null;
      setAttempt(null);
    }
  }, []);

  useEffect(() => {
    // Incrementing this token retries the read without replacing the key draft.
    void refresh;
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<JevProviderStatus>(path, undefined, 'GET', controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setStatus(next);
        setConflict(false);
        // A status refresh must not replace a possibly submitted test with an older receipt.
        if (!attemptRef.current) {
          setTest(next.latestTest);
          setTestError('');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(uiMessage('providers.m336'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, refresh]);

  useEffect(() => {
    if (!test || test.status !== 'running' || testError) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<ProviderConnectionTest>(
        `/provider-management/tests/${encodeURIComponent(test.id)}`,
        undefined,
        'GET',
        controller.signal
      )
        .then((result) => {
          if (!controller.signal.aborted) acceptTest(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) setTestError(uiMessage('providers.m337'));
        });
    }, 1000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [test, testError, acceptTest]);

  async function save(remove = false) {
    if (!status || lock.current || busy || unresolved || conflict || (!remove && !apiKey.trim()))
      return false;
    lock.current = true;
    setOperation(remove ? 'delete' : 'save');
    setError('');
    setMessage('');
    try {
      const next = await api<JevProviderStatus>(
        path,
        { expectedRevision: status.revision, ...(remove ? {} : { apiKey }) },
        remove ? 'DELETE' : 'PUT'
      );
      if (!alive.current) return false;
      setStatus(next);
      setApiKey('');
      setTest(next.latestTest);
      setMessage(remove ? uiMessage('providers.m338') : uiMessage('providers.m339'));
      return true;
    } catch (caught) {
      if (!alive.current) return false;
      if (caught instanceof ApiError && caught.status === 409) {
        setConflict(true);
        setSaveConflict(true);
        setError(uiMessage('providers.m340'));
      } else {
        setError(uiMessage('providers.m341'));
      }
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setOperation(null);
    }
  }

  useSettingsSaveHandler(onSaveHandlerChange, save);

  async function startTest() {
    if (!status || lock.current || busy || apiKey || conflict) return;
    lock.current = true;
    setOperation('test');
    setTestError('');
    setMessage('');
    const previous = attemptRef.current;
    const next = previous ?? {
      expectedRevision: status.revision,
      idempotencyKey: crypto.randomUUID(),
    };
    attemptRef.current = next;
    setAttempt(next);
    try {
      // Recover a known receipt with GET; recover an uncertain submission with the original key.
      const result =
        test?.status === 'running'
          ? await api<ProviderConnectionTest>(
              `/provider-management/tests/${encodeURIComponent(test.id)}`
            )
          : await api<ProviderConnectionTest>(`${path}/test`, next);
      if (alive.current) acceptTest(result);
    } catch (caught) {
      if (!alive.current) return;
      if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500) {
        attemptRef.current = null;
        setAttempt(null);
        if (caught.status === 409) setConflict(true);
        setError(caught.status === 409 ? uiMessage('providers.m342') : uiMessage('providers.m343'));
      } else {
        setTestError(uiMessage('providers.m344'));
      }
    } finally {
      lock.current = false;
      if (alive.current) setOperation(null);
    }
  }

  return (
    <section
      hidden={!active}
      className="jev-provider-settings provider-management-form"
      aria-label={view === 'connection' ? t('providers.m345') : t('providers.m28')}
    >
      <SaveConflictDialog
        open={saveConflict}
        title={t('providers.m346')}
        onClose={() => setSaveConflict(false)}
        readSaved={async () => {
          const value = await api<JevProviderStatus>(path);
          return () => [
            {
              label: t('providers.m347'),
              value: value.configured ? t('providers.m348') : t('providers.m349'),
            },
            { label: t('providers.m50'), value: value.modelId },
            { label: t('providers.m45'), value: value.endpoint },
          ];
        }}
      />
      <div className="provider-section-heading">
        <h3>
          {view === 'connection'
            ? JEV_PROVIDER_DEFINITION.label
            : JEV_PROVIDER_DEFINITION.modelLabel}
        </h3>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshIcon size={16} aria-hidden="true" />
          {t('providers.m350')}
        </button>
      </div>
      {loading && (
        <LoadingState
          presentation={status ? 'inline' : 'placeholder'}
          label={t('providers.m351')}
        />
      )}
      {status && (
        <>
          <form
            hidden={view !== 'connection'}
            className="editor-grid provider-management-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset className="editor-fields provider-connection-fields full">
              <label>
                {t('providers.m578', { configured: String(status.configured) })}
                <input
                  type="password"
                  aria-label={t('providers.m353')}
                  autoComplete="new-password"
                  spellCheck={false}
                  value={apiKey}
                  disabled={busy || unresolved}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setMessage('');
                  }}
                />
                <small className="ui-meta-row">
                  <span>
                    {status.credentialSource === 'saved'
                      ? t('providers.m355')
                      : t('providers.m356')}
                  </span>
                  <span>{t('providers.m579', { value0: '' })}</span>
                </small>
              </label>
              <div className="jev-provider-links">
                <a href="https://console.typesafe.ai" target="_blank" rel="noreferrer">
                  {t('providers.m358')}
                </a>
              </div>
              <details className="provider-auth-settings">
                <summary>{t('providers.m359')}</summary>
                <div className="provider-auth-settings-body">
                  <p>{t('providers.m360')}</p>
                  <p>{t('providers.m361')}</p>
                </div>
              </details>
            </fieldset>
            <div className="provider-actions full provider-save-actions">
              {status.hasSavedKey && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || unresolved || !!apiKey || conflict}
                  onClick={() => void save(true)}
                >
                  {t('providers.m362')}
                </button>
              )}
              <small className="provider-save-status">
                {apiKey
                  ? t('providers.m363')
                  : status.configured
                    ? t('providers.m364')
                    : t('providers.m365')}
              </small>
              {apiKey && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || unresolved}
                  onClick={() => setApiKey('')}
                >
                  {t('providers.m366')}
                </button>
              )}
              <SaveButton
                label={t('providers.m367')}
                aria-busy={operation === 'save'}
                disabled={!apiKey.trim() || busy || unresolved || conflict}
              />
            </div>
          </form>
          {view === 'model' && (
            <div className="jev-provider-model">
              <dl className="jev-provider-details">
                <div>
                  <dt>{t('providers.m57')}</dt>
                  <dd>{JEV_PROVIDER_DEFINITION.label}</dd>
                </div>
                <div>
                  <dt>{t('providers.m203')}</dt>
                  <dd>{status.modelId}</dd>
                </div>
              </dl>
              <div className="provider-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={onConnectionOpen}
                >
                  {t('providers.m369')}
                </button>
                <a
                  href="https://typesafe.ai/blog/introducing-system-one-models-and-jev"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('providers.m370')}
                </a>
              </div>
            </div>
          )}
          <section
            hidden={view !== 'model'}
            className="jev-provider-test provider-model-test"
            aria-label={t('providers.m371')}
          >
            <h4>{t('providers.m372')}</h4>
            <div className="provider-actions">
              <button
                type="button"
                className="secondary"
                disabled={!status.configured || busy || !!apiKey || conflict}
                onClick={() => void startTest()}
              >
                {operation || polling
                  ? t('providers.m373')
                  : unresolved || testError
                    ? t('providers.m374')
                    : t('providers.m371')}
              </button>
              <small>{t('providers.m375')}</small>
            </div>
            {apiKey && <small>{t('providers.m376')}</small>}
            {testError && <NoticeBanner tone="error">{translateMessage(testError)}</NoticeBanner>}
            {test && (
              <div role="status" className="jev-test-result provider-test-result">
                {test.modelRevision !== status.revision && <p>{t('providers.m377')}</p>}
                <strong>
                  {test.status === 'running'
                    ? t('providers.m378')
                    : test.status === 'completed'
                      ? t('providers.m379')
                      : t('providers.m380')}
                </strong>
                {test.status !== 'running' && test.status !== 'completed' && (
                  <p>{testFailure(test.error)}</p>
                )}
                {test.status === 'completed' && score !== null && (
                  <p>
                    {t('providers.m580', {
                      value0: formatNumber(score * 100, {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      }),
                    })}
                  </p>
                )}
                <dl className="jev-provider-details">
                  {test.latencyMs !== null && (
                    <div>
                      <dt>{t('providers.m382')}</dt>
                      <dd>
                        {t('providers.m581', {
                          value0: formatNumber(test.latencyMs / 1000, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          }),
                        })}
                      </dd>
                    </div>
                  )}
                  {test.usage.inputTokens !== null && (
                    <div>
                      <dt>{t('providers.m384')}</dt>
                      <dd>{formatNumber(test.usage.inputTokens)}</dd>
                    </div>
                  )}
                  {test.usage.outputTokens !== null && (
                    <div>
                      <dt>{t('providers.m385')}</dt>
                      <dd>{formatNumber(test.usage.outputTokens)}</dd>
                    </div>
                  )}
                  {test.usage.costUsd !== null && (
                    <div>
                      <dt>{t('providers.m386')}</dt>
                      <dd>
                        $
                        {formatNumber(test.usage.costUsd, {
                          minimumFractionDigits: 6,
                          maximumFractionDigits: 6,
                        })}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            )}
          </section>
          <details hidden={view !== 'model'} className="provider-auth-settings">
            <summary>{t('providers.m387')}</summary>
            <div className="provider-auth-settings-body">
              <p>{t('providers.m388')}</p>
              <p>{t('providers.m389')}</p>
              <p>{t('providers.m390')}</p>
              <p>{t('providers.m391')}</p>
            </div>
          </details>
        </>
      )}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      <TransientNotice message={message} />
    </section>
  );
}
