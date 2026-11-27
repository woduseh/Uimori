import { defineEndpoint } from '../../endpoint.js';
import type { deletionOperations as operations } from './operations.js';

type DeleteItem = typeof operations.deleteLibraryItem;

export const deletionEndpoints = {
  deleteContent: defineEndpoint<DeleteItem>()({
    operation: 'deletion.deleteLibraryItem',
    method: 'DELETE',
    path: '/content/:id',
    invalidates: ['library'],
  }),
  deletePromptPreset: defineEndpoint<DeleteItem>()({
    operation: 'deletion.deleteLibraryItem',
    method: 'DELETE',
    path: '/prompt-presets/:id',
    invalidates: ['library'],
  }),
  deletePromptCombination: defineEndpoint<DeleteItem>()({
    operation: 'deletion.deleteLibraryItem',
    method: 'DELETE',
    path: '/prompt-combinations/:id',
    invalidates: ['library'],
  }),
  deleteConnection: defineEndpoint<DeleteItem>()({
    operation: 'deletion.deleteLibraryItem',
    method: 'DELETE',
    path: '/connections/:id',
    invalidates: ['provider-settings'],
  }),
  deleteModelPreset: defineEndpoint<DeleteItem>()({
    operation: 'deletion.deleteLibraryItem',
    method: 'DELETE',
    path: '/model-presets/:id',
    invalidates: ['provider-settings'],
  }),
};
