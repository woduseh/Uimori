import { afterEach, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { productRoutes } from '../server/product-routes.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { createPanelPackage } from './fixtures/panel-package.js';
import { validateContentPackage } from '../core/content-package.js';
import { renderPackagePanels } from '../core/package-panels.js';
import { renderPromptTemplate } from '../core/prompt-program.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { compiledPackages } from '../core/package-context.js';
import { defaultProfile, type Content, type ProfileSnapshot } from '../core/product.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';

const owned: { store: Store; app: FastifyInstance; dir: string }[] = [];
afterEach(async () => {
  for (const { store, app, dir } of owned.splice(0)) {
    await app.close();
    store.close();
    const within = relative(resolve(tmpdir()), resolve(dir));
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('uimori-panels-'))
      throw Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-panels-'));
  const store = new Store(join(dir, 'test.sqlite'));
  const app = Fastify();
  owned.push({ store, app, dir });
  productRoutes(app, store, { approvedOrigins: [], publish: () => {} });
  return { store, app };
}
function seed() {
  const f = fixture(),
    pkg = createPanelPackage();
  const content = f.store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: '',
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(f.store, 'Synthetic panel', 'calm', { botId: content.id });
  const endpoint = `/api/chats/${chat.id}/package-behaviors`;
  return { ...f, content, chat, endpoint };
}
const identity = { bot: { name: 'Ari' }, user: { name: 'User' } };

test('panel schema rejects undeclared actions, slots and unrelated runtime reads', () => {
  const pkg = createPanelPackage();
  for (const part of [
    { actions: ['missing'] },
    { actions: ['choose', 'choose'] },
    { template: [{ kind: 'slot', name: 'history' }] },
    { template: [{ kind: 'value', expression: { context: [] } }] },
    { template: [{ kind: 'value', expression: { context: ['history'] } }] },
    { template: [{ kind: 'value', expression: { context: ['user', 'description'] } }] },
  ])
    expect(() =>
      validateContentPackage({ ...pkg, panels: [{ ...pkg.panels![0], ...part }] })
    ).toThrow();
  pkg.behavior!.actions[0].triggers = ['model'];
  expect(() => validateContentPackage(pkg)).toThrow('PACKAGE_PANEL_ACTION_NOT_ALLOWED');
});

test('panel values and nested loop values are escaped without changing ordinary prompt text', () => {
  const pkg = createPanelPackage();
  const text = '</textarea><button data-uimori-action="again">Injected & \'"</button>';
  const state = {
    route: 'unselected',
    note: text,
    ledger: [{ name: '<script>bad()</script>', amount: 3 }],
  };
  const before = structuredClone(state);
  const panel = renderPackagePanels(pkg, { state, identity })[0];
  expect(panel.html).toContain('&lt;/textarea&gt;');
  expect(panel.html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
  expect(panel.html).not.toContain('<button data-uimori-action="again">Injected');
  expect(state).toEqual(before);
  expect(renderPromptTemplate([{ kind: 'value', expression: text }])).toBe(text);
});

test('panels read frozen shared variables with escaping, empty overrides and authored fallbacks', () => {
  const pkg = createPanelPackage();
  pkg.variableDefaults = {
    values: { '한 글': 'authored fallback', blank: 'blank fallback', dropped: 'restored default' },
  };
  pkg.panels = [
    {
      id: 'shared',
      title: 'Shared variables',
      template: [
        { kind: 'value', expression: { context: ['variables', '한 글'] } },
        { kind: 'text', text: '|' },
        { kind: 'value', expression: { context: ['variables', 'blank'] } },
        { kind: 'text', text: '|' },
        { kind: 'value', expression: { context: ['variables', 'dropped'] } },
      ],
    },
  ];
  expect(() => validateContentPackage(pkg)).not.toThrow();
  const profile: ProfileSnapshot = {
    ...defaultProfile('synthetic'),
    contents: [],
    models: {},
    packages: [pkg],
    packageAttachments: [{ id: pkg.id, revision: pkg.revision, role: 'bot' }],
    variableState: {
      revision: 3,
      values: { '한 글': '<script>😀 & {{literal}}</script>', blank: '' },
    },
  };
  const before = structuredClone(profile);
  const frozenIdentity = packageIdentityFromProfile(profile);
  const state = pkg.behavior!.initialState;
  const rendered = renderPackagePanels(pkg, { state, identity: frozenIdentity });
  expect(rendered[0].issue).toBeUndefined();
  expect(rendered[0].html).toBe(
    '&lt;script&gt;😀 &amp; {{literal}}&lt;/script&gt;||restored default'
  );
  expect(profile).toEqual(before);
  profile.variableState = { revision: 4, values: {} };
  expect(renderPackagePanels(pkg, { state, identity: frozenIdentity })).toEqual(rendered);
  expect(
    renderPackagePanels(pkg, { state, identity: packageIdentityFromProfile(profile) })[0].html
  ).toBe('authored fallback|blank fallback|restored default');
});

test('a failing optional panel is reported while another view and standard actions remain available', () => {
  const pkg = createPanelPackage();
  pkg.panels!.unshift({
    id: 'broken',
    title: 'Broken',
    template: [{ kind: 'value', expression: { op: 'divide', args: [1, 0] } }],
  });
  const panels = renderPackagePanels(pkg, { state: pkg.behavior!.initialState, identity });
  expect(panels[0]).toMatchObject({ issue: 'PACKAGE_PANEL_RENDER_FAILED', html: '', actions: [] });
  expect(panels[1].html).toContain('보급 기록');
  expect(pkg.behavior!.actions).toHaveLength(3);
});

test('variable overflow disables only panels that read variables and preserves ordinary state panels', () => {
  const pkg = createPanelPackage();
  pkg.panels!.unshift({
    id: 'shared',
    title: 'Shared',
    template: [{ kind: 'value', expression: { context: ['variables', 'score'] } }],
  });
  const panels = renderPackagePanels(pkg, {
    state: pkg.behavior!.initialState,
    identity: { ...identity, variableDefaultsError: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT' },
  });
  expect(panels[0]).toMatchObject({ issue: 'PACKAGE_PANEL_RENDER_FAILED', html: '', actions: [] });
  expect(panels[1].issue).toBeUndefined();
  expect(panels[1].html).toContain('경로 선택');
  expect(pkg.behavior!.actions).toHaveLength(3);
});

test('read-only panel projection, scoped state actions, replay and subsequent instructions use one state', async () => {
  const f = seed();
  const before = f.store.db.prepare('SELECT count(*) AS n FROM package_behavior_states').get();
  const first = behaviorDetail(f.store, f.chat.id),
    instance = first.instances[0];
  expect(instance.panels![0].html).toContain('경로 선택');
  expect(f.store.db.prepare('SELECT count(*) AS n FROM package_behavior_states').get()).toEqual(
    before
  );
  const command = {
    actionId: 'choose',
    input: { route: 'harbor' },
    panelId: 'journey',
    expectedPackageRevision: instance.packageRevision,
    expectedStateRevision: instance.stateRevision,
    expectedSourceHash: first.sourceHash,
    idempotencyKey: 'one-choice',
  };
  const send = (payload: unknown) =>
    injectWithFixtureBot(f.app, {
      method: 'POST',
      url: `${f.endpoint}/${encodeURIComponent(instance.instanceId)}/actions`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  expect((await send({ ...command, panelId: 'missing' })).statusCode).toBe(403);
  expect(
    (await send({ ...command, expectedPackageRevision: instance.packageRevision + 1 })).statusCode
  ).toBe(409);
  const chosen = await send(command);
  expect(chosen.statusCode, chosen.body).toBe(200);
  expect(chosen.json().instances[0].panels[0].html).toContain('id="route">harbor');
  // The host clock changes between HTTP commands. Replay still returns the single recorded action.
  const replay = await send(command);
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().instances[0].stateRevision).toBe(chosen.json().instances[0].stateRevision);
  expect((await send({ ...command, input: { route: 'ridge' } })).statusCode).toBe(409);
  expect(
    f.store.behavior.journal({
      chatId: f.chat.id,
      branchId: `main:${f.chat.id}`,
      attachmentInstanceId: instance.instanceId,
      packageId: f.content.id,
      packageRevision: f.content.revision,
      behaviorRevision: 1,
      schemaVersion: 1,
    })
  ).toHaveLength(1);
  const profile = f.store.product.snapshot(f.chat.id);
  const run = f.store.createRun(
    f.chat.id,
    {
      request: 'Continue',
      expectedRevision: null,
      expectedSettingsRevision: f.chat.settingsRevision,
      idempotencyKey: 'panel-run',
    },
    (chat) => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Continue',
      history: [],
      profile,
      resources: f.store.product.resources(chat.id, profile),
    })
  ).run;
  expect(
    compiledPackages(run.snapshot, 'main')
      .flatMap((item) => item.instructions)
      .map((item) => item.text)
      .join('\n')
  ).toContain('Selected route: harbor');
  f.store.startRun(run.id);
  const original =
    'The expedition departs.\n<LEDGER>{"items":[{"name":"rope","amount":4}]}</LEDGER>';
  const source = f.store.completeRun(
    run.id,
    original,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const after = behaviorDetail(f.store, f.chat.id).instances[0];
  expect(after.panels![0].html).toContain('<span>rope</span><strong>4</strong>');
  expect(f.store.source(source.id).text).toBe(original);
  expect(run.snapshot.profile!.packages![0].panels).toEqual(f.content.package!.panels);
  const restored = fixture().store;
  restored.product.import(f.store.product.export());
  expect(behaviorDetail(restored, f.chat.id).instances[0].panels).toEqual(after.panels);
});
