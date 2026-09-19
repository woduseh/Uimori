import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { packageInstanceId } from '../core/execution-context.js';
import type { Content } from '../core/product.js';
import type { ModelInput, RunSnapshot } from '../core/types.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { readChatVariables, writeChatVariablesInTransaction } from '../server/chat-variables.js';
import { validateChatVariablesArchive } from '../server/chat-variables-archive.js';
import { createPackageStart, validateArchivedPackageStart } from '../server/package-start.js';
import { validateRunSnapshot } from '../server/snapshot-archive.js';
import { Store } from '../server/store.js';

// The compat evaluation is a reservation input: it freezes with the Run, the compiled prompt carries
// the evaluated text instead of the card's literal braces, and every archive path either reproduces
// the receipt from that same snapshot or refuses the Run. What the evaluation wrote travels on the
// same receipt and reaches the branch shared variables when the source is saved.

const DESCRIPTION = '{{#if 1}}HP {{getvar::hp}} left{{/if}} and {{calc::1+2}}';
const EVALUATED = 'HP 10 left and 3';
// Earlier saved compat fields keep their original CBS and are evaluated at reservation.
const WRITING_DESCRIPTION = '{{setvar::hp::20}}HP {{getvar::hp}}';
const GREETING = 'Welcome, HP {{getvar::hp}} and {{calc::1+2}}';

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

/** Restore the earlier compat package shape; new imports now preserve a native Risu document. */
function imported(description = DESCRIPTION, greeting = 'The pilot waits.') {
  const store = database();
  const content = store.product.content({
    kind: 'bot',
    title: 'Synthetic Pilot',
    description: '',
    text: description,
    loading: 'pinned',
    relatedIds: [],
    package: {
      version: 1,
      id: 'legacy-compat',
      revision: 1,
      title: 'Synthetic Pilot',
      description: '',
      body: description,
      variableDefaults: { values: { hp: '10' }, attachmentRoles: ['bot'] },
      starts: [{ id: 'start-0', title: 'Opening', mode: 'authored', text: greeting }],
      lore: [],
      instructions: [],
      controls: [],
      transforms: [],
      compat: {
        risuCbs: { fields: ['body', ...(greeting.includes('{{') ? ['start:start-0'] : [])] },
      },
    },
  }) as Content;
  const chat = store.createChat(content.title, undefined, { botId: content.id });
  return { store, chat, content };
}

/** The chat's own 공유 변수 변경 허용 for this exact material revision, as the editor writes it. */
function grantVariableWrites(store: Store, chatId: string, contentId: string) {
  const profile = store.product.profile(chatId);
  const attachment = profile.packageAttachments!.find((item) => item.id === contentId)!;
  store.product.updateProfile(chatId, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    packageAttachments: profile.packageAttachments,
    image: profile.image,
    extensionGrants: {
      ...(profile.extensionGrants ?? {}),
      [packageInstanceId(attachment)]: {
        packageRevision: attachment.revision,
        capabilities: ['variables.write'],
      },
    },
  });
}

const events = (store: Store, chatId: string) =>
  store.events(chatId, 0).map((item) => (item as { kind: string }).kind);

