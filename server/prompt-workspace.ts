import { promptOptionOwner } from '../core/chat-options.js';
import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_SUMMARY_LENGTH,
  SUMMARY_LENGTH_VALUES,
  type SummaryLengthSettings,
} from '../core/summary-length.js';
import { mainJudgmentThreshold } from '../core/main-judgment-settings.js';
import {
  DEFAULT_HELPER_TASK_TIMEOUT_MINUTES,
  MAX_HELPER_TASK_TIMEOUT_MINUTES,
} from '../core/helper.js';
import {
  DEFAULT_JUDGMENT_SELECTION,
  OFFICIAL_JUDGMENT_MODELS,
  MAX_JUDGMENT_PRICES,
  TYPESAFE_JUDGMENT_MODEL,
  isJudgmentConnection,
  judgmentPriceFor,
  judgmentPriceKey,
  judgmentPriceTarget,
  type JudgmentPriceEntry,
  type JudgmentPriceTarget,
  type JudgmentPricing,
  type JudgmentSelection,
} from '../core/judgment-settings.js';
import { validateJudgmentPricing } from '../core/model-pricing.js';
import type { FastifyInstance } from 'fastify';
import type { ReferenceSource } from './product-store.js';
import type {
  ChatProfile,
  Connection,
  ContentRef,
  CurrentPrompt,
  ModelWorkspace,
  PromptPreset,
  PromptRole,
  PromptWorkspace,
  ProfileSnapshot,
  SavedPromptCombination,
  PromptCombinationOwner,
} from '../core/product.js';
import { workspaceModelRef } from '../core/product.js';
import {
  translationPolicy,
  type TranslationPolicy,
  DEFAULT_TRANSLATION_JUDGMENT,
} from '../core/translation-settings.js';
import { builtinCurrentPrompt } from './builtin-prompts.js';
import {
  resolvePromptValues,
  validateRisuPrompt,
  validateEditableRisuPrompt,
  resolveEditablePromptValues,
  reconcilePromptValues,
} from '../core/risu-prompt.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import { assertModelSelection } from './provider-selection.js';
import type { Store } from './store.js';
import { promptCombinationRoutes } from './prompt-combinations.js';
import { recordPromptWorkspaceUpdate } from './prompt-workspace-events.js';
import { AppError, assertRevision } from './app-errors.js';
import {
  type ApplyPromptCombination,
  type ApplyPromptPreset,
  promptEndpoints,
  type UpdateModelWorkspace,
  type UpdatePromptWorkspace,
} from '#contracts';
import { promptOperations } from '#contracts/operations';
import { registerEndpoint } from './endpoint.js';

const roles = ['main', 'translation'] as const;
const roleValue = (value: unknown): PromptRole => {
  if (value !== 'main' && value !== 'translation') throw new HttpError(400, 'Invalid prompt role');
  return value;
};

