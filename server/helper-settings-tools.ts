import { HELPER_PRICING_TOOLS, invokeHelperPricingTool } from './helper-pricing-tools.js';
import {
  HELPER_MODEL_PARAMETER_TOOLS,
  invokeHelperModelParameterTool,
} from './helper-model-parameter-tools.js';
import type { Json, ProviderTool } from '../core/transport.js';
import type { Settings } from '../core/types.js';
import {
  MAX_MAIN_MODEL_CALLS,
  normalizeChatSettings,
  type ChatGenerationDefaults,
} from '../core/chat-settings.js';
import { chatGenerationDefaults, saveChatGenerationDefaults } from './chat-generation-defaults.js';
import { isStoryUiThemeSetting, storyUiStyles } from '../core/story-ui-style.js';
import type { Connection, ModelPreset, WorkspaceModelRole } from '../core/product.js';
import { workspaceModelRef } from '../core/product.js';
import {
  applyWorkspacePromptPreset,
  chatPromptWorkspace,
  modelWorkspace,
  promptWorkspace,
  updateModelWorkspace,
} from './prompt-workspace.js';
import {
  autoTranslationDefaults,
  saveAutoTranslationDefaults,
} from './auto-translation-defaults.js';
import { loreContextDefaults, updateLoreContextDefaults } from './lore-context-defaults.js';
import { deleteLibraryItem } from './library-deletion.js';
import { modelInUse } from './helper-model-usage.js';
import { WRITTEN_LANGUAGES } from '../core/written-language.js';
import {
  illustrationPresetPreferences,
  readIllustrationPreset,
  selectIllustrationPreset,
} from './illustration-presets.js';
import { HelperToolError } from './app-errors.js';
import { choice, fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { USAGE_BREAKDOWNS, usageReport } from './usage-report.js';
import {
  personalWorkspaceOperations,
  promptOperations,
  translationOperations,
} from '#contracts/operations';
import { parseInput } from './endpoint.js';
import { isDeepStrictEqual } from 'node:util';
import type { HelperTask, HelperTaskResultTarget } from '../core/helper.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import { readTheme } from './themes.js';
import { resolveModelPricing } from '../core/model-pricing.js';
import { parseVertexEndpoint } from '../core/vertex-location.js';
import { savedModelParameters } from './helper-model-parameter-tools.js';

const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const modelRoles = ['main', 'translation', 'helper', 'context', 'script', 'title'] as const;
const promptPresetSettings = ['global.mainPromptPreset', 'global.translationPromptPreset'];
const autoTranslationSettings = ['global.autoTranslate', 'global.translationLanguage'];
const settings = [
  ...modelRoles.map((role) => `global.${role}Model`),
  ...promptPresetSettings,
  ...autoTranslationSettings,
  'chat.mainModel',
  'chat.mainPromptPreset',
  'chat.maxCalls',
  'chat.storyUi',
  'chat.storyUiStyle',
  'newChat.maxCalls',
  'newChat.storyUi',
  'newChat.storyUiStyle',
  'newChat.autoRefusalRetryEnabled',
  'newChat.autoRefusalMaxRetries',
  'newChat.loreContext',
] as const;
const DEFAULT_REGISTERED_MAX_OUTPUT_TOKENS = 8192;
const CONNECTION_CATALOG_LIST_MAX = 200;
const SETTINGS_UPDATE_BATCH_MAX = 20;
const settingChange: Record<string, Json> = {
  setting: {
    type: 'string',
    enum: [...settings],
    description: 'The setting to change.',
  },
  expectedRevision: {
    type: 'integer',
    minimum: 0,
    description:
      'Revision from settings.read for the group being changed: global.revision for global.*Model and global.*PromptPreset; autoTranslation.revision for global.autoTranslate and global.translationLanguage; chat.profileRevision for chat.mainModel and chat.mainPromptPreset; chat.settingsRevision for chat.maxCalls, chat.storyUi and chat.storyUiStyle; loreContextDefaults.revision for newChat.loreContext; newChat.revision for the other newChat.* settings.',
  },
  value: {
    type: ['string', 'integer', 'boolean', 'null', 'object'],
    description: `New value. Model and prompt preset settings take a saved id; a model or a chat's prompt preset takes null to clear the choice, while a global prompt preset cannot be cleared. maxCalls takes an integer from 1 to ${MAX_MAIN_MODEL_CALLS}. storyUi, autoTranslate and autoRefusalRetryEnabled take a boolean. autoRefusalMaxRetries takes an integer. translationLanguage takes the language translations are written in, one of ${WRITTEN_LANGUAGES.join(', ')}: automatic translation skips a scene already written in it, and null translates every scene. storyUiStyle takes auto (follow the bot default or the model choice), ${storyUiStyles.join(', ')}, or theme:<saved theme id> from theme.list. newChat.loreContext takes the complete policy object as settings.read returns it in loreContextDefaults, without revision.`,
  },
};

export const HELPER_SETTINGS_MUTATIONS = new Set([
  'settings.update',
  'model.pricing.update',
  'model.pricing.backfill',
  'model.parameters.update',
  'model.register',
  'model.delete',
  'illustration-preset.select',
]);

export const HELPER_SETTINGS_TOOLS: ProviderTool[] = [
  ...HELPER_PRICING_TOOLS,
  ...HELPER_MODEL_PARAMETER_TOOLS,
  {
    name: 'model.list',
    description:
      'List the saved models and the saved connections. Each model has its id, title, revision, provider model id, whether it can currently be selected, its protocol, its pricing mode and whether a price is known, and the generation parameters it sets (unset ones use the provider default). Each connection has its id, title, revision, protocol, enabled state, Vertex location where it has one, and catalogTotal. Use it to turn a model name the user mentions into a model id for settings.update, model.pricing.* or model.parameters.*. The provider catalogs of the connections, needed only to pick a providerModelId for model.register, come with includeCatalog or catalogQuery. Credentials and endpoints are not included.',
    inputSchema: schema({
      includeCatalog: {
        type: 'boolean',
        description: `Add the catalog of each connection, at most ${CONNECTION_CATALOG_LIST_MAX} entries each. Default false.`,
      },
      catalogQuery: {
        type: 'string',
        maxLength: 200,
        description:
          'Add only the catalog entries whose id or name contains this text, with catalogMatches. Implies includeCatalog.',
      },
    }),
  },
  {
    name: 'model.register',
    description:
      'Save a new model on an existing connection so it can be chosen for a role or a chat. providerModelId is the id the provider uses, usually one from the connection catalog that model.list returns with catalogQuery. The model starts with the provider defaults and a maximum output of 8192 tokens unless maxOutputTokens is given; change temperature, reasoning and other generation parameters afterwards with model.parameters.update. Connections, credentials and endpoints are managed in the app settings, not here. Registering a model does not select it; use settings.update for that.',
    inputSchema: schema(
      {
        connectionId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Saved connection id from model.list.',
        },
        providerModelId: {
          type: 'string',
          minLength: 1,
          maxLength: 300,
          description:
            'Model id as the provider names it, for example from the connection catalog.',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Display name of the saved model.',
        },
        maxOutputTokens: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum output tokens. Default 8192.',
        },
      },
      ['connectionId', 'providerModelId', 'title']
    ),
  },
  {
    name: 'model.delete',
    description:
      'Delete a saved model. A model that is still chosen for a global role or an advisor, pinned to a chat, or used by the illustration settings is refused with the places that use it: choose another model there first. The helper cannot restore a deleted model. Take expectedRevision from model.list.',
    inputSchema: schema(
      {
        modelId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Saved model id from model.list.',
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'revision from model.list.',
        },
      },
      ['modelId', 'expectedRevision']
    ),
  },
  {
    name: 'illustration-preset.select',
    description:
      'Choose the illustration preset that new illustrations use: the global default, or the choice for one bot or one chat. A chat choice wins over its bot choice, which wins over the global default. presetId null makes a bot or chat follow the next level again, or returns the global default to the built-in preset. Selecting a preset generates nothing and leaves queued illustrations as they are. Take expectedRevision from preferences.revision in illustration-preset.list.',
    inputSchema: schema(
      {
        scope: {
          type: 'string',
          enum: ['global', 'bot', 'chat'],
          description: 'Where the choice applies.',
        },
        targetId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'bot: the bot id; chat: the chat id. Omit for global.',
        },
        presetId: {
          type: ['string', 'null'],
          maxLength: 100,
          description: 'Preset id from illustration-preset.list, or null.',
        },
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description: 'preferences.revision from illustration-preset.list.',
        },
      },
      ['scope', 'presetId', 'expectedRevision']
    ),
  },
  {
    name: 'settings.read',
    description:
      'Read the current settings: which model and prompt preset are used for each role globally, automatic translation of new scenes and its language, the model and prompt preset pinned to the selected chat and the ones actually in effect, the chat call limit, Story UI on/off and style, and the defaults for new chats, including automatic retry after a refusal and the lore context policy. A model choice names the saved model id, title and provider model id. Each group comes with the revision that settings.update needs. Prompt texts and credentials are not included; read a prompt preset with resource.read.',
    inputSchema: schema({}),
  },
  {
    name: 'settings.update',
    description:
      'Change settings: the model or prompt preset used for a role, automatic translation, the model or prompt preset pinned to a chat, the call limit of a chat, Story UI on/off and style, or a default for new chats. Give setting, expectedRevision and value for one change, or updates for several changes saved together or not at all; updates of the same group take the same revision from settings.read, and the host applies them in order. Read settings.read first for the current values and revisions. global.* settings apply to every chat and affect future requests only; work that is already reserved keeps its model and prompt. global.autoTranslate translates each new scene of chats that have no choice of their own, which is a paid model call per scene. chat.* settings apply to the selected chat. newChat.* settings are defaults copied into chats created later and need no selected chat; existing chats, copies and imports keep their own settings. A Story UI default for a whole bot is set with theme.select instead.',
    inputSchema: schema({
      ...settingChange,
      updates: {
        type: 'array',
        minItems: 1,
        maxItems: SETTINGS_UPDATE_BATCH_MAX,
        description:
          'Several changes in place of setting, expectedRevision and value: each item is {setting, expectedRevision, value} as described for those fields.',
        items: {
          type: 'object',
          properties: {
            setting: { type: 'string', enum: [...settings] },
            expectedRevision: { type: 'integer', minimum: 0 },
            value: { type: ['string', 'integer', 'boolean', 'null', 'object'] },
          },
          required: ['setting', 'expectedRevision', 'value'],
          additionalProperties: false,
        },
      },
    }),
  },
  {
    name: 'usage.read',
    description:
      'Read spending and token usage totals for a range of calendar dates in Seoul time, both ends included. Use it for questions about cost, tokens or how much a period used. Without breakdown it returns totals, undated usage and coverage only; breakdown adds a split by day, model or kind, or all of them. Costs keep their status: reported, estimated, partial or unknown, and an unknown cost is not zero. For per-task or per-chat detail query agent_usage with db.query.',
    inputSchema: schema(
      {
        from: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'First date, YYYY-MM-DD in Seoul time.',
        },
        to: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Last date, YYYY-MM-DD in Seoul time, included.',
        },
        breakdown: {
          type: 'string',
          enum: [...USAGE_BREAKDOWNS, 'all'],
          description: 'Optional split of the totals. Omit for totals only.',
        },
      },
      ['from', 'to']
    ),
  },
];

