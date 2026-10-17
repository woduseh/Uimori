import { useEffect, useRef, useState } from 'react';
import type { Asset } from '../core/product.js';
import { api } from './api.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';

/** Small local form: changing metadata never uploads or recompresses an image. */
export function AssetMetadataEditor({
  asset,
  onSaved,
}: {
  asset: Asset;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(asset);
  const accepted = useRef(asset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    // Refresh pristine fields, while an edited draft keeps its original CAS revision.
    if (
      busy ||
      asset.revision <= accepted.current.revision ||
      draft.title !== accepted.current.title ||
      draft.description !== accepted.current.description
    )
      return;
    accepted.current = asset;
    setDraft(asset);
    setError('');
  }, [asset, busy, draft.title, draft.description]);
  return (
    <details aria-busy={busy}>
      <summary>이름·설명 편집</summary>
      <label>
        이미지 이름
        <input
          aria-label="업로드 이미지 이름"
          disabled={busy}
          value={draft.title}
          maxLength={200}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      <label>
        설명 · 선택
        <textarea
          aria-label="업로드 이미지 설명"
          disabled={busy}
          value={draft.description}
          maxLength={2000}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <small>저장하면 다음 이미지 자동 배치에 반영돼요.</small>
      <button
        type="button"
        className="primary"
        disabled={busy || !draft.title.trim()}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const saved = await api<Asset>(
              `/chats/${asset.chatId}/assets/${asset.id}`,
              {
                expectedRevision: draft.revision,
                title: draft.title,
                description: draft.description,
              },
              'PATCH'
            );
            accepted.current = saved;
            setDraft(saved);
            await onSaved();
          } catch (caught) {
            setError((caught as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        이미지 정보 저장
      </button>
      {busy && <LoadingState presentation="inline" label="이미지 정보를 저장하는 중이에요…" />}
      {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
    </details>
  );
}
