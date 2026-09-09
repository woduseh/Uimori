import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import {
  buildChatOverrideSnapshot,
  chatAttachmentKey,
  chatLoreKey,
  chatOverrideHash,
  chatPackagePaths,
  validateChatLoreSelector,
  type ChatLoreConflict,
  type ChatLoreOverride,
  type ChatLoreSelector,
  type ChatOverrideSnapshot,
} from '../core/chat-overrides.js';
import type { Content, ProfileSnapshot } from '../core/product.js';
import { validatePackageAttachment, type PackageAttachment } from '../core/content-package.js';
import type { SourceHistoryItem } from '../core/source-history.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import { resolvePackageProfile } from './package-features.js';
import type { Store } from './store.js';

type Row = Record<string, string | number | null>;
export const chatOverrideTables = [
  'chat_lore_overrides',
  'chat_override_heads',
  'chat_override_operations',
];
export type ChatOverrideIntent = {
  action: 'patch' | 'remove';
  chatId: string;
  branchId: string;
  selector: ChatLoreSelector;
  expectedRevision: number;
  sourceRevision: string | null;
};
/** The route/helper host constructs this callback from the actual UI/task grant, never from a model argument. */
export type ChatOverrideAuthority = {
  requestId: string;
  assert: (intent: ChatOverrideIntent) => void;
};
export type ChatOverrideResult = { revision: number; entry: ChatLoreOverride };
export function initChatOverrides(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS chat_lore_overrides(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),revision INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(chat_id,revision));
    CREATE TABLE IF NOT EXISTS chat_override_heads(chat_id TEXT PRIMARY KEY REFERENCES chats(id),revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_override_operations(operation_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),request_id TEXT NOT NULL,command_hash TEXT NOT NULL,intent TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
}
const json = JSON.stringify;
const hash = (value: unknown) => chatOverrideHash(json(value));
const sourceId = (value: unknown) => (value === null ? null : text(value, 'source revision', 100));
const maxField = (selector: ChatLoreSelector) =>
  selector.field === 'text' ? 1_000_000 : selector.field === 'description' ? 2000 : 200;

