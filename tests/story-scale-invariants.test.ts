import { countTextTokens } from '../core/text-tokens.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { buildMainInput, CATALOG_TOKENS, executeTool } from '../core/provider.js';
import { sourceHash as memoryHash } from '../core/source-history.js';
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
type Counts = {
  archivedSources: number;
  loreCount: number;
  manuscriptChars: number;
  assetCount: number;
};
type Dimension = keyof Counts;
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPY3RH6HwAGMgKYxcNPSgAAAABJRU5ErkJggg==';
const manuscript = (length: number) =>
  `old-source-begin\n${'Synthetic scene. '.repeat(Math.ceil(length / 17))}`.slice(0, length - 17) +
  '\nold-source-end!!';
const fixedSettings = {
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
  return store.completeRun(run.id, text, {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
}
function addArchived(store: Store, chatId: string, start: number, end: number) {
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
          "INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,source_revision,created_at,updated_at) VALUES(?,?,NULL,'completed',?,?,?,?,?,?,?)"
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
          time
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
  const card = owner.package.nativeRisu.card;
  const book = (card.character_book ?? {}) as { entries?: Record<string, unknown>[] };
  const saved = store.product.content(
    {
      kind: owner.kind,
      title: owner.title,
      description: owner.description,
      text: owner.text,
      loading: owner.loading,
      relatedIds: owner.relatedIds,
      expectedRevision: owner.revision,
      package: nativeContent(
        {
          ...card,
          character_book: {
            ...book,
            entries: [
              ...(book.entries ?? []),
              ...Array.from({ length: end - start }, (_, offset) => {
                const index = start + offset;
                return {
                  comment: `Synthetic lore ${index}`,
                  keys: [`needle-lore-${index}`],
                  enabled: true,
                  content: `needle-lore-${index} ${'Local fictional context. '.repeat(20)}`,
                };
              }),
            ],
          },
        },
        owner.package
      ),
    },
    owner.id
  );
  const { chatId: _chatId, revision, ...profile } = store.product.profile(chatId);
  updateTestProfile(store.product, chatId, {
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
async function fixture(counts: Counts) {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori S07 measured '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  const chat = createFixtureChat(store, 'Synthetic performance fixture');
  store.settings(chat.id, chat.settingsRevision, fixedSettings);
  const first = source(store, chat.id, manuscript(counts.manuscriptChars));
  for (let index = 1; index < 6; index++)
    source(store, chat.id, `Active source ${index}: ${'Recent concrete scene. '.repeat(12)}`);
  addArchived(store, chat.id, 0, counts.archivedSources);
  addLore(store, chat.id, 0, counts.loreCount);
  addAssets(store, chat.id, 0, counts.assetCount);
  return {
    directory,
    store,
    chatId: chat.id,
    firstRevision: first.id,
    originalText: first.text,
    head: store.chat(chat.id).headRevision!,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function grow(f: Fixture, counts: Counts, dimension: Dimension, larger: number): Counts {
  if (dimension === 'archivedSources')
    addArchived(f.store, f.chatId, counts.archivedSources, larger);
  else if (dimension === 'loreCount') addLore(f.store, f.chatId, counts.loreCount, larger);
  else if (dimension === 'assetCount') addAssets(f.store, f.chatId, counts.assetCount, larger);
  else f.store.editSource(f.firstRevision, { text: manuscript(larger), expectedRevision: 0 });
  return { ...counts, [dimension]: larger };
}

function measuredPath(f: Fixture, counts: Counts) {
  const { store, chatId, head, firstRevision } = f;
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
  const search = executeTool(snapshot, {
    callId: 'old-search',
    name: 'story.search',
    args: { query: 'old-source-end!!', limit: 5 },
  });
  const firstSceneNumber =
    snapshot.history.findIndex((item) => item.revision === firstRevision) + 1;
  let offset: number | null = 0;
  let roundtrip = '';
  let pages = 0;
  while (offset !== null) {
    const read = executeTool(snapshot, {
      callId: `old-read-${pages}`,
      name: 'story.read',
      args: { sceneNumber: firstSceneNumber, offset, limit: 8192 },
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
  const loreSearch = executeTool(snapshot, {
    callId: 'lore-search',
    name: 'knowledge.search',
    args: { query: `needle-lore-${counts.loreCount - 1}`, limit: 5 },
  });
  const loreRead = executeTool(snapshot, {
    callId: 'lore-read',
    name: 'knowledge.read',
    args: {
      ids: [
        snapshot.resources.find(
          (resource) => resource.title === `Synthetic lore ${counts.loreCount - 1}`
        )!.id,
      ],
      limit: 4096,
    },
  });
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
  };
}
type MeasuredPath = ReturnType<typeof measuredPath>;
function validateOutput(result: MeasuredPath, f: Fixture, counts: Counts) {
  expect(result.input.history).toHaveLength(6);
  expect(result.snapshot.history).toHaveLength(6);
  expect(result.input.notes).toBeUndefined();
  expect(result.roundtrip).toBe(f.store.source(f.firstRevision).text);
  expect(result.roundtrip.length).toBe(counts.manuscriptChars);
  expect(f.store.sourceOriginal(f.firstRevision).text).toBe(f.originalText);
  expect(result.search.denied).toBe(false);
  expect(JSON.stringify(result.search.result)).toContain(f.firstRevision);
  expect(JSON.stringify(result.search.result)).not.toContain('archived-source');
  expect(
    result.snapshot.resources.filter((resource) => resource.sourceKind === 'lore')
  ).toHaveLength(counts.loreCount);
  const delivered = new Set((result.input.pinnedSources ?? []).map((item) => item.id));
  const unread = result.snapshot.resources.filter((resource) => !delivered.has(resource.id));
  expect(result.input.catalog).toHaveLength(result.input.catalogPage?.listed ?? unread.length);
  expect(result.input.catalog.every((item) => !delivered.has(item.id))).toBe(true);
  expect(result.input.catalog.every((item) => !Object.hasOwn(item, 'text'))).toBe(true);
  if (result.input.catalogPage) {
    expect(result.input.catalogPage).toMatchObject({ total: unread.length });
    expect(result.input.catalogPage.listed).toBeGreaterThan(0);
    expect(result.input.catalogPage.listed).toBeLessThan(unread.length);
    expect(countTextTokens(JSON.stringify(result.input.catalog))).toBeLessThanOrEqual(
      CATALOG_TOKENS
    );
    expect(
      result.input.catalog.some((item) => item.title === `Synthetic lore ${counts.loreCount - 1}`)
    ).toBe(false);
  }
  expect(result.loreSearch.denied).toBe(false);
  expect(result.loreRead.denied).toBe(false);
  expect(JSON.stringify(result.loreSearch.result)).toContain(
    `Synthetic lore ${counts.loreCount - 1}`
  );
  expect((result.loreRead.result as any).items[0].read.text).toContain(
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
}
function expectGrowthKeepsActivePath(
  dimension: Dimension,
  small: MeasuredPath,
  large: MeasuredPath
) {
  if (dimension === 'archivedSources') {
    expect(large.input).toEqual(small.input);
    expect(large.snapshot.history).toEqual(small.snapshot.history);
    expect(large.search.result).toEqual(small.search.result);
    expect(large.roundtrip).toBe(small.roundtrip);
  }
  if (dimension === 'assetCount') expect(large.input).toEqual(small.input);
}

const small: Counts = { archivedSources: 2, loreCount: 5, manuscriptChars: 10000, assetCount: 2 };
async function growth(dimension: Dimension, larger: number) {
  const f = await fixture(small);
  const before = measuredPath(f, small);
  validateOutput(before, f, small);
  const counts = grow(f, small, dimension, larger);
  const after = measuredPath(f, counts);
  validateOutput(after, f, counts);
  expectGrowthKeepsActivePath(dimension, before, after);
  return { before, after };
}

test('archived sources off the active path leave context, story search and source roundtrip unchanged', async () => {
  await growth('archivedSources', 20);
});

test('a manuscript spanning several story.read pages roundtrips without loss', async () => {
  const { after } = await growth('manuscriptChars', 30000);
  expect(after.pages).toBeGreaterThanOrEqual(4);
});

test('lore beyond the catalog budget pages the catalog within CATALOG_TOKENS', async () => {
  const { before, after } = await growth('loreCount', 100);
  expect(before.input.catalogPage).toBeUndefined();
  expect(after.input.catalogPage).toBeDefined();
});

test('asset metadata omits image payloads and added assets leave the main input unchanged', async () => {
  await growth('assetCount', 20);
});
