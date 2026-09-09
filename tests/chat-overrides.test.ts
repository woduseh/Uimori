import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import {
  ChatOverridesStore,
  validateChatOverrideArchive,
  validateChatOverrideSnapshot,
  type ChatOverrideAuthority,
} from '../server/chat-overrides.js';
import { chatOverrideHash, type ChatLoreSelector } from '../core/chat-overrides.js';
import type { Content } from '../core/product.js';
import type { ContentPackage, PackageAttachment } from '../core/content-package.js';
import { compiledPackages } from '../core/package-context.js';
import { roleResources } from '../core/provider.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { forkChat } from '../server/chat-fork.js';

const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const target = resolve(dir),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-chat-overrides-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-chat-overrides-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
const authority: ChatOverrideAuthority = { requestId: 'explicit-chat-lore-edit', assert: () => {} };
function save(
  store: Store,
  title: string,
  part: Partial<ContentPackage> = {},
  prior?: Content
): Content {
  const model = fixtureBotInput(title, 'Unchanged package body');
  model.package.lore = [
    {
      id: 'fact',
      title: 'Fact',
      description: 'Original description',
      text: 'Original lore',
      loading: 'pinned',
    },
  ];
  Object.assign(model.package, part);
  return store.product.content(
    { ...model, ...(prior ? { expectedRevision: prior.revision } : {}) },
    prior?.id
  ) as Content;
}
const ref = (content: Content, role: PackageAttachment['role']): PackageAttachment => ({
  id: content.id,
  revision: content.revision,
  role,
});
function profile(store: Store, chatId: string, roots: PackageAttachment[]) {
  const prior = store.product.profile(chatId);
  return store.product.updateProfile(chatId, {
    expectedRevision: prior.revision,
    attachments: [],
    image: false,
    packageAttachments: roots,
  });
}
function patch(
  store: Store,
  chatId: string,
  selector: ChatLoreSelector,
  value: string,
  branchId?: string
) {
  const service = new ChatOverridesStore(store),
    state = service.get(chatId, branchId);
  const selected = state.attachments.find(
    (item) =>
      item.scope.id === selector.id &&
      item.scope.role === selector.role &&
      JSON.stringify(item.scope.modulePath) === JSON.stringify(selector.modulePath)
  )!;
  const field = selected.lore.find((lore) => lore.id === selector.loreId)![selector.field];
  const input = {
    selector,
    value,
    branchId: state.branchId,
    expectedRevision: state.revision,
    expectedHeadRevision: state.headRevision,
    expectedProfileRevision: state.profileRevision,
    expectedPackageRevision: selected.packageRevision,
    expectedFieldHash: chatOverrideHash(field),
    operationId: randomUUID(),
  };
  return { service, input, result: service.patch(chatId, input, authority) };
}
function run(store: Store, chatId: string, branchId?: string) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId, branchId);
  // Intentionally start from the default-head profile: createRun must scope overrides to the chosen branch.
  const frozen = store.product.snapshot(chatId);
  return store.createRun(
    chatId,
    {
      request: 'Continue synthetic story',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      branchId: branch.id,
      idempotencyKey: randomUUID(),
    },
    () => ({
      chatId,
      parentRevision: branch.headRevision,
      settings: chat.settings,
      settingsRevision: chat.settingsRevision,
      request: 'Continue synthetic story',
      history: store.history(branch.headRevision),
      resources: store.product.resources(chatId, frozen),
      profile: frozen,
    })
  ).run;
}
function complete(store: Store, value: ReturnType<typeof run>) {
  store.startRun(value.id);
  return store.completeRun(
    value.id,
    `Synthetic ${value.id}`,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    { ...value.snapshot.settings, status: false }
  );
}
const selector = (
  content: Content,
  role: PackageAttachment['role'] = 'bot',
  modulePath: string[] = []
): ChatLoreSelector => ({ id: content.id, role, modulePath, loreId: 'fact', field: 'text' });

