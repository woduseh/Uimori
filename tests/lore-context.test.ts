import { nativeContent } from './fixtures/native-content.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { executeTool } from '../core/provider.js';
import { DEFAULT_LORE_CONTEXT, loreHistory } from '../core/lore-context.js';
import { freezeLoreContext, verifiedRunLoreReads } from '../server/lore-context.js';
import { prepareLoreSelection } from '../server/lore-selection.js';
import type { MainHooks } from '../server/model-runner.js';
import type { Run } from '../core/types.js';
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
function fixture(mode: 'discoverable' | 'model' = 'discoverable') {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-lore-')),
    store = new Store(join(dir, 'story.sqlite'));
  owned.push({ store, dir });
  const chat = createFixtureChat(store, 'Synthetic lore');
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
      loreActivation: { mode },
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
  options: { loreContextReset?: boolean; idempotencyKey?: string } = {}
) {
  const { store, chat } = f,
    current = store.chat(chat.id),
    profile = store.product.snapshot(chat.id)!;
  const command = {
    request: 'Continue synthetic scene',
    expectedRevision: current.headRevision,
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
    args: { ids: [f.loreId], offset, limit },
  });
  f.store.tool(run.id, event);
  return event;
}
function complete(f: ReturnType<typeof fixture>, run: Run, text = 'Synthetic source.') {
  f.store.startRun(run.id);
  return f.store.completeRun(run.id, text, {
    modelCalls: 1,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
}
test('successful JEV bodies carry as stable turn references and are not judged again on later turns', async () => {
  const f = fixture('model');
  let first = (await queue(f)).run;
  const send = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: { entry_0: { type: 'noul', noul: 0.99 } },
          usage: { input_tokens: 10, output_tokens: 1 },
        })
      )
  );
  const hooks: MainHooks = {
    signal: new AbortController().signal,
    onInput: () => {},
    onToolEvent: () => {},
    onAttemptStart: () => 'synthetic-selection',
    onAttemptFinish: () => {},
    authorize: (connection) => connection,
  };
  const selected = await prepareLoreSelection(first.snapshot, hooks, {
    reserveCalls: 1,
    jev: { credential: () => 'synthetic', fetch: send },
  });
  expect(selected.snapshot.loreSelection!.entries[0].selected).toEqual(['lore-0']);
  const initial = compileSnapshotPrompt(selected.snapshot);
  const reference = initial.promptCompilation!.messages.find((message) =>
    message.id.startsWith('lore-reference:')
  )!;
  expect(reference).toBeDefined();
  expect(JSON.stringify(reference.content)).toContain(f.loreText);
  f.store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(JSON.stringify(initial), first.id);
  first = f.store.run(first.id);
  complete(f, first);
  const second = (await queue(f)).run;
  expect(second.snapshot.loreContext!.entries).toMatchObject([
    { retention: 'selection', text: f.loreText },
  ]);
  expect(second.snapshot.loreSelection).toBeUndefined();
  const carried = second.snapshot.promptCompilation!.messages.find((message) =>
    message.id.startsWith('lore-reference:')
  )!;
  expect(carried.content).toEqual(reference.content);
  const next = await prepareLoreSelection(second.snapshot, hooks, {
    reserveCalls: 1,
    jev: { credential: () => 'synthetic', fetch: send },
  });
  expect(next.usage.modelCalls).toBe(0);
  expect(next.snapshot.loreSelection!.entries[0].selected).toEqual([]);
  expect(send).toHaveBeenCalledTimes(1);
  complete(f, second);
  const third = (await queue(f)).run;
  expect(third.snapshot.loreContext!.entries[0].text).toBe(f.loreText);
  f.store.startRun(third.id);
  f.store.finishRun(third.id, 'cancelled', 'synthetic cancellation');
  const reset = (await queue(f, { loreContextReset: true })).run;
  expect(reset.snapshot.loreContext!.entries).toEqual([]);
});
test('only successful main reads retain the exact observed range; search, denied, forged and unread text do not', async () => {
  const f = fixture(),
    first = (await queue(f)).run;
  read(f, first, 2, 5);
  read(f, first, 0, 1, 'skills.load');
  f.store.tool(
    first.id,
    executeTool(first.snapshot, { callId: 'search', name: 'knowledge.search', args: {} })
  );
  f.store.tool(
    first.id,
    executeTool(first.snapshot, {
      callId: 'folder-browse',
      name: 'knowledge.search',
      args: { mode: 'browse' },
    })
  );
  const forged = executeTool(first.snapshot, {
    callId: 'forged',
    name: 'knowledge.read',
    args: { ids: [f.loreId], offset: 20, limit: 3 },
  });
  (forged.result as any).items[0].read.text = 'FAKE';
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
test('token and entry budgets evict the least recently used whole slices and do not rescan evicted reads', async () => {
  const f = fixture();
  update(f, {
    loreContext: { ...DEFAULT_LORE_CONTEXT, maxRetainedTokens: 200, maxRetainedEntries: 2 },
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
  const saved = JSON.parse(
    String(f.store.db.prepare('SELECT snapshot FROM runs WHERE id=?').get(b.run.id)!.snapshot)
  );
  expect(saved).toMatchObject({ settled: true, history: [], resources: [] });
  expect(f.store.run(b.run.id).inputs).toEqual([]);
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
    const frozen = f.store.db.prepare('SELECT snapshot FROM runs WHERE id=?').get(b.id)!.snapshot;
    f.store.editSource(kind === 'source' ? sb.id : sa.id, {
      text: 'Edited synthetic source.',
      expectedRevision: 0,
    });
    expect(verifiedRunLoreReads(f.store, f.store.run(b.id))).toEqual([]);
    expect((await queue(f)).run.snapshot.loreContext!.entries).toEqual([]);
    expect(f.store.db.prepare('SELECT snapshot FROM runs WHERE id=?').get(b.id)!.snapshot).toBe(
      frozen
    );
  }
);

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
    .promptCompilation!.messages.map((m) =>
      m.content.map((c) => (c as { type: 'text'; text: string }).text).join('')
    )
    .join('\n');
  expect(wireText.split(f.loreText).length - 1).toBe(1);
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
