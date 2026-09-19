import { nativeContent } from './fixtures/native-content.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { writeNote } from './fixtures/notes.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { executeTool } from '../core/provider.js';
import { DEFAULT_LORE_CONTEXT, loreHistory } from '../core/lore-context.js';
import { freezeLoreContext, verifiedRunLoreReads } from '../server/lore-context.js';
import type { Run, RunSnapshot } from '../core/types.js';
import type { ChatProfile, Content } from '../core/product.js';

const owned: { store?: Store; dir: string; close?: () => Promise<unknown> }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.close?.();
    item.store?.close();
    const path = resolve(item.dir),
      inside = relative(resolve(tmpdir()), path);
    if (isAbsolute(inside) || inside.startsWith('..') || !basename(path).startsWith('uimori-lore-'))
      throw Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-lore-')),
    store = new Store(join(dir, 'story.sqlite'));
  owned.push({ store, dir });
  const chat = createFixtureChat(store, 'Synthetic lore', 'calm');
  const lore = store.product.content({
    kind: 'module',
    title: 'Synthetic reference',
    description: '',
    text: '',
    package: {
      ...nativeContent(
        {
          name: 'Synthetic reference',
          character_book: {
            entries: [{ content: '0123456789ABCDEFGHIJklmnopqrstUNREAD_TAIL', name: 'Reference' }],
          },
        },
        {},
        'module'
      ),
      loreActivation: { mode: 'discoverable' },
    },
    loading: 'discoverable',
    relatedIds: [],
  }) as Content;
  const { chatId: _id, revision, ...profile } = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    ...profile,
    expectedRevision: revision,
    packageAttachments: [
      ...profile.packageAttachments!,
      { id: lore.id, revision: lore.revision, role: 'module' },
    ],
  });
  return {
    store,
    chat,
    lore,
    loreId: `package:${lore.id}:module:lore:lore-0`,
    loreText: '0123456789ABCDEFGHIJklmnopqrstUNREAD_TAIL',
  };
}
function update(f: ReturnType<typeof fixture>, changes: Partial<ChatProfile>) {
  const { chatId: _id, revision, ...body } = f.store.product.profile(f.chat.id);
  return updateTestProfile(f.store.product, f.chat.id, {
    ...body,
    ...changes,
    expectedRevision: revision,
  });
}
async function queue(
  f: ReturnType<typeof fixture>,
  options: { loreContextReset?: boolean; branchId?: string; idempotencyKey?: string } = {}
) {
  const { store, chat } = f,
    current = store.chat(chat.id),
    profile = store.product.snapshot(chat.id)!;
  const branch = store.product.branch(chat.id, options.branchId),
    command = {
      request: 'Continue synthetic scene',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: current.settingsRevision,
      expectedProfileRevision: profile.revision,
      idempotencyKey: randomUUID(),
      ...options,
    };
  const result = store.createRun(chat.id, command, (c) => ({
    chatId: c.id,
    parentRevision: c.headRevision,
    settingsRevision: c.settingsRevision,
    settings: c.settings,
    request: command.request,
    history: store.history(c.headRevision),
    resources: store.product.resources(c.id, profile),
    profile,
  }));
  const snapshot = compileSnapshotPrompt(
    freezeLoreContext(store, await prepareNativeRisuRun(result.run.snapshot))
  );
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(JSON.stringify(snapshot), result.run.id);
  return { ...result, run: store.run(result.run.id), command };
}
function read(
  f: ReturnType<typeof fixture>,
  run: Run,
  offset: number,
  limit: number,
  name = 'knowledge.read'
) {
  const event = executeTool(run.snapshot, {
    callId: randomUUID(),
    name,
    args: { id: f.loreId, offset, limit },
  });
  f.store.tool(run.id, event);
  return event;
}
function complete(f: ReturnType<typeof fixture>, run: Run, text = 'Synthetic source.') {
  f.store.startRun(run.id);
  return f.store.completeRun(
    run.id,
    text,
    { modelCalls: 1, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
test('only successful main reads retain the exact observed range; search, denied, forged and unread text do not', async () => {
  const f = fixture(),
    first = (await queue(f)).run;
  read(f, first, 2, 5);
  read(f, first, 0, 1, 'skills.load');
  f.store.tool(
    first.id,
    executeTool(first.snapshot, { callId: 'search', name: 'knowledge.search', args: {} })
  );
  const forged = executeTool(first.snapshot, {
    callId: 'forged',
    name: 'knowledge.read',
    args: { id: f.loreId, offset: 20, limit: 3 },
  });
  (forged.result as { text: string }).text = 'FAKE';
  f.store.tool(first.id, forged);
  const source = complete(f, first);
  const second = (await queue(f)).run,
    entries = second.snapshot.loreContext!.entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    start: 2,
    end: 7,
    text: '23456',
    origin: { sourceRevision: source.id, sourceHash: source.hash, runId: first.id },
  });
  expect(JSON.stringify(second.snapshot.promptCompilation)).not.toContain('UNREAD_TAIL');
  expect(second.toolEvents).toEqual([]);
  expect(second.inputs).toEqual([]);
});
test('overlapping reads append uncovered pieces, repeated use leaves the rendered old reference unchanged', async () => {
  const f = fixture(),
    a = (await queue(f)).run;
  read(f, a, 2, 6);
  const sa = complete(f, a);
  const b = (await queue(f)).run,
    oldMessage = loreHistory([], b.snapshot.loreContext)[0];
  read(f, b, 5, 9);
  complete(f, b);
  const c = (await queue(f)).run,
    entries = c.snapshot.loreContext!.entries;
  expect(entries.map((e) => [e.start, e.end, e.text])).toEqual([
    [2, 8, '234567'],
    [8, 14, '89ABCD'],
  ]);
  expect(entries[0].origin.sourceRevision).toBe(sa.id);
  expect(loreHistory([], c.snapshot.loreContext)[0]).toEqual(oldMessage);
});
test('character and entry budgets evict the least recently used whole slices and do not rescan evicted reads', async () => {
  const f = fixture();
  update(f, {
    loreContext: { ...DEFAULT_LORE_CONTEXT, maxRetainedChars: 8, maxRetainedEntries: 2 },
  });
  const a = (await queue(f)).run;
  read(f, a, 0, 4);
  complete(f, a);
  const b = (await queue(f)).run;
  read(f, b, 10, 4);
  complete(f, b);
  const c = (await queue(f)).run;
  read(f, c, 0, 4);
  read(f, c, 20, 4);
  complete(f, c);
  const d = (await queue(f)).run;
  expect(d.snapshot.loreContext!.entries.map((e) => e.start)).toEqual([0, 20]);
  expect(d.snapshot.loreContext!.stats).toMatchObject({
    retainedChars: 8,
    droppedEntries: 1,
    reasons: ['retention-budget'],
  });
  complete(f, d);
  expect((await queue(f)).run.snapshot.loreContext!.entries.map((e) => e.start)).toEqual([0, 20]);
});
test('new-scene reset is part of idempotency, clears inherited lore once, and permits new scene reads', async () => {
  const f = fixture(),
    a = (await queue(f)).run;
  read(f, a, 0, 4);
  complete(f, a);
  const b = await queue(f, { loreContextReset: true }),
    before = structuredClone(b.run.snapshot);
  expect(b.run.snapshot.loreContext!.entries).toEqual([]);
  expect(b.run.snapshot.loreContext!.stats.reasons).toContain('new-scene');
  expect(
    f.store.createRun(f.chat.id, b.command, () => {
      throw Error('must reuse');
    }).created
  ).toBe(false);
  expect(() =>
    f.store.createRun(f.chat.id, { ...b.command, loreContextReset: false }, () => before)
  ).toThrow('Idempotency key');
  read(f, b.run, 10, 4);
  complete(f, b.run);
  expect((await queue(f)).run.snapshot.loreContext!.entries.map((e) => e.start)).toEqual([10]);
  expect(f.store.run(b.run.id).snapshot).toEqual(before);
});
test.each(['source', 'ancestor'] as const)(
  '%s edits invalidate inherited context and original read receipts',
  async (kind) => {
    const f = fixture(),
      a = (await queue(f)).run;
    read(f, a, 0, 4);
    const sa = complete(f, a);
    const b = (await queue(f)).run;
    read(f, b, 10, 4);
    const sb = complete(f, b);
    const frozen = structuredClone(f.store.run(b.id).snapshot);
    f.store.editSource(kind === 'source' ? sb.id : sa.id, {
      text: 'Edited synthetic source.',
      expectedRevision: 0,
    });
    expect(verifiedRunLoreReads(f.store, f.store.run(b.id))).toEqual([]);
    expect((await queue(f)).run.snapshot.loreContext!.entries).toEqual([]);
    expect(f.store.run(b.id).snapshot).toEqual(frozen);
  }
);
test('retcon invalidates lore while preserving past snapshots; failed and alternate branch reads stay excluded', async () => {
  const f = fixture(),
    failed = (await queue(f)).run;
  read(f, failed, 0, 4);
  f.store.finishRun(failed.id, 'failed', 'synthetic failure');
  const a = (await queue(f)).run;
  expect(a.snapshot.loreContext!.entries).toEqual([]);
  read(f, a, 10, 4);
  const sa = complete(f, a);
  const branch = f.store.product.createBranch(f.chat.id, {
    title: 'Other branch',
    fromRevision: null,
  });
  const other = (await queue(f, { branchId: branch.id })).run;
  expect(other.snapshot.loreContext!.entries).toEqual([]);
  read(f, other, 20, 4);
  complete(f, other);
  writeNote(f.store, f.chat.id, { text: 'Synthetic canon changed.', author: 'Fixture' });
  const b = (await queue(f)).run;
  expect(b.snapshot.loreContext!.entries).toEqual([]);
  expect(b.snapshot.loreContext!.stats.reasons).toContain('source-or-canon-changed');
  expect(b.parentRevision).toBe(sa.id);
});
test('resource revision and attachment removal remove retained text', async () => {
  const f = fixture(),
    a = (await queue(f)).run;
  read(f, a, 0, 4);
  complete(f, a);
  const revision = f.store.product.content(
    {
      kind: 'module',
      title: f.lore.title,
      description: '',
      text: '',
      package: {
        ...nativeContent(
          { name: f.lore.title, character_book: { entries: [{ content: 'Different revision' }] } },
          {},
          'module'
        ),
        loreActivation: { mode: 'discoverable' },
      },
      loading: 'discoverable',
      relatedIds: [],
      expectedRevision: 1,
    },
    f.lore.id
  ) as Content;
  update(f, {
    packageAttachments: [
      ...f.store.product
        .profile(f.chat.id)
        .packageAttachments!.filter((ref) => ref.role !== 'module'),
      { id: revision.id, revision: revision.revision, role: 'module' },
    ],
  });
  const b = (await queue(f)).run;
  expect(b.snapshot.loreContext!.entries).toEqual([]);
  complete(f, b);
  const c = (await queue(f)).run;
  read(f, c, 0, 4);
  complete(f, c);
  update(f, {
    packageAttachments: f.store.product
      .profile(f.chat.id)
      .packageAttachments!.filter((ref) => ref.role !== 'module'),
  });
  expect((await queue(f)).run.snapshot.loreContext!.entries).toEqual([]);
});
test('package revision and persona detachment invalidate only currently excluded reads', async () => {
  const f = fixture();
  const pkg = {
    ...nativeContent(
      {
        name: 'Persona lore',
        character_book: { entries: [{ name: 'Known detail', content: 'PERSONA_REFERENCE_RANGE' }] },
      },
      {},
      'persona'
    ),
    loreActivation: { mode: 'discoverable' as const },
  };
  const content = f.store.product.content({
    kind: 'persona',
    title: pkg.title,
    description: '',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const owner = f.store.product.profile(f.chat.id).packageAttachments!;
  update(f, { packageAttachments: [...owner, { id: content.id, revision: 1, role: 'persona' }] });
  const a = (await queue(f)).run,
    id = `package:${content.id}:persona:lore:lore-0`;
  f.store.tool(
    a.id,
    executeTool(a.snapshot, {
      callId: 'persona-read',
      name: 'knowledge.read',
      args: { id, offset: 0, limit: 7 },
    })
  );
  read(f, a, 0, 4);
  complete(f, a);
  const b = (await queue(f)).run;
  expect(b.snapshot.loreContext!.entries).toHaveLength(2);
  complete(f, b);
  update(f, { packageAttachments: owner });
  const c = (await queue(f)).run;
  expect(c.snapshot.loreContext!.entries.map((e) => e.id)).toEqual([f.loreId]);
  complete(f, c);
  update(f, { packageAttachments: [...owner, { id: content.id, revision: 1, role: 'persona' }] });
  const d = (await queue(f)).run;
  expect(d.snapshot.loreContext!.entries.map((e) => e.id)).toEqual([f.loreId]);
  f.store.tool(
    d.id,
    executeTool(d.snapshot, {
      callId: 'persona-again',
      name: 'knowledge.read',
      args: { id, offset: 0, limit: 7 },
    })
  );
  complete(f, d);
  const updated = f.store.product.content(
    {
      kind: 'persona',
      title: pkg.title,
      description: '',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: content.package,
      expectedRevision: 1,
    },
    content.id
  ) as Content;
  update(f, {
    packageAttachments: [...owner, { id: content.id, revision: updated.revision, role: 'persona' }],
  });
  expect((await queue(f)).run.snapshot.loreContext!.entries.map((e) => e.id)).toEqual([f.loreId]);
});
test('switching an attached reference to pinned supplies it once and removes the retained copy', async () => {
  const f = fixture(),
    a = (await queue(f)).run;
  read(f, a, 0, 4);
  complete(f, a);
  const updated = f.store.product.content(
    {
      kind: 'module',
      title: f.lore.title,
      description: '',
      text: '',
      package: nativeContent(
        {
          name: f.lore.title,
          character_book: { entries: [{ content: f.loreText, constant: true }] },
        },
        {},
        'module'
      ),
      loading: 'pinned',
      relatedIds: [],
      expectedRevision: 1,
    },
    f.lore.id
  ) as Content;
  update(f, {
    packageAttachments: [
      ...f.store.product
        .profile(f.chat.id)
        .packageAttachments!.filter((ref) => ref.role !== 'module'),
      { id: updated.id, revision: updated.revision, role: 'module' },
    ],
  });
  const b = (await queue(f)).run;
  expect(b.snapshot.loreContext!.entries).toEqual([]);
  expect(b.snapshot.loreContext!.stats.reasons).toContain('provided-as-pinned');
  const wireText = b.snapshot
    .promptCompilation!.messages.map((m) => m.content.map((c) => c.text).join(''))
    .join('\n');
  expect(wireText.split(f.loreText).length - 1).toBe(1);
});
test('disabled retention, zero budgets and invalid policy are explicit; selection is read only', async () => {
  const f = fixture(),
    a = (await queue(f)).run;
  read(f, a, 0, 4);
  const source = complete(f, a);
  update(f, { loreContext: { ...DEFAULT_LORE_CONTEXT, enabled: false } });
  const profile = f.store.product.snapshot(f.chat.id)!,
    snapshot: RunSnapshot = {
      ...a.snapshot,
      parentRevision: source.id,
      history: f.store.history(source.id),
      profile,
      resources: f.store.product.resources(f.chat.id, profile),
    };
  const before = f.store.db.prepare('SELECT total_changes() AS n').get();
  expect(freezeLoreContext(f.store, snapshot).loreContext!.entries).toEqual([]);
  expect(f.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  expect(() =>
    update(f, { loreContext: { ...DEFAULT_LORE_CONTEXT, maxRetainedChars: -1 } })
  ).toThrow('Invalid lore context policy');
  update(f, { loreContext: { ...DEFAULT_LORE_CONTEXT, maxRetainedChars: 0 } });
  expect((await queue(f)).run.snapshot.loreContext!.entries).toEqual([]);
});
test('no-call preview accepts the selected default prompt and unsaved policy without writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-lore-')),
    app = await createApp({
      dbPath: join(dir, 'story.sqlite'),
      buildId: 'synthetic-lore',
      testMode: true,
    });
  owned.push({ dir, close: () => app.close() });
  const chat = createFixtureChat(app.store, 'Preview', 'calm'),
    before = app.store.db.prepare('SELECT total_changes() AS n').get();
  const response = await injectWithFixtureBot(app, {
    method: 'POST',
    url: `/api/chats/${chat.id}/prompt-preview`,
    payload: {
      request: 'Synthetic preview',
      loreContext: { ...DEFAULT_LORE_CONTEXT, maxRetainedChars: 1234 },
      loreContextReset: true,
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    scope: 'preview-only-no-provider-call',
    loreContext: { policy: { maxRetainedChars: 1234 }, stats: { reasons: ['new-scene'] } },
  });
  expect(app.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});
test('whole-context projection carries compacted-source lore after the summary and keeps recent source anchors', async () => {
  const f = fixture(),
    a = (await queue(f)).run;
  read(f, a, 0, 4);
  complete(f, a);
  const b = (await queue(f)).run;
  read(f, b, 10, 4);
  const source = complete(f, b),
    c = (await queue(f)).run;
  const projection = [
      { id: 'context-summary', role: 'user' as const, text: 'SYNTHETIC_SOURCE_SUMMARY_ONLY' },
      {
        id: `request:${source.id}`,
        role: 'user' as const,
        text: b.request,
        sourceRevision: source.id,
      },
      {
        id: `source:${source.id}`,
        role: 'assistant' as const,
        text: source.text,
        sourceRevision: source.id,
      },
    ],
    before = structuredClone(projection);
  const output = loreHistory(projection, c.snapshot.loreContext);
  expect(output.map((m) => m.id)).toEqual([
    'context-summary',
    `lore-reference:${a.sourceRevision ?? f.store.run(a.id).sourceRevision}`,
    `request:${source.id}`,
    `lore-reference:${source.id}`,
    `source:${source.id}`,
  ]);
  expect(output[0]).toEqual(projection[0]);
  expect(projection).toEqual(before);
  expect(
    loreHistory(
      [{ ...projection[0], id: 'other-summary' }, ...projection.slice(1)],
      c.snapshot.loreContext,
      { carryAfterMessageId: 'other-summary' }
    )[0].id
  ).toBe('other-summary');
});
