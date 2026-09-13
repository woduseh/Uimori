import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content } from '../core/product.js';
import { packageInstanceId } from '../core/execution-context.js';
import type { RunSnapshot } from '../core/types.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { chatVariableProfile } from '../server/chat-variable-context.js';
import { readChatVariables } from '../server/chat-variables.js';
import * as extensionRuntime from '../server/extension-runtime.js';
import { nativeTransferOriginal } from '../server/native-transfer.js';
import { prepareAfterResponse } from '../server/package-after-response.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import {
  prepareAutomaticRunBehavior,
  preparedBehaviorSnapshot,
  runBehaviorProgress,
} from '../server/package-behavior-run.js';
import { productRoutes } from '../server/product-routes.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';
import { Store } from '../server/store.js';
import { injectWithFixtureBot } from './fixtures/chat.js';

const owned: { store: Store; app: FastifyInstance; directory: string }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { store, app, directory } of owned.splice(0).reverse()) {
    await app.close();
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-risu-lua-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-risu-lua-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const app = Fastify();
  productRoutes(app, store, { approvedOrigins: [], publish: () => {} });
  owned.push({ store, app, directory });
  return { store, app };
}

function sourceOf(lua: string, description = 'Synthetic Lua integration') {
  const value = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Synthetic Lua Pilot',
      description,
      first_mes: 'The pilot waits.',
      alternate_greetings: [],
      character_book: { entries: [] },
      extensions: {
        risuai: {
          defaultVariables: 'fallback=authored-default',
          triggerscript: [
            {
              type: 'start',
              conditions: [],
              effect: [{ type: 'triggerlua', code: lua }],
            },
          ],
        },
      },
    },
  };
  return {
    name: 'synthetic-lua-card.json',
    base64: Buffer.from(JSON.stringify(value)).toString('base64'),
  };
}

function imported(lua: string, description?: string) {
  const { store, app } = database();
  const source = sourceOf(lua, description);
  const preview = prepareRisuImport({ source });
  const saved = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    // Input/edit phases and unsupported Risu APIs stay explicit pending findings.
    allowPartial: true,
    idempotencyKey: randomUUID(),
  });
  const chat = saved.chat!;
  const content = store.product.get<Content>('content', saved.receipt.items[0].id);
  const attachment = store.product
    .profile(chat.id)
    .packageAttachments!.find((item) => item.id === content.id)!;
  const instanceId = packageInstanceId(attachment);
  return {
    store,
    app,
    source,
    preview,
    saved,
    chat,
    content,
    attachment,
    instanceId,
    branchId: store.product.branch(chat.id).id,
    endpoint: `/api/chats/${chat.id}/package-behaviors/${instanceId}/actions`,
  };
}

type Fixture = ReturnType<typeof imported>;

function grantVariableWrites(fixture: Fixture) {
  const profile = fixture.store.product.profile(fixture.chat.id);
  fixture.store.product.updateProfile(fixture.chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    packageAttachments: profile.packageAttachments,
    image: profile.image,
    extensionGrants: {
      ...(profile.extensionGrants ?? {}),
      [fixture.instanceId]: {
        packageRevision: fixture.content.revision,
        capabilities: ['variables.write'],
      },
    },
  });
}

function buttonCommand(fixture: Fixture, input: string, idempotencyKey: string = randomUUID()) {
  const detail = behaviorDetail(fixture.store, fixture.chat.id);
  return {
    actionId: 'risu-lua-0-onButtonClick',
    input,
    expectedStateRevision: detail.instances[0].stateRevision,
    expectedSourceHash: detail.sourceHash,
    idempotencyKey,
  };
}

async function postButton(fixture: Fixture, payload: ReturnType<typeof buttonCommand>) {
  return injectWithFixtureBot(fixture.app, {
    method: 'POST',
    url: fixture.endpoint,
    payload,
  });
}

