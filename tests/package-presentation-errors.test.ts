import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { fixtureBotInput } from './fixtures/chat.js';

const failure = vi.hoisted(() => ({ error: new Error('unset') as Error }));
vi.mock('../server/package-presentation.js', async (original) => ({
  ...(await original<typeof import('../server/package-presentation.js')>()),
  buildPackagePresentation: async () => {
    throw failure.error;
  },
}));
vi.mock('../server/risu-native-actions.js', async (original) => ({
  ...(await original<typeof import('../server/risu-native-actions.js')>()),
  applyNativeRisuAction: async () => {
    throw failure.error;
  },
}));

const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    rmSync(path, { recursive: true, force: true });
  }
});

async function presentation(error: Error, action = false) {
  failure.error = error;
  const path = mkdtempSync(join(tmpdir(), 'uimori-presentation-errors-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'presentation-errors-test',
    testMode: true,
  });
  owned.push({ app, path });
  const bot = app.store.product.content(fixtureBotInput());
  const chat = importChatTranscript(
    app.store,
    {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: 'Presentation errors',
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: [{ request: 'First scene', text: '미라는 문턱에서 멈췄다.', translation: null }],
      },
    },
    'library'
  ).chat;
  const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const response = await app.inject(
    action
      ? {
          method: 'POST',
          url: `/api/chats/${chat.id}/sources/${chat.headRevision}/risu-action`,
          payload: {},
        }
      : { method: 'GET', url: `/api/chats/${chat.id}/sources/${chat.headRevision}/presentation` }
  );
  const lines = log.mock.calls.map(([line]) => String(line));
  log.mockRestore();
  return { response, lines };
}

test('a Risu stage failure reaches the reader as its code and is logged', async () => {
  const { response, lines } = await presentation(new Error('RISU_NATIVE_TIMEOUT'));
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ code: 'RISU_NATIVE_TIMEOUT' });
  expect(lines).toContain(
    'REQUEST_FAILED GET /api/chats/:id/sources/:sourceId/presentation RISU_NATIVE_TIMEOUT\n'
  );
});

const luaSessionFailure = (code: string) =>
  Object.assign(new Error(code), { code, statusCode: 400 });

test('a Risu worker failure while displaying a scene answers a logged 500', async () => {
  const { response, lines } = await presentation(luaSessionFailure('RISU_NATIVE_WORKER_EXIT'));
  expect(response.statusCode).toBe(500);
  expect(lines).toContain(
    'REQUEST_FAILED GET /api/chats/:id/sources/:sourceId/presentation RISU_NATIVE_WORKER_EXIT\n'
  );
});

test('a Risu script timeout in a user action stays a definite refusal with the timeout code', async () => {
  const { response } = await presentation(luaSessionFailure('RISU_LUA_PROGRAM_TIMEOUT'), true);
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ code: 'RISU_NATIVE_TIMEOUT' });
});
