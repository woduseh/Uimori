import {
  bot,
  combination,
  conflict,
  connection,
  domainCases,
  model,
  preset,
  removed,
} from './harness.js';

const libraryDeletion = (
  [
    ['deleteContent', 'content', bot],
    ['deletePromptPreset', 'prompt-preset', preset],
    ['deletePromptCombination', 'prompt-combination', () => combination()],
    ['deleteConnection', 'connection', () => connection()],
    ['deleteModelPreset', 'model', model],
  ] as const
).map(([key, kind, create]) => [
  key,
  {
    cases: [
      {
        when: `a ${kind} another tab deleted`,
        arrange: () => {
          const item = create();
          return { input: { id: item.id, expectedRevision: removed(kind, item) } };
        },
        answer: conflict,
        targetRevision: true as const,
      },
    ],
  },
]);

export const deletionCases = domainCases('deletion', Object.fromEntries(libraryDeletion));
