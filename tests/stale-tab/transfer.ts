import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allEndpoints } from '#contracts';
import type { NativeArchiveExport } from '#contracts/operations';
import { exportChatBackupArchive } from '../../server/chat-backup.js';
import { captureTransferResources } from '../../server/native-transfer.js';
import { exportNativeArchive } from '../../server/native-transfer-archive.js';
import { uploadDirectory } from '../../server/uploads.js';
import { bot, deleted, deletedChat, domainCases, read, scene, store } from './harness.js';

const endpoints = allEndpoints.transfer;
type Kind = 'resources' | 'chat';

async function bytes(stream: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
function staged(archive: Buffer) {
  const id = randomBytes(16).toString('hex');
  mkdirSync(uploadDirectory(store().path), { recursive: true });
  writeFileSync(join(uploadDirectory(store().path), `${id}.bin`), archive);
  return id;
}
const resourceArchive = (items: NativeArchiveExport['items']) =>
  bytes(exportNativeArchive(store(), captureTransferResources(store(), { items })));
const archiveOf = (kind: Kind) =>
  kind === 'chat'
    ? bytes(exportChatBackupArchive(store(), scene('Stale tab backup').chat.id))
    : resourceArchive([{ kind: 'content', id: bot().id }]);
const prepareEndpoint = (kind: Kind) =>
  kind === 'chat' ? endpoints.prepareChatArchive : endpoints.prepareArchive;
const prepared = async (kind: Kind, archive: Buffer) =>
  read<{ preparedId: string; digest: string }>(prepareEndpoint(kind), {
    uploadId: staged(archive),
  });
async function consumedUpload(kind: Kind) {
  const uploadId = staged(await archiveOf(kind));
  await read(prepareEndpoint(kind), { uploadId });
  return { input: { uploadId } };
}

const consumed = (kind: Kind) => ({
  when: 'an upload another tab already prepared',
  arrange: () => consumedUpload(kind),
  answer: { status: 404, code: 'UPLOAD_NOT_FOUND' as const },
  reason:
    'Preparing consumes its staged upload, and uploads are pruned after a day; preparing one that is gone asks for the file again.',
});
const expired = { status: 410, code: 'NATIVE_TRANSFER_EXPIRED' as const };
const expiredReason =
  'A prepared archive lives on disk until it is applied or expires; a second tab applying it later, or after expiry, gets the same definite 410 the restore screen words as "choose the file again".';

export const transferCases = domainCases('transfer', {
  prepareArchive: { cases: [consumed('resources')] },
  applyArchive: {
    cases: [
      {
        when: 'a prepared archive another tab already applied',
        arrange: async () => {
          const archive = await prepared('resources', await archiveOf('resources'));
          const command = {
            preparedId: archive.preparedId,
            digest: archive.digest,
          };
          await read(endpoints.applyArchive, { ...command, idempotencyKey: randomUUID() });
          return { input: { ...command, idempotencyKey: randomUUID() } };
        },
        answer: expired,
        reason: expiredReason,
      },
    ],
  },
  prepareChatArchive: { cases: [consumed('chat')] },
  importChatArchive: {
    cases: [
      {
        when: 'a prepared archive another tab already restored',
        arrange: async () => {
          const archive = await prepared('chat', await archiveOf('chat'));
          const command = { preparedId: archive.preparedId, digest: archive.digest };
          await read(endpoints.importChatArchive, { ...command, idempotencyKey: randomUUID() });
          return { input: { ...command, idempotencyKey: randomUUID() } };
        },
        answer: expired,
        reason: expiredReason,
      },
    ],
  },
  readManuscript: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { id: deletedChat().chatId } }),
        answer: deleted,
      },
    ],
  },
  exportManuscript: {
    cases: [
      {
        when: 'a chat another tab deleted, with a scene bound the range check refuses',
        arrange: () => {
          const { chatId, sourceId } = deletedChat();
          return {
            input: { id: chatId, mode: 'source', expectedHeadRevision: sourceId, fromScene: -1 },
          };
        },
        answer: deleted,
        targetRevision: true,
      },
    ],
  },
});