function reserved(options: { request?: string; description?: string; grant?: boolean } = {}) {
  const request = options.request ?? 'Where next?';
  const { store, chat, content } = imported(options.description);
  expect(content.package!.compat).toEqual({ risuCbs: { fields: ['body'] } });
  if (options.grant) grantVariableWrites(store, chat.id, content.id);
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

test('the receipt records what the card wrote and the branch adopts it under the grant', () => {
  const fixture = reserved({ description: WRITING_DESCRIPTION, grant: true });
  const entry = fixture.run.snapshot.risuCompat!.entries[0];
  expect(entry.writes).toEqual([{ key: 'hp', value: '20' }]);
  expect(entry.partial).toBe('variable-write');
  expect(entry.text).toBe('HP 20');
  const branchId = fixture.store.product.branch(fixture.chat.id).id;
  expect(readChatVariables(fixture.store, fixture.chat.id, branchId).values).toEqual({});
  completed(fixture);
  expect(readChatVariables(fixture.store, fixture.chat.id, branchId)).toEqual({
    revision: 1,
    values: { hp: '20' },
  });
});

test('without the chat grant the writes are skipped and the branch is left alone', () => {
  const fixture = reserved({ description: WRITING_DESCRIPTION });
  completed(fixture);
  const branchId = fixture.store.product.branch(fixture.chat.id).id;
  expect(readChatVariables(fixture.store, fixture.chat.id, branchId)).toEqual({
    revision: 0,
    values: {},
  });
  expect(events(fixture.store, fixture.chat.id)).toContain('risu.compat.variables.skipped');
});

test('writes evaluated against variables the branch has since changed are skipped as stale', () => {
  const fixture = reserved({ description: WRITING_DESCRIPTION, grant: true });
  const branchId = fixture.store.product.branch(fixture.chat.id).id;
  // Another writer inside the reserved Run's own window; the evaluation never saw this value.
  fixture.store.transaction(() =>
    writeChatVariablesInTransaction(fixture.store, fixture.chat.id, branchId, {
      expectedRevision: 0,
      expectedSourceHash: null,
      idempotencyKey: 'user-edit',
      values: { hp: '99' },
    })
  );
  completed(fixture);
  expect(readChatVariables(fixture.store, fixture.chat.id, branchId).values).toEqual({ hp: '99' });
  expect(events(fixture.store, fixture.chat.id)).toContain('risu.compat.variables.stale');
});

test('a chat backup copy carries the adopted variable state and its archive still validates', () => {
  const fixture = reserved({ description: WRITING_DESCRIPTION, grant: true });
  completed(fixture);
  const copy = importChatBackup(fixture.store, {
    backup: exportChatBackup(fixture.store, fixture.chat.id),
    idempotencyKey: 'compat-variables-copy',
  });
  const branchId = fixture.store.product.branch(copy.chat.id).id;
  expect(readChatVariables(fixture.store, copy.chat.id, branchId)).toEqual({
    revision: 1,
    values: { hp: '20' },
  });
  expect(() => validateChatVariablesArchive(fixture.store)).not.toThrow();
});

test('the input hash binds the evaluated inputs only, never the writes the entry carries', () => {
  const fixture = reserved({ description: WRITING_DESCRIPTION, grant: true });
  const run = completed(fixture);
  const withoutWrites: RunSnapshot = structuredClone(run.snapshot);
  delete withoutWrites.risuCompat!.entries[0].writes;
  // The same snapshot recomputes the same hash with and without them, so dropping them is not a
  // receipt mismatch - only the branch adoption reads the writes.
  expect(() => validateRunSnapshot(fixture.store, withoutWrites, run.id)).not.toThrow();
});

/** Confirms the card's only authored opening, which commits its source inside the same transaction. */
function confirmedStart() {
  const { store, chat, content } = imported(DESCRIPTION, GREETING);
  const start = content.package!.starts![0];
  expect(content.package!.compat!.risuCbs.fields).toContain(`start:${start.id}`);
  const current = store.chat(chat.id);
  const { run } = createPackageStart(store, chat.id, {
    packageId: content.id,
    packageRevision: content.revision,
    startId: start.id,
    expectedSettingsRevision: current.settingsRevision,
    expectedProfileRevision: store.product.profile(chat.id).revision,
    idempotencyKey: randomUUID(),
  });
  return { store, chat, content, start, run };
}

test('an authored start commits the compat evaluation of its own greeting', () => {
  const { store, run, start } = confirmedStart();
  const entry = run.snapshot.risuCompat!.entries.find((item) =>
    item.key.endsWith(`:bot:start:${start.id}`)
  )!;
  expect(entry.text).toBe('Welcome, HP 10 and 3');
  expect(run.snapshot.packageStart!.text).toBe(GREETING);
  expect(store.source(run.sourceRevision!).text).toBe('Welcome, HP 10 and 3');
  expect(() => validateRunSnapshot(store, run.snapshot, run.id)).not.toThrow();
  expect(() => validateArchivedPackageStart(store, run, run.snapshot)).not.toThrow();
});

test('an authored start reserved before the receipt existed still validates without one', () => {
  const { store, run } = confirmedStart();
  const withoutReceipt: RunSnapshot = structuredClone(run.snapshot);
  delete withoutReceipt.risuCompat;
  // The stored selection text is what such a Run committed, so the archive compares against it.
  const committed = run.snapshot.packageStart!.text;
  store.db
    .prepare('UPDATE sources SET text=?,hash=? WHERE id=?')
    .run(
      committed,
      createHash('sha256').update(committed).digest('hex'),
      run.sourceRevision as string
    );
  expect(() => validateArchivedPackageStart(store, run, withoutReceipt)).not.toThrow();
});

test('an authored start whose receipt text was swapped is refused by the archive', () => {
  const { store, run, start } = confirmedStart();
  const forged: RunSnapshot = structuredClone(run.snapshot);
  forged.risuCompat!.entries.find((item) => item.key.endsWith(`:bot:start:${start.id}`))!.text =
    'Welcome, HP 999 and 3';
  expect(() => validateArchivedPackageStart(store, run, forged)).toThrow(
    'PACKAGE_START_ARCHIVE_SOURCE_MISMATCH'
  );
});
