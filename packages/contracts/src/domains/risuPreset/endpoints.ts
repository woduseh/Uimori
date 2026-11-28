import { defineEndpoint } from '../../endpoint.js';
import type { risuPresetOperations } from './operations.js';
import { RISU_IMPORT_BODY_LIMIT } from '../limits.js';

export const risuPresetEndpoints = {
  apply: defineEndpoint<typeof risuPresetOperations.apply>()({
    operation: 'risuPreset.import.apply',
    method: 'POST',
    path: '/risu-preset-imports/apply',
    bodyLimit: RISU_IMPORT_BODY_LIMIT,
  }),
};