export function validateCurrentPrompt(value: unknown, role: PromptRole): CurrentPrompt {
  const b = record(value);
  fields(b, [
    'title',
    'program',
    'values',
    'presetId',
    'presetRevision',
    'defaultValues',
    'optionValues',
  ]);
  const program = validateRisuPrompt(b.program);
  if (role !== 'main' && program.collaboration)
    throw new HttpError(400, 'Collaboration requires the main prompt');
  if (
    b.optionValues !== undefined &&
    Object.values(record(b.optionValues)).some(
      (value) => value !== null && !['string', 'number', 'boolean'].includes(typeof value)
    )
  )
    throw new HttpError(400, 'Invalid explicit prompt option value');
  return {
    ...(b.presetId !== undefined ? { presetId: text(b.presetId, 'prompt preset ID', 100) } : {}),
    ...(b.presetRevision !== undefined
      ? { presetRevision: number(b.presetRevision, 'prompt preset revision') }
      : {}),
    title: text(b.title, 'prompt title', 200),
    program,
    values: resolvePromptValues(program, record(b.values)),
    ...(b.optionValues !== undefined
      ? { optionValues: record(b.optionValues) as CurrentPrompt['values'] }
      : {}),
    ...(b.defaultValues !== undefined
      ? { defaultValues: reconcilePromptValues(program, record(b.defaultValues)).values }
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

function readJudgmentSelection(value: unknown): {
  selection: JudgmentSelection;
  pricing?: JudgmentPricing;
} {
  if (value === undefined) return { selection: DEFAULT_JUDGMENT_SELECTION };
  const input = record(value);
  const provider: unknown = input.provider;
  if (provider === 'typesafe') {
    fields(input, ['provider', 'pricing']);
    return { selection: { provider }, ...legacyJudgmentPricing(input, provider) };
  }
  if (
    provider !== 'openai' &&
    provider !== 'gemini' &&
    provider !== 'openai-compatible' &&
    provider !== 'typesafe-compatible'
  )
    throw new HttpError(400, 'JUDGMENT_PROVIDER_INVALID');
  fields(input, ['provider', 'connectionId', 'modelId', 'images', 'pricing']);
  const connectionId = text(input.connectionId, 'judgment connection ID', 100);
  const modelId = text(input.modelId, 'judgment model ID', 200).trim();
  if (
    (provider === 'openai' || provider === 'gemini') &&
    modelId !== OFFICIAL_JUDGMENT_MODELS[provider]
  )
    throw new HttpError(400, 'JUDGMENT_MODEL_INVALID');
  if (typeof input.images !== 'boolean') throw new HttpError(400, 'JUDGMENT_IMAGES_INVALID');
  return {
    selection: { provider, connectionId, modelId, images: input.images },
    ...legacyJudgmentPricing(input, provider),
  };
}
function validateJudgmentSelection(value: unknown): JudgmentSelection {
  return readJudgmentSelection(value).selection;
}
function legacyJudgmentPricing(
  input: Record<string, unknown>,
  provider: JudgmentSelection['provider']
): { pricing?: JudgmentPricing } {
  return input.pricing === undefined ? {} : { pricing: judgmentPrice(input.pricing, provider) };
}
function judgmentPrice(value: unknown, provider: JudgmentSelection['provider']) {
  try {
    return validateJudgmentPricing(value, provider);
  } catch {
    throw new HttpError(400, 'INVALID_MODEL_PRICING');
  }
}
export function validateJudgmentPriceTarget(value: unknown): JudgmentPriceTarget {
  const input = record(value);
  const provider: unknown = input.provider;
  if (provider === 'openai-compatible' || provider === 'typesafe-compatible') {
    fields(input, ['provider', 'modelId', 'connectionId']);
    return {
      provider,
      modelId: text(input.modelId, 'judgment model ID', 200).trim(),
      connectionId: text(input.connectionId, 'judgment connection ID', 100),
    };
  }
  fields(input, ['provider', 'modelId']);
  const modelId =
    provider === 'typesafe'
      ? TYPESAFE_JUDGMENT_MODEL
      : provider === 'openai' || provider === 'gemini'
        ? OFFICIAL_JUDGMENT_MODELS[provider]
        : undefined;
  if (!modelId) throw new HttpError(400, 'JUDGMENT_PROVIDER_INVALID');
  if (input.modelId !== modelId) throw new HttpError(400, 'JUDGMENT_MODEL_INVALID');
  return { provider: provider as JudgmentPriceTarget['provider'], modelId };
}
function validateJudgmentPrices(value: unknown): JudgmentPriceEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_JUDGMENT_PRICES)
    throw new HttpError(400, 'JUDGMENT_PRICING_INVALID');
  const keys = new Set<string>();
  return value.map((item) => {
    const { pricing, ...target } = record(item);
    const checked = validateJudgmentPriceTarget(target);
    const key = judgmentPriceKey(checked);
    if (keys.has(key)) throw new HttpError(400, 'JUDGMENT_PRICING_INVALID');
    keys.add(key);
    return { ...checked, pricing: judgmentPrice(pricing, checked.provider) };
  });
}
function readJudgmentSettings(judgment: unknown, prices: unknown) {
  const { selection, pricing } = readJudgmentSelection(judgment);
  const entries = validateJudgmentPrices(prices);
  const target = judgmentPriceTarget(selection);
  if (pricing && !judgmentPriceFor(entries, target)) {
    if (entries.length >= MAX_JUDGMENT_PRICES) throw new HttpError(400, 'JUDGMENT_PRICING_INVALID');
    entries.push({ ...target, pricing });
  }
  return { selection, prices: entries };
}
function validateSummaryLength(value: unknown): SummaryLengthSettings {
  if (value === undefined) return { ...DEFAULT_SUMMARY_LENGTH };
  const input = record(value);
  fields(input, ['conversation', 'helper']);
  if (
    !SUMMARY_LENGTH_VALUES.includes(input.conversation as never) ||
    !SUMMARY_LENGTH_VALUES.includes(input.helper as never)
  )
    throw new HttpError(400, 'SUMMARY_LENGTH_INVALID');
  return {
    conversation: input.conversation as SummaryLengthSettings['conversation'],
    helper: input.helper as SummaryLengthSettings['helper'],
  };
}

function validateHelperTaskTimeoutMinutes(value: unknown): number {
  return value === undefined
    ? DEFAULT_HELPER_TASK_TIMEOUT_MINUTES
    : number(value, 'helper task timeout in minutes', 1, MAX_HELPER_TASK_TIMEOUT_MINUTES);
}

export function validatePromptWorkspace(value: unknown): PromptWorkspace {
  const b = record(value);
  fields(b, [
    'revision',
    'main',
    'translation',
    'translationPolicy',
    'mainJudgmentEnabled',
    'mainJudgmentThreshold',
    'judgment',
    'judgmentPricing',
    'modelRoutes',
    'titleModel',
    'helperModel',
    'helperTaskTimeoutMinutes',
    'helperConfirmPaidGeneration',
    'mcpAllowDelete',
    'contextModel',
    'scriptModel',
    'summaryLength',
  ]);
  const policy = record(b.translationPolicy);
  let checkedPolicy: TranslationPolicy;
  try {
    checkedPolicy = translationPolicy({
      ...policy,
      judgment: policy.judgment as TranslationPolicy['judgment'],
      maxRetries: number(policy.maxRetries, 'translation automatic retries', 0, 5),
      maxCalls: number(policy.maxCalls, 'translation call limit', 2, 64),
    });
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'TRANSLATION_POLICY_INVALID');
  }
  if (b.mainJudgmentEnabled !== undefined && typeof b.mainJudgmentEnabled !== 'boolean')
    throw new HttpError(400, 'MAIN_JUDGMENT_ENABLED_INVALID');
  if (
    b.helperConfirmPaidGeneration !== undefined &&
    typeof b.helperConfirmPaidGeneration !== 'boolean'
  )
    throw new HttpError(400, 'HELPER_CONFIRM_PAID_GENERATION_INVALID');
  if (b.mcpAllowDelete !== undefined && typeof b.mcpAllowDelete !== 'boolean')
    throw new HttpError(400, 'MCP_ALLOW_DELETE_INVALID');
  const judgment = readJudgmentSettings(b.judgment, b.judgmentPricing);
  return {
    judgment: judgment.selection,
    judgmentPricing: judgment.prices,
    mainJudgmentThreshold: mainJudgmentThreshold(b.mainJudgmentThreshold),
    ...(b.mainJudgmentEnabled !== undefined
      ? { mainJudgmentEnabled: b.mainJudgmentEnabled as boolean }
      : {}),
    revision: number(b.revision, 'prompt workspace revision'),
    summaryLength: validateSummaryLength(b.summaryLength),
    titleModel: validateTitleModel(b.titleModel ?? null),
    helperModel: validateTitleModel(b.helperModel ?? null),
    helperTaskTimeoutMinutes: validateHelperTaskTimeoutMinutes(b.helperTaskTimeoutMinutes),
    ...(b.helperConfirmPaidGeneration === true ? { helperConfirmPaidGeneration: true } : {}),
    ...(b.mcpAllowDelete === true ? { mcpAllowDelete: true } : {}),
    contextModel: validateTitleModel(b.contextModel ?? null),
    scriptModel: validateTitleModel(b.scriptModel ?? null),
    modelRoutes: validateModelRoutes(
      Object.hasOwn(b, 'modelRoutes') ? b.modelRoutes : emptyModelRoutes()
    ),
    main: validateCurrentPrompt(b.main, 'main'),
    translation: validateCurrentPrompt(b.translation, 'translation'),
    translationPolicy: checkedPolicy,
  };
}

