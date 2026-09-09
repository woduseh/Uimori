import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { readerActivities, readerDetail, readerRuns } from '../server/reader.js';
import type { Store } from '../server/store.js';
import type { RunSnapshot } from '../core/types.js';

const owned: { app: App; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of owned.splice(0)) {
    await app.close();
    const target = resolve(directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-reader-tests-')
    )
      throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-reader-tests-'));
  const app = await createApp({
    dbPath: join(directory, 'reader.sqlite'),
    buildId: 'reader-test',
    testMode: true,
  });
  owned.push({ app, directory });
  return app;
}
test('new chats leave automatic status off until explicitly enabled', async () => {
  const app = await setup();
  const chat = createFixtureChat(app.store, 'Synthetic initial settings');
  expect(chat.settings.status).toBe(false);
  const result = source(app.store, chat.id);
  expect(app.store.chat(chat.id).settingsRevision).toBe(1);
  expect(
    app.store.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE source_revision=? AND kind='status'")
      .get(result.id)
  ).toEqual({ count: 0 });
});
function source(store: Store, chatId: string, text = 'Synthetic paragraph.', branchId?: string) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId, branchId);
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic request',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
      branchId,
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic request',
      history: store.history(current.headRevision),
      resources: [],
    })
  ).run;
  store.startRun(run.id);
  return store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
function readerSourceBatch(store: Store, chatId: string, texts: string[]) {
  // This scale case checks persisted reader projection, not prompt compilation.
  // Seed typed run snapshots once per source, retaining their complete ancestry;
  // source hashing, branch updates and auxiliary reservations still use the host.
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId),
    history: RunSnapshot['history'] = store.history(branch.headRevision);
  const insert = store.db.prepare(
    "INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at,branch_id) VALUES(?,?,?,'running',?,?,?,?,?,?,?)"
  );
  return store.transaction(() =>
    texts.map((text, index) => {
      // Give this ordered fixture distinct timestamps; same-millisecond UUID ties are unordered.
      const runId = randomUUID(),
        time = new Date(Date.UTC(2020, 0, 1) + index).toISOString(),
        parentRevision = history.at(-1)?.revision ?? null;
      const snapshot: RunSnapshot = {
        chatId,
        parentRevision,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        request: 'Synthetic request',
        history,
        resources: [],
        branchId: branch.id,
      };
      insert.run(
        runId,
        chatId,
        parentRevision,
        snapshot.request,
        JSON.stringify(snapshot),
        runId,
        JSON.stringify({
          request: snapshot.request,
          expectedRevision: parentRevision,
          expectedSettingsRevision: chat.settingsRevision,
          branchId: branch.id,
        }),
        time,
        time,
        branch.id
      );
      store.event(chatId, 'run.queued', runId);
      store.event(chatId, 'run.running', runId);
      const completed = store.completeRunInTransaction(
        runId,
        text,
        { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
        chat.settings
      );
      history.push({ revision: completed.id, text, contentHash: completed.hash });
      return completed;
    })
  );
}

