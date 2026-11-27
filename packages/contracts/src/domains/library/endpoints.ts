import { defineEndpoint } from '../../endpoint.js';
import { PACKAGE_IMAGE_UPLOAD_MAX_BYTES } from '../../image-limits.js';
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
  uploadPackageImage: defineEndpoint<typeof operations.uploadPackageImage>()({
    operation: 'library.uploadPackageImage',
    method: 'POST',
    path: '/package-image-blobs',
    bodyLimit: PACKAGE_IMAGE_UPLOAD_MAX_BYTES,
  }),
};
