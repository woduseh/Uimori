import type { Content, Library } from './product.js';

export type LibraryCategory = 'bot' | 'persona' | 'module' | 'prompts';
export type LibraryItemKey = { kind: 'content' | 'prompt-preset'; id: string };
export type LibraryFolder = {
  id: string;
  category: LibraryCategory;
  title: string;
  sortPosition: number;
};
export type LibraryPlacement = LibraryItemKey & {
  category: LibraryCategory;
  folderId: string | null;
};
export type LibraryOrganization = {
  revision: number;
  folders: LibraryFolder[];
  items: LibraryPlacement[];
};
export const libraryItemKey = (item: LibraryItemKey) => `${item.kind}:${item.id}`;
export function libraryCategory(library: Library, content: Content): Content['kind'] {
  const placement = library.organization?.items.find(
    (item) => item.kind === 'content' && item.id === content.id
  );
  return placement && placement.category !== 'prompts' ? placement.category : content.kind;
}
export function libraryFolderOf(library: Library, item: LibraryItemKey): string | null {
  return (
    library.organization?.items.find(
      (placement) => placement.kind === item.kind && placement.id === item.id
    )?.folderId ?? null
  );
}
