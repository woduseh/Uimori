import { updateTestProfile } from './fixtures/model-workspace.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { createAgentCollaboration, createAgentDefinition } from '../core/agent-collaboration.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import type { ChatProfile, Connection, ModelPreset, PromptPreset } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { deleteLibraryItem, libraryDeletionImpact } from '../server/library-deletion.js';
import { buildAgentProviderRequest } from '../server/agent-collaboration.js';
import { buildMainProviderRequest } from '../server/main-request.js';
import { definePrompt } from '../core/prompt-authoring.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';

const owned: { root: string; store: Store }[] = [];
function database() {
  const root = mkdtempSync(join(tmpdir(), 'uimori-collaboration-store-'));
  const store = new Store(join(root, 'story.sqlite'));
  owned.push({ root, store });
  return store;
}
afterEach(() => {
  for (const { root, store } of owned.splice(0).reverse()) {
    store.close();
    const path = resolve(root),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-collaboration-store-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
const profileBody = (p: ChatProfile) => ({
  expectedRevision: p.revision,
  attachments: p.attachments,
  routes: p.routes,
  image: p.image,
});
function fixture() {
  const store = database(),
    product = store.product;
  const created = createFixtureChat(store, 'Synthetic advisor snapshot');
  const chat = store.settings(created.id, created.settingsRevision, {
    ...created.settings,
    translation: false,
    status: false,
  });
  const connection = product.connection({
    title: 'Synthetic connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9/turn',
    enabled: true,
    credentialEnv: 'Advisor_Test_Key',
  }) as Connection;
  const body = {
    title: 'Synthetic model',
    connectionId: connection.id,
    modelId: 'deterministic-fixture',
    maxOutputTokens: 1024,
    temperature: null,
  };
  const main = product.model(body) as ModelPreset;
  const advisor = product.model({ ...body, title: 'Advisor model' }) as ModelPreset;
  const agent = { ...createAgentDefinition('character', 'actor'), model: { id: advisor.id } };
  const program = createDefaultPromptProgram('MAIN_ONLY_PRIVATE_INSTRUCTION');
  program.controls = [
    { id: 'shared', label: 'Shared', type: 'text', default: 'default' },
    { id: 'private', label: 'Private', type: 'text', default: 'PRIVATE_OPTION' },
  ];
  program.collaboration = {
    ...createAgentCollaboration(),
    enabled: true,
    sharedInstructions: 'Shared creative direction',
    sharedControls: ['shared'],
    agents: [agent, createAgentDefinition('lore', 'lore')],
  };
  const preset = product.promptPreset({
    title: 'Synthetic collaborating writer',
    role: 'main',
    program,
  }) as PromptPreset;
  const initial = product.profile(chat.id);
  updateTestProfile(product, chat.id, {
    ...profileBody(initial),
    routes: { ...initial.routes, main: { id: main.id } },
  });
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: preset.title, program: preset.program, values: { shared: 'selected' } },
  });
  const capture = () => {
    const p = product.snapshot(chat.id),
      current = store.chat(chat.id);
    return store.createRun(
      chat.id,
      {
        request: 'Synthetic request',
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        expectedProfileRevision: p.revision,
        idempotencyKey: randomUUID(),
      },
      (c): RunSnapshot => ({
        chatId: chat.id,
        parentRevision: c.headRevision,
        settingsRevision: c.settingsRevision,
        settings: c.settings,
        request: 'Synthetic request',
        history: store.history(c.headRevision),
        resources: product.resources(chat.id, p),
        profile: p,
      })
    ).run;
  };
  return { store, product, chat, connection, main, advisor, body, preset, program, capture };
}

