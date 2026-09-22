import { useState } from 'react';
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
  const url = contentPortraitUrl(content);
  return (
    <span className={`content-avatar ${className}`} aria-hidden="true">
      <AvatarImage key={url} url={url} initial={Array.from(name.trim())[0] ?? '?'} />
    </span>
  );
}
