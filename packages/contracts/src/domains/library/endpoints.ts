import { defineEndpoint } from '../../endpoint.js';
import type { libraryOperations as operations } from './operations.js';

export const libraryEndpoints = {
  readOrganization: defineEndpoint<typeof operations.readOrganization>()({
    operation: 'library.readOrganization',
    method: 'GET',
    path: '/library/organization',
  }),
  createFolder: defineEndpoint<typeof operations.createFolder>()({
    operation: 'library.createFolder',
    method: 'POST',
    path: '/library/folders',
    invalidates: ['library'],
  }),
  updateFolder: defineEndpoint<typeof operations.updateFolder>()({
    operation: 'library.updateFolder',
    method: 'PATCH',
    path: '/library/folders/:id',
    invalidates: ['library'],
  }),
  deleteFolder: defineEndpoint<typeof operations.deleteFolder>()({
    operation: 'library.deleteFolder',
    method: 'DELETE',
    path: '/library/folders/:id',
    invalidates: ['library'],
  }),
  moveItems: defineEndpoint<typeof operations.moveItems>()({
    operation: 'library.moveItems',
    method: 'POST',
    path: '/library/organization/move',
    invalidates: ['library'],
  }),
};
