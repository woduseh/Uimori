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

/** Export each branch as an independent continuing conversation, with its resource dependencies. */
export function exportChatBackup(store: Store, chatId: string): ChatBackup {
  return store.transaction(() => {
    const chat = store.chat(chatId);
    const branches = store.product
      .branches(chatId)
      .sort((a, b) => Number(b.default) - Number(a.default));
    const chats = branches.map((branch) => {
      const copy = captureChatCopy(store, chatId, branch.id);
      if (!branch.default) copy.transcript.title += ` — ${branch.title}`;
      if (copy.state.profile.pinned) delete copy.state.profile.pinned.mainModel;
      return copy;
    });
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

function checkedBackup(value: unknown): ChatBackup {
  const body = record(value);
  fields(body, ['format', 'version', 'createdAt', 'title', 'resources', 'chats', 'notices']);
  if (
    body.format !== CHAT_BACKUP_FORMAT ||
    body.version !== CHAT_BACKUP_VERSION ||
    !Array.isArray(body.chats) ||
    !body.chats.length ||
    body.chats.length > 1000
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
  inspectBundle(body.resources);
  return body as ChatBackup;
}

export async function importChatBackup(store: Store, value: unknown): Promise<ChatBackupImport> {
  const body = record(value);
  fields(body, ['backup', 'idempotencyKey']);
  const key = `chat:${text(body.idempotencyKey, 'import request', 100)}`;
  const original = checkedBackup(body.backup);
  const digest = bundleDigest(original);
  const prior = store.db
    .prepare('SELECT digest,result FROM import_operations WHERE key=?')
    .get(key);
  if (prior) {
    if (prior.digest !== digest)
      throw new HttpError(409, '다른 백업에 같은 가져오기 ID가 사용됐어요.');
    const saved = JSON.parse(String(prior.result));
    const chats = (saved.chatIds as string[]).map((id) => store.chat(id));
    return {
      chat: chats[0]!,
      chats,
      created: false,
      branches: chats.length,
      sources: saved.sources,
      notices: original.notices,
    };
  }
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
    store.db
      .prepare('INSERT INTO import_operations VALUES(?,?,?)')
      .run(key, digest, JSON.stringify({ chatIds: chats.map((chat) => chat.id), sources }));
    return {
      chat: chats[0]!,
      chats,
      created: true,
      branches: chats.length,
      sources,
      notices: original.notices,
    };
  });
}
