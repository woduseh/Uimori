import type { Json, ProviderTool } from '../core/transport.js';
import type { Settings } from '../core/types.js';
import type { Connection, ModelPreset, WorkspaceModelRole } from '../core/product.js';
import { workspaceModelRef } from '../core/product.js';
import {
  chatPromptWorkspace,
  modelWorkspace,
  promptWorkspace,
  updateModelWorkspace,
} from './prompt-workspace.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { usageReport } from './usage-report.js';

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
] as const;

export const HELPER_SETTINGS_TOOLS: ProviderTool[] = [
  {
    name: 'model.list',
    description:
      'List saved model IDs and titles with their current selectable state. Read this before choosing an unfamiliar model ID. Credentials and endpoints are omitted.',
    inputSchema: schema({}),
  },
  {
    name: 'settings.read',
    description:
      'Read compact global and selected-chat model and prompt references, pinned versus effective selections, chat call limit, and the revisions needed to update them. Prompt bodies and credentials are omitted.',
    inputSchema: schema({}),
  },
  {
    name: 'settings.update',
    description:
      'Change one requested setting using the revision from settings.read. Global model targets accept a saved model ID or null; chat.mainModel and chat.mainPromptPreset accept an ID or null; chat.maxCalls accepts an integer from 1 to 32. Global choices affect future requests across chats; reserved jobs keep their frozen models. Existing services preserve unrelated settings. The selected chat is required for chat targets.',
    inputSchema: schema(
      {
        setting: { type: 'string', enum: [...settings] },
        expectedRevision: { type: 'integer', minimum: 0 },
        value: { type: ['string', 'integer', 'boolean', 'null'] },
      },
      ['setting', 'expectedRevision', 'value']
    ),
  },
  {
    name: 'usage.read',
    description:
      'Read the existing usage report for inclusive Seoul calendar dates. Reported, estimated, partial and unknown costs retain their distinct meanings.',
    inputSchema: schema(
      {
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      ['from', 'to']
    ),
  },
];

/** The caller owns helper operation receipts and resolves optional chatId to this scope. */
export function invokeHelperSettingsTool(
  store: Store,
  name: string,
  value: unknown,
  chatId?: string
): unknown {
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
    fields(args, ['from', 'to']);
    return usageReport(store, args);
  }
  if (name === 'settings.read') {
    fields(args, []);
    const global = promptWorkspace(store);
    const models = Object.fromEntries(
      modelRoles.map((role) => [role, workspaceModelRef(global, role)])
    );
    const result = {
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
      },
    };
  }
  if (name !== 'settings.update') throw new HttpError(400, 'UNKNOWN_SETTINGS_TOOL');
  fields(args, ['setting', 'expectedRevision', 'value']);
  const setting = text(args.setting, 'setting', 100);
  if (!(settings as readonly string[]).includes(setting))
    throw new HttpError(400, 'INVALID_SETTING');
  const expectedRevision = number(args.expectedRevision, 'settings revision', 0);
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
  if (!Number.isSafeInteger(args.value) || Number(args.value) < 1 || Number(args.value) > 32)
    throw new HttpError(400, 'INVALID_MAX_CALLS');
  const next: Settings = { ...chat.settings, maxCalls: Number(args.value) };
  const updated = store.settings(chatId, expectedRevision, next);
  return {
    setting,
    revision: updated.settingsRevision,
    value: updated.settings.maxCalls,
  };
}
