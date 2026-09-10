import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { defaultProfile } from '../core/product.js';
import type { Resource, RunSnapshot } from '../core/types.js';
import * as segments from '../core/package-source-segments.js';
import * as overrides from '../server/chat-overrides.js';
import * as outline from '../server/outline-store.js';
import * as states from '../server/package-behavior-host.js';
import * as behavior from '../server/package-behavior-run.js';
import * as lore from '../server/lore-context.js';
import * as prompt from '../server/prompt-snapshot.js';
import * as reservation from '../server/reservation-snapshot.js';
import { ChatOptionsStore } from '../server/chat-options.js';
import { helperWritingSnapshot } from '../server/helper-runtime.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), directory);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-reservation-'))
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

const clock = { iso: '2026-09-10T01:02:03.000Z', unix: 1789002123 };
const resource = (id: string): Resource => ({
  id,
  chatId: 'chat',
  kind: 'lore',
  revision: 1,
  title: id,
  description: '',
  text: `Frozen ${id}`,
});
function phases() {
  const calls: string[] = [];
  const base: RunSnapshot = {
    chatId: 'chat',
    branchId: 'branch',
    parentRevision: 'source-2',
    settingsRevision: 8,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 16 },
    request: 'Frozen request',
    history: [
      { revision: 'source-1', text: 'Frozen source one', contentHash: 'hash-1' },
      { revision: 'source-2', text: 'Frozen source two', contentHash: 'hash-2' },
    ],
    resources: [resource('manual'), resource('package:old')],
    profile: {
      ...defaultProfile('chat'),
      contents: [],
      models: {},
      packageAttachments: [{ id: 'package', revision: 1, role: 'bot' }],
    },
    executionClock: clock,
  };
  const previous = {
    compacted: [{ sourceRevision: 'source-1', sourceHash: 'hash-1' }],
    summary: 'Previously accepted summary',
  };
  const store = {
    product: {
      profile: () => base.profile,
      resources: () => {
        calls.push('resources');
        return [resource('package:refreshed'), resource('discarded-non-package')];
      },
    },
    story: {
      prepareRunInTransaction: (snapshot: RunSnapshot) => {
        calls.push('story');
        return snapshot;
      },
    },
    context: {
      prepareRun: (snapshot: RunSnapshot) => {
        calls.push('context');
        return { ...snapshot, contextPlan: { summary: '', compacted: [] } };
      },
      previous: () => {
        calls.push('previous-summary');
        return previous;
      },
    },
  } as unknown as Store;
  vi.spyOn(ChatOptionsStore.prototype, 'freeze').mockImplementation((_profile, branchId, runId) => {
    expect(branchId).toBe('branch');
    expect(runId).toBe('run');
    calls.push('consume-options');
  });
  vi.spyOn(overrides, 'freezeChatOverrides').mockImplementation(
    (_store, _profile, _roots, head) => {
      expect(head).toBe(base.parentRevision);
      calls.push('overrides');
      return undefined;
    }
  );
  vi.spyOn(segments, 'freezeSourceSegments').mockImplementation(() => {
    calls.push('segments');
    return undefined;
  });
  vi.spyOn(outline, 'freezeOutline').mockImplementation((_store, commandId, snapshot) => {
    expect(commandId).toBe('scene');
    calls.push('outline');
    return snapshot;
  });
  vi.spyOn(prompt, 'captureLogicalHistory').mockImplementation(() => {
    calls.push('logical-history');
    return [];
  });
  vi.spyOn(states, 'freezePackageStates').mockImplementation((_store, snapshot, initialize) => {
    expect(snapshot.executionClock).toEqual(clock);
    calls.push(initialize ? 'initialize-states' : 'read-states');
    return snapshot;
  });
  vi.spyOn(behavior, 'prepareRunBehavior').mockImplementation((_store, runId, snapshot) => {
    expect(runId).toBe('run');
    calls.push('before-turn');
    return snapshot;
  });
  vi.spyOn(lore, 'freezeLoreContext').mockImplementation((_store, snapshot) => {
    calls.push('lore');
    return snapshot;
  });
  vi.spyOn(prompt, 'compileSnapshotPrompt').mockImplementation((snapshot) => {
    calls.push('compile');
    return snapshot;
  });
  return { store, base, calls, previous };
}

