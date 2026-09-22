import { promptControls } from '../core/risu-prompt.js';
import { effectiveRisuControls } from '../core/risu-effective-controls.js';
import { resolvePackageProfile } from './package-features.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import {
  promptOptionOwner,
  type OptionBinding,
  type OptionValues,
  type PendingChatOptions,
  type ChatOptionState,
} from '../core/chat-options.js';
import type { HelperTask } from '../core/helper.js';
import type { CurrentPrompt, ProfileSnapshot } from '../core/product.js';
import { resolveControlValues, type PromptControl, type RisuPrompt } from '../core/risu-prompt.js';
import type { ProviderTool, Json } from '../core/transport.js';
import { HelperWorkspace } from './helper-workspace.js';
import { chatPromptWorkspace } from './prompt-workspace.js';
import { fields, HttpError, isSha256Hex, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

type Row = Record<string, string | number | null>;
const json = JSON.stringify;
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const now = () => new Date().toISOString();

export function initChatOptions(store: Store): void {
  store.db.exec(`
    CREATE TABLE chat_prompt_options(chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE chat_option_pending(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,body TEXT NOT NULL);
    CREATE TABLE chat_option_operations(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,request_id TEXT NOT NULL,command_hash TEXT NOT NULL,command TEXT NOT NULL,intent TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
}
export type ChatOptionIntent = {
  action: 'fixed' | 'oneoff' | 'cancel';
  chatId: string;
  branchId: string;
  fields: string[];
};
/** Identifies a write and checks that its owning helper task is still active. */
export type ChatOptionAuthority = { requestId: string; assert: (intent: ChatOptionIntent) => void };
export function optionBinding(
  prompt: Pick<CurrentPrompt, 'presetId' | 'program'>,
  controls = promptControls(prompt.program)
): OptionBinding {
  return {
    owner: promptOptionOwner(prompt),
    definitionHash: hash(controls),
  };
}
/** The binding a frozen profile implies; its owner was recorded from the workspace at freeze time. */
function frozenOptionBinding(profile: ProfileSnapshot): OptionBinding | undefined {
  const preset = profile.promptPresets?.main;
  if (!preset || profile.promptOptionOwner === undefined) return undefined;
  return {
    owner: profile.promptOptionOwner,
    definitionHash: hash(frozenOptionControls(profile, preset.program)),
  };
}
function frozenOptionControls(profile: ProfileSnapshot, program: RisuPrompt): PromptControl[] {
  return effectiveRisuControls(profile, program);
}
const readBinding = (value: unknown): OptionBinding => {
  const b = record(value);
  fields(b, ['owner', 'definitionHash']);
  const result = {
    owner: text(b.owner, 'prompt owner', 200),
    definitionHash: text(b.definitionHash, 'option definition hash', 64),
  };
  if (!isSha256Hex(result.definitionHash))
    throw new HttpError(400, 'Invalid option definition hash');
  return result;
};
function valuesFor(program: RisuPrompt | PromptControl[], value: unknown): OptionValues {
  const input = record(value) as OptionValues;
  const resolved = resolveControlValues(
    Array.isArray(program) ? program : promptControls(program),
    input
  );
  return Object.fromEntries(Object.keys(input).map((id) => [id, resolved[id]]));
}
function headHash(store: Store, revision: string | null): string | null {
  if (!revision) return null;
  return (
    store.history(revision).at(-1)?.contentHash ??
    createHash('sha256').update(store.source(revision).text).digest('hex')
  );
}
const conflict = (message: string): never => {
  throw new HttpError(409, message);
};

export class ChatOptionsStore {
  constructor(readonly store: Store) {}
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
  private pending(chatId: string, branchId: string): PendingChatOptions[] {
    return (
      this.store.db
        .prepare(
          'SELECT body FROM chat_option_pending WHERE chat_id=? AND branch_id=? ORDER BY rowid'
        )
        .all(chatId, branchId) as Row[]
    ).map((row) => JSON.parse(String(row.body)) as PendingChatOptions);
  }

  get(chatId: string, branchId?: string): ChatOptionState {
    const profile = this.store.product.profile(chatId);
    const branch = this.store.product.branch(chatId, branchId),
      workspace = chatPromptWorkspace(this.store, profile.pinned),
      controls = effectiveRisuControls(
        resolvePackageProfile(this.store.product, profile),
        workspace.main.program
      ),
      binding = optionBinding(workspace.main, controls),
      saved = this.saved(chatId);
    const compatible = !saved.binding || isDeepStrictEqual(saved.binding, binding);
    const pending = this.pending(chatId, branch.id).filter((item) => item.status === 'pending');
    const conflicts: string[] = [];
    if (!compatible && Object.keys(saved.values).length)
      conflicts.push(
        '프롬프트 소속이나 옵션 정의가 바뀌어 이전 채팅 고정값을 적용하지 않아요. 현재 정의로 다시 저장해 주세요.'
      );
    for (const item of pending) {
      if (!isDeepStrictEqual(item.binding, binding))
        conflicts.push(
          '다음 요청 옵션의 프롬프트 정의가 바뀌었어요. 선택을 취소하고 다시 지정해 주세요.'
        );
      else if (
        item.headRevision !== branch.headRevision ||
        item.headHash !== headHash(this.store, branch.headRevision)
      )
        conflicts.push(
          '다음 요청 옵션을 선택한 뒤 본편이 바뀌었어요. 선택을 취소하고 다시 지정해 주세요.'
        );
    }
    return {
      chatId,
      branchId: branch.id,
      revision: saved.revision,
      binding,
      workspaceRevision: workspace.revision,
      program: workspace.main.program,
      controls,
      globalValues: resolveControlValues(controls, workspace.main.values),
      fixedValues: compatible ? valuesFor(controls, saved.values) : {},
      pending,
      conflicts,
      headRevision: branch.headRevision,
    };
  }
  private write(
    chatId: string,
    value: unknown,
    action: ChatOptionIntent['action'],
    authority: ChatOptionAuthority,
    allowed: string[],
    apply: (b: Record<string, unknown>, state: ChatOptionState) => unknown
  ): ChatOptionState {
    const b = record(value);
    fields(b, ['branchId', 'expectedRevision', 'operationId', ...allowed]);
    const operationId = text(b.operationId, 'operation ID', 100),
      requestId = text(authority.requestId, 'request ID', 200);
    const revision = number(b.expectedRevision, 'options revision', 0, Number.MAX_SAFE_INTEGER);
    const branch = this.store.product.branch(
      chatId,
      b.branchId === undefined ? undefined : text(b.branchId, 'branch ID', 100)
    );
    const selectedFields = b.values
      ? Object.keys(record(b.values))
      : Array.isArray(b.fields)
        ? b.fields.map((v) => text(v, 'option field', 1500))
        : [];
    const intent: ChatOptionIntent = {
      action,
      chatId,
      branchId: branch.id,
      fields: selectedFields,
    };
    const command = { action, chatId, body: b },
      commandHash = hash(command);
    return this.store.transaction(() => {
      authority.assert(intent);
      const prior = this.store.db
        .prepare('SELECT * FROM chat_option_operations WHERE id=?')
        .get(operationId) as Row | undefined;
      if (prior) {
        if (
          prior.request_id !== requestId ||
          prior.command_hash !== commandHash ||
          prior.chat_id !== chatId
        )
          conflict('옵션 요청 키가 다른 작업에 사용됐어요.');
        return JSON.parse(String(prior.result)) as ChatOptionState;
      }
      const state = this.get(chatId, branch.id);
      if (state.revision !== revision)
        conflict('채팅 옵션이 변경됐어요. 입력은 유지하고 최신 설정을 확인해 주세요.');
      apply(b, state);
      const result = this.get(chatId, branch.id);
      this.store.db
        .prepare('INSERT INTO chat_option_operations VALUES(?,?,?,?,?,?,?,?)')
        .run(
          operationId,
          chatId,
          requestId,
          commandHash,
          json(command),
          json(intent),
          json(result),
          now()
        );
      return result;
    });
  }
  fixed(chatId: string, value: unknown, authority: ChatOptionAuthority): ChatOptionState {
    return this.write(chatId, value, 'fixed', authority, ['binding', 'values'], (b, state) => {
      this.assertBinding(b.binding, state);
      this.bump(chatId, {
        binding: state.binding,
        values: valuesFor(state.controls ?? state.program, b.values),
        definitions: state.controls ?? promptControls(state.program),
      });
    });
  }
  private assertBinding(value: unknown, state: ChatOptionState): void {
    if (!isDeepStrictEqual(readBinding(value), state.binding))
      conflict('프롬프트 소속이나 옵션 정의가 바뀌었어요.');
  }
  stage(chatId: string, value: unknown, authority: ChatOptionAuthority): ChatOptionState {
    return this.write(
      chatId,
      value,
      'oneoff',
      authority,
      ['binding', 'values', 'expectedHeadRevision'],
      (body, state) => {
        this.assertBinding(body.binding, state);
        if (body.expectedHeadRevision !== state.headRevision)
          conflict('옵션을 선택하는 동안 본편이 변경됐어요.');
        const values = valuesFor(state.controls ?? state.program, body.values);
        if (!Object.keys(values).length)
          throw new HttpError(400, '한 개 이상의 옵션을 선택해 주세요.');
        for (const pending of state.pending)
          this.updatePending({ ...pending, status: 'superseded' });
        const pending: PendingChatOptions = {
          id: randomUUID(),
          chatId,
          branchId: state.branchId,
          kind: 'oneoff',
          binding: state.binding,
          definitions: state.controls ?? promptControls(state.program),
          values,
          headRevision: state.headRevision,
          headHash: headHash(this.store, state.headRevision),
          status: 'pending',
          runId: null,
          createdAt: now(),
        };
        this.store.db
          .prepare('INSERT INTO chat_option_pending VALUES(?,?,?,?)')
          .run(pending.id, chatId, state.branchId, json(pending));
        this.bump(chatId);
      }
    );
  }
  private updatePending(item: PendingChatOptions): void {
    this.store.db
      .prepare('UPDATE chat_option_pending SET body=? WHERE id=?')
      .run(json(item), item.id);
  }
  cancel(
    chatId: string,
    pendingId: string,
    value: unknown,
    authority: ChatOptionAuthority
  ): ChatOptionState {
    return this.write(
      chatId,
      { ...record(value), pendingId },
      'cancel',
      authority,
      ['pendingId'],
      (_b, state) => {
        const pending = state.pending.find((item) => item.id === pendingId);
        if (!pending) conflict('취소할 다음 요청 옵션이 변경됐어요.');
        this.updatePending({ ...pending!, status: 'cancelled' });
        this.bump(chatId);
      }
    );
  }

  freeze(profile: ProfileSnapshot, branchId: string, runId?: string): void {
    const preset = profile.promptPresets?.main,
      ref = profile.prompts?.main;
    if (!preset || !ref) return;
    const state = this.get(profile.chatId, branchId);
    if (
      !isDeepStrictEqual(frozenOptionBinding(profile), state.binding) ||
      profile.promptWorkspaceRevision !== state.workspaceRevision
    )
      conflict('옵션 예약 전 현재 프롬프트가 변경됐어요.');
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
        if (
          !isDeepStrictEqual(pending.binding, state.binding) ||
          pending.headRevision !== state.headRevision ||
          pending.headHash !== headHash(this.store, state.headRevision)
        )
          conflict(
            '다음 요청 옵션의 본편이나 프롬프트가 바뀌었어요. 창작 옵션에서 선택을 다시 지정해 주세요.'
          );
        Object.assign(oneoffValues, pending.values);
        pendingIds.push(pending.id);
        this.updatePending({ ...pending, status: 'consumed', runId });
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
/** Model option decisions need definitions and receipts, not the unrelated prompt body. */
export function helperOptionState({ program, ...state }: ChatOptionState) {
  return { ...state, definitions: state.controls ?? promptControls(program) };
}
export const helperOptionTools: ProviderTool[] = [
  {
    name: 'options.read',
    description:
      'Read writing option definitions, global/fixed values, pending one-off values and conflicts. Use the current definitions and revision when saving. Prompt prose is omitted.',
    inputSchema: schema({}),
  },
  {
    name: 'options.oneoff',
    description:
      'Set next-request option values for the selected chat. Read options first for definitions and the current revision.',
    inputSchema: schema(
      {
        expectedRevision: { type: 'integer', minimum: 0 },
        binding: {
          type: 'object',
          properties: { owner: str, definitionHash: str },
          required: ['owner', 'definitionHash'],
          additionalProperties: false,
        },
        values: { type: 'object' },
        expectedHeadRevision: { type: ['string', 'null'] },
        operationId: str,
      },
      ['expectedRevision', 'binding', 'values', 'expectedHeadRevision', 'operationId']
    ),
  },
];
export function invokeHelperOptions(
  store: Store,
  task: HelperTask,
  name: string,
  value: unknown
): unknown {
  const scope = task.snapshot.scope;
  if (scope.kind !== 'chat') throw new HttpError(403, '채팅에서만 창작 옵션을 선택할 수 있어요.');
  const service = new ChatOptionsStore(store);
  if (name === 'options.read') {
    fields(record(value), []);
    return helperOptionState(service.get(scope.chatId, scope.branchId));
  }
  if (name !== 'options.oneoff') throw new HttpError(400, 'Unknown option tool');
  new HelperWorkspace(store).assertRunning(task.id);
  return helperOptionState(
    service.stage(
      scope.chatId,
      { ...record(value), branchId: scope.branchId },
      {
        requestId: task.id,
        assert: () => new HelperWorkspace(store).assertRunning(task.id),
      }
    )
  );
}

export function chatOptionRoutes(app: FastifyInstance, store: Store): void {
  const service = new ChatOptionsStore(store);
  const authority = (body: unknown): ChatOptionAuthority => ({
    requestId: 'ui:' + text(record(body).operationId, 'operation ID', 100),
    assert: () => {},
  });
  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/options',
    (request) => service.get(request.params.id, request.query.branchId)
  );
  app.post<{ Params: { id: string } }>('/api/chats/:id/options/fixed', (request) =>
    service.fixed(request.params.id, request.body, authority(request.body))
  );
  app.post<{ Params: { id: string } }>('/api/chats/:id/options/oneoff', (request) =>
    service.stage(request.params.id, request.body, authority(request.body))
  );
  app.post<{ Params: { id: string; pendingId: string } }>(
    '/api/chats/:id/options/pending/:pendingId/cancel',
    (request) =>
      service.cancel(
        request.params.id,
        request.params.pendingId,
        request.body,
        authority(request.body)
      )
  );
}

export function validateChatOptionSnapshot(profile: ProfileSnapshot): void {
  if (!profile.chatOptions) return;
  const value = record(profile.chatOptions);
  fields(value, [
    'binding',
    'revision',
    'globalValues',
    'fixedValues',
    'oneoffValues',
    'pendingIds',
    'values',
  ]);
  const resolution = profile.chatOptions,
    preset = profile.promptPresets?.main,
    ref = profile.prompts?.main;
  if (
    !preset ||
    !ref ||
    !isDeepStrictEqual(readBinding(resolution.binding), frozenOptionBinding(profile))
  )
    throw new HttpError(400, 'Invalid option snapshot binding');
  number(resolution.revision, 'option revision', 0, Number.MAX_SAFE_INTEGER);
  const maps = [resolution.globalValues, resolution.fixedValues, resolution.oneoffValues];
  const controls = frozenOptionControls(profile, preset.program);
  for (const map of maps) valuesFor(controls, map);
  const values = resolveControlValues(controls, Object.assign({}, ...maps));
  if (
    !isDeepStrictEqual(values, resolution.values) ||
    !isDeepStrictEqual(values, profile.promptControls?.[`${ref.id}@${ref.revision}`]?.values)
  )
    throw new HttpError(400, 'Invalid option snapshot resolution');
  for (const list of [resolution.pendingIds])
    if (
      !Array.isArray(list) ||
      list.some((id) => typeof id !== 'string') ||
      new Set(list).size !== list.length
    )
      throw new HttpError(400, 'Invalid option snapshot provenance');
}

export function deleteChatOptionSourcesInTransaction(
  store: Store,
  chatId: string,
  sources: Set<string>,
  runs: Set<string>
): void {
  for (const row of store.db
    .prepare('SELECT body FROM chat_option_pending WHERE chat_id=?')
    .all(chatId) as Row[]) {
    const item = JSON.parse(String(row.body)) as PendingChatOptions;
    if (
      (item.headRevision && sources.has(item.headRevision)) ||
      (item.runId && runs.has(item.runId))
    )
      store.db.prepare('DELETE FROM chat_option_pending WHERE id=?').run(item.id);
  }
}
