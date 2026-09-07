import { useEffect, useRef, useState } from 'react';
import type { CodexRuntimeStatus } from '../core/agent-runtime.js';
import { api } from './api.js';

const runtimeErrors: Record<string, string> = {
  CODEX_DISABLED: '서버에서 Codex 연결 기능을 활성화해 주세요.',
  CODEX_NOT_INSTALLED: '서버에 공식 Codex 실행기를 설치하고 실행 위치를 설정해 주세요.',
  CODEX_EXECUTABLE_INVALID: '서버의 Codex 실행기 경로를 확인해 주세요.',
  CODEX_VERSION_UNSUPPORTED: '서버의 공식 Codex 실행기를 지원하는 버전으로 업데이트해 주세요.',
  CODEX_LOGIN_FAILED: 'Codex 로그인을 완료하지 못했어요. ChatGPT 로그인을 다시 시작해 주세요.',
  CODEX_SUBSCRIPTION_REQUIRED: 'API 키 연결을 해제한 뒤 ChatGPT 구독으로 로그인해 주세요.',
  CODEX_LOGIN_REQUIRED: 'ChatGPT 구독으로 Codex에 로그인해 주세요.',
};

/** Authentication remains in the server's dedicated official Codex runtime. */
export function CodexAgentSettings({ active = true }: { active?: boolean }) {
  const [status, setStatus] = useState<CodexRuntimeStatus>();
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
      try {
        const result = await api<CodexRuntimeStatus>('/agent-runtimes/codex');
        if (!alive || current !== version.current) return;
        setStatus(result);
        setError('');
        if (result.login && Date.now() < deadline)
          timer = setTimeout(() => {
            void poll();
          }, 3000);
        else if (result.login) setError('자동 확인을 멈췄어요. 로그인 상태를 다시 확인해 주세요.');
      } catch {
        if (alive && current === version.current)
          setError('Codex 상태를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.');
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
    try {
      setStatus(await api<CodexRuntimeStatus>(path, {}, method));
      setRefresh((value) => value + 1);
    } catch {
      setError('Codex 인증 작업을 완료하지 못했어요. 상태를 다시 확인해 주세요.');
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
    <section className="settings-section codex-agent-settings" aria-label="Codex 에이전트 연결">
      <h3>Codex · 개인 ChatGPT 구독</h3>
      <p>
        Codex는 Uimori 서버에서 실행해요. Uimori 전용 로그인으로 연결하며 PC와 휴대폰에서 같은 구독
        한도를 사용해요. API 키 방식으로 자동 전환하지 않아요.
      </p>
      {!status ? (
        <p role="status">Codex 준비 상태를 확인하고 있어요…</p>
      ) : (
        <>
          <p role="status">
            {!status.available
              ? '서버에 Codex 실행 설정이 필요해요'
              : status.authenticated && status.authMode === 'chatgpt'
                ? 'ChatGPT 구독으로 연결됐어요'
                : status.authMode === 'apikey'
                  ? 'API 키 로그인이 감지됐어요. 구독을 사용하려면 연결을 해제하고 ChatGPT로 로그인해 주세요.'
                  : status.login
                    ? '공식 페이지에서 로그인을 완료해 주세요'
                    : 'ChatGPT 로그인이 필요해요'}
          </p>
          {!status.available && (
            <p>
              서버 관리자가 공식 Codex 실행기와 Uimori 전용 실행 환경을 설정해야 해요. 서버 설정
              문서의 Codex 연결 절차를 확인해 주세요.
            </p>
          )}
          {status.error && (
            <p className="error" role="alert">
              {runtimeErrors[status.error] ??
                'Codex 실행 환경을 확인해 주세요. 서버에서 준비 상태를 확인하지 못했어요.'}
            </p>
          )}
          {status.login && (
            <div className="compact-card" role="region" aria-label="Codex 로그인 코드">
              <strong>로그인 코드</strong>
              <code>{status.login.userCode}</code>
              {verificationUrl ? (
                <a href={verificationUrl} target="_blank" rel="noopener noreferrer">
                  공식 Codex 로그인 페이지 열기
                </a>
              ) : (
                <p className="error">
                  공식 로그인 주소를 확인하지 못했어요. 로그인을 취소하고 다시 시도해 주세요.
                </p>
              )}
              <small>
                코드는 위의 공식 페이지에 직접 입력해요. 이 화면이 열려 있는 동안 완료 여부를
                확인해요.
              </small>
            </div>
          )}
          {status.planType && <p>구독: {status.planType}</p>}
          {status.limits.length > 0 && (
            <ul aria-label="Codex 구독 사용량">
              {status.limits.map((limit, index) => (
                <li key={`${limit.name}-${index}`}>
                  {limit.name} · 사용 {limit.usedPercent}%
                  {limit.resetsAt !== null &&
                    ` · 초기화 ${new Date(limit.resetsAt * 1000).toLocaleString()}`}
                </li>
              ))}
            </ul>
          )}
          <div className="provider-actions">
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
                  ChatGPT로 Codex 로그인
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
                Codex 로그인 취소
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
                Codex 연결 해제
              </button>
            )}
          </div>
        </>
      )}
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Codex 상태 다시 확인
      </button>
      <p>
        로그인 후 ‘연결과 모델’에서 Codex 연결과 모델 프리셋을 저장해요. 본문·번역·장면 상태·이미지
        작업·상태·기억과 모델 등록 요청에서 역할별로 선택할 수 있어요. 실제 요청은 구독 한도를
        사용해요.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
