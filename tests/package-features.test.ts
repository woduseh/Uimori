import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { resolvePackageModules } from '../server/package-features.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { HiddenStoryStore } from '../server/hidden-story.js';
import { packageControlKey } from '../server/product-store.js';
import { defaultHiddenStoryConfig } from '../core/hidden-story.js';
import type { ContentPackage, PackageAttachment } from '../core/content-package.js';
import type { ChatProfile, Content } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { createHiddenNativeFixture } from './fixtures/hidden-native.js';

const owned: { store: Store; dir: string }[] = [];
afterEach(() => { for (const { store, dir } of owned.splice(0)) { store.close(); const path = relative(resolve(tmpdir()), resolve(dir)); if (isAbsolute(path) || path.startsWith('..') || !path.startsWith('uimori-package-features-')) throw Error('Unsafe cleanup'); rmSync(dir, { recursive: true, force: true }); } });
function database() { const dir = mkdtempSync(join(tmpdir(), 'uimori-package-features-')); const store = new Store(join(dir, 'test.sqlite')); owned.push({ store, dir }); return store; }
function save(store: Store, title: string, part: Partial<ContentPackage> = {}, previous?: Content): Content {
  const pkg: ContentPackage = { version: 1, id: 'draft', revision: 1, title, description: '', body: `${title} body`, lore: [], instructions: [], controls: [], transforms: [], ...part };
  return store.product.content({ kind: 'module', title, description: '', text: pkg.body, loading: 'pinned', relatedIds: [], package: pkg, ...(previous ? { expectedRevision: previous.revision } : {}) }, previous?.id) as Content;
}
const ref = (item: Content, role: PackageAttachment['role']): PackageAttachment => ({ id: item.id, revision: item.revision, role });
function update(store: Store, chatId: string, change: Partial<ChatProfile>): ChatProfile { const { chatId: _chat, revision, ...body } = store.product.profile(chatId); return store.product.updateProfile(chatId, { ...body, ...change, expectedRevision: revision }); }
function run(store: Store, chatId: string, branchId = `main:${chatId}`) {
  const chat = store.chat(chatId), branch = store.product.branch(chatId, branchId), profile = store.product.snapshot(chatId)!;
  const snapshot: RunSnapshot = { chatId, branchId, parentRevision: branch.headRevision, settingsRevision: chat.settingsRevision, settings: chat.settings, request: 'Synthetic continuation.', history: store.history(branch.headRevision), resources: store.product.resources(chatId, profile), profile };
  return store.createRun(chatId, { request: snapshot.request, expectedRevision: branch.headRevision, expectedSettingsRevision: chat.settingsRevision, expectedProfileRevision: profile.revision, branchId, idempotencyKey: randomUUID() }, () => snapshot).run;
}
function complete(store: Store, value: ReturnType<typeof run>) { store.startRun(value.id); return store.completeRun(value.id, 'Synthetic original.', { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null }, { ...value.snapshot.settings, status: false }); }
function sharedGraph(store: Store) {
  const magic = save(store, 'Shared magic', {
    controls: [{ id: 'intensity', label: '강도', type: 'number', default: 1, min: 0, max: 10 }],
    lore: [{ id: 'spell', title: 'Spell', description: '', text: 'SYNTHETIC_SHARED_SPELL', loading: 'pinned' }],
    behavior: { revision: 1, schemaVersion: 1, mode: 'authoritative', stateSchema: { type: 'record', properties: { count: { type: 'number', min: 0, max: 100, integer: true } } }, initialState: { count: 0 }, actions: [{ id: 'once', inputSchema: { type: 'record', properties: {} }, triggers: ['before-turn'], automaticInput: {}, effects: [{ path: ['count'], value: { op: 'add', args: [{ context: ['state', 'count'] }, 1] } }] }], outputParsers: [] },
  });
  const requirement = [{ id: magic.id, revision: magic.revision }];
  const bot = save(store, 'World bot', { modules: requirement }), persona = save(store, 'World persona', { modules: requirement });
  const roots = [ref(bot, 'bot'), ref(persona, 'persona')];
  const chat = store.createChat('Synthetic shared package', 'calm', () => [], { botId: bot.id });
  update(store, chat.id, { packageAttachments: roots });
  return { magic, bot, persona, roots, chat };
}
function hiddenFixture() {
  const store = database(), conversion = createHiddenNativeFixture(), hidden = new HiddenStoryStore(store.product).import({ title: 'Synthetic Hidden engine', conversion });
  const config = defaultHiddenStoryConfig();
  const feature = save(store, 'Common Hidden feature', { controls: conversion.program.controls, hiddenStory: { module: { id: hidden.id, revision: hidden.revision }, config, insertion: 'before-current' } });
  const bot = save(store, 'Synthetic host'), chat = store.createChat('Synthetic hidden module', 'calm', () => [], { botId: bot.id });
  update(store, chat.id, { packageAttachments: [ref(bot, 'bot'), ref(feature, 'module')] });
  return { store, hidden, feature, bot, chat, config };
}