export class ChatOverridesStore {
  constructor(readonly store: Store) {}
  revision(chatId: string): number {
    this.store.chat(chatId);
    return Number(
      (
        this.store.db
          .prepare('SELECT revision FROM chat_override_heads WHERE chat_id=?')
          .get(chatId) as Row | undefined
      )?.revision ?? 0
    );
  }
  private all(chatId: string): ChatLoreOverride[] {
    return (
      this.store.db
        .prepare('SELECT body FROM chat_lore_overrides WHERE chat_id=? ORDER BY revision')
        .all(chatId) as Row[]
    ).map((row) => JSON.parse(String(row.body)) as ChatLoreOverride);
  }
  private scoped(chatId: string, headRevision: string | null) {
    this.store.chat(chatId);
    const history = this.store.history(headRevision);
    if (history.some((item) => this.store.source(item.revision).chatId !== chatId))
      throw new HttpError(400, 'Override source outside chat');
    const hashes = new Map(
      history.map((item) => [item.revision, item.contentHash ?? chatOverrideHash(item.text)])
    );
    const latest = new Map<string, ChatLoreOverride>();
    for (const entry of this.all(chatId))
      if (entry.atSource === null || hashes.has(entry.atSource))
        latest.set(chatLoreKey(entry.selector), entry);
    const entries = [...latest.values()];
    const valid = entries.filter(
      (entry) => entry.atSource === null || hashes.get(entry.atSource) === entry.atHash
    );
    const conflicts: ChatLoreConflict[] = entries
      .filter((entry) => !entry.retired && !valid.includes(entry))
      .map((entry) => ({ overrideId: entry.id, kind: 'anchor-changed', currentValue: null }));
    return { entries, valid, conflicts, headHash: headRevision ? hashes.get(headRevision)! : null };
  }
  freeze(
    profile: ProfileSnapshot,
    roots: PackageAttachment[],
    headRevision: string | null
  ): ChatOverrideSnapshot {
    const scoped = this.scoped(profile.chatId, headRevision);
    return buildChatOverrideSnapshot(profile, roots, this.revision(profile.chatId), scoped.valid, {
      headRevision,
      headHash: scoped.headHash,
    });
  }
  get(chatId: string, branchId?: string) {
    const branch = this.store.product.branch(chatId, branchId),
      profile = this.store.product.profile(chatId);
    const roots = profile.packageAttachments ?? [],
      resolved = resolvePackageProfile(this.store.product, profile);
    const scoped = this.scoped(chatId, branch.headRevision);
    const snapshot = buildChatOverrideSnapshot(
      resolved,
      roots,
      this.revision(chatId),
      scoped.valid,
      { headRevision: branch.headRevision, headHash: scoped.headHash }
    );
    return {
      chatId,
      branchId: branch.id,
      headRevision: branch.headRevision,
      headHash: scoped.headHash,
      revision: snapshot.revision,
      profileRevision: profile.revision,
      attachments: chatPackagePaths(resolved, roots).map((path) => ({
        scope: path.scope,
        packageId: path.package.id,
        packageRevision: path.package.revision,
        title: path.package.title,
        lore: path.package.lore,
      })),
      overrides: scoped.entries.filter((entry) => !entry.retired),
      conflicts: [...snapshot.conflicts, ...scoped.conflicts],
    };
  }
  patch(chatId: string, value: unknown, authority: ChatOverrideAuthority): ChatOverrideResult {
    return this.write('patch', chatId, value, authority);
  }
  remove(chatId: string, value: unknown, authority: ChatOverrideAuthority): ChatOverrideResult {
    return this.write('remove', chatId, value, authority);
  }
  private write(
    action: 'patch' | 'remove',
    chatId: string,
    value: unknown,
    authority: ChatOverrideAuthority
  ): ChatOverrideResult {
    const body = record(value);
    fields(body, [
      'selector',
      'branchId',
      'expectedRevision',
      'expectedHeadRevision',
      'operationId',
      ...(action === 'patch'
        ? ['expectedProfileRevision', 'expectedPackageRevision', 'expectedFieldHash', 'value']
        : []),
    ]);
    const selector = validateChatLoreSelector(body.selector),
      expectedRevision = number(body.expectedRevision, 'override revision', 0);
    const expectedHead = sourceId(body.expectedHeadRevision),
      operationId = text(body.operationId, 'override operation ID', 160);
    if (!authority || typeof authority.assert !== 'function')
      throw new HttpError(403, 'Override authority required');
    text(authority.requestId, 'override request ID', 200);
    const inputHash = hash({ action, chatId, ...body });
    return this.store.transaction(() => {
      const receipt = this.store.db
        .prepare('SELECT * FROM chat_override_operations WHERE operation_id=?')
        .get(operationId) as Row | undefined;
      if (receipt) {
        authority.assert(JSON.parse(String(receipt.intent)) as ChatOverrideIntent);
        if (
          receipt.chat_id !== chatId ||
          receipt.request_id !== authority.requestId ||
          receipt.command_hash !== inputHash
        )
          throw new HttpError(409, 'Override operation ID reused');
        return JSON.parse(String(receipt.result)) as ChatOverrideResult;
      }
      const branch = this.store.product.branch(
        chatId,
        body.branchId === undefined ? undefined : text(body.branchId, 'branch ID', 100)
      );
      const intent: ChatOverrideIntent = {
        action,
        chatId,
        branchId: branch.id,
        selector,
        expectedRevision,
        sourceRevision: expectedHead,
      };
      authority.assert(intent);
      if (this.revision(chatId) !== expectedRevision)
        throw new HttpError(409, '채팅 전용 로어가 바뀌었어요. 최신 변경을 확인해 주세요.');
      if (branch.headRevision !== expectedHead)
        throw new HttpError(409, '로어 변경을 붙일 원문이 바뀌었어요. 최신 원문을 확인해 주세요.');
      const scoped = this.scoped(chatId, branch.headRevision),
        prior = scoped.entries.find(
          (entry) => chatLoreKey(entry.selector) === chatLoreKey(selector)
        );
      let entry: ChatLoreOverride;
      if (action === 'remove') {
        if (!prior || prior.retired) throw new HttpError(409, '이 연결에 적용한 변경이 없어요.');
        entry = {
          ...prior,
          id: randomUUID(),
          revision: expectedRevision + 1,
          retired: true,
          atSource: branch.headRevision,
          atHash: scoped.headHash,
          createdAt: new Date().toISOString(),
        };
      } else {
        const profile = this.store.product.profile(chatId);
        if (profile.revision !== number(body.expectedProfileRevision, 'profile revision'))
          throw new HttpError(409, '자료 연결이 변경됐어요.');
        const resolved = resolvePackageProfile(this.store.product, profile),
          paths = chatPackagePaths(resolved, profile.packageAttachments ?? []);
        const selected = paths.find(
          (path) => chatAttachmentKey(path.scope) === chatAttachmentKey(selector)
        );
        if (!selected) throw new HttpError(400, '선택한 패키지 연결 경로가 현재 채팅에 없어요.');
        if (selected.package.revision !== number(body.expectedPackageRevision, 'package revision'))
          throw new HttpError(409, '원본 자료가 변경됐어요.');
        const baseEntry = selected.package.lore.find((lore) => lore.id === selector.loreId);
        if (!baseEntry) throw new HttpError(404, '선택한 로어 항목이 없어요.');
        const baseValue = baseEntry[selector.field];
        if (body.expectedFieldHash !== chatOverrideHash(baseValue))
          throw new HttpError(409, '원본 로어 필드가 변경됐어요.');
        const roots = profile.packageAttachments ?? [],
          root = roots.find((ref) => ref.id === selector.id && ref.role === selector.role)!;
        const baseModuleRevisions = selector.modulePath.map((moduleId, index) => {
          const path = paths.find(
            (item) =>
              chatAttachmentKey(item.scope) ===
              chatAttachmentKey({
                ...selector,
                modulePath: selector.modulePath.slice(0, index + 1),
              })
          )!;
          return { id: moduleId, revision: path.package.revision };
        });
        entry = {
          id: randomUUID(),
          chatId,
          revision: expectedRevision + 1,
          selector,
          basePackageRevision: selected.package.revision,
          baseRootRevision: root.revision,
          baseModuleRevisions,
          baseEntry: structuredClone(baseEntry),
          baseValue,
          baseHash: chatOverrideHash(baseValue),
          value: text(body.value, 'lore text', maxField(selector), true),
          atSource: branch.headRevision,
          atHash: scoped.headHash,
          retired: false,
          createdAt: new Date().toISOString(),
        };
        if (!prior && scoped.entries.filter((item) => !item.retired).length >= 1000)
          throw new HttpError(400, '채팅 전용 로어 변경 한도를 넘었어요.');
      }
      const result = { revision: entry.revision, entry };
      this.store.db
        .prepare('INSERT INTO chat_lore_overrides VALUES(?,?,?,?)')
        .run(entry.id, chatId, entry.revision, json(entry));
      this.store.db
        .prepare(
          'INSERT INTO chat_override_heads VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision'
        )
        .run(chatId, entry.revision);
      this.store.db
        .prepare('INSERT INTO chat_override_operations VALUES(?,?,?,?,?,?,?)')
        .run(
          operationId,
          chatId,
          authority.requestId,
          inputHash,
          json(intent),
          json(result),
          entry.createdAt
        );
      this.store.event(chatId, 'chat.lore.override', entry.id);
      return result;
    });
  }
}

