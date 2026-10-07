import { afterEach, expect, test, vi } from 'vitest';
import * as projections from '../server/run-projections.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../server/store.js';
import { prepareRisuImport, applyRisuImport } from '../server/risu-import.js';
import { createPackageStart } from '../server/package-start.js';
import { applyNativeRisuAction, nativeSourceSnapshot } from '../server/risu-native-actions.js';
import { forkChat } from '../server/chat-fork.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { readChatVariables } from '../server/chat-variables.js';
import { packagePresentationRoutes } from '../server/package-presentation-routes.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { prepareNativeRisuRun, prepareNativeRisuOutput } from '../server/risu-native-run.js';
import { disposeAllNativeRisuSessions } from '../server/risu-native-runtime.js';

import {
  nativeInteractionRoutes,
  requestNativeInteraction,
} from '../server/risu-native-interactions.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  disposeAllNativeRisuSessions();
  for (const { path, store } of owned.splice(0)) {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
async function setup(extraOutput = false, historyEdit = '') {
  const path = mkdtempSync(join(tmpdir(), 'uimori-native-host-'));
  const store = new Store(join(path, 'test.sqlite'));
  owned.push({ path, store });
  const source = {
    name: 'native.json',
    base64: Buffer.from(
      JSON.stringify({
        spec: 'chara_card_v3',
        data: {
          name: 'Native',
          description: 'A story. Choice:{{getvar::chosen}}',
          first_mes: '<selector>',
          extensions: {
            risuai: {
              defaultVariables: 'chosen=none',
              customScripts: [
                {
                  type: 'editdisplay',
                  in: '<selector>',
                  out: '<button risu-trigger="choose">Choose {{getvar::chosen}}</button>',
                  flag: 'g',
                  ableFlag: true,
                },
              ],
              triggerscript: [
                {
                  type: 'start',
                  effect: [
                    {
                      type: 'triggerlua',
                      code: `
function choose(id) setChatVar(id, 'chosen', 'yes'); reloadDisplay(id) end
function start(id) addChat(id, 'char', 'Chosen opening'); reloadDisplay(id) end
function replace(id) setChat(id, 0, 'Changed opening'); reloadDisplay(id) end
listenEdit('editInput', function(id, text) return text .. ' INPUT' end)
listenEdit('editOutput', function(id, text) return text .. ' OUTPUT' end)
function onOutput(id)
  setChatVar(id, 'finished', 'yes')
  ${extraOutput ? "addChat(id, 'char', 'Script postscript'); addChat(id, 'user', 'Script user reply'); addChat(id, 'char', 'Script followup')" : ''}
  ${historyEdit}
end
${extraOutput ? "listenEdit('editDisplay', function(id, text, meta) return '[' .. tostring(meta.index) .. ']' .. text end)" : ''}
function ask(id)
  local name = alertInput(id, 'Name?'):await()
  setChatVar(id, 'name', name)
  local selected = alertSelect(id, {'A', 'B'}):await()
  setChatVar(id, 'selected', selected)
end
`,
                    },
                  ],
                },
              ],
            },
          },
        },
      })
    ).toString('base64'),
  };
  const preview = prepareRisuImport({ source });
  const saved = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'import',
  });
  const chatId = saved.chat!.id;
  const bot = store.product.profile(chatId).packageAttachments![0];
  if (!store.chat(chatId).headRevision)
    createPackageStart(store, chatId, {
      packageId: bot.id,
      packageRevision: bot.revision,
      startId: 'start-0',
      expectedSettingsRevision: store.chat(chatId).settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: 'opening',
    });
  return { store, chatId };
}
function actionBody(store: Store, chatId: string, name: string, key: string) {
  const head = store.source(store.chat(chatId).headRevision!);
  return {
    kind: 'trigger',
    name,
    expectedHeadRevision: head.id,
    expectedHeadHash: head.hash,
    expectedVariableRevision: readChatVariables(store, chatId).revision,
    idempotencyKey: key,
  };
}

