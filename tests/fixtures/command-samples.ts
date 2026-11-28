import { prepareRisuImport } from '../../server/risu-import.js';
import { prepareRisuPresetImport } from '../../server/risu-preset-import.js';
import { randomUUID } from 'node:crypto';
import { deleteChat } from '../../server/chat-deletion.js';
import type { allCommands } from '../../server/commands/index.js';
import type { Store } from '../../server/store.js';
import { createStorePorts } from '../../server/store-ports.js';
import { createFixtureChat } from './chat.js';
import { completedSource } from './illustration.js';
import { seedOutline } from './outline.js';

type Input = Record<string, unknown>;
type Samples = {
  inputs: Input[];
  stale?: Record<string, (input: Input) => void>;
};

function importSample(document: unknown, preview: (value: unknown) => { digest: string }) {
  const source = {
    name: 'sample.json',
    base64: Buffer.from(JSON.stringify(document)).toString('base64'),
  };
  return {
    inputs: [
      {
        source,
        digest: preview({ source }).digest,
        allowPartial: true,
        idempotencyKey: randomUUID(),
      },
    ],
  };
}

export const commandSamples: Partial<Record<keyof typeof allCommands, (store: Store) => Samples>> =
  {
    'risu.import.apply': () =>
      importSample(
        { spec: 'chara_card_v3', data: { name: 'Probe', description: 'Receipt probe' } },
        prepareRisuImport
      ),
    'risuPreset.import.apply': () =>
      importSample(
        {
          name: 'Probe',
          promptTemplate: [{ type: 'plain', type2: 'normal', role: 'system', text: 'Probe' }],
        },
        prepareRisuPresetImport
      ),
    'chat-settings.writeVariables'(store) {
      const { id: chatId } = createFixtureChat(store, 'Variables command probe');
      const head = {
        chatId,
        expectedRevision: 0,
        expectedSourceHash: null,
        idempotencyKey: randomUUID(),
      };
      const ports = createStorePorts(store);
      return {
        inputs: [
          { ...head, values: { mood: 'calm' } },
          { ...head, set: { mood: 'steady' } },
        ],
        stale: {
          chatId: () => deleteChat(store, chatId),
          expectedRevision: () =>
            ports.tx.transaction((tx) => {
              const current = ports.chatVariables.read(chatId);
              ports.chatVariables.save(tx, chatId, { ...current, revision: current.revision + 1 });
            }),
          expectedSourceHash: () => completedSource(store, chatId, 'Another scene'),
        },
      };
    },
    'chat-settings.updateStoryGuide'(store) {
      const { id: chatId } = createFixtureChat(store, 'Guide command probe');
      const head = { chatId, expectedRevision: 0 };
      const current = store.storyGuide.get(chatId);
      const changes = { enabled: true, work: 'Harbor Chronicle' };
      const ports = createStorePorts(store);
      return {
        inputs: [
          { ...head, config: { ...current.config, ...changes } },
          { ...head, changes },
        ],
        stale: {
          chatId: () => deleteChat(store, chatId),
          expectedRevision: () =>
            ports.tx.transaction((tx) => {
              store.storyGuide.save(tx, chatId, current.revision + 1, current.config);
            }),
        },
      };
    },
    'outline.setFocus'(store) {
      const { id: chatId } = createFixtureChat(store, 'Outline focus command probe');
      const [arc] = seedOutline(store, chatId, [
        { op: 'create', level: 'arc', title: '1부', intent: '시작' },
      ]);
      return {
        inputs: [{ chatId, nodeId: arc!.id }],
        stale: {
          chatId: () => deleteChat(store, chatId),
        },
      };
    },
    'outline.apply'(store) {
      const { id: chatId } = createFixtureChat(store, 'Outline apply command probe');
      const [arc] = seedOutline(store, chatId, [
        { op: 'create', level: 'arc', title: '1부', intent: '기존 구성' },
      ]);
      const head = { chatId, idempotencyKey: randomUUID() };
      return {
        inputs: [
          {
            ...head,
            operations: [{ op: 'create', ref: 'arc2', level: 'arc', title: '2부', intent: '시작' }],
          },
          {
            ...head,
            operations: [{ op: 'update', id: arc!.id, expectedRevision: 1, title: '1부 개정' }],
          },
          {
            ...head,
            operations: [{ op: 'move', id: arc!.id, expectedRevision: 1, position: 1 }],
          },
          {
            ...head,
            operations: [{ op: 'remove', id: arc!.id, expectedRevision: 1 }],
          },
        ],
        stale: {
          chatId: () => deleteChat(store, chatId),
        },
      };
    },
  };
