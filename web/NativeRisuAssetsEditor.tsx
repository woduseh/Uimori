import { ImageMetadataFields } from './ImageMetadataFields.js';
import { useLayoutEffect, useRef, useState } from 'react';
import type { RisuContent } from '../core/risu-content.js';
import { PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import {
  addNativeRisuImage,
  nativeImageNames,
  removeNativeRisuImage,
  replaceNativeRisuImage,
  unmappedNativeAssetCount,
} from '../core/risu-native-assets.js';
import { uploadPackageImage } from './package-image-upload.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { DeleteIcon, ImagesIcon } from './ui-icons.js';
import './native-risu-assets.css';

type Props = {
  value: RisuContent;
  onChange: (value: RisuContent) => void;
  onBusyChange?: (busy: boolean) => void;
};
const pageSize = 30;

export function NativeRisuAssetsEditor({ value, onChange, onBusyChange }: Props) {
  const scope = `${value.id}@${value.revision}`;
  const latest = useRef({ value, onChange, onBusyChange, scope });
  latest.current = { value, onChange, onBusyChange, scope };
  const upload = useRef<AbortController | null>(null),
    generation = useRef(0);
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState(''),
    [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [removing, setRemoving] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision changes invalidate the ownership of uploads and local selection.
  useLayoutEffect(() => {
    generation.current++;
    setBusy(false);
    setSelected('');
    setQuery('');
    setPage(0);
    setNotice('');
    setError('');
    setRemoving('');
    return () => {
      generation.current++;
      upload.current?.abort();
      upload.current = null;
      latest.current.onBusyChange?.(false);
    };
  }, [scope]);
  const change = (next: RisuContent) => {
    latest.current.value = next;
    latest.current.onChange(next);
  };
  async function filesChosen(files: File[], replacing?: string) {
    if (!files.length || upload.current) return;
    if (!replacing && (latest.current.value.images?.length ?? 0) + files.length > 2000) {
      setError('자료 하나에 이미지를 2,000개까지 등록할 수 있어요.');
      return;
    }
    const token = ++generation.current,
      owner = latest.current.scope,
      controller = new AbortController();
    upload.current = controller;
    setBusy(true);
    setError('');
    setNotice('이미지를 업로드하고 있어요.');
    latest.current.onBusyChange?.(true);
    const current = () =>
      generation.current === token && latest.current.scope === owner && !controller.signal.aborted;
    let completed = 0;
    const failures: string[] = [];
    try {
      for (const file of files) {
        if (!current()) return;
        try {
          const image = await uploadPackageImage(file, controller.signal, 'both');
          if (!current()) return;
          const next = replacing
            ? replaceNativeRisuImage(latest.current.value, replacing, image)
            : addNativeRisuImage(latest.current.value, image);
          change(next);
          setSelected(replacing ?? image.id);
          completed++;
        } catch (cause) {
          if (!current()) return;
          failures.push(
            `${file.name}: ${cause instanceof Error ? cause.message : '업로드하지 못했어요.'}`
          );
        }
      }
      if (current()) {
        setNotice(
          replacing && completed
            ? '파일을 교체했어요. 원래 에셋 이름과 연결은 유지해요. 저장하면 적용돼요.'
            : `${completed}개 이미지를 추가했어요. 저장하면 적용돼요.`
        );
        setError(failures.slice(0, 5).join('\n'));
      }
    } finally {
      if (current()) {
        upload.current = null;
        setBusy(false);
        latest.current.onBusyChange?.(false);
      }
    }
  }
  const images = value.images ?? [],
    needle = query.trim().toLocaleLowerCase();
  const found = images.filter((image) =>
    `${image.title} ${image.description} ${nativeImageNames(value, image.id).join(' ')}`
      .toLocaleLowerCase()
      .includes(needle)
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(found.length / pageSize) - 1));
  const active = images.find((image) => image.id === selected),
    pending = images.find((image) => image.id === removing);
  const names = active ? nativeImageNames(value, active.id) : [],
    missing = unmappedNativeAssetCount(value);
  return (
    <section className="native-risu-assets" aria-label="Risu 에셋 편집">
      <div className="native-assets-toolbar">
        <label className="native-assets-search">
          에셋 검색
          <input
            type="search"
            value={query}
            placeholder="에셋 이름으로 검색"
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
        </label>
        <label className="native-assets-upload">
          이미지 추가
          <input
            type="file"
            multiple
            accept={PACKAGE_IMAGE_MIMES.join(',')}
            disabled={busy}
            aria-label="Risu 이미지 추가"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void filesChosen(files);
            }}
          />
          <small>PNG · JPEG · WebP · AVIF · GIF, 최대 64MiB · 자동 WebP 변환</small>
        </label>
      </div>
      {missing > 0 && (
        <p className="muted native-assets-unavailable">
          이미지로 읽지 못한 원문 에셋 {missing}개는 보존하고 있어요. 이 화면에서는 편집할 수
          없으며, 내장 파일이 누락된 자료는 CHARX 내보내기가 제한될 수 있어요.
        </p>
      )}
      <p role="status" aria-live="polite" className="muted">
        {notice || `${images.length}개 이미지`}
        {busy && ' · 업로드가 끝난 뒤 저장해 주세요.'}
      </p>
      {error && (
        <p role="alert" className="error native-assets-error">
          {error}
        </p>
      )}
      <div className={`native-assets-layout${active ? ' has-selection' : ''}`}>
        <div>
          <div className="native-assets-grid" aria-label="Risu 이미지 목록">
            {found.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((image) => (
              <button
                type="button"
                key={image.id}
                className={`secondary native-assets-tile${image.id === selected ? ' is-selected' : ''}`}
                aria-pressed={image.id === selected}
                onClick={() => setSelected(image.id)}
              >
                <img src={`/api/package-image-blobs/${image.blobHash}`} alt="" loading="lazy" />
                <span>{image.title}</span>
                {image.id === value.portraitImageId && <small>대표 이미지</small>}
              </button>
            ))}
          </div>
          {!found.length && (
            <div className="native-assets-empty">
              <ImagesIcon size={28} aria-hidden="true" />
              <p>
                {images.length
                  ? '검색 결과가 없어요.'
                  : '추가한 이미지를 여기서 확인하고 교체할 수 있어요.'}
              </p>
            </div>
          )}
          {found.length > pageSize && (
            <div className="native-assets-pages">
              <button
                type="button"
                className="secondary"
                disabled={!currentPage}
                onClick={() => setPage(currentPage - 1)}
              >
                이전
              </button>
              <span>
                {currentPage + 1} / {Math.ceil(found.length / pageSize)}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={(currentPage + 1) * pageSize >= found.length}
                onClick={() => setPage(currentPage + 1)}
              >
                다음
              </button>
            </div>
          )}
        </div>
        {active && (
          <aside className="native-assets-detail" aria-label="선택한 에셋">
            <img
              className="native-assets-preview"
              src={`/api/package-image-blobs/${active.blobHash}`}
              alt={active.title}
            />
            <ImageMetadataFields
              image={active}
              onChange={(next) =>
                change({
                  ...value,
                  images: images.map((image) => (image.id === next.id ? next : image)),
                })
              }
            />
            <details>
              <summary>스크립트 참조 이름</summary>
              <code>{names.join(', ') || active.id}</code>
            </details>
            <p className="muted">
              {names.length
                ? '에셋 이름은 원문의 연결에 사용돼요. 파일을 교체해도 이름과 연결을 유지해요.'
                : '대표 이미지 등으로 추가한 이미지예요. CHARX 내보내기에도 포함돼요.'}
            </p>
            <div className="native-assets-actions">
              <label>
                파일 교체
                <input
                  type="file"
                  accept={PACKAGE_IMAGE_MIMES.join(',')}
                  disabled={busy}
                  aria-label="선택한 Risu 이미지 파일 교체"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void filesChosen([file], active.id);
                  }}
                />
              </label>
              <IconButton
                label="선택한 에셋 제거"
                icon={DeleteIcon}
                disabled={busy}
                onClick={() => setRemoving(active.id)}
              />
            </div>
          </aside>
        )}
      </div>
      <Dialog
        open={!!pending}
        title="이 에셋을 자료에서 제거할까요?"
        onClose={() => setRemoving('')}
        scopeKey={scope}
        role="alertdialog"
      >
        <p>
          {pending && (nativeImageNames(value, pending.id).join(', ') || pending.title)} 이미지와 이
          자료의 에셋 연결을 제거해요. 원본 파일은 삭제하지 않아요.
        </p>
        <p className="muted">
          본문·로어·HTML·스크립트에서 이 에셋을 부르는 이름은 그대로 남아요. 제거하면 해당 이미지가
          표시되지 않을 수 있어요.
        </p>
        <div className="native-assets-actions">
          <button type="button" className="secondary" onClick={() => setRemoving('')}>
            취소
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (!pending || busy) return;
              try {
                change(removeNativeRisuImage(latest.current.value, pending.id));
                setSelected('');
                setRemoving('');
                setNotice('자료에서 제거했어요. 저장하면 적용돼요.');
                setError('');
              } catch (cause) {
                setRemoving('');
                setError(cause instanceof Error ? cause.message : '제거하지 못했어요.');
              }
            }}
          >
            에셋 제거
          </button>
        </div>
      </Dialog>
    </section>
  );
}
