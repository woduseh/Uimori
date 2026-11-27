import type { Content, Library } from './product.js';

export type {
  LibraryCategory,
  LibraryFolder,
  LibraryItemKey,
  LibraryOrganization,
  LibraryPlacement,
} from '#contracts';
import type { LibraryItemKey, LibraryPlacement } from '#contracts';

export const libraryItemKey = (item: LibraryItemKey) => `${item.kind}:${item.id}`;
export function placementCategory(
  placement: LibraryPlacement | undefined,
  content: Content
): Content['kind'] {
  return placement && placement.category !== 'prompts' ? placement.category : content.kind;
}
export function libraryCategory(library: Library, content: Content): Content['kind'] {
  return placementCategory(
    library.organization?.items.find((item) => item.kind === 'content' && item.id === content.id),
    content
  );
}
export function libraryFolderOf(library: Library, item: LibraryItemKey): string | null {
  return (
    library.organization?.items.find(
      (placement) => placement.kind === item.kind && placement.id === item.id
    )?.folderId ?? null
  );
}
