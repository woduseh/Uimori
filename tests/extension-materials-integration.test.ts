import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import {
  packageControlKey,
  type ContentPackage,
  type PackageAttachment,
} from '../core/content-package.js';
import type { Content } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { EXTENSION_PROGRAM_API, type ExtensionProgram } from '../core/extension-program.js';
import {
  behaviorDetail,
  performBehaviorActionWithProgram,
} from '../server/package-behavior-host.js';
import {
  executeRunBehaviorTool,
  prepareAutomaticRunBehavior,
  runBehaviorProgress,
} from '../server/package-behavior-run.js';
import { listBehaviorTools } from '../core/package-behavior-tools.js';
import * as extensionRuntime from '../server/extension-runtime.js';
import type { BehaviorActionCommand } from '../server/package-behavior-store.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import { readChatVariables, writeChatVariables } from '../server/chat-variables.js';

const owned: { store: Store; dir: string }[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, dir } of owned.splice(0).reverse()) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-extension-materials-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-extension-materials-')),
    store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}

const readOwnMaterials = `
const items = [];
let listOffset = 0;
do {
  const page = await api.host.call('materials.list', {offset: listOffset, limit: 1});
  items.push(...page.items);
  listOffset = page.nextOffset;
} while (listOffset !== null);
const body = items.find((item) => item.id.endsWith(':body'));
if (!body) throw new Error('body material missing');
const defaultList = await api.host.call('materials.list', {});
const defaultRead = await api.host.call('materials.read', {id: body.id});
let text = '';
let readOffset = 0;
let contentHash = null;
do {
  const page = await api.host.call('materials.read', {id: body.id, offset: readOffset, limit: 3});
  text += page.text;
  contentHash = page.contentHash;
  readOffset = page.nextOffset;
} while (readOffset !== null);
return {
  state: {count: api.state.count + 1},
  result: {
    text,
    contentHash,
    listedHash: body.contentHash,
    totalChars: body.totalChars,
    defaultsAgree: defaultList.items.length === items.length && defaultRead.text === text,
    ids: items.map((item) => item.id),
    kinds: items.map((item) => item.kind),
    titles: items.map((item) => item.title)
  }
};`;

const program = (source: string, capability = true): ExtensionProgram => ({
  api: EXTENSION_PROGRAM_API,
  ...(capability ? { capabilities: ['materials.read.self'] } : {}),
  source,
});