export function defaultPromptWorkspace(): PromptWorkspace {
  return {
    judgment: DEFAULT_JUDGMENT_SELECTION,
    revision: 1,
    summaryLength: { ...DEFAULT_SUMMARY_LENGTH },
    titleModel: null,
    helperModel: null,
    helperTaskTimeoutMinutes: DEFAULT_HELPER_TASK_TIMEOUT_MINUTES,
    contextModel: null,
    scriptModel: null,
    modelRoutes: emptyModelRoutes(),
    main: builtinCurrentPrompt('main'),
    translation: builtinCurrentPrompt('translation'),
    translationPolicy: {
      judgment: { ...DEFAULT_TRANSLATION_JUDGMENT, enabled: false },
      retryProviderRefusal: true,
      previousSceneTokens: 2048,
      maxRetries: 1,
      maxCalls: 16,
    },
  };
}

type PromptSelection = { presetId: string; values: CurrentPrompt['values'] };
type StoredPromptWorkspace = Omit<PromptWorkspace, 'main' | 'translation'> & {
  main: PromptSelection | CurrentPrompt;
  translation: PromptSelection | CurrentPrompt;
};

function savedWorkspace(store: Store): StoredPromptWorkspace {
  const row = store.db.prepare('SELECT body FROM prompt_workspace WHERE id=1').get() as {
    body: string;
  };
  return JSON.parse(row.body) as StoredPromptWorkspace;
}

