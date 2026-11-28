import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { remapChatAuthoring } from './chat-copy-authoring.js';
import {
  checkedPortableIllustrationReferences,
  remapIllustrationPackageReferences,
} from './illustration-reference-copy.js';
import { mapCopiedMessageTexts } from './chat-copy-messages.js';
import { rewriteTranscriptMedia, remapTranscriptRequestImages } from './chat-media.js';
import type { Store } from './store.js';
import {
  CHAT_BACKUP_FORMAT,
  CHAT_BACKUP_VERSION,
  type ChatBackup,
  type ChatBackupImport,
  type ChatCopy,
} from '../core/chat-backup.js';
import { captureChatCopy, checkedCopyProfile, restoreChatCopy } from './chat-copy.js';
import {
  captureResourceBundle,
  importResourceBundle,
  inspectBundle,
  bundleDigest,
} from './resource-bundle.js';
import { convertTransferImages } from './transfer-images.js';
import { processImage } from './image-processing.js';
import { validateChatTranscript } from '../core/chat-transcript.js';
import { validateChatVariableState } from '../core/chat-variables.js';
import { normalizeStoryGuideConfig } from '../core/story-guide.js';
import { fields, record } from './request-validation.js';
import { readFileSync } from 'node:fs';
import { importPreparedResourceBundle } from './resource-bundle.js';
import {
  exportNativeArchive,
  readPreparedArchive,
  deletePreparedArchive,
  type PreparedArchive,
} from './native-transfer-archive.js';
import { AppError } from './app-errors.js';
import type { ImportChatBackup, ImportChatBackupArchive } from '#contracts/operations';

type ImportedEntries = { key: string; source: { id: string } }[];

function remapRestoredResources(
  copy: ChatCopy,
  file: { contents: ImportedEntries; prompts: ImportedEntries },
  imported: ReadonlyMap<string, string>
): void {
  const ids = (entries: ImportedEntries) =>
    new Map(entries.map((entry) => [entry.source.id, imported.get(entry.key)!]));
  const contents = ids(file.contents),
    prompts = ids(file.prompts);
  const content = (id: string) => {
    const target = contents.get(id);
    if (!target) throw new AppError(400, 'CHAT_BACKUP_INVALID');
    return target;
  };
  if (copy.state.illustrationReferences)
    remapIllustrationPackageReferences(copy.state.illustrationReferences, contents);
  copy.transcript.packageAttachments = copy.transcript.packageAttachments.map((ref) => ({
    ...ref,
    id: content(ref.id),
    revision: 1,
  }));
  const prompt = prompts.get(copy.state.profile.pinned?.mainPromptPresetId ?? '');
  copy.state.profile.pinned = prompt ? { mainPromptPresetId: prompt } : undefined;
  if (copy.state.authoring) remapChatAuthoring(copy.state.authoring, contents);
}

function checkedBackup(value: unknown, binary = false): ChatBackup {
  const body = record(value);
  fields(body, ['format', 'version', 'createdAt', 'title', 'resources', 'chats', 'notices']);
  if (
    body.format !== CHAT_BACKUP_FORMAT ||
    body.version !== CHAT_BACKUP_VERSION ||
    !Array.isArray(body.chats) ||
    !body.chats.length
  )
    throw new AppError(400, 'CHAT_BACKUP_INVALID');
  for (const raw of body.chats) {
    const copy = record(raw);
    validateChatTranscript(copy.transcript);
    const state = record(copy.state);
    checkedCopyProfile(state.profile);
    if (state.illustrationReferences !== undefined)
      checkedPortableIllustrationReferences(state.illustrationReferences);
    if (state.storyGuide !== undefined)
      state.storyGuide = normalizeStoryGuideConfig(state.storyGuide);
    validateChatVariableState(state.variables);
    if (!Array.isArray(state.checkpoints) || !Array.isArray(copy.illustrations))
      throw new AppError(400, 'CHAT_BACKUP_INVALID');
    state.checkpoints.forEach((checkpoint) => {
      if (checkpoint !== null) validateChatVariableState(checkpoint);
    });
  }
  if (!binary) inspectBundle(body.resources);
  return body as ChatBackup;
}

export function exportChatBackupArchive(store: Store, chatId: string) {
  const chat = store.chat(chatId),
    copy = captureChatCopy(store, chatId, undefined, true);
  if (copy.state.profile.pinned) delete copy.state.profile.pinned.mainModel;
  const selected = new Map<string, { kind: 'content' | 'prompt-preset'; id: string }>();
  for (const ref of copy.transcript.packageAttachments)
    selected.set(`content:${ref.id}`, { kind: 'content', id: ref.id });
  const prompt = copy.state.profile.pinned?.mainPromptPresetId;
  if (prompt) selected.set(`prompt:${prompt}`, { kind: 'prompt-preset', id: prompt });
  const resources = captureResourceBundle(store, [...selected.values()], 'preserve');
  return exportNativeArchive(store, resources, {
    format: CHAT_BACKUP_FORMAT,
    version: CHAT_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    title: chat.title,
    chats: [copy],
  });
}

