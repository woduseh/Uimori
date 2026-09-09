import { useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { IconButton } from './IconButton.js';
import './settings-actions.css';
import type { Asset } from '../core/product.js';
import { api } from './api.js';
import { DeleteButton } from './DeleteButton.js';

const emptyFields = {
  title: '',
  description: '',
  actor: '',
  outfit: '',
  location: '',
  allowedUse: 'both' as Asset['allowedUse'],
};

export function AssetEditor({
  chatId,
  assets,
  refresh,
  onError,
  onDirtyChange,
  expanded = false,
}: {
  chatId: string;
  assets: Asset[];
  refresh: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  expanded?: boolean;
}) {
  const [value, setValue] = useState({ ...emptyFields });
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const hasUnsavedChanges =
    busy ||
    file !== null ||
    value.title.length > 0 ||
    value.description.length > 0 ||
    value.actor.length > 0 ||
    value.outfit.length > 0 ||
    value.location.length > 0 ||
    value.allowedUse !== 'both';
  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const visible = expanded || open;
  const pageSize = 48;
  const start = Math.min(
    page * pageSize,
    Math.max(0, Math.ceil(assets.length / pageSize) - 1) * pageSize
  );
  const content = (
    <>
      <div className="asset-grid">
        {visible &&
          assets.slice(start, start + pageSize).map((asset) => (
            <figure key={asset.id}>
              <img src={asset.url} alt={asset.description || asset.title} loading="lazy" />
              <figcaption>
                {asset.title}
                <small>
                  {[asset.actor, asset.outfit, asset.location].filter(Boolean).join(' · ')} ·{' '}
                  {asset.allowedUse}
                </small>
                {!asset.packageOwner && asset.url === `/api/assets/${asset.id}` && (
                  <DeleteButton
                    path={`/chats/${encodeURIComponent(chatId)}/assets/${encodeURIComponent(asset.id)}`}
                    title={asset.title}
                    label="이미지 삭제"
                    description="업로드 이미지 목록에서 삭제해요. 과거 채팅과 실행에 필요한 이미지 파일은 유지돼요."
                    disabled={busy}
                    onDeleted={async () => {
                      setMessage(asset.title + ' 이미지를 삭제했어요.');
                      await refresh();
                    }}
                    onError={onError}
                  />
                )}
              </figcaption>
            </figure>
          ))}
      </div>
      {visible && assets.length > pageSize && (
        <nav aria-label="이미지 목록 구간" className="reader-pages">
          <button
            className="secondary"
            disabled={start === 0}
            onClick={() => setPage(Math.max(0, page - 1))}
          >
            이전 이미지
          </button>
          <span>
            {start + 1}–{Math.min(start + pageSize, assets.length)} / {assets.length}
          </span>
          <button
            className="secondary"
            disabled={start + pageSize >= assets.length}
            onClick={() => setPage(page + 1)}
          >
            다음 이미지
          </button>
        </nav>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!file || uploadLock.current) return;
          uploadLock.current = true;
          setBusy(true);
          setMessage('');
          onError('');
          try {
            if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 2_000_000)
              throw new Error('2MB 이하 PNG 또는 JPEG를 선택해 주세요.');
            const base64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(',')[1]);
              reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했어요.'));
              reader.readAsDataURL(file);
            });
            await api(`/chats/${chatId}/assets`, { ...value, mime: file.type, base64 });
            setFile(null);
            setValue({ ...emptyFields });
            if (fileInput.current) fileInput.current.value = '';
            setMessage('이미지를 등록했어요.');
            try {
              await refresh();
            } catch (error) {
              onError(
                `이미지는 등록했지만 목록을 새로 불러오지 못했어요. ${(error as Error).message}`
              );
            }
          } catch (error) {
            onError((error as Error).message);
          } finally {
            uploadLock.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset className="editor-fields editor-grid" disabled={busy}>
          <label className="full">
            PNG 또는 JPEG 이미지
            <input
              ref={fileInput}
              aria-label="PNG 또는 JPEG 이미지"
              type="file"
              accept="image/png,image/jpeg"
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <label>
            이미지 이름
            <input
              aria-label="이미지 이름"
              required
              maxLength={160}
              value={value.title}
              onChange={(event) => setValue({ ...value, title: event.target.value })}
            />
          </label>
          <label>
            이미지 설명
            <input
              aria-label="이미지 설명"
              required
              maxLength={1000}
              value={value.description}
              onChange={(event) => setValue({ ...value, description: event.target.value })}
            />
          </label>
          <label>
            이미지 인물
            <input
              aria-label="이미지 인물"
              value={value.actor}
              onChange={(event) => setValue({ ...value, actor: event.target.value })}
            />
          </label>
          <label>
            이미지 의상
            <input
              aria-label="이미지 의상"
              value={value.outfit}
              onChange={(event) => setValue({ ...value, outfit: event.target.value })}
            />
          </label>
          <label>
            이미지 장소
            <input
              aria-label="이미지 장소"
              value={value.location}
              onChange={(event) => setValue({ ...value, location: event.target.value })}
            />
          </label>
          <label>
            이미지 용도
            <select
              aria-label="이미지 용도"
              value={value.allowedUse}
              onChange={(event) =>
                setValue({ ...value, allowedUse: event.target.value as Asset['allowedUse'] })
              }
            >
              <option value="both">프로필과 본문</option>
              <option value="profile">프로필</option>
              <option value="inline">본문</option>
            </select>
          </label>
          <div className="form-actions full settings-save-actions">
            <span role="status">{message}</span>
            <IconButton
              type="submit"
              icon={ImagePlus}
              label="이미지 등록"
              className="settings-save-button"
              disabled={busy || !file}
              aria-busy={busy}
            />
          </div>
        </fieldset>
      </form>
    </>
  );
  return expanded ? (
    <section className="workspace-tools" aria-label="이 이야기의 이미지">
      <p className="muted">등록된 이미지 {assets.length}개</p>
      {content}
    </section>
  ) : (
    <details className="workspace-tools" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        이 이야기의 이미지 <small>{assets.length}개</small>
      </summary>
      {content}
    </details>
  );
}