export function judgmentSelection(store: Store): JudgmentSelection {
  return validateJudgmentSelection(savedWorkspace(store).judgment);
}

export function judgmentSettings(store: Store) {
  const saved = savedWorkspace(store);
  return readJudgmentSettings(saved.judgment, saved.judgmentPricing);
}

export function initializePromptWorkspaceReferences(store: Store): void {
  const saved = savedWorkspace(store);
  if (!roles.some((role) => 'program' in saved[role])) return;
  store.transaction(() => {
    validatePromptWorkspace({
      ...saved,
      ...Object.fromEntries(
        roles.map((role) => [
          role,
          'program' in saved[role] ? saved[role] : resolveSelection(store, saved[role], role),
        ])
      ),
    });
    for (const role of roles) {
      const current = saved[role];
      if (!('program' in current)) continue;
      let source: PromptPreset | undefined;
      if (current.presetId) {
        try {
          const candidate = store.product.available<PromptPreset>(
            'prompt-preset',
            current.presetId
          );
          if (
            candidate.role === role &&
            candidate.title === current.title &&
            isDeepStrictEqual(candidate.program, current.program)
          )
            source = candidate;
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
        }
      }
      source ??= store.product.saveInTransaction('prompt-preset', {
        title: current.title,
        role,
        program: structuredClone(current.program),
        values: resolvePromptValues(current.program, current.defaultValues ?? current.values),
      }) as PromptPreset;
      const oldDefaults = current.defaultValues
        ? resolvePromptValues(current.program, current.defaultValues)
        : undefined;
      const explicit =
        current.optionValues ??
        (oldDefaults
          ? Object.fromEntries(
              Object.entries(current.values).filter(
                ([id, value]) => !isDeepStrictEqual(value, oldDefaults[id])
              )
            )
          : current.values);
      saved[role] = { presetId: source.id, values: structuredClone(explicit) };
      for (const combo of store.product.all('prompt-combination') as SavedPromptCombination[]) {
        if (combo.role !== role || combo.owner.kind !== 'workspace' || combo.owner.role !== role)
          continue;
        const { id, revision, ...body } = combo;
        store.product.saveInTransaction(
          'prompt-combination',
          { ...body, owner: { kind: 'preset', id: source.id } },
          id,
          revision
        );
      }
    }
    store.db.prepare('UPDATE prompt_workspace SET body=? WHERE id=1').run(JSON.stringify(saved));
  });
}

