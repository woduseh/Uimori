import { injectWithFixtureBot, createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { forkChat } from '../server/chat-fork.js';
import { Store, HttpError, type Source } from '../server/store.js';
import { Controls } from '../server/controls.js';
import { auxiliaryBridge } from '../server/auxiliary-bridge.js';
import { runAuxiliaryJob, sourceTimeContext } from '../server/product-auxiliary.js';
import { validateTranslationPlan } from '../core/auxiliary.js';
import type { Content, PromptPreset, ChatProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';

const owned: { directory: string; app?: App; store?: Store }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('External calls forbidden in fork tests')
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    if (item.app) await item.app.close();
    else item.store?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori fork tests ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function application() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori fork tests '));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'fork-synthetic',
    instanceId: randomUUID(),
    testMode: true,
  });
  await item.app.ready();
  return item.app;
}
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori fork tests '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
const profileBody = (prior: ChatProfile, changes: Record<string, unknown> = {}) => ({
  expectedRevision: prior.revision,
  attachments: prior.attachments,
  personaReference: prior.personaReference,
  routes: prior.routes,
  image: prior.image,
  ...changes,
});
function source(store: Store, chatId: string, value: string, branchId?: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const branch = store.product.branch(chatId, branchId);
  const request = 'Synthetic source, no model request';
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
    },
    (current) =>
      ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request,
        history: store.history(current.headRevision),
        resources: store.product.resources(chatId, profile),
        ...(profile ? { profile } : {}),
      }) satisfies RunSnapshot
  ).run;
  store.startRun(run.id);
  return store.source(
    store.completeRun(
      run.id,
      value,
      { modelCalls: 3, inputTokens: 70, outputTokens: 90, costUsd: 0.04 },
      run.snapshot.settings
    ).id
  );
}
async function fork(app: App, chatId: string, body: unknown, status = 200) {
  const response = await injectWithFixtureBot(app, {
    method: 'POST',
    url: '/api/chats/' + chatId + '/fork',
    payload: JSON.stringify(body),
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
}
async function translate(store: Store, jobId: string) {
  const signal = new AbortController().signal;
  const result = await runAuxiliaryJob(
    auxiliaryBridge(store, new Controls(), signal),
    jobId,
    'synthetic-fork-worker',
    {
      signal,
      approvedOrigins: [],
      authorize: (value) => value,
      maxChunkChars: 100,
      onAttemptStart: () => {
        throw new Error('No provider transport allowed');
      },
      onAttemptFinish: () => {},
    }
  );
  expect(result?.status).toBe('completed');
  return store.job(jobId);
}
function finishOther(store: Store, revision: Source, assetId: string) {
  for (const job of store
    .detail(revision.chatId)
    .jobs.filter((job) => job.sourceRevision === revision.id && job.kind !== 'translation')) {
    const claimed = store.claimJob(job.id, 'synthetic-fork-worker', {})!;
    const result =
      job.kind === 'status'
        ? {
            mock: true,
            sourceRevision: revision.id,
            sourceHash: revision.hash,
            display: [
              {
                anchor: revision.blocks![0].anchor,
                summary: 'Synthetic display only',
                mood: 'quiet',
              },
            ],
          }
        : {
            mock: true,
            sourceRevision: revision.id,
            sourceHash: revision.hash,
            annotations: [
              {
                blockAnchor: revision.blocks![0].anchor,
                assetRef: assetId,
                assetRevision: 1,
                assetHash: store.product.asset(assetId).asset.hash,
                presentationIntent: 'inline',
                caption: 'Synthetic pixel',
              },
            ],
          };
    expect(store.completeJob(job.id, claimed.generation, 'synthetic-fork-worker', result)).toBe(
      true
    );
  }
}
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
async function rich(app: App) {
  const store = app.store;
  const chat = createFixtureChat(store, 'Synthetic original');
  const main = store.product.promptPreset({
    role: 'main',
    title: 'Main prompt',
    text: '  MAIN exact\r\n',
  }) as PromptPreset;
  const translation = store.product.promptPreset({
    role: 'translation',
    title: 'Translation prompt',
    text: '  TRANSLATION exact\r\n',
  }) as PromptPreset;
  const lore = store.product.content({
    kind: 'lore',
    title: 'Versioned lore',
    description: 'Synthetic',
    text: 'The lantern stands beside the sea.',
    loading: 'discoverable',
    relatedIds: [],
  }) as Content;
  store.product.updateProfile(
    chat.id,
    profileBody(store.product.profile(chat.id), {
      attachments: [ref(lore)],
      image: true,
      prompts: { main: ref(main), translation: ref(translation) },
    })
  );
  store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    preset: 'vivid',
    maxCalls: 4,
  });
  const asset = store.product.createAsset(chat.id, {
    title: 'Synthetic pixel',
    mime: 'image/png',
    base64: pixel,
    description: 'Synthetic pixel',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'inline',
  });
  const first = source(
    store,
    chat.id,
    'Mira counted 9 lamps beside `north_gate`.\n\nThe old record literally names ' +
      chat.id +
      ' and resource:' +
      chat.id +
      ':harbor.'
  );
  const firstJob = store.requestTranslation(first.id);
  await translate(store, firstJob.id);
  finishOther(store, first, asset.id);
  const laterPrompt = store.product.promptPreset({
    role: 'translation',
    title: 'Later translation',
    text: '',
  }) as PromptPreset;
  store.product.updateProfile(
    chat.id,
    profileBody(store.product.profile(chat.id), { prompts: { translation: ref(laterPrompt) } })
  );
  const revised = store.retranslate(first.id);
  await translate(store, revised.id);
  const second = source(
    store,
    chat.id,
    [
      'The quiet traveler watched the waves softly wash against the pier while the evening lamps shone.',
      'The bellkeeper listened for a distant bell and left the next decision to the waiting traveler.',
    ].join('\n\n')
  );
  const secondJob = store.requestTranslation(second.id);
  await translate(store, secondJob.id);
  finishOther(store, second, asset.id);
  const third = source(store, chat.id, 'The descendant stays solely in the original story.');
  const pending = store.requestTranslation(third.id);
  const failed = store.retranslate(second.id);
  const claimed = store.claimJob(failed.id, 'failed-worker', {})!;
  store.failJob(failed.id, claimed.generation, 'failed-worker', 'Synthetic failure');
  store.product.mockAttempt(chat.id, first.runId, null, 'main', {
    role: 'main',
    task: 'Synthetic earlier attempt',
  });
  return {
    chat,
    first,
    second,
    third,
    asset,
    main,
    translation,
    laterPrompt,
    pending,
    failed,
    revised,
  };
}