test('Risu import and passive restores preserve native Lua actions and source bytes without execution', () => {
  const execute = vi.spyOn(extensionRuntime, 'executeExtensionProgram');
  const fixture = imported('error("IMPORT_OR_RESTORE_MUST_NOT_EXECUTE")');

  expect(execute).not.toHaveBeenCalled();
  expect(fixture.preview.findings).toContainEqual(
    expect.objectContaining({ code: 'lua-actions', level: 'warning' })
  );
  expect(
    fixture.preview.findings.some(
      (finding) =>
        finding.level === 'unsupported' && finding.code.startsWith('RISU_LUA_PHASE_UNSUPPORTED:')
    )
  ).toBe(true);
  expect(
    fixture.content.package!.behavior!.actions.map((action) => [
      action.id,
      action.triggers,
      action.program?.language,
    ])
  ).toEqual([
    ['risu-lua-0-output', ['after-turn'], 'lua'],
    ['risu-lua-0-start', ['before-turn'], 'lua'],
    ['risu-lua-0-onButtonClick', ['user'], 'lua'],
  ]);
  expect(
    fixture.content.package!.behavior!.actions.every(
      (action) => action.program?.api === 'uimori-state-action-v1'
    )
  ).toBe(true);
  expect(
    nativeTransferOriginal(fixture.store, fixture.saved.receipt.id).sourceFiles![0].base64
  ).toBe(fixture.source.base64);

  const archive = fixture.store.product.export();
  const restored = database().store;
  expect(restored.product.import(archive)).toMatchObject({ restored: true, chats: 1 });
  const restoredPackage = restored.product
    .snapshot(fixture.chat.id)!
    .packages!.find((pkg) => pkg.id === fixture.content.id)!;
  expect(restoredPackage.behavior!.actions.map((action) => action.program?.language)).toEqual([
    'lua',
    'lua',
    'lua',
  ]);

  const copied = importChatBackup(fixture.store, {
    backup: exportChatBackup(fixture.store, fixture.chat.id),
    idempotencyKey: 'copy-passive-lua',
  });
  expect(
    fixture.store.product.snapshot(copied.chat.id)!.packages![0].behavior!.actions[0].program
      ?.language
  ).toBe('lua');
  expect(execute).not.toHaveBeenCalled();
});

test('imported onButtonClick reads defaults and missing values, then commits variables for the next prompt', async () => {
  const fixture = imported(
    `function onButtonClick(id, data)
  setChatVar(id, "selected", data)
  setChatVar(id, "fallbackSeen", getChatVar(id, "fallback"))
  setChatVar(id, "missingSeen", getChatVar(id, "missing"))
end`,
    'SELECTED={{getvar::selected}} FALLBACK={{getvar::fallbackSeen}} MISSING={{getvar::missingSeen}}'
  );
  grantVariableWrites(fixture);

  const first = await postButton(fixture, buttonCommand(fixture, 'open-menu', 'lua-button'));
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().instances[0]).toMatchObject({
    stateRevision: 1,
    state: {},
    lastAction: {
      actionId: 'risu-lua-0-onButtonClick',
      trigger: 'user',
      result: null,
    },
  });
  expect(readChatVariables(fixture.store, fixture.chat.id, fixture.branchId)).toEqual({
    revision: 1,
    values: {
      selected: 'open-menu',
      fallbackSeen: 'authored-default',
      missingSeen: 'null',
    },
  });
  expect(
    fixture.store.db.prepare('SELECT count(*) AS n FROM package_behavior_journal').get()
  ).toEqual({ n: 1 });
  expect(fixture.store.db.prepare('SELECT count(*) AS n FROM chat_variable_journal').get()).toEqual(
    {
      n: 1,
    }
  );

  const profile = chatVariableProfile(fixture.store, fixture.chat.id, fixture.branchId);
  const snapshot = compileSnapshotPrompt({
    chatId: fixture.chat.id,
    branchId: fixture.branchId,
    parentRevision: null,
    settingsRevision: fixture.chat.settingsRevision,
    settings: fixture.chat.settings,
    request: 'Continue.',
    history: [],
    logicalHistory: [],
    profile,
    resources: fixture.store.product.resources(fixture.chat.id, profile),
  });
  expect(JSON.stringify(snapshot.promptCompilation!.messages)).toContain(
    'SELECTED=open-menu FALLBACK=authored-default MISSING=null'
  );

  const archive = fixture.store.product.export();
  const restored = database().store;
  restored.product.import(archive);
  expect(readChatVariables(restored, fixture.chat.id, fixture.branchId)).toEqual({
    revision: 1,
    values: {
      selected: 'open-menu',
      fallbackSeen: 'authored-default',
      missingSeen: 'null',
    },
  });

  const copied = importChatBackup(fixture.store, {
    backup: exportChatBackup(fixture.store, fixture.chat.id),
    idempotencyKey: 'copy-executed-lua',
  });
  expect(
    readChatVariables(
      fixture.store,
      copied.chat.id,
      fixture.store.product.branch(copied.chat.id).id
    )
  ).toEqual({
    revision: 1,
    values: {
      selected: 'open-menu',
      fallbackSeen: 'authored-default',
      missingSeen: 'null',
    },
  });
});

