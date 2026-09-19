import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Content } from '../core/product.js';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';
import { buildMainInput, executeTool } from '../core/provider.js';
import type { ModelInput, RunSnapshot } from '../core/types.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { importRisuLore } from '../server/risu-import-lore.js';
import { createRisuImportFindings } from '../server/risu-import-findings.js';
import { validateRunSnapshot } from '../server/snapshot-archive.js';
import { Store } from '../server/store.js';

// Keyword activation is a reservation input: the scan freezes with the Run, the compiled prompt carries
// the entries it chose and nothing else, and every archive path either reproduces the receipt from that
// same snapshot or refuses the Run.

const REQUEST = 'Where is the harbor?';
const CONSTANT = 'The station never sleeps.';
const HARBOR = 'The harbor is busy.';
const DRAGON = 'A dragon sleeps below.';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-risu-activation-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-risu-activation-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  owned.push({ directory, store });
  return store;
}

const entry = (name: string, keys: string[], content: string, constant = false) => ({
  name,
  keys,
  content,
  constant,
  enabled: true,
  extensions: {},
});
/** The engine sorts its answer by insert order, so each fixture entry gets its own. */
const ordered = (entries: ReturnType<typeof entry>[]) =>
  entries.map((item, index) => ({ ...item, insertion_order: index }));

const sourceOf = () => ({
  name: 'synthetic-lorebook-card.json',
  base64: Buffer.from(
    JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Synthetic Pilot',
        description: 'The pilot waits.',
        first_mes: 'The pilot waits.',
        character_book: {
          extensions: {},
          scan_depth: 5,
          token_budget: 800,
          recursive_scanning: true,
          entries: ordered([
            entry('Station', [], CONSTANT, true),
            entry('Harbor', ['harbor'], HARBOR),
            entry('Dragon', ['dragon'], DRAGON),
            entry('Rumor', ['harbor'], '@@probability 0\nA rumor nobody repeats.'),
            entry('Unkeyed', [], 'Notes with no way in.'),
          ]),
        },
      },
    })
  ).toString('base64'),
});

/** lore ids follow the card's entry order, so each fixture entry is named by its index. */
const STATION = 'lore-0',
  HARBOR_ID = 'lore-1',
  DRAGON_ID = 'lore-2',
  RUMOR = 'lore-3',
  UNKEYED = 'lore-4';

