import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Content } from '../core/product.js';
import type { PromptTemplate } from '../core/prompt-program.js';
import { executionContext } from '../core/execution-context.js';
import { compiledPackages } from '../core/package-context.js';
import { Store } from '../server/store.js';
import { chatVariableRoutes } from '../server/chat-variable-routes.js';
import { readChatVariables } from '../server/chat-variables.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { freezeReservationSnapshot } from '../server/reservation-snapshot.js';
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
  const template: PromptTemplate = [
    { kind: 'value', expression: { op: 'get', args: [{ context: ['variables'] }, 'mood'] } },
  ];
  const input = fixtureBotInput('Synthetic shared state', 'Preserved original body');
  input.package.variableDefaults = { values: { mood: 'calm' } };
  input.package.bodyTemplate = template;
  input.package.instructions = [
    { id: 'mood', target: 'main', text: 'Preserved original instruction', template },
  ];
  input.package.panels = [{ id: 'mood', title: 'Current mood', template }];
  const bot = store.product.content(input) as Content;
  const chat = createFixtureChat(store, 'Synthetic variable flow', 'calm', { botId: bot.id });
  const branch = store.product.branch(chat.id);
  const url = `/api/chats/${chat.id}/variables`;
  const reserve = () =>
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
    ).run;
  return { store, app, chat, branch, bot, url, reserve };
}
const noUsage = { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null };

test('HTTP edits feed live panels and frozen instructions; pending writes, historical forks and candidates retain ownership', async () => {
  const f = fixture();
  const initial = (await f.app.inject(f.url)).json();
  expect(initial).toMatchObject({
    revision: 0,
    values: {},
    defaults: { mood: 'calm' },
    resolved: { mood: 'calm' },
    pending: false,
  });
  expect(f.store.db.prepare('SELECT * FROM chat_variable_states').all()).toEqual([]);
  const command = {
    expectedRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: randomUUID(),
    values: { mood: 'bright', empty: '' },
  };
  const saved = await f.app.inject({ method: 'PUT', url: f.url, payload: command });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ revision: 1, resolved: { mood: 'bright', empty: '' } });
  expect(JSON.stringify(behaviorDetail(f.store, f.chat.id))).toContain('bright');
  const run = f.reserve();
  expect(run.snapshot.profile?.variableState).toEqual({ revision: 1, values: command.values });
  expect(compiledPackages(run.snapshot, 'main')[0].instructions[0].text).toBe('bright');
  expect(run.snapshot.resources.some((r) => r.text === 'bright')).toBe(true);
  const rejected = await f.app.inject({
    method: 'PUT',
    url: f.url,
    payload: {
      ...command,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      values: { mood: 'late' },
    },
  });
  expect(rejected.statusCode).toBe(409);
  const replay = await f.app.inject({ method: 'PUT', url: f.url, payload: command });
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toMatchObject({ revision: 1, pending: true });
  f.store.startRun(run.id);
  const source = f.store.completeRun(run.id, 'Synthetic output', noUsage, run.snapshot.settings);
  const changed = await f.app.inject({
    method: 'PUT',
    url: f.url,
    payload: {
      ...command,
      expectedRevision: 1,
      expectedSourceHash: source.hash,
      idempotencyKey: randomUUID(),
      values: { mood: 'newer' },
    },
  });
  expect(changed.statusCode).toBe(200);
  const historical = f.store.product.createBranch(f.chat.id, {
    title: 'Historical',
    fromRevision: source.id,
  });
  expect(readChatVariables(f.store, f.chat.id, historical.id).values).toEqual(command.values);
  const candidate = f.store.candidate(run.id, randomUUID(), 'Same original inputs').run;
  expect(readChatVariables(f.store, f.chat.id, candidate.snapshot.branchId!)).toEqual(
    run.snapshot.profile!.variableState
  );
  expect(candidate.snapshot.profile?.variableState).toEqual(run.snapshot.profile?.variableState);
  expect(readChatVariables(f.store, f.chat.id, f.branch.id).values).toEqual({ mood: 'newer' });
  expect(
    executionContext(freezeReservationSnapshot(f.store, run.snapshot, { purpose: 'resume-state' }))
      .variables
  ).toEqual(command.values);
  expect(f.store.product.get<Content>('content', f.bot.id, f.bot.revision).package?.body).toBe(
    'Preserved original body'
  );
});

test('historical snapshots omit overrides and their candidates do not borrow later values', async () => {
  const f = fixture();
  const old = f.reserve();
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
  expect(readChatVariables(f.store, f.chat.id, candidate.snapshot.branchId!)).toEqual({
    revision: 0,
    values: {},
  });
});
