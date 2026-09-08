import { updateTestProfile } from './fixtures/model-workspace.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { resolvePackageModules } from '../server/package-features.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { packageControlKey } from '../server/product-store.js';
import { freezeSourceSegments } from '../core/package-source-segments.js';
import { compiledPackages } from '../core/package-context.js';
import type { ContentPackage, PackageAttachment } from '../core/content-package.js';
import type { ChatProfile, Content } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const path = relative(resolve(tmpdir()), resolve(dir));
    if (isAbsolute(path) || path.startsWith('..') || !path.startsWith('uimori-package-features-'))
      throw Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-package-features-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
function save(
  store: Store,
  title: string,
  part: Partial<ContentPackage> = {},
  previous?: Content
): Content {
  const pkg: ContentPackage = {
    version: 1,
    id: 'draft',
    revision: 1,
    title,
    description: '',
    body: `${title} body`,
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    ...part,
  };
  return store.product.content(
    {
      kind: 'module',
      title,
      description: '',
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
      ...(previous ? { expectedRevision: previous.revision } : {}),
    },
    previous?.id
  ) as Content;
}
const ref = (item: Content, role: PackageAttachment['role']): PackageAttachment => ({
  id: item.id,
  revision: item.revision,
  role,
});
function update(store: Store, chatId: string, change: Partial<ChatProfile>): ChatProfile {
  const { chatId: _chat, revision, ...body } = store.product.profile(chatId);
  return updateTestProfile(store.product, chatId, {
    ...body,
    ...change,
    expectedRevision: revision,
  });
}
function run(store: Store, chatId: string, branchId = `main:${chatId}`) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId, branchId),
    profile = store.product.snapshot(chatId)!;
  const snapshot: RunSnapshot = {
    chatId,
    branchId,
    parentRevision: branch.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: 'Synthetic continuation.',
    history: store.history(branch.headRevision),
    resources: store.product.resources(chatId, profile),
    profile,
  };
  return store.createRun(
    chatId,
    {
      request: snapshot.request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: profile.revision,
      branchId,
      idempotencyKey: randomUUID(),
    },
    () => snapshot
  ).run;
}
function complete(store: Store, value: ReturnType<typeof run>) {
  store.startRun(value.id);
  return store.completeRun(
    value.id,
    'Synthetic original.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    { ...value.snapshot.settings, status: false }
  );
}
function sharedGraph(store: Store) {
  const magic = save(store, 'Shared magic', {
    controls: [{ id: 'intensity', label: '강도', type: 'number', default: 1, min: 0, max: 10 }],
    lore: [
      {
        id: 'spell',
        title: 'Spell',
        description: '',
        text: 'SYNTHETIC_SHARED_SPELL',
        loading: 'pinned',
      },
    ],
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
  const requirement = [{ id: magic.id, revision: magic.revision }];
  const bot = save(store, 'World bot', { modules: requirement }),
    persona = save(store, 'World persona', { modules: requirement });
  const roots = [ref(bot, 'bot'), ref(persona, 'persona')];
  const chat = createFixtureChat(store, 'Synthetic shared package', 'calm', { botId: bot.id });
  update(store, chat.id, { packageAttachments: roots });
  return { magic, bot, persona, roots, chat };
}
function segmentFixture() {
  const store = database();
  const policy = createSourceSegmentFixture();
  policy.rules[0].excludeWhen = { control: 'excludeAside' };
  policy.rules[0].expandedWhen = { control: 'expanded' };
  const feature = save(store, 'Common segment feature', {
    controls: [
      { id: 'excludeAside', label: '별도 구간 제외', type: 'boolean', default: false },
      { id: 'expanded', label: '처음 펼치기', type: 'boolean', default: false },
      { id: 'theme', label: '주제', type: 'text', default: 'SYNTHETIC_DEFAULT' },
    ],
    instructions: [
      {
        id: 'guide',
        target: 'main',
        text: 'Stored source instructions.',
        template: [
          { kind: 'text', text: 'SYNTHETIC_ASIDE Theme=' },
          { kind: 'value', expression: { control: 'theme' } },
        ],
      },
    ],
    sourceSegments: policy,
  });
  const bot = save(store, 'Synthetic host'),
    chat = createFixtureChat(store, 'Synthetic segment module', 'calm', { botId: bot.id });
  update(store, chat.id, { packageAttachments: [ref(bot, 'bot'), ref(feature, 'module')] });
  return { store, feature, bot, chat, policy };
}

test('shared requirements follow latest modules once while preserving captured runs and archives', () => {
  const store = database(),
    f = sharedGraph(store),
    key = packageControlKey(ref(f.magic, 'module'));
  update(store, f.chat.id, { packageValues: { [key]: { intensity: 4 } } });
  expect(store.product.profile(f.chat.id).packageAttachments).toEqual(f.roots);
  const snapshot = store.product.snapshot(f.chat.id)!;
  expect(snapshot.packageAttachments).toEqual([
    ref(f.bot, 'bot'),
    ref(f.magic, 'module'),
    ref(f.persona, 'persona'),
  ]);
  expect(snapshot.packageValues?.[key]).toEqual({ intensity: 4 });
  const value = run(store, f.chat.id),
    frozen = structuredClone(value.snapshot);
  expect(
    value.snapshot.resources.filter((item) => item.text === 'SYNTHETIC_SHARED_SPELL')
  ).toHaveLength(1);
  expect(value.snapshot.packageStates).toHaveLength(1);
  expect(value.snapshot.packageStates![0].state).toEqual({ count: 1 });
  complete(store, value);
  expect(behaviorDetail(store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 1 },
  });
  expect(store.db.prepare('SELECT 1 FROM package_behavior_journal').all()).toHaveLength(1);
  save(store, 'Shared magic revised', { ...f.magic.package!, body: 'New revision only.' }, f.magic);
  expect(store.run(value.id).snapshot).toEqual(frozen);
  expect(
    store.product.snapshot(f.chat.id)!.packages!.find((item) => item.id === f.magic.id)!.revision
  ).toBe(2);
  expect(store.product.snapshot(f.chat.id).packageValues?.[`${f.magic.id}@2:module`]).toEqual({
    intensity: 4,
  });
  const next = run(store, f.chat.id);
  complete(store, next);
  const current = store.product.get<Content>('content', f.magic.id);
  save(store, 'Later module', { ...current.package!, body: 'Version three.' }, current);
  const restored = database();
  restored.product.import(store.product.export());
  expect(restored.run(value.id).snapshot).toEqual(frozen);
  expect(
    restored.run(next.id).snapshot.profile?.packages?.find((p) => p.id === f.magic.id)?.revision
  ).toBe(2);
  expect(
    restored.product.snapshot(f.chat.id).packages?.find((p) => p.id === f.magic.id)?.revision
  ).toBe(3);
  const before = store.product.profile(f.chat.id);
  expect(() =>
    update(store, f.chat.id, { packageValues: { 'outside@1:module': { intensity: 1 } } })
  ).toThrow('Package controls outside attachment scope');
  expect(store.product.profile(f.chat.id)).toEqual(before);
});

test('dependency revisions, missing packages, non-package references and cycles are rejected', () => {
  const store = database(),
    f = sharedGraph(store),
    revised = save(store, 'Shared magic revised', f.magic.package, f.magic);
  expect(() => resolvePackageModules(store.product, [...f.roots, ref(revised, 'module')])).toThrow(
    'Package module revision conflict'
  );
  expect(
    resolvePackageModules(store.product, [...f.roots, ref(revised, 'module')], {
      latest: true,
    }).attachments.filter((r) => r.id === revised.id)
  ).toEqual([ref(revised, 'module')]);
  expect(() =>
    save(
      store,
      'Cycle through current IDs',
      { ...revised.package!, modules: [{ id: f.bot.id, revision: f.bot.revision }] },
      revised
    )
  ).toThrow('Package module dependency cycle');
  expect(store.product.get<Content>('content', revised.id)).toEqual(revised);
  expect(() =>
    store.product.content(
      {
        kind: 'module',
        title: revised.title,
        description: '',
        text: 'Remove package',
        loading: 'pinned',
        relatedIds: [],
        expectedRevision: revised.revision,
      },
      revised.id
    )
  ).toThrow('Referenced content must keep its package structure');
  expect(store.product.get<Content>('content', revised.id)).toEqual(revised);
  expect(store.product.snapshot(f.chat.id).packageAttachments).toContainEqual(
    ref(revised, 'module')
  );
  expect(() =>
    save(store, 'Missing dependency', { modules: [{ id: 'missing-package', revision: 1 }] })
  ).toThrow();
  const plain = store.product.content({
    kind: 'module',
    title: 'Legacy plain lore',
    description: '',
    text: 'Synthetic lore',
    loading: 'pinned',
    relatedIds: [],
  }) as Content;
  expect(() =>
    save(store, 'Invalid dependency', { modules: [{ id: plain.id, revision: plain.revision }] })
  ).toThrow('Required module is not a package');
  // Corruption is confined to this synthetic DB, exercising the resolver independently of authoring validation.
  const broken = {
    ...f.magic,
    package: { ...f.magic.package!, modules: [{ id: f.magic.id, revision: 1 }] },
  };
  store.db
    .prepare("UPDATE versions SET body=? WHERE kind='content' AND id=? AND revision=1")
    .run(JSON.stringify(broken), f.magic.id);
  expect(() => resolvePackageModules(store.product, f.roots)).toThrow(
    'Package module dependency cycle'
  );
});

test('one required module keeps state separate across chats and branch source boundaries', () => {
  const store = database(),
    f = sharedGraph(store),
    other = createFixtureChat(store, 'Second synthetic story', 'calm', { botId: f.bot.id });
  update(store, other.id, { packageAttachments: f.roots });
  const first = complete(store, run(store, f.chat.id));
  const branch = store.product.createBranch(f.chat.id, {
    title: 'Synthetic branch',
    fromRevision: first.id,
  });
  complete(store, run(store, f.chat.id));
  expect(behaviorDetail(store, f.chat.id).instances[0].state).toEqual({ count: 2 });
  expect(behaviorDetail(store, f.chat.id, branch.id).instances[0].state).toEqual({ count: 1 });
  expect(behaviorDetail(store, other.id).instances[0].state).toEqual({ count: 0 });
  complete(store, run(store, other.id));
  expect(behaviorDetail(store, other.id).instances[0].state).toEqual({ count: 1 });
  expect(behaviorDetail(store, f.chat.id).instances[0].state).toEqual({ count: 2 });
});

test('common module controls freeze source rules and instructions equally for preview and accepted runs', () => {
  const f = segmentFixture(),
    key = packageControlKey(ref(f.feature, 'module'));
  const persona = save(f.store, 'Synthetic persona package', {
    identity: { name: 'SYNTHETIC_PERSONA', description: 'A synthetic participant.' },
  });
  expect(f.feature.package!.controls.map((control) => control.id)).toEqual([
    'excludeAside',
    'expanded',
    'theme',
  ]);
  expect(freezeSourceSegments(f.store.product.snapshot(f.chat.id))!.rules[0]).toMatchObject({
    exclude: false,
    expanded: false,
  });
  update(f.store, f.chat.id, {
    packageAttachments: [ref(f.bot, 'bot'), ref(persona, 'persona'), ref(f.feature, 'module')],
    packageValues: {
      [key]: {
        excludeAside: true,
        expanded: true,
        theme: 'SYNTHETIC_THEME',
      },
    },
  });
  const value = run(f.store, f.chat.id),
    frozen = structuredClone(value.snapshot);
  const preview = { ...value.snapshot, profile: f.store.product.snapshot(f.chat.id) };
  expect(value.snapshot.sourceSegments).toEqual(freezeSourceSegments(preview.profile));
  expect(value.snapshot.sourceSegments!.rules[0]).toMatchObject({
    id: `${key}:aside`,
    exclude: true,
    expanded: true,
  });
  expect(value.snapshot.sourceSegments!.rules[0]).not.toHaveProperty('excludeWhen');
  const instructions = compiledPackages(value.snapshot, 'main').flatMap(
    (item) => item.instructions
  );
  expect(instructions).toEqual(
    compiledPackages(preview, 'main').flatMap((item) => item.instructions)
  );
  expect(instructions.map((item) => item.text).join('\n')).toContain(
    'SYNTHETIC_ASIDE Theme=SYNTHETIC_THEME'
  );
  expect(f.store.product.attempts(f.chat.id)).toHaveLength(0);
  f.store.finishRun(value.id, 'cancelled', 'Synthetic cleanup');
  update(f.store, f.chat.id, {
    packageAttachments: [ref(f.bot, 'bot'), ref(persona, 'persona')],
    packageValues: undefined,
  });
  expect(freezeSourceSegments(f.store.product.snapshot(f.chat.id))).toBeUndefined();
  expect(f.store.product.profile(f.chat.id).packageValues).toEqual({});
  expect(f.store.run(value.id).snapshot).toEqual(frozen);
  const restore = database();
  restore.product.import(f.store.product.export());
  expect(restore.run(value.id).snapshot).toEqual(frozen);
});

test('duplicate rules resolve once and conflicting package delimiters fail atomically for the current profile', () => {
  const f = segmentFixture(),
    before = f.store.product.profile(f.chat.id);
  const duplicate = save(f.store, 'Same common rule', {
    controls: f.feature.package!.controls,
    sourceSegments: f.policy,
  });
  update(f.store, f.chat.id, {
    packageAttachments: [...before.packageAttachments!, ref(duplicate, 'module')],
  });
  expect(freezeSourceSegments(f.store.product.snapshot(f.chat.id))!.rules).toHaveLength(2);
  const current = f.store.product.profile(f.chat.id);
  const changed = structuredClone(f.policy);
  changed.rules[0].label = 'Conflicting meaning';
  const conflicting = save(f.store, 'Conflicting common module', {
    controls: f.feature.package!.controls,
    sourceSegments: changed,
  });
  expect(() =>
    update(f.store, f.chat.id, {
      packageAttachments: [...current.packageAttachments!, ref(conflicting, 'module')],
    })
  ).toThrow('SEGMENT_DELIMITER_CONFLICT');
  expect(() =>
    update(f.store, f.chat.id, {
      packageValues: { [packageControlKey(ref(duplicate, 'module'))]: { expanded: true } },
    })
  ).toThrow('SEGMENT_DELIMITER_CONFLICT');
  expect(f.store.product.profile(f.chat.id)).toEqual(current);
  expect(f.store.product.attempts(f.chat.id)).toHaveLength(0);
});

test('archive validation rejects forged common-module references and source declarations and rolls back restore', () => {
  const f = segmentFixture(),
    original = f.store.product.export();
  for (const corruption of [
    'missing-module',
    'self-cycle',
    'invalid-segment',
    'unknown-control',
  ] as const) {
    const archive = structuredClone(original),
      row = archive.tables.versions.find(
        (item) => item.kind === 'content' && item.id === f.feature.id
      )!;
    const content = JSON.parse(row.body);
    if (corruption === 'missing-module')
      content.package.modules = [{ id: 'missing-package', revision: 1 }];
    if (corruption === 'self-cycle') content.package.modules = [{ id: f.feature.id, revision: 1 }];
    if (corruption === 'invalid-segment')
      content.package.sourceSegments.rules[0].close = content.package.sourceSegments.rules[0].open;
    if (corruption === 'unknown-control')
      content.package.sourceSegments.rules[0].excludeWhen = { control: 'missing' };
    row.body = JSON.stringify(content);
    const restored = database();
    expect(() => restored.product.import(archive), corruption).toThrow();
    expect(restored.chats()).toHaveLength(0);
  }
});
