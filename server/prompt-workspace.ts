import type { FastifyInstance } from 'fastify';
import type {
  CurrentPrompt,
  ModelWorkspace,
  PromptPreset,
  PromptRole,
  PromptWorkspace,
  ProfileSnapshot,
  SavedPromptCombination,
} from '../core/product.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { resolvePromptValues, validatePromptProgram } from '../core/prompt-program.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import { assertModelSelection } from './provider-selection.js';
import type { Store } from './store.js';

const roles = ['main', 'translation'] as const;
const roleValue = (value: unknown): PromptRole => {
  if (value !== 'main' && value !== 'translation') throw new HttpError(400, 'Invalid prompt role');
  return value;
};

export function validateCurrentPrompt(value: unknown, role: PromptRole): CurrentPrompt {
  const b = record(value);
  fields(b, ['title', 'program', 'values']);
  const program = validatePromptProgram(b.program);
  if (role !== 'main' && program.collaboration)
    throw new HttpError(400, 'Collaboration requires the main prompt');
  return {
    title: text(b.title, 'prompt title', 200),
    program,
    values: resolvePromptValues(program, record(b.values)),
  };
}

export function validatePromptWorkspace(value: unknown): PromptWorkspace {
  const b = record(value);
  fields(b, ['revision', 'main', 'translation', 'translationPolicy', 'modelRoutes']);
  const policy = record(b.translationPolicy);
  fields(policy, ['refusalModel', 'maxRetries', 'maxCalls']);
  let refusalModel = null;
  if (policy.refusalModel !== null) {
    const model = record(policy.refusalModel);
    fields(model, ['id']);
    refusalModel = { id: text(model.id, 'refusal model', 100) };
  }
  return {
    revision: number(b.revision, 'prompt workspace revision'),
    modelRoutes: validateModelRoutes(
      Object.hasOwn(b, 'modelRoutes') ? b.modelRoutes : emptyModelRoutes()
    ),
    main: validateCurrentPrompt(b.main, 'main'),
    translation: validateCurrentPrompt(b.translation, 'translation'),
    translationPolicy: {
      refusalModel,
      maxRetries: number(policy.maxRetries, 'translation automatic retries', 0, 5),
      maxCalls: number(policy.maxCalls, 'translation call limit', 2, 64),
    },
  };
}

export function defaultPromptWorkspace(): PromptWorkspace {
  return {
    revision: 1,
    modelRoutes: emptyModelRoutes(),
    main: {
      title: '현재 작문 프롬프트',
      program: createDefaultPromptProgram(DEFAULT_MAIN_PROMPT),
      values: {},
    },
    translation: {
      title: '현재 번역 프롬프트',
      program: createDefaultPromptProgram(DEFAULT_TRANSLATION_PROMPT, 'translation'),
      values: {},
    },
    translationPolicy: { refusalModel: null, maxRetries: 1, maxCalls: 16 },
  };
}

export function promptWorkspace(store: Store): PromptWorkspace {
  const row = store.db.prepare('SELECT body FROM prompt_workspace WHERE id=1').get() as {
    body: string;
  };
  const saved = JSON.parse(row.body) as PromptWorkspace;
  return {
    ...saved,
    modelRoutes: Object.hasOwn(saved, 'modelRoutes')
      ? validateModelRoutes(saved.modelRoutes)
      : emptyModelRoutes(),
  };
}

export function emptyModelRoutes(): ModelWorkspace['routes'] {
  return { main: null, translation: null, status: null, image: null };
}
function validateModelRoutes(value: unknown): ModelWorkspace['routes'] {
  const input = record(value);
  fields(input, ['main', 'translation', 'status', 'image']);
  return Object.fromEntries(
    Object.keys(emptyModelRoutes()).map((role) => {
      if (input[role] === null) return [role, null];
      const ref = record(input[role]);
      fields(ref, ['id']);
      return [role, { id: text(ref.id, 'model ID', 100) }];
    })
  ) as ModelWorkspace['routes'];
}
export function modelWorkspace(store: Store): ModelWorkspace {
  const current = promptWorkspace(store);
  return {
    revision: current.revision,
    routes: current.modelRoutes,
    translationPolicy: current.translationPolicy,
  };
}
export function updateModelWorkspace(store: Store, value: unknown): ModelWorkspace {
  const input = record(value);
  fields(input, ['expectedRevision', 'routes', 'translationPolicy']);
  return store.transaction(() => {
    const prior = promptWorkspace(store);
    if (prior.revision !== number(input.expectedRevision, 'model workspace revision'))
      throw new HttpError(409, '전역 설정이 변경됐어요. 새로고침한 뒤 저장해 주세요.');
    const next = validatePromptWorkspace({
      ...prior,
      modelRoutes: validateModelRoutes(input.routes),
      translationPolicy: input.translationPolicy,
      revision: prior.revision + 1,
    });
    for (const role of Object.keys(emptyModelRoutes()) as (keyof ModelWorkspace['routes'])[])
      assertModelSelection(store.product, next.modelRoutes[role], prior.modelRoutes[role]);
    assertModelSelection(
      store.product,
      next.translationPolicy.refusalModel,
      prior.translationPolicy.refusalModel
    );
    store.db.prepare('UPDATE prompt_workspace SET body=? WHERE id=1').run(JSON.stringify(next));
    for (const chat of store.chats()) store.event(chat.id, 'prompt-workspace.updated', chat.id);
    return modelWorkspace(store);
  });
}

