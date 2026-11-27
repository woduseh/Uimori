import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { queryInt } from '../query.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';
import {
  INPUT_TRANSLATION_LANGUAGE_CODES,
  REQUEST_IMAGE_DIMENSION_MAX,
  REQUEST_IMAGE_MAX_COUNT,
  REQUEST_IMAGE_NAME_MAX_CHARS,
  REQUEST_TEXT_MAX_CHARS,
  RESPONSE_TASK_KINDS,
  REVISION_CONTEXTS,
  SOURCE_TEXT_MAX_CHARS,
  TRANSLATION_TEXT_MAX_CHARS,
} from './limits.js';

const id = nonBlank(100);
const hash = nonBlank(64);
const anyObject = z.looseObject({});

const sceneCache = z.strictObject({
  readTokens: z.number().nullable(),
  writeTokens: z.number().nullable(),
  write5mTokens: z.number().nullable().optional(),
  write1hTokens: z.number().nullable().optional(),
});

const sceneUsageDetail = z.strictObject({
  cache: sceneCache.nullable(),
  lore: anyObject.nullable(),
});

const lastSceneLore = z.strictObject({
  sourceRevision: z.string().nullable(),
  attemptId: z.string().nullable(),
  lore: anyObject.nullable(),
});

const chatJob = z.strictObject({
  id: z.string(),
  sourceRevision: z.string(),
  kind: z.enum(['translation', 'image']),
  status: z.enum([
    'queued',
    'running',
    'completed',
    'failed',
    'stale',
    'partial',
    'cancelled',
    'interrupted',
  ]),
  error: z.string().nullable(),
  attempt: z.int().nonnegative(),
});
export type ChatJob = z.infer<typeof chatJob>;

const sceneDeletionRequest = {
  expectedHeadRevision: id.nullable(),
  expectedSettingsRevision: z.int().min(1),
  expectedSourceHash: hash,
  expectedHistoryHash: hash,
  expectedVariablesRevision: revision,
};
export const sceneDeletionImpact = z.strictObject({
  sourceId: z.string(),
  onlyCount: z.int().nonnegative(),
  followingCount: z.int().nonnegative(),
  orphanNoteCount: z.strictObject({
    only: z.int().nonnegative(),
    following: z.int().nonnegative(),
  }),
  request: z.strictObject(sceneDeletionRequest),
});
export type SceneDeletionImpact = z.infer<typeof sceneDeletionImpact>;
export const sceneDeletionResult = z.strictObject({
  deleted: z.literal(true),
  chatId: z.string(),
  sourceIds: z.array(z.string()),
  headRevision: z.string().nullable(),
  settingsRevision: z.int(),
});
export type SceneDeletionResult = z.infer<typeof sceneDeletionResult>;
export const deleteScenesInput = z.strictObject({
  chatId: id,
  sourceId: id,
  scope: z.enum(['only', 'following']),
  ...sceneDeletionRequest,
  idempotencyKey: id,
});
export type DeleteScenesInput = z.infer<typeof deleteScenesInput>;

const selectionRevisionCommon = {
  sourceId: id,
  start: revision,
  end: z.int().positive(),
  instruction: nonBlank(REQUEST_TEXT_MAX_CHARS),
  expectedSourceHash: hash,
  expectedRevision: revision,
  context: z.enum(REVISION_CONTEXTS).optional(),
};
export const selectionRevisionInput = z.discriminatedUnion('target', [
  z.strictObject({
    ...selectionRevisionCommon,
    target: z.literal('source'),
    draft: nonBlank(SOURCE_TEXT_MAX_CHARS),
  }),
  z.strictObject({
    ...selectionRevisionCommon,
    target: z.literal('translation'),
    draft: nonBlank(TRANSLATION_TEXT_MAX_CHARS),
    expectedTextHash: hash,
  }),
]);
export type SelectionRevisionInput = z.infer<typeof selectionRevisionInput>;
export const selectionRevisionResult = z.strictObject({ text: z.string() });
export type SelectionRevisionResult = z.infer<typeof selectionRevisionResult>;

export const inputTranslationInput = z.strictObject({
  chatId: id,
  text: nonBlank(REQUEST_TEXT_MAX_CHARS),
  targetLanguage: z.enum(INPUT_TRANSLATION_LANGUAGE_CODES),
});
export type InputTranslationInput = z.infer<typeof inputTranslationInput>;
export const inputTranslationResult = z.strictObject({
  text: z.string(),
  targetLanguage: z.enum(INPUT_TRANSLATION_LANGUAGE_CODES),
});
export type InputTranslationResult = z.infer<typeof inputTranslationResult>;

const preflightRole = { chatId: id };
export const codexContentPreflightInput = z.discriminatedUnion('role', [
  z
    .strictObject({
      ...preflightRole,
      role: z.literal('main'),
      text: z.string().max(REQUEST_TEXT_MAX_CHARS),
      retryRunId: nonBlank(200).optional(),
      imageCount: z.int().min(1).max(REQUEST_IMAGE_MAX_COUNT).optional(),
    })
    .refine((input) => input.imageCount !== undefined || input.text.trim() !== '', {
      message: 'Expected a non-blank request or an image',
      path: ['text'],
    }),
  z.strictObject({
    ...preflightRole,
    role: z.literal('translation'),
    text: nonBlank(REQUEST_TEXT_MAX_CHARS),
  }),
  z.strictObject({
    ...preflightRole,
    role: z.literal('selection-revision'),
    text: nonBlank(REQUEST_TEXT_MAX_CHARS),
    selection: nonBlank(REQUEST_TEXT_MAX_CHARS),
  }),
]);
export type CodexContentPreflightInput = z.infer<typeof codexContentPreflightInput>;
export const codexContentPreflightResult = z.strictObject({ warning: z.boolean() });
export type CodexContentPreflightResult = z.infer<typeof codexContentPreflightResult>;

