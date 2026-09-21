import { useEffect, useState } from 'react';
import type { Content } from '../core/product.js';
import { api } from './api.js';
import { RisuMessageSurface } from './RisuMessageSurface.js';

export function RisuStartPreview({
  content,
  startId,
  userName,
}: {
  content: Content;
  startId: string;
  userName?: string;
}) {
  const [preview, setPreview] = useState<{ html: string; css: string; issues: string[] } | null>(
    null
  );
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPreview(null);
    setError('');
    const query = new URLSearchParams({
      revision: String(content.revision),
      startId,
      ...(userName ? { userName } : {}),
    });
    void api<{ html: string; css: string; issues: string[] }>(
      `/content/${encodeURIComponent(content.id)}/risu-preview?${query}`
    )
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((caught: Error) => {
        if (active) setError(caught.message);
      });
    return () => {
      active = false;
    };
  }, [content.id, content.revision, startId, userName]);
  if (error) return <p role="alert">시작 화면을 미리 볼 수 없어요: {error}</p>;
  if (!preview) return <p role="status">시작 화면을 불러오는 중이에요…</p>;
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
