import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { createPackageStart } from '../server/package-start.js';
import { resolvePackageStart, validatePackageStarts } from '../core/package-start.js';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import { createFixtureChat } from './fixtures/chat.js';
const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-package-start-')
    )
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-package-start-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}

function fixture() {
  const store = database(),
    pkg = nativeContent({
      name: 'Ari',
      first_mes: '\r\nAri opens the observatory door.\n',
      alternate_greetings: ['A second opening.'],
    });
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: '',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic greeting', { botId: content.id });
  const profile = store.product.profile(chat.id);
  return {
    store,
    pkg,
    content,
    chat,
    command: {
      packageId: content.id,
      packageRevision: content.revision,
      startId: 'start-0',
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: profile.revision,
      idempotencyKey: 'native-greeting',
    },
  };
}
test('native first and alternative greetings retain authored text with no independent action language', () => {
  const pkg = nativeContent({
    first_mes: '\r\n{{char}} waits.\n',
    alternate_greetings: ['Other {{user}} greeting.'],
  });
  expect(resolvePackageStart(pkg, 'start-0').text).toBe('\r\n{{char}} waits.\n');
  expect(resolvePackageStart(pkg, 'start-1').text).toBe('Other {{user}} greeting.');
  for (const extra of [
    { values: {} },
    { initialAction: {} },
    { template: [] },
    { mode: 'generate' },
  ])
    expect(() => validatePackageStarts([{ ...pkg.starts![0], ...extra }])).toThrow();
});

test.each(['first', 'alternative'])(
  'native %s greetings preserve authored text at the one-million-character limit',
  (kind) => {
    const text = '가'.repeat(1_000_000);
    const pkg = nativeContent({
      first_mes: kind === 'first' ? text : 'First greeting',
      alternate_greetings: kind === 'alternative' ? [text] : [],
    });
    expect(resolvePackageStart(pkg, kind === 'first' ? 'start-0' : 'start-1').text).toBe(text);
  }
);

test('oversized greeting text has a distinct error from malformed authored starts', () => {
  const start = { id: 'start-0', title: 'Opening', mode: 'authored', text: 'a'.repeat(1_000_001) };
  expect(() => validatePackageStarts([start])).toThrow('PACKAGE_START_TEXT_TOO_LONG');
  expect(() => validatePackageStarts([{ ...start, text: null }])).toThrow(
    'PACKAGE_START_INVALID_TEXT'
  );
});

test('greetings retain the two-million-character combined JSON size limit', () => {
  const starts = [
    { id: 'start-0', title: 'First', mode: 'authored', text: 'a'.repeat(1_000_000) },
    { id: 'start-1', title: 'Second', mode: 'authored', text: '' },
  ];
  starts[1].text = 'b'.repeat(2_000_000 - JSON.stringify(starts).length);
  expect(JSON.stringify(starts)).toHaveLength(2_000_000);
  expect(validatePackageStarts(starts)).toEqual(starts);
  starts[1].text += 'b';
  expect(() => validatePackageStarts(starts)).toThrow('PACKAGE_START_SIZE_LIMIT');
});

test('greeting selection rejects stale ownership and subsequent attempts without adding a source', () => {
  const f = fixture();
  expect(() =>
    createPackageStart(f.store, f.chat.id, {
      ...f.command,
      expectedProfileRevision: f.command.expectedProfileRevision + 1,
    })
  ).toThrow();
  expect(f.store.chat(f.chat.id).headRevision).toBeNull();
  createPackageStart(f.store, f.chat.id, f.command);
  expect(() =>
    createPackageStart(f.store, f.chat.id, { ...f.command, idempotencyKey: 'another' })
  ).toThrow();
});
