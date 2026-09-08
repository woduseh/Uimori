import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { ProductStore } from '../server/product-store.js';
import { buildMainInput } from '../core/provider.js';
import type { ChatProfile, Connection, Content, ModelPreset } from '../core/product.js';
import type { Chat, ChatDetail, Job, Run, RunSnapshot, Usage } from '../core/types.js';
import { runMain } from '../server/model-runner.js';
import type { ProviderResult } from '../core/transport.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { createApp } from '../server/app.js';

const owned: { directory: string; store?: Store; close?: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.close?.();
    item.store?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('서사 M1 product ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), '서사 M1 product '));
  const item = { directory: path } as (typeof owned)[number];
  owned.push(item);
  return item;
}
async function database() {
  const item = await directory();
  const store = new Store(join(item.directory, 'story.sqlite'));
  item.store = store;
  const product = new ProductStore(store);
  return { item, store, product };
}
const reference = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
const contentBody = (
  kind: Content['kind'],
  text: string,
  loading: Content['loading'] = 'pinned'
) => ({
  kind,
  title: `${kind} fixture`,
  description: `synthetic ${kind}`,
  text,
  loading,
  relatedIds: [],
});
const noUsage: Usage = { modelCalls: 1, inputTokens: null, outputTokens: null, costUsd: null };
function profile(
  product: ProductStore,
  chat: Chat,
  attachments: { id: string; revision: number }[] = [],
  changes: Partial<ChatProfile> = {}
) {
  const prior = product.profile(chat.id);
  return product.updateProfile(chat.id, {
    expectedRevision: prior.revision,
    attachments,
    personaReference: prior.personaReference,
    routes: prior.routes,
    image: prior.image,
    ...changes,
  });
}
function queuedRun(
  store: Store,
  product: ProductStore,
  chatId: string,
  request = 'Synthetic scene',
  options: {
    branchId?: string;
    expectedRevision?: string | null;
    expectedProfileRevision?: number;
    idempotencyKey?: string;
  } = {}
) {
  const chat = store.chat(chatId);
  const captured = product.snapshot(chatId);
  const head = product.branch(chatId, options.branchId).headRevision;
  return store.createRun(
    chatId,
    {
      request,
      expectedRevision: head,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
      ...options,
    },
    (current) =>
      ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request,
        history: store.history(current.headRevision),
        resources: product.resources(chatId, captured),
        ...(captured ? { profile: captured } : {}),
      }) satisfies RunSnapshot
  ).run;
}
function completedSource(
  store: Store,
  product: ProductStore,
  chatId: string,
  text = 'A synthetic keeper watched the evening tide.'
) {
  const run = queuedRun(store, product, chatId);
  store.startRun(run.id);
  return store.completeRun(run.id, text, noUsage, run.snapshot.settings);
}
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const assetBody = {
  title: 'Synthetic pixel',
  mime: 'image/png',
  base64: pixel,
  description: 'A one pixel synthetic fixture',
  actor: '',
  outfit: '',
  location: '',
  allowedUse: 'both',
};