test('reservation freezes each advisor and prompt; later current settings apply only to the next run', () => {
  const f = fixture(),
    run = f.capture(),
    frozen = structuredClone(run.snapshot);
  f.product.model(
    { ...f.body, title: 'Changed advisor', maxOutputTokens: 2048, expectedRevision: 1 },
    f.advisor.id
  );
  f.product.promptPreset(
    {
      title: f.preset.title,
      role: 'main',
      program: {
        ...f.program,
        collaboration: { ...f.program.collaboration!, sharedInstructions: 'Changed direction' },
      },
      expectedRevision: 1,
    },
    f.preset.id
  );
  expect(f.store.run(run.id).snapshot).toEqual(frozen);
  expect(promptWorkspace(f.store).main.program.collaboration!.sharedInstructions).toBe(
    'Shared creative direction'
  );
  const edited = f.product.get<PromptPreset>('prompt-preset', f.preset.id);
  updatePromptWorkspace(f.store, {
    expectedRevision: promptWorkspace(f.store).revision,
    main: { title: edited.title, program: edited.program, values: { shared: 'selected' } },
  });
  f.store.startRun(run.id);
  f.store.completeRun(
    run.id,
    'Only the writer becomes a source.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const next = f.capture();
  expect(next.snapshot.profile!.collaborationModels!.actor).toMatchObject({
    revision: 2,
    maxOutputTokens: 2048,
  });
  expect(next.snapshot.profile!.collaborationModels!.lore).toEqual(
    next.snapshot.profile!.models.main
  );
  expect(
    next.snapshot.profile!.promptPresets!.main!.program.collaboration!.sharedInstructions
  ).toBe('Changed direction');
});

test('advisors share explicit instructions and selected options without copying the authored main prompt', () => {
  const f = fixture(),
    // This request-builder unit uses empty history; compile it after the reservation boundary.
    // Queued runs intentionally leave compilation pending until the context planner runs.
    snapshot = compileSnapshotPrompt({ ...f.capture().snapshot, contextPlan: undefined });
  const agent = snapshot.profile!.promptPresets!.main!.program.collaboration!.agents[0];
  const request = buildAgentProviderRequest(
    snapshot,
    agent,
    snapshot.profile!.collaborationModels!.actor,
    'What does this character know?'
  );
  expect(request.input.controls).toEqual({ shared: 'selected' });
  expect(JSON.stringify(request)).toContain('Shared creative direction');
  expect(JSON.stringify(request)).not.toContain('MAIN_ONLY_PRIVATE_INSTRUCTION');
  expect(JSON.stringify(request)).not.toContain('PRIVATE_OPTION');
  expect(
    request.stable.tools.every(
      (tool) =>
        !tool.name.startsWith('agents.') &&
        !tool.name.startsWith('behavior_') &&
        tool.name !== 'story.submit'
    )
  ).toBe(true);
  const main = buildMainProviderRequest(snapshot).request;
  expect(JSON.stringify(main.prompt)).toContain('MAIN_ONLY_PRIVATE_INSTRUCTION');
  expect(main.stable.tools.some((tool) => tool.name === 'agents.consult')).toBe(true);
});

test('archive restore keeps frozen advisor evidence while revoking both inherited and separate connections', () => {
  const f = fixture(),
    run = f.capture();
  const archive = f.product.export(),
    original = JSON.stringify(archive),
    target = database();
  expect(target.product.import(archive)).toMatchObject({ restored: true });
  expect(JSON.stringify(archive)).toBe(original);
  const restored = target.run(run.id);
  expect(restored.status).toBe('interrupted');
  for (const model of Object.values(restored.snapshot.profile!.collaborationModels!)) {
    expect(model.connection.enabled).toBe(false);
    expect(model.connection).not.toHaveProperty('credentialEnv');
  }
  expect(restored.snapshot.profile!.promptPresets!.main!.program.collaboration).toEqual(
    f.program.collaboration
  );
});

test('forged or missing advisor snapshot models roll archive restoration back', () => {
  const f = fixture(),
    run = f.capture(),
    archive = f.product.export();
  for (const forge of [
    (p: Record<string, any>) => {
      p.collaborationModels.actor.id = 'not-selected';
    },
    (p: Record<string, any>) => {
      delete p.collaborationModels.lore;
    },
    (p: Record<string, any>) => {
      p.collaborationModels.extra = p.collaborationModels.actor;
    },
  ]) {
    const damaged = structuredClone(archive),
      row = damaged.tables.runs.find((item) => item.id === run.id)!;
    const snapshot = JSON.parse(row.snapshot);
    forge(snapshot.profile);
    row.snapshot = JSON.stringify(snapshot);
    const target = database();
    expect(() => target.product.import(damaged)).toThrow();
    expect(target.chats()).toHaveLength(0);
  }
});

test('disabled collaboration and switching the main prompt restore the ordinary execution path', () => {
  const f = fixture();
  const disabled = { ...f.program, collaboration: { ...f.program.collaboration!, enabled: false } };
  f.product.promptPreset(
    { title: f.preset.title, role: 'main', program: disabled, expectedRevision: 1 },
    f.preset.id
  );
  expect(f.product.snapshot(f.chat.id)).toHaveProperty('collaborationModels');
  updatePromptWorkspace(f.store, {
    expectedRevision: promptWorkspace(f.store).revision,
    main: { title: f.preset.title, program: disabled, values: {} },
  });
  expect(f.product.snapshot(f.chat.id)).not.toHaveProperty('collaborationModels');
  const plain = f.product.promptPreset({
    title: 'Independent writer',
    role: 'main',
    text: 'Other instructions',
  }) as PromptPreset;
  updatePromptWorkspace(f.store, {
    expectedRevision: promptWorkspace(f.store).revision,
    main: { title: plain.title, program: plain.program, values: {} },
  });
  const run = f.capture();
  expect(run.snapshot.profile!.promptPresets!.main!.id).toBe('current-main');
  expect(run.snapshot.profile!.promptPresets!.main!.program).toEqual(plain.program);
  expect(
    buildMainProviderRequest(run.snapshot).request.stable.tools.some(
      (tool) => tool.name === 'agents.consult'
    )
  ).toBe(false);
});

test('model references, prompt role and CAS are checked before storing collaboration settings', () => {
  const f = fixture();
  expect(libraryDeletionImpact(f.store, 'model', f.advisor.id).canDelete).toBe(true);
  expect(() =>
    f.product.promptPreset({ title: 'Wrong role', role: 'translation', program: f.program })
  ).toThrow('작문');
  const changed = structuredClone(f.program);
  changed.collaboration!.agents[0].model = { id: 'missing-model' };
  expect(() =>
    f.product.promptPreset({ title: 'Missing model', role: 'main', program: changed })
  ).toThrow();
  expect(() =>
    f.product.promptPreset(
      { title: 'Stale editor', role: 'main', program: f.program, expectedRevision: 2 },
      f.preset.id
    )
  ).toThrow('Revision');
  expect(f.product.get<PromptPreset>('prompt-preset', f.preset.id)).toEqual(f.preset);
  expect(
    definePrompt({ controls: {}, compose: () => [], collaboration: createAgentCollaboration() })
      .collaboration
  ).toEqual(createAgentCollaboration());
});

test('advisor model deletion preserves its historical Run independently of current library references', () => {
  const f = fixture(),
    run = f.capture();
  f.product.promptPreset(
    {
      title: f.preset.title,
      role: 'main',
      text: 'The main writes alone now.',
      expectedRevision: 1,
    },
    f.preset.id
  );
  expect(libraryDeletionImpact(f.store, 'model', f.advisor.id).canDelete).toBe(true);
  f.store.startRun(run.id);
  f.store.completeRun(
    run.id,
    'A completed historical scene.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  expect(libraryDeletionImpact(f.store, 'model', f.advisor.id).canDelete).toBe(true);
  deleteLibraryItem(f.store, 'model', f.advisor.id, { expectedRevision: f.advisor.revision });
  const restored = database();
  expect(restored.product.import(f.product.export())).toMatchObject({ restored: true });
  expect(restored.run(run.id).snapshot.profile!.collaborationModels!.actor.id).toBe(f.advisor.id);
});