test('shared requirements keep only roots in the profile and execute the pinned magic module once', () => {
  const store = database(), f = sharedGraph(store), key = packageControlKey(ref(f.magic, 'module'));
  update(store, f.chat.id, { packageValues: { [key]: { intensity: 4 } } });
  expect(store.product.profile(f.chat.id).packageAttachments).toEqual(f.roots);
  const snapshot = store.product.snapshot(f.chat.id)!;
  expect(snapshot.packageAttachments).toEqual([ref(f.bot, 'bot'), ref(f.magic, 'module'), ref(f.persona, 'persona')]);
  expect(snapshot.packageValues?.[key]).toEqual({ intensity: 4 });
  const value = run(store, f.chat.id), frozen = structuredClone(value.snapshot);
  expect(value.snapshot.resources.filter(item => item.text === 'SYNTHETIC_SHARED_SPELL')).toHaveLength(1);
  expect(value.snapshot.packageStates).toHaveLength(1); expect(value.snapshot.packageStates![0].state).toEqual({ count: 1 });
  complete(store, value); expect(behaviorDetail(store, f.chat.id).instances[0]).toMatchObject({ stateRevision: 1, state: { count: 1 } });
  expect(store.db.prepare('SELECT 1 FROM package_behavior_journal').all()).toHaveLength(1);
  save(store, 'Shared magic revised', { ...f.magic.package!, body: 'New revision only.' }, f.magic);
  expect(store.run(value.id).snapshot).toEqual(frozen); expect(store.product.snapshot(f.chat.id)!.packages!.find(item => item.id === f.magic.id)!.revision).toBe(1);
  const before = store.product.profile(f.chat.id);
  expect(() => update(store, f.chat.id, { packageValues: { 'outside@1:module': { intensity: 1 } } })).toThrow('Package controls outside attachment scope');
  expect(store.product.profile(f.chat.id)).toEqual(before);
});

test('dependency revisions, missing packages, non-package references and cycles are rejected', () => {
  const store = database(), f = sharedGraph(store), revised = save(store, 'Shared magic revised', f.magic.package, f.magic);
  expect(() => resolvePackageModules(store.product, [...f.roots, ref(revised, 'module')])).toThrow('Package module revision conflict');
  expect(() => save(store, 'Missing dependency', { modules: [{ id: 'missing-package', revision: 1 }] })).toThrow();
  const plain = store.product.content({ kind: 'lore', title: 'Legacy plain lore', description: '', text: 'Synthetic lore', loading: 'pinned', relatedIds: [] }) as Content;
  expect(() => save(store, 'Invalid dependency', { modules: [{ id: plain.id, revision: plain.revision }] })).toThrow('Required module is not a package');
  // Corruption is confined to this synthetic DB, exercising the resolver independently of authoring validation.
  const broken = { ...f.magic, package: { ...f.magic.package!, modules: [{ id: f.magic.id, revision: 1 }] } };
  store.db.prepare("UPDATE versions SET body=? WHERE kind='content' AND id=? AND revision=1").run(JSON.stringify(broken), f.magic.id);
  expect(() => resolvePackageModules(store.product, f.roots)).toThrow('Package module dependency cycle');
});

test('one required module keeps state separate across chats and branch source boundaries', () => {
  const store = database(), f = sharedGraph(store), other = store.createChat('Second synthetic story', 'calm', () => [], { botId: f.bot.id });
  update(store, other.id, { packageAttachments: f.roots });
  const first = complete(store, run(store, f.chat.id));
  const branch = store.product.createBranch(f.chat.id, { title: 'Synthetic branch', fromRevision: first.id });
  complete(store, run(store, f.chat.id));
  expect(behaviorDetail(store, f.chat.id).instances[0].state).toEqual({ count: 2 });
  expect(behaviorDetail(store, f.chat.id, branch.id).instances[0].state).toEqual({ count: 1 });
  expect(behaviorDetail(store, other.id).instances[0].state).toEqual({ count: 0 });
  complete(store, run(store, other.id));
  expect(behaviorDetail(store, other.id).instances[0].state).toEqual({ count: 1 });
  expect(behaviorDetail(store, f.chat.id).instances[0].state).toEqual({ count: 2 });
});

