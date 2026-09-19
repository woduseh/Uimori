import { nativeContent } from './fixtures/native-content.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { prepareNativeFixtureRun } from './fixtures/native-run.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import type { Content, PromptPreset } from '../core/product.js';
import type { RisuContent } from '../core/risu-content.js';
import { packageContext } from '../core/package-context.js';
const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-redesign-integration-')
    )
      throw Error('Unsafe fixture cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function db() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-redesign-integration-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
const reference = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
function packageBody(): RisuContent {
  return nativeContent(
    {
      name: 'Imported title',
      creator_notes: 'Imported description',
      description: 'Imported body',
      system_prompt: 'Exact original instruction',
      character_book: {
        entries: [{ uid: 1, name: 'Lore', content: 'Exact original lore', constant: false }],
      },
    },
    { id: 'imported', revision: 17 },
    'module'
  );
}
function save(store: Store, pkg = packageBody(), prior?: Content) {
  return store.product.content(
    {
      kind: 'module',
      title: 'Outer title',
      description: 'Outer description',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
      ...(prior ? { expectedRevision: prior.revision } : {}),
    },
    prior?.id
  ) as Content;
}
function update(store: Store, chatId: string, changes: Record<string, unknown>) {
  const p = store.product.profile(chatId);
  return updateTestProfile(store.product, chatId, {
    expectedRevision: p.revision,
    packageAttachments: p.packageAttachments,

    routes: p.routes,
    image: p.image,
    ...changes,
  });
}
async function capture(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (c) => ({
      chatId,
      parentRevision: c.headRevision,
      settingsRevision: c.settingsRevision,
      settings: c.settings,
      request: 'Synthetic',
      history: store.history(c.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  ).run;
  await prepareNativeFixtureRun(store, run);
  store.startRun(run.id);
  store.completeRun(
    run.id,
    'Synthetic original',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  return store.run(run.id);
}
test('native source normalizes projections and freezes old run content after editing', async () => {
  const store = db(),
    input = packageBody(),
    saved = save(store, input);
  expect(saved.package).toEqual({ ...input, id: saved.id, revision: 1 });
  expect(input.id).toBe('imported');
  const chat = createFixtureChat(store, 'Story', 'calm', { botId: saved.id });
  const run = await capture(store, chat.id),
    before = JSON.stringify(run.snapshot);
  const edited = save(
    store,
    {
      ...saved.package,
      nativeRisu: {
        ...saved.package.nativeRisu,
        card: { ...saved.package.nativeRisu.card, system_prompt: 'NEW' },
      },
    },
    saved
  );
  expect(edited.revision).toBe(2);
  expect(JSON.stringify(store.run(run.id).snapshot)).toBe(before);
  expect(packageContext(store.run(run.id).snapshot, 'main')!.instructions[0].text).toBe(
    'Exact original instruction'
  );
  const summary = store.product.library(true).contents.find((c) => c.id === saved.id)!;
  expect(summary.hasPackage).toBe(true);
  expect(summary.package).toBeUndefined();
  expect(summary.text).toBe('');
});
test('cross-role attachment of one package namespaces resources while invalid refs and mixed primary roles reject atomically', () => {
  const store = db(),
    pkg = save(store),
    chat = createFixtureChat(store, 'Story', 'calm', { botId: pkg.id });
  const refs = [
    { ...reference(pkg), role: 'bot' },
    { ...reference(pkg), role: 'persona' },
  ];
  update(store, chat.id, { packageAttachments: refs });
  const profile = store.product.snapshot(chat.id)!,
    resources = store.product.resources(chat.id, profile);
  expect(new Set(resources.map((r) => r.id)).size).toBe(resources.length);
  expect(resources.some((r) => r.id.includes(':bot:'))).toBe(true);
  expect(resources.some((r) => r.id.includes(':persona:'))).toBe(true);
  const before = store.product.profile(chat.id);
  expect(() =>
    update(store, chat.id, { packageAttachments: [{ id: pkg.id, revision: 999, role: 'bot' }] })
  ).toThrow('revision not found');
  expect(() => update(store, chat.id, { packageAttachments: [refs[0], refs[0]] })).toThrow(
    'Duplicate package'
  );
  expect(store.product.profile(chat.id)).toEqual(before);
});
function prompt(store: Store, id = 'choice'): PromptPreset {
  const preset = store.product.promptPreset({
    title: 'Composed',
    role: 'main',
    text: '',
    program: nativePrompt('Synthetic native instructions', {
      customPromptTemplateToggle: `${id}=${id}=select=Off,On`,
    }),
  }) as PromptPreset;
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: preset.title, program: preset.program, values: {} },
  });
  return preset;
}
test('prompt combinations reject nonprimitive values and controls from a different prompt', () => {
  const store = db(),
    p = prompt(store);
  expect(() =>
    store.product.promptCombination({
      workspaceRevision: promptWorkspace(store).revision,
      title: 'Bad',
      role: 'main',
      values: { choice: { nested: true } },
    })
  ).toThrow('PROMPT_INVALID_VALUE');
  prompt(store, 'different');
  expect(() =>
    store.product.promptCombination({
      workspaceRevision: promptWorkspace(store).revision,
      title: 'Bad',
      role: 'main',
      values: { choice: '1' },
    })
  ).toThrow('PROMPT_UNKNOWN_CONTROL');
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: p.title, program: p.program, values: {} },
  });
  expect(
    store.product.promptCombination({
      workspaceRevision: promptWorkspace(store).revision,
      title: 'Saved',
      role: 'main',
      values: { choice: '0' },
    }).values
  ).toEqual({ choice: '0' });
});
test('current archive roundtrips native lore, option combinations and bot folder ownership', async () => {
  const store = db(),
    body = packageBody();
  (body.nativeRisu.card.character_book as { entries: { content: string }[] }).entries[0].content =
    'L'.repeat(100001);
  const pkg = save(store, body);
  const folder = store.organization.createFolder(pkg.id, {
    title: 'Folder',
    defaultPersona: reference(pkg),
  });
  const chat = createFixtureChat(store, 'Story', 'calm', { botId: pkg.id, folderId: folder.id });
  prompt(store);
  const combination = store.product.promptCombination({
    workspaceRevision: promptWorkspace(store).revision,
    title: 'Saved',
    role: 'main',
    values: { choice: '0' },
  });
  const run = await capture(store, chat.id);
  const archive = store.product.export();
  expect(archive.version).toBe(1);
  const before = JSON.stringify(archive);
  const restored = db();
  expect(restored.product.import(archive)).toEqual({ restored: true, chats: 1 });
  expect(JSON.stringify(archive)).toBe(before);
  expect(restored.organization.metadata(chat.id)).toEqual(store.organization.metadata(chat.id));
  expect(restored.organization.folder(pkg.id, folder.id)).toEqual(folder);
  expect(restored.product.profile(chat.id)).toEqual(store.product.profile(chat.id));
  expect(restored.product.get('prompt-combination', combination.id)).toEqual(combination);
  expect(restored.run(run.id).snapshot.resources).toEqual(run.snapshot.resources);
  expect(restored.run(run.id).snapshot.profile!.packages).toEqual(run.snapshot.profile!.packages);
});
test('malformed package import and forged archive package body roll back all writes', () => {
  const store = db();
  expect(() =>
    save(store, {
      ...packageBody(),
      lore: [
        {
          id: 'a',
          title: '',
          description: '',
          text: 'x',
          loading: 'discoverable',
          relatedIds: ['missing'],
        },
      ],
    })
  ).toThrow('PACKAGE_LORE_REFERENCE');
  expect(store.product.all('content')).toEqual([]);
  save(store);
  const archive = store.product.export();
  const row = archive.tables.versions.find((r) => r.kind === 'content')!;
  const body = JSON.parse(row.body);
  body.package.body = 'Forged';
  row.body = JSON.stringify(body);
  const restored = db();
  expect(() => restored.product.import(archive)).toThrow('Package identity mismatch');
  expect(restored.product.all('content')).toEqual([]);
});
test('native body and creator notes survive archive at supported sizes', () => {
  const store = db();
  const body = nativeContent(
    { name: 'Large', description: 'b'.repeat(100001), creator_notes: 'd'.repeat(3000) },
    { id: 'large' },
    'module'
  );
  const saved = save(store, body);
  expect(saved.package.body).toBe(body.body);
  expect(saved.package.description).toBe(body.description);
  const restored = db();
  restored.product.import(store.product.export());
  expect(restored.product.get('content', saved.id)).toEqual(saved);
});
