import { saveResource } from '../../server/resource-service.js';
import { fixtureBotInput } from '../fixtures/chat.js';
import { bot, conflict, deleted, domainCases, purged, removed, store } from './harness.js';

const savedBot = () => {
  const item = bot();
  const { saved } = saveResource(store(), {
    kind: 'content',
    id: item.id,
    expectedRevision: item.revision,
    model: { ...fixtureBotInput('Stale tab bot, edited') },
  });
  return { id: item.id, saved: saved as { id: string; revision: number } };
};

export const resourceEditorsCases = domainCases('resourceEditors', {
  readResource: {
    cases: [
      {
        when: 'content another tab deleted',
        arrange: () => {
          const item = bot();
          removed('content', item);
          return { input: { kind: 'content', id: item.id } };
        },
        answer: deleted,
      },
    ],
  },
  readPreviousResource: {
    cases: [
      {
        when: 'content another tab deleted after a save',
        arrange: () => {
          const { id, saved } = savedBot();
          removed('content', saved);
          return { input: { kind: 'content', id } };
        },
        answer: deleted,
      },
    ],
  },
  saveResource: {
    cases: [
      {
        when: 'content another tab deleted',
        arrange: () => {
          const item = bot();
          return {
            input: {
              kind: 'content',
              id: item.id,
              expectedRevision: removed('content', item),
              model: {},
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  cloneResource: {
    cases: [
      {
        when: 'a source another tab deleted',
        arrange: () => {
          const item = bot();
          return {
            input: {
              kind: 'content',
              sourceId: item.id,
              expectedSourceRevision: removed('content', item),
              title: 'Copy',
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  undoResource: {
    cases: [
      {
        when: 'content another tab deleted and the cleanup purged after a save',
        arrange: () => {
          const { id, saved } = savedBot();
          purged('content', saved);
          return { input: { kind: 'content', id, expectedRevision: saved.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'content another tab deleted after a save',
        arrange: () => {
          const { id, saved } = savedBot();
          return { input: { kind: 'content', id, expectedRevision: removed('content', saved) } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
});