function resolveSelection(
  store: Store,
  selection: PromptSelection | CurrentPrompt,
  role: PromptRole
): CurrentPrompt {
  if (!selection.presetId) throw new HttpError(409, 'PROMPT_SOURCE_REQUIRED');
  const preset = store.product.available<PromptPreset>('prompt-preset', selection.presetId);
  if (preset.role !== role) throw new HttpError(409, 'Prompt role mismatch');
  const defaultValues = resolvePromptValues(preset.program, preset.values ?? {});
  const reconciled = reconcilePromptValues(preset.program, selection.values);
  const compatible = Object.fromEntries(
    Object.entries(selection.values).filter(([id]) => !reconciled.resetKeys.includes(id))
  );
  return {
    presetId: preset.id,
    presetRevision: preset.revision,
    title: preset.title,
    program: structuredClone(preset.program),
    values: { ...defaultValues, ...compatible },
    defaultValues,
    optionValues: structuredClone(selection.values),
  };
}

export function savePromptWorkspace(store: Store, workspace: PromptWorkspace): void {
  const saved = {
    ...workspace,
    ...Object.fromEntries(
      roles.map((role) => [
        role,
        {
          presetId: workspace[role].presetId,
          values: workspace[role].optionValues ?? workspace[role].values,
        },
      ])
    ),
  };
  store.db.prepare('UPDATE prompt_workspace SET body=? WHERE id=1').run(JSON.stringify(saved));
}

export function promptWorkspace(store: Store): PromptWorkspace {
  const saved = savedWorkspace(store);
  const judgment = readJudgmentSettings(saved.judgment, saved.judgmentPricing);
  return {
    ...saved,
    judgment: judgment.selection,
    judgmentPricing: judgment.prices,
    summaryLength: validateSummaryLength(saved.summaryLength),
    main: resolveSelection(store, saved.main, 'main'),
    translation: resolveSelection(store, saved.translation, 'translation'),
    titleModel: validateTitleModel(saved.titleModel ?? null),
    helperModel: validateTitleModel(saved.helperModel ?? null),
    helperTaskTimeoutMinutes: validateHelperTaskTimeoutMinutes(saved.helperTaskTimeoutMinutes),
    contextModel: validateTitleModel(saved.contextModel ?? null),
    scriptModel: validateTitleModel(saved.scriptModel ?? null),
    modelRoutes: Object.hasOwn(saved, 'modelRoutes')
      ? validateModelRoutes(saved.modelRoutes)
      : emptyModelRoutes(),
  };
}

export function currentModelRoutes(store: Store): ModelWorkspace['routes'] {
  const row = store.db
    .prepare(
      "SELECT json_type(body,'$.modelRoutes') AS type,json_extract(body,'$.modelRoutes') AS routes FROM prompt_workspace WHERE id=1"
    )
    .get() as { type: string | null; routes: string | null };
  return row.type === null
    ? emptyModelRoutes()
    : validateModelRoutes(JSON.parse(row.routes ?? 'null'));
}

type ChatPromptWorkspace = PromptWorkspace & { pinnedMainPreset?: ContentRef };

export function chatPromptWorkspace(
  store: Store,
  pinned: ChatProfile['pinned'],
  source: ReferenceSource = 'library'
): ChatPromptWorkspace {
  const workspace: ChatPromptWorkspace = promptWorkspace(store);
  if (pinned?.mainModel) workspace.modelRoutes.main = structuredClone(pinned.mainModel);
  if (pinned?.mainPromptPresetId) {
    let preset: PromptPreset;
    try {
      preset = store.product.reference<PromptPreset>(
        source,
        'prompt-preset',
        pinned.mainPromptPresetId
      );
      if (preset.role !== 'main')
        throw new HttpError(400, 'The pinned prompt is not a main prompt');
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new AppError(409, 'PINNED_PROMPT_UNAVAILABLE');
    }
    const values = resolvePromptValues(preset.program, preset.values ?? {});
    workspace.main = {
      presetId: preset.id,
      presetRevision: preset.revision,
      title: preset.title,
      program: structuredClone(preset.program),
      values,
      defaultValues: structuredClone(values),
      optionValues: {},
    };
    workspace.pinnedMainPreset = { id: preset.id, revision: preset.revision };
  }
  return workspace;
}

