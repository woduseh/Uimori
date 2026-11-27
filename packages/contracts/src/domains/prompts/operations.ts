import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';

const id = nonBlank(100);
const promptRole = z.enum(['main', 'translation']);
const promptValues = z.record(z.string(), z.unknown());
const modelRef = z.strictObject({ id });

const templateSummary = { id: z.string(), title: z.string(), role: promptRole };
export const promptTemplateSummary = z.strictObject(templateSummary);
export const promptTemplate = z.strictObject({
  ...templateSummary,
  program: z.unknown(),
  values: promptValues,
});

const promptWorkspace = z.looseObject({ revision });
const modelWorkspace = z.looseObject({ revision });

export const updatePromptWorkspaceInput = z.strictObject({
  expectedRevision: revision,
  main: z.unknown().optional(),
  translation: z.unknown().optional(),
  translationPolicy: z.unknown().optional(),
  mainJudgmentEnabled: z.boolean().optional(),
  mainJudgmentThreshold: z.unknown().optional(),
});
export type UpdatePromptWorkspace = z.infer<typeof updatePromptWorkspaceInput>;

export const applyPromptPresetInput = z.strictObject({
  expectedRevision: revision,
  role: promptRole,
  presetId: id,
});
export type ApplyPromptPreset = z.infer<typeof applyPromptPresetInput>;

export const applyPromptCombinationInput = z.strictObject({
  expectedRevision: revision,
  role: promptRole,
  combinationId: id,
});
export type ApplyPromptCombination = z.infer<typeof applyPromptCombinationInput>;

export const updatePromptCombinationInput = z.strictObject({
  id,
  expectedRevision: revision,
  sourceRevision: revision,
  title: nonBlank(200),
  values: promptValues,
});
export type UpdatePromptCombination = z.infer<typeof updatePromptCombinationInput>;

const optionalModel = modelRef.nullable().optional();
export const updateModelWorkspaceInput = z.strictObject({
  expectedRevision: revision,
  routes: z.strictObject({ main: modelRef.nullable(), translation: modelRef.nullable() }),
  translationPolicy: z.unknown(),
  mainJudgmentEnabled: z.boolean().optional(),
  mainJudgmentThreshold: z.unknown().optional(),
  judgment: z.unknown().optional(),
  judgmentPricing: z.unknown().optional(),
  titleModel: optionalModel,
  helperModel: optionalModel,
  helperTaskTimeoutMinutes: z.unknown().optional(),
  helperConfirmPaidGeneration: z.boolean().optional(),
  contextModel: optionalModel,
  scriptModel: optionalModel,
  summaryLength: z.unknown().optional(),
});
export type UpdateModelWorkspace = z.infer<typeof updateModelWorkspaceInput>;

const count = z.int().nonnegative();
export const loreContextDefaults = z.strictObject({
  revision,
  enabled: z.boolean(),
  tokenEstimator: z.literal('o200k_base-text-v1'),
  maxRetainedTokens: count,
  maxRetainedEntries: count,
  maxPinnedTokens: count,
  judgment: z.strictObject({
    threshold: z.number(),
    maxSelectedTokens: count,
    maxInputTokens: count,
  }),
});
export const updateLoreContextDefaultsInput = z.strictObject({
  expectedRevision: revision,
  enabled: z.unknown().optional(),
  tokenEstimator: z.unknown().optional(),
  maxRetainedTokens: z.unknown().optional(),
  maxRetainedEntries: z.unknown().optional(),
  maxPinnedTokens: z.unknown().optional(),
  judgment: z.unknown().optional(),
});
export type UpdateLoreContextDefaults = z.infer<typeof updateLoreContextDefaultsInput>;

export const promptOperations = {
  listTemplates: defineOperation(
    'prompts.listTemplates',
    z.strictObject({}),
    z.array(promptTemplateSummary)
  ),
  readTemplate: defineOperation('prompts.readTemplate', z.strictObject({ id }), promptTemplate),
  readWorkspace: defineOperation('prompts.readWorkspace', z.strictObject({}), promptWorkspace),
  updateWorkspace: defineOperation(
    'prompts.updateWorkspace',
    updatePromptWorkspaceInput,
    promptWorkspace
  ),
  applyPreset: defineOperation('prompts.applyPreset', applyPromptPresetInput, promptWorkspace),
  applyCombination: defineOperation(
    'prompts.applyCombination',
    applyPromptCombinationInput,
    promptWorkspace
  ),
  updateCombination: defineOperation(
    'prompts.updateCombination',
    updatePromptCombinationInput,
    z.looseObject({ id: z.string(), revision })
  ),
  readModelWorkspace: defineOperation(
    'prompts.readModelWorkspace',
    z.strictObject({}),
    modelWorkspace
  ),
  updateModelWorkspace: defineOperation(
    'prompts.updateModelWorkspace',
    updateModelWorkspaceInput,
    modelWorkspace
  ),
  readLoreContextDefaults: defineOperation(
    'prompts.readLoreContextDefaults',
    z.strictObject({}),
    loreContextDefaults
  ),
  updateLoreContextDefaults: defineOperation(
    'prompts.updateLoreContextDefaults',
    updateLoreContextDefaultsInput,
    loreContextDefaults
  ),
};