export function freezeChatOverrides(
  store: Store,
  profile: ProfileSnapshot,
  roots: PackageAttachment[],
  headRevision: string | null
): ChatOverrideSnapshot | undefined {
  const service = new ChatOverridesStore(store);
  return service.revision(profile.chatId)
    ? service.freeze(profile, roots, headRevision)
    : undefined;
}

function validateOverrideEntry(store: Store, value: unknown): ChatLoreOverride {
  const body = record(value);
  fields(body, [
    'id',
    'chatId',
    'revision',
    'selector',
    'basePackageRevision',
    'baseRootRevision',
    'baseModuleRevisions',
    'baseEntry',
    'baseValue',
    'baseHash',
    'value',
    'atSource',
    'atHash',
    'retired',
    'createdAt',
  ]);
  text(body.id, 'override ID', 100);
  store.chat(text(body.chatId, 'override chat ID', 100));
  number(body.revision, 'override revision');
  const selector = validateChatLoreSelector(body.selector),
    baseRootRevision = number(body.baseRootRevision, 'root revision');
  let pkg = store.product.get<Content>('content', selector.id, baseRootRevision).package;
  if (
    !pkg ||
    !Array.isArray(body.baseModuleRevisions) ||
    body.baseModuleRevisions.length !== selector.modulePath.length
  )
    throw new HttpError(400, 'Invalid override base path');
  for (const [index, raw] of body.baseModuleRevisions.entries()) {
    const ref = record(raw);
    fields(ref, ['id', 'revision']);
    if (
      ref.id !== selector.modulePath[index] ||
      !pkg.modules?.some((module) => module.id === ref.id)
    )
      throw new HttpError(400, 'Override base module outside path');
    pkg = store.product.get<Content>(
      'content',
      ref.id,
      number(ref.revision, 'module revision')
    ).package;
    if (!pkg) throw new HttpError(400, 'Override base module missing');
  }
  if (number(body.basePackageRevision, 'package revision') !== pkg.revision)
    throw new HttpError(400, 'Override base package mismatch');
  const lore = pkg.lore.find((item) => item.id === selector.loreId);
  if (
    !lore ||
    !isDeepStrictEqual(lore, body.baseEntry) ||
    lore[selector.field] !== body.baseValue ||
    body.baseHash !== chatOverrideHash(body.baseValue)
  )
    throw new HttpError(400, 'Override base lore mismatch');
  text(body.value, 'override text', maxField(selector), true);
  if (
    typeof body.retired !== 'boolean' ||
    typeof body.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(body.createdAt))
  )
    throw new HttpError(400, 'Invalid override metadata');
  const anchor = sourceId(body.atSource);
  if (anchor === null) {
    if (body.atHash !== null) throw new HttpError(400, 'Unexpected override source hash');
  } else if (
    store.sourceAtHash(anchor, text(body.atHash, 'source hash', 64)).chatId !== body.chatId
  )
    throw new HttpError(400, 'Override anchor outside chat');
  return body as ChatLoreOverride;
}