const backfilled = (backfill?: { estimatedCalls: number; partialCalls: number }) =>
  !!backfill && backfill.estimatedCalls + backfill.partialCalls > 0;

type SettingValue = string | number | boolean | null | Record<string, unknown>;
const isScalar = (value: SettingValue): value is string | number | boolean | null =>
  value === null || typeof value !== 'object';

function settingValue(store: Store, setting: string, chatId?: string): SettingValue {
  if (setting === 'newChat.loreContext') {
    const { revision: _revision, ...policy } = loreContextDefaults(store);
    return policy;
  }
  if (setting === 'global.autoTranslate') return autoTranslationDefaults(store.db).autoTranslate;
  if (setting === 'global.translationLanguage')
    return autoTranslationDefaults(store.db).translationLanguage;
  if (promptPresetSettings.includes(setting)) {
    const workspace = promptWorkspace(store);
    return (
      (setting === 'global.mainPromptPreset' ? workspace.main : workspace.translation).presetId ??
      null
    );
  }
  if (setting.startsWith('newChat.')) {
    const key = setting.slice('newChat.'.length) as Exclude<
      keyof ChatGenerationDefaults,
      'revision'
    >;
    return chatGenerationDefaults(store.db)[key];
  }
  if ((settings as readonly string[]).includes(setting) && setting.startsWith('global.')) {
    const role = setting.slice('global.'.length, -'Model'.length) as WorkspaceModelRole;
    return workspaceModelRef(promptWorkspace(store), role)?.id ?? null;
  }
  if (!chatId) return null;
  if (setting === 'chat.maxCalls') return store.chat(chatId).settings.maxCalls;
  if (setting === 'chat.storyUi') return store.chat(chatId).settings.storyUi ?? false;
  if (setting === 'chat.storyUiStyle') return store.chat(chatId).settings.storyUiStyle ?? 'auto';
  const profile = store.product.profile(chatId);
  return setting === 'chat.mainModel'
    ? (profile.pinned?.mainModel?.id ?? null)
    : (profile.pinned?.mainPromptPresetId ?? null);
}

