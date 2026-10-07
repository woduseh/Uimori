import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content, PromptPreset } from '../core/product.js';
import { Store } from '../server/store.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), path);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-library-metadata-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

test('library summary metadata keeps current visible items without loading full bodies', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-library-metadata-'));
  const store = new Store(join(path, 'synthetic.sqlite'));
  owned.push({ store, path });
  const content = store.product.content(
    fixtureBotInput('Original', 'Body '.repeat(7000))
  ) as Content;
  const prompt = store.product.promptPreset({
    title: 'Main prompt',
    role: 'main',
    text: 'Prompt '.repeat(7000),
  }) as PromptPreset;
  const changed = store.product.content(
    { ...fixtureBotInput('Current', content.text), expectedRevision: content.revision },
    content.id
  ) as Content;
  const prepare = store.db.prepare.bind(store.db);
  const returnedRows: Record<string, unknown>[] = [];
  vi.spyOn(store.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql),
      all = statement.all.bind(statement);
    vi.spyOn(statement, 'all').mockImplementation((...args) => {
      const rows = all(...args);
      returnedRows.push(...rows);
      return rows;
    });
    return statement;
  });
  expect(store.product.libraryMetadata()).toEqual({
    contents: [{ id: content.id, revision: changed.revision, title: 'Current', kind: 'bot' }],
    prompts: [{ id: prompt.id, revision: prompt.revision, title: prompt.title, role: 'main' }],
  });
  expect(returnedRows).toHaveLength(2);
  expect(returnedRows.every((row) => !('body' in row) && !('package' in row))).toBe(true);
});

test('current profiles refresh attachment revisions without loading authored bodies', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-library-metadata-'));
  const store = new Store(join(path, 'synthetic.sqlite'));
  owned.push({ store, path });
  const body = 'ATTACHED_BODY_NOT_NEEDED_FOR_PROFILE '.repeat(2000);
  const bot = store.product.content(fixtureBotInput('Profile owner', body)) as Content;
  const chat = createFixtureChat(store, 'Profile metadata', { botId: bot.id });
  const original = store.product.profile(chat.id);
  const changed = store.product.content(
    { ...fixtureBotInput('Revised owner', body), expectedRevision: bot.revision },
    bot.id
  ) as Content;
  const workspace = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: workspace.revision,
    main: { ...workspace.main, title: 'PROMPT_BODY_NOT_NEEDED_FOR_PROFILE' },
  });

  const prepare = store.db.prepare.bind(store.db);
  const returnedRows: unknown[] = [];
  vi.spyOn(store.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql),
      get = statement.get.bind(statement);
    vi.spyOn(statement, 'get').mockImplementation((...args) => {
      const row = get(...args);
      returnedRows.push(row);
      return row;
    });
    return statement;
  });
  const current = store.product.profile(chat.id);
  expect(current.packageAttachments).toEqual([
    { ...original.packageAttachments![0], revision: changed.revision },
  ]);
  expect(current.routes).toEqual({ main: null, translation: null });
  const loaded = JSON.stringify(returnedRows);
  expect(loaded.includes('ATTACHED_BODY_NOT_NEEDED_FOR_PROFILE')).toBe(false);
  expect(loaded.includes('PROMPT_BODY_NOT_NEEDED_FOR_PROFILE')).toBe(false);
  current.packageAttachments![0].revision = -1;
  expect(store.product.profile(chat.id).packageAttachments![0].revision).toBe(changed.revision);
  store.db.prepare("DELETE FROM versions WHERE kind='content' AND id=?").run(bot.id);
  expect(() => store.product.profile(chat.id)).toThrow('content revision not found');
});
