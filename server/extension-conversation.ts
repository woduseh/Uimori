import { createHash } from 'node:crypto';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import type {
  ExtensionConversationRef,
  ExtensionConversationSnapshot,
} from '../core/extension-conversation.js';
import { pageSlice, pageText } from '../core/paging.js';
import { readerConversation, readerRequestOrder } from '../core/reader-conversation.js';
import type { ReaderRun, RunSnapshot, Source } from '../core/types.js';
import {
  createHostDispatcher,
  exactHostArguments,
  hostInteger,
  type HostMethodOf,
} from './extension-host-methods.js';
import type { ExtensionHostHandler } from './extension-runtime.js';
import type { Store } from './store.js';

export type {
  ExtensionConversationRef,
  ExtensionConversationSnapshot,
} from '../core/extension-conversation.js';
export type FrozenExtensionConversation = readonly Readonly<{
  role: 'user' | 'assistant';
  text: string;
}>[];
type ConversationScope = Pick<RunSnapshot, 'chatId' | 'branchId' | 'parentRevision' | 'history'>;
type RunRow = {
  id: string;
  admissionOrder: number;
  branchId: string | null;
  sourceRevision: string | null;
  status: string;
  request: string | null;
  partialText: string | null;
  retryOf: string | null;
  forkRequestOrder: number | null;
  startMode: string | null;
};
const activeStatuses = new Set(['queued', 'running', 'waiting_for_state']);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fail(code = 'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'): never {
  throw new ExtensionProgramError(code);
}
function exactFields(value: unknown, keys: readonly string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail();
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
}
/** Identity-independent evidence survives source/run ID remapping without copying body text. */
export function extensionConversationViewHash(view: FrozenExtensionConversation): string {
  return hash(JSON.stringify(view.map(({ role, text }) => ({ role, hash: hash(text) }))));
}

/**
 * Admission only. Reuses the Reader's conversation ordering, including visible failed requests
 * and their retained partial output. Completed sibling candidates and superseded requests are
 * excluded. Segment exclude/keepLastMessages govern model input, not reader access: collapsed
 * sections can be opened by the user and remain part of this separately granted conversation.
 */
