import type { PackageImage } from '../core/package-images.js';

/** Display metadata is independent of image bytes and native script aliases. */
export function ImageMetadataFields({
  image,
  onChange,
}: {
  image: PackageImage;
  onChange: (image: PackageImage) => void;
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
      <p className="muted">
        이름과 설명은 JEV의 이미지 선택에 사용돼요. 자료 저장 후 다음 선택부터 반영돼요.
      </p>
    </>
  );
}
