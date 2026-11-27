import { allEndpoints } from '#contracts';
import { promptWorkspace } from '../../server/prompt-workspace.js';
import {
  combination,
  conflict,
  connection,
  deleted,
  domainCases,
  model,
  preset,
  read,
  removed,
  store,
} from './harness.js';

async function modelWorkspace() {
  return read<{ revision: number; routes: unknown; translationPolicy: unknown }>(
    allEndpoints.prompts.readModelWorkspace
  );
}

export const promptsCases = domainCases('prompts', {
  readTemplate: {
    exempt:
      'Prompt templates are built in and cannot be deleted, so no tab can hold a template that is gone.',
  },
  updateWorkspace: {
    cases: [
      {
        when: 'a stale revision with a prompt body the service refuses',
        arrange: async () => {
          const { revision } = await read<{ revision: number }>(allEndpoints.prompts.readWorkspace);
          return { input: { expectedRevision: revision + 1, main: 'not a prompt' } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  applyPreset: {
    cases: [
      {
        when: 'a preset another tab deleted',
        arrange: () => {
          const live = preset();
          const gone = preset();
          removed('prompt-preset', gone);
          const apply = { expectedRevision: promptWorkspace(store()).revision, role: 'main' };
          return {
            input: { ...apply, presetId: gone.id },
            control: { ...apply, presetId: live.id },
          };
        },
        answer: deleted,
      },
    ],
  },
  applyCombination: {
    cases: [
      {
        when: 'a combination another tab deleted',
        arrange: () => {
          const live = combination();
          const gone = combination();
          removed('prompt-combination', gone);
          const apply = { expectedRevision: promptWorkspace(store()).revision, role: 'main' };
          return {
            input: { ...apply, combinationId: gone.id },
            control: { ...apply, combinationId: live.id },
          };
        },
        answer: deleted,
      },
    ],
  },
  updateCombination: {
    cases: [
      {
        when: 'a combination another tab deleted',
        arrange: () => {
          const item = combination();
          return {
            input: {
              id: item.id,
              expectedRevision: removed('prompt-combination', item),
              sourceRevision: promptWorkspace(store()).revision,
              title: 'Edited',
              values: {},
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'the owning preset another tab deleted',
        arrange: () => {
          const liveOwner = preset();
          const live = combination(liveOwner);
          const owner = preset();
          const item = combination(owner);
          removed('prompt-preset', owner);
          const edit = { title: 'Edited', values: {} };
          return {
            input: {
              ...edit,
              id: item.id,
              expectedRevision: item.revision,
              sourceRevision: owner.revision,
            },
            control: {
              ...edit,
              id: live.id,
              expectedRevision: live.revision,
              sourceRevision: liveOwner.revision,
            },
          };
        },
        answer: conflict,
      },
    ],
  },
  updateModelWorkspace: {
    cases: [
      {
        when: 'a model another tab deleted',
        arrange: async () => {
          const live = model();
          const gone = model();
          removed('model', gone);
          const current = await modelWorkspace();
          const workspace = {
            expectedRevision: current.revision,
            translationPolicy: current.translationPolicy,
          };
          return {
            input: { ...workspace, routes: { main: { id: gone.id }, translation: null } },
            control: { ...workspace, routes: { main: { id: live.id }, translation: null } },
          };
        },
        answer: { status: 400, code: 'MODEL_SELECTION_UNAVAILABLE' },
        reason:
          'A model another tab deleted shares MODEL_SELECTION_UNAVAILABLE with a disabled model or connection: its text names both causes and asks for another model.',
      },
      {
        when: 'a judgment connection another tab deleted',
        arrange: async () => {
          const live = connection('https://api.openai.com/v1');
          const gone = connection('https://api.openai.com/v1');
          removed('connection', gone);
          const current = await modelWorkspace();
          const workspace = {
            expectedRevision: current.revision,
            routes: current.routes,
            translationPolicy: current.translationPolicy,
          };
          const judgment = (connectionId: string) => ({
            provider: 'openai',
            connectionId,
            modelId: 'gpt-6-luna',
            images: false,
          });
          return {
            input: { ...workspace, judgment: judgment(gone.id) },
            control: { ...workspace, judgment: judgment(live.id) },
          };
        },
        answer: deleted,
      },
    ],
  },
  updateLoreContextDefaults: {
    cases: [
      {
        when: 'a stale revision with a value the service refuses',
        arrange: async () => {
          const endpoints = allEndpoints.prompts;
          const { revision, ...policy } = await read<{ revision: number }>(
            endpoints.readLoreContextDefaults
          );
          await read(endpoints.updateLoreContextDefaults, {
            ...policy,
            expectedRevision: revision,
          });
          return { input: { ...policy, expectedRevision: revision, maxRetainedTokens: -1 } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
});
