import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { ChatOverridesStore } from '../server/chat-overrides.js';
import { chatOverrideHash } from '../core/chat-overrides.js';
import { OutlineStore } from '../server/outline-store.js';
import { forkChat } from '../server/chat-fork.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import type { Content } from '../core/product.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    rmSync(item.path, { recursive: true, force: true });
  }
});
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-author-copy-'));
  const store = new Store(join(path, 'app.sqlite'));
  owned.push({ path, store });
  return store;
}

test('independent chat copies and portable restores keep authored plans and scoped lore, not task receipts', async () => {
  const store = database();
  const input = fixtureBotInput('Authoring bot', 'A friendly character');
  input.package.nativeRisu.card.character_book = {
    entries: [{ comment: 'Location', content: 'An old harbor', constant: true, enabled: true }],
  };
  const bot = store.product.content(input) as Content;
  const chat = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Original',
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: [{ request: 'Begin', text: 'The story begins.', translation: null }],
    },
  }).chat;
  const branch = store.product.branch(chat.id);
  const outline = new OutlineStore(store);
  outline.apply(
    chat.id,
    {
      branchId: branch.id,
      idempotencyKey: randomUUID(),
      operations: [
        { op: 'create', level: 'theme', title: 'Reconciliation', intent: 'Reunite the siblings' },
      ],
    },
    'user'
  );
  const createdPlan = outline.detail(chat.id).nodes[0];
  outline.apply(
    chat.id,
    {
      branchId: branch.id,
      idempotencyKey: randomUUID(),
      operations: [
        { op: 'update', id: createdPlan.id, expectedRevision: createdPlan.revision, fixed: true },
      ],
    },
    'user'
  );
  const service = new ChatOverridesStore(store),
    state = service.get(chat.id, branch.id);
  const attachment = state.attachments[0],
    lore = attachment.lore[0];
  service.patch(
    chat.id,
    {
      selector: { ...attachment.scope, loreId: lore.id, field: 'text' },
      value: 'A quiet mountain town',
      branchId: branch.id,
      expectedRevision: state.revision,
      expectedHeadRevision: state.headRevision,
      expectedProfileRevision: state.profileRevision,
      expectedPackageRevision: attachment.packageRevision,
      expectedFieldHash: chatOverrideHash(lore.text),
      operationId: randomUUID(),
    },
    randomUUID()
  );
  const copy = forkChat(store, chat.id, {
    fromRevision: chat.headRevision,
    idempotencyKey: randomUUID(),
  });
  const verify = (target: Store, id: string) => {
    const nodes = new OutlineStore(target).detail(id).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      title: 'Reconciliation',
      intent: 'Reunite the siblings',
      fixed: true,
      progress: { state: 'planned', commandId: null },
    });
    const overrides = new ChatOverridesStore(target).get(id);
    expect(overrides.conflicts).toEqual([]);
    expect(overrides.overrides[0]?.value).toBe('A quiet mountain town');
    expect(
      target.db
        .prepare('SELECT count(*) AS n FROM chat_override_operations WHERE chat_id=?')
        .get(id)!.n
    ).toBe(0);
  };
  verify(store, copy.id);
  const target = database();
  const restored = await importChatBackup(target, {
    backup: exportChatBackup(store, chat.id),
    idempotencyKey: randomUUID(),
  });
  verify(target, restored.chat.id);
  expect(target.product.profile(restored.chat.id).packageAttachments![0].id).not.toBe(bot.id);
  expect(new OutlineStore(target).detail(restored.chat.id).nodes[0].id).not.toBe(
    outline.detail(chat.id).nodes[0].id
  );
});
