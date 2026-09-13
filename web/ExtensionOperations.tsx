import { useEffect, useRef, useState } from 'react';
import type { ExtensionOperationView } from '../core/extension-operation.js';
import type { ExtensionProgramResult } from '../core/extension-program.js';
import { api, labels } from './api.js';

export function ExtensionOperations({
  chatId,
  operations,
  titles,
  refresh,
}: {
  chatId: string;
  operations: ExtensionOperationView[];
  titles: Record<string, string>;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [results, setResults] = useState<Record<string, ExtensionProgramResult>>({});
  const mounted = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function act(operation: ExtensionOperationView, cancel: boolean) {
    if (lock.current) return;
    lock.current = true;
    setBusy(operation.id);
    setError('');
    const path = `/chats/${encodeURIComponent(chatId)}/extension-operations/${encodeURIComponent(operation.id)}`;
    try {
      if (cancel) {
        await api(`${path}/cancel`, {});
        if (mounted.current) await refresh();
      } else {
        const detail = await api<{ result: ExtensionProgramResult | null }>(
          `${path}?includeResult=1`
        );
        if (mounted.current && detail.result)
          setResults((current) => ({ ...current, [operation.id]: detail.result! }));
      }
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  if (!operations.length) return null;
  return (
    <section aria-label="자료 코드 작업" className="behavior-action-result">
      <h3>자료 코드 작업</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {operations.map((operation) => (
        <article key={operation.id} data-extension-operation={operation.id}>
          <h4>
            {titles[operation.instanceId] ?? '자료'} · {operation.title}
          </h4>
          <p role="status">
            {labels[operation.status]} · 모델 호출 {operation.usage.modelCalls}회
          </p>
          {operation.error && (
            <p className="muted">
              상태에 반영하지 못했어요. 원문과 기존 상태는 유지해요. ({operation.error})
            </p>
          )}
          <div className="form-actions">
            {['queued', 'running'].includes(operation.status) && (
              <button
                type="button"
                className="secondary"
                disabled={busy === operation.id}
                onClick={() => void act(operation, true)}
              >
                자료 작업 취소
              </button>
            )}
            {operation.hasResult && !results[operation.id] && (
              <button
                type="button"
                className="secondary"
                disabled={busy === operation.id}
                onClick={() => void act(operation, false)}
              >
                계산 결과 보기
              </button>
            )}
          </div>
          {results[operation.id] && (
            <details open>
              <summary>
                {operation.status === 'completed' ? '계산 결과' : '계산 결과 · 상태에 미반영'}
              </summary>
              <pre className="extension-operation-result">
                {JSON.stringify(results[operation.id], null, 2)}
              </pre>
            </details>
          )}
        </article>
      ))}
    </section>
  );
}
