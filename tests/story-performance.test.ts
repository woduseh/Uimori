import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  tmpdir,
  totalmem,
} from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { buildMainInput, executeTool } from '../core/provider.js';
import { memoryHash } from '../core/memory.js';
import { resolveAsset, searchAssets } from '../core/asset-manifest.js';
import type { RunSnapshot } from '../core/types.js';
import type { Content } from '../core/product.js';

const owned: { directory: string; store: Store }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('External provider calls forbidden in synthetic S07 measurements')
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    const path = resolve(item.directory);
    const inside = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !basename(path).startsWith('Uimori S07 measured ')
    )
      throw new Error('Refusing cleanup outside owned synthetic performance directory');
    await rm(path, { recursive: true, force: true });
  }
});
const SAMPLE_COUNT = 5;
const WARMUP_COUNT = 1;
const baseline = { archivedSources: 10, loreCount: 50, manuscriptChars: 10000, assetCount: 10 };
type Counts = typeof baseline;
type Dimension = keyof Counts;
const dimensions: { dimension: Dimension; larger: number }[] = [
  { dimension: 'archivedSources', larger: 1000 },
  { dimension: 'loreCount', larger: 500 },
  { dimension: 'manuscriptChars', larger: 200000 },
  { dimension: 'assetCount', larger: 1000 },
];
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const manuscript = (length: number) =>
  `old-source-begin\n${'Synthetic scene. '.repeat(Math.ceil(length / 17))}`.slice(0, length - 17) +
  '\nold-source-end!!';
const fixedSettings = {
  preset: 'calm' as const,
  mode: 'direct' as const,
  translation: false,
  status: false,
  maxCalls: 8,
};

function source(store: Store, chatId: string, text: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const request = 'Synthetic source insertion; no model execution.';
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) =>
      ({
        chatId,
        request,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        history: store.history(current.headRevision),
        resources: store.product.resources(chatId, profile),
        profile,
      }) satisfies RunSnapshot
  ).run;
  store.startRun(run.id);
  return store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
