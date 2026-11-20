import { useState } from 'react';
import { packageImageThumbnailUrl } from '../core/package-images.js';
import type { Content } from '../core/product.js';
import './content-picker.css';
import { contentPortraitUrl } from './content-portrait.js';

function AvatarImage({ url, initial }: { url: string; initial: string }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? (
    <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span>{initial}</span>
  );
}

export function ContentAvatar({
  content,
  title,
  className = '',
  fullSize = false,
}: {
  content?: Content | null;
  title?: string;
  className?: string;
  fullSize?: boolean;
}) {
  const name = title ?? content?.title ?? '';
  const portrait = contentPortraitUrl(content);
  const url = fullSize ? portrait : packageImageThumbnailUrl(portrait);
  return (
    <span className={`content-avatar ${className}`} aria-hidden="true">
      <AvatarImage key={url} url={url} initial={Array.from(name.trim())[0] ?? '?'} />
    </span>
  );
}
