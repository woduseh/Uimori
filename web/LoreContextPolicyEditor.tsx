import { Switch } from './BooleanControls.js';
import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_LORE_CONTEXT,
  validateLoreContextPolicy,
  type LoreContextPolicy,
  type LoreContextSnapshot,
} from '../core/lore-context.js';
import type { PromptCompilation } from '../core/prompt-program.js';
import { api } from './api.js';
import { LoreContextDiagnostics } from './LoreContextDiagnostics.js';
import './lore-context.css';

const fields = [
  { key: 'maxRetainedChars', label: '조회 로어 문자 한도', min: 0, max: 200_000, unit: 'UTF-16자' },
  { key: 'maxRetainedEntries', label: '조회 로어 구간 한도', min: 0, max: 256, unit: '구간' },
  { key: 'maxPinnedChars', label: '고정 자료 문자 한도', min: 1, max: 2_000_000, unit: 'UTF-16자' },
] as const;
type PolicyDraft = {
  enabled: boolean;
  maxRetainedChars: string;
  maxRetainedEntries: string;
  maxPinnedChars: string;
};
const draftOf = (policy: LoreContextPolicy): PolicyDraft => ({
  enabled: policy.enabled,
  maxRetainedChars: String(policy.maxRetainedChars),
  maxRetainedEntries: String(policy.maxRetainedEntries),
  maxPinnedChars: String(policy.maxPinnedChars),
});
export function parseLorePolicyDraft(draft: PolicyDraft): LoreContextPolicy {
  for (const field of fields) {
    const number = Number(draft[field.key]);
    if (
      !draft[field.key].trim() ||
      !Number.isSafeInteger(number) ||
      number < field.min ||
      number > field.max
    )
      throw new Error(
        `${field.label}는 ${field.min.toLocaleString()}–${field.max.toLocaleString()} 사이 정수로 입력해 주세요.`
      );
  }
  return validateLoreContextPolicy({
    enabled: draft.enabled,
    maxRetainedChars: Number(draft.maxRetainedChars),
    maxRetainedEntries: Number(draft.maxRetainedEntries),
    maxPinnedChars: Number(draft.maxPinnedChars),
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
  branchId,
  profileRevision,
  request = '',
  reset = false,
}: {
  value?: LoreContextPolicy;
  onChange: (value: LoreContextPolicy) => void;
  onPendingChange?: (dirty: boolean) => void;
  chatId: string;
  branchId?: string;
  profileRevision: number;
  request?: string;
  reset?: boolean;
}) {
  const effective = value ?? DEFAULT_LORE_CONTEXT,
    serialized = JSON.stringify(effective);
  const [draft, setDraft] = useState(() => draftOf(effective)),
    [preview, setPreview] = useState<{ value: Preview; fingerprint: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const previous = useRef(serialized),
    sequence = useRef(0);
  useEffect(() => {
    if (serialized !== previous.current) {
      const prior = previous.current;
      setDraft((current) => {
        try {
          return JSON.stringify(parseLorePolicyDraft(current)) === prior
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
      branchId,
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
    if (!policy) return;
    const version = ++sequence.current,
      source = fingerprint;
    setBusy(true);
    setError('');
    try {
      const result = await api<Preview>(`/chats/${encodeURIComponent(chatId)}/prompt-preview`, {
        request: previewRequest,
        role: 'main',
        loreContext: policy,
        ...(branchId ? { branchId } : {}),
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
    <section className="lore-context-panel" aria-label="로어 문맥 정책">
      <h3>로어 문맥</h3>
      <p className="muted">
        모델이 실제로 읽은 구간을 다음 생성에 이어 사용해요. 처음 읽은 이력 위치에 두며, 예산이 차면
        오래 사용하지 않은 자료부터 정리해요.
      </p>
      <label className="check">
        <Switch
          aria-label="조회한 로어를 다음 생성에 유지"
          checked={draft.enabled}
          onChange={(event) => change({ ...draft, enabled: event.target.checked })}
        />
        조회한 로어를 다음 생성에 유지
      </label>
      <div className="lore-context-policy-grid">
        {fields.map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              aria-label={field.label}
              inputMode="numeric"
              value={draft[field.key]}
              onChange={(event) => change({ ...draft, [field.key]: event.target.value })}
              aria-invalid={validation.startsWith(field.label)}
            />
            <small>
              {field.min.toLocaleString()}–{field.max.toLocaleString()} {field.unit}
            </small>
          </label>
        ))}
      </div>
      <p className="muted">
        문자 한도는 UTF-16 코드 단위예요. 예를 들어 이모지 하나가 2자로 계산될 수 있어요. 고정
        자료는 한도를 넘으면 요청을 중단해 알려요. 이 한도는 로어와 고정 자료에 적용하며 전체 모델
        입력 토큰 한도는 별도예요.
      </p>
      <p className="muted">
        사용자가 만든 PromptProgram의 역할·순서·캐시 기준은 그대로 사용해요. 이 설정이 사용자
        프롬프트를 다시 배치하지 않아요.
      </p>
      {validation && (
        <p className="error" role="alert">
          {validation} 입력한 초안은 유지돼요.
        </p>
      )}
      <div className="lore-context-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => change(draftOf(DEFAULT_LORE_CONTEXT))}
        >
          기본 정책으로
        </button>
        {validation && (
          <button type="button" className="ghost" onClick={() => setDraft(draftOf(effective))}>
            마지막 유효값으로 되돌리기
          </button>
        )}
      </div>
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
    </section>
  );
}