export function validateChatOverrideArchive(store: Store): void {
  const maximum = new Map<string, number>(),
    entries = new Map<string, ChatLoreOverride>();
  for (const row of store.db.prepare('SELECT * FROM chat_lore_overrides').all() as Row[]) {
    const entry = validateOverrideEntry(store, JSON.parse(String(row.body)));
    if (row.id !== entry.id || row.chat_id !== entry.chatId || row.revision !== entry.revision)
      throw new HttpError(400, 'Override row identity mismatch');
    maximum.set(entry.chatId, Math.max(maximum.get(entry.chatId) ?? 0, entry.revision));
    entries.set(entry.id, entry);
  }
  for (const row of store.db.prepare('SELECT * FROM chat_override_heads').all() as Row[]) {
    store.chat(String(row.chat_id));
    number(row.revision, 'override head revision');
    if ((maximum.get(String(row.chat_id)) ?? 0) > Number(row.revision))
      throw new HttpError(400, 'Override head mismatch');
    maximum.delete(String(row.chat_id));
  }
  if (maximum.size) throw new HttpError(400, 'Override head missing');
  for (const row of store.db.prepare('SELECT * FROM chat_override_operations').all() as Row[]) {
    text(row.operation_id, 'operation ID', 160);
    text(row.request_id, 'request ID', 200);
    if (
      typeof row.command_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.command_hash) ||
      !Number.isFinite(Date.parse(String(row.created_at)))
    )
      throw new HttpError(400, 'Invalid override receipt metadata');
    const intent = record(JSON.parse(String(row.intent)));
    fields(intent, [
      'action',
      'chatId',
      'branchId',
      'selector',
      'expectedRevision',
      'sourceRevision',
    ]);
    const result = record(JSON.parse(String(row.result)));
    fields(result, ['revision', 'entry']);
    const entry = validateOverrideEntry(store, result.entry),
      selector = validateChatLoreSelector(intent.selector);
    if (
      !['patch', 'remove'].includes(intent.action) ||
      intent.chatId !== row.chat_id ||
      entry.chatId !== row.chat_id ||
      result.revision !== entry.revision ||
      entry.revision !== number(intent.expectedRevision, 'expected revision', 0) + 1 ||
      !isDeepStrictEqual(selector, entry.selector) ||
      intent.sourceRevision !== entry.atSource ||
      entry.retired !== (intent.action === 'remove') ||
      !isDeepStrictEqual(entries.get(entry.id), entry)
    )
      throw new HttpError(400, 'Override receipt mismatch');
    if (
      store.product.branch(entry.chatId, text(intent.branchId, 'branch ID', 100)).chatId !==
      entry.chatId
    )
      throw new HttpError(400, 'Override receipt branch mismatch');
  }
}