function selectionLabel(store: Store, setting: string, value: SettingValue) {
  if (typeof value !== 'string') return value === null ? null : undefined;
  if (setting === 'global.translationLanguage') return undefined;
  try {
    if (setting === 'chat.storyUiStyle' || setting === 'newChat.storyUiStyle')
      return isStoryUiThemeSetting(value)
        ? readTheme(store, value.slice('theme:'.length)).title
        : undefined;
    return store.product.stored<{ title: string }>(
      setting === 'chat.mainPromptPreset' || promptPresetSettings.includes(setting)
        ? 'prompt-preset'
        : 'model',
      value
    ).title;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return undefined;
  }
}

export function applyHelperSettingsMutation(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId'>,
  receiptId: string,
  name: string,
  args: Record<string, unknown>,
  chatId?: string
): unknown {
  if (name.startsWith('model.pricing.') && args.judgment !== undefined) {
    const read = () =>
      invokeHelperSettingsTool(store, 'model.pricing.read', {
        judgment: true,
        ...(args.judgmentTarget === undefined ? {} : { judgmentTarget: args.judgmentTarget }),
      }) as { pricing: unknown; revision: number };
    const before = read();
    const result = invokeHelperSettingsTool(store, name, args, chatId) as {
      providerModelId: string;
      pricing: unknown;
      estimatedCalls?: number;
      partialCalls?: number;
      backfill?: { estimatedCalls: number; partialCalls: number };
    };
    const changed =
      name === 'model.pricing.backfill'
        ? (result.estimatedCalls ?? 0) + (result.partialCalls ?? 0) > 0
        : !isDeepStrictEqual(before.pricing, result.pricing) || backfilled(result.backfill);
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: 1,
      targets: !changed
        ? []
        : [
            {
              kind: 'settings',
              id: 'judgment',
              title: result.providerModelId,
              revision: read().revision,
              setting: 'judgment.pricing',
            },
          ],
    });
    return result;
  }
  if (name === 'model.pricing.update') {
    const modelId = text(args.modelId, 'saved model ID', 100);
    const before = store.product.writable<ModelPreset>('model', modelId);
    const result = invokeHelperSettingsTool(store, name, args, chatId) as {
      backfill?: { estimatedCalls: number; partialCalls: number };
    };
    const after = store.product.stored<ModelPreset>('model', modelId);
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: 1,
      targets:
        isDeepStrictEqual(
          before.pricing ?? { mode: 'official' },
          after.pricing ?? { mode: 'official' }
        ) && !backfilled(result.backfill)
          ? []
          : [
              {
                kind: 'settings',
                id: modelId,
                title: after.title,
                revision: after.revision,
                setting: 'model.pricing',
                beforePricing: before.pricing ?? { mode: 'official' },
                afterPricing: after.pricing ?? { mode: 'official' },
              },
            ],
    });
    return result;
  }
  if (name === 'model.pricing.backfill') {
    const result = invokeHelperSettingsTool(store, name, args, chatId) as {
      modelId: string;
      estimatedCalls: number;
      partialCalls: number;
    };
    const model = store.product.stored<ModelPreset>('model', result.modelId);
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: 1,
      targets:
        result.estimatedCalls + result.partialCalls > 0
          ? [
              {
                kind: 'settings',
                id: model.id,
                title: model.title,
                revision: model.revision,
                setting: 'model.pricing',
              },
            ]
          : [],
    });
    return result;
  }
  if (name === 'model.register' || name === 'model.delete') {
    const result = invokeHelperSettingsTool(store, name, args, chatId) as {
      modelId: string;
      title: string;
      revision: number;
    };
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: 1,
      targets: [
        {
          kind: 'settings',
          id: result.modelId,
          title: result.title,
          revision: result.revision,
          setting: name,
        },
      ],
    });
    return result;
  }
  if (name === 'illustration-preset.select') {
    const scope = text(args.scope, 'scope', 10);
    const targetId = scope === 'global' ? 'global' : text(args.targetId, 'target ID', 100);
    const selected = () => {
      const preferences = illustrationPresetPreferences(store);
      return scope === 'global'
        ? preferences.defaultPresetId
        : ((scope === 'bot' ? preferences.botPresets : preferences.chatPresets)[targetId] ?? null);
    };
    const label = (id: string | null) => {
      if (id === null) return null;
      try {
        return readIllustrationPreset(store, id).title;
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return null;
      }
    };
    const before = selected();
    const result = selectIllustrationPreset(store, args);
    const after = selected();
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: 1,
      targets:
        before === after
          ? []
          : [
              {
                kind: 'settings',
                id: targetId,
                title:
                  scope === 'global'
                    ? '기본값'
                    : scope === 'bot'
                      ? store.product.stored<{ title: string }>('content', targetId).title
                      : store.chat(targetId).title,
                revision: result.revision,
                setting:
                  scope === 'global' ? 'illustrationPreset.global' : `${scope}.illustrationPreset`,
                before,
                after,
                beforeLabel: label(before),
                afterLabel: label(after),
              },
            ],
    });
    return result;
  }
  if (name === 'model.parameters.update') {
    const result = invokeHelperModelParameterTool(store, name, args);
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: 1,
      targets: result.changed
        ? [
            {
              kind: 'settings',
              id: result.modelId,
              title: result.title,
              revision: result.revision,
              setting: 'model.parameters',
            },
          ]
        : [],
    });
    return result;
  }
  if (args.updates !== undefined) {
    fields(args, ['updates']);
    if (
      !Array.isArray(args.updates) ||
      !args.updates.length ||
      args.updates.length > SETTINGS_UPDATE_BATCH_MAX
    )
      throw new HelperToolError(400, 'INVALID_SETTINGS_UPDATES');
    const groups = new Map<string, { expected: number; current: number }>();
    const updates: unknown[] = [];
    const targets: HelperTaskResultTarget[] = [];
    for (const raw of args.updates) {
      const item = record(raw);
      fields(item, ['setting', 'expectedRevision', 'value']);
      const setting = text(item.setting, 'setting', 100);
      const expected = number(item.expectedRevision, 'settings revision', 0);
      const group = settingGroup(setting);
      const chained = groups.get(group);
      if (chained && chained.expected !== expected)
        throw new HelperToolError(
          409,
          'SETTINGS_REVISION_MISMATCH',
          `give every update of ${setting}'s group the same expectedRevision from settings.read.`
        );
      const updated = updateSetting(
        store,
        { ...item, setting, expectedRevision: chained ? chained.current : expected },
        chatId
      );
      groups.set(group, { expected, current: updated.result.revision });
      updates.push(updated.result);
      targets.push(...updated.targets);
    }
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: args.updates.length,
      targets,
    });
    return { updates };
  }
  const { result, targets } = updateSetting(store, args, chatId);
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: name,
    requestedTargets: 1,
    targets,
  });
  return result;
}

