import { promptControls } from '../core/risu-prompt.js';
import { effectiveRisuControls } from '../core/risu-effective-controls.js';
import { resolvePackageProfile } from './package-features.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import type { FastifyInstance } from 'fastify';
import { chatSettingsEndpoints } from '#contracts';
import {
  chatSettingsOperations,
  fixOptionsInput,
  stageOptionsInput,
  type ChatOptionsCancel,
  type ChatOptionsCommand,
} from '#contracts/operations';
import {
  promptOptionOwner,
  type OptionBinding,
  type OptionValues,
  type PendingChatOptions,
  type ChatOptionState,
  type ChatOptionConflict,
} from '../core/chat-options.js';
import type { HelperTask } from '../core/helper.js';
import type { CurrentPrompt, ProfileSnapshot } from '../core/product.js';
import { resolveControlValues, type PromptControl, type RisuPrompt } from '../core/risu-prompt.js';
import type { ProviderTool, Json } from '../core/transport.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import { HelperWorkspace } from './helper-workspace.js';
import { chatPromptWorkspace } from './prompt-workspace.js';
import { parseInput, registerEndpoint } from './endpoint.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';
import type { ReferenceSource } from './product-store.js';
import { AppError, HelperToolError } from './app-errors.js';

type Row = Record<string, string | number | null>;
const json = JSON.stringify;
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const now = () => new Date().toISOString();

export function initChatOptions(store: Store): void {
  store.db.exec(`
    CREATE TABLE chat_prompt_options(chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE chat_option_pending(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,body TEXT NOT NULL);
    CREATE TABLE chat_option_operations(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,request_id TEXT NOT NULL,command_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL);
  `);
}

export function optionBinding(
  prompt: Pick<CurrentPrompt, 'presetId' | 'program'>,
  controls = promptControls(prompt.program)
): OptionBinding {
  return {
    owner: promptOptionOwner(prompt),
    definitionHash: hash(controls),
  };
}
function frozenOptionBinding(profile: ProfileSnapshot): OptionBinding | undefined {
  const preset = profile.promptPresets?.main;
  if (!preset || profile.promptOptionOwner === undefined) return undefined;
  return {
    owner: profile.promptOptionOwner,
    definitionHash: hash(effectiveRisuControls(profile, preset.program)),
  };
}
function valuesFor(
  program: RisuPrompt | PromptControl[],
  value: Record<string, unknown>
): OptionValues {
  const input = value as OptionValues;
  const resolved = resolveControlValues(
    Array.isArray(program) ? program : promptControls(program),
    input
  );
  return Object.fromEntries(Object.keys(input).map((id) => [id, resolved[id]]));
}

export class ChatOptionsStore {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  private saved(chatId: string): {
    revision: number;
    binding: OptionBinding | null;
    values: OptionValues;
    definitions: PromptControl[];
  } {
    this.store.chat(chatId);
    const row = this.store.db
      .prepare('SELECT * FROM chat_prompt_options WHERE chat_id=?')
      .get(chatId) as Row | undefined;
    return row
      ? { revision: Number(row.revision), ...JSON.parse(String(row.body)) }
      : { revision: 0, binding: null, values: {}, definitions: [] };
  }
  private bump(
    chatId: string,
    replacement?: { binding: OptionBinding; values: OptionValues; definitions: PromptControl[] }
  ): number {
    const old = this.saved(chatId),
      revision = old.revision + 1;
    const body = replacement ?? {
      binding: old.binding,
      values: old.values,
      definitions: old.definitions,
    };
    this.store.db
      .prepare(
        'INSERT INTO chat_prompt_options VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,body=excluded.body'
      )
      .run(chatId, revision, json(body));
    this.store.event(chatId, 'options.updated', chatId);
    return revision;
  }
  private pending(chatId: string): PendingChatOptions[] {
    return (
      this.store.db
        .prepare('SELECT body FROM chat_option_pending WHERE chat_id=? ORDER BY rowid')
        .all(chatId) as Row[]
    ).map((row) => JSON.parse(String(row.body)) as PendingChatOptions);
  }

