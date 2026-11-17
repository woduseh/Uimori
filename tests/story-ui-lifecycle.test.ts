import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { buildMainInput } from '../core/provider.js';
import { parseStoryUi, projectStoryUiText } from '../core/story-ui.js';
import type { Run } from '../core/types.js';
import { createApp, type App } from '../server/app.js';
import { forkChat } from '../server/chat-fork.js';
import { exportChatTranscript, importChatTranscript } from '../server/chat-transcript.js';
import { requestInput } from '../server/main-host-context.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { directory: string; app: App }[] = [];
afterEach(async () => {
  for (const { directory, app } of owned.splice(0)) {
    await app.close();
    const within = relative(resolve(tmpdir()), resolve(directory));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-story-ui-life-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real run commit freezes UI and preserves it through copy, export/import and next context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-story-ui-life-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'story-ui-lifecycle',
    testMode: true,
    codex: { enabled: false },
  });
  owned.push({ directory, app });
  const { store } = app;
  const created = createFixtureChat(store, 'A live interface');
  const chat = store.settings(created.id, created.settingsRevision, {
    ...created.settings,
    storyUi: true,
  });
  // The deterministic fixture echoes the request inside its response, crossing the real executor.
  const expression =
    '<a2ui>root = Column([Text("A preserved notice"), Button(Text("Reply"), action=Event("reply", {topic: "harbor"}))])</a2ui>';
  const admitted = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: expression,
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(admitted.statusCode, admitted.body).toBe(200);
  const runId = admitted.json<Run>().id;
  await vi.waitFor(() => expect(store.run(runId).status).toBe('completed'), { timeout: 15000 });
  const source = store.source(store.chat(chat.id).headRevision!);
  const block = parseStoryUi(source.text).find((part) => part.kind === 'ui');
  expect(block?.kind).toBe('ui');
  if (block?.kind !== 'ui') throw new Error('Missing committed UI');
  expect(block.expression).toBe(expression);
  expect(projectStoryUiText(source.text)).toContain('A preserved notice');
  expect(projectStoryUiText(source.text)).not.toContain('createSurface');

  const transcript = exportChatTranscript(store, chat.id);
  const restored = importChatTranscript(store, { idempotencyKey: randomUUID(), transcript }).chat;
  expect(store.source(restored.headRevision!).text).toBe(source.text);
  const copied = forkChat(store, chat.id, {
    fromRevision: source.id,
    idempotencyKey: randomUUID(),
  });
  expect(store.source(copied.headRevision!).text).toBe(source.text);
  expect(copied.settings.storyUi).toBe(true);

  app.controls.hold('run');
  const action = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/story-ui/actions`,
    payload: {
      sourceRevision: source.id,
      sourceHash: source.hash,
      blockId: block.id,
      eventName: 'reply',
      context: { topic: 'harbor' },
      mode: 'short',
      idempotencyKey: randomUUID(),
    },
  });
  expect(action.statusCode, action.body).toBe(200);
  const run = action.json<Run>();
  const input = buildMainInput(run.snapshot);
  const host = requestInput(run.snapshot, input);
  const hostSource = host.source as {
    storyUi: { catalogId: string; referenceLayout: string; submittedAction: unknown };
  };
  expect(hostSource.storyUi.referenceLayout).toBe(expression);
  expect(hostSource.storyUi.catalogId).toBe('urn:uimori:story-ui:1');
  expect(hostSource.storyUi.submittedAction).toEqual({
    name: 'reply',
    context: { topic: 'harbor' },
  });
  expect(run.request).toBe('Reply\ntopic: harbor');
  expect(input.history.at(-1)?.text).not.toContain('createSurface');
  expect(run.snapshot.history.at(-1)?.text).toBe(source.text);
  app.controls.release('run');
});
