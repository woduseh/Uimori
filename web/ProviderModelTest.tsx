import { useEffect, useRef, useState } from 'react';
import type { ModelPreset } from '../core/product.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { api } from './api.js';
import { ProviderRejectionNotice, rejectionMessage } from './provider-rejection.js';
import './ProviderModelTest.css';

type TestDisplay = {
  pending: boolean;
  idempotencyKey: string;
  result?: ProviderConnectionTest;
  error?: string;
};
const scope = (model: Pick<ModelPreset, 'id' | 'revision'>) => `${model.id}@${model.revision}`;
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
  async function start(model: ModelPreset) {
    const key = scope(model);
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
            { expectedRevision: model.revision, idempotencyKey }
          );
      while (active()) {
        if (result.modelId !== model.id || result.modelRevision !== model.revision) {
          result = undefined;
          throw new Error(
            '응답 테스트 이후 모델 설정이 바뀌었어요. 현재 설정으로 다시 테스트해 주세요.'
          );
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
          error: error instanceof Error ? error.message : '응답 테스트 상태를 확인하지 못했어요.',
        });
    } finally {
      if (controllers.current.get(key) === controller) controllers.current.delete(key);
    }
  }
  return { records, start };
}

const statusLabel: Record<ProviderConnectionTest['status'], string> = {
  running: '응답 확인 중…',
  completed: '응답에 성공했어요.',
  refused: '모델이 응답을 거절했어요.',
  partial: '응답이 끝까지 도착하지 않았어요.',
  error: '응답에 실패했어요.',
  cancelled: '테스트가 취소됐어요.',
  interrupted: '실행 결과를 확인하지 못했어요.',
};
export function ProviderModelTest({
  model,
  record,
  available,
  busy,
  onStart,
}: {
  model: ModelPreset;
  record: TestDisplay | undefined;
  available: boolean;
  busy: boolean;
  onStart: (model: ModelPreset) => Promise<void>;
}) {
  const result = record?.result;
  return (
    <section className="provider-model-test" aria-label={model.title + ' 응답 테스트 결과'}>
      <div className="provider-actions">
        <button
          type="button"
          className="secondary"
          disabled={!available || busy || record?.pending}
          aria-label={model.title + ' 응답 테스트'}
          onClick={() => {
            void onStart(model);
          }}
        >
          {record?.pending
            ? '응답 확인 중…'
            : record?.error
              ? '테스트 상태 다시 확인'
              : '응답 테스트'}
        </button>
        <small>요금이 발생할 수 있어요.</small>
      </div>
      {!available && <small>모델과 프로바이더를 활성화해 주세요.</small>}
      {record?.error ? (
        <div className="provider-test-result" role="alert">
          <p>실행 결과를 확인하지 못했어요. 상태를 다시 확인해 주세요.</p>
          <details>
            <summary>오류 상세</summary>
            <p>{record.error}</p>
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
                  <p>프로바이더 편집에서 요청 주소를 확인해 주세요.</p>
                ) : null}
                {(result.error || result.rejection) && (
                  <details>
                    <summary>오류 상세</summary>
                    {result.rejection && <ProviderRejectionNotice rejection={result.rejection} />}
                    {result.error && <p className="error">{result.error}</p>}
                  </details>
                )}
              </>
            )}
          </div>
        )
      )}
    </section>
  );
}