export function captureExtensionConversation(
  store: Store,
  snapshot: ConversationScope,
  options: { admissionRunId?: string; supersedesRunId?: string } = {}
): ExtensionConversationSnapshot {
  if (!snapshot.branchId) fail();
  const branch = store.product.branch(snapshot.chatId, snapshot.branchId);
  if (branch.id !== snapshot.branchId || branch.headRevision !== snapshot.parentRevision) fail();
  const sources: Source[] = [];
  let parent: string | null = null;
  for (const entry of snapshot.history) {
    const source = entry.contentHash
      ? store.sourceAtHash(entry.revision, entry.contentHash)
      : store.sourceOriginal(entry.revision);
    if (
      source.chatId !== snapshot.chatId ||
      source.parentRevision !== parent ||
      source.text !== entry.text ||
      source.hash !== hash(entry.text)
    )
      fail();
    sources.push(source);
    parent = source.id;
  }
  if (parent !== snapshot.parentRevision) fail();
  const sourceRunIds = sources.map((source) => source.runId);
  const sourceRunSet = new Set(sourceRunIds);
  // Project bodies only for the selected branch and its shared source ancestors. The rest is
  // retry-order metadata, exactly as in reader.ts; never load diagnostics, models or secrets.
  const rows = store.db
    .prepare(`
    SELECT id,rowid AS admissionOrder,branch_id AS branchId,source_revision AS sourceRevision,
      status,json_extract(command,'$.retryOf') AS retryOf,
      json_extract(snapshot,'$.forkedFrom.requestOrder') AS forkRequestOrder,
      json_extract(snapshot,'$.packageStart.mode') AS startMode,
      CASE WHEN branch_id=? OR (branch_id IS NULL AND ?=1) OR id IN (SELECT value FROM json_each(?)) THEN request END AS request,
      CASE WHEN branch_id=? OR (branch_id IS NULL AND ?=1) THEN partial_text END AS partialText
    FROM runs WHERE chat_id=? ORDER BY created_at,id
  `)
    .all(
      branch.id,
      branch.default ? 1 : 0,
      JSON.stringify(sourceRunIds),
      branch.id,
      branch.default ? 1 : 0,
      snapshot.chatId
    ) as RunRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const admission = options.admissionRunId ? byId.get(options.admissionRunId) : undefined;
  if (
    admission &&
    admission.branchId !== branch.id &&
    !(admission.branchId === null && branch.default)
  )
    fail();
  const cutoff = admission?.admissionOrder ?? Infinity;
  const beforeAdmission = rows.filter((row) => row.admissionOrder < cutoff);
  const superseded = new Set(beforeAdmission.flatMap((row) => (row.retryOf ? [row.retryOf] : [])));
  if (admission?.retryOf) superseded.add(admission.retryOf);
  if (options.supersedesRunId) superseded.add(options.supersedesRunId);
  const selected = beforeAdmission.filter(
    (row) =>
      sourceRunSet.has(row.id) ||
      (row.sourceRevision === null &&
        row.id !== options.admissionRunId &&
        !superseded.has(row.id) &&
        (row.branchId === branch.id || (row.branchId === null && branch.default)))
  );
  const selectedIds = new Set(selected.map((row) => row.id));
  if (sources.some((source) => !selectedIds.has(source.runId))) fail();
  // readerConversation consumes only these projected fields; no Reader diagnostics are needed.
  const readerRuns = selected.map((row) => ({
    ...row,
    requestOrder: readerRequestOrder(byId, row.id),
    supersededBy: superseded.has(row.id) ? 'superseded' : null,
  })) as unknown as ReaderRun[];
  const messages: ExtensionConversationRef[] = [];
  for (const entry of readerConversation(sources, readerRuns)) {
    const run = byId.get(entry.kind === 'source' ? entry.source.runId : entry.run.id);
    if (!run || typeof run.request !== 'string') fail();
    if (run.startMode !== 'authored')
      messages.push({ kind: 'request', role: 'user', runId: run.id, hash: hash(run.request) });
    if (entry.kind === 'source') {
      messages.push({
        kind: 'source',
        role: 'assistant',
        runId: run.id,
        sourceRevision: entry.source.id,
        hash: entry.source.hash,
      });
    } else if (!activeStatuses.has(run.status) && run.partialText) {
      messages.push({
        kind: 'partial',
        role: 'assistant',
        runId: run.id,
        hash: hash(run.partialText),
      });
    }
  }
  return {
    version: 1,
    chatId: snapshot.chatId,
    branchId: branch.id,
    parentRevision: snapshot.parentRevision,
    admissionRunId: options.admissionRunId ?? null,
    messages,
  };
}

/**
 * Resolve exact references once for one invocation, never today's branch/history. No fallback
 * captures are allowed. The phase owner may append its original request and staged response;
 * this does not change durable source text or add duplicate bodies to each action receipt.
 */