function addArchived(store: Store, chatId: string, start: number, end: number) {
  // These are complete, off-ancestry storage fixtures, not an assertion about an archive UI operation.
  // Bulk seeding is outside the measured region; each real SQLite row preserves chat/source/run references.
  const time = new Date(0).toISOString();
  const profile = store.product.snapshot(chatId);
  const snapshot: RunSnapshot = {
    chatId,
    request: 'Archived synthetic fixture.',
    parentRevision: null,
    settingsRevision: store.chat(chatId).settingsRevision,
    settings: fixedSettings,
    history: [],
    resources: store.product.resources(chatId, profile),
    profile,
  };
  store.transaction(() => {
    for (let index = start; index < end; index++) {
      const runId = `archived-run-${index}`;
      const id = `archived-source-${index}`;
      const text = `Unrelated archived candidate ${index}. ${'Unselected source text. '.repeat(40)}`;
      store.db
        .prepare(
          "INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,source_revision,created_at,updated_at,branch_id) VALUES(?,?,NULL,'completed',?,?,?,?,?,?,?,?)"
        )
        .run(
          runId,
          chatId,
          snapshot.request,
          JSON.stringify(snapshot),
          `archive-key-${index}`,
          '{}',
          id,
          time,
          time,
          `main:${chatId}`
        );
      store.db
        .prepare(
          'INSERT INTO sources(id,chat_id,run_id,parent_revision,text,hash,created_at) VALUES(?,?,?,NULL,?,?,?)'
        )
        .run(id, chatId, runId, text, memoryHash(text), time);
    }
  });
}
function addLore(store: Store, chatId: string, start: number, end: number) {
  const owner = store.product.get<Content>('content', store.chat(chatId).botId);
  const saved = store.product.content(
    {
      kind: owner.kind,
      title: owner.title,
      description: owner.description,
      text: owner.text,
      loading: owner.loading,
      relatedIds: owner.relatedIds,
      expectedRevision: owner.revision,
      package: {
        ...owner.package!,
        lore: [
          ...owner.package!.lore,
          ...Array.from({ length: end - start }, (_, offset) => {
            const index = start + offset;
            return {
              id: `lore-${String(index).padStart(4, '0')}`,
              title: `Synthetic lore ${index}`,
              description: 'Discoverable local lore description.',
              loading: 'discoverable' as const,
              text: `needle-lore-${index} ${'Local fictional context. '.repeat(20)}`,
            };
          }),
        ],
      },
    },
    owner.id
  );
  const { chatId: _chatId, revision, ...profile } = store.product.profile(chatId);
  store.product.updateProfile(chatId, {
    ...profile,
    expectedRevision: revision,
    packageAttachments: profile.packageAttachments!.map((attachment) =>
      attachment.id === owner.id ? { ...attachment, revision: saved.revision } : attachment
    ),
  });
}
function addAssets(store: Store, chatId: string, start: number, end: number) {
  store.transaction(() => {
    for (let index = start; index < end; index++)
      store.product.createAsset(chatId, {
        title: `asset-marker-${index}`,
        mime: 'image/png',
        base64: pixel,
        description: 'Synthetic one-pixel image metadata.',
        actor: 'Alice',
        outfit: 'raincoat',
        location: 'harbor',
        allowedUse: 'inline',
      });
  });
}
function indexAll(store: Store, chatId: string) {
  for (const job of store.story.indexHistory(chatId)) {
    if (job.status === 'completed') continue;
    const claim = store.story.claim(job.id, 'S07-no-facts-fixture');
    expect(claim).not.toBeNull();
    const result = store.story.finish(job.id, claim!.generation, 'S07-no-facts-fixture', {
      status: 'completed',
      result: { entries: [] },
      error: null,
      mock: true,
    });
    expect(result.status).toBe('completed');
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori S07 measured '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  const chat = createFixtureChat(store, 'Synthetic performance fixture');
  store.settings(chat.id, chat.settingsRevision, fixedSettings);
  const first = source(store, chat.id, manuscript(baseline.manuscriptChars));
  for (let index = 1; index < 6; index++)
    source(store, chat.id, `Active source ${index}: ${'Recent concrete scene. '.repeat(12)}`);
  store.story.saveConfig(chat.id, {
    expectedRevision: 0,
    module: null,
    stateModel: null,
    memory: { enabled: true, model: null, recentCount: 2, maxPacketChars: 60000 },
  });
  indexAll(store, chat.id);
  addArchived(store, chat.id, 0, baseline.archivedSources);
  addLore(store, chat.id, 0, baseline.loreCount);
  addAssets(store, chat.id, 0, baseline.assetCount);
  return {
    directory,
    store,
    chatId: chat.id,
    firstRevision: first.id,
    originalText: first.text,
    head: store.chat(chat.id).headRevision!,
  };
}

type Timing = {
  contextMs: number;
  storySearchMs: number;
  sourceRoundtripMs: number;
  loreReadMs: number;
  assetMetadataMs: number;
  totalMs: number;
};
function measuredPath(f: Awaited<ReturnType<typeof fixture>>, counts: Counts) {
  const { store, chatId, head, firstRevision } = f;
  const start = performance.now();
  const current = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const snapshot: RunSnapshot = {
    chatId,
    request: 'Continue the same synthetic active path.',
    parentRevision: head,
    settingsRevision: current.settingsRevision,
    settings: current.settings,
    history: store.history(head),
    resources: store.product.resources(chatId, profile),
    profile,
  };
  snapshot.story = store.story.prepare(snapshot);
  const input = buildMainInput(snapshot);
  const contextEnd = performance.now();
  const search = executeTool(snapshot, {
    callId: 'old-search',
    name: 'story.search',
    args: { query: 'old-source-end!!', limit: 5 },
  });
  const searchEnd = performance.now();
  let offset: number | null = 0;
  let roundtrip = '';
  let pages = 0;
  while (offset !== null) {
    const read = executeTool(snapshot, {
      callId: `old-read-${pages}`,
      name: 'story.read',
      args: { id: firstRevision, offset, limit: 8192 },
    });
    if (read.denied) throw new Error('Synthetic source read denied');
    const result = read.result as {
      text: string;
      nextOffset: number | null;
      source: { hash: string };
    };
    roundtrip += result.text;
    offset = result.nextOffset;
    pages++;
  }
  const readEnd = performance.now();
  const loreSearch = executeTool(snapshot, {
    callId: 'lore-search',
    name: 'knowledge.search',
    args: { query: `needle-lore-${counts.loreCount - 1}`, limit: 5 },
  });
  const loreRead = executeTool(snapshot, {
    callId: 'lore-read',
    name: 'knowledge.read',
    args: {
      id: snapshot.resources.find((resource) =>
        resource.id.endsWith(`:lore-${String(counts.loreCount - 1).padStart(4, '0')}`)
      )!.id,
      limit: 8192,
    },
  });
  const loreEnd = performance.now();
  const assets = store.product.assets(chatId);
  const assetSearch = searchAssets(assets, {
    chatId,
    query: `asset-marker-${counts.assetCount - 1}`,
    actor: 'Alice',
    outfit: 'raincoat',
    location: 'harbor',
    allowedUse: 'inline',
    limit: 5,
  });
  const asset = assets.find((item) => item.title === `asset-marker-${counts.assetCount - 1}`)!;
  const selected = resolveAsset(assets, {
    chatId,
    ref: { id: asset.id, revision: asset.revision, hash: asset.hash },
    use: 'inline',
    actor: 'Alice',
    outfit: 'raincoat',
    location: 'harbor',
  });
  const missing = resolveAsset(assets, {
    chatId,
    ref: { id: asset.id, revision: asset.revision, hash: asset.hash },
    use: 'inline',
    actor: 'Alice',
    outfit: 'space-suit',
    location: 'harbor',
  });
  const end = performance.now();
  return {
    input,
    snapshot,
    search,
    roundtrip,
    pages,
    loreSearch,
    loreRead,
    assetSearch,
    selected,
    missing,
    timing: {
      contextMs: contextEnd - start,
      storySearchMs: searchEnd - contextEnd,
      sourceRoundtripMs: readEnd - searchEnd,
      loreReadMs: loreEnd - readEnd,
      assetMetadataMs: end - loreEnd,
      totalMs: end - start,
    } satisfies Timing,
  };
}
function validateOutput(
  result: ReturnType<typeof measuredPath>,
  f: Awaited<ReturnType<typeof fixture>>,
  counts: Counts
) {
  expect(result.input.history).toHaveLength(2);
  expect(result.snapshot.history).toHaveLength(6);
  expect(result.input.memory).toMatchObject({
    indexedCount: 6,
    totalSources: 6,
    unprocessedCount: 0,
    ready: true,
  });
  expect(result.roundtrip).toBe(f.store.source(f.firstRevision).text);
  expect(result.roundtrip.length).toBe(counts.manuscriptChars);
  expect(f.store.sourceOriginal(f.firstRevision).text).toBe(f.originalText);
  expect(result.search.denied).toBe(false);
  expect(JSON.stringify(result.search.result)).toContain(f.firstRevision);
  expect(JSON.stringify(result.search.result)).not.toContain('archived-source');
  expect(
    result.snapshot.resources.filter((resource) => resource.sourceKind === 'lore')
  ).toHaveLength(counts.loreCount);
  expect(result.input.catalog).toHaveLength(Math.min(100, counts.loreCount + 1));
  expect(result.input.catalog.every((item) => !Object.hasOwn(item, 'text'))).toBe(true);
  if (counts.loreCount > 100) {
    expect(result.input.catalogPage).toMatchObject({ total: counts.loreCount + 1, listed: 100 });
    expect(
      result.input.catalog.some((item) =>
        item.id.endsWith(`:lore-${String(counts.loreCount - 1).padStart(4, '0')}`)
      )
    ).toBe(false);
  }
  expect(result.loreSearch.denied).toBe(false);
  expect(result.loreRead.denied).toBe(false);
  expect(JSON.stringify(result.loreSearch.result)).toContain(
    `lore-${String(counts.loreCount - 1).padStart(4, '0')}`
  );
  expect((result.loreRead.result as { text: string }).text).toContain(
    `needle-lore-${counts.loreCount - 1}`
  );
  expect(result.assetSearch.total).toBe(1);
  expect(result.assetSearch.items).toHaveLength(1);
  expect(result.selected.ok).toBe(true);
  expect(result.missing).toEqual({
    ok: false,
    fallback: 'no-image',
    error: 'ASSET_COMBINATION_MISMATCH',
  });
  const metadata = JSON.stringify({ search: result.assetSearch, selected: result.selected });
  expect(metadata).not.toMatch(/"(?:url|bytes|base64)":/);
  expect(metadata).not.toContain(pixel);
  expect(JSON.stringify(result.input)).not.toContain('asset-marker-');
  expect(Object.values(result.timing).every((value) => Number.isFinite(value) && value >= 0)).toBe(
    true
  );
}
function summarize(samples: Timing[]) {
  return Object.fromEntries(
    Object.keys(samples[0]).map((key) => {
      const sorted = samples.map((sample) => sample[key as keyof Timing]).sort((a, b) => a - b);
      return [
        key,
        {
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          samples: samples.map((sample) => sample[key as keyof Timing]),
        },
      ];
    })
  );
}
function condition(f: Awaited<ReturnType<typeof fixture>>, counts: Counts) {
  for (let index = 0; index < WARMUP_COUNT; index++)
    validateOutput(measuredPath(f, counts), f, counts);
  const samples: Timing[] = [];
  let output = measuredPath(f, counts);
  validateOutput(output, f, counts);
  samples.push(output.timing);
  for (let index = 1; index < SAMPLE_COUNT; index++) {
    const result = measuredPath(f, counts);
    validateOutput(result, f, counts);
    samples.push(result.timing);
  }
  const count = (table: string) =>
    Number(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  return {
    output,
    evidence: {
      counts: {
        ...counts,
        activeHistory: 6,
        sourceRows: count('sources'),
        resolvedResources: output.snapshot.resources.length,
        assetRows: count('assets'),
      },
      elapsedMs: summarize(samples),
      output: {
        inputChars: JSON.stringify(output.input).length,
        catalogEntries: output.input.catalog.length,
        inputHistoryEntries: output.input.history.length,
        storedActiveHistoryEntries: output.snapshot.history.length,
        roundtripChars: output.roundtrip.length,
        readPages: output.pages,
        manuscriptHash: memoryHash(output.roundtrip),
        activeInputHash: memoryHash(JSON.stringify(output.input)),
        assetMetadataChars: JSON.stringify(output.assetSearch).length,
      },
      sqliteLogicalBytes:
        Number(f.store.db.prepare('PRAGMA page_count').get()?.page_count) *
        Number(f.store.db.prepare('PRAGMA page_size').get()?.page_size),
    },
  };
}

test('S07 independent archive/lore/manuscript/asset growth measures actual SQLite active context; S05 200k source roundtrips', async () => {
  const started = new Date().toISOString();
  const evidence: unknown[] = [];
  for (const { dimension, larger } of dimensions) {
    const f = await fixture();
    const small = condition(f, baseline);
    const largeCounts = { ...baseline, [dimension]: larger };
    if (dimension === 'archivedSources')
      addArchived(f.store, f.chatId, baseline.archivedSources, larger);
    else if (dimension === 'loreCount') addLore(f.store, f.chatId, baseline.loreCount, larger);
    else if (dimension === 'assetCount') addAssets(f.store, f.chatId, baseline.assetCount, larger);
    else {
      f.store.editSource(f.firstRevision, { text: manuscript(larger), expectedRevision: 0 });
      indexAll(f.store, f.chatId);
    }
    const large = condition(f, largeCounts);
    if (dimension === 'archivedSources') {
      expect(large.output.input).toEqual(small.output.input);
      expect(large.output.snapshot.history).toEqual(small.output.snapshot.history);
      expect(large.output.search.result).toEqual(small.output.search.result);
      expect(large.output.roundtrip).toBe(small.output.roundtrip);
    }
    if (dimension === 'assetCount') expect(large.output.input).toEqual(small.output.input);
    evidence.push({ dimension, baseline: small.evidence, larger: large.evidence });
  }
  const environment = {
    node: process.version,
    sqlite: process.versions.sqlite,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    host: hostname(),
    pid: process.pid,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtEnd: freemem(),
    loadAverageAtEnd: loadavg(),
    processMemoryAtEnd: process.memoryUsage(),
  };
  const artifact = {
    scenario: 'S07',
    status: 'PASS',
    started,
    finished: new Date().toISOString(),
    environment,
    method: {
      warmupsPerCondition: WARMUP_COUNT,
      measuredSamplesPerCondition: SAMPLE_COUNT,
      percentile: 'nearest-rank; p95 equals maximum with five samples',
      clock: 'node:perf_hooks performance.now milliseconds',
      fixture:
        'Actual temporary file SQLite; synthetic source/lore data; 68-byte PNG BLOBs; no provider/model calls',
      activePath:
        'Six original source revisions; all indexed with explicit no-facts fixture completions; two recent sources in actual main input',
      setupTiming:
        'Schema creation, fixture inserts, source edit, reindexing and assertions are excluded from measured durations',
      concurrency:
        'Sequential measurements within this test; other machine processes and concurrent agent work are uncontrolled',
      boundaries: [
        'Warm-cache local backend/context/tool measurements only; no live model, GPU, browser paint, mobile network or provider latency claim.',
        'Source roundtrip includes all paginated reads and source-hash validation; larger manuscripts intentionally require more pages.',
        'Archived count means off-ancestry stored source/run rows, not a measured archive import/export UI operation.',
        'No speed threshold or relative performance assertion; PASS denotes functional contract checks, not a speed gain.',
      ],
    },
    conditions: evidence,
  };
  const destination = process.env.NR_ARTIFACT_DIR
    ? resolve(process.env.NR_ARTIFACT_DIR)
    : owned[0].directory;
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'story-performance.json'), JSON.stringify(artifact, null, 2));
}, 30000);
