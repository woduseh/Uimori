import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { nonBlank } from '../text.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const stagedId = z.string().regex(/^[a-f0-9]{32}$/u);
const count = z.int().nonnegative();
const resourceKind = z.enum(['content', 'prompt-preset']);

export const nativeTransferModelBinding = z.discriminatedUnion('mode', [
  z.strictObject({ requirementKey: nonBlank(300), mode: z.literal('inherit-main') }),
  z.strictObject({
    requirementKey: nonBlank(300),
    mode: z.literal('local'),
    model: z.strictObject({ id: nonBlank(100) }),
  }),
]);
export type NativeTransferModelBinding = z.infer<typeof nativeTransferModelBinding>;
const modelBindings = z.array(nativeTransferModelBinding);

const summary = z.strictObject({
  contents: count,
  prompts: count,
  combinations: count,
  images: count,
  imageBytes: count,
});
const entry = {
  kind: resourceKind,
  key: z.string(),
  title: z.string(),
  category: z.string(),
  root: z.boolean(),
};
const preview = {
  digest: sha256,
  summary,
  entries: z.array(z.strictObject(entry)),
  modelRequirements: z.array(
    z.strictObject({
      key: z.string(),
      promptKey: z.string(),
      promptTitle: z.string(),
      agentId: z.string(),
      agentTitle: z.string(),
      sourceModelId: z.string(),
    })
  ),
  warnings: z.array(z.strictObject({ code: z.string(), key: z.string(), message: z.string() })),
};
const archivePreview = z.strictObject({
  ...preview,
  preparedId: stagedId,
  backup: z.strictObject({ title: z.string(), chats: count, sources: count }).optional(),
});
const receipt = z.strictObject({
  id: z.string(),
  created: z.boolean(),
  digest: sha256,
  importedAt: z.string(),
  summary,
  items: z.array(z.strictObject({ ...entry, id: z.string(), revision: z.int().positive() })),
});
const chat = z.looseObject({ id: z.string(), title: z.string() });
const chatBackupImport = z.strictObject({
  chat,
  chats: z.array(chat).min(1),
  created: z.boolean(),
  sources: count,
});

export const transferRawInputs = {
  exportArchive: z.strictObject({
    items: z
      .array(z.strictObject({ kind: resourceKind, id: nonBlank(100) }))
      .min(1)
      .max(1000),
  }),
  chatDownload: z.strictObject({ id: nonBlank(100) }),
  packageImageBlob: z.strictObject({ hash: sha256, w: z.string().optional() }),
  requestFile: z.strictObject({ hash: sha256, name: z.string().optional() }),
};
export type NativeArchiveExport = z.infer<typeof transferRawInputs.exportArchive>;

const reviewedDigest = nonBlank(64);
const applyFileInput = z.strictObject({
  file: z.unknown(),
  digest: reviewedDigest,
  idempotencyKey: nonBlank(200),
  modelBindings,
});
export type ApplyNativeTransfer = z.infer<typeof applyFileInput>;
const applyArchiveInput = z.strictObject({
  preparedId: stagedId,
  digest: reviewedDigest,
  idempotencyKey: nonBlank(100),
  modelBindings,
});
export type ApplyNativeArchive = z.infer<typeof applyArchiveInput>;
const importChatArchiveInput = z.strictObject({
  preparedId: stagedId,
  digest: reviewedDigest,
  idempotencyKey: nonBlank(100),
});
export type ImportChatBackupArchive = z.infer<typeof importChatArchiveInput>;
const importChatBackupInput = z.strictObject({
  backup: z.unknown(),
  idempotencyKey: nonBlank(100),
});
export type ImportChatBackup = z.infer<typeof importChatBackupInput>;
const importTranscriptInput = z.strictObject({
  transcript: z.unknown(),
  title: z
    .string()
    .refine((value) => value.trim() !== '', 'Expected a non-blank string')
    .optional(),
  idempotencyKey: nonBlank(160),
});
export type ImportChatTranscript = z.infer<typeof importTranscriptInput>;
const exportManuscriptInput = z.strictObject({
  id: nonBlank(100),
  mode: z.enum(['source', 'translation']),
  fromScene: z.number().optional(),
  toScene: z.number().optional(),
  expectedHeadRevision: z.string().nullable(),
});
export type ExportManuscript = z.infer<typeof exportManuscriptInput>;

export const transferOperations = {
  prepareFile: defineOperation(
    'transfer.prepareFile',
    z.strictObject({ file: z.unknown() }),
    z.strictObject(preview)
  ),
  applyFile: defineOperation('transfer.applyFile', applyFileInput, receipt),
  prepareArchive: defineOperation(
    'transfer.prepareArchive',
    z.strictObject({ uploadId: stagedId }),
    archivePreview
  ),
  applyArchive: defineOperation('transfer.applyArchive', applyArchiveInput, receipt),
  prepareChatArchive: defineOperation(
    'transfer.prepareChatArchive',
    z.strictObject({ uploadId: stagedId }),
    archivePreview
  ),
  importChatArchive: defineOperation(
    'transfer.importChatArchive',
    importChatArchiveInput,
    chatBackupImport
  ),
  importChatBackup: defineOperation(
    'transfer.importChatBackup',
    importChatBackupInput,
    chatBackupImport
  ),
  importTranscript: defineOperation(
    'transfer.importTranscript',
    importTranscriptInput,
    z.strictObject({ chat, created: z.boolean(), skippedAttachments: z.array(z.unknown()) })
  ),
  readManuscript: defineOperation(
    'transfer.readManuscript',
    z.strictObject({ id: nonBlank(100) }),
    z.strictObject({
      title: z.string(),
      headRevision: z.string().nullable(),
      scenes: z.array(z.strictObject({ number: count })),
    })
  ),
  exportManuscript: defineOperation(
    'transfer.exportManuscript',
    exportManuscriptInput,
    z.strictObject({ title: z.string(), range: z.string(), markdown: z.string() })
  ),
};
