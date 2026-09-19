import { useEffect, useRef, useState } from 'react';
import type { Job, Source } from '../core/types.js';

export type PackagePresentation = {
  sourceRevision: string;
  sourceHash: string;
  format: 'plain-text' | 'risu-html';
  nativeAction?: {
    branchId: string;
    expectedHeadRevision: string;
    expectedHeadHash: string;
    expectedVariableRevision: number;
  };
  /** Registered inline images from this source's frozen packages only. */
  inlineImageUrls?: string[];
  original: { text: string; changed: boolean; applied: string[]; html?: string; css?: string };
  request?: { text: string; changed: boolean; applied: string[] };
  translation?: { text: string; changed: boolean; applied: string[]; html?: string; css?: string };
  translationId: string | null;
  translationRevision: number | null;
  issues: string[];
};
export function usePackagePresentation(
  source: Source,
  translation: Job | undefined,
  enabled: boolean,
  refreshKey: string,
  branchId?: string
) {
  const identity = `${source.chatId}:${branchId ?? ''}:${source.id}:${source.hash}:${translation?.id ?? ''}:${translation?.revision ?? 0}:${translation?.status ?? ''}`;
  const key = `${identity}:${refreshKey}`;
  const sequence = useRef(0);
  const [result, setResult] = useState<{
    key: string;
    identity: string;
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
          `/api/chats/${encodeURIComponent(source.chatId)}/sources/${encodeURIComponent(source.id)}/presentation${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`,
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
        if (!['plain-text', 'risu-html'].includes(data.format))
          throw new Error('지원하지 않는 표시 형식이에요.');
        if (
          data.translation &&
          (data.translationId !== translation?.id ||
            data.translationRevision !== (translation?.revision ?? 0))
        )
          throw new Error('표시 결과의 번역 버전이 달라요.');
        if (!controller.signal.aborted && sequence.current === requestId)
          setResult({ key, identity, data });
      } catch (error) {
        if (!controller.signal.aborted && sequence.current === requestId)
          setResult({
            key,
            identity,
            error: `표시 변환을 적용하지 못해 저장된 본문을 표시해요. ${error instanceof Error ? error.message : ''}`,
          });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [
    enabled,
    identity,
    key,
    source.chatId,
    source.id,
    source.hash,
    translation?.id,
    translation?.revision,
    branchId,
  ]);
  return enabled && result?.identity === identity
    ? { ...result, pending: result.key !== key }
    : undefined;
}
export function PackagePresentationIssues({ data }: { data?: PackagePresentation }) {
  if (!data) return null;
  return (
    <>
      {data.issues.map((issue, i) => (
        <p key={i} role="status" className="muted">
          {issue}
        </p>
      ))}
    </>
  );
}