export function emptyModelRoutes(): ModelWorkspace['routes'] {
  return { main: null, translation: null };
}
function validateTitleModel(value: unknown): ModelWorkspace['titleModel'] {
  if (value === null) return null;
  const ref = record(value);
  fields(ref, ['id']);
  return { id: text(ref.id, 'title model ID', 100) };
}
function validateModelRoutes(value: unknown): ModelWorkspace['routes'] {
  const input = record(value);
  fields(input, ['main', 'translation', 'status']);
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
    judgment: current.judgment,
    judgmentPricing: current.judgmentPricing ?? [],
    mainJudgmentEnabled: current.mainJudgmentEnabled === true,
    mainJudgmentThreshold: mainJudgmentThreshold(current.mainJudgmentThreshold),
    revision: current.revision,
    summaryLength: validateSummaryLength(current.summaryLength),
    titleModel: workspaceModelRef(current, 'title'),
    helperModel: workspaceModelRef(current, 'helper'),
    helperTaskTimeoutMinutes: current.helperTaskTimeoutMinutes,
    helperConfirmPaidGeneration: current.helperConfirmPaidGeneration === true,
    mcpAllowDelete: current.mcpAllowDelete === true,
    contextModel: workspaceModelRef(current, 'context'),
    scriptModel: workspaceModelRef(current, 'script'),
    routes: current.modelRoutes,
    translationPolicy: current.translationPolicy,
  };
}
export function mcpDeleteAllowed(store: Store): boolean {
  return (
    store.db
      .prepare(
        "SELECT json_type(body,'$.mcpAllowDelete') AS allowed FROM prompt_workspace WHERE id=1"
      )
      .get()?.allowed === 'true'
  );
}
export function updateModelWorkspace(store: Store, input: UpdateModelWorkspace): ModelWorkspace {
  return store.transaction(() => {
    const prior = promptWorkspace(store);
    assertRevision(prior.revision, input.expectedRevision);
    const next = validatePromptWorkspace({
      ...prior,
      ...(Object.hasOwn(input, 'judgment') ? { judgment: input.judgment } : {}),
      ...(Object.hasOwn(input, 'judgmentPricing')
        ? { judgmentPricing: input.judgmentPricing }
        : {}),
      titleModel: Object.hasOwn(input, 'titleModel')
        ? (input.titleModel ?? null)
        : (prior.titleModel ?? null),
      helperModel: Object.hasOwn(input, 'helperModel')
        ? (input.helperModel ?? null)
        : (prior.helperModel ?? null),
      helperTaskTimeoutMinutes: Object.hasOwn(input, 'helperTaskTimeoutMinutes')
        ? input.helperTaskTimeoutMinutes
        : prior.helperTaskTimeoutMinutes,
      helperConfirmPaidGeneration: Object.hasOwn(input, 'helperConfirmPaidGeneration')
        ? input.helperConfirmPaidGeneration
        : prior.helperConfirmPaidGeneration,
      mcpAllowDelete: Object.hasOwn(input, 'mcpAllowDelete')
        ? input.mcpAllowDelete
        : prior.mcpAllowDelete,
      contextModel: Object.hasOwn(input, 'contextModel')
        ? (input.contextModel ?? null)
        : (prior.contextModel ?? null),
      scriptModel: Object.hasOwn(input, 'scriptModel')
        ? (input.scriptModel ?? null)
        : (prior.scriptModel ?? null),
      modelRoutes: input.routes,
      summaryLength: Object.hasOwn(input, 'summaryLength')
        ? validateSummaryLength(input.summaryLength)
        : validateSummaryLength(prior.summaryLength),
      translationPolicy: input.translationPolicy,
      ...(Object.hasOwn(input, 'mainJudgmentThreshold')
        ? { mainJudgmentThreshold: input.mainJudgmentThreshold }
        : {}),
      ...(Object.hasOwn(input, 'mainJudgmentEnabled')
        ? { mainJudgmentEnabled: input.mainJudgmentEnabled }
        : {}),
      revision: prior.revision + 1,
    });
    for (const role of Object.keys(emptyModelRoutes()) as (keyof ModelWorkspace['routes'])[])
      assertModelSelection(store.product, next.modelRoutes[role], prior.modelRoutes[role]);
    assertModelSelection(store.product, next.titleModel ?? null, prior.titleModel ?? null);
    assertModelSelection(store.product, next.helperModel ?? null, prior.helperModel ?? null);
    assertModelSelection(store.product, next.contextModel ?? null, prior.contextModel ?? null);
    assertModelSelection(store.product, next.scriptModel ?? null, prior.scriptModel ?? null);
    const judgment = next.judgment;
    if (
      judgment &&
      judgment.provider !== 'typesafe' &&
      !isDeepStrictEqual(judgment, prior.judgment)
    ) {
      const connection = store.product.available<Connection>('connection', judgment.connectionId);
      if (!isJudgmentConnection(judgment.provider, connection))
        throw new HttpError(400, 'JUDGMENT_CONNECTION_INVALID');
    }

    next.judgmentPricing = next.judgmentPricing?.filter(
      (entry) => !entry.connectionId || store.product.isLive('connection', entry.connectionId)
    );
    savePromptWorkspace(store, next);
    recordPromptWorkspaceUpdate(store.db);
    return modelWorkspace(store);
  });
}