describe('M1 product data with actual file SQLite', () => {
  test('P01 P02 P03 freezes exact content/profile revisions and the explicit persona scope', async () => {
    const { store, product } = await database();
    const bot = product.content(
      fixtureBotInput('Attached story owner', 'Ada is the keeper.')
    ) as Content;
    const chat = createFixtureChat(store, 'attached-story', 'calm', { botId: bot.id });
    const canon = product.content(
      contentBody('module', 'The harbor has never had electricity.')
    ) as Content;
    const lore = product.content(
      contentBody('module', 'UNREAD_LORE_V1', 'discoverable')
    ) as Content;
    const persona = product.content(contentBody('persona', 'EXCLUDED_READER_PERSONA')) as Content;
    const first = profile(product, chat, [canon, lore, persona].map(reference));
    const applied = profile(product, chat, first.attachments, { personaReference: false });
    expect(applied.personaReference).toBe(false);
    expect(applied.attachments).toEqual(first.attachments);
    expect(applied.routes).toEqual(first.routes);
    const run = queuedRun(store, product, chat.id);
    const oldSnapshot = structuredClone(run.snapshot);
    const edited = product.content(
      {
        ...contentBody('module', 'EDITED_LORE_V2', 'discoverable'),
        expectedRevision: lore.revision,
      },
      lore.id
    ) as Content;
    expect(edited.revision).toBe(2);
    profile(product, chat, [canon, edited, persona].map(reference), {
      personaReference: true,
    });
    expect(store.run(run.id).snapshot).toEqual(oldSnapshot);
    expect(store.run(run.id).snapshot.resources.find((item) => item.id === lore.id)?.text).toBe(
      'UNREAD_LORE_V1'
    );
    expect(product.get<Content>('content', lore.id, 1).text).toBe('UNREAD_LORE_V1');
    expect(product.snapshot(chat.id)?.contents.find((item) => item.id === lore.id)?.text).toBe(
      'EDITED_LORE_V2'
    );
    const input = buildMainInput(oldSnapshot);
    expect(input.facts).toContain(canon.text);
    expect(input.pinnedSources?.find((item) => item.id === canon.id)).toMatchObject({
      id: canon.id,
      revision: 1,
      hash: createHash('sha256').update(canon.text).digest('hex'),
    });
    expect(input.history).toEqual([]);
    expect(input.catalog.find((item) => item.id === lore.id)).not.toHaveProperty('text');
    expect(JSON.stringify(input)).not.toContain('UNREAD_LORE_V1');
    expect(input).not.toHaveProperty('controls');
    expect(JSON.stringify(input)).not.toContain('EXCLUDED_READER_PERSONA');
    expect(product.profile(chat.id).personaReference).toBe(true);
    expect(oldSnapshot.profile!.personaReference).toBe(false);
    expect(() =>
      product.content({ ...contentBody('module', 'STALE_WRITE'), expectedRevision: 1 }, lore.id)
    ).toThrow('Revision conflict');
    expect(() =>
      product.updateProfile(chat.id, {
        expectedRevision: first.revision,
        attachments: applied.attachments,
        personaReference: false,
        routes: applied.routes,
        image: applied.image,
      })
    ).toThrow('Profile revision conflict');
  });

  test('P04 keeps manual model IDs and credential references separate from content and transport options', async () => {
    const { store, product } = await database();
    const chat = createFixtureChat(store, 'connection-story');
    const bound = product.connection({
      title: 'Local fixture',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:49999/turn',
      credentialEnv: 'NARRATIVE_PROVIDER_SYNTHETIC',
      enabled: true,
    }) as Connection;
    const model = product.model({
      title: 'Manual unknown model',
      connectionId: bound.id,
      modelId: 'user-entered-unknown-model',
      maxOutputTokens: 4096,
      temperature: null,
    }) as ModelPreset;
    profile(product, chat, [], {
      routes: { main: { id: model.id }, translation: null, status: null, image: null },
    });
    const snapshot = product.snapshot(chat.id)!;
    expect(snapshot.models.main?.modelId).toBe('user-entered-unknown-model');
    expect(snapshot.models.main?.connection.credentialEnv).toBe('NARRATIVE_PROVIDER_SYNTHETIC');
    expect(bound.catalog).toEqual([]);
    expect(() =>
      product.connection({
        title: 'injected',
        protocol: 'fixture-sse-v1',
        endpoint: bound.endpoint,
        enabled: true,
        headers: { authorization: 'forged' },
      })
    ).toThrow('Unknown request field');
    expect(() =>
      product.model({
        title: 'injected',
        connectionId: bound.id,
        modelId: 'unknown',
        maxOutputTokens: 100,
        temperature: null,
        body: { tools: ['shell.execute'] },
      })
    ).toThrow('Unknown request field');
    const disabled = product.connection(
      {
        title: bound.title,
        protocol: bound.protocol,
        endpoint: bound.endpoint,
        credentialEnv: bound.credentialEnv,
        enabled: false,
        expectedRevision: bound.revision,
      },
      bound.id
    ) as Connection;
    expect(disabled.revision).toBe(2);
    expect(snapshot.models.main?.connection.enabled).toBe(true);
    expect(() => product.authorize(snapshot.models.main!.connection)).toThrow();
    expect(product.get<Connection>('connection', bound.id)).toEqual(disabled);
    expect(() => product.get<Connection>('connection', bound.id, 1)).toThrow('Setting not found');
    expect(snapshot.models.main?.connection).toEqual(bound);
  });

  test('P09 preserves sibling candidates from the exact original snapshot and each descendant ancestry with branch CAS', async () => {
    const { store, product } = await database();
    const chat = createFixtureChat(store, 'candidate-story');
    const canon = product.content(contentBody('module', 'Original canon revision.')) as Content;
    profile(product, chat, [reference(canon)]);
    const base = completedSource(store, product, chat.id, 'BASE_SCENE');
    const original = queuedRun(store, product, chat.id, 'Same candidate request');
    store.startRun(original.id);
    const a = store.completeRun(original.id, 'CANDIDATE_A', noUsage, original.snapshot.settings);
    const changedCanon = product.content(
      { ...contentBody('module', 'Later canon revision.'), expectedRevision: 1 },
      canon.id
    ) as Content;
    profile(product, chat, [reference(changedCanon)], { personaReference: false });
    store.settings(chat.id, store.chat(chat.id).settingsRevision, {
      ...store.chat(chat.id).settings,
      preset: 'vivid',
    });
    const key = randomUUID();
    const candidate = store.candidate(original.id, key, 'Sibling B');
    const {
      branchId: _oldBranch,
      candidateOf: _oldCandidate,
      ...originalFrozen
    } = original.snapshot;
    const { branchId: candidateBranch, candidateOf, ...candidateFrozen } = candidate.run.snapshot;
    expect(candidateFrozen).toEqual(originalFrozen);
    expect(candidate.run.parentRevision).toBe(base.id);
    expect(candidateOf).toBe(original.id);
    expect(candidate.run.snapshot.profile?.contents[0].text).toBe('Original canon revision.');
    expect(candidate.run.snapshot.settings.preset).toBe('calm');
    expect(store.candidate(original.id, key, 'Sibling B')).toMatchObject({
      created: false,
      run: { id: candidate.run.id },
    });
    expect(() => store.candidate(original.id, key, 'Different title')).toThrow(
      'Idempotency key reused'
    );
    store.startRun(candidate.run.id);
    const b = store.completeRun(
      candidate.run.id,
      'CANDIDATE_B',
      noUsage,
      candidate.run.snapshot.settings
    );
    expect(store.chat(chat.id).headRevision).toBe(a.id);
    expect(product.branch(chat.id, candidateBranch).headRevision).toBe(b.id);
    const aDescendant = completedSource(store, product, chat.id, 'A_DESCENDANT');
    const bRun = queuedRun(store, product, chat.id, 'Continue B', { branchId: candidateBranch });
    expect(bRun.snapshot.history.map((item) => item.text)).toEqual(['BASE_SCENE', 'CANDIDATE_B']);
    store.startRun(bRun.id);
    const bDescendant = store.completeRun(bRun.id, 'B_DESCENDANT', noUsage, bRun.snapshot.settings);
    expect(store.history(aDescendant.id).map((item) => item.text)).toEqual([
      'BASE_SCENE',
      'CANDIDATE_A',
      'A_DESCENDANT',
    ]);
    expect(store.history(bDescendant.id).map((item) => item.text)).toEqual([
      'BASE_SCENE',
      'CANDIDATE_B',
      'B_DESCENDANT',
    ]);
    expect(() =>
      queuedRun(store, product, chat.id, 'Stale B', {
        branchId: candidateBranch,
        expectedRevision: b.id,
      })
    ).toThrow('Source revision conflict');
    expect(() =>
      queuedRun(store, product, chat.id, 'Stale profile', { expectedProfileRevision: 1 })
    ).toThrow('Profile revision conflict');
    const other = createFixtureChat(store, 'other-candidate-story');
    expect(() =>
      product.createBranch(other.id, { title: 'Cannot cross chat', fromRevision: a.id })
    ).toThrow('Source outside chat');
    expect(store.detail(chat.id).sources).toHaveLength(5);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('P05 P06 P12 records fixture refusals and partials without source/jobs; duplicate attempt finishes cannot rewrite usage', async () => {
    const { item, store, product } = await database();
    let calls = 0;
    const server = await loopbackProvider(async (_captured, response) => {
      calls++;
      await writeSse(
        response,
        calls === 1
          ? [
              { type: 'refusal', message: 'Explicit fixture refusal' },
              {
                type: 'usage',
                inputTokens: 13,
                outputTokens: 2,
                costUsd: null,
                raw: { total_tokens: 15 },
              },
              { type: 'done', reason: 'refusal' },
            ]
          : [
              { type: 'text_delta', delta: 'Unfinished fixture fragment' },
              { type: 'usage', inputTokens: 7, outputTokens: 1, costUsd: null },
            ]
      );
    });
    item.close = server.close;
    const chat = createFixtureChat(store, 'refusal-story');
    const preserved = completedSource(store, product, chat.id, 'PRESERVED_ORIGINAL');
    const originalJobCount = store.detail(chat.id).jobs.length;
    const bound = product.connection({
      title: 'Actual loopback fixture',
      protocol: 'fixture-sse-v1',
      endpoint: server.endpoint,
      enabled: true,
    }) as Connection;
    const model = product.model({
      title: 'Main fixture target',
      connectionId: bound.id,
      modelId: 'fixture-main',
      maxOutputTokens: 4000,
      temperature: null,
    }) as ModelPreset;
    profile(product, chat, [], {
      routes: { main: { id: model.id }, translation: null, status: null, image: null },
    });
    for (const expected of ['refused', 'partial'] as const) {
      const run = queuedRun(store, product, chat.id);
      store.startRun(run.id);
      const result = await runMain(run.snapshot, {
        signal: new AbortController().signal,
        approvedOrigins: [server.origin],
        authorize: (value) => product.authorize(value),
        onInput: (input) => store.input(run.id, input),
        onToolEvent: (tool) => store.tool(run.id, tool),
        onAttemptStart: (wire) => product.startAttempt(chat.id, run.id, null, wire),
        onAttemptFinish: (id, value) => product.finishAttempt(id, value),
      });
      expect(result.status).toBe(expected);
      store.finishRun(run.id, expected, result.error ?? '', result.text, result.usage);
      expect(store.run(run.id)).toMatchObject({
        status: expected,
        sourceRevision: null,
        usage: { costUsd: null },
      });
    }
    expect(store.detail(chat.id).sources).toHaveLength(1);
    expect(store.source(preserved.id).text).toBe('PRESERVED_ORIGINAL');
    expect(store.chat(chat.id).headRevision).toBe(preserved.id);
    expect(store.detail(chat.id).jobs).toHaveLength(originalJobCount);
    const attempts = product.attempts(chat.id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['refused', 'partial']);
    expect(attempts.map((attempt) => attempt.inputTokens)).toEqual([13, 7]);
    const firstResult = attempts[0].response as ProviderResult;
    product.finishAttempt(attempts[0].id, {
      ...firstResult,
      status: 'completed',
      usage: { ...firstResult.usage, inputTokens: 999, costUsd: 0 },
    });
    expect(product.attempts(chat.id)[0]).toEqual(attempts[0]);
    expect(server.requests).toHaveLength(2);
    expect(product.attempts(chat.id).every((attempt) => attempt.costUsd === null)).toBe(true);
  });

  test('P11 exports/restores source bytes, lineage and assets while disabling connections and unfinished work', async () => {
    const { store, product } = await database();
    const chat = createFixtureChat(store, 'archive-story');
    const canon = product.content(
      contentBody('module', 'A portable author declaration.')
    ) as Content;
    const bound = product.connection({
      title: 'Fixture',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:49999/turn',
      credentialEnv: 'NARRATIVE_PROVIDER_ARCHIVE_FIXTURE',
      enabled: true,
    }) as Connection;
    profile(product, chat, [reference(canon)]);
    const first = completedSource(
      store,
      product,
      chat.id,
      'First original paragraph.\n\nSecond original paragraph.'
    );
    const second = completedSource(
      store,
      product,
      chat.id,
      'A descendant keeps the earlier scene.'
    );
    store.requestTranslation(first.id);
    const asset = product.createAsset(chat.id, assetBody);
    const archive = product.export();
    const original = structuredClone(archive);
    const target = await database();
    expect(target.product.import(archive)).toEqual({ restored: true, chats: 1 });
    expect(archive).toEqual(original);
    expect(target.store.source(first.id)).toEqual(store.source(first.id));
    expect(target.store.history(second.id)).toEqual(store.history(second.id));
    expect(target.product.asset(asset.id).bytes).toEqual(Buffer.from(pixel, 'base64'));
    expect(target.product.asset(asset.id).asset.hash).toBe(asset.hash);
    expect(target.product.snapshot(chat.id)?.contents).toEqual(product.snapshot(chat.id)?.contents);
    expect(target.product.get<Connection>('connection', bound.id)).toMatchObject({
      enabled: false,
    });
    expect(target.product.get<Connection>('connection', bound.id)).not.toHaveProperty(
      'credentialEnv'
    );
    expect(target.store.queuedJobs()).toEqual([]);
    expect(target.store.detail(chat.id).jobs.every((job) => job.status === 'interrupted')).toBe(
      true
    );
    expect(target.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => target.product.import(original)).toThrow('Restore requires an empty database');
  });

  test('P11 rejects changed source/asset bytes and invalid ancestry atomically in an empty restore target', async () => {
    const { store, product } = await database();
    const chat = createFixtureChat(store, 'integrity-story');
    const source = completedSource(store, product, chat.id);
    store.requestTranslation(source.id);
    const asset = product.createAsset(chat.id, assetBody);
    const archive = product.export();
    const mutations: { name: string; mutate: (value: typeof archive) => void }[] = [
      {
        name: 'source hash',
        mutate: (value) => {
          value.tables.sources[0].text = 'Changed bytes';
        },
      },
      {
        name: 'asset hash',
        mutate: (value) => {
          value.tables.assets[0].bytes = Buffer.from('corrupt bytes').toString('base64');
        },
      },
      {
        name: 'source cycle',
        mutate: (value) => {
          value.tables.sources[0].parent_revision = source.id;
        },
      },
      {
        name: 'missing attachment revision',
        mutate: (value) => {
          value.tables.profiles.push({
            chat_id: chat.id,
            body: JSON.stringify({
              ...product.profile(chat.id),
              attachments: [{ id: 'missing', revision: 1 }],
            }),
          });
        },
      },
    ];
    for (const mutation of mutations) {
      const target = await database();
      const invalid = structuredClone(archive);
      mutation.mutate(invalid);
      expect(() => target.product.import(invalid), mutation.name).toThrow();
      expect(target.store.chats(), mutation.name).toEqual([]);
      expect(target.store.db.prepare('SELECT count(*) AS count FROM sources').get()).toEqual({
        count: 0,
      });
      expect(target.product.assets()).toEqual([]);
      expect(target.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    }
    expect(product.asset(asset.id).asset.hash).toBe(asset.hash);
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])(
    'P11 rejects unsupported schema %i without automatic migration or backup',
    async (version) => {
      const item = await directory();
      const path = join(item.directory, 'legacy.sqlite');
      schema1Fixture(path);
      const old = new DatabaseSync(path);
      old.exec(`PRAGMA user_version=${version};`);
      old.close();
      expect(() => new Store(path)).toThrow(`Unsupported database schema version ${version}`);
      expect(() => new Store(path)).toThrow('npm run reset:dev');
      expect((await readdir(item.directory)).filter((name) => name.includes('.pre-'))).toEqual([]);
      const backup = new DatabaseSync(path, { readOnly: true });
      try {
        expect(backup.prepare('PRAGMA user_version').get()).toEqual({ user_version: version });
        expect(backup.prepare('SELECT text FROM sources WHERE id=?').get('old-source')).toEqual({
          text: 'Legacy original preserved.',
        });
        expect(
          backup.prepare('SELECT result FROM job_results WHERE job_id=?').get('old-job')
        ).toEqual({ result: JSON.stringify({ mock: true, text: '기존 모의 번역' }) });
        expect(backup.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        backup.close();
      }
    }
  );

  test('P11 reopens actual backup bytes as standalone SQLite while the source database remains owned', async () => {
    const { item, store, product } = await database();
    const chat = createFixtureChat(store, 'live-backup-fixture');
    const source = completedSource(
      store,
      product,
      chat.id,
      'WAL-backed source committed before the backup.'
    );
    const asset = product.createAsset(chat.id, assetBody);
    const bytes = product.backup();
    const path = join(item.directory, 'downloaded-backup.sqlite');
    await writeFile(path, bytes);
    const reopened = new DatabaseSync(path, { readOnly: true });
    try {
      expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 });
      expect(
        reopened.prepare('SELECT id,text,hash FROM sources WHERE id=?').get(source.id)
      ).toEqual({ id: source.id, text: source.text, hash: source.hash });
      expect(reopened.prepare('SELECT source_revision FROM jobs ORDER BY id').all()).toEqual(
        store.db.prepare('SELECT source_revision FROM jobs ORDER BY id').all()
      );
      expect(
        Buffer.from(
          (
            reopened.prepare('SELECT bytes FROM assets WHERE id=?').get(asset.id) as {
              bytes: Uint8Array;
            }
          ).bytes
        )
      ).toEqual(Buffer.from(pixel, 'base64'));
      expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      reopened.close();
    }
    expect(store.source(source.id).hash).toBe(source.hash);
    expect((await readdir(item.directory)).some((name) => name.includes('.backup-'))).toBe(false);
  });
});

async function application(options: { approvedOrigins?: string[]; accessToken?: string } = {}) {
  const item = await directory();
  const app = await createApp({
    dbPath: join(item.directory, 'http.sqlite'),
    buildId: 'm1-product-tests',
    instanceId: randomUUID(),
    testMode: true,
    ...options,
  });
  item.close = () => app.close();
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { item, app, url };
}
async function api<T = unknown>(
  url: string,
  path: string,
  body?: unknown,
  options: { method?: string; status?: number; cookie?: string; origin?: string } = {}
): Promise<T> {
  if (
    path === '/api/chats' &&
    (options.method ?? 'POST') === 'POST' &&
    (options.status ?? 200) === 200 &&
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    !Object.hasOwn(body, 'botId')
  ) {
    const owner = await api<{ id: string }>(url, '/api/content', fixtureBotInput(), options);
    body = { ...body, botId: owner.id };
  }
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(options.status ?? 200);
  return value as T;
}
async function terminal(url: string, id: string): Promise<Run> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = await api<Run>(url, `/api/runs/${id}`);
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${id} did not become terminal`);
}
async function terminalJob(url: string, chatId: string, id: string): Promise<Job> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const detail = await api<ChatDetail>(url, `/api/chats/${chatId}`);
    const job = detail.jobs.find((value) => value.id === id);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${id} did not become terminal`);
}