test('100-source HTTP reader pages retain order while execution snapshot and full detail stay intact', async () => {
  const app = await setup(),
    store = app.store,
    chat = createFixtureChat(store, '100 synthetic sources');
  const sources = readerSourceBatch(
    store,
    chat.id,
    Array.from({ length: 100 }, (_, i) => `Synthetic source ${i}.`)
  );
  const frozen = store.run(sources[99].runId).snapshot;
  const full = store.detail(chat.id);
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  let next: string | null = null;
  const collected: string[] = [];
  do {
    const response: { statusCode: number; body: string; json(): ReturnType<typeof readerDetail> } =
      await injectWithFixtureBot(app, {
        method: 'GET',
        url: `/api/chats/${chat.id}/reader${next ? '?source=' + next : ''}`,
      });
    expect(response.statusCode, response.body).toBe(200);
    const page: ReturnType<typeof readerDetail> = response.json();
    expect(page.sources).toHaveLength(5);
    expect(page.runs.map((run) => run.id).sort()).toEqual(
      page.sources.map((source) => source.runId).sort()
    );
    expect(page.reader.total).toBe(100);
    expect(page.reader.navigation).toEqual(
      sources.map((item, index) => ({
        id: item.id,
        number: index + 1,
        label: 'Synthetic request',
      }))
    );
    expect(page.sources.map((s: { id: string }) => s.id)).toEqual(page.reader.order);
    expect(
      page.runs.every(
        (r: { snapshot: Record<string, unknown> }) =>
          !('history' in r.snapshot) &&
          !('resources' in r.snapshot) &&
          !('inputs' in r) &&
          !('toolEvents' in r)
      )
    ).toBe(true);
    collected.push(...page.reader.order);
    next = page.reader.next;
  } while (next);
  expect(collected).toEqual(sources.map((s) => s.id));
  expect(store.detail(chat.id)).toEqual(full);
  const taskResponse = await injectWithFixtureBot(app, {
    method: 'GET',
    url: `/api/chats/${chat.id}/reader-runs`,
  });
  expect(taskResponse.statusCode).toBe(200);
  expect(taskResponse.json()).toHaveLength(100);
  expect(taskResponse.json()).toEqual(JSON.parse(JSON.stringify(readerRuns(store, chat.id))));
  expect(store.run(sources[99].runId).snapshot).toEqual(frozen);
  expect(frozen.history).toHaveLength(99);
  expect(frozen.history).toEqual(
    sources.slice(0, -1).map((item) => ({
      revision: item.id,
      text: item.text,
      contentHash: item.hash,
    }))
  );
});

test('source cursors and supplied known IDs cannot cross branch or chat boundaries', async () => {
  const { store } = await setup(),
    chat = createFixtureChat(store, 'Branch scope');
  const root = source(store, chat.id),
    main = source(store, chat.id);
  const branch = store.product.createBranch(chat.id, {
    title: 'Independent branch',
    fromRevision: root.id,
  });
  const child = source(store, chat.id, 'Branch child', branch.id);
  const other = source(store, createFixtureChat(store, 'Other chat').id);
  expect(readerDetail(store, chat.id, { branch: branch.id }).reader.order).toEqual([
    root.id,
    child.id,
  ]);
  expect(readerDetail(store, chat.id, {}).reader.order).toEqual([root.id, main.id]);
  expect(
    readerDetail(store, chat.id, { branch: branch.id }).reader.navigation.map((item) => item.id)
  ).toEqual([root.id, child.id]);
  expect(readerDetail(store, chat.id, {}).reader.navigation.map((item) => item.id)).toEqual([
    root.id,
    main.id,
  ]);
  for (const id of [main.id, other.id])
    expect(() => readerDetail(store, chat.id, { branch: branch.id, source: id })).toThrow(
      'Source is not in this branch'
    );
  const first = readerDetail(store, chat.id, { branch: branch.id });
  expect(
    readerDetail(store, chat.id, {
      branch: branch.id,
      since: String(first.reader.cursor),
      known: other.id,
    }).sources.map((s) => s.id)
  ).toEqual([root.id, child.id]);
});

