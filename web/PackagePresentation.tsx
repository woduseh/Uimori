import { t, useI18n } from './i18n.js';
import { UiError, legacyMessageString, uiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { useEffect, useRef, useState } from 'react';
import type { Job, Source } from '../core/types.js';
import { useWindowViewport } from './window-viewport.js';
import { throwApiError } from './api.js';

export type PackagePresentation = {
  sourceRevision: string;
  sourceHash: string;
  format: 'plain-text' | 'risu-html';
  nativeAction?: {
    program?: string;
    sourceIdentity?: string;
    expectedHeadRevision: string;
    expectedHeadHash: string;
    expectedVariableRevision: number;
  };
  original: {
    text: string;
    changed: boolean;
    applied: string[];
    html?: string;
    css?: string;
  };
  request?: { text: string; changed: boolean; applied: string[] };
  translation?: {
    text: string;
    changed: boolean;
    applied: string[];
    html?: string;
    css?: string;
  };
  translationId: string | null;
  translationRevision: number | null;
  issues: string[];
};
export function usePackagePresentation(
  source: Source,
  translation: Job | undefined,
  enabled: boolean,
  refreshKey: string
) {
  useI18n();
  const viewport = useWindowViewport(enabled);
  const sourceIdentity = `${source.chatId}:${source.id}`;
  const identity = `${sourceIdentity}:${source.hash}:${translation?.id ?? ''}:${translation?.revision ?? 0}:${translation?.status ?? ''}`;
  const key = `${identity}:${refreshKey}:${viewport?.width ?? ''}:${viewport?.height ?? ''}`;
  const sequence = useRef(0);
  const [result, setResult] = useState<{
    key: string;
    identity: string;
    sourceIdentity: string;
    data?: PackagePresentation;
    error?: string;
  }>();
  useEffect(() => {
    const requestId = ++sequence.current;
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const query = new URLSearchParams(
          viewport
            ? {
                viewportWidth: String(viewport.width),
                viewportHeight: String(viewport.height),
              }
            : {}
        );
        const response = await fetch(
          `/api/chats/${encodeURIComponent(source.chatId)}/sources/${encodeURIComponent(source.id)}/presentation?${query}`,
          { signal: controller.signal }
        );
        if (!response.ok) await throwApiError(response);
        const data = (await response.json()) as PackagePresentation;
        if (data.sourceRevision !== source.id || data.sourceHash !== source.hash)
          throw new UiError(uiMessage('library.theOriginalSnapshotDiffersFromThePresentation'));
        if (!['plain-text', 'risu-html'].includes(data.format))
          throw new UiError(uiMessage('library.unsupportedPresentationFormat'));
        if (
          data.translation &&
          (data.translationId !== translation?.id ||
            data.translationRevision !== (translation?.revision ?? 0))
        )
          throw new UiError(uiMessage('library.theTranslationSnapshotDiffersFromThePresentation'));
        if (!controller.signal.aborted && sequence.current === requestId)
          setResult({ key, identity, sourceIdentity, data });
      } catch (error) {
        if (!controller.signal.aborted && sequence.current === requestId)
          setResult({
            key,
            identity,
            sourceIdentity,
            error: legacyMessageString(
              uiMessage('library.couldNotApplyDisplayTransformationsShowingThe', {
                v0: toUiMessage(error),
              })
            ),
          });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [
    enabled,
    identity,
    sourceIdentity,
    key,
    viewport,
    source.chatId,
    source.id,
    source.hash,
    translation?.id,
    translation?.revision,
  ]);
  if (!enabled || result?.sourceIdentity !== sourceIdentity) return;
  if (result.identity === identity) return { ...result, pending: result.key !== key };
  return {
    ...result,
    pending: true,
    data: result.data && {
      ...result.data,
      translation: undefined,
      translationId: null,
      translationRevision: null,
    },
  };
}
export function PackagePresentationIssues({ data }: { data?: PackagePresentation }) {
  useI18n();
  if (!data) return null;
  const kinds = [
    ...new Set(
      data.issues.map((issue) =>
        issue.startsWith('native-image-tag-evaluation:')
          ? 'native-image-tag-evaluation'
          : issue.startsWith('native-image-tag-unavailable:')
            ? 'native-image-tag-unavailable'
            : issue
      )
    ),
  ];
  return (
    <>
      {kinds.map((kind) => (
        <p key={kind} role="status" className="muted package-presentation-issue">
          {kind === 'native-image-guidance-evaluation'
            ? t('library.someSelectedImagesWereOmittedBecauseImage')
            : kind === 'native-image-tag-evaluation'
              ? t('library.someSelectedImagesWereOmittedBecauseThe')
              : kind === 'native-image-tag-unavailable'
                ? t('library.selectedImagesWereOmittedBecauseTheyCould')
                : kind}
        </p>
      ))}
    </>
  );
}
