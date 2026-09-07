import { useEffect, useRef, useState } from 'react';
import type { Job, Source } from '../core/types.js';

export type PackagePresentation = {
  sourceRevision: string;
  sourceHash: string;
  format: 'plain-text';
  original: { text: string; changed: boolean; applied: string[] };
  translation?: { text: string; changed: boolean; applied: string[] };
  translationId: string | null;
  translationRevision: number | null;
  issues: string[];
  stateViews: {
    packageId: string;
    revision: number;
    role: string;
    title: string;
    fields: { key: string; label: string; text: string; missing: boolean }[];
  }[];
};
export function usePackagePresentation(
  source: Source,
  translation: Job | undefined,
  enabled: boolean,
  refreshKey: string
) {
  const key = `${source.chatId}:${source.id}:${source.hash}:${translation?.id ?? ''}:${translation?.revision ?? 0}:${translation?.status ?? ''}:${refreshKey}`;
  const sequence = useRef(0);
  const [result, setResult] = useState<{
    key: string;
    data?: PackagePresentation;
    error?: string;
  }>();
  useEffect(() => {
    const requestId = ++sequence.current;
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/chats/${encodeURIComponent(source.chatId)}/sources/${encodeURIComponent(source.id)}/presentation`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(
            typeof error.message === 'string' ? error.message : `HTTP ${response.status}`
          );
        }
        const data = (await response.json()) as PackagePresentation;
        if (data.sourceRevision !== source.id || data.sourceHash !== source.hash)
          throw new Error('표시 결과의 원문 버전이 달라요.');
        if (data.format !== 'plain-text') throw new Error('지원하지 않는 표시 형식이에요.');
        if (
          data.translation &&
          (data.translationId !== translation?.id ||
            data.translationRevision !== (translation?.revision ?? 0))
        )
          throw new Error('표시 결과의 번역 버전이 달라요.');
        if (!controller.signal.aborted && sequence.current === requestId) setResult({ key, data });
      } catch (error) {
        if (!controller.signal.aborted && sequence.current === requestId)
          setResult({
            key,
            error: `패키지 표시를 적용하지 못해 저장된 본문을 표시해요. ${error instanceof Error ? error.message : ''}`,
          });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [enabled, key, source.chatId, source.id, source.hash, translation?.id, translation?.revision]);
  return enabled && result?.key === key ? result : undefined;
}
export function PackageStateCards({ data }: { data?: PackagePresentation }) {
  if (!data) return null;
  return (
    <>
      {data.issues.map((issue, i) => (
        <p key={i} role="status" className="muted">
          {issue}
        </p>
      ))}
      {data.stateViews.map((view) => (
        <aside
          className="scene-status"
          data-testid="package-state-view"
          key={`${view.packageId}@${view.revision}:${view.role}`}
          aria-label={view.title || '패키지 상태'}
        >
          <h4>{view.title || '패키지 상태'}</h4>
          <dl>
            {view.fields.map((field) => (
              <div key={field.key}>
                <dt>{field.label}</dt>
                <dd>{field.missing ? '아직 상태가 없어요' : field.text}</dd>
              </div>
            ))}
          </dl>
        </aside>
      ))}
    </>
  );
}
