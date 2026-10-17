import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { RunSnapshot } from '../core/types.js';
import { executeStoryRead } from '../core/story-context.js';
import { buildMainInput } from '../core/provider.js';
import { contextDependencyKey } from '../server/context-dependency.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { updateSceneContext } from '../server/scene-context.js';
import { captureLogicalHistory } from '../server/prompt-snapshot.js';
import { exportChatTranscript, importChatTranscript } from '../server/chat-transcript.js';
import { readerDetail } from '../server/reader.js';
import { forkChat } from '../server/chat-fork.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(async () => {
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-scene-context-'));
  const store = new Store(join(directory, 'test.sqlite'));
  owned.push({ store, directory });
  return store;
}
function turn(store: Store, chatId: string, request: string, text: string) {
  const chat = store.chat(chatId);
  const { run } = store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current): RunSnapshot => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request,
      history: store.history(current.headRevision),
      resources: [],
    })
  );
  store.startRun(run.id);
  return store.completeRun(run.id, text, {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
}
function current(store: Store, chatId: string): RunSnapshot {
  const chat = store.chat(chatId);
  return {
    chatId,
    parentRevision: chat.headRevision,
    request: 'continue',
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    history: store.history(chat.headRevision),
    resources: [],
  };
}

describe('authored scene context without replaying prior runs', () => {
  test('revises input, excludes an individual input and entire scene, then restores it', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Context controls');
    const first = turn(store, chat.id, 'Meet in the cafe', 'The cafe encounter.');
    const second = turn(store, chat.id, 'Return home', 'They went home.');

    const before = current(store, chat.id);
    const key = contextDependencyKey(before);
    expect(captureLogicalHistory(store, before).map((m) => m.text)).toEqual([
      'Meet in the cafe',
      'The cafe encounter.',
      'Return home',
      'They went home.',
    ]);
    const updated = updateSceneContext(store, first.id, {
      expectedRevision: 0,
      requestText: 'Meet by the bridge',
    });
    expect(updated).toMatchObject({ revision: 1, requestText: 'Meet by the bridge' });
    expect(store.run(first.runId).request).toBe('Meet in the cafe');
    const revised = current(store, chat.id);
    expect(contextDependencyKey(revised)).not.toBe(key);
    expect(captureLogicalHistory(store, revised)[0].text).toBe('Meet by the bridge');
    expect(readerDetail(store, chat.id, {}).sources[0].sceneContext).toMatchObject(updated);

    updateSceneContext(store, first.id, { expectedRevision: 1, requestEnabled: false });
    const withoutInput = current(store, chat.id);
    expect(captureLogicalHistory(store, withoutInput).map((m) => m.text)).toEqual([
      'The cafe encounter.',
      'Return home',
      'They went home.',
    ]);
    updateSceneContext(store, first.id, { expectedRevision: 2, sceneEnabled: false });
    const withoutScene = current(store, chat.id);
    expect(captureLogicalHistory(store, withoutScene).map((m) => m.text)).toEqual([
      'Return home',
      'They went home.',
    ]);
    expect(buildMainInput(withoutScene).history.map((h) => h.revision)).toEqual([second.id]);
    expect(
      executeStoryRead(withoutScene, {
        callId: '1',
        name: 'story.read',
        args: { sceneNumber: 1 },
      })
    ).toMatchObject({ denied: true, result: { code: 'RESOURCE_UNAVAILABLE' } });
    expect(
      executeStoryRead(withoutScene, {
        callId: '2',
        name: 'story.search',
        args: { query: 'cafe' },
      })
    ).toMatchObject({ denied: false, result: { total: 0 } });
    expect(
      executeStoryRead(withoutScene, {
        callId: '3',
        name: 'story.search',
        args: { query: 'home' },
      })
    ).toMatchObject({ denied: false, result: { results: [{ sceneNumber: 2 }] } });
    updateSceneContext(store, first.id, {
      expectedRevision: 3,
      requestEnabled: true,
      sceneEnabled: true,
    });
    expect(captureLogicalHistory(store, current(store, chat.id))[0].text).toBe(
      'Meet by the bridge'
    );
  });

  test('a native Risu scene edits a combined user request, not only request:source IDs', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Native Risu context');
    const data = [
      { role: 'user' as const, data: 'Pick a destination' },
      { role: 'user' as const, data: 'Follow the river' },
      { role: 'char' as const, data: 'At the river bank' },
    ];
    const before = store.chat(chat.id);
    const request = 'Pick a destination\n\nFollow the river';
    const { run } = store.createRun(
      chat.id,
      {
        request,
        expectedRevision: before.headRevision,
        expectedSettingsRevision: before.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (state): RunSnapshot => ({
        chatId: chat.id,
        parentRevision: state.headRevision,
        settingsRevision: state.settingsRevision,
        settings: state.settings,
        request,
        history: [],
        resources: [],
        nativeRisuAuthored: { version: 1, action: 'choose', messages: data },
      })
    );
    store.startRun(run.id);
    const source = store.completeRun(run.id, 'At the river bank', {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect(captureLogicalHistory(store, current(store, chat.id)).map((m) => m.text)).toEqual([
      'Pick a destination',
      'Follow the river',
      'At the river bank',
    ]);
    updateSceneContext(store, source.id, {
      expectedRevision: 0,
      requestText: 'Go to the mountain instead',
    });
    expect(captureLogicalHistory(store, current(store, chat.id)).map((m) => m.text)).toEqual([
      'Go to the mountain instead',
      'At the river bank',
    ]);
    updateSceneContext(store, source.id, {
      expectedRevision: 1,
      requestEnabled: false,
    });
    expect(captureLogicalHistory(store, current(store, chat.id)).map((m) => m.text)).toEqual([
      'At the river bank',
    ]);
    expect(store.run(run.id).request).toBe(request);
  });

  test('rejects stale revisions and changes during an active main run', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Concurrent edits');
    const first = turn(store, chat.id, 'Original request', 'Original scene');
    expect(() =>
      updateSceneContext(store, first.id, { expectedRevision: 3, sceneEnabled: false })
    ).toThrow('revision conflict');
    const state = store.chat(chat.id);
    store.createRun(
      chat.id,
      {
        request: 'Pending',
        expectedRevision: state.headRevision,
        expectedSettingsRevision: state.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (current): RunSnapshot => ({
        chatId: chat.id,
        request: 'Pending',
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        history: store.history(current.headRevision),
        resources: [],
      })
    );
    expect(() =>
      updateSceneContext(store, first.id, { expectedRevision: 0, sceneEnabled: false })
    ).toThrow('장면 생성 중');
  });

  test('preserves effective controls in portable transcripts and chat forks', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Portable context');
    const first = turn(store, chat.id, 'A', 'Scene A');
    turn(store, chat.id, 'B', 'Scene B');
    updateSceneContext(store, first.id, {
      expectedRevision: 0,
      requestText: 'Edited A',
      requestEnabled: false,
      sceneEnabled: false,
    });
    const transcript = exportChatTranscript(store, chat.id);
    expect(transcript.entries[0].sceneContext).toMatchObject({
      requestText: 'Edited A',
      requestEnabled: false,
      sceneEnabled: false,
    });
    const restored = importChatTranscript(store, {
      transcript,
      idempotencyKey: randomUUID(),
    }).chat;
    expect(current(store, restored.id).history[0].sceneContext).toMatchObject({
      requestText: 'Edited A',
      requestEnabled: false,
      sceneEnabled: false,
    });
    const fork = forkChat(store, chat.id, {
      fromRevision: store.chat(chat.id).headRevision,
      idempotencyKey: randomUUID(),
    });
    expect(current(store, fork.id).history[0].sceneContext?.sceneEnabled).toBe(false);
    expect(captureLogicalHistory(store, current(store, fork.id)).map((m) => m.text)).toEqual([
      'B',
      'Scene B',
    ]);
  });
});
