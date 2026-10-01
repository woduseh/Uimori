import type { PackageImage } from '../core/package-images.js';

/** Display metadata is independent of image bytes and native script aliases. */
export function ImageMetadataFields({
  image,
  onChange,
  portrait = false,
}: {
  image: PackageImage;
  onChange: (image: PackageImage) => void;
  portrait?: boolean;
}) {
  return (
    <>
      <label>
        이미지 이름
        <input
          aria-label="이미지 이름"
          value={image.title}
          maxLength={200}
          onChange={(event) => onChange({ ...image, title: event.target.value })}
        />
      </label>
      <label>
        설명 · 선택
        <textarea
          aria-label="이미지 설명"
          value={image.description}
          maxLength={2000}
          rows={4}
          placeholder="인물, 복장, 장소, 표정 등 이미지 선택에 필요한 특징"
          onChange={(event) => onChange({ ...image, description: event.target.value })}
        />
      </label>
      <label>
        에셋 용도
        <select
          aria-label="에셋 용도"
          value={image.allowedUse}
          onChange={(event) =>
            onChange({ ...image, allowedUse: event.target.value as PackageImage['allowedUse'] })
          }
        >
          <option value="both">대표 이미지와 본문</option>
          <option value="profile">대표 이미지 전용</option>
          <option value="inline" disabled={portrait}>
            본문 전용
          </option>
        </select>
      </label>
      <p className="muted">
        이름과 설명은 JEV의 이미지 선택에 사용돼요. 본문이 포함된 용도는 자동 이미지 배치 후보가
        돼요.{portrait ? ' 현재 대표 이미지는 프로필 사용을 유지해야 해요.' : ''}
      </p>
    </>
  );
}
