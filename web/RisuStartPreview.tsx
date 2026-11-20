import { useI18n, translateMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { useState } from 'react';
import type { Content } from '../core/product.js';
import { api } from './api.js';
import { RisuMessageSurface } from './RisuMessageSurface.js';
import { useWindowViewport } from './window-viewport.js';
import { useRetryableEffect } from './useRetryableEffect.js';

export function RisuStartPreview({
  content,
  startId,
  userName,
}: {
  content: Content;
  startId: string;
  userName?: string;
}) {
  const { t } = useI18n();

  const viewport = useWindowViewport();
  const identity = `${content.id}:${content.revision}:${startId}:${userName ?? ''}`;
  const [preview, setPreview] = useState<{
    identity: string;
    html: string;
    css: string;
    issues: string[];
  } | null>(null);
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const error = failure?.identity === identity ? failure.message : '';
  const retryPreview = useRetryableEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const query = new URLSearchParams({
      revision: String(content.revision),
      startId,
      ...(userName ? { userName } : {}),
      ...(viewport
        ? { viewportWidth: String(viewport.width), viewportHeight: String(viewport.height) }
        : {}),
    });
    void api<{ html: string; css: string; issues: string[] }>(
      `/content/${encodeURIComponent(content.id)}/risu-preview?${query}`,
      undefined,
      'GET',
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setPreview({ identity, ...value });
          setFailure(null);
        }
      })
      .catch((caught: Error) => {
        if (!controller.signal.aborted) setFailure({ identity, message: caught.message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [content.id, content.revision, startId, userName, identity, viewport]);
  if (!preview || preview.identity !== identity || error)
    return (
      <LoadingState
        presentation="placeholder"
        loading={loading}
        error={translateMessage(error)}
        errorLabel={t('native.text_78102a76b6')}
        label={t('native.text_f7b0125b0b')}
        onRetry={() => {
          setLoading(true);
          retryPreview();
        }}
      />
    );
  return (
    <>
      <RisuMessageSurface
        html={preview.html}
        css={preview.css}
        revisionKey={identity}
        disabled
        onAction={async () => {}}
      />
      {preview.issues.length > 0 && (
        <details>
          <summary>{t('native.previewIssues', { count: preview.issues.length })}</summary>
          <p>{preview.issues.map((issue) => translateMessage(issue)).join(', ')}</p>
        </details>
      )}
    </>
  );
}
