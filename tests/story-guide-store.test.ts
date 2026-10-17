import { legacyChatBackupFixture } from './fixtures/legacy-backup.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  defaultStoryGuideConfig,
  type StoryGuideBrief,
  type StoryGuideConfig,
} from '../core/story-guide.js';
import type { RunSnapshot } from '../core/types.js';
import { importChatBackup } from '../server/chat-backup.js';
import { deleteChat } from '../server/chat-deletion.js';
import { forkChat } from '../server/chat-fork.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { Store, type Run } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('uimori-guide-'))
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-guide-'));
  const item = { directory, store: new Store(join(directory, 'app.sqlite')) };
  owned.push(item);
  return item;
}

const config: StoryGuideConfig = {
  enabled: true,
  work: 'A synthetic original world',
  reference: 'The harbor is closed in winter.',
  position: 'Before the spring festival',
  followCanon: false,
};
const usage = { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null };

function reserve(store: Store, chatId: string, replace = false) {
  const chat = store.chat(chatId);
  const head = chat.headRevision ? store.source(chat.headRevision) : undefined;
  const parent = replace ? head!.parentRevision : chat.headRevision;
  return store.createRun(
    chatId,
    {
      request: 'Continue the synthetic story',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current): RunSnapshot => ({
      chatId,
      parentRevision: parent,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Continue the synthetic story',
      history: store.history(parent),
      resources: [],
      ...(replace ? { replacement: { sourceRevision: head!.id, sourceHash: head!.hash } } : {}),
    })
  ).run;
}

function brief(run: Run, text = 'Keep the harbor closed until spring.'): StoryGuideBrief {
  return {
    fingerprint: 'a'.repeat(64),
    text,
    createdAt: '2026-10-15T00:00:00.000Z',
    parentRevision: run.parentRevision,
    configRevision: run.snapshot.storyGuide!.revision,
    runId: run.id,
    modelTitle: 'Synthetic writer',
  };
}

