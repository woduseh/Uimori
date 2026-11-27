import { randomUUID } from 'node:crypto';
import { conflict, domainCases, model, removed } from './harness.js';

const jevExemption =
  'The JEV key and settings are one singleton with no target to delete; the operation schema checks the whole input and the handler checks the revision before the stored key.';

export const providersCases = domainCases('providers', {
  saveJevKey: { exempt: jevExemption },
  deleteJevKey: { exempt: jevExemption },
  updateJevSettings: { exempt: jevExemption },
  startJevTest: { exempt: jevExemption },
  startModelTest: {
    cases: [
      {
        when: 'a model another tab deleted',
        arrange: () => {
          const item = model();
          return {
            input: {
              id: item.id,
              expectedRevision: removed('model', item),
              idempotencyKey: randomUUID(),
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  readConnectionTest: {
    exempt:
      'Connection test records are never deleted and their id comes from the answer that started the test, so no tab can hold one that is gone.',
  },
});
