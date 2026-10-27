import {
  t,
  useI18n,
  translateMessage,
  formatNumber,
  formatDate,
  message as uiMessage,
} from './i18n.js';
import { RefreshIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import './codex-agent-settings.css';
import { useEffect, useRef, useState } from 'react';
import type { CodexRuntimeStatus } from '../core/agent-runtime.js';
import { api } from './api.js';

const runtimeErrors: Record<string, string> = {
  get CODEX_DISABLED() {
    return t('providers.m407');
  },
  get CODEX_NOT_INSTALLED() {
    return t('providers.m408');
  },
  get CODEX_EXECUTABLE_INVALID() {
    return t('providers.m409');
  },
  get CODEX_VERSION_UNSUPPORTED() {
    return t('providers.m410');
  },
  get CODEX_LOGIN_FAILED() {
    return t('providers.m411');
  },
  get CODEX_SUBSCRIPTION_REQUIRED() {
    return t('providers.m412');
  },
  get CODEX_LOGIN_REQUIRED() {
    return t('providers.m413');
  },
};

type CodexLimit = CodexRuntimeStatus['limits'][number];

const planNames: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

function codexPlanLabel(plan: string | null): string {
  if (!plan) return t('providers.m414');
  const normalized = plan.trim();
  return `ChatGPT ${planNames[normalized.toLowerCase()] ?? normalized}`;
}

function codexLimitLabel(limit: CodexLimit): string {
  const minutes = limit.windowDurationMins;
  if (minutes === 10_080) return t('providers.m415');
  if (minutes === 1_440) return t('providers.m416');
  if (minutes && minutes % 1_440 === 0) return t('providers.m583', { value0: minutes / 1_440 });
  if (minutes && minutes % 60 === 0) return t('providers.m584', { value0: minutes / 60 });
  if (minutes) return t('providers.m585', { value0: minutes });
  const name = limit.name.replace(/\s*·\s*(?:primary|secondary)$/iu, '').trim();
  return name && name.toLowerCase() !== 'codex'
    ? t('providers.m586', { value0: name })
    : t('providers.m417');
}

function codexResetLabel(resetsAt: number): { short: string; full: string } {
  const date = new Date(resetsAt * 1000);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const short = formatDate(date, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return {
    short,
    full: formatDate(date, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }),
  };
}

/** Authentication remains in the server's dedicated official Codex runtime. */
export function CodexAgentSettings({
  active = true,
  onOpenModels,
}: {
  active?: boolean;
  onOpenModels?: () => void;
}) {
  useI18n();
  const [status, setStatus] = useState<CodexRuntimeStatus>();
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const version = useRef(0),
    locked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh restarts polling and its login deadline.
  useEffect(() => {
    if (!active) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const current = ++version.current,
      deadline = Date.now() + 10 * 60 * 1000;
    async function poll() {
      if (!alive || current !== version.current) return;
      setChecking(true);
      try {
        const result = await api<CodexRuntimeStatus>('/agent-runtimes/codex');
        if (!alive || current !== version.current) return;
        setStatus(result);
        setError('');
        if (result.login && Date.now() < deadline)
          timer = setTimeout(() => {
            void poll();
          }, 3000);
        else if (result.login) setError(uiMessage('providers.m418'));
      } catch {
        if (alive && current === version.current) setError(uiMessage('providers.m419'));
      } finally {
        if (alive && current === version.current) setChecking(false);
      }
    }
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active, refresh]);
  async function action(path: string, method = 'POST') {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    ++version.current;
    setChecking(false);
    try {
      setStatus(await api<CodexRuntimeStatus>(path, {}, method));
      setRefresh((value) => value + 1);
    } catch {
      setError(uiMessage('providers.m420'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  // Only the official HTTPS verification page may be opened from runtime data.
  const verificationUrl = (() => {
    try {
      const url = new URL(status?.login?.verificationUrl ?? '');
      return url.origin === 'https://auth.openai.com' &&
        url.pathname === '/codex/device' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
        ? url.href
        : null;
    } catch {
      return null;
    }
  })();
  return (
    <section
      className={`codex-agent-settings${!status ? ' settings-loading-region' : ''}`}
      aria-label={t('providers.m421')}
    >
      <div className="codex-agent-heading">
        <IconButton
          icon={RefreshIcon}
          label={t('providers.m423')}
          disabled={busy || checking}
          aria-busy={checking}
          className={checking ? 'codex-agent-refreshing' : ''}
          onClick={() => setRefresh((value) => value + 1)}
        />
      </div>
      {!status ? (
        <LoadingState presentation="region" loading={!error} label={t('providers.m424')} />
      ) : (
        <>
          {!(status.authenticated && status.authMode === 'chatgpt') && (
            <p role="status" className="codex-agent-status">
              {!status.available
                ? t('providers.m425')
                : status.authMode === 'apikey'
                  ? t('providers.m426')
                  : status.login
                    ? t('providers.m427')
                    : t('providers.m428')}
            </p>
          )}
          {!status.available ? (
            <p>{(status.error && runtimeErrors[status.error]) || t('providers.m429')}</p>
          ) : status.authMode === 'apikey' ? (
            <p>{t('providers.m430')}</p>
          ) : status.error && status.error !== 'CODEX_LOGIN_REQUIRED' ? (
            <p className="error" role="alert">
              {runtimeErrors[status.error] ?? t('providers.m431')}
            </p>
          ) : null}
          {status.login && (
            <div className="compact-card" role="region" aria-label={t('providers.m443')}>
              <strong>{t('providers.m444')}</strong>
              <code>{status.login.userCode}</code>
              {verificationUrl ? (
                <a href={verificationUrl} target="_blank" rel="noopener noreferrer">
                  {t('providers.m445')}
                </a>
              ) : (
                <p className="error">{t('providers.m446')}</p>
              )}
              <small>{t('providers.m447')}</small>
            </div>
          )}
          {status.authenticated && status.authMode === 'chatgpt' && (
            <section className="settings-card codex-account-card" aria-label={t('providers.m448')}>
              <header className="codex-account-summary">
                <span className="codex-connected-status" role="status">
                  <span className="codex-status-dot" aria-hidden="true" />
                  {t('providers.m449')}
                </span>
                <span className="codex-plan-badge">{codexPlanLabel(status.planType)}</span>
              </header>
              {status.limits.length > 0 ? (
                <div className="codex-limit-list" aria-label={t('providers.m450')}>
                  {status.limits.map((limit, index) => {
                    const usedPercent = Math.round(limit.usedPercent);
                    const remainingPercent = Math.max(0, 100 - usedPercent);
                    const reset = limit.resetsAt === null ? null : codexResetLabel(limit.resetsAt);
                    return (
                      <div className="codex-limit-row" key={`${limit.name}-${index}`}>
                        <div className="codex-limit-heading">
                          <strong>{codexLimitLabel(limit)}</strong>
                          <span>{t('providers.m587', { value0: remainingPercent })}</span>
                        </div>
                        <div className="codex-limit-meter" aria-hidden="true">
                          <span style={{ width: `${remainingPercent}%` }} />
                        </div>
                        <div className="codex-limit-meta">
                          {reset ? (
                            <small title={reset.full}>
                              {t('providers.m588', { value0: reset.short })}
                            </small>
                          ) : (
                            <small>{t('providers.m453')}</small>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="codex-limit-unavailable muted">{t('providers.m455')}</p>
              )}
              {status.credits && (
                <div className="codex-limit-row codex-credit-row">
                  <div className="codex-limit-heading">
                    <strong>{t('providers.m456')}</strong>
                    <span>
                      {status.credits.unlimited
                        ? t('providers.m457')
                        : status.credits.balance !== null
                          ? t('providers.m590', {
                              value0: formatNumber(status.credits.balance, {
                                maximumFractionDigits: 0,
                              }),
                            })
                          : status.credits.hasCredits
                            ? t('providers.m458')
                            : t('providers.m349')}
                    </span>
                  </div>
                </div>
              )}
            </section>
          )}
          <div className="provider-actions">
            {status.available &&
              status.authenticated &&
              status.authMode === 'chatgpt' &&
              onOpenModels && (
                <button type="button" onClick={onOpenModels}>
                  {t('providers.m459')}
                </button>
              )}
            {status.available &&
              !status.authenticated &&
              !status.login &&
              status.authMode !== 'apikey' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void action('/agent-runtimes/codex/login');
                  }}
                >
                  {t('providers.m460')}
                </button>
              )}
            {status.login && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  void action('/agent-runtimes/codex/login/cancel');
                }}
              >
                {t('providers.m461')}
              </button>
            )}
            {(status.authenticated || status.authMode === 'apikey') && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  void action('/agent-runtimes/codex/session', 'DELETE');
                }}
              >
                {t('providers.m462')}
              </button>
            )}
          </div>
        </>
      )}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
    </section>
  );
}
