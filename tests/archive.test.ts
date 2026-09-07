import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store, HttpError } from '../server/store.js';
import { Controls } from '../server/controls.js';
import { auxiliaryBridge } from '../server/auxiliary-bridge.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import type { Content } from '../core/product.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('narrative-m1-archive-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'narrative-m1-archive-'));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
function complete(store: Store, chatId: string, text: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const request = 'Synthetic archive fixture';
  const { run } = store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request,
      history: store.history(current.headRevision),
      resources: store.product.resources(chatId, profile),
      ...(profile ? { profile } : {}),
    })
  );
  store.startRun(run.id);
  return store.completeRun(
    run.id,
    text,
    { modelCalls: 1, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
async function prepared() {
  const store = await database();
  const a = createFixtureChat(store, 'Synthetic archive A');
  const b = createFixtureChat(store, 'Synthetic archive B');
  const lore = store.product.content({
    kind: 'lore',
    title: 'Synthetic lore',
    description: 'A scoped fixture',
    text: 'The distant tower has a green dome.',
    loading: 'discoverable',
    relatedIds: [],
  }) as Content;
  const profile = store.product.profile(a.id);
  store.product.updateProfile(a.id, {
    expectedRevision: profile.revision,
    attachments: [{ id: lore.id, revision: lore.revision }],
    personaReference: profile.personaReference,
    routes: profile.routes,
    image: false,
  });
  const first = complete(store, a.id, 'Mira counted 9 lamps beside `north_gate`.');
  const second = complete(store, b.id, 'The other fictional scene remains isolated.');
  const asset = store.product.createAsset(a.id, {
    title: 'Synthetic pixel',
    mime: 'image/png',
    base64: pixel,
    description: 'A synthetic pixel',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'inline',
  });
  expect(store.detail(a.id).jobs.some((job) => job.kind === 'translation')).toBe(false);
  const job = store.requestTranslation(first.id);
  const controller = new AbortController();
  expect(
    (
      await runAuxiliaryJob(
        auxiliaryBridge(store, new Controls(), controller.signal),
        job.id,
        'archive-worker',
        {
          signal: controller.signal,
          approvedOrigins: [],
          authorize: (c) => c,
          onAttemptStart: () => {
            throw new Error('Unexpected external request');
          },
          onAttemptFinish: () => {},
        }
      )
    )?.status
  ).toBe('completed');
  return { store, a, b, first, second, asset, job, archive: store.product.export() };
}

describe('M1 archive trust boundaries in a fresh file SQLite database', () => {
  test('P11 restores complete protected translation chunks and normalizes asset URLs without mutating input', async () => {
    const original = await prepared();
    const archive = structuredClone(original.archive);
    const row = archive.tables.assets[0];
    const asset = JSON.parse(row.body);
    asset.url = 'https://unapproved.invalid/image';
    row.body = JSON.stringify(asset);
    const before = structuredClone(archive);
    const target = await database();
    expect(target.product.import(archive)).toEqual({ restored: true, chats: 2 });
    expect(archive).toEqual(before);
    expect(target.product.asset(original.asset.id).asset.url).toBe(
      `/api/assets/${original.asset.id}`
    );
    expect(target.job(original.job.id).result).toEqual(original.store.job(original.job.id).result);
    expect(target.product.chunks(original.job.id)).toEqual(
      original.store.product.chunks(original.job.id)
    );
    expect(target.source(original.first.id).hash).toBe(original.first.hash);
    expect(target.queuedJobs()).toEqual([]);
  });

  test('P11 rejects active asset MIME, foreign identity, cross-chat lineage and poisoned frozen references atomically', async () => {
    const source = await prepared();
    const attacks: { name: string; mutate: (archive: typeof source.archive) => void }[] = [
      {
        name: 'active MIME',
        mutate: (a) => {
          const body = JSON.parse(a.tables.assets[0].body);
          body.mime = 'text/html';
          a.tables.assets[0].body = JSON.stringify(body);
        },
      },
      {
        name: 'asset foreign identity',
        mutate: (a) => {
          const body = JSON.parse(a.tables.assets[0].body);
          body.chatId = source.b.id;
          a.tables.assets[0].body = JSON.stringify(body);
        },
      },
      {
        name: 'cross-chat ancestor',
        mutate: (a) => {
          a.tables.sources.find((r) => r.id === source.first.id)!.parent_revision =
            source.second.id;
        },
      },
      {
        name: 'cross-chat branch head',
        mutate: (a) => {
          a.tables.branches.find((r) => r.chat_id === source.a.id)!.head_revision =
            source.second.id;
        },
      },
      {
        name: 'cross-chat job',
        mutate: (a) => {
          const row = a.tables.jobs.find((r) => r.id === source.job.id)!;
          row.source_revision = source.second.id;
          row.source_hash = source.second.hash;
        },
      },
      {
        name: 'forged frozen resource',
        mutate: (a) => {
          const row = a.tables.runs.find((r) => r.id === source.first.runId)!;
          const s = JSON.parse(row.snapshot);
          s.resources[0].text = 'FORGED_NEW_FACT';
          row.snapshot = JSON.stringify(s);
        },
      },
      {
        name: 'forged source history',
        mutate: (a) => {
          const row = a.tables.runs.find((r) => r.id === source.first.runId)!;
          const s = JSON.parse(row.snapshot);
          s.history = [{ revision: source.second.id, text: source.second.text }];
          row.snapshot = JSON.stringify(s);
        },
      },
    ];
    for (const attack of attacks) {
      const archive = structuredClone(source.archive);
      attack.mutate(archive);
      const before = structuredClone(archive);
      const target = await database();
      let error: unknown;
      try {
        target.product.import(archive);
      } catch (caught) {
        error = caught;
      }
      expect(error, attack.name).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode, attack.name).toBe(400);
      expect(target.chats(), attack.name).toEqual([]);
      expect(target.product.assets(), attack.name).toEqual([]);
      expect(archive, attack.name).toEqual(before);
    }
  });

  test('P08 P11 rejects poisoned persisted plan bodies, missing returned coverage and changed protected spans', async () => {
    const source = await prepared();
    const attacks: { name: string; mutate: (a: typeof source.archive) => void }[] = [
      {
        name: 'plan payload',
        mutate: (a) => {
          const row = a.tables.jobs.find((r) => r.id === source.job.id)!;
          const plan = JSON.parse(row.plan);
          plan.chunks[0].blocks[0].text = 'UNRELATED_SOURCE_BUT_GENUINE_HASH';
          row.plan = JSON.stringify(plan);
        },
      },
      {
        name: 'chunk coverage',
        mutate: (a) => {
          const row = a.tables.job_chunks.find((r) => r.job_id === source.job.id)!;
          const result = JSON.parse(row.result);
          result.segments[0].anchors = [];
          row.result = JSON.stringify(result);
        },
      },
      {
        name: 'protected numeric value',
        mutate: (a) => {
          const row = a.tables.job_chunks.find((r) => r.job_id === source.job.id)!;
          const result = JSON.parse(row.result);
          result.segments[0].text = result.segments[0].text.replace('9 lamps', '99 lamps');
          row.result = JSON.stringify(result);
        },
      },
    ];
    for (const attack of attacks) {
      const archive = structuredClone(source.archive);
      attack.mutate(archive);
      const target = await database();
      expect(() => target.product.import(archive), attack.name).toThrow();
      expect(target.chats(), attack.name).toEqual([]);
      expect(target.db.prepare('SELECT count(*) AS n FROM job_chunks').get(), attack.name).toEqual({
        n: 0,
      });
    }
  });
});
