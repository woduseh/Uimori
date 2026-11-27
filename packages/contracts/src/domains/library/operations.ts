import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';

const id = nonBlank(100);
export const libraryCategory = z.enum(['bot', 'persona', 'module', 'prompts']);
export type LibraryCategory = z.infer<typeof libraryCategory>;
const itemKind = z.enum(['content', 'prompt-preset']);
export const libraryItemKey = z.strictObject({ kind: itemKind, id });
export type LibraryItemKey = z.infer<typeof libraryItemKey>;

export const libraryFolder = z.strictObject({
  id: z.string(),
  category: libraryCategory,
  title: z.string(),
  sortPosition: z.int().nonnegative(),
  coverImageHash: z.string().nullable(),
});
export type LibraryFolder = z.infer<typeof libraryFolder>;
export const libraryPlacement = z.strictObject({
  kind: itemKind,
  id: z.string(),
  category: libraryCategory,
  folderId: z.string().nullable(),
});
export type LibraryPlacement = z.infer<typeof libraryPlacement>;
export const libraryOrganization = z.strictObject({
  revision,
  folders: z.array(libraryFolder),
  items: z.array(libraryPlacement),
});
export type LibraryOrganization = z.infer<typeof libraryOrganization>;

const folderTitle = nonBlank(200).transform((title) => title.trim());

export const createLibraryFolderInput = z.strictObject({
  expectedRevision: revision,
  category: libraryCategory,
  title: folderTitle,
});
export type CreateLibraryFolder = z.infer<typeof createLibraryFolderInput>;

export const updateLibraryFolderInput = z
  .strictObject({
    id,
    expectedRevision: revision,
    title: folderTitle.optional(),
    beforeFolderId: id.nullable().optional(),
    coverImageHash: nonBlank(64).nullable().optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.beforeFolderId !== undefined ||
      input.coverImageHash !== undefined,
    { message: 'A folder update changes the title, the order or the cover', path: ['title'] }
  );
export type UpdateLibraryFolder = z.infer<typeof updateLibraryFolderInput>;

export const deleteLibraryFolderInput = z.strictObject({ id, expectedRevision: revision });
export type DeleteLibraryFolder = z.infer<typeof deleteLibraryFolderInput>;

const moveTarget = { expectedRevision: revision, folderId: id.nullable() };
const distinctItems = <T extends { id: string }>(items: z.ZodType<T>) =>
  z
    .array(items)
    .min(1)
    .max(1000)
    .refine((list) => new Set(list.map((item) => item.id)).size === list.length, {
      message: 'Each library item is listed once',
    });
export const moveLibraryItemsInput = z.union([
  z.strictObject({
    ...moveTarget,
    category: z.enum(['bot', 'persona', 'module']),
    items: distinctItems(z.strictObject({ kind: z.literal('content'), id })),
  }),
  z.strictObject({
    ...moveTarget,
    category: z.literal('prompts'),
    items: distinctItems(z.strictObject({ kind: z.literal('prompt-preset'), id })),
  }),
]);
export type MoveLibraryItems = z.infer<typeof moveLibraryItemsInput>;

export const libraryOperations = {
  readOrganization: defineOperation(
    'library.readOrganization',
    z.strictObject({}),
    libraryOrganization
  ),
  createFolder: defineOperation(
    'library.createFolder',
    createLibraryFolderInput,
    libraryOrganization
  ),
  updateFolder: defineOperation(
    'library.updateFolder',
    updateLibraryFolderInput,
    libraryOrganization
  ),
  deleteFolder: defineOperation(
    'library.deleteFolder',
    deleteLibraryFolderInput,
    libraryOrganization
  ),
  moveItems: defineOperation('library.moveItems', moveLibraryItemsInput, libraryOrganization),
};