async function appendNativeSource(store: Store, chatId: string, text: string) {
  const chat = store.chat(chatId);
  const { run } = store.createRun(
    chatId,
    {
      request: `Continue ${text}`,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: text,
    },
    () => ({
      chatId,
      parentRevision: chat.headRevision,
      request: `Continue ${text}`,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      history: store.history(chat.headRevision),
      profile: store.product.snapshot(chatId),
      resources: [],
    })
  );
  store.startRun(run.id);
  const output = await prepareNativeRisuOutput(
    compileSnapshotPrompt(await prepareNativeRisuRun(run.snapshot)),
    text
  );
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(output), run.id);
  return store.completeRun(
    run.id,
    output.nativeRisuExecution!.output!.text,
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    chat.settings
  );
}

test('later native output preserves Lua history edits until a newer user source edit replaces them', async () => {
  const { store, chatId } = await setup(
    false,
    "if getChatLength(id) > 2 then setChat(id, 0, 'Lua revised first request'); setChat(id, 1, 'Lua revised first source') end"
  );
  const first = await appendNativeSource(store, chatId, 'First');
  const second = await appendNativeSource(store, chatId, 'Second');
  const message = () =>
    nativeSourceSnapshot(store, chatId, second.id).snapshot.logicalHistory!.find(
      (entry) => entry.id === `source:${first.id}`
    );
  expect(message()).toMatchObject({ text: 'Lua revised first source', sourceHash: first.hash });
  expect(store.source(first.id).text).toBe('First OUTPUT');
  const edited = store.editSource(first.id, {
    expectedRevision: 0,
    text: 'User corrected first source',
  });
  expect(message()).toMatchObject({ text: edited.text, sourceHash: edited.hash });
  expect(
    nativeSourceSnapshot(store, chatId, second.id).snapshot.logicalHistory!.find(
      (entry) => entry.id === `request:${first.id}`
    )
  ).toMatchObject({ text: 'Lua revised first request' });
  expect(store.source(second.id)).toMatchObject({ ...second, editRevision: 0 });
});

test('a new Lua edit can revise source text after the user edit enters its input', async () => {
  const { store, chatId } = await setup(
    false,
    "if getChatLength(id) > 2 then setChat(id, 1, getChat(id, 1).data .. ' LUA') end"
  );
  const first = await appendNativeSource(store, chatId, 'First');
  const edited = store.editSource(first.id, { expectedRevision: 0, text: 'User corrected first' });
  const second = await appendNativeSource(store, chatId, 'Second');
  const saved = store.run(second.runId).snapshot;
  expect(
    saved.messageChanges!.updated.find((change) => change.message.id === `source:${first.id}`)
  ).toMatchObject({ message: { text: `${edited.text} LUA` }, expectedSourceHash: edited.hash });
  expect(saved.logicalHistory).toBeUndefined();
  expect(
    nativeSourceSnapshot(store, chatId, second.id).snapshot.logicalHistory!.find(
      (message) => message.id === `source:${first.id}`
    )
  ).toMatchObject({ text: `${edited.text} LUA`, sourceHash: edited.hash });
  expect(store.source(first.id).text).toBe(edited.text);
});

test('user edits to an authored native char survive older output receipts', async () => {
  const { store, chatId } = await setup(false, "setChat(id, 0, 'Lua revised authored source')");
  const head = store.source(store.chat(chatId).headRevision!);
  await applyNativeRisuAction(store, chatId, head.id, actionBody(store, chatId, 'start', 'start'));
  const authored = store.source(store.chat(chatId).headRevision!);
  const next = await appendNativeSource(store, chatId, 'Next');
  const edited = store.editSource(authored.id, {
    expectedRevision: 0,
    text: 'User corrected opening',
  });
  expect(
    nativeSourceSnapshot(store, chatId, next.id).snapshot.logicalHistory!.find(
      (message) => message.id === `native:${authored.id}:0`
    )
  ).toMatchObject({ text: edited.text, sourceHash: edited.hash });
});