test.each<{
  options: reservation.ReservationPurpose;
  expected: string[];
}>([
  {
    options: { purpose: 'run', runId: 'run', sceneCommandId: 'scene' },
    expected: [
      'consume-options',
      'overrides',
      'resources',
      'segments',
      'story',
      'outline',
      'logical-history',
      'initialize-states',
      'before-turn',
      'lore',
      'context',
      'compile',
    ],
  },
  {
    options: { purpose: 'authored', runId: 'run', sceneCommandId: 'scene' },
    expected: [
      'consume-options',
      'overrides',
      'resources',
      'segments',
      'outline',
      'logical-history',
      'initialize-states',
      'lore',
      'compile',
    ],
  },
  {
    options: { purpose: 'helper-artifact' },
    expected: [
      'segments',
      'story',
      'logical-history',
      'read-states',
      'lore',
      'context',
      'previous-summary',
    ],
  },
  {
    options: { purpose: 'helper-context' },
    expected: [
      'segments',
      'story',
      'logical-history',
      'read-states',
      'lore',
      'context',
      'previous-summary',
    ],
  },
  {
    options: { purpose: 'preview-main', executionClock: () => clock },
    expected: ['segments', 'story', 'logical-history', 'clock', 'read-states', 'lore'],
  },
  {
    options: { purpose: 'preview-translation', executionClock: () => clock },
    expected: ['story', 'logical-history', 'clock', 'read-states'],
  },
  { options: { purpose: 'resume-state' }, expected: ['lore', 'compile'] },
])(
  '$options.purpose preserves the reservation phase order and caller-owned input',
  ({ options, expected }) => {
    const f = phases();
    if (options.purpose === 'authored') f.base.transcriptImport = { index: 0 };
    if (options.purpose === 'preview-main' || options.purpose === 'preview-translation')
      delete f.base.executionClock;
    const fixed = structuredClone(f.base);
    const purposeOptions =
      'executionClock' in options
        ? {
            ...options,
            executionClock: () => {
              f.calls.push('clock');
              return options.executionClock();
            },
          }
        : options;
    const result = reservation.freezeReservationSnapshot(f.store, f.base, purposeOptions);
    expect(f.calls).toEqual(expected);
    for (const field of [
      'history',
      'settings',
      'settingsRevision',
      'request',
      'branchId',
      'parentRevision',
    ] as const)
      expect(result[field]).toEqual(fixed[field]);
    expect(result.executionClock).toEqual(clock);
    if (options.purpose === 'run' || options.purpose === 'authored')
      expect(result.resources.map((item) => item.id)).toEqual(['manual', 'package:refreshed']);
    else expect(result.resources).toEqual(fixed.resources);
    if (options.purpose === 'helper-artifact' || options.purpose === 'helper-context')
      expect(result.contextPlan).toMatchObject({
        compacted: f.previous.compacted,
        summary: f.previous.summary,
        recentSourceRevisions: ['source-2'],
      });
    if (options.purpose === 'resume-state') expect(result).toEqual(fixed);
  }
);

test('authored preparation requires the corresponding frozen authored marker before any phase runs', () => {
  const f = phases();
  expect(() =>
    reservation.freezeReservationSnapshot(f.store, f.base, { purpose: 'authored', runId: 'run' })
  ).toThrow('RESERVATION_AUTHORSHIP_MISMATCH');
  f.base.transcriptImport = { index: 0 };
  expect(() =>
    reservation.freezeReservationSnapshot(f.store, f.base, { purpose: 'run', runId: 'run' })
  ).toThrow('RESERVATION_AUTHORSHIP_MISMATCH');
  expect(f.calls).toEqual([]);
});

test('helper callers apply fixed options before resources and preserve pending options without database writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-reservation-')),
    store = new Store(join(directory, 'synthetic.sqlite'));
  owned.push({ store, directory });
  const prior = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: prior.revision,
    main: {
      ...prior.main,
      values: { tone: 'calm' },
      program: {
        ...prior.main.program,
        controls: [
          {
            id: 'tone',
            label: 'Tone',
            type: 'select',
            default: 'calm',
            options: [
              { label: 'Calm', value: 'calm' },
              { label: 'Bold', value: 'bold' },
              { label: 'Warm', value: 'warm' },
            ],
          },
        ],
      },
    },
  });
  const chat = createFixtureChat(store, 'Read-only helper reservation'),
    service = new ChatOptionsStore(store),
    authority = { requestId: 'direct-ui', assert: () => {} },
    initial = service.get(chat.id);
  service.fixed(
    chat.id,
    {
      branchId: initial.branchId,
      expectedRevision: initial.revision,
      binding: initial.binding,
      values: { tone: 'bold' },
      operationId: randomUUID(),
    },
    authority
  );
  const fixed = service.get(chat.id);
  service.stage(
    chat.id,
    {
      branchId: fixed.branchId,
      expectedRevision: fixed.revision,
      expectedHeadRevision: fixed.headRevision,
      binding: fixed.binding,
      values: { tone: 'warm' },
      operationId: randomUUID(),
    },
    authority
  );
  const pending = service.get(chat.id).pending,
    before = store.db.prepare('SELECT total_changes() AS n').get(),
    resources = store.product.resources.bind(store.product),
    observed: unknown[] = [];
  vi.spyOn(store.product, 'resources').mockImplementation((chatId, profile) => {
    observed.push(profile?.chatOptions?.values);
    return resources(chatId, profile);
  });
  for (const purpose of ['artifact', 'context'] as const) {
    const result = helperWritingSnapshot(store, chat.id, fixed.branchId, purpose);
    expect(result.profile?.chatOptions).toMatchObject({ values: { tone: 'bold' }, pendingIds: [] });
    expect(result.executionPurpose).toBe(purpose === 'artifact' ? 'artifact' : undefined);
    expect(result.promptCompilation).toBeUndefined();
  }
  expect(observed).toEqual([{ tone: 'bold' }, { tone: 'bold' }]);
  expect(service.get(chat.id).pending).toEqual(pending);
  expect(store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});