test('the same package in bot and persona roles receives an override only on the requested attachment', () => {
  const store = database(),
    bot = save(store, 'Shared identity'),
    chat = store.createChat('Role scope', 'calm', { botId: bot.id });
  profile(store, chat.id, [ref(bot, 'bot'), ref(bot, 'persona')]);
  patch(store, chat.id, selector(bot), 'Bot-only local lore');
  const value = run(store, chat.id),
    original = structuredClone(value.snapshot);
  const compiled = compiledPackages(value.snapshot, 'main');
  expect(
    compiled
      .find((item) => item.attachment.role === 'bot')
      ?.resources.find((resource) => resource.sourceKind === 'lore')?.text
  ).toBe('Bot-only local lore');
  expect(
    compiled
      .find((item) => item.attachment.role === 'persona')
      ?.resources.find((resource) => resource.sourceKind === 'lore')?.text
  ).toBe('Original lore');
  expect(
    value.snapshot.profile!.packages!.every((pkg) => pkg.lore[0].text === 'Original lore')
  ).toBe(true);
  expect(store.product.get<Content>('content', bot.id)).toEqual(bot);
  complete(store, value);
  const changed = save(
    store,
    'Shared identity revised',
    {
      ...bot.package!,
      lore: [{ ...bot.package!.lore[0], description: 'Unrelated original update' }],
    },
    bot
  );
  const live = store.product.snapshot(chat.id);
  expect(live.chatOverrides!.conflicts).toEqual([]);
  expect(
    live.chatOverrides!.projections.find((item) => item.scope.role === 'bot')!.package.lore[0]
  ).toMatchObject({ text: 'Bot-only local lore', description: 'Unrelated original update' });
  save(
    store,
    'Changed relevant field',
    {
      ...changed.package!,
      lore: [{ ...changed.package!.lore[0], text: 'Author changed the same field' }],
    },
    changed
  );
  const conflict = store.product.snapshot(chat.id);
  expect(conflict.chatOverrides!.conflicts).toMatchObject([
    { kind: 'source-changed', currentValue: 'Author changed the same field' },
  ]);
  expect(
    conflict.chatOverrides!.projections.find((item) => item.scope.role === 'bot')!.package.lore[0]
      .text
  ).toBe('Bot-only local lore');
  expect(store.run(value.id).snapshot).toEqual(original);
});

test('a shared nested module keeps its other path unchanged and executes canonical behavior and instructions once', () => {
  const store = database();
  const module = save(store, 'Shared module', {
    instructions: [{ id: 'one-guide', target: 'main', text: 'Execute guide once' }],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      mode: 'authoritative',
      stateSchema: {
        type: 'record',
        properties: { count: { type: 'number', min: 0, max: 100, integer: true } },
      },
      initialState: { count: 0 },
      actions: [
        {
          id: 'once',
          inputSchema: { type: 'record', properties: {} },
          triggers: ['before-turn'],
          automaticInput: {},
          effects: [
            { path: ['count'], value: { op: 'add', args: [{ context: ['state', 'count'] }, 1] } },
          ],
        },
      ],
      outputParsers: [],
    },
  });
  const middle = save(store, 'Middle module', {
    lore: [],
    modules: [{ id: module.id, revision: module.revision }],
  });
  const bot = save(store, 'Bot root', {
    lore: [],
    modules: [{ id: middle.id, revision: middle.revision }],
  });
  const persona = save(store, 'Persona root', {
    lore: [],
    modules: [{ id: module.id, revision: module.revision }],
  });
  const chat = store.createChat('Nested scope', 'calm', { botId: bot.id });
  profile(store, chat.id, [ref(bot, 'bot'), ref(persona, 'persona')]);
  patch(store, chat.id, selector(bot, 'bot', [middle.id, module.id]), 'Only bot nested path');
  const value = run(store, chat.id),
    resources = roleResources(value.snapshot);
  expect(resources.filter((item) => item.text === 'Only bot nested path')).toHaveLength(1);
  expect(resources.filter((item) => item.text === 'Original lore')).toHaveLength(1);
  expect(new Set(resources.map((item) => item.id)).size).toBe(resources.length);
  expect(
    compiledPackages(value.snapshot, 'main')
      .flatMap((item) => item.instructions)
      .filter((item) => item.text === 'Execute guide once')
  ).toHaveLength(1);
  expect(value.snapshot.packageStates).toHaveLength(1);
  expect(value.snapshot.packageStates![0].state).toEqual({ count: 1 });
  expect(value.snapshot.profile!.packages!.find((pkg) => pkg.id === module.id)!.lore[0].text).toBe(
    'Original lore'
  );
});

test('authority, source scope, root/package revisions and text-only selectors reject forged or stale changes atomically', () => {
  const store = database(),
    bot = save(store, 'Scoped bot'),
    unrelated = save(store, 'Unrelated module');
  const chat = store.createChat('Mutation guards', 'calm', { botId: bot.id });
  const { service, input, result } = patch(store, chat.id, selector(bot), 'Local');
  expect(service.patch(chat.id, input, authority)).toEqual(result);
  const denied: ChatOverrideAuthority = {
    requestId: authority.requestId,
    assert: () => {
      throw new Error('Task grant denies this attachment');
    },
  };
  expect(() => service.patch(chat.id, input, denied)).toThrow(/grant denies/);
  expect(() => service.patch(chat.id, { ...input, value: 'Changed replay' }, authority)).toThrow(
    /reused/
  );
  const next = { ...input, operationId: randomUUID(), expectedRevision: result.revision };
  expect(() =>
    service.patch(
      chat.id,
      { ...next, selector: { ...input.selector, field: 'behavior' } },
      authority
    )
  ).toThrow(/TEXT_FIELD/);
  expect(() =>
    service.patch(
      chat.id,
      { ...next, selector: { ...input.selector, modulePath: [unrelated.id] } },
      authority
    )
  ).toThrow(/연결 경로/);
  expect(() =>
    service.patch(chat.id, { ...next, expectedFieldHash: '0'.repeat(64) }, authority)
  ).toThrow(/필드/);
  expect(() =>
    service.patch(chat.id, { ...next, expectedHeadRevision: randomUUID() }, authority)
  ).toThrow(/원문/);
  expect(() =>
    service.patch(
      chat.id,
      { ...next, expectedProfileRevision: input.expectedProfileRevision + 1 },
      authority
    )
  ).toThrow(/자료 연결/);
  expect(service.revision(chat.id)).toBe(result.revision);
  expect(store.db.prepare('SELECT 1 FROM chat_override_operations').all()).toHaveLength(1);
});