export function updatePromptWorkspace(store: Store, value: unknown): PromptWorkspace {
  const b = record(value);
  fields(b, ['expectedRevision', 'main', 'translation', 'translationPolicy']);
  const expected = number(b.expectedRevision, 'prompt workspace revision');
  return store.transaction(() => {
    const prior = promptWorkspace(store);
    if (prior.revision !== expected)
      throw new HttpError(409, 'Current prompts changed; refresh before saving');
    const result = validatePromptWorkspace({
      ...prior,
      ...Object.fromEntries(
        roles.filter((role) => b[role] !== undefined).map((role) => [role, b[role]])
      ),
      ...(b.translationPolicy !== undefined ? { translationPolicy: b.translationPolicy } : {}),
      revision: prior.revision + 1,
    });
    // Selectors are current configuration. Frozen executions carry their own copies.
    if (result.translationPolicy.refusalModel) {
      store.product.assertAvailable('model', result.translationPolicy.refusalModel.id);
      store.product.get('model', result.translationPolicy.refusalModel.id);
    }
    for (const agent of result.main.program.collaboration?.agents ?? [])
      if (agent.model) {
        store.product.assertAvailable('model', agent.model.id);
        store.product.get('model', agent.model.id);
      }
    store.db.prepare('UPDATE prompt_workspace SET body=? WHERE id=1').run(JSON.stringify(result));
    for (const chat of store.chats()) store.event(chat.id, 'prompt-workspace.updated', chat.id);
    return result;
  });
}

/** IDs here identify a working slot and revision, not a retained preset dependency. */
export function freezeCurrentPrompts(
  workspace: PromptWorkspace
): Pick<
  ProfileSnapshot,
  'prompts' | 'promptPresets' | 'promptControls' | 'promptWorkspaceRevision'
> {
  const promptPresets: NonNullable<ProfileSnapshot['promptPresets']> = {};
  const prompts: NonNullable<ProfileSnapshot['prompts']> = {};
  const promptControls: NonNullable<ProfileSnapshot['promptControls']> = {};
  for (const role of roles) {
    const current = workspace[role];
    const preset = {
      ...structuredClone(current),
      id: `current-${role}`,
      revision: workspace.revision,
      role,
    };
    promptPresets[role] = preset;
    prompts[role] = { id: preset.id, revision: preset.revision };
    promptControls[`${preset.id}@${preset.revision}`] = {
      values: structuredClone(current.values),
      combinations: [],
    };
  }
  return { prompts, promptPresets, promptControls, promptWorkspaceRevision: workspace.revision };
}

export function promptWorkspaceRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  const publishResult = <T>(result: T): T => {
    for (const chat of store.chats()) publish(chat.id);
    return result;
  };
  app.get('/api/model-workspace', async () => modelWorkspace(store));
  app.put('/api/model-workspace', async (request) =>
    publishResult(updateModelWorkspace(store, request.body))
  );
  app.get('/api/prompt-workspace', async () => promptWorkspace(store));
  app.put('/api/prompt-workspace', { bodyLimit: 2_000_000 }, async (request) =>
    publishResult(updatePromptWorkspace(store, request.body))
  );
  app.post('/api/prompt-workspace/apply', async (request) => {
    const b = record(request.body);
    fields(b, ['expectedRevision', 'role', 'presetId']);
    const role = roleValue(b.role);
    store.product.assertAvailable('prompt-preset', text(b.presetId, 'preset', 100));
    const preset = store.product.get<PromptPreset>(
      'prompt-preset',
      text(b.presetId, 'preset', 100)
    );
    if (preset.role !== role) throw new HttpError(400, 'Prompt role mismatch');
    return publishResult(
      updatePromptWorkspace(store, {
        expectedRevision: b.expectedRevision,
        [role]: { title: preset.title, program: preset.program, values: preset.values ?? {} },
      })
    );
  });
  app.post('/api/prompt-workspace/apply-options', async (request) => {
    const b = record(request.body);
    fields(b, ['expectedRevision', 'role', 'combinationId']);
    const role = roleValue(b.role);
    store.product.assertAvailable(
      'prompt-combination',
      text(b.combinationId, 'option preset', 100)
    );
    const preset = store.product.get<SavedPromptCombination>(
      'prompt-combination',
      text(b.combinationId, 'option preset', 100)
    );
    if (preset.role !== role) throw new HttpError(400, 'Prompt role mismatch');
    const current = promptWorkspace(store)[role];
    return publishResult(
      updatePromptWorkspace(store, {
        expectedRevision: b.expectedRevision,
        [role]: { ...current, values: preset.values },
      })
    );
  });
}
