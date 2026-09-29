import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chatOverrideHash, type ChatLoreSelector } from '../core/chat-overrides.js';
import type { Content } from '../core/product.js';
import { ChatOverridesStore } from '../server/chat-overrides.js';
import { readHelperChatLore } from '../server/helper-lore-read.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { createTestDirectory } from './fixtures/test-directory.js';

const owned: (ReturnType<typeof createTestDirectory> & { store: Store })[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    item.remove();
  }
});

test('lore pages discover live overrides only on their attachment and retain conflict and removal details', () => {
  const temporary = createTestDirectory('uimori-helper-lore-read-');
  const store = new Store(join(temporary.directory, 'test.sqlite'));
  owned.push({ ...temporary, store });
  const input = fixtureBotInput('Shared lore owner', 'Unchanged body');
  const entry = { comment: 'Harbor', keys: ['port'], content: 'Original harbor text' };
  input.package.nativeRisu.card.character_book = { entries: [entry] };
  const bot = store.product.content(input) as Content;
  const chat = store.createChat('Scoped lore discovery', { botId: bot.id });
  const profile = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    image: false,
    packageAttachments: [
      { id: bot.id, revision: bot.revision, role: 'bot' },
      { id: bot.id, revision: bot.revision, role: 'persona' },
    ],
  });
  const list = (offset = 0) => {
    const page = readHelperChatLore(store, chat.id, { offset, limit: 1 });
    if (!('items' in page)) throw new Error('Expected a lore list');
    return page;
  };
  expect(list()).toMatchObject({ total: 2, nextOffset: 1 });
  expect(list().items[0]).not.toHaveProperty('overrides');
  const service = new ChatOverridesStore(store);
  const selector: ChatLoreSelector = {
    id: bot.id,
    role: 'bot',
    modulePath: [],
    loreId: 'lore-0',
    field: 'text',
  };
  const original = service.get(chat.id);
  const changed = service.patch(
    chat.id,
    {
      selector,
      value: 'Chat-only harbor text',
      expectedRevision: original.revision,
      expectedHeadRevision: original.headRevision,
      expectedProfileRevision: original.profileRevision,
      expectedPackageRevision: bot.package.revision,
      expectedFieldHash: chatOverrideHash(entry.content),
      operationId: randomUUID(),
    },
    'discover-scoped-override'
  );
  const first = list();
  expect(first.items[0]).toMatchObject({
    scope: { id: bot.id, role: 'bot', modulePath: [] },
    overrides: [{ field: 'text', id: changed.entry.id, conflicts: [] }],
    fieldHashes: { text: chatOverrideHash(entry.content) },
  });
  expect(JSON.stringify(first)).not.toContain('Chat-only harbor text');
  expect(list(1).items[0]).toMatchObject({ scope: { role: 'persona' } });
  expect(list(1).items[0]).not.toHaveProperty('overrides');
  expect(list(1).nextOffset).toBeNull();

  const nextInput = structuredClone(input);
  nextInput.package.nativeRisu.card.character_book = {
    entries: [{ ...entry, content: 'Author changed the original text' }],
  };
  const revised = store.product.content(
    { ...nextInput, expectedRevision: bot.revision },
    bot.id
  ) as Content;
  expect(list().items[0]).toMatchObject({
    overrides: [{ field: 'text', id: changed.entry.id, conflicts: ['source-changed'] }],
  });
  expect(readHelperChatLore(store, chat.id, { selector })).toMatchObject({
    original: { text: 'Author changed the original text' },
    override: {
      id: changed.entry.id,
      text: 'Chat-only harbor text',
      conflicts: ['source-changed'],
    },
    expectedFieldHash: chatOverrideHash('Author changed the original text'),
  });

  nextInput.package.nativeRisu.card.character_book = { entries: [] };
  store.product.content({ ...nextInput, expectedRevision: revised.revision }, bot.id);
  expect(list()).toMatchObject({
    total: 1,
    nextOffset: null,
    items: [
      {
        originalMissing: true,
        selector,
        overrideId: changed.entry.id,
        conflicts: ['entry-missing'],
      },
    ],
  });
  const missing = readHelperChatLore(store, chat.id, { selector });
  expect(missing).toMatchObject({ original: null, override: { id: changed.entry.id } });
  service.remove(
    chat.id,
    {
      selector,
      expectedRevision: missing.revision,
      expectedHeadRevision: missing.headRevision,
      operationId: randomUUID(),
    },
    'remove-discovered-override'
  );
  expect(list()).toMatchObject({ total: 0, items: [], nextOffset: null });
});
