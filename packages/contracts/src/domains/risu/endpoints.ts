import { defineEndpoint } from '../../endpoint.js';
import type { risuOperations } from './operations.js';
import { RISU_IMPORT_BODY_LIMIT } from '../limits.js';

export const risuEndpoints = {
  apply: defineEndpoint<typeof risuOperations.apply>()({
    operation: 'risu.import.apply',
    method: 'POST',
    path: '/risu-imports/apply',
    bodyLimit: RISU_IMPORT_BODY_LIMIT,
    invalidates: ['library'],
  }),
};
