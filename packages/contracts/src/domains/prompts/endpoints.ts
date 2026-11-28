import { defineEndpoint } from '../../endpoint.js';
import { PROMPT_HTTP_BODY_MAX_BYTES } from '../limits.js';
import type { promptOperations as operations } from './operations.js';

export const promptEndpoints = {
  listTemplates: defineEndpoint<typeof operations.listTemplates>()({
    operation: 'prompts.listTemplates',
    method: 'GET',
    path: '/prompt-templates',
  }),
  readTemplate: defineEndpoint<typeof operations.readTemplate>()({
    operation: 'prompts.readTemplate',
    method: 'GET',
    path: '/prompt-templates/:id',
  }),
  readWorkspace: defineEndpoint<typeof operations.readWorkspace>()({
    operation: 'prompts.readWorkspace',
    method: 'GET',
    path: '/prompt-workspace',
    cache: 'revalidate',
  }),
  updateWorkspace: defineEndpoint<typeof operations.updateWorkspace>()({
    operation: 'prompts.updateWorkspace',
    method: 'PUT',
    path: '/prompt-workspace',
    bodyLimit: PROMPT_HTTP_BODY_MAX_BYTES,
    invalidates: ['library', 'prompt-workspace'],
  }),
  applyPreset: defineEndpoint<typeof operations.applyPreset>()({
    operation: 'prompts.applyPreset',
    method: 'POST',
    path: '/prompt-workspace/apply',
    invalidates: ['library', 'prompt-workspace'],
  }),
  applyCombination: defineEndpoint<typeof operations.applyCombination>()({
    operation: 'prompts.applyCombination',
    method: 'POST',
    path: '/prompt-workspace/apply-options',
    invalidates: ['library', 'prompt-workspace'],
  }),
  updateCombination: defineEndpoint<typeof operations.updateCombination>()({
    operation: 'prompts.updateCombination',
    method: 'PUT',
    path: '/prompt-combinations/:id',
    invalidates: ['library'],
  }),
  readModelWorkspace: defineEndpoint<typeof operations.readModelWorkspace>()({
    operation: 'prompts.readModelWorkspace',
    method: 'GET',
    path: '/model-workspace',
  }),
  updateModelWorkspace: defineEndpoint<typeof operations.updateModelWorkspace>()({
    operation: 'prompts.updateModelWorkspace',
    method: 'PUT',
    path: '/model-workspace',
    invalidates: ['library', 'prompt-workspace'],
  }),
  readLoreContextDefaults: defineEndpoint<typeof operations.readLoreContextDefaults>()({
    operation: 'prompts.readLoreContextDefaults',
    method: 'GET',
    path: '/lore-context-defaults',
    cache: 'no-store',
  }),
  updateLoreContextDefaults: defineEndpoint<typeof operations.updateLoreContextDefaults>()({
    operation: 'prompts.updateLoreContextDefaults',
    method: 'PUT',
    path: '/lore-context-defaults',
  }),
};