describe('M1 real HTTP application boundaries', () => {
  test('P07 P08 P12 explicit retry translates the whole scene with the current model and retains source-time references', async () => {
    const fixtureItem = await directory();
    const chunkRequests = new Map<string, number>();
    let expectedTranslationModel = 'fixture-translator';
    let glossaryId = '';
    const originalText = ['First', 'Middle', 'Last']
      .map(
        (label) =>
          `${label} block carries \`KEEP_LITERAL\`. ${'The wind moves along the quiet pier. '.repeat(55)}`
      )
      .join('\n\n');
    const provider = await loopbackProvider(async (captured, response) => {
      const body = JSON.parse(captured.body);
      if (body.role === 'main') {
        await writeSse(response, [
          { type: 'text_delta', delta: originalText },
          { type: 'usage', inputTokens: 5, outputTokens: 9 },
          { type: 'done', reason: 'stop' },
        ]);
        return;
      }
      expect(body.role).toBe('translation');
      expect(body.modelId).toBe(expectedTranslationModel);
      const source = body.input.source;
      expect(source.context.references).toMatchObject([
        { id: glossaryId, revision: 1, text: 'SOURCE_TIME_GLOSSARY_OLD' },
      ]);
      expect(JSON.stringify(body)).not.toContain('FUTURE_GLOSSARY_NEW');
      const count = (chunkRequests.get(source.chunkId) ?? 0) + 1;
      chunkRequests.set(source.chunkId, count);
      if (source.chunkId.endsWith('-0') && body.input.results.length === 0) {
        await writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: 'translation-read-glossary',
            name: 'knowledge.read',
            argumentsDelta: JSON.stringify({ id: glossaryId }),
          },
          { type: 'usage', inputTokens: 3, outputTokens: 1 },
          { type: 'done', reason: 'tool_calls' },
        ]);
        return;
      }
      if (source.chunkId.endsWith('-0'))
        expect(body.input.results[0]).toMatchObject({
          callId: 'translation-read-glossary',
          denied: false,
          result: { text: 'SOURCE_TIME_GLOSSARY_OLD', source: { revision: 1 } },
        });
      if (source.chunkId.endsWith('-1') && count === 1) {
        await writeSse(response, [
          { type: 'error', message: 'One intentional technical fixture failure' },
        ]);
        return;
      }
      const output = {
        sourceRevision: source.sourceRevision,
        sourceHash: source.sourceHash,
        chunkId: source.chunkId,
        segments: source.blocks.map((block: { anchor: string; text: string }) => ({
          anchors: [block.anchor],
          text: `[모의 번역 결과 ${body.modelId}] ${block.text}`,
        })),
      };
      await writeSse(response, [
        { type: 'text_delta', delta: JSON.stringify(output) },
        { type: 'usage', inputTokens: 4, outputTokens: 2 },
        { type: 'done', reason: 'stop' },
      ]);
    });
    fixtureItem.close = provider.close;
    const { app, url } = await application({ approvedOrigins: [provider.origin] });
    const created = await api<Chat>(url, '/api/chats', { title: 'Translation HTTP fixture' });
    const chat = await api<Chat>(
      url,
      `/api/chats/${created.id}/settings`,
      {
        expectedSettingsRevision: created.settingsRevision,
        ...created.settings,
        status: false,
        maxCalls: 8,
      },
      { method: 'PATCH' }
    );
    const glossary = app.store.product.content(
      contentBody('module', 'SOURCE_TIME_GLOSSARY_OLD')
    ) as Content;
    glossaryId = glossary.id;
    const bound = app.store.product.connection({
      title: 'Role routes fixture',
      protocol: 'fixture-sse-v1',
      endpoint: provider.endpoint,
      enabled: true,
    }) as Connection;
    const main = app.store.product.model({
      title: 'Main',
      connectionId: bound.id,
      modelId: 'fixture-main',
      maxOutputTokens: 6000,
      temperature: null,
    }) as ModelPreset;
    const translation = app.store.product.model({
      title: 'Translator',
      connectionId: bound.id,
      modelId: 'fixture-translator',
      maxOutputTokens: 6000,
      temperature: null,
    }) as ModelPreset;
    const configured = profile(app.store.product, chat, [reference(glossary)], {
      routes: {
        main: { id: main.id },
        translation: { id: translation.id },
        status: null,
        image: null,
      },
    });
    await api(url, '/api/test/control', { action: 'hold', barrier: 'translation' });
    const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, {
      request: 'Translate this synthetic long scene after generation.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: configured.revision,
      idempotencyKey: randomUUID(),
    });
    const done = await terminal(url, run.id);
    expect(done.status).toBe('completed');
    const source = app.store.source(done.sourceRevision!);
    expect(source.text).toBe(originalText);
    const initial = await api<ChatDetail>(url, `/api/chats/${chat.id}`);
    expect(initial.jobs).toHaveLength(0);
    const requested = await api<Job>(url, `/api/sources/${source.id}/translation`, {});
    const jobId = requested.id;
    const updatedGlossary = app.store.product.content(
      { ...contentBody('module', 'FUTURE_GLOSSARY_NEW'), expectedRevision: glossary.revision },
      glossary.id
    ) as Content;
    profile(app.store.product, chat, [reference(updatedGlossary)], { routes: configured.routes });
    const other = await api<Chat>(url, '/api/chats', { title: 'Another visible chat' });
    await api(url, `/api/chats/${other.id}`);
    await api(url, '/api/test/control', { action: 'release', barrier: 'translation' });
    const partial = await terminalJob(url, chat.id, jobId);
    expect(partial.status).toBe('partial');
    expect(partial.chunks?.map((chunk) => chunk.status)).toEqual([
      'completed',
      'failed',
      'completed',
    ]);
    expect(app.store.job(jobId).input).toMatchObject({
      translationModelSelection: { id: translation.id },
      translationModelSnapshot: { ...translation, connection: bound },
    });
    expect(partial.result?.segments).toHaveLength(2);
    expect(partial.result?.sourceRevision).toBe(source.id);
    expect(partial.result?.mock).toBe(true);
    const successfulChunks = partial
      .chunks!.filter((chunk) => chunk.status === 'completed')
      .map((chunk) => structuredClone(chunk));
    const failedChunk = partial.chunks!.find((chunk) => chunk.status === 'failed')!;
    const beforeRetry = new Map(chunkRequests);
    await api(url, `/api/jobs/${jobId}/retry`, { chunkId: failedChunk.id }, { status: 400 });
    expect(app.store.job(jobId).status).toBe('partial');
    const updatedTranslation = app.store.product.model(
      {
        title: 'Future translator settings',
        connectionId: bound.id,
        modelId: 'future-translator',
        maxOutputTokens: 2048,
        temperature: null,
        expectedRevision: translation.revision,
      },
      translation.id
    );
    expectedTranslationModel = 'future-translator';
    await api(url, `/api/jobs/${jobId}/retry`, {});
    const completed = await terminalJob(url, chat.id, jobId);
    expect(completed.status).toBe('completed');
    expect(completed.result?.segments).toHaveLength(3);
    expect(app.store.job(jobId).input).toMatchObject({
      translationModelSelection: { id: translation.id },
      translationModelSnapshot: { ...updatedTranslation, connection: bound },
    });
    expect(app.store.product.get<ModelPreset>('model', translation.id).modelId).toBe(
      'future-translator'
    );
    expect(completed.result?.segments?.flatMap((segment) => segment.anchors)).toEqual(
      source.blocks?.map((block) => block.anchor)
    );
    for (const chunk of successfulChunks) {
      expect(completed.chunks?.find((value) => value.id === chunk.id)?.result).not.toEqual(
        chunk.result
      );
      expect(chunkRequests.get(chunk.id)).toBe(
        beforeRetry.get(chunk.id)! + (chunk.id.endsWith('-0') ? 2 : 1)
      );
    }
    expect(chunkRequests.get(failedChunk.id)).toBe(beforeRetry.get(failedChunk.id)! + 1);
    expect(completed.chunks?.find((chunk) => chunk.id === failedChunk.id)?.attempt).toBe(1);
    expect(completed.result?.text?.match(/`KEEP_LITERAL`/g)).toHaveLength(3);
    expect(completed.result?.text).not.toContain('[[p_');
    expect(app.store.source(source.id).hash).toBe(source.hash);
    expect(app.store.source(source.id).text).toBe(originalText);
    expect(app.store.detail(other.id).jobs).toEqual([]);
    const ledger = app.store.product.attempts(chat.id);
    expect(ledger.filter((attempt) => attempt.role === 'main')).toHaveLength(1);
    expect(ledger.filter((attempt) => attempt.role === 'translation')).toHaveLength(8);
    expect(ledger.filter((attempt) => attempt.status === 'error')).toHaveLength(1);
    expect(ledger.every((attempt) => attempt.costUsd === null)).toBe(true);
    expect(
      provider.requests.filter((request) => JSON.parse(request.body).role === 'main')
    ).toHaveLength(1);
  });

  test('invalid queued translation snapshot fails once before any provider request and leaves the HTTP server responsive', async () => {
    const fixtureItem = await directory();
    const provider = await loopbackProvider(async (_captured, response) => {
      await writeSse(response, [{ type: 'error', message: 'Unexpected provider dispatch' }]);
    });
    fixtureItem.close = provider.close;
    const item = await directory();
    const app = await createApp({
      dbPath: join(item.directory, 'invalid-translation.sqlite'),
      buildId: 'invalid-translation-snapshot',
      instanceId: randomUUID(),
      testMode: true,
      approvedOrigins: [provider.origin],
    });
    item.close = () => app.close();
    const store = app.store,
      product = store.product;
    const initial = createFixtureChat(store, 'Invalid queued translation fixture');
    const chat = store.settings(initial.id, initial.settingsRevision, {
      ...initial.settings,
      translation: false,
      status: false,
    });
    const connection = product.connection({
      title: 'Valid local fixture',
      protocol: 'fixture-sse-v1',
      endpoint: provider.endpoint,
      enabled: true,
    }) as Connection;
    const model = product.model({
      title: 'Translator',
      connectionId: connection.id,
      modelId: 'fixture-translator',
      maxOutputTokens: 2000,
      temperature: null,
    }) as ModelPreset;
    profile(product, chat, [], {
      routes: { main: null, translation: { id: model.id }, status: null, image: null },
    });
    const source = completedSource(
      store,
      product,
      chat.id,
      'The synthetic keeper waited by the river.'
    );
    const job = store.requestTranslation(source.id),
      frozen = structuredClone(store.run(source.runId).snapshot),
      storedSource = structuredClone(store.source(source.id));
    const input = structuredClone(job.input) as Record<string, unknown>;
    delete input.translationModelSnapshot;
    store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(JSON.stringify(input), job.id);
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const failed = await terminalJob(url, chat.id, job.id);
    expect(failed).toMatchObject({
      status: 'failed',
      generation: job.generation,
      error: 'Auxiliary job failed',
    });
    await api(url, '/api/session');
    await api(url, `/api/chats/${chat.id}`);
    expect(store.queuedJobs()).not.toContain(job.id);
    expect(
      store
        .events(chat.id, 0)
        .filter((event) => event.kind === 'job.failed' && event.entityId === job.id)
    ).toHaveLength(1);
    expect(product.attempts(chat.id)).toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(store.source(source.id)).toEqual(storedSource);
    expect(store.run(source.runId).snapshot).toEqual(frozen);
  });

  test('P05 P06 P09 routes selected main through fetch, preserves source on refusal/partial and creates a sibling over HTTP', async () => {
    const fixtureItem = await directory();
    const provider = await loopbackProvider(async (captured, response) => {
      const body = JSON.parse(captured.body);
      if (body.input.task === 'refuse main')
        await writeSse(response, [
          { type: 'refusal', message: 'Fixture refuses explicitly' },
          { type: 'usage', inputTokens: 8, outputTokens: 1 },
          { type: 'done', reason: 'refusal' },
        ]);
      else if (body.input.task === 'partial main')
        await writeSse(response, [{ type: 'text_delta', delta: 'PARTIAL_NOT_SOURCE' }]);
      else
        await writeSse(response, [
          { type: 'text_delta', delta: 'HTTP_PROVIDER_ORIGINAL' },
          { type: 'usage', inputTokens: 4, outputTokens: 2 },
          { type: 'done', reason: 'stop' },
        ]);
    });
    fixtureItem.close = provider.close;
    const { app, url } = await application({ approvedOrigins: [provider.origin] });
    const initial = await api<Chat>(url, '/api/chats', { title: 'HTTP provider chat' });
    const chat = await api<Chat>(
      url,
      `/api/chats/${initial.id}/settings`,
      { expectedSettingsRevision: initial.settingsRevision, ...initial.settings, status: true },
      { method: 'PATCH' }
    );
    const bound = app.store.product.connection({
      title: 'Loopback selected',
      protocol: 'fixture-sse-v1',
      endpoint: provider.endpoint,
      enabled: true,
    }) as Connection;
    const model = app.store.product.model({
      title: 'Fixture',
      connectionId: bound.id,
      modelId: 'fixture-http-main',
      maxOutputTokens: 4096,
      temperature: null,
    }) as ModelPreset;
    const configured = profile(app.store.product, chat, [], {
      routes: { main: { id: model.id }, translation: null, status: null, image: null },
    });
    async function create(request: string) {
      const current = app.store.chat(chat.id);
      return api<Run>(url, `/api/chats/${chat.id}/runs`, {
        request,
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        expectedProfileRevision: configured.revision,
        idempotencyKey: randomUUID(),
      });
    }
    const created = await create('success main');
    const completed = await terminal(url, created.id);
    expect(completed.status).toBe('completed');
    const success = await api<ChatDetail>(url, `/api/chats/${chat.id}`);
    expect(success.sources).toHaveLength(1);
    expect(success.sources[0].text).toBe('HTTP_PROVIDER_ORIGINAL');
    expect(success.jobs.map((job) => job.kind)).toEqual(['status']);
    expect(success.attempts?.[0]).toMatchObject({
      modelId: 'fixture-http-main',
      status: 'completed',
      inputTokens: 4,
      outputTokens: 2,
      costUsd: null,
    });
    for (const [request, status] of [
      ['refuse main', 'refused'],
      ['partial main', 'partial'],
    ] as const) {
      const run = await create(request);
      const done = await terminal(url, run.id);
      expect(done).toMatchObject({ status, sourceRevision: null });
    }
    const preserved = await api<ChatDetail>(url, `/api/chats/${chat.id}`);
    expect(preserved.sources).toEqual(success.sources);
    expect(preserved.jobs.map((job) => job.kind)).toEqual(['status']);
    expect(preserved.runs.find((run) => run.status === 'partial')?.partialText).toBe(
      'PARTIAL_NOT_SOURCE'
    );
    const key = randomUUID();
    const sibling = await api<Run>(url, `/api/runs/${created.id}/candidate`, {
      idempotencyKey: key,
      title: 'HTTP sibling',
    });
    expect((await terminal(url, sibling.id)).status).toBe('completed');
    const duplicate = await api<Run>(url, `/api/runs/${created.id}/candidate`, {
      idempotencyKey: key,
      title: 'HTTP sibling',
    });
    expect(duplicate.id).toBe(sibling.id);
    expect(app.store.run(sibling.id).snapshot.candidateOf).toBe(created.id);
    expect(app.store.chat(chat.id).headRevision).toBe(completed.sourceRevision);
    expect(provider.requests).toHaveLength(4);
    expect(app.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('P04 catalog refresh updates data only and retains prior data on HTTP failure without changing model routes or credentials', async () => {
    const fixtureItem = await directory();
    let fail = false;
    const provider = await loopbackProvider((captured, response) => {
      expect(captured.url).toBe('/models');
      if (fail) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{"error":"fixture unavailable"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          models: [
            { id: 'catalog-new-entry', label: 'New fixture model', capabilities: { tools: true } },
          ],
        })
      );
    });
    fixtureItem.close = provider.close;
    const envName = 'NARRATIVE_PROVIDER_CATALOG_FIXTURE';
    const priorEnv = process.env[envName];
    process.env[envName] = 'SYNTHETIC_CATALOG_CREDENTIAL';
    try {
      const { app, url } = await application({ approvedOrigins: [provider.origin] });
      const bound = app.store.product.connection({
        title: 'Catalog fixture',
        protocol: 'fixture-sse-v1',
        endpoint: provider.endpoint,
        credentialEnv: envName,
        enabled: true,
      }) as Connection;
      const model = app.store.product.model({
        title: 'Unlisted manual ID',
        connectionId: bound.id,
        modelId: 'manual-unlisted-id',
        maxOutputTokens: 1000,
        temperature: null,
      }) as ModelPreset;
      await api(url, `/api/connections/${bound.id}/catalog`, {});
      const refreshed = app.store.product.get<Connection>('connection', bound.id);
      expect(refreshed.catalog.map((item) => item.id)).toEqual(['catalog-new-entry']);
      expect(refreshed.catalog[0].capabilities.structuredOutput).toBeNull();
      expect(refreshed.catalog[0].priceRevision).toBeNull();
      expect(refreshed.credentialEnv).toBe(envName);
      expect(refreshed.enabled).toBe(true);
      expect(app.store.product.get<ModelPreset>('model', model.id)).toEqual(model);
      fail = true;
      await api(url, `/api/connections/${bound.id}/catalog`, {});
      const failed = app.store.product.get<Connection>('connection', bound.id);
      expect(failed.catalog).toEqual(refreshed.catalog);
      expect(failed.catalogError).toBeTruthy();
      expect(failed.credentialEnv).toBe(envName);
      expect(failed.enabled).toBe(true);
      expect(app.store.product.get<ModelPreset>('model', model.id).modelId).toBe(
        'manual-unlisted-id'
      );
      expect(JSON.stringify(app.store.product.library())).not.toContain(
        'SYNTHETIC_CATALOG_CREDENTIAL'
      );
      expect(provider.requests).toHaveLength(2);
    } finally {
      if (priorEnv === undefined) delete process.env[envName];
      else process.env[envName] = priorEnv;
    }
  });

  test('P12 protects data, events and asset bytes with an HttpOnly session, rejects foreign origins and revokes logout cookies', async () => {
    const accessToken = 'SYNTHETIC_LOCAL_AUTH_TOKEN_0123456789';
    const { app, url } = await application({ accessToken });
    const chat = createFixtureChat(app.store, 'private synthetic chat');
    const asset = app.store.product.createAsset(chat.id, assetBody);
    expect(await api(url, '/api/session')).toMatchObject({ required: true, authenticated: false });
    for (const path of ['/api/chats', `/api/chats/${chat.id}/events`, `/api/assets/${asset.id}`]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status, path).toBe(401);
      await response.body?.cancel();
    }
    await api(url, '/api/session', { token: 'wrong synthetic token' }, { status: 401 });
    const login = await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ token: accessToken }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    await login.body?.cancel();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toContain(accessToken);
    const cookie = setCookie.split(';')[0];
    expect(await api(url, '/api/session', undefined, { cookie })).toMatchObject({
      authenticated: true,
    });
    expect(await api<Chat[]>(url, '/api/chats', undefined, { cookie })).toHaveLength(1);
    await api(
      url,
      '/api/chats',
      { title: 'foreign write' },
      { cookie, origin: 'https://foreign.invalid', status: 403 }
    );
    const assetResponse = await fetch(`${url}/api/assets/${asset.id}`, { headers: { cookie } });
    expect(assetResponse.status).toBe(200);
    expect(Buffer.from(await assetResponse.arrayBuffer())).toEqual(Buffer.from(pixel, 'base64'));
    const events = await fetch(`${url}/api/chats/${chat.id}/events`, { headers: { cookie } });
    expect(events.status).toBe(200);
    expect(events.headers.get('content-type')).toContain('text/event-stream');
    await events.body?.cancel();
    await api(url, '/api/session', undefined, { method: 'DELETE', cookie });
    await api(url, '/api/chats', undefined, { cookie, status: 401 });
    expect(app.store.chats()).toHaveLength(1);
  });
});