test('native first-message button renders, checkpoints state, and survives source refresh', async () => {
  const { store, chatId } = await setup();
  const app = Fastify();
  packagePresentationRoutes(app, store);
  try {
    const first = store.chat(chatId).headRevision!;
    const snapshots = vi.spyOn(projections, 'readRunSnapshot');
    const before = await app.inject(`/api/chats/${chatId}/sources/${first}/presentation`);
    expect(
      snapshots.mock.calls.filter(([, runId]) => runId === store.source(first).runId)
    ).toHaveLength(1);
    snapshots.mockRestore();
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().format).toBe('risu-html');
    expect(before.json().original.html).toContain('Choose none');
    const body = actionBody(store, chatId, 'choose', 'choose-once');
    await applyNativeRisuAction(store, chatId, first, body);
    const head = store.chat(chatId).headRevision!;
    expect(head).not.toBe(first);
    const after = await app.inject(`/api/chats/${chatId}/sources/${head}/presentation`);
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().original.html).toContain('Choose yes');
    const replay = await applyNativeRisuAction(store, chatId, first, body);
    expect(replay.created).toBe(false);
    expect(store.chat(chatId).headRevision).toBe(head);
  } finally {
    await app.close();
  }
});

test('last response replacement runs native input and output from ancestor state without replaying the old response', async () => {
  const { store, chatId } = await setup();
  const opening = store.chat(chatId).headRevision!;
  const old = await appendNativeSource(store, chatId, 'Old story');
  const live = readChatVariables(store, chatId);
  expect(live.values.finished).toBe('yes');
  const retry = store.retryRun(old.runId, 'native-replace', undefined, undefined, 'replace').run;
  expect(retry.parentRevision).toBe(opening);
  expect(retry.snapshot.profile!.variableState!.revision).toBe(live.revision);
  expect(retry.snapshot.profile!.variableState!.values.finished).toBeUndefined();
  expect(store.chat(chatId).headRevision).toBe(old.id);
  store.startRun(retry.id);
  const prepared = await prepareNativeRisuRun(retry.snapshot);
  expect(prepared.nativeRisuExecution!.beforeVariableRevision).toBe(live.revision);
  expect(
    prepared.nativeRisuExecution!.messages.some(
      (message) => message.role === 'char' && message.data === old.text
    )
  ).toBe(false);
  const output = await prepareNativeRisuOutput(
    compileSnapshotPrompt(prepared),
    'Replacement story'
  );
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(output), retry.id);
  const saved = store.completeRun(
    retry.id,
    output.nativeRisuExecution!.output!.text,
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    retry.snapshot.settings
  );
  expect(saved.parentRevision).toBe(opening);
  expect(saved.text).toBe('Replacement story OUTPUT');
  expect(readChatVariables(store, chatId).revision).toBe(live.revision + 1);
  expect(readChatVariables(store, chatId).values.finished).toBe('yes');
  expect(store.source(old.id).text).toBe('Old story OUTPUT');
});

