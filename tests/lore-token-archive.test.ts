import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LORE_CONTEXT, type LoreContextPolicy } from '../core/lore-context.js';
import { countTextTokens } from '../core/text-tokens.js';
import { executeTool } from '../core/provider.js';
import { Store } from '../server/store.js';
import { freezeLoreContext } from '../server/lore-context.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { forkChat } from '../server/chat-fork.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';

const owned: { dir: string; store: Store }[] = [];
const text = 'The harbor is open. 항구에 도착했다. 港は静かだった。';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('External calls forbidden')));
});
afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    for (const { dir, store } of owned.splice(0)) {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-token-lore-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ dir, store });
  return store;
}

function setPolicy(store: Store, chatId: string, policy: LoreContextPolicy) {
  const { chatId: _chatId, revision, ...body } = store.product.profile(chatId);
  updateTestProfile(store.product, chatId, {
    ...body,
    expectedRevision: revision,
    loreContext: structuredClone(policy),
  });
}

async function complete(store: Store, chatId: string, readId?: string) {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId),
    request = `Synthetic turn ${randomUUID()}`;
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request,
      history: store.history(current.headRevision),
      resources: store.product.resources(chatId, profile),
      ...(profile ? { profile } : {}),
    })
  ).run;
  const snapshot = compileSnapshotPrompt(
    freezeLoreContext(store, await prepareNativeRisuRun(run.snapshot))
  );
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), run.id);
  store.startRun(run.id);
  if (readId)
    store.tool(
      run.id,
      executeTool(snapshot, {
        callId: 'read-lore',
        name: 'knowledge.read',
        args: { id: readId, offset: 0, limit: 4096 },
      })
    );
  store.completeRun(
    run.id,
    'A complete synthetic scene.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    snapshot.settings
  );
  return store.run(run.id);
}

async function fixture() {
  const store = database();
  const input = fixtureBotInput('Token budget fixture');
  input.package.nativeRisu.card.character_book = { entries: [{ name: 'Harbor', content: text }] };
  input.package.loreActivation = { mode: 'discoverable' };
  const bot = store.product.content(input);
  const chat = createFixtureChat(store, 'Local tokens', 'calm', { botId: bot.id });
  setPolicy(store, chat.id, DEFAULT_LORE_CONTEXT);
  const resource = store.product
    .resources(chat.id, store.product.snapshot(chat.id))
    .find((item) => item.id.endsWith(':lore-0'))!;
  const first = await complete(store, chat.id, resource.id);
  const token = await complete(store, chat.id);
  return { store, chat, first, token };
}

describe('token lore persistence with real SQLite and local tokenizer', () => {
  it('preserves token history through export, restore and a subsequent turn', async () => {
    const f = await fixture();
    const context = f.token.snapshot.loreContext!;
    const tokens = context.entries.reduce((sum, entry) => sum + countTextTokens(entry.text), 0);
    expect(context.entries.length).toBeGreaterThan(0);
    expect(context.stats.retainedTokens).toBe(tokens);
    const restored = database();
    expect(restored.product.import(f.store.product.export()).restored).toBe(true);
    expect(restored.run(f.token.id).snapshot.loreContext).toEqual(context);
    const next = await complete(restored, f.chat.id);
    expect(next.snapshot.loreContext!.stats.retainedTokens).toBe(tokens);
    expect(next.snapshot.loreContext!.entries).toEqual(context.entries);
  });

  it('keeps token counts and UTF-16 ranges across fork and restore', async () => {
    const f = await fixture();
    const copy = forkChat(f.store, f.chat.id, {
      fromRevision: f.token.sourceRevision,
      idempotencyKey: 'token-fork',
    });
    const restored = database();
    expect(restored.product.import(f.store.product.export()).restored).toBe(true);
    const next = await complete(restored, copy.id);
    expect(next.snapshot.loreContext!.stats.retainedTokens).toBe(
      f.token.snapshot.loreContext!.stats.retainedTokens
    );
    const ranges = (run: typeof next) =>
      run.snapshot.loreContext!.entries.map(({ start, end, text }) => ({ start, end, text }));
    expect(ranges(next)).toEqual(ranges(f.token));
  });

  it('rejects forged token statistics and rolls back the import transaction', async () => {
    const f = await fixture();
    const archive = f.store.product.export();
    const row = archive.tables.runs.find((item) => item.id === f.token.id)!;
    const snapshot = JSON.parse(row.snapshot);
    snapshot.loreContext.stats.retainedTokens++;
    row.snapshot = JSON.stringify(snapshot);
    const restored = database(),
      before = restored.product.export().tables;
    expect(() => restored.product.import(archive)).toThrow();
    expect(restored.product.export().tables).toEqual(before);
  });
});