/** Historical profiles are validated from their frozen closure and stored override versions, not live library contents. */
export function validateChatOverrideSnapshot(
  store: Store,
  profile: ProfileSnapshot,
  history?: readonly SourceHistoryItem[]
): void {
  if (profile.chatOverrides === undefined) return;
  const snapshot = record(profile.chatOverrides);
  fields(snapshot, [
    'version',
    'revision',
    'headRevision',
    'headHash',
    'roots',
    'entries',
    'projections',
    'conflicts',
  ]);
  if (
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.roots) ||
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.length > 1000
  )
    throw new HttpError(400, 'Invalid override snapshot');
  const revision = number(snapshot.revision, 'override snapshot revision', 0);
  if (revision > new ChatOverridesStore(store).revision(profile.chatId))
    throw new HttpError(400, 'Override snapshot beyond current revision');
  const roots: PackageAttachment[] = snapshot.roots.map((value: unknown) =>
    validatePackageAttachment(value)
  );
  if (
    new Set(roots.map((root) => `${root.id}:${root.role}`)).size !== roots.length ||
    roots.some((root) => !profile.packageAttachments?.some((ref) => isDeepStrictEqual(ref, root)))
  )
    throw new HttpError(400, 'Invalid override snapshot roots');
  const entries: ChatLoreOverride[] = snapshot.entries.map((entry: unknown) =>
    validateOverrideEntry(store, entry)
  );
  for (const entry of entries) {
    const row = store.db
      .prepare('SELECT body FROM chat_lore_overrides WHERE id=? AND chat_id=?')
      .get(entry.id, profile.chatId) as Row | undefined;
    if (
      entry.revision > revision ||
      !row ||
      !isDeepStrictEqual(entry, JSON.parse(String(row.body)))
    )
      throw new HttpError(400, 'Override snapshot entry mismatch');
  }
  const headRevision = sourceId(snapshot.headRevision),
    headHash = headRevision ? text(snapshot.headHash, 'override head hash', 64) : null;
  if (headRevision === null && snapshot.headHash !== null)
    throw new HttpError(400, 'Unexpected override snapshot hash');
  if (headRevision && store.sourceAtHash(headRevision, headHash!).chatId !== profile.chatId)
    throw new HttpError(400, 'Override snapshot head outside chat');
  if (history) {
    const hashes = new Map(
      history.map((item) => [item.revision, item.contentHash ?? chatOverrideHash(item.text)])
    );
    if (
      (history.at(-1)?.revision ?? null) !== headRevision ||
      (headRevision ? hashes.get(headRevision) : null) !== headHash
    )
      throw new HttpError(400, 'Override snapshot head mismatch');
    const latest = new Map<string, ChatLoreOverride>();
    for (const row of store.db
      .prepare(
        'SELECT body FROM chat_lore_overrides WHERE chat_id=? AND revision<=? ORDER BY revision'
      )
      .all(profile.chatId, revision) as Row[]) {
      const entry = JSON.parse(String(row.body)) as ChatLoreOverride;
      if (entry.atSource === null || hashes.has(entry.atSource))
        latest.set(chatLoreKey(entry.selector), entry);
    }
    const expected = [...latest.values()].filter(
      (entry) => entry.atSource === null || hashes.get(entry.atSource) === entry.atHash
    );
    if (!isDeepStrictEqual(entries, expected))
      throw new HttpError(400, 'Override snapshot source scope mismatch');
  }
  const expected = buildChatOverrideSnapshot(profile, roots, revision, entries, {
    headRevision,
    headHash,
  });
  if (!isDeepStrictEqual(snapshot, expected))
    throw new HttpError(400, 'Override projection mismatch');
}