test('reader scopes long Run details while retaining unresolved work, candidate order and full task access', async () => {
  const app = await setup(),
    store = app.store;
  const chat = createFixtureChat(store, 'Scoped run summaries');
  const items = readerSourceBatch(
    store,
    chat.id,
    Array.from({ length: 40 }, (_, i) => `Scene ${i}`)
  );
  const request = 'A long synthetic request. '.repeat(100);
  store.db.prepare('UPDATE runs SET request=? WHERE chat_id=?').run(request, chat.id);
  const attempt =
    store.db.prepare(`INSERT INTO attempts(id,chat_id,run_id,role,connection_id,model_id,status,request,response)
    VALUES(?,?,?,?,'synthetic','synthetic','completed','{}',?)`);
  for (const [runId, role, cost] of [
    [items[0].runId, 'main', { status: 'estimated', usd: 0.25 }],
    [items[0].runId, 'main', { status: 'unavailable', usd: null, subtotalUsd: 0.1 }],
    [items[0].runId, 'title', { status: 'estimated', usd: 99 }],
    [items[39].runId, 'main', { status: 'estimated', usd: 7 }],
  ] as const)
    attempt.run(randomUUID(), chat.id, runId, role, JSON.stringify({ estimatedCost: cost }));
  const branch = store.product.createBranch(chat.id, {
    title: '후보 분기',
    fromRevision: items[20].id,
  });
  const candidate = source(store, chat.id, 'Candidate scene', branch.id);
  store.db
    .prepare("UPDATE runs SET snapshot=json_set(snapshot,'$.candidateOf',?) WHERE id=?")
    .run(items[20].runId, candidate.runId);
  const pendingId = randomUUID();
  store.db
    .prepare(`INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at,branch_id)
    SELECT ?,chat_id,parent_revision,'failed','Unresolved request',snapshot,?,'{}','1970-01-01','1970-01-01',branch_id FROM runs WHERE id=?`)
    .run(pendingId, randomUUID(), items[39].runId);
  const page = readerDetail(store, chat.id, {});
  expect(page.runs).toHaveLength(6);
  expect(page.runs.find((run) => run.id === items[0].runId)?.estimatedCost).toEqual({
    usd: null,
    subtotalUsd: 0.35,
    unknownCount: 1,
    attemptCount: 2,
  });
  expect(page.runs.find((run) => run.id === pendingId)?.request).toBe('Unresolved request');
  expect(page.runs.some((run) => run.id === items[39].runId)).toBe(false);
  expect(
    page.runs.filter((run) => run.sourceRevision).every((run) => run.request === request)
  ).toBe(true);
  expect(page.reader.latestBranchRuns[`main:${chat.id}`]).toBe(items[39].runId);
  expect(page.reader.candidateBranches).toEqual([branch.id]);
  expect(readerRuns(store, chat.id)).toHaveLength(42);
  const delta = readerDetail(store, chat.id, {
    since: String(page.reader.cursor),
    known: page.reader.order.join(','),
  });
  expect(delta.runs).toEqual(page.runs);
  expect(delta.sources).toEqual([]);
  const last = readerDetail(store, chat.id, { source: items[39].id });
  expect(last.runs.find((run) => run.id === items[39].runId)?.request).toBe(request);
  expect(last.runs.find((run) => run.id === items[39].runId)?.estimatedCost?.usd).toBe(7);
  expect(last.runs.some((run) => run.id === items[0].runId)).toBe(false);
  expect(last.reader.candidateBranches).toEqual(page.reader.candidateBranches);
  expect(Buffer.byteLength(JSON.stringify(page.runs))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(readerRuns(store, chat.id))) / 3
  );
});

