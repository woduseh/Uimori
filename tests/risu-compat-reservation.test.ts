import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Content } from '../core/product.js';
import type { ModelInput, RunSnapshot } from '../core/types.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';
import { validateRunSnapshot } from '../server/snapshot-archive.js';
import { Store } from '../server/store.js';

// The compat evaluation is a reservation input: it freezes with the Run, the compiled prompt carries
// the evaluated text instead of the card's literal braces, and every archive path either reproduces
// the receipt from that same snapshot or refuses the Run.

const DESCRIPTION = '{{#if 1}}HP {{getvar::hp}} left{{/if}} and {{calc::1+2}}';
const EVALUATED = 'HP 10 left and 3';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-risu-reservation-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-risu-reservation-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  owned.push({ directory, store });
  return store;
}

const sourceOf = () => ({
  name: 'synthetic-compat-card.json',
  base64: Buffer.from(
    JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Synthetic Pilot',
        description: DESCRIPTION,
        first_mes: 'The pilot waits.',
        extensions: { risuai: { defaultVariables: 'hp=10' } },
      },
    })
  ).toString('base64'),
});

function reserved(request = 'Where next?') {
  const store = database();
  const source = sourceOf();
  const preview = prepareRisuImport({ source });
  const saved = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    // The card's `{{#if}}`/`{{calc}}` body is exactly what the AST converter refuses.
    allowPartial: true,
    idempotencyKey: randomUUID(),
  });
  const chat = saved.chat!;
  const content = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(content.package!.compat).toEqual({ risuCbs: { fields: ['body'] } });
  const profile = store.product.snapshot(chat.id);
  const current = store.chat(chat.id);
  const { run } = store.createRun(
    chat.id,
    {
      request,
      expectedRevision: current.headRevision,
      expectedSettingsRevision: current.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (captured) => ({
      chatId: chat.id,
      parentRevision: captured.headRevision,
      settingsRevision: captured.settingsRevision,
      settings: captured.settings,
      request,
      history: store.history(captured.headRevision),
      resources: store.product.resources(chat.id, profile),
      profile,
    })
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

test('a reserved Run freezes the compat evaluation and compiles the evaluated text', () => {
  const { run } = reserved();
  const entry = run.snapshot.risuCompat!.entries[0];
  expect(run.snapshot.risuCompat!.version).toBe(1);
  expect(entry.key).toMatch(/:bot:body$/u);
  expect(entry.text).toBe(EVALUATED);
  expect(entry.inputHash).toMatch(/^[a-f0-9]{64}$/u);
  const compiled = JSON.stringify(run.snapshot.promptCompilation!.messages);
  expect(compiled).toContain(EVALUATED);
  expect(compiled).not.toContain('{{getvar::hp}}');
  expect(compiled).not.toContain('{{calc::1+2}}');
});

test('an archive round trip keeps the receipt and revalidates it against the same snapshot', () => {
  const fixture = reserved();
  const run = completed(fixture);
  expect(() => validateRunSnapshot(fixture.store, run.snapshot, run.id)).not.toThrow();
  const copy = database();
  expect(copy.product.import(fixture.store.product.export())).toMatchObject({ restored: true });
  const restored = copy.run(run.id);
  expect(restored.snapshot.risuCompat).toEqual(run.snapshot.risuCompat);
  expect(() => validateRunSnapshot(copy, restored.snapshot, restored.id)).not.toThrow();
});

test('a forged receipt text or input hash is refused by archive validation', () => {
  const fixture = reserved();
  const run = completed(fixture);
  const forgedText = structuredClone(run.snapshot);
  forgedText.risuCompat!.entries[0].text = 'HP 999 left and 3';
  // The text is bound by the prompt it compiled, so the forgery surfaces there first.
  expect(() => validateRunSnapshot(fixture.store, forgedText, run.id)).toThrow(
    'compiled prompt mismatch'
  );
  const forgedHash = structuredClone(run.snapshot);
  forgedHash.risuCompat!.entries[0].inputHash = 'b'.repeat(64);
  expect(() => validateRunSnapshot(fixture.store, forgedHash, run.id)).toThrow(
    'risu compat receipt mismatch'
  );
  const foreignKey = structuredClone(run.snapshot);
  foreignKey.risuCompat!.entries[0].key = 'other@1:bot:body';
  expect(() => validateRunSnapshot(fixture.store, foreignKey, run.id)).toThrow(
    'risu compat receipt mismatch'
  );
});

test('a Run that recorded a model input cannot drop its receipt', () => {
  const fixture = reserved();
  const input: ModelInput = {
    role: 'main',
    contract: 'main',
    task: 'Where next?',
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
  const withoutReceipt: RunSnapshot = structuredClone(run.snapshot);
  delete withoutReceipt.risuCompat;
  expect(() => validateRunSnapshot(fixture.store, withoutReceipt, run.id)).toThrow(
    'risu compat receipt missing'
  );
});

test('a chat backup restore keeps the frozen receipt on the copied Run', () => {
  const fixture = reserved();
  const run = completed(fixture);
  const copy = importChatBackup(fixture.store, {
    backup: exportChatBackup(fixture.store, fixture.chat.id),
    idempotencyKey: 'compat-reservation-copy',
  });
  const rows = fixture.store.db
    .prepare('SELECT id FROM runs WHERE chat_id=?')
    .all(copy.chat.id) as { id: string }[];
  const restored = rows.map((row) => fixture.store.run(row.id));
  const carried = restored.find((item) => item.snapshot.risuCompat !== undefined)!;
  expect(carried.id).not.toBe(run.id);
  expect(carried.snapshot.risuCompat).toEqual(run.snapshot.risuCompat);
  expect(JSON.stringify(carried.snapshot.promptCompilation!.messages)).toContain(EVALUATED);
});
