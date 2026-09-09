import type { FastifyInstance } from 'fastify';
import type {
  CurrentPrompt,
  ModelWorkspace,
  PromptPreset,
  PromptRole,
  PromptWorkspace,
  ProfileSnapshot,
  SavedPromptCombination,
  PromptCombinationOwner,
} from '../core/product.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import {
  resolvePromptValues,
  validatePromptProgram,
  validateEditablePromptProgram,
  resolveEditablePromptValues,
} from '../core/prompt-program.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
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
  fields(b, ['title', 'program', 'values', 'presetId', 'defaultValues']);
  const program = validatePromptProgram(b.program);
  if (role !== 'main' && program.collaboration)
    throw new HttpError(400, 'Collaboration requires the main prompt');
  return {
    ...(b.presetId !== undefined ? { presetId: text(b.presetId, 'prompt preset ID', 100) } : {}),
    title: text(b.title, 'prompt title', 200),
    program,
    values: resolvePromptValues(program, record(b.values)),
    ...(b.defaultValues !== undefined
      ? { defaultValues: resolvePromptValues(program, record(b.defaultValues)) }
      : {}),
  };
}

export function validateCombinationOwner(value: unknown): PromptCombinationOwner {
  const b = record(value);
  if (b.kind === 'preset') {
    fields(b, ['kind', 'id']);
    return { kind: 'preset', id: text(b.id, 'prompt preset ID', 100) };
  }
  fields(b, ['kind', 'role']);
  if (b.kind !== 'workspace') throw new HttpError(400, 'Invalid prompt combination owner');
  return { kind: 'workspace', role: roleValue(b.role) };
}

export function validatePromptWorkspace(value: unknown): PromptWorkspace {
  const b = record(value);
  fields(b, [
    'revision',
    'main',
    'translation',
    'translationPolicy',
    'modelRoutes',
    'titleModel',
    'helperModel',
    'contextModel',
  ]);
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
    titleModel: validateTitleModel(b.titleModel ?? null),
    helperModel: validateTitleModel(b.helperModel ?? null),
    contextModel: validateTitleModel(b.contextModel ?? null),
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
    titleModel: null,
    helperModel: null,
    contextModel: null,
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
    titleModel: validateTitleModel(saved.titleModel ?? null),
    helperModel: validateTitleModel(saved.helperModel ?? null),
    contextModel: validateTitleModel(saved.contextModel ?? null),
    modelRoutes: Object.hasOwn(saved, 'modelRoutes')
      ? validateModelRoutes(saved.modelRoutes)
      : emptyModelRoutes(),
  };
}

