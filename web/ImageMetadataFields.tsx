import { t, useI18n } from './i18n.js';
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
  useI18n();
  return (
    <>
      <label>
        {t('library.imageName')}
        <input
          aria-label={t('library.imageName')}
          value={image.title}
          maxLength={200}
          onChange={(event) => onChange({ ...image, title: event.target.value })}
        />
      </label>
      <label>
        {t('library.descriptionOptional')}
        <textarea
          aria-label={t('library.imageDescription')}
          value={image.description}
          maxLength={2000}
          rows={4}
          placeholder={t('library.featuresNeededToSelectImagesCharacterOutfit')}
          onChange={(event) => onChange({ ...image, description: event.target.value })}
        />
      </label>
      <label>
        {t('library.imageUse')}
        <select
          aria-label={t('library.imageUse')}
          value={image.allowedUse}
          onChange={(event) =>
            onChange({ ...image, allowedUse: event.target.value as PackageImage['allowedUse'] })
          }
        >
          <option value="both">{t('library.portraitAndStory')}</option>
          <option value="profile">{t('library.portraitOnly')}</option>
          <option value="inline" disabled={portrait}>
            {t('library.storyOnly')}
          </option>
        </select>
      </label>
      <p className="muted">
        {t('library.imageMetadataHint', { portrait: portrait ? 'yes' : 'no' })}
      </p>
    </>
  );
}