export function updatePromptWorkspace(
  store: Store,
  b: UpdatePromptWorkspace,
  appliedPreset?: { role: PromptRole; id: string },
  inTransaction = false
): PromptWorkspace {
  const apply = () => {
    const prior = promptWorkspace(store);
    assertRevision(prior.revision, b.expectedRevision);
    const updates = Object.fromEntries(
      roles
        .filter((role) => b[role] !== undefined)
        .map((role) => {
          const incoming = validateCurrentPrompt(b[role], role);
          incoming.program = validateEditableRisuPrompt(incoming.program);
          incoming.values = resolveEditablePromptValues(incoming.program, incoming.values);
          if (incoming.presetId !== undefined && incoming.presetId !== prior[role].presetId)
            throw new HttpError(400, 'Prompt preset source can only change when applying a preset');
          const applying = appliedPreset?.role === role;
          const presetId = applying ? appliedPreset.id : prior[role].presetId;
          if (
            !applying &&
            incoming.presetRevision !== undefined &&
            incoming.presetRevision !== prior[role].presetRevision
          )
            throw new AppError(409, 'REVISION_CONFLICT');
          if (
            !applying &&
            (!isDeepStrictEqual(incoming.program, prior[role].program) ||
              incoming.title !== prior[role].title)
          ) {
            store.product.promptPreset(
              {
                title: incoming.title,
                role,
                program: incoming.program,
                values: reconcilePromptValues(incoming.program, prior[role].defaultValues).values,
                expectedRevision: prior[role].presetRevision,
              },
              presetId,
              true
            );
          }
          const raw = record(b[role]);
          const overrides =
            applying || Object.keys(record(raw.values)).length === 0
              ? {}
              : Object.hasOwn(raw, 'optionValues') &&
                  !isDeepStrictEqual(incoming.optionValues, prior[role].optionValues)
                ? incoming.optionValues!
                : {
                    ...prior[role].optionValues,
                    ...Object.fromEntries(
                      Object.entries(incoming.values).filter(
                        ([id, value]) => !isDeepStrictEqual(value, prior[role].values[id])
                      )
                    ),
                  };
          const next = resolveSelection(store, { presetId: presetId!, values: overrides }, role);
          return [role, next];
        })
    );
    const result = validatePromptWorkspace({
      ...prior,
      ...updates,
      ...(Object.hasOwn(b, 'mainJudgmentThreshold')
        ? { mainJudgmentThreshold: b.mainJudgmentThreshold }
        : {}),
      ...(b.translationPolicy !== undefined ? { translationPolicy: b.translationPolicy } : {}),
      ...(Object.hasOwn(b, 'mainJudgmentEnabled')
        ? { mainJudgmentEnabled: b.mainJudgmentEnabled }
        : {}),
      revision: prior.revision + 1,
    });
    const priorAgents = prior.main.program.collaboration?.agents ?? [];
    for (const agent of result.main.program.collaboration?.agents ?? [])
      assertModelSelection(
        store.product,
        agent.model,
        priorAgents.find((item) => item.id === agent.id)?.model
      );
    savePromptWorkspace(store, result);
    recordPromptWorkspaceUpdate(store.db);
    return result;
  };
  return inTransaction ? apply() : store.transaction(apply);
}

