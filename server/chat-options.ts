import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import {
  promptOptionOwner,
  type OptionBinding,
  type OptionDelegation,
  type OptionValues,
  type PendingChatOptions,
  type ChatOptionState,
} from '../core/chat-options.js';
import type { HelperTask, HelperGrant } from '../core/helper.js';
import type { RunSnapshot } from '../core/types.js';
import type { CurrentPrompt, ProfileSnapshot } from '../core/product.js';
import {
  resolvePromptValues,
  validatePromptProgram,
  type PromptControl,
  type PromptProgram,
} from '../core/prompt-program.js';
import type { ProviderTool, Json } from '../core/transport.js';
import { HelperWorkspace } from './helper-workspace.js';
import { chatPromptWorkspace } from './prompt-workspace.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

type Row = Record<string, string | number | null>;
const json = JSON.stringify;
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const now = () => new Date().toISOString();
export const chatOptionTables = [
  'chat_prompt_options',
  'chat_option_pending',
  'chat_option_operations',
];
export function initChatOptions(store: Store): void {
  store.db.exec(`
    CREATE TABLE chat_prompt_options(chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE chat_option_pending(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,body TEXT NOT NULL);
    CREATE TABLE chat_option_operations(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,request_id TEXT NOT NULL,command_hash TEXT NOT NULL,command TEXT NOT NULL,intent TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
}
export type ChatOptionIntent = {
  action: 'fixed' | 'oneoff' | 'choose' | 'cancel' | 'delegate' | 'revoke';
  chatId: string;
  branchId: string;
  fields: string[];
};
/** A direct UI route or a separately verified helper grant creates this capability. */
export type ChatOptionAuthority = { requestId: string; assert: (intent: ChatOptionIntent) => void };
export function optionBinding(prompt: Pick<CurrentPrompt, 'presetId' | 'program'>): OptionBinding {
  return {
    owner: promptOptionOwner(prompt),
    definitionHash: hash(prompt.program.controls),
  };
}
/** The binding a frozen profile implies; its owner was recorded from the workspace at freeze time. */
function frozenOptionBinding(profile: ProfileSnapshot): OptionBinding | undefined {
  const preset = profile.promptPresets?.main;
  if (!preset || profile.promptOptionOwner === undefined) return undefined;
  return { owner: profile.promptOptionOwner, definitionHash: hash(preset.program.controls) };
}
const readBinding = (value: unknown): OptionBinding => {
  const b = record(value);
  fields(b, ['owner', 'definitionHash']);
  const result = {
    owner: text(b.owner, 'prompt owner', 200),
    definitionHash: text(b.definitionHash, 'option definition hash', 64),
  };
  if (!/^[a-f0-9]{64}$/u.test(result.definitionHash))
    throw new HttpError(400, 'Invalid option definition hash');
  return result;
};
function valuesFor(program: PromptProgram, value: unknown): OptionValues {
  const input = record(value) as OptionValues;
  const resolved = resolvePromptValues(program, input);
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
  delegations(chatId: string, branchId: string): OptionDelegation[] {
    return (
      this.store.db
        .prepare(
          'SELECT d.* FROM helper_delegations d JOIN helper_conversations c ON c.id=d.conversation_id WHERE c.chat_id=? AND c.branch_id=? ORDER BY d.rowid'
        )
        .all(chatId, branchId) as Row[]
    ).map(
      (row) =>
        ({
          ...JSON.parse(String(row.body)),
          revision: Number(row.revision),
          revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
        }) as OptionDelegation
    );
  }
  get(chatId: string, branchId?: string): ChatOptionState {
    const branch = this.store.product.branch(chatId, branchId),
      workspace = chatPromptWorkspace(this.store, this.store.product.profile(chatId).pinned),
      binding = optionBinding(workspace.main),
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
      globalValues: resolvePromptValues(workspace.main.program, workspace.main.values),
      fixedValues: compatible ? valuesFor(workspace.main.program, saved.values) : {},
      pending,
      delegations: this.delegations(chatId, branch.id),
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
        ? b.fields.map((v) => text(v, 'option field', 100))
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
        values: valuesFor(state.program, b.values),
        definitions: state.program.controls,
      });
    });
  }
  private assertBinding(value: unknown, state: ChatOptionState): void {
    if (!isDeepStrictEqual(readBinding(value), state.binding))
      conflict('프롬프트 소속이나 옵션 정의가 바뀌었어요.');
  }
  stage(
    chatId: string,
    value: unknown,
    authority: ChatOptionAuthority,
    delegated = false
  ): ChatOptionState {
    return this.write(
      chatId,
      value,
      delegated ? 'choose' : 'oneoff',
      authority,
      ['binding', 'values', 'expectedHeadRevision', ...(delegated ? ['delegationId'] : [])],
      (b, state) => {
        this.assertBinding(b.binding, state);
        if (b.expectedHeadRevision !== state.headRevision)
          conflict('옵션을 선택하는 동안 본편이 변경됐어요.');
        const values = valuesFor(state.program, b.values);
        if (!Object.keys(values).length)
          throw new HttpError(400, '한 개 이상의 옵션을 선택해 주세요.');
        let delegationId: string | undefined;
        let delegation: OptionDelegation | undefined;
        if (delegated) {
          delegationId = text(b.delegationId, 'delegation ID', 100);
          delegation = this.assertDelegation(state, delegationId, Object.keys(values));
          if (Object.keys(values).some((id) => Object.hasOwn(state.fixedValues, id)))
            conflict('사용자가 고정한 옵션은 도우미가 선택할 수 없어요.');
        }
        const kind = delegated ? 'delegated' : 'oneoff';
        for (const old of this.pending(chatId, state.branchId).filter(
          (item) =>
            item.kind === kind &&
            item.status === 'pending' &&
            (!delegated || item.delegationId === delegationId)
        ))
          this.updatePending({ ...old, status: 'superseded' });
        const pending: PendingChatOptions = {
          id: randomUUID(),
          chatId,
          branchId: state.branchId,
          kind,
          binding: state.binding,
          definitions: state.program.controls,
          values,
          ...(delegationId ? { delegationId, delegation } : {}),
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
  delegate(chatId: string, value: unknown, authority: ChatOptionAuthority): ChatOptionState {
    return this.write(
      chatId,
      value,
      'delegate',
      authority,
      ['binding', 'fields', 'conversationId'],
      (b, state) => {
        this.assertBinding(b.binding, state);
        if (!Array.isArray(b.fields) || !b.fields.length)
          throw new HttpError(400, '위임할 옵션을 선택해 주세요.');
        const selected = [...new Set(b.fields.map((v) => text(v, 'option field', 100)))];
        if (selected.some((id) => !state.program.controls.some((control) => control.id === id)))
          throw new HttpError(400, '실제 프롬프트 옵션만 위임할 수 있어요.');
        const workspace = new HelperWorkspace(this.store);
        const conversation =
          b.conversationId === undefined
            ? workspace.open({ kind: 'chat', chatId, branchId: state.branchId })
            : workspace.conversation(text(b.conversationId, 'helper conversation ID', 100));
        if (
          conversation.scope.kind !== 'chat' ||
          conversation.scope.chatId !== chatId ||
          conversation.scope.branchId !== state.branchId
        )
          throw new HttpError(403, '이 채팅 분기의 도우미 대화에만 위임할 수 있어요.');
        const item: OptionDelegation = {
          id: randomUUID(),
          revision: 1,
          conversationId: conversation.id,
          scope: { kind: 'chat', chatId, branchId: state.branchId },
          binding: state.binding,
          definitions: state.program.controls,
          fields: selected,
          startedAt: now(),
          revokedAt: null,
        };
        this.store.db
          .prepare('INSERT INTO helper_delegations VALUES(?,?,?,?,1,?,NULL,?)')
          .run(item.id, conversation.id, chatId, state.branchId, json(item), item.startedAt);
        workspace.event(conversation.id, null, 'delegation.created', { id: item.id });
        this.bump(chatId);
      }
    );
  }
  /** Deletion removes authority while retaining the exact proof used by past story runs. */
  detachConversation(conversationId: string): void {
    const conversation = new HelperWorkspace(this.store).conversation(conversationId);
    if (conversation.scope.kind !== 'chat') return;
    const { chatId, branchId } = conversation.scope;
    const delegations = this.delegations(chatId, branchId).filter(
      (item) => item.conversationId === conversationId
    );
    const oneoffIds = new Set<string>();
    for (const row of this.store.db
      .prepare(
        "SELECT o.result FROM chat_option_operations o JOIN helper_tasks t ON t.id=o.request_id WHERE t.conversation_id=? AND json_extract(o.intent,'$.action')='oneoff'"
      )
      .all(conversationId))
      for (const pending of (JSON.parse(String(row.result)) as ChatOptionState).pending)
        if (pending.kind === 'oneoff') oneoffIds.add(pending.id);
    if (!delegations.length && !oneoffIds.size) return;
    const ids = new Set(delegations.map((item) => item.id));
    this.store.db
      .prepare(
        'UPDATE helper_delegations SET revoked_at=?,revision=revision+1 WHERE conversation_id=? AND revoked_at IS NULL'
      )
      .run(now(), conversationId);
    for (const pending of this.pending(chatId, branchId))
      if (
        pending.status === 'pending' &&
        (oneoffIds.has(pending.id) || (pending.delegationId && ids.has(pending.delegationId)))
      )
        this.updatePending({ ...pending, status: 'cancelled' });
    this.bump(chatId);
  }
  revoke(
    chatId: string,
    delegationId: string,
    value: unknown,
    authority: ChatOptionAuthority
  ): ChatOptionState {
    return this.write(
      chatId,
      { ...record(value), delegationId },
      'revoke',
      authority,
      ['delegationId'],
      (_b, state) => {
        const delegation = state.delegations.find(
          (item) => item.id === delegationId && !item.revokedAt
        );
        if (!delegation) conflict('철회할 위임이 변경됐어요.');
        this.store.db
          .prepare(
            'UPDATE helper_delegations SET revoked_at=?,revision=revision+1 WHERE id=? AND revoked_at IS NULL'
          )
          .run(now(), delegationId);
        new HelperWorkspace(this.store).event(
          delegation!.conversationId,
          null,
          'delegation.revoked',
          { id: delegationId }
        );
        for (const item of state.pending.filter((item) => item.delegationId === delegationId))
          this.updatePending({ ...item, status: 'cancelled' });
        this.bump(chatId);
      }
    );
  }
  private assertDelegation(
    state: ChatOptionState,
    delegationId: string,
    ids: string[]
  ): OptionDelegation {
    const item = state.delegations.find((item) => item.id === delegationId && !item.revokedAt);
    if (
      !item ||
      !isDeepStrictEqual(item.binding, state.binding) ||
      ids.some((id) => !item.fields.includes(id))
    )
      throw new HttpError(403, '현재 채팅과 옵션 정의에 유효한 사용자 위임이 필요해요.');
    return item;
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
    const globalValues = resolvePromptValues(
      preset.program,
      profile.chatOptions?.globalValues ??
        profile.promptControls?.[`${ref.id}@${ref.revision}`]?.values ??
        preset.values
    );
    const delegatedValues: OptionValues = {},
      oneoffValues: OptionValues = {},
      pendingIds: string[] = [],
      delegationIds: string[] = [];
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
        if (pending.kind === 'delegated') {
          this.assertDelegation(state, pending.delegationId ?? '', Object.keys(pending.values));
          Object.assign(
            delegatedValues,
            Object.fromEntries(
              Object.entries(pending.values).filter(([id]) => !Object.hasOwn(state.fixedValues, id))
            )
          );
          delegationIds.push(pending.delegationId!);
        } else Object.assign(oneoffValues, pending.values);
        pendingIds.push(pending.id);
        this.updatePending({ ...pending, status: 'consumed', runId });
      }
    const values = resolvePromptValues(preset.program, {
      ...globalValues,
      ...state.fixedValues,
      ...delegatedValues,
      ...oneoffValues,
    });
    profile.chatOptions = {
      binding: state.binding,
      revision: state.revision,
      globalValues,
      fixedValues: state.fixedValues,
      delegatedValues,
      oneoffValues,
      pendingIds,
      delegationIds,
      values,
    };
    profile.promptControls ??= {};
    profile.promptControls[`${ref.id}@${ref.revision}`] = { values, combinations: [] };
    if (pendingIds.length) this.bump(profile.chatId);
  }
}

export function chatOptionGrants(
  store: Store,
  conversationId: string,
  requestId: string
): HelperGrant[] {
  const conversation = new HelperWorkspace(store).conversation(conversationId);
  if (conversation.scope.kind !== 'chat') return [];
  const service = new ChatOptionsStore(store),
    state = service.get(conversation.scope.chatId, conversation.scope.branchId);
  return state.delegations
    .filter(
      (item) =>
        item.conversationId === conversationId &&
        !item.revokedAt &&
        isDeepStrictEqual(item.binding, state.binding)
    )
    .map((item) => ({
      id: randomUUID(),
      requestId,
      target: item.id,
      actions: item.fields.map((id) => `options.choose:${id}`),
      provenance: 'delegation',
    }));
}
const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str: Json = { type: 'string' };
/** Model option decisions need definitions and receipts, not the unrelated prompt body. */
export function helperOptionState(
  { program, pending, ...state }: ChatOptionState,
  conversationId?: string
) {
  const delegations =
    conversationId === undefined
      ? state.delegations
      : state.delegations.filter((item) => item.conversationId === conversationId);
  const visible = new Set(delegations.map((item) => item.id));
  return {
    ...state,
    delegations,
    definitions: program.controls,
    // The current delegation list already carries the scope, definitions and revocation state.
    // Keep the choice's own frozen binding/definitions so old choices remain inspectable.
    pending: pending
      .filter(
        (item) =>
          conversationId === undefined ||
          item.kind !== 'delegated' ||
          visible.has(item.delegationId ?? '')
      )
      .map(({ delegation: _delegation, ...choice }) => choice),
  };
}
export const helperOptionTools: ProviderTool[] = [
  {
    name: 'options.read',
    description:
      'Read writing option definitions, global/fixed values, pending choices, conflicts and user delegations in this chat. Use definitions for allowed values and check delegation binding, fields and revokedAt before choosing. Prompt prose is omitted. Recommendation does not save.',
    inputSchema: schema({}),
  },
  {
    name: 'options.oneoff',
    description:
      'Apply explicit next-request option values only after a direct user instruction for this chat. Does not grant future discretion or change global settings. Read options first.',
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
  {
    name: 'options.choose',
    description:
      'Choose only unfixed fields covered by an active user delegation for the next main request. Cannot change models, prompts, global settings or grant permissions. Use values and binding returned by options.read; stable operationId and revision required.',
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
        delegationId: str,
        operationId: str,
      },
      [
        'expectedRevision',
        'binding',
        'values',
        'expectedHeadRevision',
        'delegationId',
        'operationId',
      ]
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
    return helperOptionState(service.get(scope.chatId, scope.branchId), task.conversationId);
  }
  if (name !== 'options.choose' && name !== 'options.oneoff')
    throw new HttpError(400, 'Unknown option tool');
  const b = record(value);
  const savedTask = new HelperWorkspace(store).task(task.id);
  if (savedTask.status !== 'running') throw new HttpError(409, 'HELPER_TASK_NO_LONGER_ACTIVE');
  if (
    savedTask.conversationId !== task.conversationId ||
    !isDeepStrictEqual(savedTask.snapshot.scope, scope)
  )
    throw new HttpError(403, 'Helper option scope changed');
  if (name === 'options.oneoff')
    return helperOptionState(
      service.stage(
        scope.chatId,
        { ...b, branchId: scope.branchId },
        {
          requestId: task.id,
          assert: () =>
            new HelperWorkspace(store).authorize(task.id, scope.chatId, 'options.oneoff'),
        }
      ),
      task.conversationId
    );
  const delegationId = text(b.delegationId, 'delegation ID', 100);
  return helperOptionState(
    service.stage(
      scope.chatId,
      { ...b, branchId: scope.branchId },
      {
        requestId: task.id,
        assert: (intent) => {
          if (
            intent.action !== 'choose' ||
            intent.chatId !== scope.chatId ||
            intent.branchId !== scope.branchId ||
            !service
              .delegations(scope.chatId, scope.branchId)
              .some(
                (item) =>
                  item.id === delegationId &&
                  item.conversationId === task.conversationId &&
                  !item.revokedAt
              ) ||
            !savedTask.snapshot.grants.some(
              (grant) =>
                grant.provenance === 'delegation' &&
                grant.target === delegationId &&
                intent.fields.every((id) => grant.actions.includes(`options.choose:${id}`))
            )
          )
            throw new HttpError(403, '이 작업에 사용자 옵션 위임이 없어요.');
        },
      },
      true
    ),
    task.conversationId
  );
}
export function chatOptionRoutes(app: FastifyInstance, store: Store): void {
  const service = new ChatOptionsStore(store);
  const authority = (body: unknown): ChatOptionAuthority => ({
    requestId: `ui:${text(record(body).operationId, 'operation ID', 100)}`,
    assert: () => {},
  });
  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/options',
    (request) => service.get(request.params.id, request.query.branchId)
  );
  for (const action of ['fixed', 'oneoff', 'delegations'] as const)
    app.post<{ Params: { id: string } }>(`/api/chats/:id/options/${action}`, (request) =>
      action === 'fixed'
        ? service.fixed(request.params.id, request.body, authority(request.body))
        : action === 'oneoff'
          ? service.stage(request.params.id, request.body, authority(request.body))
          : service.delegate(request.params.id, request.body, authority(request.body))
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
  app.post<{ Params: { id: string; delegationId: string } }>(
    '/api/chats/:id/options/delegations/:delegationId/revoke',
    (request) =>
      service.revoke(
        request.params.id,
        request.params.delegationId,
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
    'delegatedValues',
    'oneoffValues',
    'pendingIds',
    'delegationIds',
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
  const maps = [
    resolution.globalValues,
    resolution.fixedValues,
    resolution.delegatedValues,
    resolution.oneoffValues,
  ];
  for (const map of maps) valuesFor(preset.program, map);
  if (
    Object.keys(resolution.delegatedValues).some((id) => Object.hasOwn(resolution.fixedValues, id))
  )
    throw new HttpError(400, 'Delegated snapshot overrides fixed option');
  const values = resolvePromptValues(preset.program, Object.assign({}, ...maps));
  if (
    !isDeepStrictEqual(values, resolution.values) ||
    !isDeepStrictEqual(values, profile.promptControls?.[`${ref.id}@${ref.revision}`]?.values)
  )
    throw new HttpError(400, 'Invalid option snapshot resolution');
  for (const list of [resolution.pendingIds, resolution.delegationIds])
    if (
      !Array.isArray(list) ||
      list.some((id) => typeof id !== 'string') ||
      new Set(list).size !== list.length
    )
      throw new HttpError(400, 'Invalid option snapshot provenance');
}

function definitionProgram(binding: OptionBinding, definitions: unknown): PromptProgram {
  const checked = readBinding(binding);
  if (
    !/^(?:workspace:main|preset:.+)$/u.test(checked.owner) ||
    hash(definitions) !== checked.definitionHash
  )
    throw new HttpError(400, 'Invalid option definition ownership');
  return validatePromptProgram({
    version: 1,
    controls: definitions,
    blocks: [{ id: 'request', title: 'Request', kind: 'current' }],
  });
}
function validateDelegation(value: unknown): OptionDelegation {
  const b = record(value);
  fields(b, [
    'id',
    'revision',
    'conversationId',
    'scope',
    'binding',
    'fields',
    'startedAt',
    'revokedAt',
    'definitions',
  ]);
  const item = b as OptionDelegation,
    program = definitionProgram(item.binding, item.definitions);
  for (const key of ['id', 'conversationId', 'startedAt'] as const)
    text(item[key], `delegation ${key}`, 200);
  if (
    !Number.isFinite(Date.parse(item.startedAt)) ||
    (item.revokedAt !== null &&
      (!Number.isFinite(Date.parse(item.revokedAt)) || item.revokedAt < item.startedAt))
  )
    throw new HttpError(400, 'Invalid delegation lifetime');
  if (item.revision !== (item.revokedAt === null ? 1 : 2))
    throw new HttpError(400, 'Invalid delegation revision');
  const scope = record(item.scope);
  fields(scope, ['kind', 'chatId', 'branchId']);
  if (scope.kind !== 'chat') throw new HttpError(400, 'Invalid delegation scope');
  text(scope.chatId, 'delegation chat', 100);
  text(scope.branchId, 'delegation branch', 100);
  if (
    !Array.isArray(item.fields) ||
    !item.fields.length ||
    new Set(item.fields).size !== item.fields.length ||
    item.fields.some(
      (id) => typeof id !== 'string' || !program.controls.some((control) => control.id === id)
    )
  )
    throw new HttpError(400, 'Invalid delegation field whitelist');
  return item;
}
/** Current definitions may differ: archived bindings retain the actual controls that authorized each write. */
export function validateChatOptionArchive(store: Store): void {
  const delegations = new Map<string, OptionDelegation>();
  for (const row of store.db.prepare('SELECT * FROM helper_delegations').all() as Row[]) {
    const original = validateDelegation(JSON.parse(String(row.body)));
    const item = validateDelegation({
      ...original,
      revision: Number(row.revision),
      revokedAt: row.revoked_at,
    });
    const conversation =
      row.conversation_id === null
        ? null
        : new HelperWorkspace(store).conversation(String(row.conversation_id));
    if (
      item.id !== row.id ||
      original.revokedAt !== null ||
      original.revision !== 1 ||
      (conversation
        ? item.conversationId !== conversation.id ||
          !isDeepStrictEqual(item.scope, conversation.scope)
        : !item.revokedAt) ||
      item.scope.chatId !== row.chat_id ||
      item.scope.branchId !== row.branch_id ||
      row.created_at !== item.startedAt ||
      (!conversation &&
        store.db.prepare('SELECT 1 FROM helper_conversations WHERE id=?').get(item.conversationId))
    )
      throw new HttpError(400, 'Invalid archived delegation owner');
    store.product.branch(item.scope.chatId, item.scope.branchId);
    delegations.set(item.id, item);
  }
  for (const row of store.db.prepare('SELECT * FROM chat_prompt_options').all() as Row[]) {
    store.chat(String(row.chat_id));
    number(Number(row.revision), 'options revision');
    const b = record(JSON.parse(String(row.body)));
    fields(b, ['binding', 'values', 'definitions']);
    if (b.binding === null) {
      if (
        Object.keys(record(b.values)).length ||
        !Array.isArray(b.definitions) ||
        b.definitions.length
      )
        throw new HttpError(400, 'Invalid unbound chat options');
    } else valuesFor(definitionProgram(b.binding, b.definitions), b.values);
  }
  const pendingById = new Map<string, PendingChatOptions>();
  for (const row of store.db.prepare('SELECT * FROM chat_option_pending').all() as Row[]) {
    const b = record(JSON.parse(String(row.body)));
    fields(b, [
      'id',
      'chatId',
      'branchId',
      'kind',
      'binding',
      'values',
      'delegationId',
      'headRevision',
      'headHash',
      'status',
      'runId',
      'createdAt',
      'definitions',
      'delegation',
      'origin',
    ]);
    const item = b as PendingChatOptions;
    if (
      item.id !== row.id ||
      item.chatId !== row.chat_id ||
      item.branchId !== row.branch_id ||
      !['oneoff', 'delegated'].includes(item.kind) ||
      !['pending', 'consumed', 'cancelled', 'superseded'].includes(item.status) ||
      !Number.isFinite(Date.parse(item.createdAt))
    )
      throw new HttpError(400, 'Invalid pending option identity');
    store.product.branch(item.chatId, item.branchId);
    if (
      !Object.keys(valuesFor(definitionProgram(item.binding, item.definitions), item.values)).length
    )
      throw new HttpError(400, 'Invalid empty pending options');
    if (
      item.headRevision === null
        ? item.headHash !== null
        : store.sourceAtHash(
            text(item.headRevision, 'option source', 100),
            text(item.headHash, 'option source hash', 64)
          ).chatId !== item.chatId
    )
      throw new HttpError(400, 'Invalid pending option source');
    if (item.kind === 'delegated') {
      const proof = validateDelegation(item.delegation);
      if (
        proof.id !== item.delegationId ||
        proof.revokedAt !== null ||
        !isDeepStrictEqual(proof.binding, item.binding) ||
        Object.keys(item.values).some((id) => !proof.fields.includes(id)) ||
        proof.startedAt > item.createdAt
      )
        throw new HttpError(400, 'Invalid pending option delegation');
      if (!item.origin) {
        const live = delegations.get(proof.id);
        if (
          !live ||
          !isDeepStrictEqual(proof, { ...live, revision: 1, revokedAt: null }) ||
          proof.scope.chatId !== item.chatId ||
          proof.scope.branchId !== item.branchId ||
          (live.revokedAt && item.createdAt > live.revokedAt) ||
          (item.status === 'pending' && live.revokedAt)
        )
          throw new HttpError(400, 'Invalid pending option delegation owner');
      }
    } else if (item.delegation || item.delegationId)
      throw new HttpError(400, 'Oneoff options cannot confer delegation');
    if (item.status === 'consumed') {
      const run = store.run(text(item.runId, 'consuming run', 100));
      if (
        run.chatId !== item.chatId ||
        run.snapshot.branchId !== item.branchId ||
        run.snapshot.parentRevision !== item.headRevision ||
        !run.snapshot.profile?.chatOptions?.pendingIds.includes(item.id)
      )
        throw new HttpError(400, 'Invalid option consuming run');
      if (item.origin) {
        const origin = record(item.origin);
        fields(origin, ['pendingId', 'chatId', 'branchId', 'runId']);
        for (const key of ['pendingId', 'chatId', 'branchId', 'runId'])
          text(origin[key], `option origin ${key}`, 100);
        if (
          item.id !== forkPendingId(item.chatId, origin.pendingId) ||
          run.snapshot.forkedFrom?.chatId !== origin.chatId ||
          run.snapshot.forkedFrom?.runId !== origin.runId
        )
          throw new HttpError(400, 'Invalid fork option provenance');
      }
    } else if (item.runId !== null || item.origin)
      throw new HttpError(400, 'Unconsumed option cannot own a run');
    pendingById.set(item.id, item);
  }
  for (const row of store.db.prepare('SELECT id,chat_id,snapshot FROM runs').all() as Row[]) {
    const snapshot = JSON.parse(String(row.snapshot)) as RunSnapshot,
      resolution = snapshot.profile?.chatOptions;
    if (!resolution || !snapshot.profile) continue;
    validateChatOptionSnapshot(snapshot.profile);
    const selected = resolution.pendingIds.map((id) => pendingById.get(id));
    if (
      selected.some(
        (item) =>
          !item ||
          item.status !== 'consumed' ||
          item.chatId !== row.chat_id ||
          item.runId !== row.id ||
          item.branchId !== snapshot.branchId ||
          !isDeepStrictEqual(item.binding, resolution.binding)
      )
    )
      throw new HttpError(400, 'Invalid snapshot option owner');
    const delegatedValues: OptionValues = {},
      oneoffValues: OptionValues = {},
      delegationIds: string[] = [];
    for (const item of selected as PendingChatOptions[]) {
      if (item.kind === 'delegated') {
        Object.assign(
          delegatedValues,
          Object.fromEntries(
            Object.entries(item.values).filter(([id]) => !Object.hasOwn(resolution.fixedValues, id))
          )
        );
        delegationIds.push(item.delegationId!);
      } else Object.assign(oneoffValues, item.values);
    }
    if (
      !isDeepStrictEqual(delegatedValues, resolution.delegatedValues) ||
      !isDeepStrictEqual(oneoffValues, resolution.oneoffValues) ||
      !isDeepStrictEqual(delegationIds, resolution.delegationIds)
    )
      throw new HttpError(400, 'Invalid snapshot option selection provenance');
  }
  for (const row of store.db.prepare('SELECT * FROM chat_option_operations').all() as Row[]) {
    store.chat(String(row.chat_id));
    text(row.id, 'option operation', 100);
    text(row.request_id, 'option request', 200);
    if (
      typeof row.command_hash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(row.command_hash) ||
      !Number.isFinite(Date.parse(String(row.created_at)))
    )
      throw new HttpError(400, 'Invalid option operation receipt');
    const intent = record(JSON.parse(String(row.intent)));
    fields(intent, ['action', 'chatId', 'branchId', 'fields']);
    const command = record(JSON.parse(String(row.command)));
    fields(command, ['action', 'chatId', 'body']);
    const body = record(command.body);
    const result = record(JSON.parse(String(row.result)));
    fields(result, [
      'chatId',
      'branchId',
      'revision',
      'binding',
      'workspaceRevision',
      'program',
      'globalValues',
      'fixedValues',
      'pending',
      'delegations',
      'conflicts',
      'headRevision',
    ]);
    if (
      !['fixed', 'oneoff', 'choose', 'cancel', 'delegate', 'revoke'].includes(intent.action) ||
      intent.chatId !== row.chat_id ||
      result.chatId !== row.chat_id ||
      result.branchId !== intent.branchId ||
      !Array.isArray(intent.fields) ||
      intent.fields.some((id: unknown) => typeof id !== 'string')
    )
      throw new HttpError(400, 'Invalid option receipt scope');
    if (
      hash(command) !== row.command_hash ||
      command.action !== intent.action ||
      command.chatId !== intent.chatId ||
      body.operationId !== row.id ||
      (body.branchId !== undefined && body.branchId !== intent.branchId) ||
      result.revision !== Number(body.expectedRevision) + 1
    )
      throw new HttpError(400, 'Invalid option receipt command');
    const program = validatePromptProgram(result.program);
    definitionProgram(result.binding, program.controls);
    valuesFor(program, result.globalValues);
    valuesFor(program, result.fixedValues);
    if (
      intent.action === 'fixed' &&
      !isDeepStrictEqual(valuesFor(program, body.values), result.fixedValues)
    )
      throw new HttpError(400, 'Invalid fixed option receipt');
    if (
      !Array.isArray(result.pending) ||
      !Array.isArray(result.delegations) ||
      !Array.isArray(result.conflicts) ||
      result.conflicts.some((item: unknown) => typeof item !== 'string')
    )
      throw new HttpError(400, 'Invalid option receipt result');
    for (const proof of result.delegations) {
      const item = validateDelegation(proof),
        live = delegations.get(item.id);
      if (
        !live ||
        item.scope.chatId !== row.chat_id ||
        item.scope.branchId !== intent.branchId ||
        !isDeepStrictEqual({ ...live, revision: item.revision, revokedAt: item.revokedAt }, item) ||
        (item.revokedAt && item.revokedAt !== live.revokedAt)
      )
        throw new HttpError(400, 'Invalid delegation receipt history');
    }
    if (intent.action === 'oneoff' || intent.action === 'choose') {
      const chosen = result.pending.filter(
        (item: PendingChatOptions) =>
          item.kind === (intent.action === 'oneoff' ? 'oneoff' : 'delegated') &&
          (!body.delegationId || item.delegationId === body.delegationId)
      );
      if (
        chosen.length !== 1 ||
        !isDeepStrictEqual(chosen[0].values, body.values) ||
        !isDeepStrictEqual(chosen[0].binding, body.binding) ||
        chosen[0].headRevision !== body.expectedHeadRevision
      )
        throw new HttpError(400, 'Invalid pending option receipt');
    }
    store.product.branch(String(row.chat_id), intent.branchId);
    number(result.revision, 'option receipt revision');
    if (
      result.revision >
      Number(
        (
          store.db
            .prepare('SELECT revision FROM chat_prompt_options WHERE chat_id=?')
            .get(row.chat_id) as Row
        )?.revision ?? 0
      )
    )
      throw new HttpError(400, 'Invalid option receipt revision');
  }
}

const forkPendingId = (chatId: string, pendingId: string) =>
  `fork-option:${hash({ chatId, pendingId }).slice(0, 48)}`;
export function mapForkChatOptionSnapshot(
  profile: ProfileSnapshot | undefined,
  chatId: string
): void {
  if (profile?.chatOptions)
    profile.chatOptions.pendingIds = profile.chatOptions.pendingIds.map((id) =>
      forkPendingId(chatId, id)
    );
}
/** Only immutable options already consumed by copied Runs follow a fork. No live choice or permission does. */
export function copyChatOptionsInTransaction(
  store: Store,
  fromChatId: string,
  toChatId: string,
  branchId: string,
  sources: Map<string, string>,
  runs: Map<string, string>
): void {
  for (const row of store.db
    .prepare('SELECT body FROM chat_option_pending WHERE chat_id=?')
    .all(fromChatId) as Row[]) {
    const old = JSON.parse(String(row.body)) as PendingChatOptions;
    if (old.status !== 'consumed' || !old.runId || !runs.has(old.runId)) continue;
    const item: PendingChatOptions = {
      ...old,
      id: forkPendingId(toChatId, old.id),
      chatId: toChatId,
      branchId,
      runId: runs.get(old.runId)!,
      headRevision: old.headRevision ? (sources.get(old.headRevision) ?? null) : null,
      origin: { pendingId: old.id, chatId: fromChatId, branchId: old.branchId, runId: old.runId },
    };
    if (old.headRevision && !item.headRevision)
      throw new HttpError(400, 'Fork option source missing');
    store.db
      .prepare('INSERT INTO chat_option_pending VALUES(?,?,?,?)')
      .run(item.id, toChatId, branchId, json(item));
  }
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
