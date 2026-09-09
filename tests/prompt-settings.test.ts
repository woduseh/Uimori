import { updateTestProfile } from './fixtures/model-workspace.js';
import { injectWithFixtureBot, createFixtureChat } from './fixtures/chat.js';
import { DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import type {
  ChatProfile,
  PromptPreset,
  Connection,
  ModelPreset,
  SavedPromptCombination,
} from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';

const owned: { directory: string; app?: App }[] = [];
test('explicit prompt writes reject unset boolean defaults and values while reads retain legacy nulls', async () => {
  const app = await application();
  const program = createDefaultPromptProgram('Switch');
  program.controls = [{ id: 'enabled', label: 'Enabled', type: 'boolean', default: false }];
  const invalid = structuredClone(program);
  invalid.controls[0].default = null;
  await request(
    app,
    '/prompt-presets',
    { title: 'Unset default', role: 'main', program: invalid },
    400
  );
  await request(
    app,
    '/prompt-presets',
    { title: 'Unset value', role: 'main', program, values: { enabled: null } },
    400
  );
  let current = await workspace(app);
  await request(
    app,
    '/prompt-workspace',
    {
      expectedRevision: current.revision,
      main: { title: 'Unset default', program: invalid, values: {} },
    },
    400,
    'PUT'
  );
  current = await request(
    app,
    '/prompt-workspace',
    {
      expectedRevision: current.revision,
      main: { title: 'Switch', program, values: { enabled: false } },
    },
    200,
    'PUT'
  );
  await request(
    app,
    '/prompt-workspace',
    {
      expectedRevision: current.revision,
      main: { title: 'Unset value', program, values: { enabled: null } },
    },
    400,
    'PUT'
  );
  await request(
    app,
    '/prompt-combinations',
    {
      title: 'Unset switch',
      role: 'main',
      workspaceRevision: current.revision,
      values: { enabled: null },
    },
    400
  );
  const legacy = {
    ...current,
    main: { title: 'Legacy', program: invalid, values: { enabled: null } },
  };
  app.store.db.prepare('UPDATE prompt_workspace SET body=? WHERE id=1').run(JSON.stringify(legacy));
  expect((await workspace(app)).main).toEqual(legacy.main);
  const unchanged = await request(
    app,
    '/prompt-workspace',
    { expectedRevision: legacy.revision, translationPolicy: legacy.translationPolicy },
    200,
    'PUT'
  );
  expect(unchanged.main).toEqual(legacy.main);
  expect(
    JSON.parse(
      String(app.store.db.prepare('SELECT body FROM prompt_workspace WHERE id=1').get()?.body)
    ).main
  ).toEqual(legacy.main);
});
test('option combinations bind to a prompt owner and exact control meanings while preserving working source identity', async () => {
  const app = await application();
  const program = createDefaultPromptProgram('Options');
  program.controls = [{ id: 'tone', label: 'Narration tone', type: 'text', default: 'quiet' }];
  const first = await request<PromptPreset>(app, '/prompt-presets', {
    title: 'First',
    role: 'main',
    program,
  });
  const second = await request<PromptPreset>(app, '/prompt-presets', {
    title: 'Second',
    role: 'main',
    program,
  });
  const options = await request(app, '/prompt-combinations', {
    title: 'Bold',
    role: 'main',
    values: { tone: 'bold' },
    owner: { kind: 'preset', id: first.id },
    expectedRevision: first.revision,
  });
  expect(options).toMatchObject({
    owner: { kind: 'preset', id: first.id },
    controls: program.controls,
  });
  await request(
    app,
    '/prompt-combinations',
    {
      title: 'Stale',
      role: 'main',
      values: {},
      owner: { kind: 'preset', id: first.id },
      expectedRevision: 99,
    },
    409
  );
  await request(
    app,
    '/prompt-combinations',
    {
      title: 'Wrong role',
      role: 'translation',
      values: {},
      owner: { kind: 'preset', id: first.id },
      expectedRevision: first.revision,
    },
    400
  );
  let current = await apply(app, second);
  expect(current.main.presetId).toBe(second.id);
  await request(
    app,
    '/prompt-workspace/apply-options',
    { expectedRevision: current.revision, role: 'main', combinationId: options.id },
    409
  );
  current = await apply(app, first);
  current = await request(app, '/prompt-workspace/apply-options', {
    expectedRevision: current.revision,
    role: 'main',
    combinationId: options.id,
  });
  expect(current.main.values).toEqual({ tone: 'bold' });
  await request(
    app,
    '/prompt-workspace',
    { expectedRevision: current.revision, main: { ...current.main, presetId: second.id } },
    400,
    'PUT'
  );
  const changedProgram = structuredClone(program);
  changedProgram.controls[0].label = 'An unrelated meaning with the same ID';
  current = await request(
    app,
    '/prompt-workspace',
    {
      expectedRevision: current.revision,
      main: { title: 'Edited working copy', program: changedProgram, values: {} },
    },
    200,
    'PUT'
  );
  expect(current.main.presetId).toBe(first.id);
  expect(
    matchesPromptCombination(
      options,
      combinationOwner(current.main, 'main'),
      'main',
      current.main.program
    )
  ).toBe(false);
  await request(
    app,
    '/prompt-workspace/apply-options',
    { expectedRevision: current.revision, role: 'main', combinationId: options.id },
    409
  );
  const working = await request(app, '/prompt-combinations', {
    title: 'Current meaning',
    role: 'main',
    values: { tone: 'new' },
    workspaceRevision: current.revision,
  });
  expect(working).toMatchObject({
    owner: { kind: 'preset', id: first.id },
    controls: changedProgram.controls,
  });
  expect(
    matchesPromptCombination(
      working,
      combinationOwner(current.main, 'main'),
      'main',
      current.main.program
    )
  ).toBe(true);
  await request(
    app,
    '/prompt-combinations',
    { title: 'Stale workspace', role: 'main', values: {}, workspaceRevision: current.revision - 1 },
    409
  );
  await request(
    app,
    '/prompt-combinations',
    {
      title: 'Forged controls',
      role: 'main',
      values: {},
      workspaceRevision: current.revision,
      controls: [],
    },
    400
  );
  await request(
    app,
    '/prompt-combinations',
    {
      title: 'Mixed owner',
      role: 'main',
      values: {},
      workspaceRevision: current.revision,
      owner: { kind: 'preset', id: first.id },
      expectedRevision: 1,
    },
    400
  );
  const legacy = app.store.product.save('prompt-combination', {
    title: 'Legacy unbound',
    role: 'main',
    values: { tone: 'old' },
  });
  expect(
    matchesPromptCombination(
      legacy as SavedPromptCombination,
      combinationOwner(current.main, 'main'),
      'main',
      current.main.program
    )
  ).toBe(false);
  await request(
    app,
    '/prompt-workspace/apply-options',
    { expectedRevision: current.revision, role: 'main', combinationId: legacy.id },
    409
  );
  const before = current;
  current = await request(app, '/prompt-workspace/apply-options', {
    expectedRevision: current.revision,
    role: 'main',
    combinationId: working.id,
  });
  expect(current.main.values).toEqual({ tone: 'new' });
  expect(current.main.presetId).toBe(first.id);
  await request(
    app,
    '/prompt-workspace/apply-options',
    { expectedRevision: before.revision, role: 'main', combinationId: working.id },
    409
  );
});
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in prompt settings tests'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori prompt settings ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function application() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori prompt settings '));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'prompt-settings-synthetic',
    instanceId: randomUUID(),
    testMode: true,
  });
  await item.app.ready();
  return item.app;
}
async function request<T = any>(
  app: App,
  path: string,
  payload: unknown,
  status = 200,
  method: 'POST' | 'PUT' = 'POST'
): Promise<T> {
  const response = await injectWithFixtureBot(app, {
    method,
    url: '/api' + path,
    payload: JSON.stringify(payload),
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json() as T;
}
async function read<T = any>(app: App, path: string, status = 200): Promise<T> {
  const response = await injectWithFixtureBot(app, {
    method: 'GET',
    url: '/api' + path,
    headers: { host: '127.0.0.1' },
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json() as T;
}
const prompt = (role: 'main' | 'translation', text: string, title = 'Synthetic prompt') => ({
  title,
  role,
  text,
});
const profileBody = (prior: ChatProfile, changes: Record<string, unknown> = {}) => ({
  expectedRevision: prior.revision,
  attachments: prior.attachments,

  routes: prior.routes,
  image: prior.image,
  ...changes,
});
function capture(app: App, chatId: string) {
  const store = app.store;
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const text = 'Synthetic source capture, no provider execution';
  return store.createRun(
    chatId,
    {
      request: text,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: randomUUID(),
    },
    (current) =>
      ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request: text,
        history: store.history(current.headRevision),
        resources: store.product.resources(chatId, profile),
        ...(profile ? { profile } : {}),
      }) satisfies RunSnapshot
  ).run;
}
function complete(app: App, run: ReturnType<typeof capture>) {
  app.store.startRun(run.id);
  return app.store.completeRun(
    run.id,
    'Mira waits by the quiet harbor.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}

async function workspace(app: App) {
  return read<import('../core/product.js').PromptWorkspace>(app, '/prompt-workspace');
}
async function apply(app: App, preset: PromptPreset) {
  return request<import('../core/product.js').PromptWorkspace>(app, '/prompt-workspace/apply', {
    expectedRevision: (await workspace(app)).revision,
    role: preset.role,
    presetId: preset.id,
  });
}

describe('global working prompts and independent library copies', () => {
  test('rejects retired fixed creative controls and APIs and retired persona scope', async () => {
    const app = await application();
    const chat = createFixtureChat(app.store, 'Synthetic current profile');
    const initial = app.store.product.profile(chat.id);
    expect(initial).not.toHaveProperty('creative');
    expect(await read(app, '/library')).not.toHaveProperty('presets');
    await request(
      app,
      `/chats/${chat.id}/profile`,
      profileBody(initial, { creative: { mode: 'novel' } }),
      400,
      'PUT'
    );
    await request(
      app,
      `/chats/${chat.id}/profile`,
      profileBody(initial, { personaReference: 'false' }),
      400,
      'PUT'
    );
    await request(app, '/creative-presets', { title: 'Retired' }, 404);
    await request(
      app,
      `/chats/${chat.id}/preset`,
      { expectedRevision: initial.revision, presetId: 'retired', presetRevision: 1 },
      404
    );
    await read(app, '/revisions/preset/retired/1', 404);
    for (const personaReference of [false, true])
      await request(
        app,
        `/chats/${chat.id}/profile`,
        profileBody(initial, { personaReference }),
        400,
        'PUT'
      );
    const saved = await request<ChatProfile>(
      app,
      `/chats/${chat.id}/profile`,
      profileBody(initial),
      200,
      'PUT'
    );
    expect(saved).not.toHaveProperty('personaReference');
    expect(fetch).not.toHaveBeenCalled();
  });
  test('saves exact whitespace, empty text and version history, rejecting stale writes and invalid shapes without generation', async () => {
    const app = await application();
    const literal = `\r\n  {{char}} \${literal}\n<instructions>Keep my exact wording.</instructions>\t\n`;
    const first = await request<PromptPreset>(app, '/prompt-presets', prompt('main', literal));
    expect(first.program).toEqual(createDefaultPromptProgram(literal));
    expect(first).not.toHaveProperty('text');
    expect(first).toMatchObject({ role: 'main', revision: 1 });
    const empty = await request<PromptPreset>(app, '/prompt-presets', prompt('translation', ''));
    expect(empty.program).toEqual(createDefaultPromptProgram('', 'translation'));
    const blank = await request<PromptPreset>(
      app,
      '/prompt-presets',
      prompt('translation', ' \r\n\t')
    );
    expect(blank.program).toEqual(createDefaultPromptProgram(' \r\n\t', 'translation'));
    const next = await request<PromptPreset>(
      app,
      '/prompt-presets/' + first.id,
      { ...prompt('main', 'Replacement\n'), expectedRevision: 1 },
      200,
      'PUT'
    );
    expect(next).toMatchObject({
      id: first.id,
      revision: 2,
      program: createDefaultPromptProgram('Replacement\n'),
    });
    await request(
      app,
      '/prompt-presets/' + first.id,
      { ...prompt('main', 'Lost update'), expectedRevision: 1 },
      409,
      'PUT'
    );
    await request(
      app,
      '/prompt-presets/' + first.id,
      prompt('main', 'Missing revision'),
      400,
      'PUT'
    );
    expect(await read(app, `/revisions/prompt-preset/${first.id}/1`)).toEqual(first);
    const library = await read(app, '/library');
    expect(library.promptPresets).toHaveLength(3);
    expect(library.promptPresets.find((item: PromptPreset) => item.id === first.id)).toEqual(next);
    for (const changes of [
      { role: 'status' },
      { text: null },
      { text: 3 },
      { text: 'x'.repeat(200001) },
      { title: '' },
      { unknown: true },
    ])
      await request(app, '/prompt-presets', { ...prompt('main', 'original'), ...changes }, 400);
    expect(
      (await request<PromptPreset>(app, '/prompt-presets', prompt('main', 'x'.repeat(200000))))
        .program
    ).toEqual(createDefaultPromptProgram('x'.repeat(200000)));
    const ast = createDefaultPromptProgram('AST wins');
    const explicit = await request<PromptPreset>(app, '/prompt-presets', {
      title: 'AST',
      role: 'main',
      text: 'ignored draft',
      program: ast,
    });
    expect(explicit.program).toEqual(ast);
    expect(explicit).not.toHaveProperty('text');
    expect(app.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(app.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('one workspace supplies both chats; stale saves and obsolete chat prompt controls are rejected', async () => {
    const app = await application();
    const one = createFixtureChat(app.store, 'One'),
      two = createFixtureChat(app.store, 'Two');
    const initial = await workspace(app);
    const changed = await request(
      app,
      '/prompt-workspace',
      {
        expectedRevision: initial.revision,
        main: {
          title: 'Exact current',
          program: createDefaultPromptProgram('  Current prose\n'),
          values: {},
        },
      },
      200,
      'PUT'
    );
    expect(changed.translation).toEqual(initial.translation);
    for (const chat of [one, two]) {
      const snapshot = app.store.product.snapshot(chat.id);
      expect(snapshot.promptPresets!.main).toMatchObject({
        id: 'current-main',
        revision: changed.revision,
        program: changed.main.program,
      });
      expect(snapshot.promptPresets!.translation!.id).toBe('current-translation');
      expect(app.store.product.profile(chat.id)).not.toHaveProperty('prompts');
      await request(
        app,
        `/chats/${chat.id}/profile`,
        profileBody(app.store.product.profile(chat.id), { prompts: { main: null } }),
        400,
        'PUT'
      );
    }
    await request(
      app,
      '/prompt-workspace',
      { expectedRevision: initial.revision, main: initial.main },
      409,
      'PUT'
    );
    expect(await workspace(app)).toEqual(changed);
    const before = app.store.db.prepare('SELECT total_changes() AS n').get();
    await workspace(app);
    app.store.product.snapshot(one.id);
    expect(app.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('applying a preset copies its exact program and values; later edits and deletion do not change the workspace', async () => {
    const app = await application();
    const preset = await request<PromptPreset>(app, '/prompt-presets', prompt('translation', ''));
    const current = await apply(app, preset);
    expect(current.translation.program).toEqual(createDefaultPromptProgram('', 'translation'));
    const edited = await request<PromptPreset>(
      app,
      `/prompt-presets/${preset.id}`,
      { ...prompt('translation', 'Later library text'), expectedRevision: 1 },
      200,
      'PUT'
    );
    expect(await workspace(app)).toEqual(current);
    await request(
      app,
      '/prompt-workspace/apply',
      { expectedRevision: current.revision, role: 'main', presetId: preset.id },
      400
    );
    const applied = await apply(app, edited);
    expect(applied.translation.program).toEqual(edited.program);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/prompt-presets/${preset.id}`,
      payload: { expectedRevision: 2 },
      headers: { host: '127.0.0.1' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await workspace(app)).toEqual(applied);
    expect(app.store.product.get('prompt-preset', preset.id, 1)).toEqual(preset);
  });

  test('option presets copy only values into the current role and never retarget a saved prompt', async () => {
    const app = await application();
    const initial = await workspace(app);
    const program = createDefaultPromptProgram('Current options');
    program.controls = [
      {
        id: 'tone',
        label: 'Tone',
        type: 'select',
        default: 'quiet',
        options: [
          { label: 'Quiet', value: 'quiet' },
          { label: 'Bold', value: 'bold' },
        ],
      },
    ];
    const updated = await request(
      app,
      '/prompt-workspace',
      {
        expectedRevision: initial.revision,
        main: { title: 'Working', program, values: { tone: 'quiet' } },
      },
      200,
      'PUT'
    );
    const options = await request(app, '/prompt-combinations', {
      workspaceRevision: updated.revision,
      title: 'Bold option',
      role: 'main',
      values: { tone: 'bold' },
    });
    expect(options).toMatchObject({ role: 'main', values: { tone: 'bold' } });
    expect(options).not.toHaveProperty('prompt');
    const applied = await request(app, '/prompt-workspace/apply-options', {
      expectedRevision: updated.revision,
      role: 'main',
      combinationId: options.id,
    });
    expect(applied.main).toEqual({ ...updated.main, values: { tone: 'bold' } });
    expect(applied.translation).toEqual(updated.translation);
    await request(
      app,
      '/prompt-workspace/apply-options',
      { expectedRevision: applied.revision, role: 'translation', combinationId: options.id },
      400
    );
  });

  test('new scenes capture current working copies while prior source and candidate keep their frozen prompt', async () => {
    const app = await application();
    const chat = createFixtureChat(app.store, 'Frozen prompts');
    const first = await request<PromptPreset>(
      app,
      '/prompt-presets',
      prompt('main', 'First current')
    );
    await apply(app, first);
    const run = capture(app, chat.id),
      frozen = structuredClone(run.snapshot);
    complete(app, run);
    const nextPreset = await request<PromptPreset>(
      app,
      '/prompt-presets',
      prompt('main', 'Next current')
    );
    await apply(app, nextPreset);
    const candidate = app.store.candidate(run.id, randomUUID(), 'Synthetic candidate').run;
    expect(candidate.snapshot.profile).toEqual(frozen.profile);
    app.store.finishRun(candidate.id, 'cancelled', 'Synthetic');
    const next = capture(app, chat.id);
    expect(next.snapshot.profile!.promptPresets!.main!.program).toEqual(nextPreset.program);
    expect(app.store.run(run.id).snapshot).toEqual(frozen);
  });

  test('translation reservations copy the current translation and a later retry keeps earlier jobs intact', async () => {
    const app = await application(),
      chat = createFixtureChat(app.store, 'Translation copies');
    const first = await request<PromptPreset>(
      app,
      '/prompt-presets',
      prompt('translation', 'First translation')
    );
    await apply(app, first);
    const run = capture(app, chat.id),
      source = complete(app, run);
    const job = app.store.requestTranslation(source.id);
    const frozenJob = structuredClone(job);
    const next = await request<PromptPreset>(
      app,
      '/prompt-presets',
      prompt('translation', 'Later translation')
    );
    await apply(app, next);
    expect(app.store.job(job.id)).toEqual(frozenJob);
    app.store.cancelJob(job.id);
    const old = app.store.job(job.id);
    const retried = app.store.retryJob(job.id);
    expect(retried.id).not.toBe(job.id);
    expect(app.store.job(job.id)).toEqual(old);
    expect(retried.input).toMatchObject({ translationPrompt: { program: next.program } });
    expect(
      app.store.product.resolveJobPrompt(run.snapshot, retried.input).profile!.promptPresets!
        .translation!.program
    ).toEqual(next.program);
    expect(app.store.run(run.id).snapshot.profile!.promptPresets!.translation!.program).toEqual(
      first.program
    );
  });

  test('archive restores copied prompts and rejects forged frozen role or compiled prompt content atomically', async () => {
    const app = await application(),
      chat = createFixtureChat(app.store, 'Archive copies');
    const preset = await request<PromptPreset>(
      app,
      '/prompt-presets',
      prompt('main', 'Archive literal')
    );
    await apply(app, preset);
    const run = capture(app, chat.id);
    const compiled = compileSnapshotPrompt({ ...run.snapshot, contextPlan: undefined });
    app.store.db
      .prepare('UPDATE runs SET snapshot=? WHERE id=?')
      .run(JSON.stringify(compiled), run.id);
    const archive = app.store.product.export();
    const target = await application();
    expect(target.store.product.import(archive)).toMatchObject({ restored: true });
    expect(target.store.run(run.id).snapshot.profile!.promptPresets!.main!.program).toEqual(
      preset.program
    );
    expect(await workspace(target)).toEqual(await workspace(app));
    for (const forge of [
      (snapshot: any) => {
        snapshot.profile.promptPresets.main.role = 'translation';
      },
      (snapshot: any) => {
        snapshot.promptCompilation.messages[0].content[0].text = 'Forged compiled text';
      },
    ]) {
      const damaged = structuredClone(archive);
      const row = damaged.tables.runs.find((row) => row.id === run.id)!;
      const snapshot = JSON.parse(row.snapshot);
      forge(snapshot);
      row.snapshot = JSON.stringify(snapshot);
      const rejected = await application();
      expect(() => rejected.store.product.import(damaged)).toThrow();
      expect(rejected.store.chats()).toEqual([]);
    }
  });

  test('an unavailable optional translation connection does not block a main snapshot', async () => {
    const app = await application(),
      chat = createFixtureChat(app.store, 'Optional translation');
    const c = app.store.product.connection({
      title: 'Disabled translator',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:1',
      enabled: true,
    }) as Connection;
    const model = app.store.product.model({
      title: 'Optional model',
      connectionId: c.id,
      modelId: 'fixture',
      maxOutputTokens: 100,
      temperature: null,
    }) as ModelPreset;
    const profile = app.store.product.profile(chat.id);
    updateTestProfile(
      app.store.product,
      chat.id,
      profileBody(profile, { routes: { ...profile.routes, translation: { id: model.id } } })
    );
    app.store.product.connection(
      {
        title: c.title,
        protocol: c.protocol,
        endpoint: c.endpoint,
        enabled: false,
        expectedRevision: c.revision,
      },
      c.id
    );
    expect(app.store.product.snapshot(chat.id)).toHaveProperty('promptPresets.main');
  });
});

describe('translation prompt preview uses the job compiler without writes', () => {
  test.each([false, true])('default translation preview with stored source=%s', async (stored) => {
    const app = await application(),
      chat = createFixtureChat(app.store, 'Translation preview');
    const source = stored ? complete(app, capture(app, chat.id)) : undefined;
    const before = app.store.db.prepare('SELECT total_changes() AS n').get();
    const program = createDefaultPromptProgram(DEFAULT_TRANSLATION_PROMPT, 'translation');
    const preview = await request(app, `/chats/${chat.id}/prompt-preview`, {
      role: 'translation',
      program,
      request: 'Synthetic preview source.',
    });
    expect(preview.scope).toBe('preview-only-no-provider-call');
    expect(preview.error).toBeUndefined();
    expect(preview.previewSource.kind).toBe(stored ? 'stored' : 'synthetic');
    expect(preview.compilation.messages[0].content[0].text).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect(preview.compilation.messages.some((m: any) => m.id === 'context')).toBe(true);
    expect(preview.compilation.messages.some((m: any) => m.id === 'outputSchema')).toBe(false);
    const sourceText = preview.compilation.messages.find((m: any) => m.id === 'source').content[0]
      .text;
    expect(sourceText).toContain(
      stored ? 'Mira waits by the quiet harbor.' : 'Synthetic preview source.'
    );
    expect(sourceText).not.toContain('anchor');
    if (source)
      expect(preview.previewSource).toMatchObject({
        sourceRevision: source.id,
        sourceHash: source.hash,
      });
    expect(
      preview.compilation.messages.filter((m: any) => m.provenance.origin === 'current')
    ).toHaveLength(1);
    expect(
      preview.compilation.messages.filter((m: any) => m.provenance.origin === 'history')
    ).toHaveLength(0);
    program.controls = [{ id: 'tone', label: 'Tone', type: 'text', default: 'default' }];
    if (program.blocks[0].kind === 'message')
      program.blocks[0].template.push({ kind: 'value', expression: { control: 'tone' } });
    const changed = await request(app, `/chats/${chat.id}/prompt-preview`, {
      role: 'translation',
      program,
      request: 'Synthetic preview source.',
      values: { tone: 'PREVIEW OVERRIDE' },
    });
    expect(changed.compilation.messages[0].content[0].text).toContain('PREVIEW OVERRIDE');
    expect(app.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('explicit status recovery with current model', () => {
  test('freezes the new model, retains the original run and failed job, and rejects duplicate or superseded recovery', async () => {
    const app = await application();
    const store = app.store;
    const chat = createFixtureChat(store, 'Synthetic status recovery');
    store.settings(chat.id, chat.settingsRevision, { ...chat.settings, status: true });
    const run = capture(app, chat.id);
    const source = complete(app, run);
    const original = store.detail(chat.id).jobs.find((job) => job.kind === 'status')!;
    store.failQueuedJob(original.id, original.generation, 'MODEL_REQUIRED:status');
    const frozenRun = store.run(run.id);
    const frozenJob = store.job(original.id);
    const connection = store.product.connection({
      title: 'Synthetic status',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:1',
      enabled: true,
    }) as Connection;
    const model = store.product.model({
      title: 'Synthetic status',
      connectionId: connection.id,
      modelId: 'fixture-status',
      maxOutputTokens: 1024,
      temperature: null,
    }) as ModelPreset;
    const profile = store.product.profile(chat.id);
    updateTestProfile(
      store.product,
      chat.id,
      profileBody(profile, { routes: { ...profile.routes, status: { id: model.id } } })
    );
    const created = store.requestStatus(source.id, source.hash, original.id);
    expect(created.id).not.toBe(original.id);
    expect(created.input).toMatchObject({
      statusModelSelection: { id: model.id },
      statusModelSnapshot: { id: model.id },
    });
    expect(store.run(run.id)).toEqual(frozenRun);
    expect(store.job(original.id)).toEqual(frozenJob);
    expect(() => store.requestStatus(source.id, source.hash, original.id)).toThrow(/changed/);
    expect(() => store.requestStatus(source.id, source.hash, created.id)).toThrow(/active/);
    expect(() => store.retryJob(original.id)).toThrow(/replaced/);
    const claimed = store.claimJob(created.id, 'synthetic-status-owner', {
      inputs: [],
      toolEvents: [],
    })!;
    expect(claimed.input).toMatchObject({ statusModelSelection: { id: model.id } });
    store.failJob(created.id, claimed.generation, 'synthetic-status-owner', 'Synthetic failure');
    const nextProfile = store.product.profile(chat.id);
    updateTestProfile(
      store.product,
      chat.id,
      profileBody(nextProfile, { routes: { ...nextProfile.routes, status: null } })
    );
    expect(
      store.product.resolveJobPrompt(run.snapshot, store.retryJob(created.id).input).profile?.models
        .status?.id
    ).toBe(model.id);
    store.cancelJob(created.id);
    const archived = store.product.export();
    const restored = await application();
    restored.store.product.import(archived);
    const restoredInput = restored.store.job(created.id).input;
    expect(restoredInput).toMatchObject({
      statusModelSnapshot: { id: model.id, connection: { enabled: false } },
    });
    const malformed = structuredClone(archived);
    const row = malformed.tables.jobs.find((row) => row.id === created.id)!;
    const invalidInput = JSON.parse(row.input);
    delete invalidInput.statusModelSelection;
    row.input = JSON.stringify(invalidInput);
    const rejected = await application();
    expect(() => rejected.store.product.import(malformed)).toThrow(/requires selection/);
  });

  test('rolls back validation failures and rejects changed source or active older workers', async () => {
    const app = await application();
    const store = app.store;
    const chat = createFixtureChat(store, 'Synthetic status safety');
    store.settings(chat.id, chat.settingsRevision, { ...chat.settings, status: true });
    const run = capture(app, chat.id);
    const source = complete(app, run);
    const original = store.detail(chat.id).jobs.find((job) => job.kind === 'status')!;
    store.failQueuedJob(original.id, original.generation, 'MODEL_REQUIRED:status');
    const before = store.detail(chat.id).jobs;
    expect(() =>
      store.requestStatus(source.id, source.hash, original.id, () => {
        throw new Error('MODEL_REQUIRED:status');
      })
    ).toThrow('MODEL_REQUIRED:status');
    expect(store.detail(chat.id).jobs).toEqual(before);
    await request(
      app,
      `/sources/${source.id}/status`,
      { expectedSourceHash: '0'.repeat(64), expectedJobId: original.id },
      409
    );
    expect(store.detail(chat.id).jobs).toEqual(before);
    const created = store.requestStatus(source.id, source.hash, original.id);
    const claimed = store.claimJob(created.id, 'old-worker', {})!;
    store.cancelJob(created.id);
    const edited = store.editSource(source.id, { text: 'A changed source.', expectedRevision: 0 });
    expect(() => store.requestStatus(source.id, source.hash, created.id)).toThrow(/changed/);
    const replacement = store.requestStatus(source.id, edited.hash, created.id);
    expect(replacement.sourceHash).toBe(edited.hash);
    expect(store.completeJob(created.id, claimed.generation, 'old-worker', {})).toBe(false);
    store.cancelJob(replacement.id);
    store.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(original.id);
    expect(() => store.requestStatus(source.id, edited.hash, replacement.id)).toThrow(/active/);
  });
});