test('delta includes current edited source and matching latest translation only, with unchanged assets omitted', async () => {
  const { store } = await setup(),
    chat = createFixtureChat(store, 'Delta');
  const a = source(store, chat.id),
    b = source(store, chat.id);
  const manual = store.editTranslation(a.id, {
    text: 'Original translation',
    expectedRevision: 0,
    expectedSourceHash: a.hash,
  });
  const first = readerDetail(store, chat.id, {}),
    known = first.reader.order.join(',');
  expect(first).toHaveProperty('assets');
  const idle = readerDetail(store, chat.id, { since: String(first.reader.cursor), known });
  expect(idle.sources).toEqual([]);
  expect(idle.jobs).toEqual([]);
  expect(idle.reader.navigation).toEqual(first.reader.navigation);
  expect(idle).not.toHaveProperty('assets');
  const edited = store.editSource(a.id, { text: 'Revised source', expectedRevision: 0 });
  const changed = readerDetail(store, chat.id, { since: String(first.reader.cursor), known });
  expect(changed.sources.map((s) => s.id)).toEqual([a.id]);
  expect(changed.sources[0].hash).toBe(edited.hash);
  expect(changed.jobs.some((job) => job.id === manual.id)).toBe(false);
  const translated = store.editTranslation(a.id, {
    text: 'Current translation',
    expectedRevision: edited.translationRevision!,
    expectedSourceHash: edited.hash,
  });
  const delta = readerDetail(store, chat.id, { since: String(changed.reader.cursor), known });
  expect(delta.sources.map((s) => s.id)).toEqual([a.id]);
  expect(delta.sources.some((s) => s.id === b.id)).toBe(false);
  expect(delta.jobs.find((j) => j.id === translated.id)?.result?.text).toBe('Current translation');
  expect(delta.jobs.every((j) => j.sourceHash === edited.hash)).toBe(true);
  expect(delta.jobs.every((j) => !('input' in j))).toBe(true);
  store.event(chat.id, 'asset.created', 'synthetic-asset-event');
  expect(
    readerDetail(store, chat.id, { since: String(delta.reader.cursor), known })
  ).toHaveProperty('assets');
});

test('navigation labels use bounded requests and never authored, generated, or edited source bodies', async () => {
  const { store } = await setup(),
    chat = createFixtureChat(store, 'Navigation labels');
  const items = Array.from({ length: 7 }, (_, index) =>
    source(store, chat.id, `Hidden source body ${index}`)
  );
  const request = store.db.prepare('UPDATE runs SET request=? WHERE id=?');
  request.run('  Request\n\twith   whitespace  ', items[1].runId);
  request.run('🙂'.repeat(110), items[2].runId);
  request.run(' \n ', items[3].runId);
  request.run('🙂'.repeat(100), items[4].runId);
  request.run('a' + '🙂'.repeat(100), items[5].runId);
  store.db
    .prepare(
      "UPDATE runs SET snapshot=json_set(snapshot,'$.packageStart',json(?)),request=? WHERE id=?"
    )
    .run(
      JSON.stringify({ mode: 'authored', title: 'Private authored title' }),
      'Private start content',
      items[0].runId
    );
  store.editSource(items[6].id, { text: 'Private edited hidden source body', expectedRevision: 0 });
  const page = readerDetail(store, chat.id, {});
  expect(page.sources).toHaveLength(5);
  expect(page.reader.navigation).toHaveLength(7);
  expect(page.reader.navigation.map((item) => item.label)).toEqual([
    '시작 장면',
    'Request with whitespace',
    `${'🙂'.repeat(99)}…`,
    '장면 4',
    '🙂'.repeat(100),
    `a${'🙂'.repeat(98)}…`,
    'Synthetic request',
  ]);
  expect(
    page.reader.navigation.every((item) => Object.keys(item).sort().join(',') === 'id,label,number')
  ).toBe(true);
  const serialized = JSON.stringify(page.reader.navigation);
  for (const body of [
    'Hidden source body',
    'Private edited hidden source body',
    'Private start content',
    'Private authored title',
  ])
    expect(serialized).not.toContain(body);
  const last = readerDetail(store, chat.id, { source: items[6].id });
  expect(last.reader.navigation).toEqual(page.reader.navigation);
  expect(last.reader.order).toContain(items[6].id);
});

test('new source joins an incomplete last page on delta and another chat does not dirty it', async () => {
  const { store } = await setup(),
    chat = createFixtureChat(store, 'Last page');
  const items = Array.from({ length: 6 }, () => source(store, chat.id));
  const first = readerDetail(store, chat.id, { source: items[5].id });
  source(store, createFixtureChat(store, 'Other chat activity').id);
  expect(
    readerDetail(store, chat.id, {
      source: items[5].id,
      since: String(first.reader.cursor),
      known: items[5].id,
    }).sources
  ).toEqual([]);
  const added = source(store, chat.id);
  const delta = readerDetail(store, chat.id, {
    source: items[5].id,
    since: String(first.reader.cursor),
    known: items[5].id,
  });
  expect(delta.reader.order).toEqual([items[5].id, added.id]);
  expect(delta.sources.map((s) => s.id)).toEqual([added.id]);
});

