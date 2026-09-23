import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { resolvePackageModules } from '../server/package-features.js';
import { nativeContent } from './fixtures/native-content.js';
import { createFixtureChat } from './fixtures/chat.js';
import type { Content } from '../core/product.js';
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
  name: string,
  modules: { id: string; revision: number }[] = [],
  previous?: Content
): Content {
  const pkg = nativeContent(
    { name, description: `${name} body`, system_prompt: `${name} instruction` },
    { modules: modules.map(({ id, revision }) => ({ id, revision })) },
    'module'
  );
  return store.product.content(
    {
      kind: 'module',
      title: name,
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
const ref = (item: Content, role: 'bot' | 'persona' | 'module') => ({
  id: item.id,
  revision: item.revision,
  role,
});
test('shared native modules resolve once and keep immutable snapshots independent from later revisions', () => {
  const store = database(),
    shared = save(store, 'Shared'),
    bot = save(store, 'Bot', [shared]),
    persona = save(store, 'Persona', [shared]);
  const roots = [ref(bot, 'bot'), ref(persona, 'persona')],
    resolved = resolvePackageModules(store.product, roots);
  expect(resolved.attachments).toEqual([
    ref(bot, 'bot'),
    ref(shared, 'module'),
    ref(persona, 'persona'),
  ]);
  const chat = createFixtureChat(store, 'Shared native module', { botId: bot.id }),
    current = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: current.revision,
    packageAttachments: roots,
    image: false,
  });
  const frozen = store.product.snapshot(chat.id),
    copy = structuredClone(frozen);
  save(store, 'Shared revised', [], shared);
  expect(frozen).toEqual(copy);
  expect(store.product.snapshot(chat.id).packages!.find((p) => p.id === shared.id)!.revision).toBe(
    2
  );
  expect(frozen.packages!.find((p) => p.id === shared.id)!.revision).toBe(1);
});
test('missing module dependencies, conflicting revisions and cycles are rejected atomically', () => {
  const store = database(),
    shared = save(store, 'Shared'),
    bot = save(store, 'Bot', [shared]),
    revised = save(store, 'Revised', [], shared);
  expect(() =>
    resolvePackageModules(store.product, [ref(bot, 'bot'), ref(revised, 'module')])
  ).toThrow('content revision not found');
  expect(() => save(store, 'Cycle', [bot], revised)).toThrow('Package module dependency cycle');
  expect(store.product.get<Content>('content', revised.id)).toEqual(revised);
  expect(() => save(store, 'Missing', [{ id: 'missing', revision: 1 }])).toThrow();
});
