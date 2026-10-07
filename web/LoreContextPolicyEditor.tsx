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

const tokenFields = [
  {
    key: 'maxRetainedTokens',
    label: '조회 로어 토큰 한도',
    min: 0,
    max: 200_000,
    unit: '추정 토큰',
  },
  {
    key: 'maxRetainedEntries',
    label: '조회 로어 구간 한도',
    min: 0,
    max: 256,
    unit: '구간',
  },
  {
    key: 'maxPinnedTokens',
    label: '고정 자료 토큰 한도',
    min: 1,
    max: 1_000_000,
    unit: '추정 토큰',
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
export function parseLorePolicyDraft(draft: PolicyDraft): LoreContextPolicy {
  for (const field of tokenFields) {
    const raw = draft[field.key];
    const number = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(number) || number < field.min || number > field.max)
      throw new Error(
        `${field.label}는 ${field.min.toLocaleString()}–${field.max.toLocaleString()} 사이 정수로 입력해 주세요.`
      );
  }
  if (!draft.threshold?.trim() || !draft.maxSelectedTokens?.trim() || !draft.maxInputTokens?.trim())
    throw new Error('Jev 관련성 기준과 토큰 한도를 입력해 주세요.');
  {
    const threshold = Number(draft.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      throw new Error('Jev 관련성 기준은 0–1 사이로 입력해 주세요.');
    for (const [key, label, min, max] of [
      ['maxSelectedTokens', 'Jev 선택 로어 토큰 한도', 0, 100000],
      ['maxInputTokens', 'Jev 판단 입력 토큰 한도', 1000, 30000],
    ] as const) {
      const value = Number(draft[key]);
      if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(
          `${label}는 ${min.toLocaleString()}–${max.toLocaleString()} 사이 정수로 입력해 주세요.`
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
  resetLabel = '전역 기본값 적용',
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
  const previewRequest = request.trim() ? request : '현재 로어 문맥을 확인해요.';
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
        setError(
          `미리보기를 구성하지 못했어요. 고정 자료 예산과 저장된 자료·프롬프트를 확인해 주세요. (${(caught as Error).message})`
        );
    } finally {
      if (sequence.current === version) setBusy(false);
    }
  }
  return (
    <section className="lore-context-panel settings-group full" aria-label="로어 문맥 정책">
      <h3 className="settings-group-heading">로어 사용</h3>
      <div className="settings-group-body">
        <div className="lore-context-heading settings-row settings-row-toggle">
          <div className="settings-row-copy">
            <span>조회 로어 유지</span>
            <p className="muted">조회한 로어를 다음 생성에서도 유지해요.</p>
          </div>
          <div className="settings-row-control">
            <Switch
              aria-label="조회한 로어를 다음 생성에 유지"
              checked={draft.enabled}
              onChange={(event) => change({ ...draft, enabled: event.target.checked })}
            />
          </div>
        </div>
        <details className="lore-context-advanced">
          <summary>선별 기준과 용량</summary>
          <h4>문맥 유지 한도</h4>
          <div className="lore-context-policy-grid">
            {tokenFields.map((field) => (
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
          <h4>관련성 판단</h4>
          <div className="lore-context-policy-grid">
            <label>
              관련성 기준
              <input
                aria-label="Jev 관련성 기준"
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={draft.threshold}
                onChange={(event) => change({ ...draft, threshold: event.target.value })}
              />
              <small>0–1, 높일수록 관련성이 높은 로어만 포함해요.</small>
            </label>
            <label>
              선택 로어 토큰 한도
              <input
                aria-label="Jev 선택 로어 토큰 한도"
                type="number"
                min="0"
                max="100000"
                value={draft.maxSelectedTokens}
                onChange={(event) => change({ ...draft, maxSelectedTokens: event.target.value })}
              />
            </label>
            <label>
              판단 입력 토큰 한도
              <input
                aria-label="Jev 판단 입력 토큰 한도"
                type="number"
                min="1000"
                max="30000"
                value={draft.maxInputTokens}
                onChange={(event) => change({ ...draft, maxInputTokens: event.target.value })}
              />
            </label>
          </div>
          <details className="lore-context-units">
            <summary>단위와 예산 설명</summary>
            <p className="muted">로어를 유지할 최대 크기를 정해요.</p>
            <ul>
              {tokenFields.map((field) => (
                <li key={field.key}>
                  {field.label}: {field.min.toLocaleString()}–{field.max.toLocaleString()}{' '}
                  {field.unit}
                </li>
              ))}
            </ul>
            <p className="muted">토큰은 로컬 추정값으로, 모델의 실제 사용량과 다를 수 있어요.</p>
            <p className="muted">
              조회 로어는 한도에 맞춰 정리하고, 고정 자료는 초과 시 자르지 않고 알려요.
            </p>
            <p className="muted">
              관련성 판단은 JEV를 사용해요. 전체 입력 한도와 프롬프트 배치는 별도예요.
            </p>
          </details>
        </details>
      </div>
      {validation && (
        <p className="error" role="alert">
          선별 기준과 용량의 입력을 확인해 주세요. {validation}
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
            <RotateCcw size={16} aria-hidden="true" /> 마지막 유효값으로 되돌리기
          </button>
        )}
        {footerAction}
      </div>
      {chatId && (
        <details className="lore-context-preview">
          <summary>다음 생성의 로어 미리보기</summary>
          <p className="muted">
            저장된 자료·프롬프트와 위 정책 초안을 사용해요. 모델을 호출하거나 조회 기록을 바꾸지
            않아요. 다른 채팅 설정의 초안은 먼저 저장해 주세요.
          </p>
          <p>
            {reset
              ? '새 장면 · 조회 로어 정리 선택을 포함해요.'
              : '현재 조회 로어를 이어 사용하는 요청이에요.'}
            {!request.trim() && ' 입력이 비어 있어 확인용 요청을 사용해요.'}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy || !policy}
            onClick={() => void showPreview()}
          >
            <RefreshCw size={16} aria-hidden="true" />{' '}
            {busy ? '로어 미리보기 구성 중…' : '로어 미리보기 갱신'}
          </button>
          {preview && (
            <div className="lore-context-preview-result">
              {preview.fingerprint !== fingerprint && (
                <p className="muted" role="status">
                  정책이나 다음 요청이 바뀌었어요. 아래는 이전 미리보기예요.
                </p>
              )}
              <LoreContextDiagnostics
                snapshot={preview.value.loreContext}
                reset={JSON.parse(preview.fingerprint).reset === true}
                label="미리보기의 조회 로어"
              />
              <details>
                <summary>
                  프롬프트 안의 실제 배치 · {preview.value.compilation.messages.length}메시지
                </summary>
                <ol className="lore-context-messages">
                  {preview.value.compilation.messages.map((message, index) => (
                    <li key={message.id}>
                      <details>
                        <summary>
                          {index + 1}. {message.role} · {message.provenance.origin} ·{' '}
                          {message.provenance.blockId}
                        </summary>
                        <pre>{message.content.map((part) => part.text).join('\n')}</pre>
                      </details>
                    </li>
                  ))}
                </ol>
              </details>
              {preview.value.error && (
                <p className="error" role="alert">
                  {preview.value.error}
                </p>
              )}
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </details>
      )}
    </section>
  );
}