test('current-format databases add guide storage without changing existing chats; settings survive prompts and restart', () => {
  const fixture = database();
  const chat = createFixtureChat(fixture.store, 'Persistent guide');
  expect(fixture.store.storyGuide.get(chat.id)).toEqual({
    revision: 0,
    config: defaultStoryGuideConfig(),
    brief: null,
  });
  expect(fixture.store.db.prepare('SELECT count(*) AS n FROM chat_story_guides').get()!.n).toBe(0);
  // Reopen an otherwise current database made before the additive table existed.
  fixture.store.db.exec('DROP TABLE chat_story_guides');
  fixture.store.close();
  fixture.store = new Store(join(fixture.directory, 'app.sqlite'));
  expect(fixture.store.chat(chat.id).title).toBe('Persistent guide');
  expect(fixture.store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(15);
  const saved = fixture.store.storyGuide.update(chat.id, { expectedRevision: 0, config });
  const prompt = promptWorkspace(fixture.store);
  updatePromptWorkspace(fixture.store, {
    expectedRevision: prompt.revision,
    main: { ...prompt.main, title: 'A different writing prompt' },
  });
  fixture.store.close();
  fixture.store = new Store(join(fixture.directory, 'app.sqlite'));
  expect(fixture.store.storyGuide.get(chat.id)).toEqual(saved);
});

test('config CAS preserves newer edits and prior advice while reserved runs keep their own config', () => {
  const { store } = database();
  const chat = createFixtureChat(store, 'Config changes');
  store.storyGuide.update(chat.id, { expectedRevision: 0, config });
  const run = reserve(store, chat.id);
  const generated = brief(run);
  expect(store.storyGuide.saveBrief(chat.id, generated)).toBe(true);
  expect(store.storyGuide.update(chat.id, { expectedRevision: 1, config }).brief).toEqual(
    generated
  );
  const changed = { ...config, position: 'During the spring festival' };
  expect(store.storyGuide.update(chat.id, { expectedRevision: 1, config: changed })).toEqual({
    revision: 2,
    config: changed,
    brief: generated,
  });
  expect(() => store.storyGuide.update(chat.id, { expectedRevision: 1, config })).toThrow(
    '설정이 바뀌었어요'
  );
  expect(store.storyGuide.saveBrief(chat.id, generated)).toBe(false);
  expect(store.storyGuide.get(chat.id).brief).toEqual(generated);
  expect(store.run(run.id).snapshot.storyGuide).toEqual({ revision: 1, config });
});

test('only the current writer can publish advice; manual and cancelled late replies cannot replace it', () => {
  const { store } = database();
  const chat = createFixtureChat(store, 'Late guide replies');
  store.storyGuide.update(chat.id, { expectedRevision: 0, config });
  const old = reserve(store, chat.id);
  expect(store.storyGuide.saveBrief(chat.id, brief(old, 'Old advice'))).toBe(true);
  store.finishRun(old.id, 'cancelled', 'Synthetic cancellation');
  const current = reserve(store, chat.id);
  expect(current.snapshot.storyGuide).toEqual({ revision: 1, config });
  const accepted = brief(current, 'Current writer advice');
  expect(store.storyGuide.saveBrief(chat.id, accepted)).toBe(true);
  expect(store.storyGuide.saveBrief(chat.id, brief(old, 'Late old advice'))).toBe(false);
  expect(store.storyGuide.saveBrief(chat.id, { ...accepted, runId: undefined })).toBe(false);
  expect(store.storyGuide.saveBrief(chat.id, { ...accepted, parentRevision: 'wrong-head' })).toBe(
    false
  );
  expect(store.storyGuide.get(chat.id).brief).toEqual(accepted);
  store.startRun(current.id);
  store.completeRun(current.id, 'The writer finishes the scene.', usage);
  expect(store.storyGuide.saveBrief(chat.id, { ...accepted, text: 'Late completed advice' })).toBe(
    false
  );
  expect(store.storyGuide.get(chat.id).brief).toEqual(accepted);
});

test('regeneration publishes against the replaced head and rejects a changed source hash', () => {
  const { store } = database();
  const chat = createFixtureChat(store, 'Regenerated guide');
  store.storyGuide.update(chat.id, { expectedRevision: 0, config });
  const first = reserve(store, chat.id);
  store.startRun(first.id);
  const source = store.completeRun(first.id, 'The original scene.', usage);
  const replacement = reserve(store, chat.id, true);
  expect(replacement.parentRevision).toBeNull();
  expect(store.storyGuide.saveBrief(chat.id, brief(replacement))).toBe(true);
  store.editSource(source.id, { expectedRevision: 0, text: 'The user corrected the scene.' });
  expect(
    store.storyGuide.saveBrief(chat.id, brief(replacement, 'Outdated replacement advice'))
  ).toBe(false);
  expect(store.storyGuide.get(chat.id).brief?.text).toBe('Keep the harbor closed until spring.');
});

test('forks and portable backups copy preferences only; legacy backups stay disabled and invalid config is rejected', async () => {
  const { store } = database();
  const chat = createFixtureChat(store, 'Portable guide');
  store.storyGuide.update(chat.id, { expectedRevision: 0, config });
  const run = reserve(store, chat.id);
  expect(store.storyGuide.saveBrief(chat.id, brief(run))).toBe(true);
  store.startRun(run.id);
  store.completeRun(run.id, 'A complete synthetic scene.', usage);
  const copied = forkChat(store, chat.id, {
    fromRevision: store.chat(chat.id).headRevision,
    idempotencyKey: randomUUID(),
  });
  expect(store.storyGuide.get(copied.id)).toEqual({ revision: 1, config, brief: null });
  const backup = legacyChatBackupFixture(store, chat.id);
  expect(backup.chats[0].state.storyGuide).toEqual(config);
  expect(JSON.stringify(backup)).not.toContain('Keep the harbor closed until spring.');
  const target = database().store;
  const restored = await importChatBackup(target, { backup, idempotencyKey: randomUUID() });
  expect(target.storyGuide.get(restored.chat.id)).toEqual({ revision: 1, config, brief: null });
  const legacy = structuredClone(backup);
  delete legacy.chats[0].state.storyGuide;
  const restoredLegacy = await importChatBackup(target, {
    backup: legacy,
    idempotencyKey: randomUUID(),
  });
  expect(target.storyGuide.get(restoredLegacy.chat.id).config).toEqual(defaultStoryGuideConfig());
  const malformed = structuredClone(backup);
  malformed.chats[0].state.storyGuide!.enabled = 'yes' as unknown as boolean;
  const before = target.db.prepare('SELECT count(*) AS n FROM chats').get()!.n;
  await expect(
    importChatBackup(target, { backup: malformed, idempotencyKey: randomUUID() })
  ).rejects.toThrow('Invalid story guide settings');
  expect(target.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(before);
  deleteChat(store, copied.id, {});
  expect(store.db.prepare('SELECT 1 FROM chat_story_guides WHERE chat_id=?').get(copied.id)).toBe(
    undefined
  );
});