export function freezeCurrentPrompts(
  workspace: ChatPromptWorkspace
): Pick<
  ProfileSnapshot,
  'prompts' | 'promptPresets' | 'promptControls' | 'promptWorkspaceRevision' | 'promptOptionOwner'
> {
  const promptPresets: NonNullable<ProfileSnapshot['promptPresets']> = {};
  const prompts: NonNullable<ProfileSnapshot['prompts']> = {};
  const promptControls: NonNullable<ProfileSnapshot['promptControls']> = {};
  for (const role of roles) {
    const {
      presetId: _presetId,
      presetRevision: _presetRevision,
      optionValues: _optionValues,
      defaultValues: _defaultValues,
      ...current
    } = workspace[role];
    const preset = {
      ...structuredClone(current),
      id:
        role === 'main'
          ? (workspace.pinnedMainPreset?.id ?? 'current-main')
          : 'current-translation',
      revision:
        role === 'main'
          ? (workspace.pinnedMainPreset?.revision ?? workspace.revision)
          : workspace.revision,
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
    promptOptionOwner: promptOptionOwner(workspace.main),
  };
}

export function applyWorkspacePromptPreset(
  store: Store,
  { expectedRevision, role, presetId }: ApplyPromptPreset
) {
  return store.transaction(() => {
    assertRevision(promptWorkspace(store).revision, expectedRevision);
    const preset = store.product.available<PromptPreset>('prompt-preset', presetId);
    if (preset.role !== role) throw new HttpError(400, 'Prompt role mismatch');
    return updatePromptWorkspace(
      store,
      {
        expectedRevision,
        [role]: {
          title: preset.title,
          program: preset.program,
          values: preset.values ?? {},
          defaultValues: resolvePromptValues(preset.program, preset.values ?? {}),
        },
      },
      { role, id: preset.id },
      true
    );
  });
}

export function promptWorkspaceRoutes(app: FastifyInstance, store: Store, publishAll: () => void) {
  promptCombinationRoutes(app, store, () => promptWorkspace(store));
  const publishResult = <T>(result: T): T => {
    publishAll();
    return result;
  };
  const endpoints = promptEndpoints,
    operations = promptOperations;
  registerEndpoint(app, endpoints.readModelWorkspace, operations.readModelWorkspace, () =>
    modelWorkspace(store)
  );
  registerEndpoint(app, endpoints.updateModelWorkspace, operations.updateModelWorkspace, (input) =>
    publishResult(updateModelWorkspace(store, input))
  );
  registerEndpoint(app, endpoints.readWorkspace, operations.readWorkspace, () =>
    promptWorkspace(store)
  );
  registerEndpoint(app, endpoints.updateWorkspace, operations.updateWorkspace, (input) =>
    publishResult(updatePromptWorkspace(store, input))
  );
  registerEndpoint(app, endpoints.applyPreset, operations.applyPreset, (input) =>
    publishResult(applyWorkspacePromptPreset(store, input))
  );
  registerEndpoint(app, endpoints.applyCombination, operations.applyCombination, (input) =>
    publishResult(applyPromptCombination(store, input))
  );
}

export function applyPromptCombination(
  store: Store,
  { expectedRevision, role, combinationId }: ApplyPromptCombination
) {
  return store.transaction(() => {
    const workspace = promptWorkspace(store);
    assertRevision(workspace.revision, expectedRevision);
    const preset = store.product.available<SavedPromptCombination>(
      'prompt-combination',
      combinationId
    );
    if (preset.role !== role) throw new HttpError(400, 'Prompt role mismatch');
    const current = workspace[role];
    if (!matchesPromptCombination(preset, combinationOwner(current, role), role, current.program))
      throw new AppError(409, 'PROMPT_COMBINATION_MISMATCH');
    return updatePromptWorkspace(
      store,
      {
        expectedRevision,
        [role]: { ...current, values: preset.values, optionValues: preset.values },
      },
      undefined,
      true
    );
  });
}