  get(chatId: string, source: ReferenceSource = 'library'): ChatOptionState {
    const profile = this.store.product.profile(chatId);
    const workspace = chatPromptWorkspace(this.store, profile.pinned, source),
      controls = effectiveRisuControls(
        resolvePackageProfile(this.store.product, profile),
        workspace.main.program
      ),
      binding = optionBinding(workspace.main, controls),
      saved = this.saved(chatId);
    const compatible = !saved.binding || isDeepStrictEqual(saved.binding, binding);
    const pending = this.pending(chatId);
    const conflicts: ChatOptionConflict[] = [];
    if (!compatible && Object.keys(saved.values).length) conflicts.push('fixed_definition_changed');
    if (pending.some((item) => !isDeepStrictEqual(item.binding, binding)))
      conflicts.push('pending_definition_changed');
    return {
      chatId,
      revision: saved.revision,
      binding,
      workspaceRevision: workspace.revision,
      program: workspace.main.program,
      controls,
      globalValues: resolveControlValues(controls, workspace.main.values),
      fixedValues: compatible ? valuesFor(controls, saved.values) : {},
      pending,
      conflicts,
    };
  }
  private write<B extends ChatOptionsCancel>(
    chatId: string,
    body: B,
    action: 'fixed' | 'oneoff' | 'cancel',
    requestId: string,
    apply: (body: B, state: ChatOptionState) => void
  ): ChatOptionState {
    const { operationId, expectedRevision: revision } = body;
    this.store.writableChat(chatId);
    const commandHash = hash({ action, chatId, body });
    return this.store.transaction(() => {
      const prior = this.store.db
        .prepare('SELECT chat_id,request_id,command_hash FROM chat_option_operations WHERE id=?')
        .get(operationId) as Row | undefined;
      if (prior) {
        if (
          prior.request_id !== requestId ||
          prior.command_hash !== commandHash ||
          prior.chat_id !== chatId
        )
          throw new HttpError(409, 'Option operation ID reused');
        return this.get(chatId);
      }
      const state = this.get(chatId);
      if (state.revision !== revision) throw new AppError(409, 'CHAT_OPTIONS_CHANGED');
      apply(body, state);
      const result = this.get(chatId);
      this.store.db
        .prepare('INSERT INTO chat_option_operations VALUES(?,?,?,?,?,?)')
        .run(operationId, chatId, requestId, commandHash, result.revision, now());
      return result;
    });
  }
  fixed(chatId: string, command: ChatOptionsCommand, requestId: string): ChatOptionState {
    return this.write(chatId, command, 'fixed', requestId, (body, state) => {
      this.assertBinding(body.binding, state);
      this.bump(chatId, {
        binding: state.binding,
        values: valuesFor(state.controls ?? state.program, body.values),
        definitions: state.controls ?? promptControls(state.program),
      });
    });
  }
  private assertBinding(binding: OptionBinding, state: ChatOptionState): void {
    if (!isDeepStrictEqual(binding, state.binding)) throw new AppError(409, 'REVISION_CONFLICT');
  }
  stage(chatId: string, command: ChatOptionsCommand, requestId: string): ChatOptionState {
    return this.write(chatId, command, 'oneoff', requestId, (body, state) => {
      this.assertBinding(body.binding, state);
      const values = valuesFor(state.controls ?? state.program, body.values);
      if (!Object.keys(values).length) throw new AppError(400, 'CHAT_OPTIONS_EMPTY');
      this.store.db.prepare('DELETE FROM chat_option_pending WHERE chat_id=?').run(chatId);
      const pending: PendingChatOptions = {
        id: randomUUID(),
        chatId,
        binding: state.binding,
        values,
        createdAt: now(),
      };
      this.store.db
        .prepare('INSERT INTO chat_option_pending VALUES(?,?,?)')
        .run(pending.id, chatId, json(pending));
      this.bump(chatId);
    });
  }

  cancel(
    chatId: string,
    pendingId: string,
    command: ChatOptionsCancel,
    requestId: string
  ): ChatOptionState {
    return this.write(chatId, { ...command, pendingId }, 'cancel', requestId, (_body, state) => {
      const pending = state.pending.find((item) => item.id === pendingId);
      if (!pending) throw new AppError(409, 'REVISION_CONFLICT');
      this.store.db.prepare('DELETE FROM chat_option_pending WHERE id=?').run(pendingId);
      this.bump(chatId);
    });
  }

