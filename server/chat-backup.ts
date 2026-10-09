import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { remapChatAuthoring } from './chat-copy-authoring.js';
import { copiedMessageTexts, mapCopiedMessageTexts } from './chat-copy-messages.js';
import { transcriptImages, rewriteTranscriptMedia } from './chat-media.js';
import type { Store } from './store.js';
import {
  CHAT_BACKUP_FORMAT,
  CHAT_BACKUP_VERSION,
  CHAT_BACKUP_MAX_BYTES,
  type ChatBackup,
  type ChatBackupImport,
  type ChatCopy,
} from '../core/chat-backup.js';
import { captureChatCopy, restoreChatCopy } from './chat-copy.js';
import {
  exportResourceBundle,
  importResourceBundle,
  inspectBundle,
  bundleDigest,
} from './resource-bundle.js';
import { convertTransferImages } from './transfer-images.js';
import { processImage } from './image-processing.js';
import { validateChatTranscript } from '../core/chat-transcript.js';
import { validateChatVariableState } from '../core/chat-variables.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { importPreparedResourceBundle } from './resource-bundle.js';
import {
  exportNativeArchive,
  readPreparedArchive,
  deletePreparedArchive,
  type PreparedArchive,
} from './native-transfer-archive.js';

/** Export the current chat as an independent continuing conversation, with its resources. */
export function exportChatBackup(store: Store, chatId: string): ChatBackup {
  return store.transaction(() => {
    const chat = store.chat(chatId);
    const copy = captureChatCopy(store, chatId);
    if (copy.state.profile.pinned) delete copy.state.profile.pinned.mainModel;
    const chats = [copy];
    const selected = new Map<string, { kind: 'content' | 'prompt-preset'; id: string }>();
    for (const copy of chats) {
      for (const ref of copy.transcript.packageAttachments)
        selected.set(`content:${ref.id}`, { kind: 'content', id: ref.id });
      const prompt = copy.state.profile.pinned?.mainPromptPresetId;
      if (prompt) selected.set(`prompt:${prompt}`, { kind: 'prompt-preset', id: prompt });
    }
    const resources = exportResourceBundle(store, [...selected.values()]);
    resources.images = [
      ...new Map(
        [
          ...resources.images,
          ...transcriptImages(
            store,
            chats.map((copy) => ({
              ...copy.transcript,
              entries: [
                ...copy.transcript.entries,
                ...copiedMessageTexts(copy.state.messages ?? []).map((text) => ({
                  request: '',
                  text,
                  translation: null,
                })),
              ],
            }))
          ),
        ].map((image) => [image.hash, image])
      ).values(),
    ];
    const result: ChatBackup = {
      format: CHAT_BACKUP_FORMAT,
      version: CHAT_BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      title: chat.title,
      resources,
      chats,
      notices: [
        '모델 연결과 API 키는 가져오지 않아요. 대상 작업실의 모델을 사용해요.',
        '실행 기록·도우미 내부 작업·자동 요약 체크포인트·일회성 옵션은 복원하지 않아요. 원문과 메모로 다시 이어가요.',
      ],
    };
    if (Buffer.byteLength(JSON.stringify(result)) > CHAT_BACKUP_MAX_BYTES)
      throw new HttpError(413, '채팅 백업이 256MiB를 넘어요.');
    return result;
  });
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
    throw new HttpError(400, '개인 채팅 백업 파일을 확인해 주세요.');
  for (const raw of body.chats) {
    const copy = record(raw);
    validateChatTranscript(copy.transcript);
    const state = record(copy.state);
    validateChatVariableState(state.variables);
    if (!Array.isArray(state.checkpoints) || !Array.isArray(copy.illustrations))
      throw new HttpError(400, '채팅 상태가 올바르지 않아요.');
    state.checkpoints.forEach((checkpoint) => {
      if (checkpoint !== null) validateChatVariableState(checkpoint);
    });
  }
  if (!binary) inspectBundle(body.resources);
  return body as ChatBackup;
}

/** Images stay binary in a portable archive, including displayed illustrations and authored media. */
export function exportChatBackupArchive(store: Store, chatId: string) {
  const chat = store.chat(chatId),
    copy = captureChatCopy(store, chatId, undefined, true);
  if (copy.state.profile.pinned) delete copy.state.profile.pinned.mainModel;
  const selected = new Map<string, { kind: 'content' | 'prompt-preset'; id: string }>();
  for (const ref of copy.transcript.packageAttachments)
    selected.set(`content:${ref.id}`, { kind: 'content', id: ref.id });
  const prompt = copy.state.profile.pinned?.mainPromptPresetId;
  if (prompt) selected.set(`prompt:${prompt}`, { kind: 'prompt-preset', id: prompt });
  const resources = exportResourceBundle(store, [...selected.values()], true);
  return exportNativeArchive(store, resources, {
    format: CHAT_BACKUP_FORMAT,
    version: CHAT_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    title: chat.title,
    chats: [copy],
    notices: [
      '모델 연결과 API 키는 가져오지 않아요. 대상 작업실의 모델을 사용해요.',
      '실행 기록·도우미 내부 작업·자동 요약 체크포인트·일회성 옵션은 복원하지 않아요. 원문과 메모로 다시 이어가요.',
    ],
  });
}

