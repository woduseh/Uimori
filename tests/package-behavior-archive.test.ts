import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { performBehaviorAction } from '../server/package-behavior-host.js';
import type { ContentPackage } from '../core/content-package.js';
import type { RunSnapshot } from '../core/types.js';
import { packageBehaviorTables } from '../server/package-behavior-archive.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    const rel = relative(resolve(tmpdir()), resolve(item.path));
    if (
      isAbsolute(rel) ||
      rel.startsWith('..') ||
      !basename(item.path).startsWith('uimori-behavior-archive-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(item.path, { recursive: true, force: true });
  }
});
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-behavior-archive-'));
  const store = new Store(join(path, 'test.sqlite'));
  owned.push({ path, store });
  return store;
}
function fixture() {
  const store = database();
  const chat = createFixtureChat(store, 'synthetic behavior archive', 'calm');
  const pkg: ContentPackage = {
    version: 1,
    id: 'example',
    revision: 1,
    title: 'Example',
    description: 'Synthetic state',
    body: 'Preserve original prose.',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      stateSchema: {
        type: 'record',
        properties: {
          count: { type: 'number', min: 0, max: 100, integer: true },
          visible: { type: 'boolean' },
        },
      },
      initialState: { count: 0, visible: false },
      actions: [
        {
          id: 'draw',
          inputSchema: { type: 'record', properties: {} },
          draws: [{ id: 'd6', type: 'integer', min: 1, max: 6 }],
          effects: [{ path: ['count'], value: { context: ['draws', 'd6'] } }],
        },
      ],
      outputParsers: [
        {
          id: 'state',
          format: 'json',
          start: '<state>',
          end: '</state>',
          fields: [
            { path: ['count'], from: ['count'] },
            { path: ['visible'], from: ['visible'] },
          ],
        },
      ],
    },
  };
  const content = store.product.content({
    kind: 'module',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as any;
  const p = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    expectedRevision: p.revision,
    attachments: p.attachments,

    routes: p.routes,
    image: p.image,
    packageAttachments: [
      ...(p.packageAttachments ?? []),
      { id: content.id, revision: content.revision, role: 'module' },
    ],
  });
  const instanceId = `${content.id}:module`,
    branchId = `main:${chat.id}`;
  performBehaviorAction(store, chat.id, branchId, instanceId, {
    actionId: 'draw',
    input: {},
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'draw',
  });
  const request = 'Synthetic request';
  const run = store.createRun(
    chat.id,
    {
      request,
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => {
      const profile = store.product.snapshot(chat.id)!;
      return {
        chatId: chat.id,
        parentRevision: null,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request,
        history: [],
        resources: store.product.resources(chat.id, profile),
        profile,
      } satisfies RunSnapshot;
    }
  ).run;
  expect(store.startRun(run.id)).toBe(true);
  const source = store.completeRun(
    run.id,
    'Unchanged story. <state>{"count":0,"visible":false}</state>',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  return { store, chat, content, instanceId, branchId, run: store.run(run.id), source };
}
describe('package behavior archive v11', () => {
  it('roundtrips clocks, frozen states, original text, draw seed, action and parser journals', () => {
    const f = fixture(),
      archive = f.store.product.export(),
      before = structuredClone(archive);
    expect(archive.version).toBe(14);
    expect(archive.tables.package_behavior_journal).toHaveLength(2);
    const target = database();
    expect(target.product.import(archive)).toEqual({ restored: true, chats: 1 });
    expect(archive).toEqual(before);
    expect(target.run(f.run.id).snapshot).toEqual(f.run.snapshot);
    expect(target.source(f.source.id).text).toBe(f.source.text);
    for (const table of packageBehaviorTables)
      expect(target.product.export().tables[table]).toEqual(archive.tables[table]);
  });
  it('rejects forged definition hashes, state values, draws, payloads and source ownership atomically', () => {
    const f = fixture(),
      base = f.store.product.export();
    const attacks: ((a: any) => void)[] = [
      (a) => {
        a.tables.package_behavior_states[0].definition_hash = '0'.repeat(64);
      },
      (a) => {
        a.tables.package_behavior_states[0].state = '{"count":101,"visible":false}';
      },
      (a) => {
        const r = JSON.parse(a.tables.package_behavior_journal[0].result);
        r.draws.d6 = 99;
        a.tables.package_behavior_journal[0].result = JSON.stringify(r);
      },
      (a) => {
        const p = JSON.parse(a.tables.package_behavior_journal[0].payload);
        p.input = { forged: 1 };
        a.tables.package_behavior_journal[0].payload = JSON.stringify(p);
      },
      (a) => {
        a.tables.package_behavior_outputs[0].source_id = 'missing';
      },
      (a) => {
        const s = JSON.parse(a.tables.runs[0].snapshot);
        s.packageStates[0].packageRevision = 999;
        a.tables.runs[0].snapshot = JSON.stringify(s);
      },
      (a) => {
        const s = JSON.parse(a.tables.runs[0].snapshot);
        s.executionClock.unix += 1;
        a.tables.runs[0].snapshot = JSON.stringify(s);
      },
      (a) => {
        a.tables.package_behavior_heads[0].draws = '{"__proto__":{}}';
      },
    ];
    for (const mutate of attacks) {
      const archive = structuredClone(base);
      mutate(archive);
      const target = database();
      expect(() => target.product.import(archive)).toThrow();
      expect(target.chats()).toEqual([]);
      expect(target.db.prepare('SELECT count(*) n FROM package_behavior_states').get()?.n).toBe(0);
    }
  });
  it('keeps historical source hashes and ready dependency rows after a source edit', () => {
    const f = fixture();
    f.store.editSource(f.source.id, {
      text: 'Edited source, previous parser stays historical.',
      expectedRevision: 0,
    });
    const target = database();
    expect(target.product.import(f.store.product.export())).toEqual({ restored: true, chats: 1 });
    expect(target.sourceOriginal(f.source.id).text).toBe(f.source.text);
    expect(target.source(f.source.id).text).toMatch(/^Edited/);
  });
});
