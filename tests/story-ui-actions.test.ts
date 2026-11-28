import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { parseStoryUi } from '../core/story-ui.js';
import type { Run } from '../core/types.js';
import { type App, createApp } from '../server/app.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { normalizeStoryUiOutput } from '../server/story-ui.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { directory: string; app?: App }[] = [];
afterEach(async () => {
  for (const { app, directory } of owned.splice(0)) {
    await app?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function setup(expression: string, eventName: string, context: Record<string, unknown>) {
  const fixture: (typeof owned)[number] = {
    directory: mkdtempSync(join(tmpdir(), 'uimori-story-ui-actions-')),
  };
  owned.push(fixture);
  const app = await createApp({
    dbPath: join(fixture.directory, 'app.sqlite'),
    buildId: 'story-ui-action-test',
    testMode: true,
    codex: { enabled: false },
  });
  fixture.app = app;
  const { store } = app;
  const bot = store.product.content(fixtureBotInput());
  const sourceText = normalizeStoryUiOutput(`A door opens.\n\n<a2ui>${expression}</a2ui>`);
  const block = parseStoryUi(sourceText).find((part) => part.kind === 'ui');
  if (!block) throw new Error('Fixture should contain a valid story UI block');
  const imported = importChatTranscript(
    store,
    {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: 'The sealed door',
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: [{ request: 'Enter the hall', text: sourceText, translation: null }],
      },
    },
    'library'
  ).chat;
  const chat = store.settings(imported.id, imported.settingsRevision, {
    ...imported.settings,
    storyUi: true,
  });
  const source = store.source(chat.headRevision!);
  const body = {
    sourceRevision: source.id,
    sourceHash: source.hash,
    blockId: block.id,
    surfaceId: 'main',
    eventName,
    context,
    mode: 'short',
    idempotencyKey: String(randomUUID()),
  };
  const submit = (
    changes: Partial<typeof body> & { componentId?: string } = {},
    chatId = chat.id
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/chats/${chatId}/story-ui/actions`,
      payload: { ...body, ...changes },
    });
  app.controls.hold('run');
  return { app, store, source, chat, body, submit };
}

const noteExpression =
  'root = Column([TextField("Note", $/note), Button(Text("Send"), action=Event("send", {note: $/note, station: "north"}))])';

test('an action uses the current original source and accepts the declared event and context keys', async () => {
  const f = await setup(noteExpression, 'send', { note: 'Open slowly', station: 'north' });
  const otherChat = f.store.createChat('A different chat', { botId: f.chat.botId });
  const foreign = await f.submit({}, otherChat.id);
  expect(foreign.statusCode).toBe(409);
  expect(foreign.json()).toEqual({ error: 'STORY_UI_STALE_SOURCE' });
  const disabled = f.store.settings(f.chat.id, f.chat.settingsRevision, {
    ...f.chat.settings,
    storyUi: false,
  });
  expect((await f.submit()).json()).toEqual({ error: 'STORY_UI_DISABLED' });
  f.store.settings(f.chat.id, disabled.settingsRevision, f.chat.settings);

  for (const changes of [
    { blockId: 'story-ui-0' },
    { componentId: 'unknown-button' },
    { eventName: 'next' },
    { context: { note: 'Open slowly' } },
    { context: { note: 'Open slowly', station: 'north', extra: true } },
  ]) {
    const response = await f.submit(changes);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'STORY_UI_INVALID_ACTION' });
  }
  const edited = f.store.editSource(f.source.id, {
    expectedRevision: 0,
    text: f.source.text.replace('A door opens.', 'A bell sounds.'),
  });
  const stale = await f.submit();
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toEqual({ error: 'STORY_UI_STALE_SOURCE' });
  const blockId = parseStoryUi(edited.text).find((part) => part.kind === 'ui')!.id;
  const accepted = await f.submit({ sourceHash: edited.hash, blockId, mode: 'continue' });
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(accepted.json<Run>().snapshot.storyUiAction).toMatchObject({
    sourceRevision: edited.id,
    sourceHash: edited.hash,
    name: 'send',
    context: { note: 'Open slowly', station: 'north' },
    mode: 'continue',
  });
  const busy = await f.submit({ sourceHash: edited.hash, blockId, idempotencyKey: randomUUID() });
  expect(busy.statusCode).toBe(409);
  expect(busy.json()).toEqual({ error: 'A run already owns this head' });
});

test('a concurrent dice submission reserves one server roll and replays it after completion', async () => {
  const f = await setup(
    'root = Button(Text("Roll"), action=Event("roll", {sides: 6, count: 5}))',
    'roll',
    { sides: 6, count: 5 }
  );
  const tampered = await f.submit({ context: { sides: 1000, count: 5 } });
  expect(tampered.statusCode).toBe(400);
  const click = { componentId: 'root' };
  const [admitted, duplicate] = await Promise.all([f.submit(click), f.submit(click)]);
  expect(admitted.statusCode, admitted.body).toBe(200);
  expect(duplicate.statusCode, duplicate.body).toBe(200);
  const run = admitted.json<Run>();
  expect(duplicate.json<Run>().id).toBe(run.id);
  const roll = run.snapshot.storyUiAction?.roll;
  expect(roll).toEqual({ sides: 6, results: Array(5).fill(expect.any(Number)) });
  expect(roll?.results.every((value) => Number.isInteger(value) && value >= 1 && value <= 6)).toBe(
    true
  );

  f.app.controls.release('run');
  await vi.waitFor(() => expect(f.store.run(run.id).status).toBe('completed'), { timeout: 15000 });
  const head = f.store.chat(f.chat.id);
  expect(head.headRevision).not.toBe(f.source.id);
  const copied = await f.app.inject({
    method: 'POST',
    url: `/api/runs/${run.id}/retry`,
    payload: { idempotencyKey: 'copied', mode: 'copy' },
  });
  expect(copied.statusCode, copied.body).toBe(200);
  const copy = copied.json<Run>();
  expect(copy.chatId).not.toBe(run.chatId);
  expect(copy.parentRevision).not.toBe(run.parentRevision);
  expect(copy.snapshot.storyUiAction).toMatchObject({
    sourceRevision: copy.parentRevision,
    sourceHash: f.source.hash,
    roll,
  });
  await vi.waitFor(() => expect(f.store.run(copy.id).status).toBe('completed'), { timeout: 15000 });

  f.store.settings(head.id, head.settingsRevision, { ...head.settings, storyUi: false });
  const replay = await f.submit({ ...click, context: { count: 5, sides: 6 } });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json<Run>()).toMatchObject({
    id: run.id,
    status: 'completed',
    snapshot: { storyUiAction: { roll } },
  });
  const changedCommand = await f.submit({ ...click, mode: 'continue' });
  expect(changedCommand.statusCode).toBe(409);
  expect(changedCommand.json()).toEqual({ error: 'Idempotency key reused with different command' });
  const historical = await f.submit({ idempotencyKey: randomUUID() });
  expect(historical.statusCode).toBe(409);
  expect(historical.json()).toEqual({ error: 'STORY_UI_STALE_SOURCE' });
});

test('editing the originating scene during execution invalidates completion and unedited retry', async () => {
  const f = await setup(noteExpression, 'send', { note: 'Open slowly', station: 'north' });
  const admitted = await f.submit();
  expect(admitted.statusCode, admitted.body).toBe(200);
  const run = admitted.json<Run>();
  await vi.waitFor(() => expect(f.app.controls.snapshot().waiting.run).toBe(1), { timeout: 15000 });
  const edited = f.store.editSource(f.source.id, {
    expectedRevision: 0,
    text: 'The door was never there.',
  });
  expect(() =>
    f.store.completeRun(run.id, 'The door opens.', {
      modelCalls: 1,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    })
  ).toThrow('STORY_UI_STALE_SOURCE');
  f.app.controls.release('run');
  await vi.waitFor(() => expect(f.store.run(run.id).status).toBe('failed'), { timeout: 15000 });
  expect(f.store.chat(f.chat.id).headRevision).toBe(edited.id);
  expect(f.store.source(edited.id).hash).toBe(edited.hash);
  const retry = await f.app.inject({
    method: 'POST',
    url: `/api/runs/${run.id}/retry`,
    payload: { idempotencyKey: 'stale' },
  });
  expect(retry.statusCode).toBe(409);
  expect(retry.json()).toEqual({ error: 'STORY_UI_STALE_SOURCE' });
});

test('an unedited retry keeps the dice result, while a free-text retry has no action receipt', async () => {
  const f = await setup('root = Button(Text("Roll"), action=Event("roll", {sides: 20}))', 'roll', {
    sides: 20,
  });
  const admitted = await f.submit();
  expect(admitted.statusCode, admitted.body).toBe(200);
  const original = admitted.json<Run>();
  f.app.controls.armFailure('source-transaction', original.chatId);
  f.app.controls.release('run');
  await vi.waitFor(() => expect(f.store.run(original.id).status).toBe('failed'), {
    timeout: 15000,
  });
  expect(original.snapshot.storyUiAction?.roll?.results).toHaveLength(1);

  f.app.controls.hold('run');
  const retry = (payload: { idempotencyKey: string; request?: string }) =>
    f.app.inject({ method: 'POST', url: `/api/runs/${original.id}/retry`, payload });
  const retried = await retry({ idempotencyKey: 'unchanged' });
  expect(retried.statusCode, retried.body).toBe(200);
  const run = retried.json<Run>();
  expect(run.snapshot.storyUiAction).toEqual(original.snapshot.storyUiAction);
  const unrelatedKey = await f.submit({ idempotencyKey: 'unchanged' });
  expect(unrelatedKey.statusCode).toBe(409);
  expect(unrelatedKey.json()).toEqual({ error: 'Idempotency key reused with different command' });
  const cancelled = await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
  expect(cancelled.statusCode, cancelled.body).toBe(200);
  const edited = await retry({ idempotencyKey: 'edited', request: 'Leave the room.' });
  expect(edited.statusCode, edited.body).toBe(200);
  expect(edited.json<Run>()).toMatchObject({ request: 'Leave the room.' });
  expect(edited.json<Run>().snapshot.storyUiAction).toBeUndefined();
});
