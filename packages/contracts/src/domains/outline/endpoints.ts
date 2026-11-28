import { defineEndpoint } from '../../endpoint.js';
import type { outlineOperations as operations } from './operations.js';

export const outlineEndpoints = {
  setFocus: defineEndpoint<typeof operations.setFocus>()({
    operation: 'outline.setFocus',
    method: 'PUT',
    path: '/chats/:chatId/outline/focus',
  }),
  apply: defineEndpoint<typeof operations.apply>()({
    operation: 'outline.apply',
    method: 'POST',
    path: '/chats/:chatId/outline',
    bodyLimit: 16 * 1024 * 1024,
  }),
};