function packageDefinition(): ContentPackage {
  return {
    version: 1,
    id: 'extension-materials-fixture',
    revision: 1,
    title: 'Material owner',
    description: 'Material owner description',
    body: 'BODY_FALLBACK',
    bodyTemplate: [
      { kind: 'value', expression: { context: ['bot', 'name'] } },
      { kind: 'text', text: ':' },
      { kind: 'value', expression: { control: 'tone' } },
    ],
    identity: { name: 'Aster', description: 'IDENTITY_SELF' },
    lore: [
      {
        id: 'self-lore',
        title: 'Self lore',
        description: 'Self lore description',
        text: 'LORE_SELF',
        loading: 'discoverable',
      },
    ],
    instructions: [],
    controls: [{ id: 'tone', label: 'Tone', type: 'text', default: 'default' }],
    transforms: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      stateSchema: {
        type: 'record',
        properties: { count: { type: 'number', min: 0, max: 20, integer: true } },
      },
      initialState: { count: 0 },
      actions: [
        {
          id: 'user-read',
          triggers: ['user'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: program(readOwnMaterials),
        },
        {
          id: 'automatic-read',
          triggers: ['before-turn'],
          automaticInput: {},
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: program(readOwnMaterials),
        },
        {
          id: 'model-read',
          triggers: ['model'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: program(readOwnMaterials),
        },
        {
          id: 'undeclared-read',
          triggers: ['user'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: program(
            "const page = await api.host.call('materials.list', {}); return {state: api.state, result: page};",
            false
          ),
        },
        {
          id: 'arbitrary-read',
          triggers: ['user'],
          inputSchema: {
            type: 'record',
            properties: { id: { type: 'string', maxLength: 1000 } },
          },
          effects: [],
          program: program(
            "const item = await api.host.call('materials.read', {id: api.input.id}); return {state: api.state, result: item};"
          ),
        },
        {
          id: 'unknown-field',
          triggers: ['user'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: program(
            "const page = await api.host.call('materials.list', {chatId: 'foreign'}); return {state: api.state, result: page};"
          ),
        },
      ],
      outputParsers: [],
    },
  };
}

function fixture(pkg = packageDefinition()) {
  const store = database(),
    content = store.product.content({
      kind: 'bot',
      title: pkg.title,
      description: pkg.description,
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    }) as Content,
    chat = createFixtureChat(store, 'Extension materials', 'calm', { botId: content.id }),
    ref: PackageAttachment = { id: content.id, revision: content.revision, role: 'bot' };
  const profile = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    routes: profile.routes,
    image: profile.image,
    packageAttachments: profile.packageAttachments,
    packageValues: { [packageControlKey(ref)]: { tone: 'selected' } },
  });
  return {
    store,
    content,
    chat,
    ref,
    instanceId: `${content.id}:bot`,
    branchId: `main:${chat.id}`,
  };
}

type Fixture = ReturnType<typeof fixture>;

function admit(f: Fixture) {
  const chat = f.store.chat(f.chat.id),
    profile = f.store.product.snapshot(chat.id),
    snapshot: RunSnapshot = {
      chatId: chat.id,
      branchId: f.branchId,
      parentRevision: chat.headRevision,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Read the package-owned materials.',
      history: f.store.history(chat.headRevision),
      profile,
      resources: f.store.product.resources(chat.id, profile),
    };
  return f.store.createRun(
    chat.id,
    {
      request: snapshot.request,
      expectedRevision: snapshot.parentRevision,
      expectedSettingsRevision: snapshot.settingsRevision,
      branchId: f.branchId,
      idempotencyKey: randomUUID(),
    },
    () => snapshot
  ).run;
}

function start(f: Fixture, run = admit(f)) {
  expect(f.store.startRun(run.id)).toBe(true);
  return f.store.run(run.id);
}

function command(f: Fixture, actionId: string, input: RuntimeValue = {}): BehaviorActionCommand {
  const detail = behaviorDetail(f.store, f.chat.id),
    state = detail.instances[0];
  return {
    actionId,
    input,
    expectedStateRevision: state.stateRevision,
    expectedSourceHash: detail.sourceHash,
    idempotencyKey: randomUUID(),
  };
}

function materialResult(value: unknown) {
  return value as {
    text: string;
    contentHash: string;
    listedHash: string;
    totalChars: number;
    defaultsAgree: boolean;
    ids: string[];
    kinds: string[];
    titles: string[];
  };
}

test('user Guest reads only its projected body, identity and lore through bounded pagination', async () => {
  const f = fixture();
  const detail = await performBehaviorActionWithProgram(
    f.store,
    f.chat.id,
    f.branchId,
    f.instanceId,
    command(f, 'user-read')
  );
  const result = materialResult(detail.instances[0].lastAction!.result);
  expect(result).toMatchObject({
    text: 'Aster:selected',
    contentHash: result.listedHash,
    totalChars: 'Aster:selected'.length,
    defaultsAgree: true,
  });
  expect(result.ids).toEqual([
    `package:${f.content.id}:bot:identity`,
    `package:${f.content.id}:bot:body`,
    `package:${f.content.id}:bot:lore:self-lore`,
  ]);
  expect(result.titles).toEqual(['Aster', 'Material owner', 'Self lore']);
  expect(result.kinds).toEqual(['bot', 'bot', 'lore']);
  expect(detail.instances[0]).toMatchObject({ stateRevision: 1, state: { count: 1 } });

  const archive = f.store.product.export(),
    restored = database(),
    execute = vi.spyOn(extensionRuntime, 'executeExtensionProgram');
  expect(restored.product.import(archive)).toEqual({ restored: true, chats: 1 });
  expect(behaviorDetail(restored, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 1 },
    lastAction: { result },
  });
  expect(execute).not.toHaveBeenCalled();
});

