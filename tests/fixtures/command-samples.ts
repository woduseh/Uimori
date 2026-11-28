import { randomUUID } from 'node:crypto';
import { deleteChat } from '../../server/chat-deletion.js';
import type { allCommands } from '../../server/commands/index.js';
import type { Store } from '../../server/store.js';
import { createStorePorts } from '../../server/store-ports.js';
import { createFixtureChat } from './chat.js';
import { completedSource } from './illustration.js';

type Input = Record<string, unknown>;
type Samples = {
  inputs: Input[];
  stale?: Record<string, (input: Input) => void>;
};

export const commandSamples: Partial<Record<keyof typeof allCommands, (store: Store) => Samples>> =
  {
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
  };