test('HTTP reader rejects invalid or future cursors', async () => {
  const app = await setup(),
    chat = createFixtureChat(app.store, 'Cursor validation');
  for (const cursor of ['-1', 'NaN', '1.5', '9007199254740992', '1']) {
    const response = await injectWithFixtureBot(app, {
      method: 'GET',
      url: `/api/chats/${chat.id}/reader?since=${cursor}`,
    });
    expect(response.statusCode, response.body).toBe(400);
  }
  expect(
    (
      await injectWithFixtureBot(app, {
        method: 'GET',
        url: `/api/chats/${chat.id}/reader?since=0`,
      })
    ).statusCode
  ).toBe(200);
});

test('restoring any source retains its whole fixed page, including all of a short chat', async () => {
  const { store } = await setup(),
    chat = createFixtureChat(store, 'Restore fixed pages');
  const items = Array.from({ length: 3 }, () => source(store, chat.id));
  const short = readerDetail(store, chat.id, { source: items[2].id });
  expect(short.reader.order).toEqual(items.map((s) => s.id));
  expect(short.reader.start).toBe(0);
  expect(short.reader.previous).toBeNull();
  items.push(...Array.from({ length: 9 }, () => source(store, chat.id)));
  for (const index of [1, 4, 6, 9, 11]) {
    const page = readerDetail(store, chat.id, { source: items[index].id });
    const start = Math.floor(index / 5) * 5;
    expect(page.reader.start).toBe(start);
    expect(page.reader.order).toEqual(items.slice(start, start + 5).map((s) => s.id));
    expect(page.reader.order).toContain(items[index].id);
    expect(page.reader.latest).toBe(items[10].id);
  }
});

test('activity remains page independent and retains active work beyond the terminal limit', async () => {
  const { store } = await setup(),
    chat = createFixtureChat(store, 'Activity');
  store.settings(chat.id, chat.settingsRevision, { ...chat.settings, status: true });
  const items = Array.from({ length: 35 }, () => source(store, chat.id));
  const first = readerDetail(store, chat.id, {});
  const activities = first.reader.activity;
  expect(
    activities.filter((a) => !['queued', 'running', 'waiting_for_state'].includes(a.status))
  ).toHaveLength(30);
  const active = activities.filter((a) => ['queued', 'running'].includes(a.status));
  expect(active.length).toBeGreaterThan(30);
  expect(active.some((a) => a.sourceRevision === items[34].id)).toBe(true);
  expect(
    readerDetail(store, chat.id, {
      since: String(first.reader.cursor),
      known: first.reader.order.join(','),
    }).reader.activity
  ).toEqual(activities);
  const other = source(store, createFixtureChat(store, 'Other activity').id);
  expect(readerDetail(store, chat.id, {}).reader.activity.some((a) => a.id === other.runId)).toBe(
    false
  );
  expect(Object.keys(activities[0]).sort()).toEqual(
    [
      'id',
      'kind',
      'status',
      'createdAt',
      'updatedAt',
      'startedAt',
      'finishedAt',
      'branchId',
      'sourceRevision',
      'generation',
      'sourceHash',
      'superseded',
      'executionUncertain',
    ].sort()
  );
});

