import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';
import { CHAT_VARIABLE_LIMITS, STORY_GUIDE_LIMITS } from './limits.js';

const chatId = nonBlank(120);
const chatTarget = z.strictObject({ chatId });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const optionBinding = z.strictObject({ owner: nonBlank(200), definitionHash: sha256 });
const optionValues = z.record(z.string(), z.unknown());
const optionsCommand = {
  expectedRevision: revision,
  operationId: nonBlank(100),
  binding: optionBinding,
  values: optionValues,
};
export const stageOptionsInput = z.strictObject({ chatId, ...optionsCommand });
export const fixOptionsInput = z.strictObject({ chatId, ...optionsCommand });
export type ChatOptionsCommand = Omit<z.output<typeof fixOptionsInput>, 'chatId'>;
export const cancelStagedOptionsInput = z.strictObject({
  chatId,
  pendingId: nonBlank(120),
  expectedRevision: revision,
  operationId: nonBlank(100),
});
export type ChatOptionsCancel = Omit<
  z.output<typeof cancelStagedOptionsInput>,
  'chatId' | 'pendingId'
>;
const chatOptionState = z.looseObject({
  chatId: z.string(),
  revision,
  binding: z.strictObject({ owner: z.string(), definitionHash: z.string() }),
  workspaceRevision: revision,
  pending: z.array(z.looseObject({ id: z.string() })),
  conflicts: z.array(z.enum(['fixed_definition_changed', 'pending_definition_changed'])),
});

const variableValues = z
  .record(z.string(), z.string().max(CHAT_VARIABLE_LIMITS.maxValueChars))
  .refine((values) => Object.keys(values).length <= CHAT_VARIABLE_LIMITS.maxEntries)
  .refine(
    (values) =>
      Object.values(values).reduce((total, value) => total + value.length, 0) <=
      CHAT_VARIABLE_LIMITS.maxTotalChars
  );
export const writeVariablesInput = z.strictObject({
  chatId,
  expectedRevision: revision,
  expectedSourceHash: sha256.nullable(),
  idempotencyKey: nonBlank(200),
  values: variableValues,
});
export type ChatVariableCommand = Omit<z.output<typeof writeVariablesInput>, 'chatId'>;
const variableView = z.looseObject({
  revision,
  values: z.record(z.string(), z.string()),
  defaults: z.record(z.string(), z.string()),
  resolved: z.record(z.string(), z.string()),
  sourceHash: z.string().nullable(),
  pending: z.boolean(),
});

const storyGuideConfig = z.strictObject({
  enabled: z.boolean(),
  work: z.string().max(STORY_GUIDE_LIMITS.work),
  reference: z.string().max(STORY_GUIDE_LIMITS.reference),
  position: z.string().max(STORY_GUIDE_LIMITS.position),
  followCanon: z.boolean(),
  webSearch: z.boolean().default(false),
});
export const updateStoryGuideInput = z.strictObject({
  chatId,
  expectedRevision: revision,
  config: storyGuideConfig,
});
export type StoryGuideUpdate = Omit<z.output<typeof updateStoryGuideInput>, 'chatId'>;
const storyGuideDetail = z.looseObject({ revision, config: storyGuideConfig });

export const applyOrphanMemoryInput = z.strictObject({
  chatId,
  kind: z.enum(['note', 'lore']),
  entryId: nonBlank(100),
  action: z.enum(['reanchor', 'retire']),
  expectedRevision: revision,
  expectedLoreRevision: revision,
  expectedHeadRevision: nonBlank(100).nullable(),
  expectedHeadHash: nonBlank(64).nullable(),
  idempotencyKey: nonBlank(120),
});
export type OrphanMemoryCommand = Omit<z.output<typeof applyOrphanMemoryInput>, 'chatId'>;
const orphanMemoryDetail = z.looseObject({
  headRevision: z.string().nullable(),
  headHash: z.string().nullable(),
  revision,
  loreRevision: revision,
  entries: z.array(
    z.looseObject({
      kind: z.enum(['note', 'lore']),
      reason: z.enum(['missing-source', 'outside-history', 'source-changed']),
    })
  ),
});

export const chatSettingsOperations = {
  readOptions: defineOperation('chat-settings.readOptions', chatTarget, chatOptionState),
  fixOptions: defineOperation('chat-settings.fixOptions', fixOptionsInput, chatOptionState),
  stageOptions: defineOperation('chat-settings.stageOptions', stageOptionsInput, chatOptionState),
  cancelStagedOptions: defineOperation(
    'chat-settings.cancelStagedOptions',
    cancelStagedOptionsInput,
    chatOptionState
  ),
  readVariables: defineOperation('chat-settings.readVariables', chatTarget, variableView),
  writeVariables: defineOperation(
    'chat-settings.writeVariables',
    writeVariablesInput,
    variableView
  ),
  readStoryGuide: defineOperation('chat-settings.readStoryGuide', chatTarget, storyGuideDetail),
  updateStoryGuide: defineOperation(
    'chat-settings.updateStoryGuide',
    updateStoryGuideInput,
    storyGuideDetail
  ),
  readOrphanMemory: defineOperation(
    'chat-settings.readOrphanMemory',
    chatTarget,
    orphanMemoryDetail
  ),
  applyOrphanMemory: defineOperation(
    'chat-settings.applyOrphanMemory',
    applyOrphanMemoryInput,
    z.strictObject({ entryId: z.string(), revision, loreRevision: revision })
  ),
};
