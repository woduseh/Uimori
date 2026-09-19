import { useCallback, useEffect, useRef, useState } from 'react';
import type { JevProviderStatus } from '../core/jev-provider.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { api, ApiError } from './api.js';
import { SaveButton } from './SaveButton.js';
import { RefreshIcon } from './ui-icons.js';
import './JevProviderSettings.css';

type Attempt = { expectedRevision: number; idempotencyKey: string };
const path = '/provider-management/jev';

function testFailure(code: string | null): string {
  if (code === 'JEV_HTTP_401' || code === 'JEV_HTTP_403')
    return 'API 키와 TypeSafe 계정의 사용 권한을 확인해 주세요.';
  if (code === 'JEV_HTTP_429') return '요청 한도나 계정 잔액을 확인한 뒤 다시 테스트해 주세요.';
  if (code === 'JEV_CREDENTIAL_REQUIRED') return '먼저 JEV API 키를 저장해 주세요.';
  if (code === 'JEV_CREDENTIAL_CHANGED')
    return '연결 정보가 바뀌었어요. 현재 상태를 새로 읽고 다시 테스트해 주세요.';
  if (code === 'JEV_TIMEOUT') return 'JEV 응답 시간이 초과됐어요. 처리 여부는 확인할 수 없어요.';
  if (code === 'SERVER_RESTARTED' || code === 'SERVER_STOPPING')
    return '서버가 중단되어 결과를 확인할 수 없어요. 테스트를 자동으로 다시 보내지 않아요.';
  return 'JEV의 정상 판단 결과를 확인하지 못했어요. 계정 상태를 확인한 뒤 다시 테스트해 주세요.';
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
  onDirtyChange,
  onBusyChange,
}: {
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState<JevProviderStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [test, setTest] = useState<ProviderConnectionTest | null>(null);
  const [testError, setTestError] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const polling = test?.status === 'running' && !testError;
  const busy = loading || operation || polling;
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
        if (!controller.signal.aborted)
          setError('JEV 연결 상태를 불러오지 못했어요. 다시 확인해 주세요.');
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
          if (!controller.signal.aborted)
            setTestError(
              '테스트 결과를 불러오지 못했어요. 상태 확인으로 기존 요청을 이어 확인해 주세요.'
            );
        });
    }, 1000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [test, testError, acceptTest]);

  async function save(remove = false) {
    if (!status || lock.current || busy || unresolved || conflict) return;
    lock.current = true;
    setOperation(true);
    setError('');
    setMessage('');
    try {
      const next = await api<JevProviderStatus>(
        path,
        { expectedRevision: status.revision, ...(remove ? {} : { apiKey }) },
        remove ? 'DELETE' : 'PUT'
      );
      if (!alive.current) return;
      setStatus(next);
      setApiKey('');
      setTest(next.latestTest);
      setMessage(
        remove
          ? '저장한 키를 삭제했어요.'
          : 'JEV API 키를 저장했어요. 연결 테스트를 실행할 수 있어요.'
      );
    } catch (caught) {
      if (!alive.current) return;
      if (caught instanceof ApiError && caught.status === 409) {
        setConflict(true);
        setError(
          '다른 화면에서 연결 정보가 바뀌었어요. 새로고침한 뒤 다시 저장해 주세요. 입력한 키는 유지돼요.'
        );
      } else {
        setError(
          '연결 정보 변경을 확인하지 못했어요. 새로고침으로 저장 상태를 확인해 주세요. 입력한 키는 유지돼요.'
        );
      }
    } finally {
      lock.current = false;
      if (alive.current) setOperation(false);
    }
  }

  async function startTest() {
    if (!status || lock.current || busy || apiKey || conflict) return;
    lock.current = true;
    setOperation(true);
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
        setError(
          caught.status === 409
            ? '연결 정보가 바뀌었어요. 새로고침한 뒤 다시 테스트해 주세요.'
            : '테스트 요청을 시작하지 못했어요. API 키와 연결 상태를 확인해 주세요.'
        );
      } else {
        setTestError(
          '요청 결과를 확인하지 못했어요. 상태 확인은 같은 요청을 복구하며 새 테스트를 추가하지 않아요.'
        );
      }
    } finally {
      lock.current = false;
      if (alive.current) setOperation(false);
    }
  }

  return (
    <section hidden={!active} className="jev-provider-settings" aria-label="JEV 판단 연결">
      <div className="provider-section-heading">
        <h3>TypeSafe JEV</h3>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshIcon size={16} aria-hidden="true" /> 연결 상태 새로고침
        </button>
      </div>
      <p>
        로어 관련성과 번역 거절 여부를 판단하는 모델이에요. 연결한 뒤 필요한 기능에서 JEV를 선택해
        주세요.
      </p>
      <div className="jev-provider-links">
        <a href="https://console.typesafe.ai" target="_blank" rel="noreferrer">
          TypeSafe에서 API 키 발급
        </a>
        <a
          href="https://typesafe.ai/blog/introducing-system-one-models-and-jev"
          target="_blank"
          rel="noreferrer"
        >
          JEV 안내
        </a>
      </div>
      {loading && <p role="status">연결 상태를 불러오는 중이에요…</p>}
      {status && (
        <>
          <dl className="jev-provider-details">
            <div>
              <dt>연결 키</dt>
              <dd>
                {status.credentialSource === 'saved'
                  ? 'Uimori에 저장한 키'
                  : status.credentialSource === 'environment'
                    ? '서버 환경변수의 키'
                    : '등록되지 않음'}
              </dd>
            </div>
            <div>
              <dt>모델</dt>
              <dd>{status.modelId}</dd>
            </div>
          </dl>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              JEV API 키{status.configured ? ' 교체' : ''}
              <input
                type="password"
                aria-label="JEV API 키"
                autoComplete="new-password"
                spellCheck={false}
                value={apiKey}
                disabled={busy || unresolved}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setMessage('');
                }}
              />
              <small>
                키는 서버에 저장하며 이 화면에 다시 표시하지 않아요. 연결 상태 새로고침과 관리 탭
                전환은 입력한 키를 유지해요.
              </small>
            </label>
            <div className="provider-actions">
              <SaveButton
                label="JEV API 키 저장"
                text="키 저장"
                disabled={!apiKey.trim() || busy || unresolved || conflict}
              />
              {apiKey && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || unresolved}
                  onClick={() => setApiKey('')}
                >
                  입력 지우기
                </button>
              )}
              {status.hasSavedKey && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || unresolved || !!apiKey || conflict}
                  onClick={() => void save(true)}
                >
                  저장한 JEV 키 삭제
                </button>
              )}
            </div>
            <small>
              저장한 키를 우선 사용해요. 삭제하면 서버의 TYPESAFE_API_KEY가 설정되어 있을 때 그 키를
              사용해요.
            </small>
          </form>
          <section className="jev-provider-test" aria-label="JEV 연결 테스트">
            <h4>판단 응답 테스트</h4>
            <p>짧은 예제의 관련성을 한 번 판단해요. 실제 JEV 요청이며 요금이 발생할 수 있어요.</p>
            <button
              type="button"
              className="secondary"
              disabled={!status.configured || busy || !!apiKey || conflict}
              onClick={() => void startTest()}
            >
              {operation || polling
                ? 'JEV 응답 확인 중…'
                : unresolved || testError
                  ? 'JEV 테스트 상태 확인'
                  : 'JEV 연결 테스트'}
            </button>
            {apiKey && <small>입력한 키를 저장하거나 지운 뒤 테스트해 주세요.</small>}
            {testError && (
              <p role="alert" className="error">
                {testError}
              </p>
            )}
            {test && (
              <div role="status" className="jev-test-result">
                {test.modelRevision !== status.revision && (
                  <p>이 결과는 이전 연결 정보로 실행한 테스트예요.</p>
                )}
                <strong>
                  {test.status === 'running'
                    ? 'JEV 판단을 기다리고 있어요…'
                    : test.status === 'completed'
                      ? 'JEV 판단 응답을 확인했어요.'
                      : 'JEV 연결 테스트를 완료하지 못했어요.'}
                </strong>
                {test.status !== 'running' && test.status !== 'completed' && (
                  <p>{testFailure(test.error)}</p>
                )}
                {test.status === 'completed' && score !== null && (
                  <p>예제 관련성: {(score * 100).toFixed(1)}%</p>
                )}
                <dl className="jev-provider-details">
                  {test.latencyMs !== null && (
                    <div>
                      <dt>응답 시간</dt>
                      <dd>{(test.latencyMs / 1000).toFixed(2)}초</dd>
                    </div>
                  )}
                  {test.usage.inputTokens !== null && (
                    <div>
                      <dt>입력 토큰</dt>
                      <dd>{test.usage.inputTokens.toLocaleString()}</dd>
                    </div>
                  )}
                  {test.usage.outputTokens !== null && (
                    <div>
                      <dt>출력 토큰</dt>
                      <dd>{test.usage.outputTokens.toLocaleString()}</dd>
                    </div>
                  )}
                  {test.usage.costUsd !== null && (
                    <div>
                      <dt>공급자 보고 비용</dt>
                      <dd>${test.usage.costUsd.toFixed(6)}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}
          </section>
          <aside className="provider-draft-note">
            <strong>연결한 JEV 사용하기</strong>
            <p>로어 선별: 채팅 설정 → 로어 문맥 → 로어 관련성 판단에서 JEV를 선택해요.</p>
            <p>번역 거절 판정: 역할별 모델 → 번역 오류 감지와 재시도에서 JEV를 선택해요.</p>
            <small>API 키를 저장해도 이 설정은 자동으로 바뀌지 않아요.</small>
          </aside>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