/** All conversion completed before preview; the synchronous restore remains one atomic transaction. */
export function importPreparedChatBackup(
  store: Store,
  prepared: PreparedArchive,
  idempotencyKey: string
): ChatBackupImport {
  const file = prepared.manifest.resources;
  const original = checkedBackup({ ...prepared.manifest.backup, resources: file }, true);
  const key = `chat:${text(idempotencyKey, 'import request', 100)}`,
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
        notices: original.notices,
      };
    }
    const receipt = importPreparedResourceBundle(store, file, prepared.images, {
      digest: bundleDigest(file),
      idempotencyKey: `resources:${key}`,
      modelBindings: [],
    });
    const importedIds = new Map(receipt.items.map((item) => [item.key, item.id]));
    const remap = new Map(
      [...file.contents, ...file.prompts].map((entry) => [
        entry.source.id,
        importedIds.get(entry.key)!,
      ])
    );
    const chats = original.chats.map((originalCopy, index) => {
      const copy = structuredClone(originalCopy);
      copy.transcript.packageAttachments = copy.transcript.packageAttachments.map((ref) => ({
        ...ref,
        id: remap.get(ref.id)!,
        revision: 1,
      }));
      const prompt = copy.state.profile.pinned?.mainPromptPresetId;
      copy.state.profile.pinned =
        prompt && remap.has(prompt) ? { mainPromptPresetId: remap.get(prompt)! } : undefined;
      if (copy.state.authoring) remapChatAuthoring(copy.state.authoring, remap);
      return restoreChatCopy(
        store,
        copy,
        `restore:${key}:${index}`,
        copy.transcript.title,
        (reference) => {
          const image = binary.get(reference);
          if (!image) throw new HttpError(400, '삽화 이미지가 없어요.');
          const bytes = readFileSync(image.path);
          if (
            bytes.length !== image.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== image.hash
          )
            throw new HttpError(409, '가져올 이미지가 변경됐어요. 다시 확인해 주세요.');
          return bytes;
        }
      );
    });
    const sources = original.chats.reduce((sum, copy) => sum + copy.transcript.entries.length, 0);
    saveImportReceipt(store, key, digest, { chatIds: chats.map((chat) => chat.id), sources });
    return { chat: chats[0]!, chats, created: true, sources, notices: original.notices };
  });
}

export function importChatBackupArchiveRequest(store: Store, value: unknown): ChatBackupImport {
  const body = record(value);
  fields(body, ['preparedId', 'digest', 'idempotencyKey']);
  const id = text(body.preparedId, 'prepared ID', 32),
    digest = text(body.digest, 'digest', 64),
    key = `chat:archive-request:${text(body.idempotencyKey, 'import request', 100)}`;
  const command = bundleDigest({ id, digest });
  const result = store.transaction(() => {
    const prior = readImportReceipt<{ chatIds: string[]; sources: number; notices: string[] }>(
      store,
      key,
      command
    );
    if (prior) {
      const chats = prior.chatIds.map((chatId) => store.chat(chatId));
      return {
        chat: chats[0]!,
        chats,
        created: false,
        sources: prior.sources,
        notices: prior.notices,
      };
    }
    const result = importPreparedChatBackup(
      store,
      readPreparedArchive(store, id, digest, 'chat'),
      `archive:${body.idempotencyKey}`
    );
    saveImportReceipt(store, key, command, {
      chatIds: result.chats.map((chat) => chat.id),
      sources: result.sources,
      notices: result.notices,
    });
    return result;
  });
  deletePreparedArchive(store, id);
  return result;
}

export async function importChatBackup(store: Store, value: unknown): Promise<ChatBackupImport> {
  const body = record(value);
  fields(body, ['backup', 'idempotencyKey']);
  const key = `chat:${text(body.idempotencyKey, 'import request', 100)}`;
  const original = checkedBackup(body.backup);
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
      notices: original.notices,
    };
  };
  const prior = previous();
  if (prior) return prior;
  const convertedResources = await convertTransferImages(original.resources);
  const file = convertedResources.file;
  const copies: ChatCopy[] = [];
  for (const originalCopy of original.chats) {
    const copy = structuredClone(originalCopy);
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
    copies.push(copy);
  }
  return store.transaction(() => {
    // Image conversion yields; another request may have finished while it was running.
    const concurrent = previous();
    if (concurrent) return concurrent;
    const receipt = importResourceBundle(store, {
      file,
      digest: inspectBundle(file).digest,
      idempotencyKey: `resources:${key}`,
      modelBindings: [],
    });
    const remap = new Map(
      [...file.contents, ...file.prompts].map((entry) => [
        entry.source.id,
        receipt.items.find((item) => item.key === entry.key)!.id,
      ])
    );
    const chats = copies.map((copy, index) => {
      copy.transcript.packageAttachments = copy.transcript.packageAttachments.map((ref) => ({
        ...ref,
        id: remap.get(ref.id)!,
        revision: 1,
      }));
      const prompt = copy.state.profile.pinned?.mainPromptPresetId;
      copy.state.profile.pinned =
        prompt && remap.has(prompt) ? { mainPromptPresetId: remap.get(prompt)! } : undefined;
      if (copy.state.authoring) remapChatAuthoring(copy.state.authoring, remap);
      return restoreChatCopy(store, copy, `restore:${key}:${index}`);
    });
    const sources = copies.reduce((sum, copy) => sum + copy.transcript.entries.length, 0);
    saveImportReceipt(store, key, digest, { chatIds: chats.map((chat) => chat.id), sources });
    return {
      chat: chats[0]!,
      chats,
      created: true,
      sources,
      notices: original.notices,
    };
  });
}
