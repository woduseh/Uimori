import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.js';
import { createPackageStart } from '../server/package-start.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { packageControlKey } from '../server/product-store.js';
import { resolvePackageStart, validatePackageStarts } from '../core/package-start.js';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import { completePendingStoryProfile, savePendingStoryProfile } from '../web/pendingStory.js';
import type { Content } from '../core/product.js';
import { forkChat } from '../server/chat-fork.js';
import { readerDetail } from '../server/reader.js';
import { captureLogicalHistory } from '../server/prompt-snapshot.js';

const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-package-start-')
    )
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-package-start-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
function packageData(): ContentPackage {
  return {
    version: 1,
    id: 'shared-world',
    revision: 1,
    title: 'Synthetic shared world',
    description: '',
    body: 'Synthetic only',
    lore: [],
    instructions: [],
    transforms: [],
    controls: [
      {
        id: 'job',
        label: '직무',
        type: 'select',
        default: 'guard',
        options: [
          { label: '경비', value: 'guard' },
          { label: '연구', value: 'researcher' },
        ],
      },
    ],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      mode: 'authoritative',
      stateSchema: {
        type: 'record',
        properties: {
          job: { type: 'enum', values: ['guard', 'researcher'] },
          roll: { type: 'number', min: 0, max: 6, integer: true },
        },
      },
      initialState: { job: 'guard', roll: 0 },
      actions: [
        {
          id: 'choose-job',
          inputSchema: {
            type: 'record',
            properties: { job: { type: 'enum', values: ['guard', 'researcher'] } },
          },
          draws: [{ id: 'opening-die', type: 'integer', min: 1, max: 6 }],
          effects: [
            { path: ['job'], value: { context: ['input', 'job'] } },
            { path: ['roll'], value: { context: ['draws', 'opening-die'] } },
          ],
        },
      ],
      outputParsers: [
        {
          id: 'required-state',
          format: 'json',
          fields: [{ path: ['job'], from: ['job'], valueType: 'string' }],
        },
      ],
    },
    starts: [
      {
        id: 'arrival',
        title: '도착',
        description: '합성 도입문',
        mode: 'authored',
        text: '\r\n문이 열렸다.\n\n{{literal author text}}\n',
        values: { job: 'researcher' },
        initialAction: {
          actionId: 'choose-job',
          input: { op: 'object', args: ['job', { control: 'job' }] },
        },
      },
      {
        id: 'generated',
        title: '생성 시작',
        mode: 'generate',
        text: 'Write a synthetic arrival.',
        initialAction: {
          actionId: 'choose-job',
          input: { op: 'object', args: ['job', { control: 'job' }] },
        },
      },
    ],
  };
}
function fixture() {
  const store = database(),
    pkg = packageData();
  const content = store.product.content({
    kind: 'module',
    title: pkg.title,
    description: '',
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic opening', 'calm', { botId: content.id });
  const profile = store.product.profile(chat.id),
    key = packageControlKey(profile.packageAttachments![0]);
  const { chatId: _chatId, revision, ...profileBody } = profile;
  const saved = store.product.updateProfile(chat.id, {
    ...profileBody,
    expectedRevision: revision,
    packageValues: { [key]: { job: 'researcher' } },
    image: true,
  });
  return {
    store,
    content,
    chat,
    profile: saved,
    command: {
      packageId: content.id,
      packageRevision: content.revision,
      startId: 'arrival',
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: saved.revision,
      idempotencyKey: 'synthetic-opening',
    },
  };
}

test('starts validate typed choices and existing explicit actions; preview preserves exact author text and does not draw', () => {
  const pkg = packageData();
  expect(validateContentPackage(pkg).starts).toEqual(pkg.starts);
  expect(resolvePackageStart(pkg, 'arrival')).toMatchObject({
    text: pkg.starts![0].text,
    values: { job: 'researcher' },
    initialAction: { input: { job: 'researcher' } },
  });
  expect(() => resolvePackageStart(pkg, 'arrival', { job: 'missing' })).toThrow(
    'PROMPT_INVALID_CONTROL_VALUE'
  );
  expect(() => validatePackageStarts([pkg.starts![0], pkg.starts![0]], pkg)).toThrow(
    'PACKAGE_START_DUPLICATE_ID'
  );
  expect(() =>
    validatePackageStarts(
      [{ ...pkg.starts![0], initialAction: { actionId: 'missing', input: null } }],
      pkg
    )
  ).toThrow('PACKAGE_START_INITIAL_ACTION');
  expect(() =>
    validatePackageStarts(
      [
        {
          ...pkg.starts![0],
          initialAction: { actionId: 'choose-job', input: { context: ['state'] } },
        },
      ],
      pkg
    )
  ).toThrow('PACKAGE_START_INPUT_CONTEXT');
  const f = fixture(),
    before = f.store.product.export();
  for (let i = 0; i < 3; i++) resolvePackageStart(f.content.package!, 'arrival');
  expect(f.store.product.export().tables).toEqual(before.tables);
});

test('a module is used directly as bot; authored confirmation stores one immutable source and selected state with no calls or auxiliary jobs', () => {
  const f = fixture(),
    result = createPackageStart(f.store, f.chat.id, f.command),
    source = f.store.source(result.run.sourceRevision!);
  expect(f.content.kind).toBe('module');
  expect(f.store.chat(f.chat.id).botId).toBe(f.content.id);
  expect(f.store.product.all('content')).toHaveLength(1);
  expect(result.run.status).toBe('completed');
  expect(result.run.usage.modelCalls).toBe(0);
  expect(result.run.usage.costUsd).toBeNull();
  expect(source.text).toBe(packageData().starts![0].text);
  expect(source.hash).toBe(createHash('sha256').update(source.text).digest('hex'));
  expect(result.run.snapshot.packageStart).toMatchObject({
    packageId: f.content.id,
    packageRevision: 1,
    mode: 'authored',
    values: { job: 'researcher' },
  });
  const detail = behaviorDetail(f.store, f.chat.id);
  expect(detail.sourceHash).toBe(source.hash);
  expect(detail.instances[0]).toMatchObject({
    stateRevision: 1,
    status: 'ready',
    state: { job: 'researcher' },
  });
  expect((detail.instances[0].state as { roll: number }).roll).toBeGreaterThan(0);
  expect(f.store.detail(f.chat.id).jobs).toHaveLength(0);
  expect(f.store.product.attempts(f.chat.id)).toHaveLength(0);
  expect(f.store.db.prepare('SELECT 1 FROM story_jobs').all()).toHaveLength(0);
  expect(f.store.db.prepare('SELECT 1 FROM package_behavior_journal').all()).toHaveLength(1);
  const replay = createPackageStart(f.store, f.chat.id, f.command);
  expect(replay.created).toBe(false);
  expect(replay.run.id).toBe(result.run.id);
  expect(f.store.detail(f.chat.id).sources).toHaveLength(1);
  expect(f.store.db.prepare('SELECT 1 FROM package_behavior_journal').all()).toHaveLength(1);
  expect(() =>
    createPackageStart(f.store, f.chat.id, { ...f.command, idempotencyKey: 'another' })
  ).toThrow('Source revision conflict');
  expect(() =>
    f.store.candidate(result.run.id, 'candidate-opening', 'Synthetic candidate')
  ).toThrow('Authored opening cannot be regenerated as a model candidate');
  const reader = readerDetail(f.store, f.chat.id, {});
  expect(reader.runs[0].packageStart).toEqual({ mode: 'authored', title: '도착' });
  expect(reader.runs[0]).toMatchObject({ modelTitle: null });
  const logical = captureLogicalHistory(f.store, {
    ...result.run.snapshot,
    parentRevision: source.id,
    history: f.store.history(source.id),
    request: 'Synthetic next user request.',
  });
  expect(logical.filter((item) => item.sourceRevision === source.id)).toEqual([
    expect.objectContaining({ role: 'assistant', text: source.text }),
  ]);
  const edited = f.store.editSource(source.id, {
    text: 'User changed the opening.',
    expectedRevision: 0,
  });
  expect(behaviorDetail(f.store, f.chat.id).instances[0].status).toBe('stale');
  expect(f.store.sourceOriginal(source.id).text).toBe(source.text);
  expect(edited.hash).not.toBe(source.hash);
});

test('start settings CAS and commit failure roll back initial action, run, source, events and draws', () => {
  const f = fixture(),
    before = f.store.product.export().tables;
  expect(() =>
    createPackageStart(f.store, f.chat.id, { ...f.command, expectedProfileRevision: 1 })
  ).toThrow('Profile revision conflict');
  expect(f.store.product.export().tables).toEqual(before);
  const recordEvent = f.store.event.bind(f.store);
  vi.spyOn(f.store, 'event').mockImplementation((chatId, kind, entityId) => {
    if (kind === 'source.ready') throw Error('SYNTHETIC_SOURCE_FAILURE');
    recordEvent(chatId, kind, entityId);
  });
  expect(() => createPackageStart(f.store, f.chat.id, f.command)).toThrow(
    'SYNTHETIC_SOURCE_FAILURE'
  );
  expect(f.store.product.export().tables).toEqual(before);
});

test('generated opening uses the existing queue once; cancellation and retry never reapply its initial state', () => {
  const f = fixture(),
    command = { ...f.command, startId: 'generated' };
  const result = createPackageStart(f.store, f.chat.id, command);
  expect(result.run.status).toBe('queued');
  expect(result.run.sourceRevision).toBeNull();
  expect(result.run.request).toBe('Write a synthetic arrival.');
  const state = result.run.snapshot.packageStates![0];
  expect(state.state).toMatchObject({ job: 'researcher' });
  f.store.finishRun(result.run.id, 'cancelled', 'Synthetic cancellation');
  expect(createPackageStart(f.store, f.chat.id, command)).toMatchObject({
    created: false,
    run: { id: result.run.id, status: 'cancelled' },
  });
  expect(() =>
    createPackageStart(f.store, f.chat.id, { ...command, idempotencyKey: 'another-start' })
  ).toThrow('PACKAGE_START_ALREADY_CONFIRMED');
  expect(f.store.db.prepare('SELECT 1 FROM package_behavior_journal').all()).toHaveLength(1);
  expect(f.store.detail(f.chat.id).sources).toHaveLength(0);
});

test('authored source state and authorship survive archive and fork without a second initial action', () => {
  const f = fixture(),
    result = createPackageStart(f.store, f.chat.id, f.command),
    archive = f.store.product.export(),
    restored = database();
  restored.product.import(archive);
  expect(restored.run(result.run.id).snapshot.packageStart).toEqual(
    result.run.snapshot.packageStart
  );
  expect(behaviorDetail(restored, f.chat.id).instances[0].state).toEqual(
    behaviorDetail(f.store, f.chat.id).instances[0].state
  );
  const fork = forkChat(f.store, f.chat.id, {
    title: 'Synthetic fork',
    fromRevision: result.run.sourceRevision,
    idempotencyKey: 'synthetic-fork',
  });
  expect(f.store.chat(fork.id).botId).toBe(f.content.id);
  expect(f.store.detail(fork.id).sources[0].text).toBe(packageData().starts![0].text);
  expect(behaviorDetail(f.store, fork.id).instances[0].state).toEqual(
    behaviorDetail(f.store, f.chat.id).instances[0].state
  );
});

test('archive rejects forged authored markers and original prose and rolls back the import', () => {
  const f = fixture(),
    result = createPackageStart(f.store, f.chat.id, f.command),
    archive = f.store.product.export();
  const changes: ((snapshot: any, archive: any) => void)[] = [
    (snapshot) => {
      delete snapshot.packageStart;
    },
    (snapshot) => {
      snapshot.packageStart.title = 'Forged title';
    },
    (snapshot) => {
      snapshot.packageStart.text = 'Forged authored text';
    },
    (snapshot) => {
      snapshot.packageStart.packageRevision = 2;
    },
    (snapshot) => {
      snapshot.packageStart.values.job = 'guard';
    },
    (snapshot) => {
      snapshot.packageStart.initialAction.input.job = 'guard';
    },
    (_snapshot, archive) => {
      const source = archive.tables.sources.find(
        (row: any) => row.id === result.run.sourceRevision
      );
      source.text = 'Forged stored original';
      source.hash = createHash('sha256').update(source.text).digest('hex');
    },
  ];
  for (const change of changes) {
    const forged = structuredClone(archive),
      row = forged.tables.runs.find((run: any) => run.id === result.run.id)!;
    const snapshot = JSON.parse(row.snapshot);
    change(snapshot, forged);
    row.snapshot = JSON.stringify(snapshot);
    const target = database(),
      baseline = target.product.export().tables;
    expect(() => target.product.import(forged)).toThrow();
    expect(target.product.export().tables).toEqual(baseline);
  }
});

test('authorship archive validation permits later source edits and a standalone fork without the origin chat', () => {
  const f = fixture(),
    result = createPackageStart(f.store, f.chat.id, f.command);
  f.store.editSource(result.run.sourceRevision!, {
    text: 'A later author edit.',
    expectedRevision: 0,
  });
  const fork = forkChat(f.store, f.chat.id, {
    fromRevision: result.run.sourceRevision!,
    idempotencyKey: 'edited-start-fork',
  });
  const source = f.store.detail(fork.id).sources[0];
  const archive = f.store.product.export(),
    full = database();
  expect(() => full.product.import(archive)).not.toThrow();
  const standalone = structuredClone(archive);
  for (const [name, rows] of Object.entries(standalone.tables)) {
    standalone.tables[name] = rows.filter((row: any) => {
      if (name === 'chats') return row.id === fork.id;
      if (Object.hasOwn(row, 'chat_id')) return row.chat_id === fork.id;
      if (Object.hasOwn(row, 'source_id')) return row.source_id === source.id;
      return true;
    });
  }
  const restored = database();
  expect(restored.product.import(standalone)).toEqual({ restored: true, chats: 1 });
  expect(restored.source(source.id).text).toBe('A later author edit.');
  expect(restored.sourceOriginal(source.id).text).toBe(packageData().starts![0].text);
  expect(restored.run(source.runId).snapshot.packageStart).toEqual(
    result.run.snapshot.packageStart
  );
});

test('lost start response retries the saved command without another profile write or source', async () => {
  const f = fixture();
  const memory = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  });
  let profileWrites = 0,
    attempts = 0;
  vi.stubGlobal('fetch', async (url: string, options?: { method?: string; body?: string }) => {
    if (url.endsWith('/profile')) {
      if (options?.method === 'PUT') {
        profileWrites++;
        return Response.json(f.store.product.updateProfile(f.chat.id, JSON.parse(options.body!)));
      }
      return Response.json(f.store.product.profile(f.chat.id));
    }
    if (url.endsWith('/package-start')) {
      const result = createPackageStart(f.store, f.chat.id, JSON.parse(options!.body!));
      if (++attempts === 1) throw Error('SYNTHETIC_RESPONSE_LOST');
      return Response.json(result);
    }
    throw Error('Unexpected API request');
  });
  savePendingStoryProfile(f.chat.id, {
    attachments: f.profile.attachments,
    packageAttachments: f.profile.packageAttachments,
    packageValues: f.profile.packageValues,
    packageStart: { ...f.command, expectedProfileRevision: undefined },
  });
  await expect(completePendingStoryProfile(f.chat.id)).rejects.toThrow('SYNTHETIC_RESPONSE_LOST');
  const pending = JSON.parse(memory.get(`pending-profile:${f.chat.id}`)!);
  expect(pending.packageStart.expectedProfileRevision).toBe(f.profile.revision + 1);
  await completePendingStoryProfile(f.chat.id);
  expect(profileWrites).toBe(1);
  expect(attempts).toBe(2);
  expect(memory.size).toBe(0);
  expect(f.store.detail(f.chat.id).sources).toHaveLength(1);
});
