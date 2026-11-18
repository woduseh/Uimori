import { FolderIcon } from './ui-icons.js';
import './library-folder-cover.css';

export const folderCoverUrl = (hash: string) => `/api/package-image-blobs/${hash}`;

/** A chosen image fills the cover; otherwise up to four portraits from the folder stand in. */
export function LibraryFolderCover({
  coverImageHash,
  portraits = [],
  iconSize,
}: {
  coverImageHash: string | null;
  portraits?: string[];
  iconSize: number;
}) {
  const urls = coverImageHash ? [folderCoverUrl(coverImageHash)] : portraits.slice(0, 4);
  return urls.length ? (
    <span className="library-folder-cover" data-count={urls.length} aria-hidden="true">
      {urls.map((url) => (
        <img key={url} src={url} alt="" loading="lazy" draggable={false} />
      ))}
    </span>
  ) : (
    <FolderIcon size={iconSize} aria-hidden="true" />
  );
}
