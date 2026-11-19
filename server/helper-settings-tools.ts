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
  chatPromptWorkspace,
  modelWorkspace,
  promptWorkspace,
  updateModelWorkspace,
} from './prompt-workspace.js';
import { choice, fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { USAGE_BREAKDOWNS, usageReport } from './usage-report.js';
import { isDeepStrictEqual } from 'node:util';
import type { HelperTask, HelperTaskResultTarget } from '../core/helper.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import { readTheme } from './themes.js';

const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const modelRoles = ['main', 'translation', 'helper', 'context', 'script', 'title'] as const;
const settings = [
  ...modelRoles.map((role) => `global.${role}Model`),
  'chat.mainModel',
  'chat.mainPromptPreset',
  'chat.maxCalls',
  'chat.storyUi',
  'chat.storyUiStyle',
  'newChat.maxCalls',
  'newChat.storyUi',
  'newChat.storyUiStyle',
] as const;

/** Settings writes whose receipts and compact results commit inside workspace.operation. */
export const HELPER_SETTINGS_MUTATIONS = new Set([
  'settings.update',
  'model.pricing.update',
  'model.parameters.update',
]);

export const HELPER_SETTINGS_TOOLS: ProviderTool[] = [
  ...HELPER_PRICING_TOOLS,
  ...HELPER_MODEL_PARAMETER_TOOLS,
  {
    name: 'model.list',
    description:
      'List the saved models with their ids, titles and whether each can currently be selected. Use it to turn a model name the user mentions into a model id for settings.update or model.pricing.read. Credentials and endpoints are not included.',
    inputSchema: schema({}),
  },
  {
    name: 'settings.read',
    description:
      'Read the current settings: which model is used for each role globally (main, translation, helper, context, script, title), the model and prompt preset pinned to the selected chat and the ones actually in effect, the chat call limit, Story UI on/off and style, and the defaults for new chats. Each group comes with the revision that settings.update needs. Prompt texts and credentials are not included; read a prompt preset with resource.read.',
    inputSchema: schema({}),
  },
  {
    name: 'settings.update',
    description:
      'Change one setting: the model used for a role, the model or prompt preset pinned to a chat, the call limit of a chat, or Story UI on/off and style. Read settings.read first for the current value and the matching revision. global.* settings choose the model for a role in every chat and affect future requests only; work that is already reserved keeps its model. chat.* settings apply to the selected chat. newChat.* settings are defaults copied into chats created later and need no selected chat; existing chats, copies and imports keep their own settings. A Story UI default for a whole bot is set with theme.select instead.',
    inputSchema: schema(
      {
        setting: {
          type: 'string',
          enum: [...settings],
          description: 'The one setting to change.',
        },
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description:
            'Revision from settings.read for the group being changed: global.revision for global.* settings; chat.profileRevision for chat.mainModel and chat.mainPromptPreset; chat.settingsRevision for chat.maxCalls, chat.storyUi and chat.storyUiStyle; newChat.revision for newChat.* settings.',
        },
        value: {
          type: ['string', 'integer', 'boolean', 'null'],
          description: `New value. Model and prompt preset settings take a saved id, or null to clear the choice. maxCalls takes an integer from 1 to ${MAX_MAIN_MODEL_CALLS}. storyUi takes a boolean. storyUiStyle takes auto (follow the bot default or the model choice), ${storyUiStyles.join(', ')}, or theme:<saved theme id> from theme.list.`,
        },
      },
      ['setting', 'expectedRevision', 'value']
    ),
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

function settingValue(
  store: Store,
  setting: string,
  chatId?: string
): string | number | boolean | null {
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

function selectionLabel(store: Store, setting: string, value: string | number | boolean | null) {
  if (typeof value !== 'string') return value === null ? null : undefined;
  try {
    if (setting === 'chat.storyUiStyle' || setting === 'newChat.storyUiStyle')
      return isStoryUiThemeSetting(value)
        ? readTheme(store, value.slice('theme:'.length)).title
        : undefined;
    return store.product.get<{ title: string }>(
      setting === 'chat.mainPromptPreset' ? 'prompt-preset' : 'model',
      value
    ).title;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return undefined;
  }
}

/** Called inside workspace.operation so the compact result and receipt commit together. */
export function applyHelperSettingsMutation(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId'>,
  receiptId: string,
  name: string,
  args: Record<string, unknown>,
  chatId?: string
): unknown {
  if (name === 'model.pricing.update') {
    const modelId = text(args.modelId, 'saved model ID', 100);
    const before = store.product.get<ModelPreset>('model', modelId);
    const result = invokeHelperSettingsTool(store, name, args, chatId);
    const after = store.product.get<ModelPreset>('model', modelId);
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: 1,
      targets: isDeepStrictEqual(
        before.pricing ?? { mode: 'official' },
        after.pricing ?? { mode: 'official' }
      )
        ? []
        : [
            {
              kind: 'settings',
              id: modelId,
              title: after.title,
              revision: after.revision,
              setting: 'model.pricing',
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
  const setting = text(args.setting, 'setting', 100);
  const before = settingValue(store, setting, chatId);
  const beforeLabel = selectionLabel(store, setting, before);
  const result = invokeHelperSettingsTool(store, name, args, chatId) as { revision: number };
  const after = settingValue(store, setting, chatId);
  const targets: HelperTaskResultTarget[] =
    before === after
      ? []
      : [
          {
            kind: 'settings',
            id:
              setting.startsWith('global.') || setting.startsWith('newChat.') ? 'global' : chatId!,
            title:
              setting.startsWith('global.') || setting.startsWith('newChat.')
                ? '기본값'
                : store.chat(chatId!).title,
            revision: result.revision,
            setting,
            before,
            after,
            beforeLabel,
            afterLabel: selectionLabel(store, setting, after),
          },
        ];
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: name,
    requestedTargets: 1,
    targets,
  });
  return result;
}

/** The caller owns helper operation receipts and resolves optional chatId to this scope. */
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
    fields(args, []);
    const connections = new Map(
      (store.product.all('connection') as Connection[]).map((connection) => [
        connection.id,
        connection,
      ])
    );
    return (store.product.all('model') as ModelPreset[]).map((model) => ({
      id: model.id,
      title: model.title,
      connectionId: model.connectionId,
      selectable: model.enabled !== false && connections.get(model.connectionId)?.enabled === true,
    }));
  }
  if (name === 'usage.read') {
    fields(args, ['from', 'to', 'breakdown']);
    const breakdown =
      args.breakdown === undefined
        ? undefined
        : choice(args.breakdown, [...USAGE_BREAKDOWNS, 'all'], 'usage breakdown');
    return usageReport(
      store,
      { from: args.from, to: args.to },
      breakdown === 'all' ? USAGE_BREAKDOWNS : breakdown ? [breakdown] : []
    );
  }
  if (name === 'settings.read') {
    fields(args, []);
    const global = promptWorkspace(store);
    const models = Object.fromEntries(
      modelRoles.map((role) => [role, workspaceModelRef(global, role)])
    );
    const result = {
      newChat: chatGenerationDefaults(store.db),
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
          mainModel: profile.pinned?.mainModel ?? null,
          mainPromptPresetId: profile.pinned?.mainPromptPresetId ?? null,
        },
        effective: {
          models: Object.fromEntries(
            modelRoles.map((role) => [role, workspaceModelRef(effective, role)])
          ),
          mainModel: effective.modelRoutes.main,
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
  if (name !== 'settings.update') throw new HttpError(400, 'UNKNOWN_SETTINGS_TOOL');
  fields(args, ['setting', 'expectedRevision', 'value']);
  const setting = text(args.setting, 'setting', 100);
  if (!(settings as readonly string[]).includes(setting))
    throw new HttpError(400, 'INVALID_SETTING');
  const expectedRevision = number(args.expectedRevision, 'settings revision', 0);
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
      throw new HttpError(400, 'INVALID_MODEL_ID');
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
  if (!chatId) throw new HttpError(403, 'CHAT_SCOPE_REQUIRED');
  if (setting === 'chat.mainModel' || setting === 'chat.mainPromptPreset') {
    if (args.value !== null && typeof args.value !== 'string')
      throw new HttpError(400, 'INVALID_SELECTION_ID');
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
    throw new HttpError(400, 'INVALID_MAX_CALLS');
  const key = setting.slice('chat.'.length) as keyof Settings;
  const next = normalizeChatSettings({ ...chat.settings, [key]: args.value });
  const updated = store.settings(chatId, expectedRevision, next);
  return {
    setting,
    revision: updated.settingsRevision,
    value: updated.settings[key],
  };
}
