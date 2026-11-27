import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';
import { BOOKMARK_NOTE_MAX_CHARS, BOOKMARK_TITLE_MAX_CHARS } from './bookmark-limits.js';
import { USAGE_KINDS } from './usage-kinds.js';

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((date) => {
    const time = Date.parse(`${date}T00:00:00.000Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
  }, 'Invalid calendar date');
const usageRange = { from: calendarDate, to: calendarDate };
const ordered = (range: { from: string; to: string }) => range.from <= range.to;
const orderMessage = { message: 'Usage start date is after the end date', path: ['to'] };

export const usagePeriod = z.strictObject(usageRange).refine(ordered, orderMessage);
export type UsagePeriod = z.infer<typeof usagePeriod>;
export const usageExportQuery = z
  .strictObject({
    ...usageRange,
    group: z.enum(['day', 'model', 'kind']).default('day'),
    lang: z.enum(['ko', 'en', 'ja', 'zh']).default('ko'),
  })
  .refine(ordered, orderMessage);

const count = z.int().nonnegative();
const usd = z.number().nonnegative();
export const usageTotals = z.strictObject({
  calls: count,
  inputTokens: count,
  outputTokens: count,
  unknownInputCalls: count,
  unknownOutputCalls: count,
  reportedUsd: usd,
  estimatedUsd: usd,
  partialUsd: usd,
  partialCalls: count,
  unknownCostCalls: count,
  runningCalls: count,
});
export type UsageTotals = z.infer<typeof usageTotals>;
export const usageReport = z.strictObject({
  from: z.string(),
  to: z.string(),
  timeZone: z.literal('Asia/Seoul'),
  totals: usageTotals,
  days: z.array(usageTotals.extend({ day: z.string() })),
  models: z.array(usageTotals.extend({ modelId: z.string(), connectionId: z.string() })),
  kinds: z.array(usageTotals.extend({ kind: z.enum(USAGE_KINDS) })),
  undated: usageTotals,
  coverageSince: z.string(),
});
export type UsageReport = z.infer<typeof usageReport>;

export const backupSettings = z.strictObject({
  revision,
  enabled: z.boolean(),
  hour: z.int(),
  minute: z.int(),
  retain: z.int(),
  nextRunAt: z.string().nullable(),
});
export type BackupSettings = z.infer<typeof backupSettings>;
export const backupManifest = z.strictObject({
  format: z.literal('uimori-snapshot-v1'),
  id: z.string(),
  createdAt: z.string(),
  appVersion: z.string(),
  buildId: z.string(),
  schema: z.int(),
  bytes: z.int().nonnegative(),
  sha256: z.string(),
});
export type BackupManifest = z.infer<typeof backupManifest>;
export const backupStatus = z.strictObject({
  settings: backupSettings,
  status: z.enum(['idle', 'running', 'failed']),
  lastSuccess: backupManifest.nullable(),
  error: z.string().nullable(),
  warning: z.string().nullable(),
  backups: z.array(backupManifest),
});
export type BackupStatus = z.infer<typeof backupStatus>;
export const updateBackupSettingsInput = z.strictObject({
  expectedRevision: revision,
  enabled: z.boolean(),
  hour: z.int().min(0).max(23),
  minute: z.int().min(0).max(59),
  retain: z.int().min(1).max(30),
});
export type UpdateBackupSettings = z.infer<typeof updateBackupSettingsInput>;

const browserId = nonBlank(100);
const chatId = nonBlank(120);
const representation = z.enum(['original', 'translation']);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const readerTarget = z.strictObject({
  chatId: z.string(),
  sourceId: z.string(),
  representation,
  contentHash: z.string().optional(),
  blockAnchor: z.string().optional(),
  offsetRatio: z.number().optional(),
  changedParagraph: z.int().nullable().optional(),
});
export const readerTargetInput = z.strictObject({
  chatId: chatId.optional(),
  sourceId: nonBlank(120),
  representation,
  contentHash: sha256.optional(),
  blockAnchor: nonBlank(200).optional(),
  offsetRatio: z.number().min(0).max(1).optional(),
});
export type ReaderTargetInput = z.infer<typeof readerTargetInput>;

export const readingPosition = z.strictObject({
  clientId: z.string(),
  revision,
  updatedAt: z.string(),
  target: readerTarget,
});
export const readingPositions = z.strictObject({
  own: readingPosition.nullable(),
  other: readingPosition.nullable(),
});
export const saveReadingPositionInput = z.strictObject({
  chatId,
  clientId: browserId,
  expectedRevision: revision,
  target: readerTargetInput,
});
export type SaveReadingPosition = z.infer<typeof saveReadingPositionInput>;

export const bookmark = z.strictObject({
  id: z.string(),
  revision,
  target: readerTarget,
  title: z.string(),
  note: z.string(),
  quote: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const bookmarkTitle = nonBlank(BOOKMARK_TITLE_MAX_CHARS);
const bookmarkNote = z.string().max(BOOKMARK_NOTE_MAX_CHARS);
export const addBookmarkInput = z.strictObject({
  chatId,
  id: browserId,
  target: readerTargetInput,
  title: bookmarkTitle,
  note: bookmarkNote.default(''),
  quote: z.string().max(300).default(''),
});
export type AddBookmark = z.infer<typeof addBookmarkInput>;
export const updateBookmarkInput = z.strictObject({
  id: browserId,
  expectedRevision: revision,
  title: bookmarkTitle,
  note: bookmarkNote,
});
export type UpdateBookmark = z.infer<typeof updateBookmarkInput>;
export const deleteBookmarkInput = z.strictObject({ id: browserId, expectedRevision: revision });

export const pushPreferences = z.strictObject({
  main: z.boolean(),
  failures: z.boolean(),
  translation: z.boolean(),
  illustration: z.boolean(),
  showTitle: z.boolean(),
});
export const pushInfo = z.strictObject({
  available: z.boolean(),
  publicKey: z.string().nullable(),
  device: z
    .strictObject({ revision, preferences: pushPreferences, lastError: z.string().nullable() })
    .nullable(),
});
export const pushSubscription = z.strictObject({
  endpoint: z.string().max(4096),
  keys: z.strictObject({ p256dh: z.string().max(100), auth: z.string().max(100) }),
  expirationTime: z.number().nullable().optional(),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscription>;
const pushClient = z.strictObject({ clientId: browserId });
export const subscribePushInput = z.strictObject({
  clientId: browserId,
  expectedRevision: revision,
  subscription: pushSubscription,
  preferences: pushPreferences,
});
export type SubscribePush = z.infer<typeof subscribePushInput>;
export const updatePushInput = z.strictObject({
  clientId: browserId,
  expectedRevision: revision,
  preferences: pushPreferences,
});
export type UpdatePush = z.infer<typeof updatePushInput>;
export const unsubscribePushInput = z.strictObject({
  clientId: browserId,
  expectedRevision: revision,
});
export type UnsubscribePush = z.infer<typeof unsubscribePushInput>;

const searchKind = z.enum(['original', 'translation', 'request']);
const manuscriptSearchFields = {
  query: nonBlank(500),
  kinds: z.array(searchKind).min(1).max(3),
  cursor: nonBlank(1500).nullable().optional(),
  limit: z.int().min(1).max(50).optional(),
};
export const manuscriptSearchInput = z.discriminatedUnion('scope', [
  z.strictObject({ ...manuscriptSearchFields, scope: z.literal('workspace') }),
  z.strictObject({ ...manuscriptSearchFields, scope: z.literal('chat'), chatId }),
  z.strictObject({ ...manuscriptSearchFields, scope: z.literal('bot'), botId: nonBlank(120) }),
]);
export type ManuscriptSearchInput = z.infer<typeof manuscriptSearchInput>;
export const manuscriptSearchResult = z.strictObject({
  items: z.array(
    z.strictObject({
      target: readerTarget,
      title: z.string(),
      botId: z.string(),
      sceneNumber: z.int(),
      matches: z.array(
        z.strictObject({
          kind: searchKind,
          contentHash: z.string(),
          snippet: z.array(z.strictObject({ text: z.string(), match: z.boolean() })),
        })
      ),
    })
  ),
  nextCursor: z.string().nullable(),
  coverage: z.enum(['complete', 'building', 'partial']),
});

export const personalWorkspaceOperations = {
  readUsage: defineOperation('personal-workspace.readUsage', usagePeriod, usageReport),
  readBackups: defineOperation('personal-workspace.readBackups', z.strictObject({}), backupStatus),
  updateBackupSettings: defineOperation(
    'personal-workspace.updateBackupSettings',
    updateBackupSettingsInput,
    backupSettings
  ),
  startBackup: defineOperation(
    'personal-workspace.startBackup',
    z.strictObject({}),
    z.strictObject({ status: z.literal('running') })
  ),
  readReadingPositions: defineOperation(
    'personal-workspace.readReadingPositions',
    z.strictObject({ chatId, clientId: browserId }),
    readingPositions
  ),
  saveReadingPosition: defineOperation(
    'personal-workspace.saveReadingPosition',
    saveReadingPositionInput,
    readingPosition
  ),
  listBookmarks: defineOperation(
    'personal-workspace.listBookmarks',
    z.strictObject({ chatId }),
    z.array(bookmark)
  ),
  addBookmark: defineOperation('personal-workspace.addBookmark', addBookmarkInput, bookmark),
  updateBookmark: defineOperation(
    'personal-workspace.updateBookmark',
    updateBookmarkInput,
    bookmark
  ),
  deleteBookmark: defineOperation(
    'personal-workspace.deleteBookmark',
    deleteBookmarkInput,
    z.strictObject({ deleted: z.literal(true) })
  ),
  readPush: defineOperation('personal-workspace.readPush', pushClient, pushInfo),
  preparePush: defineOperation('personal-workspace.preparePush', pushClient, pushInfo),
  subscribePush: defineOperation('personal-workspace.subscribePush', subscribePushInput, pushInfo),
  updatePush: defineOperation('personal-workspace.updatePush', updatePushInput, pushInfo),
  unsubscribePush: defineOperation(
    'personal-workspace.unsubscribePush',
    unsubscribePushInput,
    pushInfo
  ),
  testPush: defineOperation(
    'personal-workspace.testPush',
    pushClient,
    z.strictObject({ status: z.literal('queued') })
  ),
  searchManuscripts: defineOperation(
    'personal-workspace.searchManuscripts',
    manuscriptSearchInput,
    manuscriptSearchResult
  ),
};