test('imported onStart and onOutput share the generation variable flow and commit with its source', async () => {
  const fixture = imported(
    `function onStart(id)
  setChatVar(id, "phase", "start")
end
function onOutput(id)
  setChatVar(id, "phase", getChatVar(id, "phase") .. ":output")
end`,
    'PHASE={{getvar::phase}}'
  );
  grantVariableWrites(fixture);
  const profile = fixture.store.product.snapshot(fixture.chat.id);
  const snapshot: RunSnapshot = {
    chatId: fixture.chat.id,
    branchId: fixture.branchId,
    parentRevision: fixture.store.product.branch(fixture.chat.id).headRevision,
    settingsRevision: fixture.chat.settingsRevision,
    settings: fixture.chat.settings,
    request: 'Continue.',
    history: [],
    logicalHistory: [],
    profile,
    resources: fixture.store.product.resources(fixture.chat.id, profile),
  };
  const run = fixture.store.createRun(
    fixture.chat.id,
    {
      request: snapshot.request,
      expectedRevision: snapshot.parentRevision,
      expectedSettingsRevision: snapshot.settingsRevision,
      branchId: snapshot.branchId,
      idempotencyKey: 'lua-generation',
    },
    () => snapshot
  ).run;
  expect(fixture.store.startRun(run.id)).toBe(true);

  await prepareAutomaticRunBehavior(fixture.store, run.id);
  const prepared = compileSnapshotPrompt(preparedBehaviorSnapshot(fixture.store, run.id));
  expect(JSON.stringify(prepared.promptCompilation!.messages)).toContain('PHASE=start');
  await prepareAfterResponse(fixture.store, run.id, 'Synthetic response.');
  const progress = runBehaviorProgress(fixture.store, run.id)!;
  expect(progress.entries.map((entry) => entry.trigger)).toEqual(['before-turn']);
  expect(progress.afterResponse!.packages[0].entries.map((entry) => entry.trigger)).toEqual([
    'after-turn',
  ]);
  expect(readChatVariables(fixture.store, fixture.chat.id, fixture.branchId)).toEqual({
    revision: 0,
    values: {},
  });

  fixture.store.completeRun(
    run.id,
    'Synthetic response.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  expect(readChatVariables(fixture.store, fixture.chat.id, fixture.branchId)).toEqual({
    revision: 2,
    values: { phase: 'start:output' },
  });
  expect(
    fixture.store.sourceOriginal(fixture.store.product.branch(fixture.chat.id).headRevision!).text
  ).toBe('Synthetic response.');
});

test('denied imported Lua writes preserve action state, variables, journal and original source', async () => {
  const fixture = imported('function onButtonClick(id, data) setChatVar(id, "selected", data) end');
  const beforePackage = structuredClone(fixture.content.package);
  const beforeSource = nativeTransferOriginal(fixture.store, fixture.saved.receipt.id);

  const denied = await postButton(fixture, buttonCommand(fixture, 'must-not-commit'));
  expect(denied.statusCode, denied.body).toBe(400);
  const detail = behaviorDetail(fixture.store, fixture.chat.id).instances[0];
  expect(detail).toMatchObject({
    stateRevision: 0,
    state: {},
  });
  expect(detail).not.toHaveProperty('lastAction');
  expect(readChatVariables(fixture.store, fixture.chat.id, fixture.branchId)).toEqual({
    revision: 0,
    values: {},
  });
  expect(
    fixture.store.db.prepare('SELECT count(*) AS n FROM package_behavior_journal').get()
  ).toEqual({ n: 0 });
  expect(fixture.store.db.prepare('SELECT count(*) AS n FROM chat_variable_journal').get()).toEqual(
    {
      n: 0,
    }
  );
  expect(fixture.store.product.get<Content>('content', fixture.content.id).package).toEqual(
    beforePackage
  );
  expect(nativeTransferOriginal(fixture.store, fixture.saved.receipt.id)).toEqual(beforeSource);
});