export function importPreparedChatBackup(
  store: Store,
  prepared: PreparedArchive,
  idempotencyKey: string
): ChatBackupImport {
  const file = prepared.manifest.resources;
  const original = checkedBackup({ ...prepared.manifest.backup, resources: file }, true);
  const key = `chat:${idempotencyKey}`,
    digest = bundleDigest(prepared.manifest);
  const binary = new Map(prepared.images.map((image) => [`archive:${image.hash}`, image]));
  return store.transaction(() => {
    const prior = readImportReceipt<{ chatIds: string[]; sources: number }>(store, key, digest);
    if (prior) {
      const chats = prior.chatIds.map((id) => store.chat(id));
      return {
        chat: chats[0]!,
        chats,
        created: false,
        sources: prior.sources,
      };
    }
    const receipt = importPreparedResourceBundle(store, file, prepared.images, {
      idempotencyKey: `resources:${key}`,
    });
    const imported = new Map(receipt.items.map((item) => [item.key, item.id]));
    const chats = original.chats.map((originalCopy, index) => {
      const copy = structuredClone(originalCopy);
      remapRestoredResources(copy, file, imported);
      return restoreChatCopy(
        store,
        copy,
        `restore:${key}:${index}`,
        copy.transcript.title,
        (reference) => {
          const image = binary.get(reference);
          if (!image) throw new AppError(400, 'CHAT_BACKUP_INVALID');
          return readFileSync(image.path);
        }
      );
    });
    const sources = original.chats.reduce((sum, copy) => sum + copy.transcript.entries.length, 0);
    saveImportReceipt(store, key, digest, { chatIds: chats.map((chat) => chat.id), sources });
    return { chat: chats[0]!, chats, created: true, sources };
  });
}

export function importChatBackupArchiveRequest(
  store: Store,
  input: ImportChatBackupArchive
): ChatBackupImport {
  const { preparedId: id, digest } = input,
    key = `chat:archive-request:${input.idempotencyKey}`;
  const command = bundleDigest({ id, digest });
  const result = store.transaction(() => {
    const prior = readImportReceipt<{ chatIds: string[]; sources: number }>(store, key, command);
    if (prior) {
      const chats = prior.chatIds.map((chatId) => store.chat(chatId));
      return {
        chat: chats[0]!,
        chats,
        created: false,
        sources: prior.sources,
      };
    }
    const result = importPreparedChatBackup(
      store,
      readPreparedArchive(store, id, digest, 'chat'),
      `archive:${input.idempotencyKey}`
    );
    saveImportReceipt(store, key, command, {
      chatIds: result.chats.map((chat) => chat.id),
      sources: result.sources,
    });
    return result;
  });
  deletePreparedArchive(store, id);
  return result;
}

export async function importChatBackup(
  store: Store,
  input: ImportChatBackup
): Promise<ChatBackupImport> {
  const key = `chat:${input.idempotencyKey}`;
  const original = checkedBackup(input.backup);
  const digest = bundleDigest(original);
  const previous = (): ChatBackupImport | undefined => {
    const saved = readImportReceipt<{ chatIds: string[]; sources: number }>(store, key, digest);
    if (!saved) return undefined;
    const chats = saved.chatIds.map((id) => store.chat(id));
    return {
      chat: chats[0]!,
      chats,
      created: false,
      sources: saved.sources,
    };
  };
  const prior = previous();
  if (prior) return prior;
  const convertedResources = await convertTransferImages(original.resources);
  const file = convertedResources.file;
  const copies: ChatCopy[] = [];
  for (const originalCopy of original.chats) {
    const copy = structuredClone(originalCopy);
    remapTranscriptRequestImages(copy.transcript, (hash) => {
      const image = convertedResources.imagesBySourceHash.get(hash);
      if (!image) throw new AppError(400, 'CHAT_BACKUP_INVALID');
      return image.hash;
    });
    copy.transcript = rewriteTranscriptMedia(copy.transcript, (kind, hash) => {
      const image =
        kind === 'package-image-blobs' && convertedResources.imagesBySourceHash.get(hash);
      return image ? `/api/package-image-blobs/${image.hash}` : undefined;
    });
    if (copy.state.messages)
      mapCopiedMessageTexts(copy.state.messages, (text) =>
        text.replace(/\/api\/package-image-blobs\/([a-f0-9]{64})/gu, (url, hash) => {
          const image = convertedResources.imagesBySourceHash.get(hash);
          return image ? `/api/package-image-blobs/${image.hash}` : url;
        })
      );
    copy.illustrations = [];
    for (const image of originalCopy.illustrations) {
      const converted = await processImage(Buffer.from(image.base64, 'base64'));
      copy.illustrations.push({
        ...image,
        mime: converted.mime,
        base64: converted.bytes.toString('base64'),
      });
    }
    if (copy.state.illustrationReferences)
      for (const image of checkedPortableIllustrationReferences(copy.state.illustrationReferences)
        .images) {
        const converted = await processImage(Buffer.from(image.base64, 'base64'));
        image.mime = converted.mime;
        image.base64 = converted.bytes.toString('base64');
      }
    copies.push(copy);
  }
  return store.transaction(() => {
    const concurrent = previous();
    if (concurrent) return concurrent;
    const receipt = importResourceBundle(store, {
      file,
      digest: bundleDigest(file),
      idempotencyKey: `resources:${key}`,
    });
    const imported = new Map(receipt.items.map((item) => [item.key, item.id]));
    const chats = copies.map((copy, index) => {
      remapRestoredResources(copy, file, imported);
      return restoreChatCopy(store, copy, `restore:${key}:${index}`);
    });
    const sources = copies.reduce((sum, copy) => sum + copy.transcript.entries.length, 0);
    saveImportReceipt(store, key, digest, { chatIds: chats.map((chat) => chat.id), sources });
    return {
      chat: chats[0]!,
      chats,
      created: true,
      sources,
    };
  });
}
