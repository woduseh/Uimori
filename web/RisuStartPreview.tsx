import { LoadingState } from './LoadingState.js';
import { useEffect, useState } from 'react';
import type { Content } from '../core/product.js';
import { api } from './api.js';
import { RisuMessageSurface } from './RisuMessageSurface.js';
import { useWindowViewport } from './window-viewport.js';

export function RisuStartPreview({
  content,
  startId,
  userName,
}: {
  content: Content;
  startId: string;
  userName?: string;
}) {
  const viewport = useWindowViewport();
  const identity = `${content.id}:${content.revision}:${startId}:${userName ?? ''}`;
  const [preview, setPreview] = useState<{
    identity: string;
    html: string;
    css: string;
    issues: string[];
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
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
        if (!controller.signal.aborted) setPreview({ identity, ...value });
      })
      .catch((caught: Error) => {
        if (!controller.signal.aborted) setError(caught.message);
      });
    return () => {
      controller.abort();
    };
  }, [content.id, content.revision, startId, userName, identity, viewport]);
  if (!preview || preview.identity !== identity || error)
    return (
      <LoadingState
        compact
        loading={!error}
        error={error}
        errorLabel="시작 화면을 미리 볼 수 없어요."
        label="시작 화면을 불러오는 중이에요…"
      />
    );
  return (
    <>
      <RisuMessageSurface
        html={preview.html}
        css={preview.css}
        disabled
        onAction={async () => {}}
      />
      {preview.issues.length > 0 && (
        <details>
          <summary>미리보기에서 확인이 필요한 항목 ({preview.issues.length})</summary>
          <p>{preview.issues.join(', ')}</p>
        </details>
      )}
      <p className="muted">미리보기예요. 화면의 선택 버튼은 채팅을 만든 뒤 사용할 수 있어요.</p>
    </>
  );
}