export function resolveExtensionConversation(
  store: Store,
  snapshot: ConversationScope,
  captured: ExtensionConversationSnapshot | undefined,
  append: { request?: string; response?: string } = {}
): FrozenExtensionConversation {
  exactFields(captured, [
    'version',
    'chatId',
    'branchId',
    'parentRevision',
    'admissionRunId',
    'messages',
  ]);
  if (
    !captured ||
    captured.version !== 1 ||
    !snapshot.branchId ||
    captured.chatId !== snapshot.chatId ||
    captured.branchId !== snapshot.branchId ||
    captured.parentRevision !== snapshot.parentRevision ||
    !Array.isArray(captured.messages) ||
    (captured.admissionRunId !== null &&
      (typeof captured.admissionRunId !== 'string' ||
        !captured.admissionRunId.length ||
        captured.admissionRunId.length > 200))
  )
    fail();
  const sourceIds = new Set(snapshot.history.map((entry) => entry.revision));
  const sourceRunIds = new Set<string>();
  const textBySource = new Map<string, string>();
  const sources: Source[] = [];
  let parent: string | null = null;
  for (const ref of captured.messages) {
    if (!ref || typeof ref !== 'object') fail();
    exactFields(
      ref,
      ref.kind === 'source'
        ? ['kind', 'role', 'runId', 'sourceRevision', 'hash']
        : ['kind', 'role', 'runId', 'hash']
    );
    if (
      typeof ref.runId !== 'string' ||
      !ref.runId.length ||
      ref.runId.length > 200 ||
      typeof ref.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ref.hash)
    )
      fail();
    if (ref.kind !== 'source') continue;
    if (
      ref.role !== 'assistant' ||
      typeof ref.sourceRevision !== 'string' ||
      !ref.sourceRevision.length ||
      ref.sourceRevision.length > 200 ||
      !sourceIds.has(ref.sourceRevision) ||
      textBySource.has(ref.sourceRevision)
    )
      fail();
    let source: Source;
    try {
      source = store.sourceAtHash(ref.sourceRevision, ref.hash);
    } catch {
      fail();
    }
    const expected = snapshot.history.find((entry) => entry.revision === ref.sourceRevision)!;
    if (
      source.chatId !== captured.chatId ||
      source.parentRevision !== parent ||
      source.id !== snapshot.history[sources.length]?.revision ||
      source.runId !== ref.runId ||
      source.hash !== hash(source.text) ||
      source.text !== expected.text ||
      (expected.contentHash !== undefined && source.hash !== expected.contentHash)
    )
      fail();
    textBySource.set(ref.sourceRevision, source.text);
    sourceRunIds.add(source.runId);
    sources.push(source);
    parent = source.id;
  }
  if (sources.length !== snapshot.history.length || parent !== captured.parentRevision) fail();
  const messages: { role: 'user' | 'assistant'; text: string }[] = [];
  type ScopedRunRow = RunRow & { chatId: string; parentRevision: string | null };
  const runCache = new Map<string, ScopedRunRow>();
  const runRow = (id: string) => {
    let row = runCache.get(id);
    if (!row) {
      row = store.db
        .prepare(`SELECT id,rowid AS admissionOrder,chat_id AS chatId,branch_id AS branchId,
        parent_revision AS parentRevision,source_revision AS sourceRevision,status,request,partial_text AS partialText,
        json_extract(command,'$.retryOf') AS retryOf,json_extract(snapshot,'$.packageStart.mode') AS startMode,
        json_extract(snapshot,'$.forkedFrom.requestOrder') AS forkRequestOrder
        FROM runs WHERE id=?`)
        .get(id) as ScopedRunRow | undefined;
      if (!row || row.chatId !== captured.chatId) fail();
      runCache.set(id, row);
    }
    return row;
  };
  let cutoff = Infinity;
  if (captured.admissionRunId !== null) {
    const admission = runRow(captured.admissionRunId);
    if (
      admission.parentRevision !== captured.parentRevision ||
      admission.branchId !== captured.branchId
    )
      fail();
    cutoff = admission.admissionOrder;
  }
  const seen = new Set<string>();
  const groups: { runId: string; kind: 'source' | 'pending' }[] = [];
  for (const [index, ref] of captured.messages.entries()) {
    if (
      !ref ||
      !/^[a-f0-9]{64}$/.test(ref.hash) ||
      typeof ref.runId !== 'string' ||
      seen.has(`${ref.kind}:${ref.runId}`)
    )
      fail();
    seen.add(`${ref.kind}:${ref.runId}`);
    const row = runRow(ref.runId);
    if (row.admissionOrder >= cutoff) fail();
    if (ref.kind === 'source') {
      if (
        row.sourceRevision !== ref.sourceRevision ||
        (row.startMode !== 'authored' &&
          (captured.messages[index - 1]?.kind !== 'request' ||
            captured.messages[index - 1].runId !== ref.runId))
      )
        fail();
      groups.push({ kind: 'source', runId: ref.runId });
      messages.push({ role: 'assistant', text: textBySource.get(ref.sourceRevision)! });
      continue;
    }
    if (
      (ref.kind !== 'request' || ref.role !== 'user') &&
      (ref.kind !== 'partial' || ref.role !== 'assistant')
    )
      fail();
    if (
      row.chatId !== captured.chatId ||
      (!sourceRunIds.has(ref.runId) &&
        row.branchId !== captured.branchId &&
        !(
          row.branchId === null && store.product.branch(captured.chatId, captured.branchId).default
        ))
    )
      fail();
    if (ref.kind === 'request') {
      if (row.startMode === 'authored') fail();
      if (sourceRunIds.has(ref.runId)) {
        if (
          captured.messages[index + 1]?.kind !== 'source' ||
          captured.messages[index + 1].runId !== ref.runId
        )
          fail();
      } else groups.push({ kind: 'pending', runId: ref.runId });
    } else if (
      sourceRunIds.has(ref.runId) ||
      captured.messages[index - 1]?.kind !== 'request' ||
      captured.messages[index - 1].runId !== ref.runId
    )
      fail();
    const text = ref.kind === 'request' ? row.request : row.partialText;
    if (typeof text !== 'string' || hash(text) !== ref.hash) fail();
    messages.push({ role: ref.role, text });
  }
  const orderRows = new Map(
    (
      store.db
        .prepare(`SELECT id,rowid AS admissionOrder,
    json_extract(command,'$.retryOf') AS retryOf,
    json_extract(snapshot,'$.forkedFrom.requestOrder') AS forkRequestOrder
    FROM runs WHERE chat_id=?`)
        .all(captured.chatId) as Pick<
        RunRow,
        'id' | 'admissionOrder' | 'retryOf' | 'forkRequestOrder'
      >[]
    ).map((row) => [row.id, row])
  );
  const ordered = readerConversation(
    sources,
    groups.map((group) => ({
      id: group.runId,
      sourceRevision: group.kind === 'source' ? runRow(group.runId).sourceRevision : null,
      requestOrder: readerRequestOrder(orderRows, group.runId),
    })) as ReaderRun[]
  ).map((entry) => ({
    kind: entry.kind,
    runId: entry.kind === 'source' ? entry.source.runId : entry.run.id,
  }));
  if (JSON.stringify(groups) !== JSON.stringify(ordered)) fail();
  for (const [key, role] of [
    ['request', 'user'],
    ['response', 'assistant'],
  ] as const) {
    const text = append[key];
    if (text !== undefined) {
      if (typeof text !== 'string') fail();
      messages.push({ role, text });
    }
  }
  return Object.freeze(messages.map((message) => Object.freeze(message)));
}