function settingGroup(setting: string) {
  if (autoTranslationSettings.includes(setting)) return 'autoTranslation';
  if (setting === 'newChat.loreContext') return 'loreContextDefaults';
  if (setting.startsWith('newChat.')) return 'newChat';
  if (setting.startsWith('global.')) return 'global';
  if (setting === 'chat.mainModel' || setting === 'chat.mainPromptPreset') return 'chat.profile';
  return 'chat.settings';
}

function updateSetting(store: Store, args: Record<string, unknown>, chatId?: string) {
  const setting = text(args.setting, 'setting', 100);
  const before = settingValue(store, setting, chatId);
  const beforeLabel = selectionLabel(store, setting, before);
  const result = invokeHelperSettingsTool(store, 'settings.update', args, chatId) as {
    revision: number;
  };
  const after = settingValue(store, setting, chatId);
  const targets: HelperTaskResultTarget[] = isDeepStrictEqual(before, after)
    ? []
    : [
        {
          kind: 'settings',
          id: setting.startsWith('global.') || setting.startsWith('newChat.') ? 'global' : chatId!,
          title:
            setting.startsWith('global.') || setting.startsWith('newChat.')
              ? '기본값'
              : store.chat(chatId!).title,
          revision: result.revision,
          setting,
          ...(isScalar(before) && isScalar(after)
            ? {
                before,
                after,
                beforeLabel,
                afterLabel: selectionLabel(store, setting, after),
              }
            : {}),
        },
      ];
  return { result, targets };
}