test('a common module exposes all 35 Hidden controls and freezes overrides into actual instruction messages', () => {
  const f = hiddenFixture(), key = packageControlKey(ref(f.feature, 'module'));
  const persona = save(f.store, 'Synthetic persona package', { identity: { name: 'SYNTHETIC_PERSONA', description: 'A synthetic participant.' } });
  expect(f.feature.package!.controls).toHaveLength(35);
  expect(f.store.product.profile(f.chat.id).hiddenStory).toBeUndefined();
  expect(f.store.product.snapshot(f.chat.id)!.hiddenStory?.config).toEqual(f.config);
  update(f.store, f.chat.id, { packageAttachments: [ref(f.bot, 'bot'), ref(persona, 'persona'), ref(f.feature, 'module')], packageValues: { [key]: { 'hidden.enabled': 0, 'hidden.customTheme': 'SYNTHETIC_THEME', 'hidden.badOutcomes': true } } });
  const value = run(f.store, f.chat.id), frozen = structuredClone(value.snapshot);
  expect(value.snapshot.hiddenStory?.module).toMatchObject({ id: f.hidden.id, revision: 1 });
  expect(value.snapshot.hiddenStory?.config.values['hidden.customTheme']).toBe('SYNTHETIC_THEME');
  const messages = value.snapshot.hiddenStory!.messages;
  expect(messages.map(item => item.content.map(part => part.text).join('')).join('\n')).toContain('SYNTHETIC_DUAL SYNTHETIC_PERSONA');
  expect(messages.map(item => item.content.map(part => part.text).join('')).join('\n')).toContain('Theme=SYNTHETIC_THEME');
  expect(messages.map(item => item.content.map(part => part.text).join('')).join('\n')).toContain('SYNTHETIC_ALLOW_LOSS');
  for (const message of messages) expect(message.provenance).toMatchObject({ sourceRevision: `${f.hidden.id}@1`, sourceHash: f.hidden.packageHash });
  f.store.finishRun(value.id, 'cancelled', 'Synthetic cleanup');
  update(f.store, f.chat.id, { packageAttachments: [ref(f.bot, 'bot'), ref(persona, 'persona')], packageValues: undefined });
  expect(f.store.product.snapshot(f.chat.id)!.hiddenStory).toBeUndefined(); expect(f.store.product.profile(f.chat.id).packageValues).toEqual({});
  expect(f.store.run(value.id).snapshot).toEqual(frozen);
  const restore = database(); restore.product.import(f.store.product.export()); expect(restore.run(value.id).snapshot).toEqual(frozen);
});

test('conflicting explicit and package Hidden selections fail atomically', () => {
  const f = hiddenFixture(), before = f.store.product.profile(f.chat.id);
  const changed = { ...f.config, values: { ...f.config.values, 'hidden.customTheme': 'conflicting theme' } };
  expect(() => new HiddenStoryStore(f.store.product).select(f.chat.id, { expectedRevision: before.revision, selection: { module: { id: f.hidden.id, revision: f.hidden.revision }, config: changed, insertion: 'before-current' } })).toThrow('Hidden Story is selected both directly and through a package');
  const conflicting = save(f.store, 'Conflicting common module', { hiddenStory: { module: { id: f.hidden.id, revision: f.hidden.revision }, config: changed, insertion: 'before-current' } });
  expect(() => update(f.store, f.chat.id, { packageAttachments: [...before.packageAttachments!, ref(conflicting, 'module')] })).toThrow('Multiple packages declare conflicting Hidden Story settings');
  expect(f.store.product.profile(f.chat.id)).toEqual(before); expect(f.store.product.attempts(f.chat.id)).toHaveLength(0);
});

test('archive validation rejects forged common-module and Hidden references and rolls back restore', () => {
  const f = hiddenFixture(), original = f.store.product.export();
  for (const corruption of ['missing-module', 'self-cycle', 'missing-hidden'] as const) {
    const archive = structuredClone(original), row = archive.tables.versions.find(item => item.kind === 'content' && item.id === f.feature.id)!;
    const content = JSON.parse(row.body);
    if (corruption === 'missing-module') content.package.modules = [{ id: 'missing-package', revision: 1 }];
    if (corruption === 'self-cycle') content.package.modules = [{ id: f.feature.id, revision: 1 }];
    if (corruption === 'missing-hidden') content.package.hiddenStory.module = { id: 'missing-hidden-engine', revision: 1 };
    row.body = JSON.stringify(content);
    const restored = database(); expect(() => restored.product.import(archive), corruption).toThrow(); expect(restored.chats()).toHaveLength(0);
  }
});
