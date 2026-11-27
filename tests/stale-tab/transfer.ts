import { randomBytes, randomUUID } from 'node:crypto';
import { allEndpoints } from '#contracts';
import { createAgentCollaboration, createAgentDefinition } from '../../core/agent-collaboration.js';
import { legacyResourceBundleFixture } from '../fixtures/legacy-backup.js';
import { nativePrompt } from '../fixtures/native-prompt.js';
import {
  conflict,
  deleted,
  deletedChat,
  domainCases,
  model,
  read,
  removed,
  store,
} from './harness.js';

const endpoints = allEndpoints.transfer;
const stagedId = () => randomBytes(16).toString('hex');
const digest = '0'.repeat(64);

async function agentBundle() {
  const program = {
    ...nativePrompt('Stale tab agent prompt'),
    collaboration: {
      ...createAgentCollaboration(),
      enabled: true,
      agents: [{ ...createAgentDefinition('custom', 'reviewer'), model: { id: model().id } }],
    },
  };
  const prompt = store().product.promptPreset({
    title: 'Stale tab agent preset',
    role: 'main',
    program,
  }) as { id: string };
  const file = legacyResourceBundleFixture(store(), [{ kind: 'prompt-preset', id: prompt.id }]);
  const preview = await read<{ digest: string; modelRequirements: { key: string }[] }>(
    endpoints.prepareFile,
    { file }
  );
  const command = (modelId: string) => ({
    file,
    digest: preview.digest,
    idempotencyKey: randomUUID(),
    modelBindings: [
      { requirementKey: preview.modelRequirements[0].key, mode: 'local', model: { id: modelId } },
    ],
  });
  return command;
}

const expiredReason =
  'A prepared archive lives on disk until it is applied or expires; a second tab applying it later, or after expiry, gets the same definite 410 the restore screen words as "choose the file again".';
const missingUpload = {
  when: 'an upload pruned before another tab prepared it',
  arrange: () => ({ input: { uploadId: stagedId() } }),
  answer: { status: 404, code: 'UPLOAD_NOT_FOUND' as const },
  reason:
    'Staged uploads are pruned after a day; preparing one that is gone asks for the file again.',
};
const expiredArchive = {
  when: 'a prepared archive another tab already applied',
  arrange: () => ({
    input: { preparedId: stagedId(), digest, idempotencyKey: randomUUID(), modelBindings: [] },
  }),
  answer: { status: 410, code: 'NATIVE_TRANSFER_EXPIRED' as const },
  reason: expiredReason,
};

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
        answer: { status: 400, code: 'MODEL_SELECTION_UNAVAILABLE' },
        reason:
          'An agent bound to a model another tab deleted meets the same MODEL_SELECTION_UNAVAILABLE as the model workspace, and the import writes nothing.',
      },
    ],
  },
  prepareArchive: { cases: [missingUpload] },
  applyArchive: { cases: [expiredArchive] },
  prepareChatArchive: { cases: [missingUpload] },
  importChatArchive: {
    cases: [
      {
        ...expiredArchive,
        arrange: () => ({
          input: { preparedId: stagedId(), digest, idempotencyKey: randomUUID() },
        }),
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
        when: 'a chat another tab deleted',
        arrange: () => {
          const { chatId, sourceId } = deletedChat();
          return { input: { id: chatId, mode: 'source', expectedHeadRevision: sourceId } };
        },
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'a chat another tab deleted and a malformed scene bound',
        arrange: () => {
          const { chatId, sourceId } = deletedChat();
          return {
            input: { id: chatId, mode: 'source', expectedHeadRevision: sourceId, fromScene: '1' },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
});