export function emptyModelRoutes(): ModelWorkspace['routes'] {
  return { main: null, translation: null, status: null, image: null };
}
function validateTitleModel(value: unknown): ModelWorkspace['titleModel'] {
  if (value === null) return null;
  const ref = record(value);
  fields(ref, ['id']);
  return { id: text(ref.id, 'title model ID', 100) };
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
    titleModel: current.titleModel ?? null,
    helperModel: current.helperModel ?? null,
    contextModel: current.contextModel ?? null,
    routes: current.modelRoutes,
    translationPolicy: current.translationPolicy,
  };
}
export function updateModelWorkspace(store: Store, value: unknown): ModelWorkspace {
  const input = record(value);
  fields(input, [
    'expectedRevision',
    'routes',
    'translationPolicy',
    'titleModel',
    'helperModel',
    'contextModel',
  ]);
  return store.transaction(() => {
    const prior = promptWorkspace(store);
    if (prior.revision !== number(input.expectedRevision, 'model workspace revision'))
      throw new HttpError(409, '전역 설정이 변경됐어요. 새로고침한 뒤 저장해 주세요.');
    const next = validatePromptWorkspace({
      ...prior,
      titleModel: Object.hasOwn(input, 'titleModel')
        ? validateTitleModel(input.titleModel)
        : (prior.titleModel ?? null),
      helperModel: Object.hasOwn(input, 'helperModel')
        ? validateTitleModel(input.helperModel)
        : (prior.helperModel ?? null),
      contextModel: Object.hasOwn(input, 'contextModel')
        ? validateTitleModel(input.contextModel)
        : (prior.contextModel ?? null),
      modelRoutes: validateModelRoutes(input.routes),
      translationPolicy: input.translationPolicy,
      revision: prior.revision + 1,
    });
    for (const role of Object.keys(emptyModelRoutes()) as (keyof ModelWorkspace['routes'])[])
      assertModelSelection(store.product, next.modelRoutes[role], prior.modelRoutes[role]);
    assertModelSelection(store.product, next.titleModel ?? null, prior.titleModel ?? null);
    assertModelSelection(store.product, next.helperModel ?? null, prior.helperModel ?? null);
    assertModelSelection(store.product, next.contextModel ?? null, prior.contextModel ?? null);
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

export function updatePromptWorkspace(
  store: Store,
  value: unknown,
  appliedPreset?: { role: PromptRole; id: string },
  inTransaction = false
): PromptWorkspace {
  const b = record(value);
  fields(b, ['expectedRevision', 'main', 'translation', 'translationPolicy']);
  const expected = number(b.expectedRevision, 'prompt workspace revision');
  const apply = () => {
    const prior = promptWorkspace(store);
    if (prior.revision !== expected)
      throw new HttpError(409, 'Current prompts changed; refresh before saving');
    const updates = Object.fromEntries(
      roles
        .filter((role) => b[role] !== undefined)
        .map((role) => {
          const incoming = validateCurrentPrompt(b[role], role);
          incoming.program = validateEditablePromptProgram(incoming.program);
          incoming.values = resolveEditablePromptValues(incoming.program, incoming.values);
          if (incoming.presetId !== undefined && incoming.presetId !== prior[role].presetId)
            throw new HttpError(400, 'Prompt preset source can only change when applying a preset');
          const presetId = appliedPreset?.role === role ? appliedPreset.id : prior[role].presetId;
          return [role, { ...incoming, ...(presetId ? { presetId } : {}) }];
        })
    );
    const result = validatePromptWorkspace({
      ...prior,
      ...updates,
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
  };
  return inTransaction ? apply() : store.transaction(apply);
}

/** IDs here identify a working slot and revision, not a retained preset dependency. */
export function freezeCurrentPrompts(
  workspace: PromptWorkspace
): Pick<
  ProfileSnapshot,
  'prompts' | 'promptPresets' | 'promptControls' | 'promptWorkspaceRevision' | 'promptOptionOwner'
> {
  const promptPresets: NonNullable<ProfileSnapshot['promptPresets']> = {};
  const prompts: NonNullable<ProfileSnapshot['prompts']> = {};
  const promptControls: NonNullable<ProfileSnapshot['promptControls']> = {};
  for (const role of roles) {
    const { presetId: _presetId, defaultValues: _defaultValues, ...current } = workspace[role];
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
  return {
    prompts,
    promptPresets,
    promptControls,
    promptWorkspaceRevision: workspace.revision,
    promptOptionOwner: workspace.main.presetId
      ? `preset:${workspace.main.presetId}`
      : 'workspace:main',
  };
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
      updatePromptWorkspace(
        store,
        {
          expectedRevision: b.expectedRevision,
          [role]: {
            title: preset.title,
            program: preset.program,
            values: preset.values ?? {},
            defaultValues: resolvePromptValues(preset.program, preset.values ?? {}),
          },
        },
        { role, id: preset.id }
      )
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
    if (!matchesPromptCombination(preset, combinationOwner(current, role), role, current.program))
      throw new HttpError(409, '이 프롬프트의 옵션 조합이 아니거나 옵션 정의가 변경됐어요.');
    return publishResult(
      updatePromptWorkspace(store, {
        expectedRevision: b.expectedRevision,
        [role]: { ...current, values: preset.values },
      })
    );
  });
}
