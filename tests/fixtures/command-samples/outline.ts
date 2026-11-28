import { randomUUID } from 'node:crypto';
import { deleteChat } from '../../../server/chat-deletion.js';
import { createFixtureChat } from '../chat.js';
import { defineCommandSamples } from '../command-registry.js';
import { seedOutline } from '../outline.js';

export default defineCommandSamples({
  samples: {
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
  },
});