/** A frozen schema-1 input fixture, independent of the new migration implementation. */
function schema1Fixture(path: string) {
  const db = new DatabaseSync(path);
  const settings = {
    preset: 'calm',
    mode: 'direct',
    translation: true,
    status: false,
    maxCalls: 8,
  };
  const time = '2026-09-06T00:00:00Z';
  const text = 'Legacy original preserved.';
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE chats (id TEXT PRIMARY KEY,title TEXT NOT NULL,head_revision TEXT,settings_revision INTEGER NOT NULL,settings TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE resources (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),body TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),parent_revision TEXT,status TEXT NOT NULL,request TEXT NOT NULL,snapshot TEXT NOT NULL,request_key TEXT NOT NULL,command TEXT NOT NULL,source_revision TEXT,error TEXT,usage TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(chat_id,request_key));
      CREATE UNIQUE INDEX one_active_run_per_chat ON runs(chat_id) WHERE status IN ('queued','running');
      CREATE TABLE sources (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),parent_revision TEXT REFERENCES sources(id),text TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE jobs (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),source_revision TEXT NOT NULL REFERENCES sources(id),source_hash TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('translation','status')),status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,input TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(source_revision,kind));
      CREATE TABLE job_results (job_id TEXT PRIMARY KEY REFERENCES jobs(id),generation INTEGER NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE model_inputs (seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),input TEXT NOT NULL);
      CREATE TABLE tool_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),event TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL REFERENCES chats(id),kind TEXT NOT NULL,entity_id TEXT NOT NULL,at TEXT NOT NULL);
      PRAGMA user_version=1;`);
    db.prepare('INSERT INTO chats VALUES(?,?,?,?,?,?)').run(
      'old-chat',
      'Legacy fixture',
      'old-source',
      1,
      JSON.stringify(settings),
      time
    );
    const snapshot = {
      chatId: 'old-chat',
      parentRevision: null,
      settingsRevision: 1,
      settings,
      request: 'Legacy request',
      history: [],
      resources: [],
    };
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'old-run',
      'old-chat',
      null,
      'completed',
      'Legacy request',
      JSON.stringify(snapshot),
      'legacy-key',
      '{}',
      'old-source',
      null,
      JSON.stringify(noUsage),
      time,
      time
    );
    const hash = createHash('sha256').update(text).digest('hex');
    db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(
      'old-source',
      'old-chat',
      'old-run',
      null,
      text,
      hash,
      time
    );
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'old-job',
      'old-chat',
      'old-source',
      hash,
      'translation',
      'completed',
      1,
      'old-owner',
      '{}',
      null,
      time,
      time
    );
    db.prepare('INSERT INTO job_results VALUES(?,?,?,?)').run(
      'old-job',
      1,
      JSON.stringify({ mock: true, text: '기존 모의 번역' }),
      time
    );
    db.prepare('INSERT INTO events(chat_id,kind,entity_id,at) VALUES(?,?,?,?)').run(
      'old-chat',
      'source.ready',
      'old-source',
      time
    );
  } finally {
    db.close();
  }
}
