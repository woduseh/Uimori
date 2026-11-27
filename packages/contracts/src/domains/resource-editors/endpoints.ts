import { defineEndpoint } from '../../endpoint.js';
import type { resourceEditorOperations as operations } from './operations.js';

export const RESOURCE_SAVE_BODY_MAX_BYTES = 48 * 1024 * 1024;

export const resourceEditorEndpoints = {
  readResource: defineEndpoint<typeof operations.readResource>()({
    operation: 'resourceEditors.readResource',
    method: 'GET',
    path: '/resources/:kind/:id',
  }),
  readPreviousResource: defineEndpoint<typeof operations.readPreviousResource>()({
    operation: 'resourceEditors.readPreviousResource',
    method: 'GET',
    path: '/resources/:kind/:id/previous',
  }),
  saveResource: defineEndpoint<typeof operations.saveResource>()({
    operation: 'resourceEditors.saveResource',
    method: 'POST',
    path: '/resources/save',
    bodyLimit: RESOURCE_SAVE_BODY_MAX_BYTES,
  }),
  cloneResource: defineEndpoint<typeof operations.cloneResource>()({
    operation: 'resourceEditors.cloneResource',
    method: 'POST',
    path: '/resources/clone',
  }),
  undoResource: defineEndpoint<typeof operations.undoResource>()({
    operation: 'resourceEditors.undoResource',
    method: 'POST',
    path: '/resources/:kind/:id/undo',
  }),
};
