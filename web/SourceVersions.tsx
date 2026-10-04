import { useEffect, useState } from 'react';
import type { SourceVersions as Versions } from '../core/source-versions.js';
import { api } from './api.js';

export function SourceVersions({
  sourceId,
  revision,
  draft,
  disabled,
  onApply,
}: {
  sourceId: string;
  revision: number;
  draft: string;
  disabled: boolean;
  onApply: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const [priorDraft, setPriorDraft] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setVersions(null);
    setError('');
    void api<Versions>(`/sources/${sourceId}/versions`, undefined, 'GET', controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setVersions(result);
        setSelected(result.versions[1]?.revision ?? 0);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError((cause as Error).message);
      });
    return () => controller.abort();
  }, [open, sourceId]);
  const version = versions?.versions.find((item) => item.revision === selected);
  const label = (value: number) =>
    value === versions?.currentRevision ? '현재 저장본' : value === 0 ? '최초 원문' : '직전 저장본';
  return (
    <details className="source-versions" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>저장본 비교</summary>
      {open && (
        <>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {!versions && !error && <p role="status">저장본을 불러오는 중…</p>}
          {versions && version && (
            <>
              <label>
                비교할 저장본
                <select
                  value={selected}
                  onChange={(event) => setSelected(Number(event.target.value))}
                >
                  {versions.versions.map((item) => (
                    <option key={item.revision} value={item.revision}>
                      {label(item.revision)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="source-versions-comparison">
                <div>
                  <strong>{label(selected)}</strong>
                  <pre>{version.text}</pre>
                </div>
                <div>
                  <strong>편집 중인 초안</strong>
                  <pre>{draft}</pre>
                </div>
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    disabled || versions.currentRevision !== revision || draft === version.text
                  }
                  onClick={() => {
                    setPriorDraft(draft);
                    onApply(version.text);
                  }}
                >
                  선택본을 초안에 불러오기
                </button>
                {priorDraft !== null && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={disabled}
                    onClick={() => {
                      onApply(priorDraft);
                      setPriorDraft(null);
                    }}
                  >
                    불러오기 전 초안으로 돌아가기
                  </button>
                )}
              </div>
              <small>원문 저장을 눌러야 본문에 반영돼요.</small>
              {versions.currentRevision !== revision && (
                <p role="alert">저장본이 바뀌었어요. 편집기를 다시 열어 확인해 주세요.</p>
              )}
            </>
          )}
        </>
      )}
    </details>
  );
}
