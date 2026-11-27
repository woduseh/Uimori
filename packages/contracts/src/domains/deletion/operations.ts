import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';

export const deleteLibraryItemInput = z.strictObject({
  id: nonBlank(100),
  expectedRevision: revision,
});
export type DeleteLibraryItem = z.infer<typeof deleteLibraryItemInput>;

export const deletionOperations = {
  deleteLibraryItem: defineOperation(
    'deletion.deleteLibraryItem',
    deleteLibraryItemInput,
    z.strictObject({ deleted: z.literal(true), id: z.string() })
  ),
};
