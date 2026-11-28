import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allEndpoints } from '#contracts';
import type { NativeArchiveExport } from '#contracts/operations';
import { createAgentCollaboration, createAgentDefinition } from '../../core/agent-collaboration.js';
import { exportChatBackupArchive } from '../../server/chat-backup.js';
import { captureTransferResources } from '../../server/native-transfer.js';
import { exportNativeArchive } from '../../server/native-transfer-archive.js';
import { uploadDirectory } from '../../server/uploads.js';
import { legacyResourceBundleFixture } from '../fixtures/legacy-backup.js';
import { nativePrompt } from '../fixtures/native-prompt.js';
import {
  bot,
  deleted,
  deletedChat,
  domainCases,
  model,
  read,
  removed,
  scene,
  store,
} from './harness.js';

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
  read<{ preparedId: string; digest: string; modelRequirements: { key: string }[] }>(
    prepareEndpoint(kind),
    { uploadId: staged(archive) }
  );
async function consumedUpload(kind: Kind) {
  const uploadId = staged(await archiveOf(kind));
  await read(prepareEndpoint(kind), { uploadId });
  return { input: { uploadId } };
}

function agentPreset() {
  const program = {
    ...nativePrompt('Stale tab agent prompt'),
    collaboration: {
      ...createAgentCollaboration(),
      enabled: true,
      agents: [{ ...createAgentDefinition('custom', 'reviewer'), model: { id: model().id } }],
    },
  };
  return store().product.promptPreset({
    title: 'Stale tab agent preset',
    role: 'main',
    program,
  }) as { id: string };
}
const localBinding = (requirementKey: string, modelId: string) => [
  { requirementKey, mode: 'local', model: { id: modelId } },
];

async function agentBundle() {
  const file = legacyResourceBundleFixture(store(), [
    { kind: 'prompt-preset', id: agentPreset().id },
  ]);
  const preview = await read<{ digest: string; modelRequirements: { key: string }[] }>(
    endpoints.prepareFile,
    { file }
  );
  return (modelId: string) => ({
    file,
    digest: preview.digest,
    idempotencyKey: randomUUID(),
    modelBindings: localBinding(preview.modelRequirements[0].key, modelId),
  });
}

const deletedModel = { status: 400, code: 'MODEL_SELECTION_UNAVAILABLE' as const };
const modelReason =
  'An agent bound to a model another tab deleted meets the same MODEL_SELECTION_UNAVAILABLE as the model workspace, and the import writes nothing.';
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
  applyFile: {
    cases: [
      {
        when: 'a local model binding naming a model another tab deleted',
        arrange: async () => {
          const command = await agentBundle();
          const gone = model();
          removed('model', gone);
          return { input: command(gone.id), control: command(model().id) };
        },
        answer: deletedModel,
        reason: modelReason,
      },
    ],
  },
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
            modelBindings: [],
          };
          await read(endpoints.applyArchive, { ...command, idempotencyKey: randomUUID() });
          return { input: { ...command, idempotencyKey: randomUUID() } };
        },
        answer: expired,
        reason: expiredReason,
      },
      {
        when: 'a local model binding naming a model another tab deleted',
        arrange: async () => {
          const archive = await prepared(
            'resources',
            await resourceArchive([{ kind: 'prompt-preset', id: agentPreset().id }])
          );
          const gone = model();
          removed('model', gone);
          const command = (modelId: string) => ({
            preparedId: archive.preparedId,
            digest: archive.digest,
            idempotencyKey: randomUUID(),
            modelBindings: localBinding(archive.modelRequirements[0].key, modelId),
          });
          return { input: command(gone.id), control: command(model().id) };
        },
        answer: deletedModel,
        reason: modelReason,
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
