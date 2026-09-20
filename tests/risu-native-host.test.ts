import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../server/store.js';
import { prepareRisuImport, applyRisuImport } from '../server/risu-import.js';
import { createPackageStart } from '../server/package-start.js';
import { applyNativeRisuAction, nativeSourceSnapshot } from '../server/risu-native-actions.js';
import { readChatVariables } from '../server/chat-variables.js';
import { packagePresentationRoutes } from '../server/package-presentation-routes.js';
import { buildPackagePresentation } from '../server/package-presentation.js';
import { captureLogicalHistory, compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { prepareNativeRisuRun, prepareNativeRisuOutput } from '../server/risu-native-run.js';
import { disposeAllNativeRisuSessions } from '../server/risu-native-runtime.js';
import { validateRunSnapshot } from '../server/snapshot-archive.js';
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
function setup(extraOutput = false) {
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
  const saved = applyRisuImport(store, {
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
  const branch = store.product.branch(chatId),
    head = store.source(branch.headRevision!);
  return {
    kind: 'trigger',
    name,
    branchId: branch.id,
    expectedHeadRevision: head.id,
    expectedHeadHash: head.hash,
    expectedVariableRevision: readChatVariables(store, chatId, branch.id).revision,
    idempotencyKey: key,
  };
}

test('native first-message button renders, checkpoints state, and survives source refresh', async () => {
  const { store, chatId } = setup();
  const app = Fastify();
  packagePresentationRoutes(app, store);
  try {
    const first = store.chat(chatId).headRevision!;
    const before = await app.inject(`/api/chats/${chatId}/sources/${first}/presentation`);
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
    validateRunSnapshot(
      store,
      store.run(store.source(head).runId).snapshot,
      store.source(head).runId
    );
  } finally {
    await app.close();
  }
});

test('native choices feed the next prompt and output variables commit with the source', async () => {
  const { store, chatId } = setup();
  const first = store.chat(chatId).headRevision!;
  await applyNativeRisuAction(
    store,
    chatId,
    first,
    actionBody(store, chatId, 'choose', 'choose-run')
  );
  const branch = store.product.branch(chatId),
    chat = store.chat(chatId);
  const created = store.createRun(
    chatId,
    {
      request: 'Continue',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'continue',
      branchId: branch.id,
    },
    () => ({
      chatId,
      branchId: branch.id,
      parentRevision: branch.headRevision,
      request: 'Continue',
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      history: store.history(branch.headRevision),
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
  expect(readChatVariables(store, chatId, branch.id).values.finished).toBe('yes');
  expect(await prepareNativeRisuRun(output)).toBe(output);
  validateRunSnapshot(store, output, created.run.id);
});

test('native message replacement copies the branch suffix and never edits another branch', async () => {
  const { store, chatId } = setup();
  let head = store.chat(chatId).headRevision!;
  await applyNativeRisuAction(store, chatId, head, actionBody(store, chatId, 'start', 'start'));
  head = store.chat(chatId).headRevision!;
  expect(store.source(head).text).toBe('Chosen opening');
  const other = store.product.createBranch(chatId, { title: 'Original', fromRevision: head });
  await applyNativeRisuAction(store, chatId, head, actionBody(store, chatId, 'replace', 'replace'));
  const next = store.chat(chatId).headRevision!;
  expect(store.source(next).text).toBe('Changed opening');
  expect(store.product.branch(chatId, other.id).headRevision).toBe(head);
  expect(store.source(head).text).toBe('Chosen opening');
  const captured = nativeSourceSnapshot(store, chatId, next);
  expect(captureLogicalHistory(store, captured.snapshot).map((entry) => entry.text)).toEqual([
    '<selector>',
    'Changed opening',
  ]);
  await expect(
    applyNativeRisuAction(store, chatId, head, actionBody(store, chatId, 'choose', 'outside'))
  ).rejects.toThrow('RISU_NATIVE_SOURCE_OUTSIDE_BRANCH');
});

test('actions preserve all logical messages when output callbacks add messages within one source', async () => {
  const { store, chatId } = setup(true);
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId);
  const created = store.createRun(
    chatId,
    {
      request: 'Continue',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      branchId: branch.id,
      idempotencyKey: 'expanded',
    },
    () => ({
      chatId,
      branchId: branch.id,
      parentRevision: branch.headRevision,
      request: 'Continue',
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      history: store.history(branch.headRevision),
      profile: store.product.snapshot(chatId),
      resources: [],
    })
  );
  store.startRun(created.run.id);
  const prepared = await prepareNativeRisuRun(created.run.snapshot);
  const output = await prepareNativeRisuOutput(compileSnapshotPrompt(prepared), 'Story');
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(JSON.stringify(output), created.run.id);
  const source = store.completeRun(
    created.run.id,
    output.nativeRisuExecution!.output!.text,
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    chat.settings
  );
  const app = Fastify();
  packagePresentationRoutes(app, store);
  try {
    const storedBefore = store.source(source.id);
    const shown = await app.inject(`/api/chats/${chatId}/sources/${source.id}/presentation`);
    expect(shown.statusCode, shown.body).toBe(200);
    const presentation = shown.json();
    expect(presentation.sourceHash).toBe(source.hash);
    expect(presentation.request.text).toBe('Continue');
    expect(presentation.original.html).toContain('[1]Story OUTPUT');
    expect(presentation.original.html).toContain('[2]Script postscript');
    expect(presentation.original.html).toContain('[3]Script user reply');
    expect(presentation.original.html).toContain('[4]Script followup');
    expect(presentation.original.html).not.toContain('Continue');
    expect(presentation.original.html.match(/data-risu-message-index=/gu)).toHaveLength(4);
    expect(presentation.original.html).toContain('data-risu-message-role="user"');
    expect(store.source(source.id)).toEqual(storedBefore);
    const snapshot = nativeSourceSnapshot(store, chatId, source.id).snapshot;
    const translated = await buildPackagePresentation(
      snapshot,
      {
        ...source,
        translation: {
          text: 'Translated body',
          sourceRevision: source.id,
          sourceHash: source.hash,
        },
      },
      undefined,
      {
        nativeMessages: [
          { index: 1, role: 'assistant', primary: true, text: 'Story OUTPUT' },
          { index: 2, role: 'assistant', primary: false, text: 'Script postscript' },
        ],
      }
    );
    if (translated.format !== 'risu-html') throw new Error('Expected native HTML presentation');
    expect(translated.translation!.html).toContain('[1]Translated body');
    expect(translated.translation!.html).toContain('[2]Script postscript');
    expect(translated.translation!.html).not.toContain('Story OUTPUT');
  } finally {
    await app.close();
  }
  const other = store.product.createBranch(chatId, { title: 'Original', fromRevision: source.id });
  const before = nativeSourceSnapshot(store, chatId, source.id).snapshot.logicalHistory!.map(
    ({ role, text }) => ({ role, text })
  );
  await applyNativeRisuAction(
    store,
    chatId,
    source.id,
    actionBody(store, chatId, 'choose', 'expanded-choose')
  );
  const head = store.chat(chatId).headRevision!;
  expect(
    nativeSourceSnapshot(store, chatId, head).snapshot.logicalHistory!.map(({ role, text }) => ({
      role,
      text,
    }))
  ).toEqual(before);
  expect(before.map(({ text }) => text)).toEqual([
    '<selector>',
    'Continue INPUT',
    'Story OUTPUT',
    'Script postscript',
    'Script user reply',
    'Script followup',
  ]);
  expect(store.product.branch(chatId, other.id).headRevision).toBe(source.id);
  expect(store.product.export().tables.sources.length).toBeGreaterThan(2);
});

test('unprepared failed native runs require a fresh retry instead of an unrepeatable candidate', () => {
  const { store, chatId } = setup();
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId);
  const created = store.createRun(
    chatId,
    {
      request: 'Continue',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      branchId: branch.id,
      idempotencyKey: 'unfinished',
    },
    () => ({
      chatId,
      branchId: branch.id,
      parentRevision: branch.headRevision,
      request: 'Continue',
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      history: store.history(branch.headRevision),
      profile: store.product.snapshot(chatId),
      resources: [],
    })
  );
  store.startRun(created.run.id);
  store.finishRun(created.run.id, 'failed', 'Interrupted before native preparation');
  expect(() => store.candidate(created.run.id, 'candidate', 'Candidate')).toThrow(
    '현재 설정으로 다시 요청'
  );
  expect(store.retryRun(created.run.id, 'retry').created).toBe(true);
});

test('native input dialog resumes the suspended invocation and rejects duplicate replies', async () => {
  const { store, chatId } = setup(),
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
    const variables = readChatVariables(store, chatId, store.product.branch(chatId).id);
    expect(variables.values).toMatchObject({ name: 'Writer', selected: '1' });
  } finally {
    await app.close();
  }
});