test('native choices feed the next prompt and output variables commit with the source', async () => {
  const { store, chatId } = await setup();
  const first = store.chat(chatId).headRevision!;
  await applyNativeRisuAction(
    store,
    chatId,
    first,
    actionBody(store, chatId, 'choose', 'choose-run')
  );
  const chat = store.chat(chatId);
  const created = store.createRun(
    chatId,
    {
      request: 'Continue',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'continue',
    },
    () => ({
      chatId,
      parentRevision: chat.headRevision,
      request: 'Continue',
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      history: store.history(chat.headRevision),
      profile: store.product.snapshot(chatId),
      resources: [],
    })
  );
  expect(created.run.snapshot.promptCompilation).toBeUndefined();
  store.startRun(created.run.id);
  const prepared = await prepareNativeRisuRun(created.run.snapshot);
  const compiled = compileSnapshotPrompt({ ...prepared, contextPlan: undefined });
  expect(JSON.stringify(compiled.promptCompilation?.messages)).toContain('Choice:yes');
  expect(JSON.stringify(compiled.promptCompilation?.messages)).toContain('Continue INPUT');
  const output = await prepareNativeRisuOutput(compiled, 'Story');
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(JSON.stringify(output), created.run.id);
  const saved = store.completeRun(
    created.run.id,
    output.nativeRisuExecution!.output!.text,
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    chat.settings
  );
  expect(saved.text).toBe('Story OUTPUT');
  expect(readChatVariables(store, chatId).values.finished).toBe('yes');
  expect(await prepareNativeRisuRun(output)).toBe(output);
});

test('a legacy native action receipt conflicts without executing the action again', async () => {
  const { store, chatId } = await setup();
  const first = store.chat(chatId).headRevision!;
  const body = actionBody(store, chatId, 'choose', 'legacy-receipt');
  await applyNativeRisuAction(store, chatId, first, body);
  const receipt = store.db
    .prepare('SELECT id,snapshot FROM runs WHERE chat_id=? AND request_key=?')
    .get(chatId, 'native-action:legacy-receipt')!;
  const snapshot = JSON.parse(String(receipt.snapshot));
  snapshot.nativeRisuAuthored.commandHash = 'legacy-branch-scoped-command';
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(JSON.stringify(snapshot), receipt.id);
  const head = store.chat(chatId).headRevision;
  const sources = store.db
    .prepare('SELECT COUNT(*) AS count FROM sources WHERE chat_id=?')
    .get(chatId);
  await expect(applyNativeRisuAction(store, chatId, first, body)).rejects.toThrow(
    'RISU_NATIVE_ACTION_REPLAY_CONFLICT'
  );
  expect(store.chat(chatId).headRevision).toBe(head);
  expect(
    store.db.prepare('SELECT COUNT(*) AS count FROM sources WHERE chat_id=?').get(chatId)
  ).toEqual(sources);
});

test('unprepared failed native runs require a fresh retry instead of an unrepeatable candidate', async () => {
  const { store, chatId } = await setup();
  const chat = store.chat(chatId);
  const created = store.createRun(
    chatId,
    {
      request: 'Continue',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'unfinished',
    },
    () => ({
      chatId,
      parentRevision: chat.headRevision,
      request: 'Continue',
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      history: store.history(chat.headRevision),
      profile: store.product.snapshot(chatId),
      resources: [],
    })
  );
  store.startRun(created.run.id);
  store.finishRun(created.run.id, 'failed', 'Interrupted before native preparation');
  const fresh = store.candidate(created.run.id, 'candidate', 'Candidate');
  expect(fresh.run.chatId).not.toBe(chatId);
  expect(fresh.run.snapshot.nativeRisuExecution).toBeUndefined();
  expect(store.retryRun(created.run.id, 'retry').created).toBe(true);
});