  freeze(profile: ProfileSnapshot, runId?: string): void {
    const preset = profile.promptPresets?.main,
      ref = profile.prompts?.main;
    if (!preset || !ref) return;
    const state = this.get(profile.chatId);
    if (
      !isDeepStrictEqual(frozenOptionBinding(profile), state.binding) ||
      profile.promptWorkspaceRevision !== state.workspaceRevision
    )
      throw new AppError(409, 'REVISION_CONFLICT');
    const controls = effectiveRisuControls(profile, preset.program);
    const globalValues = resolveControlValues(
      controls,
      profile.chatOptions?.globalValues ??
        profile.promptControls?.[`${ref.id}@${ref.revision}`]?.values ??
        preset.values
    );
    const oneoffValues: OptionValues = {},
      pendingIds: string[] = [];
    if (runId)
      for (const pending of state.pending) {
        if (!isDeepStrictEqual(pending.binding, state.binding))
          throw new AppError(409, 'CHAT_OPTIONS_PENDING_STALE');
        Object.assign(oneoffValues, pending.values);
        pendingIds.push(pending.id);
        this.store.db.prepare('DELETE FROM chat_option_pending WHERE id=?').run(pending.id);
      }
    const values = resolveControlValues(controls, {
      ...globalValues,
      ...state.fixedValues,
      ...oneoffValues,
    });
    profile.chatOptions = {
      binding: state.binding,
      revision: state.revision,
      globalValues,
      fixedValues: state.fixedValues,
      oneoffValues,
      pendingIds,
      values,
    };
    profile.promptControls ??= {};
    profile.promptControls[`${ref.id}@${ref.revision}`] = { values, combinations: [] };
    if (pendingIds.length) this.bump(profile.chatId);
  }
}

const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str: Json = { type: 'string' };
export function helperOptionState({ program, controls, ...state }: ChatOptionState) {
  return { ...state, definitions: controls ?? promptControls(program) };
}
const optionValuesInput = (values: string): Json =>
  schema(
    {
      expectedRevision: {
        type: 'integer',
        minimum: 0,
        description: 'Revision from options.read.',
      },
      binding: {
        type: 'object',
        description: 'The binding object exactly as returned by options.read.',
        properties: { owner: str, definitionHash: str },
        required: ['owner', 'definitionHash'],
        additionalProperties: false,
      },
      values: { type: 'object', description: values },
    },
    ['expectedRevision', 'binding', 'values']
  );
export const helperOptionTools: ProviderTool[] = [
  {
    name: 'options.read',
    description:
      'Read the writing options of a chat: the option definitions of its prompt preset, the values fixed globally or for the chat, any values staged for the next request only, and conflicts between them. It returns the binding and the revision that options.oneoff and options.fix need. The prompt text itself is not included.',
    inputSchema: schema({}),
  },
  {
    name: 'options.oneoff',
    description:
      'Stage writing option values for the next request of a chat only, without changing its saved options. Use it when the user wants one upcoming reply written differently, for example longer or in another style. Take the option keys, allowed values, binding and revision from options.read.',
    inputSchema: optionValuesInput(
      'Option keys and their values for the next request, using the definitions from options.read.'
    ),
  },
  {
    name: 'options.fix',
    description:
      "Save the writing option values of a chat, used by every later request of that chat until changed. Use it when the user wants the chat written differently from now on; for one reply use options.oneoff. To change only some options, give set and unset: set fixes those options to the given values and unset returns those options to the prompt preset's global value, keeping every other fixed value. values instead replaces all of the chat's fixed values: an option left out is no longer fixed, and an empty object removes every chat-fixed value. Take the option keys, allowed values, binding and revision from options.read.",
    inputSchema: (() => {
      const input = optionValuesInput(
        'All option keys to fix for this chat and their values, replacing the current fixed values. Omit when using set or unset.'
      ) as { properties: Record<string, Json>; required: string[] };
      return {
        ...input,
        properties: {
          ...input.properties,
          set: {
            type: 'object',
            description: 'Option keys to fix and their values; other fixed values stay.',
          },
          unset: {
            type: 'array',
            items: str,
            description: 'Option keys to stop fixing; other fixed values stay.',
          },
        },
        required: ['expectedRevision', 'binding'],
      } as Json;
    })(),
  },
];
const optionValues = fixOptionsInput.shape.values;
const helperOptionInputs = {
  read: z.strictObject({}),
  stage: stageOptionsInput.omit({ chatId: true, operationId: true }),
  fix: fixOptionsInput.omit({ chatId: true, operationId: true, values: true }).extend({
    values: optionValues.optional(),
    set: optionValues.optional(),
    unset: z.array(z.string()).optional(),
  }),
  command: fixOptionsInput.omit({ chatId: true }),
};

