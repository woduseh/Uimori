import { useState } from 'react';
import type { Asset } from '../core/product.js';
import { api } from './api.js';

/** Small local form: changing metadata never uploads or recompresses an image. */
export function AssetMetadataEditor({
  asset,
  onSaved,
}: {
  asset: Asset;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(asset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) {
          setDraft(asset);
          setError('');
        }
      }}
    >
      <summary>이름·설명 편집</summary>
      <label>
        이미지 이름
        <input
          aria-label="업로드 이미지 이름"
          value={draft.title}
          maxLength={200}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      <label>
        설명 · 선택
        <textarea
          aria-label="업로드 이미지 설명"
          value={draft.description}
          maxLength={2000}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <small>저장하면 다음 JEV 이미지 선택에 반영돼요.</small>
      <button
        type="button"
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
      {error && <small role="alert">{error}</small>}
    </details>
  );
}
