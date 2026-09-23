import { prepareNativeFixtureRun } from './fixtures/native-run.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Content } from '../core/product.js';
import { Store } from '../server/store.js';
import { chatVariableRoutes } from '../server/chat-variable-routes.js';
import { readChatVariables } from '../server/chat-variables.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';

const owned: { store: Store; app: FastifyInstance; directory: string }[] = [];
afterEach(async () => {
  for (const { store, app, directory } of owned.splice(0)) {
    await app.close();
    store.close();
    const inside = relative(tmpdir(), directory);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-variable-flow-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-variable-flow-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const app = Fastify();
  chatVariableRoutes(app, store, () => {});
  owned.push({ store, app, directory });
  const input = fixtureBotInput('Synthetic shared state', 'Preserved original body');
  input.package.nativeRisu.card.extensions = { risuai: { defaultVariables: 'mood=calm' } };
  const bot = store.product.content(input) as Content;
  const chat = createFixtureChat(store, 'Synthetic variable flow', { botId: bot.id });
  const branch = store.product.branch(chat.id);
  const url = `/api/chats/${chat.id}/variables`;
  const reserve = async () =>
    prepareNativeFixtureRun(
      store,
      store.createRun(
        chat.id,
        {
          request: 'Synthetic request',
          expectedRevision: store.product.branch(chat.id).headRevision,
          expectedSettingsRevision: store.chat(chat.id).settingsRevision,
          idempotencyKey: randomUUID(),
        },
        (current) => {
          const profile = store.product.snapshot(chat.id);
          return {
            chatId: chat.id,
            parentRevision: current.headRevision,
            settingsRevision: current.settingsRevision,
            settings: current.settings,
            request: 'Synthetic request',
            history: store.history(current.headRevision),
            resources: store.product.resources(chat.id, profile),
            profile,
          };
        }
      ).run
    );
  return { store, app, chat, branch, bot, url, reserve };
}
const noUsage = { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null };

test('independent rewrites start from the copied checkpoint rather than later variables', async () => {
  const f = fixture();
  const old = await f.reserve();
  expect(old.snapshot.profile).not.toHaveProperty('variableState');
  f.store.startRun(old.id);
  const source = f.store.completeRun(old.id, 'Historical source', noUsage, old.snapshot.settings);
  await f.app.inject({
    method: 'PUT',
    url: f.url,
    payload: {
      expectedRevision: 0,
      expectedSourceHash: source.hash,
      idempotencyKey: randomUUID(),
      values: { mood: 'later' },
    },
  });
  const candidate = f.store.candidate(old.id, randomUUID(), 'Historical inputs').run;
  expect(candidate.snapshot.profile).not.toHaveProperty('variableState');
  expect(readChatVariables(f.store, candidate.chatId, candidate.snapshot.branchId!)).toEqual({
    revision: 0,
    values: {},
  });
});