test('native input dialog resumes the suspended invocation and rejects duplicate replies', async () => {
  const { store, chatId } = await setup(),
    app = Fastify();
  nativeInteractionRoutes(app, store);
  const first = store.chat(chatId).headRevision!;
  const invocation = applyNativeRisuAction(
    store,
    chatId,
    first,
    actionBody(store, chatId, 'ask', 'ask'),
    {
      createHost: (runId) => (method, args, signal) =>
        requestNativeInteraction(store, runId, method, args, signal),
    }
  );
  try {
    let question: { id: string; kind: string } | undefined;
    await expect
      .poll(async () => {
        question = (await app.inject(`/api/chats/${chatId}/risu-interactions`)).json()
          .interactions[0];
        return question?.kind;
      })
      .toBe('input');
    const url = `/api/chats/${chatId}/risu-interactions/${question!.id}`;
    expect(
      (await app.inject({ method: 'POST', url, payload: { answer: 'Writer' } })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url, payload: { answer: 'Other' } })).statusCode
    ).toBe(404);
    expect(
      store.events(chatId, 0).filter((event) => event.kind === 'native.interaction.resolved')
    ).toHaveLength(1);
    await expect
      .poll(async () => {
        question = (await app.inject(`/api/chats/${chatId}/risu-interactions`)).json()
          .interactions[0];
        return question?.kind;
      })
      .toBe('select');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/chats/${chatId}/risu-interactions/${question!.id}`,
          payload: { answer: '1' },
        })
      ).statusCode
    ).toBe(200);
    await invocation;
    expect(
      store.events(chatId, 0).filter((event) => event.kind === 'native.interaction.resolved')
    ).toHaveLength(2);
    const variables = readChatVariables(store, chatId);
    expect(variables.values).toMatchObject({ name: 'Writer', selected: '1' });
  } finally {
    await app.close();
  }
});

test('cancelled native input notifies other readers and cannot accept a late answer', async () => {
  const { store, chatId } = await setup();
  const app = Fastify();
  nativeInteractionRoutes(app, store);
  const controller = new AbortController();
  const invocation = applyNativeRisuAction(
    store,
    chatId,
    store.chat(chatId).headRevision!,
    actionBody(store, chatId, 'ask', 'cancel-input'),
    {
      signal: controller.signal,
      createHost: (runId) => (method, args, signal) =>
        requestNativeInteraction(store, runId, method, args, signal),
    }
  ).catch((error: unknown) => error);
  try {
    let question: { id: string } | undefined;
    await expect
      .poll(async () => {
        question = (await app.inject(`/api/chats/${chatId}/risu-interactions`)).json()
          .interactions[0];
        return !!question;
      })
      .toBe(true);
    controller.abort();
    expect(await invocation).toBeInstanceOf(Error);
    expect(
      (await app.inject(`/api/chats/${chatId}/risu-interactions`)).json().interactions
    ).toEqual([]);
    expect(
      store.events(chatId, 0).filter((event) => event.kind === 'native.interaction.resolved')
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/chats/${chatId}/risu-interactions/${question!.id}`,
          payload: { answer: 'Too late' },
        })
      ).statusCode
    ).toBe(404);
  } finally {
    controller.abort();
    await app.close();
  }
});

test('Lua-authored extra messages survive independent copy and portable restore without input snapshots', async () => {
  const { store, chatId } = await setup(true);
  const source = await appendNativeSource(store, chatId, 'Native story');
  const view = (database: Store, id: string, head: string) =>
    nativeSourceSnapshot(database, id, head).snapshot.logicalHistory!.map(({ role, text }) => ({
      role,
      text,
    }));
  const expected = view(store, chatId, source.id);
  expect(expected.some((message) => message.text === 'Script postscript')).toBe(true);
  expect(
    expected.some((message) => message.role === 'user' && message.text === 'Script user reply')
  ).toBe(true);
  const copied = forkChat(store, chatId, {
    fromRevision: source.id,
    idempotencyKey: 'native-copy',
  });
  expect(view(store, copied.id, copied.headRevision!)).toEqual(expected);
  const path = mkdtempSync(join(tmpdir(), 'uimori-native-copy-'));
  const target = new Store(join(path, 'app.sqlite'));
  owned.push({ path, store: target });
  const restored = await importChatBackup(target, {
    backup: exportChatBackup(store, chatId),
    idempotencyKey: 'native-restore',
  });
  expect(view(target, restored.chat.id, restored.chat.headRevision!)).toEqual(expected);
  const snapshots = target.detail(restored.chat.id).runs.map((run) => run.snapshot);
  expect(
    snapshots.every(
      (snapshot) =>
        !snapshot.nativeRisuExecution && !snapshot.logicalHistory && !snapshot.promptCompilation
    )
  ).toBe(true);
});
