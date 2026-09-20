import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { prepareRisuImport, applyRisuImport } from '../server/risu-import.js';
import { applyNativeRisuAction } from '../server/risu-native-actions.js';
import { readChatVariables } from '../server/chat-variables.js';
import { captureLogicalHistory, compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import {
  prepareNativeRisuRun,
  prepareNativeRisuOutput,
  validateNativeRisuExecution,
  nativeRisuInputHash,
} from '../server/risu-native-run.js';
import { prepareNativeRisuRequest } from '../server/risu-native-request.js';
import { disposeAllNativeRisuSessions } from '../server/risu-native-runtime.js';
import { validateRunSnapshot } from '../server/snapshot-archive.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { forkChat } from '../server/chat-fork.js';
import type { RunSnapshot } from '../core/types.js';
import type { ProviderRequest } from '../core/transport.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  disposeAllNativeRisuSessions();
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const target = resolve(path),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-native-archive-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-native-archive-'));
  const store = new Store(join(path, 'test.sqlite'));
  owned.push({ path, store });
  const source = {
    name: 'synthetic.json',
    base64: Buffer.from(
      JSON.stringify({
        spec: 'chara_card_v3',
        data: {
          name: 'Archive fixture',
          description: 'Frozen {{getvar::id}}',
          first_mes: 'Opening',
          extensions: {
            risuai: {
              defaultVariables: 'requestCount=0\noutputCount=0',
              triggerscript: [
                {
                  type: 'start',
                  effect: [
                    {
                      type: 'triggerlua',
                      code: `
function start(id) addChat(id, 'user', 'Initial user'); addChat(id, 'char', 'Initial char') end
listenEdit('editRequest', function(id, messages)
  setChatVar(id, 'requestCount', tostring(tonumber(getChatVar(id, 'requestCount')) + 1))
  return messages
end)
function onOutput(id)
  setChat(id, 0, 'Edited prior user')
  setChatVar(id, 'outputCount', tostring(tonumber(getChatVar(id, 'outputCount')) + 1))
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
  const result = applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'import',
  });
  return { store, chatId: result.chat!.id };
}
async function action(store: Store, chatId: string) {
  const branch = store.product.branch(chatId),
    head = store.source(branch.headRevision!);
  await applyNativeRisuAction(store, chatId, head.id, {
    kind: 'trigger',
    name: 'start',
    branchId: branch.id,
    expectedHeadRevision: head.id,
    expectedHeadHash: head.hash,
    expectedVariableRevision: readChatVariables(store, chatId, branch.id).revision,
    idempotencyKey: 'start',
  });
  return store.source(store.chat(chatId).headRevision!);
}
function request(snapshot: RunSnapshot): ProviderRequest {
  const p = snapshot.promptCompilation!;
  return {
    role: 'main',
    modelId: 'mock',
    stable: { contract: 'synthetic', tools: [] },
    input: { task: '', controls: {} },
    prompt: {
      compilerVersion: p.compilerVersion,
      messages: p.messages,
      cachePlan: p.cachePlan,
      values: p.values,
    },
  };
}
async function turn(store: Store, chatId: string, legacyNativeOutputReplay = false) {
  const branch = store.product.branch(chatId),
    chat = store.chat(chatId);
  const result = store.createRun(
    chatId,
    {
      request: 'Continue',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
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
  store.startRun(result.run.id);
  const snapshot = result.run.snapshot;
  if (legacyNativeOutputReplay)
    snapshot.logicalHistory = captureLogicalHistory(store, snapshot, { legacyNativeOutputReplay });
  const prepared = compileSnapshotPrompt(await prepareNativeRisuRun(snapshot));
  // Literal identity-looking variable names and values must not be treated as references.
  Object.assign(prepared.nativeRisuExecution!.variables, {
    id: chatId,
    sourceRevision: branch.headRevision!,
    runId: result.run.id,
  });
  Object.assign(
    prepared.nativeRisuExecution!.preRequest!.variables,
    prepared.nativeRisuExecution!.variables
  );
  const wire = await prepareNativeRisuRequest(prepared, request(prepared));
  const finished = await prepareNativeRisuOutput(wire.snapshot, 'Generated');
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(JSON.stringify(finished), result.run.id);
  const source = store.completeRun(
    result.run.id,
    finished.nativeRisuExecution!.output!.text,
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    chat.settings
  );
  validateRunSnapshot(store, store.run(result.run.id).snapshot, result.run.id);
  return source;
}
function logical(store: Store, chatId: string) {
  const branch = store.product.branch(chatId),
    source = store.source(branch.headRevision!);
  return captureLogicalHistory(store, {
    ...store.run(source.runId).snapshot,
    history: store.history(branch.headRevision),
    parentRevision: branch.headRevision,
  });
}

test('legacy stale native history restores exactly while fresh continuations preserve user source edits', async () => {
  const { store, chatId } = setup();
  const first = await turn(store, chatId);
  await turn(store, chatId);
  const edited = store.editSource(first.id, { expectedRevision: 0, text: 'User corrected first' });
  const third = await turn(store, chatId, true);
  const historical = store.run(third.runId).snapshot;
  expect(
    historical.logicalHistory!.find((message) => message.id === `source:${first.id}`)
  ).toMatchObject({
    text: first.text,
    sourceHash: edited.hash,
  });
  expect(captureLogicalHistory(store, historical)).not.toEqual(historical.logicalHistory);
  expect(captureLogicalHistory(store, historical, { legacyNativeOutputReplay: true })).toEqual(
    historical.logicalHistory
  );
  validateRunSnapshot(store, historical, third.runId);
  const forged = structuredClone(historical);
  forged.logicalHistory!.find((message) => message.id === `source:${first.id}`)!.text =
    'Forged text';
  forged.nativeRisuExecution!.inputHash = nativeRisuInputHash(forged);
  expect(() => validateRunSnapshot(store, forged, third.runId)).toThrow('logical history mismatch');

  const backup = exportChatBackup(store, chatId);
  const restored = importChatBackup(store, { backup, idempotencyKey: 'restore-legacy-history' });
  const restoredThird = store.source(restored.chat.headRevision!);
  const restoredHistorical = store.run(restoredThird.runId).snapshot;
  expect(restoredHistorical.logicalHistory!.map((message) => message.text)).toEqual(
    historical.logicalHistory!.map((message) => message.text)
  );
  validateRunSnapshot(store, restoredHistorical, restoredThird.runId);

  const archivePath = mkdtempSync(join(tmpdir(), 'uimori-native-archive-'));
  const archiveStore = new Store(join(archivePath, 'restored.sqlite'));
  owned.push({ path: archivePath, store: archiveStore });
  archiveStore.product.import(store.product.export());
  expect(archiveStore.run(third.runId).snapshot).toEqual(historical);
  validateRunSnapshot(archiveStore, archiveStore.run(third.runId).snapshot, third.runId);

  for (const [currentStore, currentChat] of [
    [store, chatId],
    [store, restored.chat.id],
    [archiveStore, chatId],
  ] as const) {
    const corrected = currentStore
      .history(currentStore.chat(currentChat).headRevision)
      .find((source) => source.text === edited.text)!;
    const fourth = await turn(currentStore, currentChat);
    const captured = currentStore.run(fourth.runId).snapshot;
    expect(
      captured.logicalHistory!.find((message) => message.id === `source:${corrected.revision}`)
    ).toMatchObject({
      text: edited.text,
      sourceHash: edited.hash,
    });
    expect(JSON.stringify(captured.promptCompilation!.messages)).toContain(edited.text);
    validateRunSnapshot(currentStore, captured, fourth.runId);
  }
  expect(store.run(third.runId).snapshot).toEqual(historical);
  expect(store.run(restoredThird.runId).snapshot).toEqual(restoredHistorical);
});

test('historical native candidates require a current-settings retry without changing saved history', async () => {
  const { store, chatId } = setup();
  const last = await turn(store, chatId);
  const historical = store.run(last.runId).snapshot;
  historical.nativeRisuExecution!.version = 1;
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(JSON.stringify(historical), last.runId);
  const branches = store.product.branches(chatId);
  const before = store.run(last.runId);
  expect(() => store.candidate(last.runId, 'old-candidate', 'Old inputs')).toThrow(
    /이전 프롬프트 형식.*현재 설정으로 다시 요청/
  );
  expect(store.product.branches(chatId)).toEqual(branches);
  expect(store.run(last.runId)).toEqual(before);
  expect(store.source(last.id).text).toBe(last.text);
  const retry = store.retryRun(last.runId, 'current-settings').run;
  expect(retry.snapshot.nativeRisuExecution).toBeUndefined();
  expect(retry.snapshot.profile!.packages).toEqual(store.product.snapshot(chatId).packages);
});

test.each(['queued', 'running'] as const)(
  'restart never replays a historical %s native run or edits its snapshot',
  async (status) => {
    const { store, chatId } = setup();
    const last = await turn(store, chatId);
    const candidate = store.candidate(last.runId, 'pending-old-run', 'Pending old run').run;
    if (status === 'running') store.startRun(candidate.id);
    const historical = store.run(candidate.id).snapshot;
    historical.nativeRisuExecution!.version = 1;
    store.db
      .prepare('UPDATE runs SET snapshot=? WHERE id=?')
      .run(JSON.stringify(historical), candidate.id);
    const attempts = store.db.prepare('SELECT count(*) AS n FROM attempts').get();
    const before = store.source(last.id);
    store.recover();
    expect(store.run(candidate.id)).toMatchObject({ status: 'interrupted', snapshot: historical });
    expect(store.run(candidate.id).error).toMatch(/이전 프롬프트 형식.*현재 설정으로 다시 요청/);
    expect(store.source(last.id)).toEqual(before);
    expect(store.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual(attempts);
  }
);

test('portable native receipts preserve authored text and wire proofs while remapping history on repeated restore', async () => {
  const { store, chatId } = setup();
  await action(store, chatId);
  const last = await turn(store, chatId);
  const original = store.run(last.runId).snapshot;
  const backup = exportChatBackup(store, chatId),
    untouched = JSON.stringify(backup);
  const originalHistory = logical(store, chatId);
  expect(originalHistory.map((m) => m.text)).toContain('Edited prior user');
  for (const key of ['copy-1', 'copy-2']) {
    const restored = importChatBackup(store, { backup, idempotencyKey: key });
    const copiedSource = store.source(restored.chat.headRevision!),
      copy = store.run(copiedSource.runId).snapshot;
    expect(copy.nativeRisuExecution!.inputHash).not.toBe(original.nativeRisuExecution!.inputHash);
    expect(copy.nativeRisuExecution!.variables).toEqual(original.nativeRisuExecution!.variables);
    expect(copy.nativeRisuExecution!.fields).toEqual(original.nativeRisuExecution!.fields);
    expect(copy.nativeRisuExecution!.requestEdits).toEqual(
      original.nativeRisuExecution!.requestEdits
    );
    expect(logical(store, restored.chat.id).map((m) => m.text)).toEqual(
      originalHistory.map((m) => m.text)
    );
    const ids = logical(store, restored.chat.id).map((m) => m.id);
    for (const id of originalHistory.map((m) => m.id)) expect(ids).not.toContain(id);
    validateRunSnapshot(store, copy, copiedSource.runId);
    expect(store.product.export()).toBeTruthy();
  }
  expect(JSON.stringify(backup)).toBe(untouched);
});

test('native fork keeps multi-message identities, validates source hashes, and never recompiles actions', async () => {
  const { store, chatId } = setup();
  const authored = await action(store, chatId),
    last = await turn(store, chatId);
  const original = store.run(last.runId).snapshot;
  const fork = forkChat(store, chatId, { fromRevision: last.id, idempotencyKey: 'fork' });
  expect(logical(store, fork.id).map((m) => m.text)).toEqual(
    logical(store, chatId).map((m) => m.text)
  );
  const copied = store.run(store.source(fork.headRevision!).runId);
  expect(copied.snapshot.nativeRisuExecution!.requestEdits).toEqual(
    original.nativeRisuExecution!.requestEdits
  );
  for (const entry of store.history(fork.headRevision)) {
    const run = store.run(store.source(entry.revision).runId);
    if (run.snapshot.nativeRisuAuthored) expect(run.snapshot.promptCompilation).toBeUndefined();
    validateRunSnapshot(store, run.snapshot, run.id);
  }
  expect(store.source(authored.id).text).toBe('Initial char');
  const tampered = structuredClone(original);
  tampered.nativeRisuExecution!.inputHash = '0'.repeat(64);
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(JSON.stringify(tampered), last.runId);
  expect(() =>
    forkChat(store, chatId, { fromRevision: last.id, idempotencyKey: 'invalid' })
  ).toThrow('RISU_NATIVE_RECEIPT_MISMATCH');
});

test('native candidates reuse prepared input but run fresh request/output callbacks, and actions cannot regenerate', async () => {
  const { store, chatId } = setup();
  const authored = await action(store, chatId),
    last = await turn(store, chatId);
  expect(() => store.candidate(authored.runId, 'action-candidate', 'bad')).toThrow(
    'Authored opening'
  );
  expect(() => store.retryRun(authored.runId, 'action-retry')).toThrow('Authored opening');
  const candidate = store.candidate(last.runId, 'candidate', 'Another response').run;
  const receipt = candidate.snapshot.nativeRisuExecution!;
  expect(receipt.output).toBeUndefined();
  expect(receipt.requestEdits).toBeUndefined();
  expect(receipt.variables.requestCount).toBe('0');
  validateNativeRisuExecution(candidate.snapshot);
  store.startRun(candidate.id);
  const wire = await prepareNativeRisuRequest(candidate.snapshot, request(candidate.snapshot));
  expect(wire.snapshot.nativeRisuExecution!.variables.requestCount).toBe('1');
  const output = await prepareNativeRisuOutput(wire.snapshot, 'Different');
  expect(output.nativeRisuExecution!.output!.text).toBe('Different');
  expect(output.nativeRisuExecution!.output!.variables.outputCount).toBe('1');
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(JSON.stringify(output), candidate.id);
  const adopted = store.completeRun(
    candidate.id,
    output.nativeRisuExecution!.output!.text,
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    candidate.snapshot.settings
  );
  expect(adopted.text).toBe('Different');
  expect(store.source(last.id).text).toBe('Generated');
  validateRunSnapshot(store, output, candidate.id);
});

test('native execution rejects forged historical provenance and out-of-scope message identities', async () => {
  const { store, chatId } = setup();
  await action(store, chatId);
  const last = await turn(store, chatId),
    original = store.run(last.runId).snapshot;
  const changes: ((snapshot: RunSnapshot) => void)[] = [
    (s) => {
      s.nativeRisuExecution!.history.find((m) => m.sourceRevision)!.sourceHash = '0'.repeat(64);
    },
    (s) => {
      s.nativeRisuExecution!.history.find((m) => m.sourceRevision)!.runId = 'foreign-run';
    },
    (s) => {
      s.nativeRisuExecution!.history.find((m) => m.sourceRevision)!.sourceRevision =
        'foreign-source';
    },
    (s) => {
      s.nativeRisuExecution!.output!.messages[0]!.id = 'source:foreign-source';
    },
    (s) => {
      s.nativeRisuExecution!.preRequest!.messages[0]!.id = 'request:foreign-source';
    },
    (s) => {
      s.nativeRisuHistoryRevision = 'a'.repeat(64);
    },
  ];
  for (const change of changes) {
    const altered = structuredClone(original);
    change(altered);
    expect(() => validateNativeRisuExecution(altered)).toThrow('RISU_NATIVE_RECEIPT_MISMATCH');
  }
  const changed = structuredClone(original);
  changed.nativeRisuExecution!.history[0]!.text = 'Script-edited text is permitted';
  expect(() => validateNativeRisuExecution(changed)).not.toThrow();
});
