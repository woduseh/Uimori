import {
  t,
  translateMessage,
  useI18n,
  getLocale,
  formatMessage,
  registerMessage,
  type MessageValues,
  messageRef,
  message as uiMessage,
} from './i18n.js';
import { Switch } from './BooleanControls.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCcw, RefreshCw } from 'lucide-react';
import {
  DEFAULT_LORE_CONTEXT,
  LORE_TOKEN_ESTIMATOR,
  validateLoreContextPolicy,
  type LoreContextPolicy,
  type LoreContextSnapshot,
} from '../core/lore-context.js';
import type { PromptCompilation } from '../core/risu-prompt.js';
import { api } from './api.js';
import { LoreContextDiagnostics } from './LoreContextDiagnostics.js';
import './lore-context.css';
import './settings-layout.css';
import { DEFAULT_JEV_JUDGMENT } from '../core/judgment.js';

const tokenFields = (locale = getLocale()) =>
  [
    {
      key: 'maxRetainedTokens',
      labelKey: 'settings.m204',
      label: formatMessage('settings.m204', locale),
      min: 0,
      max: 200_000,
      unit: t('settings.m205'),
    },
    {
      key: 'maxRetainedEntries',
      labelKey: 'settings.m206',
      label: formatMessage('settings.m206', locale),
      min: 0,
      max: 256,
      unit: t('settings.m207'),
    },
    {
      key: 'maxPinnedTokens',
      labelKey: 'settings.m208',
      label: formatMessage('settings.m208', locale),
      min: 1,
      max: 1_000_000,
      unit: t('settings.m205'),
    },
  ] as const;
type PolicyDraft = {
  enabled: boolean;
  maxRetainedTokens: string;
  maxRetainedEntries: string;
  maxPinnedTokens: string;
  threshold?: string;
  maxSelectedTokens?: string;
  maxInputTokens?: string;
};
const draftOf = (policy: LoreContextPolicy): PolicyDraft => ({
  enabled: policy.enabled,
  maxRetainedTokens: String(policy.maxRetainedTokens),
  maxPinnedTokens: String(policy.maxPinnedTokens),
  maxRetainedEntries: String(policy.maxRetainedEntries),
  threshold: String(policy.judgment?.threshold ?? DEFAULT_JEV_JUDGMENT.threshold),
  maxSelectedTokens: String(
    policy.judgment?.maxSelectedTokens ?? DEFAULT_JEV_JUDGMENT.maxSelectedTokens
  ),
  maxInputTokens: String(policy.judgment?.maxInputTokens ?? DEFAULT_JEV_JUDGMENT.maxInputTokens),
});
function policyError(
  key: string,
  values?: MessageValues,
  displayValues?: () => MessageValues
): Error {
  const raw = formatMessage(key, 'ko', values);
  registerMessage(raw, () => formatMessage(key, getLocale(), displayValues?.() ?? values));
  return new Error(raw);
}

export function parseLorePolicyDraft(draft: PolicyDraft): LoreContextPolicy {
  for (const field of tokenFields('ko')) {
    const raw = draft[field.key];
    const number = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(number) || number < field.min || number > field.max)
      throw policyError(
        'settings.m209',
        {
          v0: field.label,
          v1: field.min.toLocaleString('ko-KR'),
          v2: field.max.toLocaleString('ko-KR'),
        },
        () => ({
          v0: formatMessage(field.labelKey, getLocale()),
          v1: field.min.toLocaleString(getLocale()),
          v2: field.max.toLocaleString(getLocale()),
        })
      );
  }
  if (!draft.threshold?.trim() || !draft.maxSelectedTokens?.trim() || !draft.maxInputTokens?.trim())
    throw policyError('settings.m210');
  {
    const threshold = Number(draft.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      throw policyError('settings.m211');
    for (const [key, label, min, max] of [
      ['maxSelectedTokens', 'settings.m212', 0, 100000],
      ['maxInputTokens', 'settings.m213', 1000, 30000],
    ] as const) {
      const value = Number(draft[key]);
      if (!Number.isSafeInteger(value) || value < min || value > max)
        throw policyError(
          'settings.m209',
          {
            v0: formatMessage(label, 'ko'),
            v1: min.toLocaleString('ko-KR'),
            v2: max.toLocaleString('ko-KR'),
          },
          () => ({
            v0: formatMessage(label, getLocale()),
            v1: min.toLocaleString(getLocale()),
            v2: max.toLocaleString(getLocale()),
          })
        );
    }
  }
  return validateLoreContextPolicy({
    enabled: draft.enabled,
    tokenEstimator: LORE_TOKEN_ESTIMATOR,
    maxRetainedTokens: Number(draft.maxRetainedTokens),
    maxRetainedEntries: Number(draft.maxRetainedEntries),
    maxPinnedTokens: Number(draft.maxPinnedTokens),
    judgment: {
      threshold: Number(draft.threshold),
      maxSelectedTokens: Number(draft.maxSelectedTokens),
      maxInputTokens: Number(draft.maxInputTokens),
    },
  });
}
type Preview = {
  loreContext?: LoreContextSnapshot;
  compilation: PromptCompilation;
  error?: string;
  scope: string;
};

