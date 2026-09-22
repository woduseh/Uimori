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
  onStatusChange,
  onSaveHandlerChange,
}: {
  active: boolean;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onStatusChange: (status: JevProviderStatus) => void;
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
    if (!status || lock.current || busy || unresolved || conflict || (!remove && !apiKey.trim()))
      return false;
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
      if (!alive.current) return false;
      setStatus(next);
      setApiKey('');
      setTest(next.latestTest);
      setMessage(
        remove
          ? '저장한 키를 삭제했어요.'
          : 'TypeSafe AI와 JEV를 등록했어요. 연결 테스트를 실행할 수 있어요.'
      );
      return true;
    } catch (caught) {
      if (!alive.current) return false;
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
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setOperation(false);
    }
  }

  useSettingsSaveHandler(onSaveHandlerChange, save);

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
    <section
      hidden={!active}
      className="jev-provider-settings provider-management-form"
      aria-label="TypeSafe AI 프로바이더 설정"
    >
      <div className="provider-section-heading">
        <h3>{JEV_PROVIDER_DEFINITION.label}</h3>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshIcon size={16} aria-hidden="true" /> 연결 상태 새로고침
        </button>
      </div>
      {loading && <p role="status">연결 상태를 불러오는 중이에요…</p>}
      {status && (
        <>
          <form
            className="editor-grid provider-management-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset className="editor-fields provider-connection-fields full">
              <legend>접속 정보</legend>
              <label>
                프로바이더
                <input value={JEV_PROVIDER_DEFINITION.label} readOnly />
              </label>
              <label>
                모델
                <input value={`JEV · ${status.modelId} · 판단 전용`} readOnly />
              </label>
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
                  <span>
                    {status.credentialSource === 'saved' ? 'Uimori에 저장한 키' : '등록되지 않음'}
                  </span>
                  {' · '}
                  키는 서버에 저장하며 다시 표시하지 않아요.
                </small>
              </label>
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
              <details className="provider-auth-settings">
                <summary>키 보관 및 우선순위</summary>
                <div className="provider-auth-settings-body">
                  <p>
                    저장한 키를 우선 사용해요. 삭제하면 서버의 TYPESAFE_API_KEY가 설정되어 있을 때
                    그 키를 사용해요.
                  </p>
                  <p>연결 상태 새로고침과 관리 탭 전환은 입력한 키를 유지해요.</p>
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
                  저장한 JEV 키 삭제
                </button>
              )}
              <small className="provider-save-status">
                {apiKey
                  ? '아직 저장하지 않은 키가 있어요.'
                  : status.configured
                    ? '연결 키가 설정되어 있어요.'
                    : '키를 저장하면 JEV 모델이 등록돼요.'}
              </small>
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
              <SaveButton
                label="JEV API 키 저장"
                text="키 저장"
                disabled={!apiKey.trim() || busy || unresolved || conflict}
              />
            </div>
          </form>
          <section className="jev-provider-test provider-model-test" aria-label="JEV 연결 테스트">
            <h4>판단 응답 테스트</h4>
            <div className="provider-actions">
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
              <small>짧은 예제의 관련성을 판단해요. 요금이 발생할 수 있어요.</small>
            </div>
            {apiKey && <small>입력한 키를 저장하거나 지운 뒤 테스트해 주세요.</small>}
            {testError && (
              <p role="alert" className="error">
                {testError}
              </p>
            )}
            {test && (
              <div role="status" className="jev-test-result provider-test-result">
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
          <details className="provider-auth-settings">
            <summary>JEV가 맡는 판단</summary>
            <div className="provider-auth-settings-body">
              <p>
                본문 서비스 거절 판정: 역할별 모델에서 켜거나 끌 수 있어요. 켜면 전체 본문을
                검사하며 확신 기준은 역할별 모델의 작업 동작에서 조절해요. 거절 시 출력을 보존하고
                자동 재생성하지 않아요.
              </p>
              <p>
                번역 서비스 거절 판정: 전체 번역문을 검사해요. 역할별 모델 → 작업 동작 → 거절
                감지에서 켜거나 끄고 번역 전용 기준과 재시도 한도를 조절해요.
              </p>
              <p>로어 관련성 판정: 채팅 설정 → 로어 문맥에서 관련성 기준과 예산을 조절해요.</p>
              <p>이미지 선택: 본문에 사용할 이미지 후보를 선택해요.</p>
            </div>
          </details>
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