export const forkChatOverrideId = (chatId: string, id: string) =>
  chatOverrideHash(json(['chat-override-fork', chatId, id])).slice(0, 40);
/** Copy only versions whose source anchor exists in the selected ancestry. Helper grants and receipts never transfer. */
export function copyChatOverridesInTransaction(
  store: Store,
  fromChatId: string,
  toChatId: string,
  sources: Map<string, string>
): void {
  if (!store.db.isTransaction)
    throw new Error('Override fork requires the enclosing fork transaction');
  const revision = new ChatOverridesStore(store).revision(fromChatId);
  for (const row of store.db
    .prepare('SELECT body FROM chat_lore_overrides WHERE chat_id=? ORDER BY revision')
    .all(fromChatId) as Row[]) {
    const original = JSON.parse(String(row.body)) as ChatLoreOverride;
    if (original.atSource !== null && !sources.has(original.atSource)) continue;
    const entry = {
      ...structuredClone(original),
      id: forkChatOverrideId(toChatId, original.id),
      chatId: toChatId,
      atSource: original.atSource === null ? null : sources.get(original.atSource)!,
    };
    store.db
      .prepare('INSERT INTO chat_lore_overrides VALUES(?,?,?,?)')
      .run(entry.id, toChatId, entry.revision, json(entry));
  }
  if (revision)
    store.db.prepare('INSERT INTO chat_override_heads VALUES(?,?)').run(toChatId, revision);
}
/** Called alongside existing snapshot identity mapping before recompiling a forked prompt. */
export function mapForkChatOverrideSnapshot(
  profile: ProfileSnapshot | undefined,
  chatId: string,
  sources: Map<string, string>
): void {
  if (!profile?.chatOverrides) return;
  const value = profile.chatOverrides;
  const mappedSource = (id: string | null) => {
    if (id === null) return null;
    const mapped = sources.get(id);
    if (!mapped) throw new HttpError(400, 'Override outside fork ancestry');
    return mapped;
  };
  const entries = value.entries.map((entry) => ({
    ...entry,
    id: forkChatOverrideId(chatId, entry.id),
    chatId,
    atSource: mappedSource(entry.atSource),
  }));
  profile.chatOverrides = buildChatOverrideSnapshot(profile, value.roots, value.revision, entries, {
    headRevision: mappedSource(value.headRevision),
    headHash: value.headHash,
  });
}

/** Remove branch-owned evidence only when its exact source IDs are being removed by the guarded deletion service. */
export function deleteChatOverrideSourcesInTransaction(
  store: Store,
  chatId: string,
  sources: ReadonlySet<string>
): void {
  const remove = (
    store.db.prepare('SELECT id,body FROM chat_lore_overrides WHERE chat_id=?').all(chatId) as Row[]
  ).filter((row) => sources.has((JSON.parse(String(row.body)) as ChatLoreOverride).atSource ?? ''));
  for (const row of remove) {
    store.db
      .prepare(
        "DELETE FROM chat_override_operations WHERE chat_id=? AND json_extract(result,'$.entry.id')=?"
      )
      .run(chatId, row.id);
    store.db.prepare('DELETE FROM chat_lore_overrides WHERE id=?').run(row.id);
  }
  // Keep the global head monotonic after branch cleanup; reusing an old revision would permit ABA writes.
}
export function chatOverrideRoutes(
  app: FastifyInstance,
  service: ChatOverridesStore,
  publish: (chatId: string) => void = () => {}
): void {
  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/lore-overrides',
    async (request) => service.get(request.params.id, request.query.branchId)
  );
  const mutate =
    (action: 'patch' | 'remove') => async (request: { params: { id: string }; body: unknown }) => {
      const operationId = text(record(request.body).operationId, 'override operation ID', 160);
      const result = service[action](request.params.id, request.body, {
        requestId: `user-ui:${operationId}`,
        assert: () => {},
      });
      publish(request.params.id);
      return result;
    };
  app.patch<{ Params: { id: string } }>(
    '/api/chats/:id/lore-overrides',
    { bodyLimit: 1_100_000 },
    mutate('patch')
  );
  app.delete<{ Params: { id: string } }>('/api/chats/:id/lore-overrides', mutate('remove'));
}
