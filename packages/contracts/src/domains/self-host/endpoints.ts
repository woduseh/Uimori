import { defineEndpoint } from '../../endpoint.js';
import type { selfHostOperations as operations } from './operations.js';

export const selfHostEndpoints = {
  readMaintenance: defineEndpoint<typeof operations.readMaintenance>()({
    operation: 'self-host.readMaintenance',
    method: 'GET',
    path: '/maintenance',
    cache: 'no-store',
  }),
  setMaintenance: defineEndpoint<typeof operations.setMaintenance>()({
    operation: 'self-host.setMaintenance',
    method: 'POST',
    path: '/maintenance',
    admission: 'always',
  }),
};