export function LoreContextPolicyEditor({
  value,
  onChange,
  onPendingChange,
  chatId,
  profileRevision,
  request = '',
  reset = false,
  defaults = DEFAULT_LORE_CONTEXT,
  resetLabel = t('settings.m214'),
  footerAction,
}: {
  value?: LoreContextPolicy;
  onChange: (value: LoreContextPolicy) => void;
  onPendingChange?: (dirty: boolean) => void;
  chatId?: string;
  profileRevision: number;
  request?: string;
  reset?: boolean;
  defaults?: LoreContextPolicy | null;
  resetLabel?: string;
  footerAction?: ReactNode;
}) {
  useI18n();
  const effective = value ?? DEFAULT_LORE_CONTEXT,
    serialized = JSON.stringify(effective);
  const [draft, setDraft] = useState(() => draftOf(effective)),
    [preview, setPreview] = useState<{
      value: Preview;
      fingerprint: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const previous = useRef(serialized),
    sequence = useRef(0);
  useEffect(() => {
    if (serialized !== previous.current) {
      const prior = previous.current;
      setDraft((current) => {
        try {
          return JSON.stringify(parseLorePolicyDraft(current)) ===
            JSON.stringify(parseLorePolicyDraft(draftOf(JSON.parse(prior))))
            ? draftOf(JSON.parse(serialized))
            : current;
        } catch {
          return current;
        }
      });
      previous.current = serialized;
    }
  }, [serialized]);
  let policy: LoreContextPolicy | undefined,
    validation = '';
  try {
    policy = parseLorePolicyDraft(draft);
  } catch (caught) {
    validation = (caught as Error).message;
  }
  useEffect(() => {
    onPendingChange?.(!!validation);
  }, [validation, onPendingChange]);
  useEffect(
    () => () => {
      sequence.current++;
    },
    []
  );
  const previewRequest = request.trim() ? request : '현재 로어 컨텍스트를 확인해요.';
  const fingerprint = JSON.stringify({
      chatId,
      profileRevision,
      policy,
      request: previewRequest,
      reset,
    }),
    latest = useRef(fingerprint);
  latest.current = fingerprint;
  function change(next: PolicyDraft) {
    setDraft(next);
    setError('');
    try {
      onChange(parseLorePolicyDraft(next));
    } catch {
      /* Preserve incomplete numeric input until it is valid. */
    }
  }
  async function showPreview() {
    if (!policy || !chatId) return;
    const version = ++sequence.current,
      source = fingerprint;
    setBusy(true);
    setError('');
    try {
      const result = await api<Preview>(`/chats/${encodeURIComponent(chatId)}/prompt-preview`, {
        request: previewRequest,
        role: 'main',
        loreContext: policy,
        ...(reset ? { loreContextReset: true } : {}),
      });
      if (sequence.current === version && latest.current === source)
        setPreview({ value: result, fingerprint: source });
    } catch (caught) {
      if (sequence.current === version && latest.current === source)
        setError(uiMessage('settings.m216', { v0: messageRef((caught as Error).message) }));
    } finally {
      if (sequence.current === version) setBusy(false);
    }
  }
  return (
    <section className="lore-context-panel settings-group full" aria-label={t('settings.m217')}>
      <h3 className="settings-group-heading">{t('settings.m218')}</h3>
      <div className="settings-group-body">
        <div className="lore-context-heading settings-row settings-row-toggle">
          <div className="settings-row-copy">
            <span>{t('settings.m219')}</span>
          </div>
          <div className="settings-row-control">
            <Switch
              aria-label={t('settings.m219')}
              checked={draft.enabled}
              onChange={(event) => change({ ...draft, enabled: event.target.checked })}
            />
          </div>
        </div>
        <details className="lore-context-advanced">
          <summary>{t('settings.m222')}</summary>
          <h4>{t('settings.m223')}</h4>
          <div className="lore-context-policy-grid">
            {tokenFields().map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  aria-label={field.label}
                  inputMode="numeric"
                  value={draft[field.key]}
                  onChange={(event) => change({ ...draft, [field.key]: event.target.value })}
                  aria-invalid={validation.startsWith(field.label)}
                />
              </label>
            ))}
          </div>
          <h4>{t('settings.m224')}</h4>
          <div className="lore-context-policy-grid">
            <label>
              {t('settings.m225')}
              <input
                aria-label={t('settings.m226')}
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={draft.threshold}
                onChange={(event) => change({ ...draft, threshold: event.target.value })}
              />
              <small>{t('settings.m227')}</small>
            </label>
            <label>
              {t('settings.m228')}
              <input
                aria-label={t('settings.m212')}
                type="number"
                min="0"
                max="100000"
                value={draft.maxSelectedTokens}
                onChange={(event) => change({ ...draft, maxSelectedTokens: event.target.value })}
              />
            </label>
            <label>
              {t('settings.m229')}
              <input
                aria-label={t('settings.m213')}
                type="number"
                min="1000"
                max="30000"
                value={draft.maxInputTokens}
                onChange={(event) => change({ ...draft, maxInputTokens: event.target.value })}
              />
            </label>
          </div>
          <details className="lore-context-units">
            <summary>{t('settings.m230')}</summary>
            <ul>
              {tokenFields().map((field) => (
                <li key={field.key}>
                  {field.label}: {field.min.toLocaleString(getLocale())}–
                  {field.max.toLocaleString(getLocale())} {field.unit}
                </li>
              ))}
            </ul>
            <p className="muted">{t('settings.m232')}</p>
            <p className="muted">{t('settings.m233')}</p>
            <p className="muted">{t('settings.m234')}</p>
          </details>
        </details>
      </div>
      {validation && (
        <p className="error" role="alert">
          {t('settings.flow12', { v0: translateMessage(validation) })}
        </p>
      )}
      <div className="lore-context-actions settings-form-footer">
        <button
          type="button"
          className="secondary"
          disabled={!defaults}
          onClick={() => {
            if (defaults) change(draftOf(defaults));
          }}
        >
          <RotateCcw size={16} aria-hidden="true" /> {resetLabel}
        </button>
        {validation && (
          <button type="button" className="ghost" onClick={() => change(draftOf(effective))}>
            <RotateCcw size={16} aria-hidden="true" />
            {t('settings.m236')}
          </button>
        )}
        {footerAction}
      </div>
      {chatId && (
        <details className="lore-context-preview">
          <summary>{t('settings.m237')}</summary>
          <p className="muted">{t('settings.m238')}</p>
          <p>
            {reset ? t('settings.m239') : t('settings.m240')}
            {!request.trim() && t('settings.m241')}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy || !policy}
            onClick={() => void showPreview()}
          >
            <RefreshCw size={16} aria-hidden="true" />{' '}
            {busy ? t('settings.m242') : t('settings.m243')}
          </button>
          {preview && (
            <div className="lore-context-preview-result">
              {preview.fingerprint !== fingerprint && (
                <p className="muted" role="status">
                  {t('settings.m244')}
                </p>
              )}
              <LoreContextDiagnostics
                snapshot={preview.value.loreContext}
                reset={JSON.parse(preview.fingerprint).reset === true}
                label={t('settings.m245')}
              />
              <details>
                <summary>
                  {t('settings.flow13', { v0: preview.value.compilation.messages.length })}
                </summary>
                <ol className="lore-context-messages">
                  {preview.value.compilation.messages.map((message, index) => (
                    <li key={message.id}>
                      <details>
                        <summary>
                          {index + 1}. {message.role} · {message.provenance.origin} ·{' '}
                          {message.provenance.blockId}
                        </summary>
                        <pre>
                          {message.content
                            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                            .join('\n')}
                        </pre>
                      </details>
                    </li>
                  ))}
                </ol>
              </details>
              {preview.value.error && (
                <p className="error" role="alert">
                  {translateMessage(preview.value.error)}
                </p>
              )}
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {translateMessage(error)}
            </p>
          )}
        </details>
      )}
    </section>
  );
}