/** Every disclosure checks live grant/owner state, while the captured content never changes. */
export function createConversationExtensionHost(
  program: ExtensionProgram,
  frozenView: FrozenExtensionConversation,
  assertReadAccess: () => void,
  assertCurrent: () => void
): ExtensionHostHandler {
  const captured = frozenView.map(({ role, text }) => {
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string') fail();
    return { role, text };
  });
  const slice = (index: number, offset: number, limit: number) => {
    const message = captured[index];
    if (offset > message.text.length) fail('BEHAVIOR_HOST_ARGUMENTS');
    return { index, role: message.role, ...pageText(message.text, offset, limit) };
  };
  return createHostDispatcher<HostMethodOf<'conversation'>>({
    denied: 'BEHAVIOR_HOST_DENIED',
    granted: (entry) => program.capabilities?.includes(entry.capability) === true,
    screen: exactHostArguments,
    gate: (_entry, signal) => {
      assertReadAccess();
      assertCurrent();
      if (signal.aborted) fail('BEHAVIOR_HOST_ABORTED');
    },
    handlers: {
      'conversation.list': async ({ offset, limit }) => {
        if (offset > captured.length) fail('BEHAVIOR_HOST_ARGUMENTS');
        const listing = pageSlice(captured, offset, limit);
        return {
          items: listing.items.map((message, index) => ({
            index: offset + index,
            role: message.role,
            totalChars: message.text.length,
          })),
          nextOffset: listing.nextOffset,
          total: listing.total,
        };
      },
      'conversation.page': async ({ args, offset, limit }) => {
        let index = hostInteger(args.index, 0, 0, captured.length);
        let nextOffset = offset;
        let remaining = limit;
        const items: ReturnType<typeof slice>[] = [];
        if (index === captured.length && offset !== 0) fail('BEHAVIOR_HOST_ARGUMENTS');
        while (index < captured.length && items.length < 50 && remaining > 0) {
          const item = slice(index, nextOffset, remaining);
          items.push(item);
          remaining -= item.text.length;
          if (item.nextOffset !== null) {
            nextOffset = item.nextOffset;
            break;
          }
          index++;
          nextOffset = 0;
        }
        return {
          items,
          next: index < captured.length ? { index, offset: nextOffset } : null,
          total: captured.length,
        };
      },
      'conversation.read': async ({ args, offset, limit }) =>
        slice(hostInteger(args.index, undefined, 0, captured.length - 1), offset, limit),
    },
  });
}