test('user material reads share frozen branch variable overrides and reject late ABA adoption', async () => {
  const pkg = packageDefinition();
  pkg.variableDefaults = { values: { phase: 'authored default' } };
  pkg.bodyTemplate = [
    { kind: 'value', expression: { op: 'get', args: [{ context: ['variables'] }, 'phase'] } },
  ];
  const f = fixture(pkg);
  const initial = writeChatVariables(f.store, f.chat.id, f.branchId, {
    expectedRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'materials-shared-initial',
    values: { phase: 'shared override' },
  });
  const first = await performBehaviorActionWithProgram(
    f.store,
    f.chat.id,
    f.branchId,
    f.instanceId,
    command(f, 'user-read')
  );
  const result = materialResult(first.instances[0].lastAction!.result);
  expect(result).toMatchObject({
    text: 'shared override',
    listedHash: result.contentHash,
    totalChars: 'shared override'.length,
    defaultsAgree: true,
  });
  expect(first.instances[0]).toMatchObject({ stateRevision: 1, state: { count: 1 } });

  const execute = extensionRuntime.executeExtensionProgram;
  let guestText: string | undefined;
  vi.spyOn(extensionRuntime, 'executeExtensionProgram').mockImplementationOnce(async (...args) => {
    const computed = await execute(...args);
    guestText = materialResult(computed.result).text;
    const intervening = writeChatVariables(f.store, f.chat.id, f.branchId, {
      expectedRevision: initial.revision,
      expectedSourceHash: null,
      idempotencyKey: 'materials-shared-b',
      values: { phase: 'intervening value' },
    });
    writeChatVariables(f.store, f.chat.id, f.branchId, {
      expectedRevision: intervening.revision,
      expectedSourceHash: null,
      idempotencyKey: 'materials-shared-a-again',
      values: initial.values,
    });
    return computed;
  });
  await expect(
    performBehaviorActionWithProgram(
      f.store,
      f.chat.id,
      f.branchId,
      f.instanceId,
      command(f, 'user-read')
    )
  ).rejects.toThrow('BEHAVIOR_PROGRAM_CONTEXT_CHANGED');
  expect(guestText).toBe('shared override');
  expect(readChatVariables(f.store, f.chat.id, f.branchId)).toEqual({
    revision: initial.revision + 2,
    values: initial.values,
  });
  expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 1 },
    lastAction: { result },
  });
  expect(f.store.product.get<Content>('content', f.content.id).package!.body).toBe('BODY_FALLBACK');
});

test('automatic preparation reads its frozen package revision after a newer library edit', async () => {
  const f = fixture(),
    run = admit(f),
    revised = f.store.product.content(
      {
        kind: f.content.kind,
        title: f.content.title,
        description: f.content.description,
        text: f.content.text,
        loading: f.content.loading,
        relatedIds: f.content.relatedIds,
        expectedRevision: f.content.revision,
        package: {
          ...f.content.package!,
          body: 'FUTURE_BODY',
          bodyTemplate: [{ kind: 'text', text: 'FUTURE_PROJECTION' }],
        },
      },
      f.content.id
    ) as Content;
  expect(revised.revision).toBe(2);
  start(f, run);
  await prepareAutomaticRunBehavior(f.store, run.id);
  const progress = runBehaviorProgress(f.store, run.id)!;
  expect(progress.preparation).toEqual({ status: 'ready', completed: 1, total: 1 });
  expect(materialResult(progress.entries[0].result).text).toBe('Aster:selected');
  expect(JSON.stringify(progress.entries[0].result)).not.toContain('FUTURE_');
  expect(
    f.store.run(run.id).snapshot.profile!.packages!.find((pkg) => pkg.id === f.content.id)!.revision
  ).toBe(1);
  f.store.completeRun(
    run.id,
    'Prose commits the frozen material result.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 1 },
  });
});

test('model Guest reads the same frozen self projection and stages its receipt until prose commits', async () => {
  const f = fixture(),
    run = start(f),
    binding = listBehaviorTools(run.snapshot).find((item) => item.actionId === 'model-read')!;
  await prepareAutomaticRunBehavior(f.store, run.id);
  const event = await executeRunBehaviorTool(f.store, run.id, binding, {
    callId: 'materials-model-call',
    name: binding.tool.name,
    args: {},
  });
  expect(event.denied).toBe(false);
  expect(materialResult(event.result).text).toBe('Aster:selected');
  expect(behaviorDetail(f.store, f.chat.id).instances[0].state).toEqual({ count: 0 });
  f.store.completeRun(
    run.id,
    'Model prose commits both automatic and model material reads.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 2,
    state: { count: 2 },
  });
});

test('undeclared capability, foreign material IDs and unknown fields disclose nothing or mutate state', async () => {
  const f = fixture();
  const attempts = [
    command(f, 'undeclared-read'),
    command(f, 'arbitrary-read', { id: 'package:foreign:module:body' }),
    command(f, 'unknown-field'),
  ];
  await expect(
    performBehaviorActionWithProgram(f.store, f.chat.id, f.branchId, f.instanceId, attempts[0])
  ).rejects.toThrow('BEHAVIOR_PROGRAM_FAILED');
  for (const attempt of attempts.slice(1))
    await expect(
      performBehaviorActionWithProgram(f.store, f.chat.id, f.branchId, f.instanceId, attempt)
    ).rejects.toThrow('BEHAVIOR_PROGRAM_FAILED');
  expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
  });
  expect(
    f.store.behavior.journal({
      chatId: f.chat.id,
      branchId: f.branchId,
      attachmentInstanceId: f.instanceId,
      packageId: f.content.id,
      packageRevision: 1,
      behaviorRevision: 1,
      schemaVersion: 1,
    })
  ).toEqual([]);
});
