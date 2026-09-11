import { createHash } from 'node:crypto';
import type { ChatLoreOverride } from '../core/chat-overrides.js';
import type {
  ChatOptionState,
  OptionDelegation,
  PendingChatOptions,
} from '../core/chat-options.js';
import type { DraftProposal, EditDraft } from '../core/edit-drafts.js';
import type { HelperGrant, HelperScope, HelperTaskSnapshot } from '../core/helper.js';
import type { RunSnapshot } from '../core/types.js';
import type { BackupRemap, BackupRow } from './chat-backup-remap.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is BackupRow =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Map owned references only. Draft buffers, shared material, option values, lore text and model
 * responses keep their exact content. This runs before snapshot/checkpoint hash reconstruction.
 */
export function remapChatBackupHelper(ctx: BackupRemap): void {
  const { tables, id } = ctx;
  const rows = (table: string) => tables[table] ?? [];
  const json = <T>(row: BackupRow, column: string, map: (value: T) => T) => {
    if (row[column] !== null && row[column] !== undefined) {
      const value = JSON.parse(row[column]) as T;
      if (value !== null) row[column] = JSON.stringify(map(value));
    }
  };
  const scope = (value: HelperScope): HelperScope =>
    value.kind === 'chat'
      ? { ...value, chatId: id(value.chatId), branchId: id(value.branchId) }
      : { ...value };
  const grant = (value: HelperGrant): HelperGrant => ({
    ...value,
    id: id(value.id),
    requestId: ctx.key(value.requestId),
    target: id(value.target),
  });
  const editorKeys = new Map<string, string>();
  for (const row of ctx.originalTables.edit_drafts ?? [])
    editorKeys.set(row.editor_key, `backup:${ctx.chatId}:${hash(row.editor_key).slice(0, 32)}`);
  const draft = (value: EditDraft): EditDraft => ({
    ...value,
    id: id(value.id),
    editorKey: editorKeys.get(value.editorKey) ?? value.editorKey,
    ...(value.kind === 'prompt-workspace' ? { backupOrigin: { chatId: ctx.chatId } } : {}),
  });
  const proposal = (value: DraftProposal): DraftProposal => ({
    ...value,
    id: id(value.id),
    draftId: id(value.draftId),
  });
  const draftResult = (value: BackupRow): BackupRow => {
    if (typeof value.baseHash === 'string' && typeof value.editorKey === 'string')
      return draft(value as EditDraft);
    const mapped = { ...value };
    if (object(value.draft)) mapped.draft = draft(value.draft as EditDraft);
    if (object(value.proposal)) mapped.proposal = proposal(value.proposal as DraftProposal);
    if (typeof value.operationId === 'string') mapped.operationId = id(value.operationId);
    return mapped;
  };
  const lore = (value: ChatLoreOverride): ChatLoreOverride => ({
    ...value,
    id: id(value.id),
    chatId: id(value.chatId),
    atSource: id(value.atSource),
  });
  const loreResult = (value: BackupRow): BackupRow => ({
    ...value,
    ...(object(value.entry) ? { entry: lore(value.entry as ChatLoreOverride) } : {}),
    ...(typeof value.chatId === 'string'
      ? {
          chatId: id(value.chatId),
          branchId: id(value.branchId),
          headRevision: id(value.headRevision),
        }
      : {}),
    ...(Array.isArray(value.overrides) ? { overrides: value.overrides.map(lore) } : {}),
    ...(Array.isArray(value.conflicts)
      ? {
          conflicts: value.conflicts.map((entry: BackupRow) => ({
            ...entry,
            overrideId: id(entry.overrideId),
          })),
        }
      : {}),
  });
  const delegation = (value: OptionDelegation): OptionDelegation => ({
    ...value,
    id: id(value.id),
    conversationId: id(value.conversationId),
    scope: scope(value.scope) as OptionDelegation['scope'],
  });

  // A forked pending ID is derived from its destination and source pending identity.
  // Replace the initial random allocation before any JSON references are visited.
  for (const row of rows('chat_option_pending')) {
    const value = JSON.parse(row.body) as PendingChatOptions;
    if (!value.origin) continue;
    const mapped = `fork-option:${hash({ chatId: id(value.chatId), pendingId: id(value.origin.pendingId) }).slice(0, 48)}`;
    ctx.ids.set(value.id, mapped);
    row.id = mapped;
  }
  const pending = (value: PendingChatOptions): PendingChatOptions => ({
    ...value,
    id: id(value.id),
    chatId: id(value.chatId),
    branchId: id(value.branchId),
    headRevision: id(value.headRevision),
    runId: id(value.runId),
    ...(value.delegationId ? { delegationId: id(value.delegationId) } : {}),
    ...(value.delegation ? { delegation: delegation(value.delegation) } : {}),
    ...(value.origin
      ? {
          origin: {
            pendingId: id(value.origin.pendingId),
            chatId: id(value.origin.chatId),
            branchId: id(value.origin.branchId),
            runId: id(value.origin.runId),
          },
        }
      : {}),
  });
  const options = <T extends Partial<ChatOptionState>>(value: T): T => ({
    ...value,
    ...(value.chatId ? { chatId: id(value.chatId) } : {}),
    ...(value.branchId ? { branchId: id(value.branchId) } : {}),
    ...(Object.hasOwn(value, 'headRevision') ? { headRevision: id(value.headRevision) } : {}),
    ...(value.pending ? { pending: value.pending.map(pending) } : {}),
    ...(value.delegations ? { delegations: value.delegations.map(delegation) } : {}),
  });
  const snapshot = (value: RunSnapshot): RunSnapshot => {
    const mapped = ctx.structured(value);
    if (value.profile?.chatOptions && mapped.profile?.chatOptions) {
      mapped.profile.chatOptions.pendingIds = value.profile.chatOptions.pendingIds.map(id);
      mapped.profile.chatOptions.delegationIds = value.profile.chatOptions.delegationIds.map(id);
    }
    return mapped;
  };
  const artifact = (value: BackupRow): BackupRow => ({
    ...value,
    id: id(value.id),
    ...(value.conversationId ? { conversationId: id(value.conversationId) } : {}),
    ...(value.taskId ? { taskId: id(value.taskId) } : {}),
    ...(object(value.snapshot) ? { snapshot: snapshot(value.snapshot as RunSnapshot) } : {}),
  });
  const chat = (value: BackupRow): BackupRow => ({
    ...value,
    id: id(value.id),
    ...(Object.hasOwn(value, 'headRevision') ? { headRevision: id(value.headRevision) } : {}),
  });
  const toolResult = (name: string, value: unknown): unknown => {
    if (!object(value)) return value;
    if (name.startsWith('draft.')) return draftResult(value);
    if (name.startsWith('options.')) return options(value);
    if (name === 'chat.lore') return loreResult(value);
    if (name.startsWith('artifact.')) return artifact(value);
    if (name === 'chat.rename' || name === 'chat.fork') return chat(value);
    if (name.startsWith('outline.') || name.startsWith('context.') || name === 'notes.write')
      return ctx.structured(value);
    if (name === 'workspace.read') {
      if (typeof value.baseHash === 'string' && typeof value.editorKey === 'string')
        return draft(value as EditDraft);
      if (object(value.chat) && object(value.workspace))
        return { ...value, chat: chat(value.chat) };
    }
    // Read-only library/model outputs are historical data, not imported identity containers.
    return value;
  };

  for (const row of rows('edit_drafts')) {
    json(row, 'body', draft);
    row.editor_key = JSON.parse(row.body).editorKey;
  }
  for (const row of rows('edit_draft_proposals')) json(row, 'body', proposal);
  for (const row of rows('edit_draft_operations')) {
    json<BackupRow>(row, 'intent', (value) => ({ ...value, draftId: id(value.draftId) }));
    json(row, 'result', draftResult);
    json(row, 'before_body', draft);
    row.request_id = ctx.key(row.request_id);
    // request_hash signs the original request, whose complete body was not retained.
    // It is historical evidence; fabricating a hash of the remapped receipt would be incorrect.
  }
  for (const row of rows('chat_lore_overrides')) json(row, 'body', lore);
  for (const row of rows('chat_override_operations')) {
    json<BackupRow>(row, 'intent', (value) => ({
      ...value,
      chatId: id(value.chatId),
      branchId: id(value.branchId),
      sourceRevision: id(value.sourceRevision),
    }));
    json(row, 'result', loreResult);
    row.request_id = ctx.key(row.request_id);
    // command_hash also records an unavailable original request body. Preserve it verbatim.
  }
  for (const row of rows('helper_delegations')) json(row, 'body', delegation);
  for (const row of rows('chat_option_pending')) json(row, 'body', pending);
  for (const row of rows('chat_option_operations')) {
    json<BackupRow>(row, 'command', (value) => ({
      ...value,
      chatId: id(value.chatId),
      body: {
        ...value.body,
        operationId: id(value.body.operationId),
        ...(Object.hasOwn(value.body, 'branchId') ? { branchId: id(value.body.branchId) } : {}),
        ...(Object.hasOwn(value.body, 'expectedHeadRevision')
          ? { expectedHeadRevision: id(value.body.expectedHeadRevision) }
          : {}),
        ...(Object.hasOwn(value.body, 'delegationId')
          ? { delegationId: id(value.body.delegationId) }
          : {}),
        ...(Object.hasOwn(value.body, 'pendingId') ? { pendingId: id(value.body.pendingId) } : {}),
      },
    }));
    json<BackupRow>(row, 'intent', (value) => ({
      ...value,
      chatId: id(value.chatId),
      branchId: id(value.branchId),
    }));
    json<ChatOptionState>(row, 'result', options);
    row.request_id = ctx.key(row.request_id);
    row.command_hash = hash(JSON.parse(row.command));
  }
  for (const row of rows('helper_conversations')) {
    json(row, 'scope', scope);
    row.scope_key = row.scope;
  }
  for (const row of rows('helper_tasks')) {
    json<HelperTaskSnapshot>(row, 'snapshot', (value) => ({
      ...value,
      scope: scope(value.scope),
      grants: value.grants.map(grant),
      history: value.history.map((entry) => ({ ...entry, id: id(entry.id) })),
      ...(value.retryOf ? { retryOf: id(value.retryOf) } : {}),
      ...(value.requestGroupId ? { requestGroupId: id(value.requestGroupId) } : {}),
      ...(value.writing ? { writing: snapshot(value.writing) } : {}),
      ...(value.editor ? { editor: { ...value.editor, draftId: id(value.editor.draftId) } } : {}),
      ...(value.selection
        ? { selection: { ...value.selection, sourceId: id(value.selection.sourceId) } }
        : {}),
      ...(value.context ? { context: ctx.structured(value.context) } : {}),
    }));
  }
  for (const row of rows('helper_messages'))
    json<{ id: string; revision: number }[]>(row, 'artifacts', (value) =>
      value.map((entry) => ({ ...entry, id: id(entry.id) }))
    );
  for (const row of rows('helper_grants')) json(row, 'body', grant);
  for (const row of rows('helper_operations')) {
    json<BackupRow>(row, 'result', (value) => {
      if (!object(value)) return value;
      if (typeof value.baseHash === 'string' && typeof value.editorKey === 'string')
        return draft(value as EditDraft);
      if (typeof value.conversationId === 'string' && typeof value.text === 'string')
        return artifact(value);
      if (typeof value.chatId === 'string' && Array.isArray(value.nodes))
        return ctx.structured(value);
      if (typeof value.id === 'string' && Object.hasOwn(value, 'headRevision')) return chat(value);
      return value;
    });
    // request_hash remains the original request digest; imported terminal tasks never replay it.
  }
  for (const row of rows('helper_artifact_jobs')) {
    row.operation_id = ctx.key(row.operation_id);
    json(row, 'snapshot', snapshot);
  }
  for (const row of rows('helper_artifacts')) json(row, 'snapshot', snapshot);
  for (const row of rows('helper_events')) {
    json<BackupRow>(row, 'data', (value) => {
      if (!object(value)) return value;
      if (row.kind === 'tool.finished')
        return {
          ...value,
          result: value.denied ? value.result : toolResult(value.name, value.result),
        };
      if (row.kind === 'artifact.saved') return { ...value, id: id(value.id) };
      if (Array.isArray(value.artifacts))
        return {
          ...value,
          artifacts: value.artifacts.map((entry: BackupRow) => ({ ...entry, id: id(entry.id) })),
        };
      if (row.kind === 'context.compacted') return ctx.structured(value);
      return value;
    });
  }
}