const promptPreviewCommon = {
  chatId: id,
  program: z.unknown().optional(),
  request: nonBlank(REQUEST_TEXT_MAX_CHARS),
  values: z.record(z.string(), z.unknown()).optional(),
};
export const promptPreviewInput = z.discriminatedUnion('role', [
  z.strictObject({
    ...promptPreviewCommon,
    role: z.literal('main'),
    loreContext: z.unknown().optional(),
    loreContextReset: z.boolean().optional(),
  }),
  z.strictObject({ ...promptPreviewCommon, role: z.literal('translation') }),
]);
export type PromptPreviewInput = z.infer<typeof promptPreviewInput>;
export const promptPreview = z.strictObject({
  compilation: z.unknown(),
  provider: z.unknown(),
  translationGuide: z.unknown().optional(),
  loreContext: z.unknown().optional(),
  previewSource: z.unknown().optional(),
  error: z.strictObject({ code: z.string(), detail: z.string().optional() }).optional(),
  scope: z.literal('preview-only-no-provider-call'),
});
export type PromptPreview = z.infer<typeof promptPreview>;

const dimension = z.int().min(1).max(REQUEST_IMAGE_DIMENSION_MAX);
export const requestPreviewInput = z
  .strictObject({
    chatId: id,
    request: z.string().max(REQUEST_TEXT_MAX_CHARS),
    loreContextReset: z.boolean().optional(),
    requestImages: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(REQUEST_IMAGE_NAME_MAX_CHARS),
          width: dimension,
          height: dimension,
        })
      )
      .max(REQUEST_IMAGE_MAX_COUNT)
      .optional(),
  })
  .refine((input) => input.request.trim() !== '' || (input.requestImages?.length ?? 0) > 0, {
    message: 'Expected a non-blank request or an image',
    path: ['request'],
  });
export type RequestPreviewInput = z.infer<typeof requestPreviewInput>;

export const responseStreamInput = z.strictObject({
  taskKind: z.enum(RESPONSE_TASK_KINDS),
  taskId: id,
  after: queryInt(z.int().nonnegative()).optional(),
});

const imageRequestCommon = {
  sourceId: id,
  expectedSourceHash: hash,
  expectedRevision: revision,
};
export const requestImagesInput = z.discriminatedUnion('target', [
  z.strictObject({ ...imageRequestCommon, target: z.literal('original') }),
  z.strictObject({
    ...imageRequestCommon,
    target: z.literal('translation'),
    expectedTranslationJobId: nonBlank(100),
    expectedTranslationRevision: revision,
  }),
]);
export type RequestImagesInput = z.infer<typeof requestImagesInput>;

const chatId = z.strictObject({ chatId: id });
export const readerOperations = {
  readSceneDetail: defineOperation(
    'reader.readSceneDetail',
    z.strictObject({ attemptId: id }),
    sceneUsageDetail
  ),
  readLastSceneLore: defineOperation('reader.readLastSceneLore', chatId, lastSceneLore),
  listChatAttempts: defineOperation(
    'reader.listChatAttempts',
    chatId,
    z.array(z.looseObject({ id: z.string() }))
  ),
  readAttempt: defineOperation(
    'reader.readAttempt',
    z.strictObject({ attemptId: id }),
    z.looseObject({ id: z.string() })
  ),
  listChatJobs: defineOperation('reader.listChatJobs', chatId, z.array(chatJob)),
  readJob: defineOperation(
    'reader.readJob',
    z.strictObject({ jobId: id }),
    z.looseObject({ id: z.string(), chatId: z.string() })
  ),
  readSceneDeletionImpact: defineOperation(
    'reader.readSceneDeletionImpact',
    z.strictObject({ chatId: id, sourceId: id }),
    sceneDeletionImpact
  ),
  deleteScenes: defineOperation('reader.deleteScenes', deleteScenesInput, sceneDeletionResult),
  reviseSelection: defineOperation(
    'reader.reviseSelection',
    selectionRevisionInput,
    selectionRevisionResult
  ),
  translateInput: defineOperation(
    'reader.translateInput',
    inputTranslationInput,
    inputTranslationResult
  ),
  preflightChatContent: defineOperation(
    'reader.preflightChatContent',
    codexContentPreflightInput,
    codexContentPreflightResult
  ),
  preflightSourceContent: defineOperation(
    'reader.preflightSourceContent',
    z.strictObject({ sourceId: id }),
    codexContentPreflightResult
  ),
  previewPrompt: defineOperation('reader.previewPrompt', promptPreviewInput, promptPreview),
  previewRequest: defineOperation(
    'reader.previewRequest',
    requestPreviewInput,
    z.looseObject({ scope: z.literal('next-request-read-only') })
  ),
  readResponseStream: defineOperation(
    'reader.readResponseStream',
    responseStreamInput,
    z.looseObject({ taskKind: z.enum(RESPONSE_TASK_KINDS), taskId: z.string() })
  ),
  requestImages: defineOperation(
    'reader.requestImages',
    requestImagesInput,
    z.looseObject({ id: z.string(), chatId: z.string() })
  ),
};