test('activity completion time ignores subsequent usage updates and retries restart queue time', async () => {
  const { store } = await setup(),
    chat = createFixtureChat(store, 'Activity time');
  store.settings(chat.id, chat.settingsRevision, { ...chat.settings, status: true });
  const item = source(store, chat.id);
  const before = readerDetail(store, chat.id, {}).reader.activity.find((a) => a.id === item.runId)!;
  store.db
    .prepare('UPDATE runs SET updated_at=? WHERE id=?')
    .run('2099-01-01T00:00:00.000Z', item.runId);
  const after = readerDetail(store, chat.id, {}).reader.activity.find((a) => a.id === item.runId)!;
  expect(after.finishedAt).toBe(before.finishedAt);
  const job = readerDetail(store, chat.id, {}).reader.activity.find((a) => a.kind !== 'main')!;
  store.db
    .prepare("UPDATE events SET at=? WHERE entity_id=? AND kind='job.queued'")
    .run('2026-09-08T12:00:00.000Z', job.id);
  const restarted = readerDetail(store, chat.id, {}).reader.activity.find((a) => a.id === job.id)!;
  expect(restarted.startedAt).toBe('2026-09-08T12:00:00.000Z');
  expect(restarted.finishedAt).toBeNull();
});

test('response activity retains older page work without expanding global activity or other pages', async () => {
  const { store } = await setup(),
    chat = createFixtureChat(store, 'Response activity');
  store.settings(chat.id, chat.settingsRevision, { ...chat.settings, status: true });
  const items = Array.from({ length: 35 }, () => source(store, chat.id));
  store.db
    .prepare("UPDATE jobs SET status='completed',updated_at='2000-01-01' WHERE chat_id=?")
    .run(chat.id);
  store.db
    .prepare("INSERT INTO story_configs(chat_id,revision,body) VALUES(?,1,'{}')")
    .run(chat.id);
  const storyJob = (index: number, kind: 'state', hash = items[index].hash): string => {
    const id = randomUUID();
    store.db
      .prepare(`INSERT INTO story_jobs(id,chat_id,source_revision,source_hash,kind,config_revision,status,snapshot,mock,created_at,updated_at,dependency_key)
      VALUES(?,?,?,?,?,1,'completed','{}',1,'2000-01-01','2000-01-01',?)`)
      .run(id, chat.id, items[index].id, hash, kind, id);
    return id;
  };
  const state = storyJob(0, 'state'),
    secondState = storyJob(0, 'state'),
    offPage = storyJob(5, 'state'),
    stale = storyJob(0, 'state', 'stale-hash');
  const page = readerDetail(store, chat.id, {});
  expect(page.reader.activity).toHaveLength(30);
  expect(page.reader.activity.some((a) => [state, secondState, offPage].includes(a.id))).toBe(
    false
  );
  const activity = page.reader.responseActivity;
  expect(activity.some((a) => a.id === state)).toBe(true);
  expect(activity.some((a) => a.id === secondState)).toBe(true);
  expect(activity.some((a) => [offPage, stale].includes(a.id))).toBe(false);
  expect(activity.every((a) => page.reader.order.includes(a.sourceRevision!))).toBe(true);
  expect(new Set(activity.map((a) => a.id)).size).toBe(activity.length);
  const delta = readerDetail(store, chat.id, {
    since: String(page.reader.cursor),
    known: page.reader.order.join(','),
  });
  expect(delta.sources).toEqual([]);
  expect(delta.reader.responseActivity).toEqual(activity);
  const next = readerDetail(store, chat.id, { source: items[5].id });
  expect(next.reader.responseActivity.some((a) => a.id === offPage)).toBe(true);
  expect(next.reader.responseActivity.some((a) => [state, secondState].includes(a.id))).toBe(false);
  expect(next.reader.activity).toEqual(page.reader.activity);

  const oldJobs = store.db
    .prepare('SELECT id FROM jobs WHERE source_revision=?')
    .all(items[0].id) as { id: string }[];
  expect(oldJobs.length).toBeGreaterThan(0);
  const edited = store.editSource(items[0].id, { text: 'Edited response', expectedRevision: 0 });
  const currentState = storyJob(0, 'state', edited.hash);
  const editedActivity = readerDetail(store, chat.id, {}).reader.responseActivity;
  expect(
    editedActivity.some((a) => [state, secondState, ...oldJobs.map((j) => j.id)].includes(a.id))
  ).toBe(false);
  expect(editedActivity.some((a) => a.id === currentState)).toBe(true);
  expect(editedActivity.some((a) => a.id === items[0].runId)).toBe(true);
});