test('branch reservation and fork exclude later source-anchored overrides while preserving the selected past', () => {
  const store = database(),
    bot = save(store, 'Fork bot'),
    chat = store.createChat('Anchor scope', 'calm', { botId: bot.id });
  const first = complete(store, run(store, chat.id));
  patch(store, chat.id, selector(bot), 'Valid at first source');
  const branch = store.product.createBranch(chat.id, {
    title: 'Earlier branch',
    fromRevision: first.id,
  });
  const second = complete(store, run(store, chat.id));
  patch(store, chat.id, selector(bot), 'Future override at second source');
  const earlier = run(store, chat.id, branch.id);
  expect(
    roleResources(earlier.snapshot).some((item) => item.text === 'Valid at first source')
  ).toBe(true);
  expect(
    roleResources(earlier.snapshot).some((item) => item.text === 'Future override at second source')
  ).toBe(false);
  store.finishRun(earlier.id, 'cancelled', 'Synthetic test cleanup');
  const forked = forkChat(store, chat.id, { fromRevision: first.id, idempotencyKey: randomUUID() });
  const copied = new ChatOverridesStore(store).get(forked.id);
  expect(copied.overrides.map((entry) => entry.value)).toEqual(['Valid at first source']);
  expect(copied.overrides[0].atSource).toBe(forked.headRevision);
  expect(copied.overrides[0].atSource).not.toBe(first.id);
  expect(
    store.db.prepare('SELECT 1 FROM chat_override_operations WHERE chat_id=?').all(forked.id)
  ).toHaveLength(0);
  expect(store.source(second.id).chatId).toBe(chat.id);
  validateChatOverrideArchive(store);
});

test('an edited source anchor preserves the override record but excludes it from new request projections', () => {
  const store = database(),
    bot = save(store, 'Retcon bot'),
    chat = store.createChat('Anchor hash', 'calm', { botId: bot.id });
  const source = complete(store, run(store, chat.id));
  patch(store, chat.id, selector(bot), 'Before retcon');
  store.editSource(source.id, { text: 'Edited historical source', expectedRevision: 0 });
  const service = new ChatOverridesStore(store),
    current = service.get(chat.id);
  expect(current.overrides[0].value).toBe('Before retcon');
  expect(current.conflicts).toMatchObject([{ kind: 'anchor-changed' }]);
  expect(store.product.snapshot(chat.id).chatOverrides!.projections).toEqual([]);
});

test('override versions, operation receipts and frozen original/projection snapshots roundtrip and reject tampering', () => {
  const store = database(),
    bot = save(store, 'Archive bot'),
    chat = store.createChat('Archive scope', 'calm', { botId: bot.id });
  const { input, result } = patch(store, chat.id, selector(bot), 'Archived local lore');
  const generated = run(store, chat.id);
  complete(store, generated);
  validateChatOverrideArchive(store);
  validateChatOverrideSnapshot(store, generated.snapshot.profile!, generated.snapshot.history);
  const archive = store.product.export(),
    restored = database();
  restored.product.import(archive);
  expect(restored.run(generated.id).snapshot).toEqual(store.run(generated.id).snapshot);
  expect(new ChatOverridesStore(restored).patch(chat.id, input, authority)).toEqual(result);
  const forged = structuredClone(generated.snapshot.profile!);
  forged.chatOverrides!.projections[0].package.body = 'Forged executable body';
  expect(() => validateChatOverrideSnapshot(restored, forged, generated.snapshot.history)).toThrow(
    /projection mismatch/
  );
  const malformed = structuredClone(archive),
    row = malformed.tables.chat_lore_overrides[0];
  const entry = JSON.parse(String(row.body));
  entry.baseEntry.text = 'Fabricated source';
  row.body = JSON.stringify(entry);
  const target = database();
  expect(() => target.product.import(malformed)).toThrow();
  expect(target.chats()).toHaveLength(0);
});
