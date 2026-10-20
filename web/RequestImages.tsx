import { useI18n } from './i18n.js';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { RequestImage } from '../core/request-images.js';
import type { DraftImage } from './request-image-draft.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import './request-images.css';

function Thumbnail({
  image,
  remove,
  disabled,
}: {
  image: { name: string; url: string };
  remove?: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="request-image">
      <button
        type="button"
        className="request-image-open secondary"
        aria-label={t('prompts.zoomNamed', { name: image.name })}
        onClick={() => setOpen(true)}
      >
        <img src={image.url} alt={image.name} loading="lazy" />
      </button>
      {remove && (
        <IconButton
          icon={X}
          label={t('prompts.removeNamed', { name: image.name })}
          className="request-image-remove secondary"
          disabled={disabled}
          onClick={remove}
        />
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={image.name}
        className="request-image-dialog"
      >
        {open && <img src={image.url} alt={image.name} />}
      </Dialog>
    </div>
  );
}

function DraftThumbnail({
  image,
  remove,
  disabled,
}: {
  image: DraftImage;
  remove: () => void;
  disabled: boolean;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const value = URL.createObjectURL(image.blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [image.blob]);
  return url ? (
    <Thumbnail image={{ name: image.name, url }} remove={remove} disabled={disabled} />
  ) : null;
}

export function StoredRequestImages({ images }: { images?: RequestImage[] }) {
  const { t } = useI18n();
  return images?.length ? (
    <div className="request-images" aria-label={t('prompts.uiRequestReferenceImages')}>
      {images.map((image, i) => (
        <Thumbnail
          key={`${image.hash}:${i}`}
          image={{ name: image.name, url: `/api/package-image-blobs/${image.hash}` }}
        />
      ))}
    </div>
  ) : null;
}

export function DraftRequestImages({
  images,
  remove,
  disabled,
}: {
  images: DraftImage[];
  remove: (id: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return images.length ? (
    <div
      className="request-images draft-request-images"
      aria-label={t('prompts.uiAttachedReferenceImages')}
    >
      {images.map((image) => (
        <DraftThumbnail
          key={image.id}
          image={image}
          remove={() => remove(image.id)}
          disabled={disabled}
        />
      ))}
    </div>
  ) : null;
}