export function invokeHelperSettingsTool(
  store: Store,
  name: string,
  value: unknown,
  chatId?: string
): unknown {
  if (name.startsWith('model.pricing.')) return invokeHelperPricingTool(store, name, value);
  if (name.startsWith('model.parameters.'))
    return invokeHelperModelParameterTool(store, name, value);
  const args = record(value);
  if (name === 'model.list') {
    fields(args, ['includeCatalog', 'catalogQuery']);
    if (args.includeCatalog !== undefined && typeof args.includeCatalog !== 'boolean')
      throw new HttpError(400, 'Invalid includeCatalog');
    const catalogQuery =
      args.catalogQuery === undefined
        ? undefined
        : text(args.catalogQuery, 'catalog query', 200, true).trim().toLowerCase();
    const includeCatalog = args.includeCatalog === true || catalogQuery !== undefined;
    const connections = new Map(
      (store.product.all('connection') as Connection[]).map((connection) => [
        connection.id,
        connection,
      ])
    );
    return {
      models: (store.product.all('model') as ModelPreset[]).map((model) => {
        const connection = connections.get(model.connectionId);
        return {
          id: model.id,
          title: model.title,
          revision: model.revision,
          connectionId: model.connectionId,
          providerModelId: model.modelId,
          selectable: model.enabled !== false && connection?.enabled === true,
          ...(connection
            ? {
                protocol: connection.protocol,
                pricing: {
                  mode: model.pricing?.mode ?? 'official',
                  known: resolveModelPricing(model, connection) !== undefined,
                },
                parameters: savedModelParameters(model, connection.protocol),
              }
            : {}),
        };
      }),
      connections: [...connections.values()].map((connection) => {
        const vertex =
          connection.protocol === 'vertex-gemini-v1'
            ? parseVertexEndpoint(connection.endpoint)
            : null;
        const catalog = catalogQuery
          ? connection.catalog.filter(
              (item) =>
                item.id.toLowerCase().includes(catalogQuery) ||
                item.name.toLowerCase().includes(catalogQuery)
            )
          : connection.catalog;
        return {
          id: connection.id,
          title: connection.title,
          revision: connection.revision,
          protocol: connection.protocol,
          enabled: connection.enabled,
          ...(vertex ? { location: vertex.location } : {}),
          ...(includeCatalog
            ? {
                catalog: catalog
                  .slice(0, CONNECTION_CATALOG_LIST_MAX)
                  .map((item) => ({ id: item.id, name: item.name })),
                ...(catalogQuery ? { catalogMatches: catalog.length } : {}),
              }
            : {}),
          catalogTotal: connection.catalog.length,
        };
      }),
    };
  }
  if (name === 'model.register') {
    fields(args, ['connectionId', 'providerModelId', 'title', 'maxOutputTokens']);
    const connectionId = text(args.connectionId, 'connection ID', 100);
    store.product.assertAvailable('connection', connectionId);
    const saved = store.product.model({
      title: text(args.title, 'model title', 200),
      connectionId,
      modelId: text(args.providerModelId, 'provider model ID', 300),
      maxOutputTokens:
        args.maxOutputTokens === undefined
          ? DEFAULT_REGISTERED_MAX_OUTPUT_TOKENS
          : number(args.maxOutputTokens, 'maximum output tokens', 1),
      temperature: null,
      enabled: true,
    }) as ModelPreset;
    return {
      modelId: saved.id,
      title: saved.title,
      revision: saved.revision,
      connectionId,
      providerModelId: saved.modelId,
    };
  }
  if (name === 'model.delete') {
    fields(args, ['modelId', 'expectedRevision']);
    const modelId = text(args.modelId, 'saved model ID', 100);
    const expectedRevision = number(args.expectedRevision, 'model revision');
    const model = store.product.editable<ModelPreset>('model', modelId, expectedRevision);
    const use = modelInUse(store, modelId);
    if (use) throw new HelperToolError(409, 'MODEL_IN_USE', `${use}`);
    deleteLibraryItem(store, 'model', modelId, { expectedRevision });
    return { modelId, title: model.title, revision: model.revision, deleted: true };
  }
  if (name === 'usage.read') {
    fields(args, ['from', 'to', 'breakdown']);
    const breakdown =
      args.breakdown === undefined
        ? undefined
        : choice(args.breakdown, [...USAGE_BREAKDOWNS, 'all'], 'usage breakdown');
    return usageReport(
      store,
      parseInput(personalWorkspaceOperations.readUsage.input, { from: args.from, to: args.to }),
      breakdown === 'all' ? USAGE_BREAKDOWNS : breakdown ? [breakdown] : []
    );
  }
  if (name === 'settings.read') {
    fields(args, []);
    const global = promptWorkspace(store);
    const choice = (ref: { id: string } | null | undefined) => {
      if (!ref) return null;
      try {
        const model = store.product.available<ModelPreset>('model', ref.id);
        return { id: ref.id, title: model.title, providerModelId: model.modelId };
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return { id: ref.id, unavailable: true };
      }
    };
    const models = Object.fromEntries(
      modelRoles.map((role) => [role, choice(workspaceModelRef(global, role))])
    );
    const result = {
      newChat: chatGenerationDefaults(store.db),
      loreContextDefaults: loreContextDefaults(store),
      autoTranslation: autoTranslationDefaults(store.db),
      global: {
        revision: global.revision,
        models,
        prompts: {
          main: { title: global.main.title, presetId: global.main.presetId ?? null },
          translation: {
            title: global.translation.title,
            presetId: global.translation.presetId ?? null,
          },
        },
      },
    };
    if (!chatId) return result;
    const chat = store.chat(chatId);
    const profile = store.product.profile(chatId);
    const effective = chatPromptWorkspace(store, profile.pinned);
    return {
      ...result,
      chat: {
        id: chatId,
        profileRevision: profile.revision,
        settingsRevision: chat.settingsRevision,
        pinned: {
          mainModel: choice(profile.pinned?.mainModel),
          mainPromptPresetId: profile.pinned?.mainPromptPresetId ?? null,
        },
        effective: {
          models: Object.fromEntries(
            modelRoles.map((role) => [role, choice(workspaceModelRef(effective, role))])
          ),
          mainModel: choice(effective.modelRoutes.main),
          mainPrompt: {
            title: effective.main.title,
            presetId: effective.pinnedMainPreset?.id ?? effective.main.presetId ?? null,
            revision: effective.pinnedMainPreset?.revision ?? effective.revision,
          },
          translationPrompt: {
            title: effective.translation.title,
            presetId: effective.translation.presetId ?? null,
            revision: effective.revision,
          },
        },
        maxCalls: chat.settings.maxCalls,
        storyUi: chat.settings.storyUi ?? false,
        storyUiStyle: chat.settings.storyUiStyle ?? 'auto',
      },
    };
  }
  if (name === 'illustration-preset.select') return selectIllustrationPreset(store, args);
  if (name !== 'settings.update') throw new HelperToolError(400, 'UNKNOWN_SETTINGS_TOOL');
  fields(args, ['setting', 'expectedRevision', 'value']);
  const setting = text(args.setting, 'setting', 100);
  if (!(settings as readonly string[]).includes(setting))
    throw new HelperToolError(400, 'INVALID_SETTING');
  const expectedRevision = number(args.expectedRevision, 'settings revision', 0);
  if (setting === 'newChat.loreContext') {
    const { revision, ...policy } = updateLoreContextDefaults(
      store,
      parseInput(promptOperations.updateLoreContextDefaults.input, {
        ...record(args.value),
        expectedRevision,
      })
    );
    return { setting, revision, value: policy };
  }
  if (autoTranslationSettings.includes(setting)) {
    const current = autoTranslationDefaults(store.db);
    const updated = saveAutoTranslationDefaults(
      store,
      parseInput(translationOperations.saveAutoTranslationDefaults.input, {
        expectedRevision,
        autoTranslate: setting === 'global.autoTranslate' ? args.value : current.autoTranslate,
        translationLanguage:
          setting === 'global.translationLanguage' ? args.value : current.translationLanguage,
      })
    );
    return {
      setting,
      revision: updated.revision,
      value:
        setting === 'global.autoTranslate' ? updated.autoTranslate : updated.translationLanguage,
    };
  }
  if (promptPresetSettings.includes(setting)) {
    const updated = applyWorkspacePromptPreset(
      store,
      parseInput(promptOperations.applyPreset.input, {
        expectedRevision,
        role: setting === 'global.mainPromptPreset' ? 'main' : 'translation',
        presetId: args.value,
      })
    );
    return {
      setting,
      revision: updated.revision,
      value: settingValue(store, setting),
    };
  }
  if (setting.startsWith('newChat.')) {
    const key = setting.slice('newChat.'.length) as Exclude<
      keyof ChatGenerationDefaults,
      'revision'
    >;
    const current = chatGenerationDefaults(store.db);
    const { revision: _revision, ...values } = current;
    const updated = saveChatGenerationDefaults(store, {
      ...values,
      [key]: args.value,
      expectedRevision,
    });
    return { setting, revision: updated.revision, value: updated[key] };
  }
  if (setting.startsWith('global.')) {
    if (args.value !== null && typeof args.value !== 'string')
      throw new HelperToolError(400, 'INVALID_MODEL_ID');
    const modelId = args.value === null ? null : text(args.value, 'model ID', 100);
    const current = modelWorkspace(store);
    const role = setting.slice('global.'.length, -'Model'.length) as WorkspaceModelRole;
    const routes = { ...current.routes };
    const ref = modelId === null ? null : { id: modelId };
    const optional: Record<string, unknown> = {};
    if (role === 'main' || role === 'translation') routes[role] = ref;
    else optional[`${role}Model`] = ref;
    const updated = updateModelWorkspace(store, {
      expectedRevision,
      routes,
      translationPolicy: current.translationPolicy,
      ...optional,
    });
    return {
      setting,
      revision: updated.revision,
      value: workspaceModelRef(promptWorkspace(store), role),
    };
  }
  if (!chatId) throw new HelperToolError(403, 'CHAT_SCOPE_REQUIRED');
  if (setting === 'chat.mainModel' || setting === 'chat.mainPromptPreset') {
    if (args.value !== null && typeof args.value !== 'string')
      throw new HelperToolError(400, 'INVALID_SELECTION_ID');
    const id = args.value === null ? null : text(args.value, 'selection ID', 100);
    const profile = store.product.profile(chatId);
    const pinned = { ...profile.pinned };
    if (setting === 'chat.mainModel') {
      if (id === null) delete pinned.mainModel;
      else pinned.mainModel = { id };
    } else if (id === null) delete pinned.mainPromptPresetId;
    else pinned.mainPromptPresetId = id;
    const updated = store.product.updateProfile(chatId, {
      expectedRevision,
      image: profile.image,
      pinned,
    });
    return {
      setting,
      revision: updated.revision,
      value:
        setting === 'chat.mainModel'
          ? (updated.pinned?.mainModel ?? null)
          : (updated.pinned?.mainPromptPresetId ?? null),
    };
  }
  const chat = store.chat(chatId);
  if (
    setting === 'chat.maxCalls' &&
    (!Number.isSafeInteger(args.value) ||
      Number(args.value) < 1 ||
      Number(args.value) > MAX_MAIN_MODEL_CALLS)
  )
    throw new HelperToolError(400, 'INVALID_MAX_CALLS');
  const key = setting.slice('chat.'.length) as keyof Settings;
  const next = normalizeChatSettings({ ...chat.settings, [key]: args.value });
  const updated = store.settings(chatId, expectedRevision, next);
  return {
    setting,
    revision: updated.settingsRevision,
    value: updated.settings[key],
  };
}