test('activity history pages past recent thirty and validates chat-scoped cursors', async () => {
  const app = await setup();
  const chat = createFixtureChat(app.store, 'Activity pagination');
  for (let i = 0; i < 35; i++) source(app.store, chat.id);
  expect(readerDetail(app.store, chat.id, {}).reader.activity).toHaveLength(30);
  const first = readerActivities(app.store, chat.id, { limit: '20' });
  expect(first.items).toHaveLength(20);
  expect(first.nextCursor).not.toBeNull();
  const second = readerActivities(app.store, chat.id, { before: first.nextCursor!, limit: '20' });
  expect(second.items).toHaveLength(15);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(35);
  const other = createFixtureChat(app.store, 'Other activity');
  expect(() => readerActivities(app.store, other.id, { before: first.nextCursor! })).toThrow(
    'Invalid activity cursor'
  );
  for (const query of ['limit=101', 'limit=0', 'before=bad']) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/activities?${query}`,
    });
    expect(response.statusCode).toBe(400);
  }
  const response = await app.inject({
    method: 'GET',
    url: `/api/chats/${chat.id}/activities?limit=20`,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(first);
});

test('translation resolution uses same source hash and revision beyond the recent window', async () => {
  const { store } = await setup();
  const chat = createFixtureChat(store, 'Activity resolution');
  store.settings(chat.id, chat.settingsRevision, { ...chat.settings, status: true });
  const item = source(store, chat.id);
  const original = store.db.prepare('SELECT id FROM jobs WHERE source_revision=?').get(item.id) as {
    id: string;
  };
  store.db
    .prepare(
      "UPDATE jobs SET kind='translation',status='failed',updated_at='2099-01-01' WHERE id=?"
    )
    .run(original.id);
  const insert = store.db.prepare(
    "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,created_at,updated_at) VALUES(?,?,?,?,'translation','completed',?,'2000-01-01','2000-01-01')"
  );
  insert.run(randomUUID(), chat.id, item.id, 'other-hash', 2);
  expect(
    readerDetail(store, chat.id, {}).reader.activity.find((a) => a.id === original.id)?.superseded
  ).toBe(false);
  insert.run(randomUUID(), chat.id, item.id, item.hash, 3);
  for (let i = 0; i < 35; i++) source(store, chat.id);
  const activity = readerDetail(store, chat.id, {}).reader.activity;
  expect(activity.find((a) => a.id === original.id)).toMatchObject({
    superseded: true,
    sourceHash: item.hash,
  });
  expect(activity.some((a) => a.kind === 'translation' && a.status === 'completed')).toBe(false);
  for (const status of ['partial', 'stale']) {
    store.db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, original.id);
    expect(
      readerActivities(store, chat.id, {}).items.find((a) => a.id === original.id)
    ).toMatchObject({ superseded: true, executionUncertain: false });
  }
  store.db
    .prepare("UPDATE jobs SET status='failed',error='AUXILIARY_PROVIDER_UNCERTAIN' WHERE id=?")
    .run(original.id);
  expect(
    readerActivities(store, chat.id, {}).items.find((a) => a.id === original.id)
  ).toMatchObject({ superseded: false, executionUncertain: true });
  store.db.prepare("UPDATE jobs SET status='interrupted' WHERE id=?").run(original.id);
  expect(
    readerActivities(store, chat.id, {}).items.find((a) => a.id === original.id)
  ).toMatchObject({ superseded: false, executionUncertain: true });
});
