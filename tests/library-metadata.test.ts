import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content, PromptPreset } from '../core/product.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';

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