function reserved(edit?: (snapshot: RunSnapshot) => void) {
  const store = database();
  const source = sourceOf();
  const card = JSON.parse(Buffer.from(source.base64, 'base64').toString('utf8')).data;
  const { lore, loreActivation } = importRisuLore({ card, findings: createRisuImportFindings() });
  // Frozen legacy keyword packages still use their original reservation/receipt contract.
  const content = store.product.content({
    kind: 'bot',
    title: card.name,
    description: '',
    text: card.description,
    loading: 'pinned',
    relatedIds: [],
    package: {
      version: 1,
      id: 'legacy-keyword',
      revision: 1,
      title: card.name,
      description: '',
      body: card.description,
      lore,
      loreActivation: { ...loreActivation, mode: 'keyword' },
      instructions: [],
      controls: [],
      transforms: [],
    },
  }) as Content;
  const chat = store.createChat(content.title, undefined, { botId: content.id });
  const profile = store.product.snapshot(chat.id);
  const current = store.chat(chat.id);
  const { run } = store.createRun(
    chat.id,
    {
      request: REQUEST,
      expectedRevision: current.headRevision,
      expectedSettingsRevision: current.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (captured) => {
      const snapshot: RunSnapshot = {
        chatId: chat.id,
        parentRevision: captured.headRevision,
        settingsRevision: captured.settingsRevision,
        settings: captured.settings,
        request: REQUEST,
        history: store.history(captured.headRevision),
        resources: store.product.resources(chat.id, profile),
        profile,
      };
      edit?.(snapshot);
      return snapshot;
    }
  );
  store.startRun(run.id);
  return { store, chat, content, run: store.run(run.id) };
}

function completed(fixture: ReturnType<typeof reserved>) {
  fixture.store.completeRun(
    fixture.run.id,
    'The pilot answers.',
    { modelCalls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    fixture.run.snapshot.settings
  );
  return fixture.store.run(fixture.run.id);
}

const pinnedTexts = (snapshot: RunSnapshot) =>
  (buildMainInput(snapshot).pinnedSources ?? []).map((item) => item.text);
const catalogIds = (snapshot: RunSnapshot) => buildMainInput(snapshot).catalog.map((i) => i.id);
const loreResourceId = (snapshot: RunSnapshot, loreId: string) =>
  `package:${snapshot.profile!.packageAttachments![0].id}:bot:lore:${loreId}`;

test('a saved legacy keyword package retains its lorebook rules and mode', () => {
  const { content } = reserved();
  expect(content.package!.loreActivation).toEqual({
    mode: 'keyword',
    scanDepth: 5,
    recursiveScanning: true,
    fullWordMatching: false,
  });
  expect(content.package!.lore.map((item) => item.activation?.keys)).toEqual([
    '',
    'harbor',
    'dragon',
    'harbor',
    '',
  ]);
  expect(content.package!.lore[3].activation?.rules).toBe('@@probability 0');
});

test('a reserved Run freezes which lore the keywords activated, against the chat lore budget', () => {
  const { run } = reserved();
  const entry = run.snapshot.loreActivation!.entries[0];
  expect(run.snapshot.loreActivation!.version).toBe(1);
  expect(entry.key).toMatch(/:bot$/u);
  expect(entry.inputHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(entry.budget).toBe(DEFAULT_LORE_CONTEXT.maxRetainedChars);
  expect(entry.activated).toEqual([STATION, HARBOR_ID]);
  expect(entry.omitted).toEqual([
    { id: DRAGON_ID, reason: 'inactive' },
    { id: RUMOR, reason: 'probability' },
    { id: UNKEYED, reason: 'inactive' },
  ]);
});

test('an activated entry is supplied and a non activated one is neither pinned nor discoverable', () => {
  const { run } = reserved();
  expect(pinnedTexts(run.snapshot)).toEqual(expect.arrayContaining([CONSTANT, HARBOR]));
  expect(pinnedTexts(run.snapshot)).not.toContain(DRAGON);
  expect(catalogIds(run.snapshot)).not.toContain(loreResourceId(run.snapshot, DRAGON_ID));
  // Missing from the catalog is missing from the scope, so reading it by id is refused outright.
  const read = executeTool(run.snapshot, {
    callId: 'read-dragon',
    name: 'knowledge.read',
    args: { id: loreResourceId(run.snapshot, DRAGON_ID), offset: 0, limit: 100 },
  });
  expect(read).toMatchObject({ denied: true, result: { code: 'RESOURCE_UNAVAILABLE' } });
});

test('an archive round trip and a chat backup keep the frozen decision', () => {
  const fixture = reserved();
  const run = completed(fixture);
  expect(() => validateRunSnapshot(fixture.store, run.snapshot, run.id)).not.toThrow();
  const copy = importChatBackup(fixture.store, {
    backup: exportChatBackup(fixture.store, fixture.chat.id),
    idempotencyKey: 'lore-activation-copy',
  });
  const rows = fixture.store.db
    .prepare('SELECT id FROM runs WHERE chat_id=?')
    .all(copy.chat.id) as { id: string }[];
  const restored = rows.map((row) => fixture.store.run(row.id));
  const carried = restored.find((item) => item.snapshot.loreActivation !== undefined)!;
  expect(carried.id).not.toBe(run.id);
  expect(carried.snapshot.loreActivation).toEqual(run.snapshot.loreActivation);
  expect(() => validateRunSnapshot(fixture.store, carried.snapshot, carried.id)).not.toThrow();
});

test('a swapped activation and a dropped receipt are both refused by archive validation', () => {
  const fixture = reserved();
  const input: ModelInput = {
    role: 'main',
    contract: 'main',
    task: REQUEST,
    preset: fixture.run.snapshot.settings.preset,
    facts: [],
    history: [],
    catalog: [],
    prefetch: [],
    tools: [],
    results: [],
  };
  fixture.store.input(fixture.run.id, input);
  const run = completed(fixture);
  const swapped = structuredClone(run.snapshot);
  swapped.loreActivation!.entries[0].activated = [STATION, DRAGON_ID];
  swapped.loreActivation!.entries[0].omitted = [
    { id: HARBOR_ID, reason: 'inactive' },
    { id: RUMOR, reason: 'probability' },
    { id: UNKEYED, reason: 'inactive' },
  ];
  // A well formed swap passes the receipt's own checks; the decision is bound by the prompt it
  // compiled, so the forgery surfaces there.
  expect(() => validateRunSnapshot(fixture.store, swapped, run.id)).toThrow(
    'compiled prompt mismatch'
  );
  const foreign = structuredClone(run.snapshot);
  foreign.loreActivation!.entries[0].activated = ['lore-9'];
  expect(() => validateRunSnapshot(fixture.store, foreign, run.id)).toThrow(
    'lore activation receipt mismatch'
  );
  const rehashed = structuredClone(run.snapshot);
  rehashed.loreActivation!.entries[0].inputHash = 'b'.repeat(64);
  expect(() => validateRunSnapshot(fixture.store, rehashed, run.id)).toThrow(
    'lore activation receipt mismatch'
  );
  const dropped = structuredClone(run.snapshot);
  delete dropped.loreActivation;
  expect(() => validateRunSnapshot(fixture.store, dropped, run.id)).toThrow(
    'lore activation receipt missing'
  );
});

test('a zero lore budget omits every entry instead of failing the scan', () => {
  const { run } = reserved((snapshot) => {
    snapshot.profile!.loreContext = { ...DEFAULT_LORE_CONTEXT, maxRetainedChars: 0 };
  });
  const entry = run.snapshot.loreActivation!.entries[0];
  expect(entry.budget).toBe(0);
  expect(entry.activated).toEqual([]);
  expect(entry.omitted.filter((item) => item.reason === 'budget').map((item) => item.id)).toEqual([
    STATION,
    HARBOR_ID,
  ]);
  expect(pinnedTexts(run.snapshot)).not.toContain(HARBOR);
});

test('switching the package out of keyword mode makes its lore discoverable again', () => {
  const { run } = reserved((snapshot) => {
    snapshot.profile!.packages![0].loreActivation = { mode: 'discoverable' };
  });
  expect(run.snapshot.loreActivation).toBeUndefined();
  expect(catalogIds(run.snapshot)).toEqual(
    expect.arrayContaining([
      loreResourceId(run.snapshot, HARBOR_ID),
      loreResourceId(run.snapshot, DRAGON_ID),
    ])
  );
  expect(pinnedTexts(run.snapshot)).not.toContain(HARBOR);
  // `constant` still pins the entry Risu always sent, mode or no mode.
  expect(pinnedTexts(run.snapshot)).toContain(CONSTANT);
});

test('the activation memory a rule would write is reported, not persisted', () => {
  const { run } = reserved((snapshot) => {
    // `@@keep_activate_after_match` asks Risu to remember the match in a chat variable.
    snapshot.profile!.packages![0].lore[1].activation!.rules = '@@keep_activate_after_match';
  });
  const entry = run.snapshot.loreActivation!.entries[0];
  expect(entry.partial).toBe('variable-write');
  expect(entry.activated).toContain(HARBOR_ID);
  expect(run.snapshot.profile!.variableState).toBeUndefined();
});
