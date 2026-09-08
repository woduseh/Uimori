import { useState } from 'react';
import type { Content } from '../core/product.js';
import './content-picker.css';

function AvatarImage({ url, initial }: { url: string; initial: string }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? (
    <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span>{initial}</span>
  );
}

/** Resolves only the supplied revision; a missing portrait never triggers a latest-version read. */
export function ContentAvatar({
  content,
  title,
  className = '',
}: {
  content?: Content | null;
  title?: string;
  className?: string;
}) {
  const name = title ?? content?.title ?? '';
  const portrait = content?.package?.images?.find(
    (image) => image.id === content.package?.portraitImageId && image.allowedUse !== 'inline'
  );
  const url = content?.package
    ? portrait
      ? `/api/package-image-blobs/${portrait.blobHash}`
      : ''
    : (content?.coverImage?.url ?? '');
  return (
    <span className={`content-avatar ${className}`} aria-hidden="true">
      <AvatarImage key={url} url={url} initial={Array.from(name.trim())[0] ?? '?'} />
    </span>
  );
}
