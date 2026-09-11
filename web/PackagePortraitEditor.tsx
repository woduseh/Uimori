import { useLayoutEffect, useRef, useState } from 'react';
import type { ContentPackage } from '../core/content-package.js';
import { PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import { ContentAvatar } from './ContentAvatar.js';
import { Dialog } from './Dialog.js';
import { maxPackageImages, uploadPackageImage } from './package-image-upload.js';

/** Edits the current authoring draft; representative image changes are saved by the parent. */
export function PackagePortraitEditor({
  value,
  onChange,
  onDirtyChange,
  disabled = false,
}: {
  value: ContentPackage;
  onChange: (value: ContentPackage) => void;
  onDirtyChange?: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  const scope = `${value.id}@${value.revision}`;
  const latest = useRef({ value, onChange, onDirtyChange, scope });
  latest.current = { value, onChange, onDirtyChange, scope };
  const generation = useRef(0),
    upload = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [visibleCount, setVisibleCount] = useState(50),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a package/revision switch invalidates upload ownership and its local dialog state.
  useLayoutEffect(() => {
    generation.current++;
    setBusy(false);
    setOpen(false);
    setQuery('');
    setVisibleCount(50);
    setError('');
    setNotice('');
    return () => {
      generation.current++;
      upload.current?.abort();
      upload.current = null;
      latest.current.onDirtyChange?.(false);
    };
  }, [scope]);

  const update = (next: ContentPackage) => {
    latest.current.value = next;
    latest.current.onChange(next);
  };
  function selectImage(imageId: string) {
    if (disabled || busy) return;
    const current = latest.current.value,
      selected = current.images?.find((image) => image.id === imageId);
    if (!selected) return;
    update({
      ...current,
      portraitImageId: selected.id,
      images: current.images?.map((image) =>
        image.id === selected.id && image.allowedUse === 'inline'
          ? { ...image, allowedUse: 'both' }
          : image
      ),
    });
    setOpen(false);
    setError('');
    setNotice(
      selected.allowedUse === 'inline'
        ? '본문용 이미지의 사용 위치를 대표 이미지와 본문으로 바꿨어요. 자료를 저장하면 적용돼요.'
        : '대표 이미지를 선택했어요. 자료를 저장하면 적용돼요.'
    );
  }
  async function addFile(file: File) {
    if (disabled || upload.current) return;
    if ((latest.current.value.images?.length ?? 0) >= maxPackageImages) {
      setError('자료 하나에 이미지를 2,000개까지 등록할 수 있어요.');
      return;
    }
    const token = ++generation.current,
      originalScope = latest.current.scope,
      controller = new AbortController();
    upload.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    latest.current.onDirtyChange?.(true);
    const current = () =>
      generation.current === token &&
      latest.current.scope === originalScope &&
      !controller.signal.aborted;
    try {
      const image = await uploadPackageImage(file, controller.signal, 'profile');
      if (!current()) return;
      if ((latest.current.value.images?.length ?? 0) >= maxPackageImages)
        throw new Error('자료 하나에 이미지를 2,000개까지 등록할 수 있어요.');
      update({
        ...latest.current.value,
        images: [...(latest.current.value.images ?? []), image],
        portraitImageId: image.id,
      });
      setNotice('대표 이미지 전용으로 추가했어요. 자료를 저장하면 적용돼요.');
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '업로드하지 못했어요.');
    } finally {
      if (current()) {
        upload.current = null;
        setBusy(false);
        latest.current.onDirtyChange?.(false);
      }
    }
  }
  const images = value.images ?? [],
    needle = query.trim().toLocaleLowerCase();
  const found = images.filter((image) =>
    `${image.title} ${image.description}`.toLocaleLowerCase().includes(needle)
  );
  const portrait = images.find((image) => image.id === value.portraitImageId);
  return (
    <section className="package-portrait-editor" aria-label="대표 이미지 설정">
      <ContentAvatar
        className="package-portrait-avatar"
        content={{
          id: value.id,
          revision: value.revision,
          title: value.title,
          description: '',
          kind: 'module',
          text: '',
          loading: 'pinned',
          relatedIds: [],
          package: value,
        }}
      />
      <div className="package-portrait-controls">
        <strong>대표 이미지</strong>
        <small>{portrait?.title ?? '목록과 자료 선택 화면에 표시할 이미지를 골라요.'}</small>
        <div className="package-portrait-actions">
          <label
            className={`secondary package-portrait-upload${disabled || busy ? ' is-disabled' : ''}`}
          >
            이미지 업로드
            <input
              type="file"
              accept={PACKAGE_IMAGE_MIMES.join(',')}
              aria-label="대표 이미지 업로드"
              disabled={disabled || busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void addFile(file);
              }}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={disabled || busy || !images.length}
            onClick={() => {
              setQuery('');
              setVisibleCount(50);
              setOpen(true);
            }}
          >
            기존 이미지에서 선택
          </button>
          <button
            type="button"
            className="ghost"
            disabled={disabled || busy || !value.portraitImageId}
            onClick={() => {
              const next = { ...latest.current.value };
              delete next.portraitImageId;
              update(next);
              setError('');
              setNotice('대표 지정을 해제했어요. 이미지 파일은 자료에 남아요. 저장하면 적용돼요.');
            }}
          >
            대표 이미지 해제
          </button>
        </div>
        <small>PNG · JPEG · WebP, 2MB 이하</small>
        {busy && (
          <div className="package-portrait-actions">
            <span role="status">대표 이미지를 업로드하고 있어요…</span>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                generation.current++;
                upload.current?.abort();
                upload.current = null;
                setBusy(false);
                latest.current.onDirtyChange?.(false);
                setNotice('이미지 업로드를 취소했어요.');
              }}
            >
              업로드 취소
            </button>
          </div>
        )}
        {notice && <small role="status">{notice}</small>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <Dialog open={open} title="대표 이미지 선택" onClose={() => setOpen(false)} scopeKey={scope}>
        <label>
          이미지 검색
          <input
            type="search"
            aria-label="대표 이미지 검색"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisibleCount(50);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
            placeholder="이름 또는 설명"
          />
        </label>
        <div className="package-portrait-choices">
          {found.slice(0, visibleCount).map((image) => (
            <button
              type="button"
              className="secondary content-picker-choice"
              key={image.id}
              aria-pressed={value.portraitImageId === image.id}
              disabled={disabled || busy}
              onClick={() => selectImage(image.id)}
            >
              <ContentAvatar
                content={{
                  id: value.id,
                  revision: value.revision,
                  title: image.title,
                  kind: 'module',
                  description: '',
                  text: '',
                  loading: 'pinned',
                  relatedIds: [],
                  coverImage: {
                    url: `/api/package-image-blobs/${image.blobHash}`,
                    title: image.title,
                  },
                }}
              />
              <span className="content-picker-copy">
                <strong>{image.title}</strong>
                <small>
                  {image.allowedUse === 'inline'
                    ? '선택하면 대표 이미지와 본문에 사용해요.'
                    : image.allowedUse === 'profile'
                      ? '대표 이미지 전용'
                      : '대표 이미지와 본문'}
                </small>
              </span>
            </button>
          ))}
          {!found.length && <p className="muted">검색 결과가 없어요.</p>}
        </div>
        {found.length > visibleCount && (
          <button
            type="button"
            className="secondary"
            onClick={() => setVisibleCount((count) => count + 50)}
          >
            이미지 더 보기 ({visibleCount} / {found.length})
          </button>
        )}
      </Dialog>
    </section>
  );
}