describe('independent stored-story fork without generation', () => {
  test('forked runs keep source-time package resource revisions after the current owning package changes', async () => {
    const store = await database();
    const input = fixtureBotInput('Synthetic versioned owner', 'OWNER_V1');
    input.package.lore = [
      {
        id: 'record',
        title: 'Versioned record',
        description: '',
        text: 'LORE_V1',
        loading: 'discoverable',
      },
    ];
    const bot = store.product.content(input) as Content;
    const chat = createFixtureChat(store, 'Source-time resources', 'calm', { botId: bot.id });
    const first = source(store, chat.id, 'SOURCE_V1');
    const frozen = structuredClone(store.run(first.runId).snapshot);
    const revised = store.product.content(
      {
        ...fixtureBotInput(input.title, 'OWNER_V2'),
        expectedRevision: bot.revision,
        package: { ...bot.package!, lore: [{ ...bot.package!.lore[0], text: 'LORE_V2' }] },
      },
      bot.id
    ) as Content;
    const current = store.product.profile(chat.id);
    store.product.updateProfile(
      chat.id,
      profileBody(current, {
        packageAttachments: current.packageAttachments!.map((attachment) =>
          attachment.id === bot.id ? { ...attachment, revision: revised.revision } : attachment
        ),
      })
    );
    const second = source(store, chat.id, 'SOURCE_V2');
    const copy = forkChat(store, chat.id, {
      fromRevision: second.id,
      idempotencyKey: 'source-time-package-fork',
    });
    const copied = store.detail(copy.id).runs;
    for (const original of [first, second]) {
      const originalRun = store.run(original.runId);
      const copiedRun = copied.find(
        (run) => run.snapshot.forkedFrom!.sourceRevision === original.id
      )!;
      expect(copiedRun.snapshot.resources).toEqual(
        originalRun.snapshot.resources.map((resource) => ({ ...resource, chatId: copy.id }))
      );
      expect(copiedRun.snapshot.profile!.packages).toEqual(originalRun.snapshot.profile!.packages);
      expect(store.sourceOriginal(copiedRun.sourceRevision!).hash).toBe(original.hash);
    }
    expect(store.run(first.runId).snapshot).toEqual(frozen);
    expect(
      copied
        .find((run) => run.snapshot.forkedFrom!.sourceRevision === first.id)!
        .snapshot.resources.map((resource) => resource.text)
    ).toEqual(['OWNER_V1', 'LORE_V1']);
    expect(
      store.product
        .resources(copy.id, store.product.snapshot(copy.id))
        .map((resource) => resource.text)
    ).toEqual(['OWNER_V2', 'LORE_V2']);
    const restored = await database();
    restored.product.import(store.product.export());
    expect(restored.detail(copy.id).runs.map((run) => run.snapshot.resources)).toEqual(
      copied.map((run) => run.snapshot.resources)
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test('copies only the selected ancestry and completed artifacts, retaining literal text and independent settings', async () => {
    const app = await application();
    const store = app.store;
    const fixture = await rich(app);
    const before = store.product.export().tables;
    const originalDetail = store.detail(fixture.chat.id);
    const originalProfile = store.product.profile(fixture.chat.id);
    const copy = await fork(app, fixture.chat.id, {
      fromRevision: fixture.second.id,
      idempotencyKey: 'copy-selected',
    });
    expect(copy.id).not.toBe(fixture.chat.id);
    expect(copy.title).toBe('Synthetic original · 포크 1');
    expect(copy.settings).toEqual(originalDetail.chat.settings);
    expect(copy.settingsRevision).toBe(1);
    const detail = store.detail(copy.id);
    const ancestry = store.history(copy.headRevision);
    expect(ancestry.map((item) => item.text)).toEqual([fixture.first.text, fixture.second.text]);
    expect(detail.sources).toHaveLength(2);
    expect(detail.sources.map((item) => item.hash).sort()).toEqual(
      [fixture.first.hash, fixture.second.hash].sort()
    );
    expect(detail.runs).toHaveLength(2);
    expect(detail.branches).toHaveLength(1);
    expect(detail.branches[0]).toMatchObject({ default: true, headRevision: copy.headRevision });
    for (const run of detail.runs) {
      const oldSource =
        run.snapshot.forkedFrom!.sourceRevision === fixture.first.id
          ? fixture.first
          : fixture.second;
      expect(run.snapshot.forkedFrom).toEqual({
        chatId: fixture.chat.id,
        runId: oldSource.runId,
        sourceRevision: oldSource.id,
      });
      expect(run.usage).toEqual({
        modelCalls: 0,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      });
      expect(run.inputs).toEqual([]);
      expect(run.toolEvents).toEqual([]);
      expect(run.snapshot.settingsRevision).toBe(
        store.run(oldSource.runId).snapshot.settingsRevision
      );
      expect(run.snapshot.history).toEqual(store.history(run.parentRevision));
      expect(run.snapshot.resources).toEqual(
        store.product.resources(copy.id, run.snapshot.profile!)
      );
      expect(run.snapshot.profile?.promptPresets?.main?.program).toEqual(
        createDefaultPromptProgram('  MAIN exact\r\n')
      );
    }
    expect(detail.attempts).toEqual([]);
    expect(detail.jobs.every((job) => job.status === 'completed')).toBe(true);
    const expectedJobs = originalDetail.jobs.filter(
      (job) =>
        [fixture.first.id, fixture.second.id].includes(job.sourceRevision) &&
        job.status === 'completed'
    );
    expect(detail.jobs).toHaveLength(expectedJobs.length);
    for (const newSource of detail.sources) {
      const old = fixture.first.hash === newSource.hash ? fixture.first : fixture.second;
      expect(
        newSource.blocks!.map((block) => ({
          index: block.index,
          text: block.text,
          start: block.start,
          end: block.end,
        }))
      ).toEqual(
        old.blocks!.map((block) => ({
          index: block.index,
          text: block.text,
          start: block.start,
          end: block.end,
        }))
      );
      expect(newSource.blocks![0].anchor).not.toBe(old.blocks![0].anchor);
      for (const job of detail.jobs.filter((job) => job.sourceRevision === newSource.id)) {
        const oldJob = expectedJobs.find(
          (prior) =>
            prior.sourceRevision === old.id &&
            prior.kind === job.kind &&
            prior.revision === job.revision
        )!;
        expect(job.id).not.toBe(oldJob.id);
        expect(job.result).toMatchObject({
          sourceRevision: newSource.id,
          sourceHash: newSource.hash,
        });
        if (job.kind === 'translation') {
          expect(job.result?.text).toBe(oldJob.result?.text);
          expect(job.result?.segments?.flatMap((segment) => segment.anchors)).toEqual(
            newSource.blocks!.map((block) => block.anchor)
          );
          const resolved = store.product.resolveJobPrompt(
            store.run(newSource.runId).snapshot,
            store.job(job.id).input
          );
          expect(() =>
            validateTranslationPlan(
              newSource,
              sourceTimeContext(resolved, 'translation'),
              store.product.plan(job.id)
            )
          ).not.toThrow();
          if (oldJob.id === fixture.revised.id)
            expect(store.product.plan(job.id).context.instructionRevision).toBe(
              'prompt:' + fixture.laterPrompt.id + '@1'
            );
        } else if (job.kind === 'image') {
          const annotation = job.result!.annotations![0];
          const copiedAsset = store.product.asset(annotation.assetRef);
          expect(annotation.blockAnchor).toBe(newSource.blocks![0].anchor);
          expect(copiedAsset.asset.id).not.toBe(fixture.asset.id);
          expect(copiedAsset.asset.chatId).toBe(copy.id);
          expect(copiedAsset.asset.url).toBe('/api/assets/' + copiedAsset.asset.id);
          expect(copiedAsset.bytes).toEqual(store.product.asset(fixture.asset.id).bytes);
        }
      }
    }
    expect(store.detail(fixture.chat.id)).toEqual(originalDetail);
    const after = store.product.export().tables;
    for (const name of Object.keys(before))
      expect(after[name]).toEqual(expect.arrayContaining(before[name]));
    expect(store.queuedJobs().sort()).toEqual(
      originalDetail.jobs
        .filter((job) => job.status === 'queued')
        .map((job) => job.id)
        .sort()
    );
    const copyProfile = store.product.profile(copy.id);
    expect({
      ...copyProfile,
      chatId: originalProfile.chatId,
      revision: originalProfile.revision,
    }).toEqual(originalProfile);
    store.product.updateProfile(
      copy.id,
      profileBody(copyProfile, {
        prompts: { main: null, translation: null },
        personaReference: false,
      })
    );
    store.settings(copy.id, copy.settingsRevision, {
      ...copy.settings,
      preset: 'calm',
      translation: false,
      status: false,
    });
    expect(store.product.profile(fixture.chat.id)).toEqual(originalProfile);
    expect(store.chat(fixture.chat.id)).toEqual(originalDetail.chat);
    const continued = source(store, copy.id, 'Only the fork continues here.');
    expect(continued.parentRevision).toBe(copy.headRevision);
    expect(store.run(continued.runId).snapshot.history).toEqual(ancestry);
    expect(store.run(continued.runId).snapshot.profile?.promptPresets).toEqual({});
    expect(store.detail(fixture.chat.id)).toEqual(originalDetail);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('makes repeated keys durable, uses distinct automatic titles and rejects conflicting selections', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Names');
    const first = source(store, chat.id, 'First scene.');
    const second = source(store, chat.id, 'Second scene.');
    const body = { fromRevision: first.id, idempotencyKey: 'stable-command' };
    const a = forkChat(store, chat.id, body);
    const b = forkChat(store, chat.id, { ...body, idempotencyKey: 'second-command' });
    expect([a.title, b.title]).toEqual(['Names · 포크 1', 'Names · 포크 2']);
    expect(forkChat(store, chat.id, body)).toEqual(a);
    expect(() => forkChat(store, chat.id, { ...body, fromRevision: second.id })).toThrow(
      'Fork idempotency key reused'
    );
    expect(() => forkChat(store, chat.id, { ...body, title: 'Different title' })).toThrow(
      'Fork idempotency key reused'
    );
    const item = owned.find((item) => item.store === store)!;
    store.close();
    item.store = undefined;
    const reopened = new Store(join(item.directory, 'story.sqlite'));
    item.store = reopened;
    expect(forkChat(reopened, chat.id, body)).toEqual(a);
    expect(reopened.chats()).toHaveLength(3);
    expect(
      forkChat(reopened, chat.id, {
        fromRevision: first.id,
        idempotencyKey: 'manual',
        title: 'Chosen title',
      }).title
    ).toBe('Chosen title');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('forks a nondefault branch with its owning bot profile without altering that branch', async () => {
    const app = await application();
    const store = app.store;
    const chat = createFixtureChat(store, 'Synthetic story');
    const first = source(store, chat.id, 'Original opening.');
    const main = source(store, chat.id, 'Default continuation.');
    const oldBranch = store.product.createBranch(chat.id, {
      title: 'Alternative branch',
      fromRevision: first.id,
    });
    const alternative = source(store, chat.id, 'Alternative continuation.', oldBranch.id);
    const before = store.detail(chat.id);
    const originalProfile = store.product.snapshot(chat.id)!;
    const copy = await fork(app, chat.id, {
      fromRevision: alternative.id,
      idempotencyKey: 'alternative',
    });
    expect(store.history(copy.headRevision).map((item) => item.text)).toEqual([
      first.text,
      alternative.text,
    ]);
    expect(store.chat(chat.id).headRevision).toBe(main.id);
    const copiedProfile = store.product.snapshot(copy.id)!;
    expect(copiedProfile).toEqual({
      ...originalProfile,
      chatId: copy.id,
      revision: copiedProfile.revision,
    });
    expect(copiedProfile.packageAttachments).toEqual([
      { id: chat.botId, revision: 1, role: 'bot' },
    ]);
    for (const run of store.detail(copy.id).runs) {
      expect(run.snapshot.profile).toEqual(copiedProfile);
      expect(run.snapshot.resources).toEqual(store.product.resources(copy.id, copiedProfile));
    }
    expect(store.detail(chat.id)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects foreign, absent and invalid inputs before creating any copy', async () => {
    const app = await application();
    const store = app.store;
    const a = createFixtureChat(store, 'A');
    const b = createFixtureChat(store, 'B');
    const first = source(store, a.id, 'A source.');
    const foreign = source(store, b.id, 'B source.');
    const before = store.product.export().tables;
    await fork(app, a.id, { fromRevision: foreign.id, idempotencyKey: 'foreign' }, 400);
    await fork(app, a.id, { fromRevision: 'missing', idempotencyKey: 'missing' }, 404);
    for (const body of [
      { fromRevision: null, idempotencyKey: 'null' },
      { fromRevision: first.id },
      { fromRevision: first.id, idempotencyKey: '' },
      { fromRevision: first.id, idempotencyKey: 'extra', extra: true },
      { fromRevision: first.id, idempotencyKey: 'title', title: '' },
    ])
      await fork(app, a.id, body, 400);
    expect(store.product.export().tables).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rolls back chat, profile, resources, assets and copied runs after an actual SQLite insertion failure', async () => {
    const app = await application();
    const store = app.store;
    const fixture = await rich(app);
    const before = store.product.export().tables;
    store.db.exec(
      "CREATE TRIGGER synthetic_fork_failure BEFORE INSERT ON sources BEGIN SELECT RAISE(ABORT,'Synthetic fork transaction failure'); END"
    );
    try {
      expect(() =>
        forkChat(store, fixture.chat.id, {
          fromRevision: fixture.second.id,
          idempotencyKey: 'rollback',
        })
      ).toThrow('Synthetic fork transaction failure');
    } finally {
      store.db.exec('DROP TRIGGER synthetic_fork_failure');
    }
    expect(store.product.export().tables).toEqual(before);
    const copy = forkChat(store, fixture.chat.id, {
      fromRevision: fixture.second.id,
      idempotencyKey: 'rollback',
    });
    expect(store.history(copy.headRevision)).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('round-trips copied source, prompts, translations and assets and accepts provenance without the original chat', async () => {
    const app = await application();
    const store = app.store;
    const fixture = await rich(app);
    const copy = forkChat(store, fixture.chat.id, {
      fromRevision: fixture.second.id,
      idempotencyKey: 'archive',
    });
    const archive = store.product.export();
    const unchanged = JSON.stringify(archive);
    const target = await database();
    expect(target.product.import(archive)).toEqual({ restored: true, chats: 2 });
    expect(JSON.stringify(archive)).toBe(unchanged);
    expect(target.detail(copy.id)).toEqual(store.detail(copy.id));
    expect(target.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const isolated = structuredClone(archive);
    const runIds = new Set(
      isolated.tables.runs.filter((row) => row.chat_id === copy.id).map((row) => row.id)
    );
    const jobIds = new Set(
      isolated.tables.jobs.filter((row) => row.chat_id === copy.id).map((row) => row.id)
    );
    for (const [name, rows] of Object.entries(isolated.tables)) {
      if (name === 'versions' || name === 'package_behavior_entropy') continue;
      isolated.tables[name] = rows.filter((row) =>
        Object.hasOwn(row, 'chat_id')
          ? row.chat_id === copy.id
          : Object.hasOwn(row, 'run_id')
            ? runIds.has(row.run_id)
            : Object.hasOwn(row, 'job_id')
              ? jobIds.has(row.job_id)
              : name === 'chats'
                ? row.id === copy.id
                : false
      );
    }
    const standalone = await database();
    expect(standalone.product.import(isolated)).toEqual({ restored: true, chats: 1 });
    expect(standalone.detail(copy.id)).toEqual(store.detail(copy.id));
    for (const invalid of [
      null,
      { chatId: 'bad/ID', runId: 'run', sourceRevision: 'source' },
      { chatId: 'chat', runId: 'run' },
      { chatId: 'chat', runId: 'run', sourceRevision: 'source', secret: true },
    ]) {
      const forged = structuredClone(isolated);
      const row = forged.tables.runs[0];
      const snapshot = JSON.parse(row.snapshot);
      snapshot.forkedFrom = invalid;
      row.snapshot = JSON.stringify(snapshot);
      const empty = await database();
      expect(() => empty.product.import(forged)).toThrow(HttpError);
      expect(empty.chats()).toEqual([]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
