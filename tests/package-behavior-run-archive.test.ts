import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ContentPackage } from '../core/content-package.js';
import type { RunSnapshot } from '../core/types.js';
import { listBehaviorTools } from '../core/package-behavior-tools.js';
import { Store, type Run } from '../server/store.js';
import { executeRunBehaviorTool, runBehaviorProgress } from '../server/package-behavior-run.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { forkChat } from '../server/chat-fork.js';
import { buildMainProviderRequest } from '../server/main-request.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    const rel = relative(resolve(tmpdir()), resolve(item.path));
    if (
      isAbsolute(rel) ||
      rel.startsWith('..') ||
      !basename(item.path).startsWith('uimori-run-behavior-archive-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(item.path, { recursive: true, force: true });
  }
});
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-run-behavior-archive-')),
    store = new Store(join(path, 'test.sqlite'));
  owned.push({ path, store });
  return store;
}
function fixture(mode: 'annotation' | 'authoritative' = 'authoritative') {
  const store = database(),
    chat = createFixtureChat(store, 'Synthetic run archive', 'calm');
  const pkg: ContentPackage = {
    version: 1,
    id: 'rules',
    revision: 1,
    title: 'Synthetic rules',
    description: '',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      mode,
      stateSchema: {
        type: 'record',
        properties: { count: { type: 'number', min: 0, max: 100, integer: true } },
      },
      initialState: { count: 0 },
      actions: [
        {
          id: 'weather',
          triggers: ['before-turn'],
          inputSchema: { type: 'record', properties: {} },
          draws: [{ id: 'weather', type: 'choice', values: ['sun', 'rain'] }],
          effects: [{ path: ['count'], value: 1 }],
          result: { context: ['draws', 'weather'] },
        },
        {
          id: 'roll',
          triggers: ['model'],
          inputSchema: {
            type: 'record',
            properties: { purpose: { type: 'string', maxLength: 30 } },
          },
          draws: [{ id: 'die', type: 'integer', min: 1, max: 6 }],
          effects: [
            {
              path: ['count'],
              value: {
                op: 'add',
                args: [{ context: ['state', 'count'] }, { context: ['draws', 'die'] }],
              },
            },
          ],
          result: { context: ['nextState', 'count'] },
        },
      ],
      outputParsers: [
        {
          id: 'state',
          format: 'json',
          start: '<state>',
          end: '</state>',
          fields: [{ path: ['count'], from: ['count'] }],
        },
      ],
    },
  };
  const content = store.product.content({
    kind: 'module',
    title: pkg.title,
    description: '',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as any;
  const profile = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    personaReference: profile.personaReference,
    routes: profile.routes,
    image: false,
    packageAttachments: [
      ...(profile.packageAttachments ?? []),
      { id: content.id, revision: 1, role: 'module' },
    ],
  });
  return { store, chat, instanceId: `${content.id}:module` };
}
function start(store: Store, chatId: string): Run {
  const chat = store.chat(chatId),
    request = 'Synthetic next scene';
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => {
      const profile = store.product.snapshot(chatId)!;
      return {
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request,
        history: store.history(current.headRevision),
        resources: store.product.resources(chatId, profile),
        profile,
      } satisfies RunSnapshot;
    }
  ).run;
  expect(store.startRun(run.id)).toBe(true);
  return store.run(run.id);
}
function model(store: Store, run: Run) {
  const binding = listBehaviorTools(run.snapshot)[0],
    event = executeRunBehaviorTool(store, run.id, binding, {
      callId: randomUUID(),
      name: binding.tool.name,
      args: { purpose: 'persuasion' },
    });
  expect(event.denied).toBe(false);
  return event;
}
function complete(store: Store, run: Run) {
  return store.completeRun(
    run.id,
    'Exact synthetic prose. <state>{"count":11}</state>',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}

describe('v11 recorded automatic/model behavior archive', () => {
  test('RBA01 automatic result projection is compact and committed journals roundtrip exactly', () => {
    const f = fixture(),
      run = start(f.store, f.chat.id);
    model(f.store, run);
    const source = complete(f.store, run),
      archive = f.store.product.export();
    expect(run.snapshot.behaviorExecution?.baseStates[0].state).toEqual({ count: 0 });
    expect(run.snapshot.packageStates?.[0].state).toEqual({ count: 1 });
    expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
      stateRevision: 3,
      state: { count: 11 },
      status: 'ready',
    });
    expect(
      archive.tables.package_behavior_journal.map((row) => JSON.parse(row.result).provenance)
    ).toEqual(['before-turn', 'model-tool', 'local-output-parser']);
    expect(
      archive.tables.package_behavior_journal
        .slice(0, 2)
        .map((row) => JSON.parse(row.result).actionResult)
    ).toEqual(runBehaviorProgress(f.store, run.id)!.entries.map((entry) => entry.result));
    const target = database();
    expect(target.product.import(archive)).toEqual({ restored: true, chats: 1 });
    expect(target.run(run.id).snapshot).toEqual(f.store.run(run.id).snapshot);
    expect(target.source(source.id).text).toBe(source.text);
    for (const name of [
      'package_behavior_entropy',
      'package_behavior_opportunities',
      'package_behavior_runs',
      'package_behavior_outputs',
    ])
      expect(target.product.export().tables[name]).toEqual(archive.tables[name]);
    const routed = structuredClone(run.snapshot);
    routed.profile!.models.main = {
      id: 'model',
      revision: 1,
      title: 'Synthetic fixture',
      connectionId: 'connection',
      modelId: 'fixture',
      temperature: null,
      maxOutputTokens: 1024,
      connection: {
        id: 'connection',
        revision: 1,
        title: 'Fixture',
        protocol: 'fixture-sse-v1',
        endpoint: 'http://127.0.0.1:19999/turn',
        enabled: true,
        catalog: [],
        catalogError: null,
      },
    };
    const request = buildMainProviderRequest(routed).request,
      projected = request.input.source as Record<string, any>;
    expect(projected.automaticResults).toEqual(run.snapshot.behaviorExecution!.automaticResults);
    expect(JSON.stringify(projected.automaticResults)).not.toMatch(
      /drawSeed|hostRuntime|before|after|stateSchema/
    );
  });

  test('RBA02 cancelled staged outcomes restore without committing state and replay the same opportunity', () => {
    const f = fixture(),
      run = start(f.store, f.chat.id),
      event = model(f.store, run),
      before = runBehaviorProgress(f.store, run.id)!;
    f.store.finishRun(run.id, 'cancelled', 'Synthetic cancellation');
    expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
      stateRevision: 0,
      state: { count: 0 },
    });
    const target = database();
    target.product.import(f.store.product.export());
    expect(target.product.export().tables.package_behavior_journal).toEqual([]);
    const retry = start(target, f.chat.id),
      replay = model(target, retry),
      after = runBehaviorProgress(target, retry.id)!;
    expect(replay.result).toEqual(event.result);
    expect(after.opportunityId).toBe(before.opportunityId);
    expect(after.entries).toEqual(before.entries);
    expect(target.product.export().tables.package_behavior_opportunities).toHaveLength(1);
  });

  test('RBA03 candidate and fork preserve recorded outcomes with their respective opportunity ownership', () => {
    const f = fixture(),
      run = start(f.store, f.chat.id);
    model(f.store, run);
    const source = complete(f.store, run);
    const candidate = f.store.candidate(run.id, randomUUID(), 'Synthetic candidate').run;
    expect(f.store.startRun(candidate.id)).toBe(true);
    model(f.store, candidate);
    complete(f.store, candidate);
    expect(runBehaviorProgress(f.store, candidate.id)?.opportunityId).toBe(
      run.snapshot.behaviorExecution?.opportunityId
    );
    const fork = forkChat(f.store, f.chat.id, {
        fromRevision: source.id,
        idempotencyKey: randomUUID(),
      }),
      copied = f.store.run(f.store.source(fork.headRevision!).runId);
    expect(copied.snapshot.behaviorExecution?.opportunityId).not.toBe(
      run.snapshot.behaviorExecution?.opportunityId
    );
    expect(runBehaviorProgress(f.store, copied.id)?.entries).toEqual(
      runBehaviorProgress(f.store, run.id)?.entries
    );
    const target = database();
    expect(target.product.import(f.store.product.export())).toEqual({ restored: true, chats: 2 });
    expect(target.run(copied.id).snapshot).toEqual(copied.snapshot);
  });

  test.each(['annotation', 'authoritative'] as const)(
    'RBA03b failed %s output restores only the states actually committed by the host',
    (mode) => {
      const f = fixture(mode),
        run = start(f.store, f.chat.id);
      model(f.store, run);
      const progress = runBehaviorProgress(f.store, run.id)!,
        source = f.store.completeRun(
          run.id,
          'Unchanged source without parser markers.',
          { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
          run.snapshot.settings
        );
      const expected =
        mode === 'annotation' ? progress.states[0] : run.snapshot.behaviorExecution!.baseStates[0];
      const archived = f.store.product.export(),
        output = JSON.parse(archived.tables.package_behavior_outputs[0].body);
      expect(output).toMatchObject({ status: 'failed', after: expected });
      const target = database();
      target.product.import(archived);
      expect(target.source(source.id).text).toBe(source.text);
      expect(behaviorDetail(target, f.chat.id).instances[0]).toMatchObject({
        state: expected.state,
        stateRevision: expected.stateRevision,
      });
      output.after.state.count = 99;
      archived.tables.package_behavior_outputs[0].body = JSON.stringify(output);
      expect(() => database().product.import(archived)).toThrow();
    }
  );

  test('RBA04 forged staged calculations and missing current tables reject atomically, restoring local entropy', () => {
    const f = fixture(),
      run = start(f.store, f.chat.id);
    model(f.store, run);
    complete(f.store, run);
    const base = f.store.product.export();
    const change = (row: any, update: (value: any) => void) => {
      const value = JSON.parse(row.body);
      update(value);
      row.body = JSON.stringify(value);
    };
    const snap = (archive: any, update: (value: any) => void) => {
      const row = archive.tables.runs[0],
        value = JSON.parse(row.snapshot);
      update(value);
      row.snapshot = JSON.stringify(value);
    };
    const attacks: ((archive: any) => void)[] = [
      (a) => {
        delete a.tables.package_behavior_runs;
      },
      (a) => {
        a.tables.package_behavior_entropy = [];
      },
      (a) => {
        a.tables.package_behavior_entropy[0].seed = 'invalid';
      },
      (a) => {
        a.tables.package_behavior_entropy[0].seed = '0'.repeat(64);
      },
      (a) => {
        a.tables.package_behavior_opportunities[0].chat_id = 'missing';
      },
      (a) => {
        change(a.tables.package_behavior_opportunities[0], (p) => {
          p.seed = '0'.repeat(64);
        });
      },
      (a) => {
        change(a.tables.package_behavior_opportunities[0], (p) => {
          p.entries.push(p.entries[0]);
        });
      },
      (a) => {
        change(a.tables.package_behavior_opportunities[0], (p) => {
          p.entries[1].input = { outside: true };
        });
      },
      (a) => {
        change(a.tables.package_behavior_opportunities[0], (p) => {
          p.entries[1].drawSeed = '0'.repeat(64);
        });
      },
      (a) => {
        change(a.tables.package_behavior_opportunities[0], (p) => {
          p.entries[1].draws.die = 99;
        });
      },
      (a) => {
        change(a.tables.package_behavior_opportunities[0], (p) => {
          p.entries[1].result = 99;
        });
      },
      (a) => {
        change(a.tables.package_behavior_opportunities[0], (p) => {
          p.entries[1].after.state.count = 99;
        });
      },
      (a) => {
        change(a.tables.package_behavior_opportunities[0], (p) => {
          p.entries[1].hostRuntime.state.count = 99;
        });
      },
      (a) => {
        change(a.tables.package_behavior_runs[0], (p) => {
          p.entries.reverse();
        });
      },
      (a) => {
        change(a.tables.package_behavior_runs[0], (p) => {
          p.states[0].state.count = 99;
        });
      },
      (a) => {
        change(a.tables.package_behavior_runs[0], (p) => {
          p.opportunityId = '0'.repeat(64);
        });
      },
      (a) => {
        a.tables.package_behavior_runs = [];
      },
      (a) => {
        a.tables.package_behavior_journal.splice(1, 1);
      },
      (a) => {
        const row = a.tables.package_behavior_journal[1],
          result = JSON.parse(row.result);
        result.actionResult = 99;
        row.result = JSON.stringify(result);
      },
      (a) => {
        snap(a, (s) => {
          s.behaviorExecution.automaticResults[0].result = 'forged';
        });
      },
      (a) => {
        snap(a, (s) => {
          s.behaviorExecution.baseStates[0].state.count = 99;
        });
      },
      (a) => {
        snap(a, (s) => {
          s.packageStates[0].state.count = 99;
        });
      },
      (a) => {
        snap(a, (s) => {
          delete s.behaviorExecution;
        });
      },
    ];
    for (const [index, mutate] of attacks.entries()) {
      const archive = structuredClone(base);
      mutate(archive);
      const target = database(),
        empty = target.product.export().tables;
      expect(() => target.product.import(archive), `attack ${index}`).toThrow();
      expect(target.product.export().tables).toEqual(empty);
    }
  });
});
