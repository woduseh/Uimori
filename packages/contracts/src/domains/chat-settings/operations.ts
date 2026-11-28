import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { defineCommandOperation } from '../../split-operation.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';
import { CHAT_VARIABLE_LIMITS, STORY_GUIDE_LIMITS } from './limits.js';

const chatId = nonBlank(120);
const chatTarget = z.strictObject({ chatId });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const optionBinding = z.strictObject({ owner: nonBlank(200), definitionHash: sha256 });
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const keyedValues = <K extends z.core.$ZodRecordKey, V extends z.ZodType>(keys: K, value: V) =>
  z
    .custom<Record<string, z.input<V>>>(
      (input) =>
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input) &&
        !Object.keys(input).some((key) => unsafeKeys.has(key)),
      'Expected an object without __proto__, constructor or prototype keys'
    )
    .pipe(z.record(keys, value));
const optionValues = keyedValues(z.string(), z.unknown());
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

const variableName = nonBlank(1000);
const variableValues = keyedValues(z.string(), z.string().max(CHAT_VARIABLE_LIMITS.maxValueChars))
  .refine((values) => Object.keys(values).length <= CHAT_VARIABLE_LIMITS.maxEntries)
  .refine(
    (values) =>
      Object.values(values).reduce((total, value) => total + value.length, 0) <=
      CHAT_VARIABLE_LIMITS.maxTotalChars
  );
export const writeVariablesHead = z.strictObject({
  chatId,
  expectedRevision: revision.describe('revision from chat.variables.read.'),
  expectedSourceHash: sha256
    .nullable()
    .describe('sourceHash from chat.variables.read, null for a chat without scenes.'),
  idempotencyKey: nonBlank(200),
});
export const writeVariablesReplaceBody = z.strictObject({
  values: variableValues,
});
export const writeVariablesPatchBody = z
  .strictObject({
    set: keyedValues(variableName, z.string().max(CHAT_VARIABLE_LIMITS.maxValueChars))
      .describe('Variable names and their new text values.')
      .optional(),
    unset: z
      .array(variableName.refine((name) => !unsafeKeys.has(name), 'Reserved variable name'))
      .max(CHAT_VARIABLE_LIMITS.maxEntries)
      .describe('Variable names whose chat value is removed.')
      .optional(),
  })
  .refine(
    (input) => Object.keys(input.set ?? {}).length > 0 || (input.unset?.length ?? 0) > 0,
    'Pass set or unset with at least one variable'
  )
  .refine((input) => {
    const set = input.set ?? {};
    return !(input.unset ?? []).some((name) => Object.hasOwn(set, name));
  }, 'A variable cannot be named in both set and unset');
export type ChatVariableCommand = Omit<z.output<typeof writeVariablesHead>, 'chatId'> &
  z.output<typeof writeVariablesReplaceBody>;
export type ChatVariableView = {
  revision: number;
  values: Record<string, string>;
  defaults: Record<string, string>;
  resolved: Record<string, string>;
  origins?: Record<string, unknown>;
  sourceHash: string | null;
  pending: boolean;
  variableDefaultsError?: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT';
};
const variableView = z.looseObject({
  revision,
  values: z.record(z.string(), z.string()),
  defaults: z.record(z.string(), z.string()),
  resolved: z.record(z.string(), z.string()),
  sourceHash: z.string().nullable(),
  pending: z.boolean(),
});

const storyGuideConfig = z.strictObject({
  enabled: z.boolean().describe('Run the automatic reference step.'),
  work: z.string().max(STORY_GUIDE_LIMITS.work).describe('Original work and edition.'),
  reference: z
    .string()
    .max(STORY_GUIDE_LIMITS.reference)
    .describe('Reference text the user supplies about the work.'),
  position: z
    .string()
    .max(STORY_GUIDE_LIMITS.position)
    .describe('Where the reader is in the original work and the spoiler limit.'),
  followCanon: z.boolean().describe('Consider canon events.'),
  webSearch: z.boolean().default(false).describe('Allow the step to search the web.'),
});
export const updateStoryGuideHead = z.strictObject({
  chatId,
  expectedRevision: revision.describe(
    'storyGuide.revision from source.writing.chat or context.read.'
  ),
});
export const updateStoryGuideReplaceBody = z.strictObject({
  config: storyGuideConfig,
});
export const updateStoryGuidePatchBody = z.strictObject({
  changes: z
    .strictObject({
      enabled: z.boolean().describe('Run the automatic reference step.').optional(),
      work: z
        .string()
        .max(STORY_GUIDE_LIMITS.work)
        .describe('Original work and edition.')
        .optional(),
      position: z
        .string()
        .max(STORY_GUIDE_LIMITS.position)
        .describe('Where the reader is in the original work and the spoiler limit.')
        .optional(),
      reference: z
        .string()
        .max(STORY_GUIDE_LIMITS.reference)
        .describe('Reference text the user supplies about the work.')
        .optional(),
      followCanon: z.boolean().describe('Consider canon events.').optional(),
      webSearch: z.boolean().describe('Allow the step to search the web.').optional(),
    })
    .refine((changes) => Object.keys(changes).length > 0, 'Pass at least one change')
    .describe('Only the settings to change.'),
});
export type StoryGuideUpdate = Omit<z.output<typeof updateStoryGuideHead>, 'chatId'> &
  z.output<typeof updateStoryGuideReplaceBody>;
export type StoryGuideDetailWire = {
  revision: number;
  config: z.output<typeof storyGuideConfig>;
  brief: {
    fingerprint: string;
    text: string;
    createdAt: string;
    parentRevision: string | null;
    configRevision: number;
    runId?: string;
    modelTitle: string;
    webSearch?: unknown;
  } | null;
  latestRun?: { status: string; used: boolean; error?: string };
};
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
  writeVariables: defineCommandOperation<ChatVariableView>()({
    name: 'chat-settings.writeVariables',
    head: writeVariablesHead,
    body: z.union([writeVariablesReplaceBody, writeVariablesPatchBody]),
  }),
  readStoryGuide: defineOperation('chat-settings.readStoryGuide', chatTarget, storyGuideDetail),
  updateStoryGuide: defineCommandOperation<StoryGuideDetailWire>()({
    name: 'chat-settings.updateStoryGuide',
    head: updateStoryGuideHead,
    body: z.union([updateStoryGuideReplaceBody, updateStoryGuidePatchBody]),
  }),
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