export function invokeHelperOptions(
  store: Store,
  task: HelperTask,
  name: string,
  value: unknown,
  operationId: string
): unknown {
  const scope = task.snapshot.scope;
  if (scope.kind !== 'chat') throw new HelperToolError(403, 'CHAT_SCOPE_REQUIRED');
  const service = new ChatOptionsStore(store);
  const { chatId } = scope;
  const args = value === undefined ? {} : value;
  if (name === 'options.read') {
    parseInput(helperOptionInputs.read, args);
    return helperOptionState(service.get(chatId));
  }
  if (name === 'options.oneoff') {
    const input = parseInput(helperOptionInputs.stage, args);
    new HelperWorkspace(store).assertRunning(task.id);
    const command = parseInput(helperOptionInputs.command, { ...input, operationId });
    return helperOptionState(service.stage(chatId, command, task.id));
  }
  if (name !== 'options.fix') throw new HttpError(400, 'Unknown option tool');
  const { set, unset, ...saved } = parseInput(helperOptionInputs.fix, args);
  const workspace = new HelperWorkspace(store);
  workspace.assertRunning(task.id);
  store.writableChat(chatId);
  const current = service.get(chatId);
  const before = current.revision;
  let values = saved.values;
  if (set !== undefined || unset !== undefined) {
    if (values !== undefined) throw new HttpError(400, 'Give either values or set/unset, not both');
    const controls = new Set(current.controls?.map((control) => control.id));
    for (const id of unset ?? []) {
      if (!controls.has(id)) throw new HttpError(400, 'Unknown option to unset');
      if (Object.hasOwn(set ?? {}, id))
        throw new HttpError(400, 'Cannot set and unset the same option');
    }
    values = { ...current.fixedValues, ...set };
    for (const id of unset ?? []) delete values[id];
  }
  const command = parseInput(helperOptionInputs.command, { ...saved, values, operationId });
  const state = service.fixed(chatId, command, task.id);
  recordHelperTaskResult(workspace, task, {
    receiptId: `${task.id}:${operationId}`,
    operation: name,
    requestedTargets: 1,
    targets:
      state.revision === before
        ? []
        : [
            {
              kind: 'settings',
              id: chatId,
              title: store.chat(chatId).title,
              revision: state.revision,
              setting: 'chat.options',
            },
          ],
  });
  return helperOptionState(state);
}

export function chatOptionRoutes(app: FastifyInstance, store: Store): void {
  const service = new ChatOptionsStore(store);
  const endpoints = chatSettingsEndpoints,
    operations = chatSettingsOperations;
  const requestId = (operationId: string) => `ui:${operationId}`;
  registerEndpoint(app, endpoints.readOptions, operations.readOptions, ({ chatId }) =>
    service.get(chatId)
  );
  registerEndpoint(app, endpoints.fixOptions, operations.fixOptions, ({ chatId, ...command }) =>
    service.fixed(chatId, command, requestId(command.operationId))
  );
  registerEndpoint(app, endpoints.stageOptions, operations.stageOptions, ({ chatId, ...command }) =>
    service.stage(chatId, command, requestId(command.operationId))
  );
  registerEndpoint(
    app,
    endpoints.cancelStagedOptions,
    operations.cancelStagedOptions,
    ({ chatId, pendingId, ...command }) =>
      service.cancel(chatId, pendingId, command, requestId(command.operationId))
  );
}
