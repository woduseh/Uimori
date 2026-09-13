import { updateTestProfile } from './fixtures/model-workspace.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Run } from '../server/store.js';
import {
  behaviorDetail,
  freezePackageStates,
  performBehaviorAction,
} from '../server/package-behavior-host.js';
import {
  executeRunBehaviorTool,
  runBehaviorProgress,
  isRecoverableBehaviorExecutionError,
} from '../server/package-behavior-run.js';
import { listBehaviorTools } from '../core/package-behavior-tools.js';
import { buildMainInput } from '../core/provider.js';
import type { Content, PromptPreset } from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import {
  validatePackageBehavior,
  BehaviorError,
  BehaviorEvaluationError,
  evaluateBehaviorAction,
  parseBehaviorOutput,
  type PackageBehavior,
} from '../core/package-behavior.js';
import type { RunSnapshot } from '../core/types.js';
import { forkChat } from '../server/chat-fork.js';
import { validatePackageBehaviorRunSnapshot } from '../server/package-behavior-archive.js';
import { compiledPackages } from '../core/package-context.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { compilePackageAttachment } from '../core/package-runtime.js';
import { compilePromptProgram } from '../core/prompt-program.js';
import { PromptBudget, PromptEvaluationError } from '../core/prompt-values.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';

const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-behavior-run-'))
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-behavior-run-')),
    store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
const number = { type: 'number' as const, min: 0, max: 1000, integer: true };
function definition(): PackageBehavior {
  return {
    revision: 1,
    schemaVersion: 1,
    stateSchema: {
      type: 'record',
      properties: { days: number, score: number, die: { ...number, min: 0, max: 6 } },
    },
    initialState: { days: 0, score: 0, die: 0 },
    actions: [
      {
        id: 'day',
        label: '새 날',
        inputSchema: { type: 'record', properties: {} },
        triggers: ['before-turn'],
        effects: [
          { path: ['days'], value: { op: 'add', args: [{ context: ['state', 'days'] }, 1] } },
        ],
        result: { context: ['nextState', 'days'] },
      },
      {
        id: 'check',
        label: '판정',
        inputSchema: { type: 'record', properties: { bonus: { ...number, max: 5 } } },
        triggers: ['model'],
        draws: [{ id: 'die', type: 'integer', min: 1, max: 6 }],
        effects: [
          { path: ['die'], value: { context: ['draws', 'die'] } },
          {
            path: ['score'],
            value: {
              op: 'add',
              args: [{ context: ['draws', 'die'] }, { context: ['input', 'bonus'] }],
            },
          },
        ],
        result: {
          op: 'object',
          args: [
            'die',
            { context: ['draws', 'die'] },
            'score',
            { context: ['nextState', 'score'] },
          ],
        },
      },
    ],
    outputParsers: [],
  };
}
function fixture(change?: (b: PackageBehavior) => void) {
  const store = database(),
    behavior = definition();
  change?.(behavior);
  const pkg: ContentPackage = {
    version: 1,
    id: 'synthetic',
    revision: 1,
    title: 'Synthetic execution',
    description: '',
    body: 'Synthetic only',
    lore: [],
    controls: [],
    transforms: [],
    behavior,
    instructions: [
      {
        id: 'day',
        target: 'main',
        text: '',
        template: [
          { kind: 'text', text: 'DAY=' },
          { kind: 'value', expression: { context: ['state', 'days'] } },
        ],
      },
    ],
  };
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: '',
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic run', 'calm', { botId: content.id });
  const prompt = store.product.promptPreset({
    title: 'Synthetic composed',
    role: 'main',
    text: '',
    program: {
      version: 1,
      controls: [],
      blocks: [
        { id: 'bot', title: 'Bot', kind: 'slot', role: 'system', slot: 'bot' },
        { id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' },
      ],
    },
  }) as PromptPreset;
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: prompt.title, program: prompt.program, values: {} },
  });
  return {
    store,
    behavior,
    chat,
    content,
    instanceId: `${content.id}:bot`,
    branchId: `main:${chat.id}`,
  };
}
type Fixture = ReturnType<typeof fixture>;
function snapshot(f: Fixture, branchId = f.branchId): RunSnapshot {
  const chat = f.store.chat(f.chat.id),
    branch = f.store.product.branch(chat.id, branchId),
    profile = f.store.product.snapshot(chat.id);
  return {
    chatId: chat.id,
    branchId,
    parentRevision: branch.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: 'Synthetic next',
    history: f.store.history(branch.headRevision),
    profile,
    resources: f.store.product.resources(chat.id, profile),
  };
}
function admit(f: Fixture, branchId = f.branchId, key = randomUUID()) {
  const s = snapshot(f, branchId);
  return f.store.createRun(
    f.chat.id,
    {
      request: s.request,
      expectedRevision: s.parentRevision,
      expectedSettingsRevision: s.settingsRevision,
      branchId,
      idempotencyKey: key,
    },
    () => s
  ).run;
}
function start(f: Fixture, run = admit(f)) {
  expect(f.store.startRun(run.id)).toBe(true);
  return f.store.run(run.id);
}
function call(f: Fixture, run: Run, bonus = 1, callId = randomUUID()) {
  const binding = listBehaviorTools(run.snapshot).find((t) => t.actionId === 'check')!;
  return executeRunBehaviorTool(f.store, run.id, binding, {
    callId,
    name: binding.tool.name,
    args: { bonus },
  });
}
function finish(f: Fixture, run: Run, text = 'Original synthetic fiction.') {
  return f.store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
function current(f: Fixture, branchId = f.branchId) {
  return behaviorDetail(f.store, f.chat.id, branchId).instances[0];
}
function frozenTables(f: Fixture) {
  return Object.fromEntries(
    [
      'package_behavior_states',
      'package_behavior_journal',
      'package_behavior_heads',
      'package_behavior_opportunities',
      'package_behavior_runs',
      'package_behavior_entropy',
    ].map((t) => [t, f.store.db.prepare(`SELECT * FROM ${t}`).all()])
  );
}

test('BETA-BEH01 failed automatic evaluation retains state and prose, with explicit unavailable snapshot through fork/archive', () => {
  const f = fixture((b) => {
    b.actions[0].effects[0].value = 1001;
  });
  const run = start(f);
  expect(run.snapshot.packageStates).toEqual([]);
  expect(run.snapshot.behaviorExecution).toBeUndefined();
  expect(runBehaviorProgress(f.store, run.id)).toBeUndefined();
  expect(run.snapshot.packageBehaviorUnavailable).toEqual([
    expect.objectContaining({
      instanceId: f.instanceId,
      stage: 'preparation',
      code: 'BEHAVIOR_NUMBER_VALUE',
    }),
  ]);
  expect(current(f).state).toEqual({ days: 0, score: 0, die: 0 });
  const compiled = compiledPackages(run.snapshot, 'main')[0];
  expect(compiled.pinned.some((item) => item.text === 'Synthetic only')).toBe(true);
  expect(compiled.unavailableInstructions).toBeUndefined();
  expect(compiled.instructions.some((item) => item.text === 'DAY=null')).toBe(true);
  expect(compiled.instructions.some((item) => item.text.includes('unavailable'))).toBe(true);
  const source = finish(f, run, 'Writing survives the optional action failure.');
  const fork = forkChat(f.store, f.chat.id, {
    fromRevision: source.id,
    idempotencyKey: randomUUID(),
  });
  expect(
    f.store.run(f.store.source(fork.headRevision!).runId).snapshot.packageBehaviorUnavailable
  ).toEqual(run.snapshot.packageBehaviorUnavailable);
  const restored = database();
  expect(restored.product.import(f.store.product.export())).toMatchObject({ restored: true });
  expect(restored.run(run.id).snapshot.packageBehaviorUnavailable).toEqual(
    run.snapshot.packageBehaviorUnavailable
  );
  expect(restored.source(source.id).text).toBe(source.text);
});

test('BETA-BEH02 unavailable metadata rejects duplicate, foreign revision and mixed ready state', () => {
  const f = fixture((b) => {
    b.actions[0].effects[0].value = 1001;
  });
  const run = admit(f);
  expect(() => validatePackageBehaviorRunSnapshot(f.store, run.snapshot)).not.toThrow();
  const duplicate = structuredClone(run.snapshot);
  duplicate.packageBehaviorUnavailable!.push(
    structuredClone(duplicate.packageBehaviorUnavailable![0])
  );
  expect(() => validatePackageBehaviorRunSnapshot(f.store, duplicate)).toThrow(
    'duplicate unavailable'
  );
  const wrongRevision = structuredClone(run.snapshot);
  wrongRevision.packageBehaviorUnavailable![0].packageRevision++;
  expect(() => validatePackageBehaviorRunSnapshot(f.store, wrongRevision)).toThrow(
    'unavailable attachment'
  );
  const foreign = structuredClone(run.snapshot);
  foreign.packageBehaviorUnavailable![0].packageId = 'unrelated-package';
  expect(() => validatePackageBehaviorRunSnapshot(f.store, foreign)).toThrow(
    'unavailable attachment'
  );
  const mixed = structuredClone(run.snapshot);
  mixed.packageStates = freezePackageStates(f.store, snapshot(f), false).packageStates;
  expect(() => validatePackageBehaviorRunSnapshot(f.store, mixed)).toThrow('missing frozen state');
  const forgedToolCause = structuredClone(run.snapshot);
  forgedToolCause.packageBehaviorUnavailable![0].stage = 'tools';
  forgedToolCause.packageBehaviorUnavailable![0].code = 'BEHAVIOR_MODEL_TOOLS_UNSUPPORTED';
  expect(() => validatePackageBehaviorRunSnapshot(f.store, forgedToolCause)).toThrow(
    'unavailable tool capability'
  );
  const wrongRetained = structuredClone(run.snapshot);
  wrongRetained.packageBehaviorUnavailable![0].retainedState!.packageRevision = 99;
  expect(() => validatePackageBehaviorRunSnapshot(f.store, wrongRetained)).toThrow();
});

test('BETA-BEH07 unavailable paths and invalid optional expressions isolate only their instructions', () => {
  const f = fixture((b) => {
    b.actions[0].effects[0].value = 1001;
  });
  const work = structuredClone(admit(f).snapshot);
  work.profile!.packages![0].instructions.push(
    { id: 'plain', target: 'main', text: 'Keep this independent instruction.' },
    {
      id: 'peer-state',
      target: 'main',
      text: '',
      template: [{ kind: 'value', expression: { context: ['packages', '0', 'state', 'days'] } }],
    },
    {
      id: 'peer-title',
      target: 'main',
      text: '',
      template: [{ kind: 'value', expression: { context: ['packages', '0', 'title'] } }],
    }
  );
  const compiled = compiledPackages(work, 'main')[0];
  expect(compiled.unavailableInstructions).toBeUndefined();
  expect(
    compiled.instructions.some((item) => item.text === 'Keep this independent instruction.')
  ).toBe(true);
  expect(compiled.instructions.some((item) => item.text === 'Synthetic execution')).toBe(true);
  work.profile!.packages![0].instructions.push({
    id: 'invalid-independent',
    target: 'main',
    text: '',
    template: [{ kind: 'value', expression: { op: 'add', args: ['invalid number', 1] } }],
  });
  const after = compiledPackages(work, 'main')[0];
  expect(after.unavailableInstructions).toContainEqual({
    id: 'invalid-independent',
    code: 'PROMPT_NUMBER_REQUIRED',
  });
  expect(
    after.instructions.some((item) => item.text === 'Keep this independent instruction.')
  ).toBe(true);
});

test('BETA-BEH08 dynamic package-state reads fail only their add-on instruction', () => {
  const f = fixture((b) => {
    b.actions[0].effects[0].value = 1001;
  });
  const work = structuredClone(admit(f).snapshot);
  work.profile!.packages![0].instructions.push(
    {
      id: 'plain-after-failure',
      target: 'main',
      text: 'The independent writing instruction remains.',
    },
    {
      id: 'handled-unavailable',
      target: 'main',
      text: '',
      template: [
        {
          kind: 'if',
          condition: { op: 'equal', args: [{ context: ['stateStatus'] }, 'unavailable'] },
          then: [{ kind: 'text', text: 'Explicit unavailable fallback remains.' }],
          else: [
            { kind: 'value', expression: { op: 'add', args: [{ context: ['state', 'days'] }, 1] } },
          ],
        },
      ],
    },
    {
      id: 'dynamic-state',
      target: 'main',
      text: '',
      template: [
        {
          kind: 'value',
          expression: {
            op: 'add',
            args: [
              {
                op: 'get',
                args: [
                  {
                    op: 'get',
                    args: [{ op: 'get', args: [{ context: ['packages'] }, 0] }, 'state'],
                  },
                  'days',
                ],
              },
              1,
            ],
          },
        },
      ],
    }
  );
  const result = compiledPackages(work, 'main')[0];
  expect(result.unavailableInstructions).toContainEqual({
    id: 'dynamic-state',
    code: 'PROMPT_NUMBER_REQUIRED',
  });
  expect(
    result.instructions.some((item) => item.text === 'The independent writing instruction remains.')
  ).toBe(true);
  expect(
    result.instructions.some((item) => item.text === 'Explicit unavailable fallback remains.')
  ).toBe(true);
  const compiledSnapshot = compileSnapshotPrompt(work);
  expect(compiledSnapshot.promptCompilation!.warnings).toContain(
    `PACKAGE_INSTRUCTION_UNAVAILABLE:${JSON.stringify({ instanceId: f.instanceId, instructionId: 'dynamic-state', code: 'PROMPT_NUMBER_REQUIRED' })}`
  );
  expect(
    work.promptCompilation?.warnings.some((warning) =>
      warning.startsWith('PACKAGE_INSTRUCTION_UNAVAILABLE:')
    ) ?? false
  ).toBe(false);
});

test('BETA-BEH09 shared instruction budgets do not reset steps or elapsed time, and never enter serialized compilation', () => {
  const pkg: ContentPackage = {
    version: 1,
    id: 'budget',
    revision: 1,
    title: 'Budget fixture',
    description: '',
    lore: [],
    controls: [],
    transforms: [],
    instructions: Array.from({ length: 30 }, (_, index) => ({
      id: `i${index}`,
      target: 'main',
      text: `Instruction ${index}`,
    })),
  };
  const compiled = compilePackageAttachment(
    pkg,
    { id: pkg.id, revision: 1, role: 'bot' },
    { chatId: 'test', target: 'main', budget: new PromptBudget({ maxSteps: 100 }) }
  );
  expect(compiled.unavailableInstructions?.length).toBeGreaterThan(0);
  expect(compiled.unavailableInstructions?.every((item) => item.code === 'PROMPT_STEP_LIMIT')).toBe(
    true
  );
  const applied = compiled.instructions.filter((item) => item.id.includes(':instruction:'));
  expect(applied.length).toBeGreaterThan(0);
  expect(applied.length).toBeLessThan(30);
  expect(applied.map((item) => item.id)).toEqual(
    applied.map((_, index) => `package:budget:bot:instruction:i${index}`)
  );
  const program = {
    version: 1 as const,
    controls: [],
    blocks: [
      { id: 'history', title: 'History', kind: 'history' as const, from: 0, to: 'end' as const },
      {
        id: 'cache',
        title: 'Cache',
        kind: 'cache' as const,
        depth: 1,
        role: 'all' as const,
        policy: 'prefer' as const,
      },
    ],
  };
  const context = {
    slots: {},
    history: [{ id: 'current', role: 'user' as const, text: 'Prompt content', current: true }],
  };
  const plain = compilePromptProgram(program, context);
  expect(compilePromptProgram(program, { ...context, budget: new PromptBudget() })).toEqual(plain);
  expect(JSON.stringify(plain)).not.toContain('budget');
  expect(() =>
    compilePromptProgram(program, {
      ...context,
      limits: { maxSteps: 100 },
      budget: new PromptBudget(),
    })
  ).toThrow('PROMPT_INVALID_BUDGET');
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    const budget = new PromptBudget({ maxMilliseconds: 10 });
    clock.mockReturnValue(11);
    expect(() => compilePromptProgram(program, { ...context, budget })).toThrow(
      'PROMPT_TIME_LIMIT'
    );
  } finally {
    clock.mockRestore();
  }
});

test('BETA-BEH10 master PromptProgram evaluation remains distinct from optional package instruction failures', () => {
  const f = fixture();
  const work: RunSnapshot = {
    ...snapshot(f),
    packageStates: [],
    packageBehaviorUnavailable: [
      {
        instanceId: f.instanceId,
        packageId: f.content.id,
        packageRevision: 1,
        role: 'bot',
        stage: 'state',
        code: 'BEHAVIOR_STATE_STALE',
      },
    ],
  };
  const program = {
    version: 1 as const,
    controls: [],
    blocks: [
      {
        id: 'master',
        title: 'Master',
        kind: 'message' as const,
        role: 'system' as const,
        template: [
          {
            kind: 'let' as const,
            name: 'selected',
            value: { op: 'get' as const, args: [{ context: ['packages'] }, 0] },
            body: [
              {
                kind: 'value' as const,
                expression: {
                  op: 'add' as const,
                  args: [{ local: 'selected', path: ['state', 'days'] }, 1],
                },
              },
            ],
          },
        ],
      },
      { id: 'current', title: 'Current', kind: 'current' as const },
    ],
  };
  const before = structuredClone(work);
  expect(() => compileSnapshotPrompt(work, program)).toThrow('PROMPT_NUMBER_REQUIRED');
  expect(work).toEqual(before);
});

test('BETA-BEH03 database failures are not swallowed by behavior admission or tool execution', async () => {
  const f = fixture();
  const failure = new Error('Synthetic database failure');
  const read = vi.spyOn(f.store.behavior, 'read').mockImplementation(() => {
    throw failure;
  });
  expect(() => admit(f)).toThrow(failure);
  read.mockRestore();
  const run = start(f);
  const reading = vi.spyOn(f.store.behavior, 'read').mockImplementation(() => {
    throw failure;
  });
  await expect(call(f, run)).rejects.toThrow(failure);
  reading.mockRestore();
  f.store.finishRun(run.id, 'cancelled', 'Synthetic corruption check');
  f.store.db
    .prepare('UPDATE package_behavior_states SET state=? WHERE chat_id=?')
    .run(JSON.stringify({ days: 99999, score: 0, die: 0 }), f.chat.id);
  expect(() => admit(f)).toThrow('BEHAVIOR_NUMBER_VALUE');
});

test('BETA-BEH11 only fresh input, expression and parsed-value failures carry the recoverable evaluation type', () => {
  const b = definition(),
    action = b.actions[1];
  const caught = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    throw new Error('Expected failure');
  };
  const invalidInput = caught(() =>
    evaluateBehaviorAction(b, action, b.initialState, { bonus: 999 }, { die: 1 })
  );
  expect(invalidInput).toBeInstanceOf(BehaviorEvaluationError);
  expect(isRecoverableBehaviorExecutionError(invalidInput)).toBe(true);
  const changed = structuredClone(action);
  changed.effects = [{ path: ['score'], value: 99999 }];
  expect(
    caught(() => evaluateBehaviorAction(b, changed, b.initialState, { bonus: 1 }, { die: 1 }))
  ).toBeInstanceOf(BehaviorEvaluationError);
  const parser = {
    id: 'score',
    format: 'json' as const,
    fields: [{ path: ['score'], from: ['score'] }],
  };
  expect(
    caught(() => parseBehaviorOutput(b, parser, b.initialState, '{"score":99999}'))
  ).toBeInstanceOf(BehaviorEvaluationError);
  const invalidBase = caught(() =>
    parseBehaviorOutput(b, parser, { ...(b.initialState as object), score: 99999 }, '{"score":1}')
  );
  expect(invalidBase).toBeInstanceOf(BehaviorError);
  expect(invalidBase).not.toBeInstanceOf(BehaviorEvaluationError);
  for (const error of [
    invalidBase,
    new BehaviorError(400, 'BEHAVIOR_SCOPE'),
    new BehaviorError(400, 'BEHAVIOR_SOURCE_HASH'),
    new PromptEvaluationError('PROMPT_INVALID_RUNTIME_VALUE'),
  ])
    expect(isRecoverableBehaviorExecutionError(error)).toBe(false);
});

test.each(['scope', 'runtime', 'database'] as const)(
  'BETA-BEH13 %s failure during tool execution and source completion propagates and rolls back',
  async (kind) => {
    const f = fixture(),
      run = start(f);
    const failure =
      kind === 'scope'
        ? new BehaviorError(400, 'BEHAVIOR_SCOPE')
        : kind === 'runtime'
          ? new PromptEvaluationError('PROMPT_INVALID_RUNTIME_VALUE')
          : new Error('Synthetic database failure');
    const read = vi.spyOn(f.store.behavior, 'read').mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(call(f, run)).rejects.toThrow(failure);
      expect(() => finish(f, run)).toThrow(failure);
      expect(f.store.run(run.id).status).toBe('running');
      expect(f.store.chat(f.chat.id).headRevision).toBeNull();
      expect(f.store.db.prepare('SELECT COUNT(*) n FROM sources').get()).toMatchObject({ n: 0 });
      expect(
        f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_outputs').get()
      ).toMatchObject({ n: 0 });
    } finally {
      read.mockRestore();
    }
  }
);

test('BETA-BEH14 rejected binding never consumes state or draws, while a missing journal remains fatal', async () => {
  const f = fixture(),
    run = start(f),
    binding = listBehaviorTools(run.snapshot)[0];
  const before = runBehaviorProgress(f.store, run.id);
  const event = await executeRunBehaviorTool(
    f.store,
    run.id,
    { ...binding, actionId: 'not-allowed' },
    { callId: 'denied', name: 'behavior_PRIVATE_NAME', args: { secret: 'PRIVATE_ARGUMENT' } }
  );
  expect(event).toMatchObject({
    name: 'unapproved',
    args: {},
    denied: true,
    errorKind: 'recoverable',
    result: { code: 'BEHAVIOR_TOOL_NOT_ALLOWED' },
  });
  expect(JSON.stringify(event)).not.toContain('PRIVATE_');
  expect(runBehaviorProgress(f.store, run.id)).toEqual(before);
  expect(current(f).stateRevision).toBe(0);
  f.store.db.prepare('DELETE FROM package_behavior_runs WHERE run_id=?').run(run.id);
  await expect(call(f, run)).rejects.toThrow('BEHAVIOR_RUN_JOURNAL_MISSING');
  expect(() => finish(f, run)).toThrow('BEHAVIOR_RUN_JOURNAL_MISSING');
  expect(f.store.chat(f.chat.id).headRevision).toBeNull();
});

test.each(['input', 'runtime'] as const)(
  'BETA-BEH15 corrupt recorded %s cannot become a recoverable output failure',
  async (kind) => {
    const f = fixture((b) => {
        b.actions[1].result = { op: 'add', args: [{ context: ['time', 'unix'] }, 1] };
      }),
      run = start(f);
    expect((await call(f, run)).denied).toBe(false);
    const progress = runBehaviorProgress(f.store, run.id)!;
    const entry = progress.entries.find((item) => item.trigger === 'model')!;
    if (kind === 'input') entry.input = { bonus: 999 };
    else entry.hostRuntime.time = null;
    f.store.db
      .prepare('UPDATE package_behavior_runs SET body=? WHERE run_id=?')
      .run(JSON.stringify(progress), run.id);
    expect(() => finish(f, run)).toThrow(
      kind === 'input' ? 'BEHAVIOR_NUMBER_VALUE' : 'BEHAVIOR_REPLAY_INVALID'
    );
    expect(f.store.run(run.id).status).toBe('running');
    expect(f.store.chat(f.chat.id).headRevision).toBeNull();
    expect(current(f).stateRevision).toBe(0);
    expect(
      f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()
    ).toMatchObject({ n: 0 });
  }
);

test('BETA-BEH06 a pre-prose user state survives schema change, unavailable writing, fork and new-ID backup restore', () => {
  const f = fixture((b) => {
    b.actions[0].triggers = ['user'];
    b.actions[0].effects[0].value = 12;
  });
  performBehaviorAction(f.store, f.chat.id, undefined, f.instanceId, {
    actionId: 'day',
    input: {},
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'before-any-prose',
  });
  expect(f.store.history(null)).toEqual([]);
  expect(current(f).state).toEqual({ days: 12, score: 0, die: 0 });
  const oldDefinition = structuredClone(f.content.package!.behavior);
  const changed: ContentPackage = {
    ...f.content.package!,
    behavior: {
      revision: 2,
      schemaVersion: 2,
      stateSchema: { type: 'record', properties: { label: { type: 'string', maxLength: 80 } } },
      initialState: { label: 'Only an explicit reset may use this' },
      actions: [],
      outputParsers: [],
    },
  };
  f.store.product.content(
    {
      kind: f.content.kind,
      title: f.content.title,
      description: f.content.description,
      text: changed.body,
      loading: f.content.loading,
      relatedIds: f.content.relatedIds,
      package: changed,
      expectedRevision: f.content.revision,
    },
    f.content.id
  );
  const run = start(f);
  expect(run.snapshot.packageStates).toEqual([]);
  expect(run.snapshot.packageBehaviorUnavailable![0]).toMatchObject({
    packageRevision: 2,
    code: 'BEHAVIOR_MIGRATION_REQUIRED',
    retainedState: { packageRevision: 1, state: { days: 12, score: 0, die: 0 }, stateRevision: 1 },
  });
  const source = finish(f, run, 'Prose before the state has been migrated.');
  const fork = forkChat(f.store, f.chat.id, {
    fromRevision: source.id,
    idempotencyKey: randomUUID(),
  });
  expect(behaviorDetail(f.store, fork.id).instances[0]).toMatchObject({
    status: 'stale',
    state: { days: 12, score: 0, die: 0 },
  });
  const target = database();
  const copy = importChatBackup(target, {
    backup: exportChatBackup(f.store, f.chat.id),
    idempotencyKey: randomUUID(),
  });
  expect(copy.chat.id).not.toBe(f.chat.id);
  const copiedRun = target.run(target.source(copy.chat.headRevision!).runId);
  expect(copiedRun.snapshot.packageBehaviorUnavailable).toEqual(
    run.snapshot.packageBehaviorUnavailable
  );
  expect(target.product.get<Content>('content', f.content.id, 1).package!.behavior).toEqual(
    oldDefinition
  );
  expect(behaviorDetail(target, copy.chat.id).instances[0]).toMatchObject({
    status: 'stale',
    state: { days: 12, score: 0, die: 0 },
  });
  expect(() => exportChatBackup(target, copy.chat.id)).not.toThrow();
});

test('BETA-BEH04 invalid action input is recoverable without applying state or concealing cancellation', async () => {
  const f = fixture(),
    run = start(f);
  const before = runBehaviorProgress(f.store, run.id);
  expect(await call(f, run, 999)).toMatchObject({
    denied: true,
    errorKind: 'recoverable',
    result: { unavailable: true, continueWithoutAction: true },
  });
  expect(runBehaviorProgress(f.store, run.id)).toEqual(before);
  const binding = listBehaviorTools(run.snapshot)[0];
  await expect(
    executeRunBehaviorTool(
      f.store,
      run.id,
      binding,
      { callId: randomUUID(), name: binding.tool.name, args: { bonus: 1 } },
      AbortSignal.abort()
    )
  ).rejects.toThrow('BEHAVIOR_RUN_CANCELLED');
});
function dependentModule(f: Fixture, trigger: 'before-turn' | 'model') {
  const content = f.store.product.content({
    kind: 'module',
    title: 'Dependent package',
    description: 'Synthetic',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: {
      version: 1,
      id: 'dependent',
      revision: 1,
      title: 'Dependent package',
      description: '',
      lore: [],
      instructions: [],
      controls: [],
      transforms: [],
      behavior: {
        revision: 1,
        schemaVersion: 1,
        stateSchema: { type: 'record', properties: { copied: number } },
        initialState: { copied: 0 },
        actions: [
          {
            id: 'copy',
            inputSchema: { type: 'record', properties: {} },
            triggers: [trigger],
            effects: [{ path: ['copied'], value: { context: ['packages', '0', 'state', 'days'] } }],
            result: { context: ['nextState', 'copied'] },
          },
        ],
        outputParsers: [],
      },
    },
  }) as Content;
  const profile = f.store.product.profile(f.chat.id);
  updateTestProfile(f.store.product, f.chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,

    routes: profile.routes,
    image: profile.image,
    packageAttachments: [
      ...(profile.packageAttachments ?? []),
      { id: content.id, revision: 1, role: 'module' },
    ],
    packageValues: profile.packageValues,
  });
  return content;
}
function namedCall(f: Fixture, run: Run, actionId: string) {
  const binding = listBehaviorTools(run.snapshot).find((b) => b.actionId === actionId)!;
  return executeRunBehaviorTool(f.store, run.id, binding, {
    callId: randomUUID(),
    name: binding.tool.name,
    args: {},
  });
}

test('BRUN01 previews have no draws or writes; automatic actions are staged and frozen before the prompt', () => {
  const f = fixture(),
    before = frozenTables(f);
  for (let i = 0; i < 3; i++) {
    freezePackageStates(f.store, snapshot(f), false);
    behaviorDetail(f.store, f.chat.id);
  }
  expect(frozenTables(f)).toEqual(before);
  const run = admit(f),
    snapshotBefore = structuredClone(run.snapshot);
  expect(current(f).state).toEqual({ days: 0, score: 0, die: 0 });
  expect(run.snapshot.packageStates![0]).toMatchObject({ stateRevision: 1, state: { days: 1 } });
  expect(run.snapshot.behaviorExecution).toMatchObject({
    version: 1,
    baseStates: [{ stateRevision: 0 }],
    automaticResults: [{ actionId: 'day', result: 1 }],
  });
  expect(JSON.stringify(buildMainInput(run.snapshot))).toContain('DAY=1');
  expect(f.store.product.attempts(f.chat.id)).toEqual([]);
  start(f, run);
  finish(f, run);
  expect(current(f)).toMatchObject({
    stateRevision: 1,
    state: { days: 1, score: 0, die: 0 },
    status: 'ready',
  });
  expect(f.store.run(run.id).snapshot).toEqual(snapshotBefore);
  expect(
    f.store.db
      .prepare('SELECT result FROM package_behavior_journal')
      .all()
      .map((r: any) => JSON.parse(r.result).provenance)
  ).toEqual(['before-turn']);
});

test('BRUN02 one domain tool resolves effects and returns a compact result; repeated call IDs cannot reroll', async () => {
  const f = fixture(),
    run = start(f),
    first = await call(f, run);
  expect(first.denied).toBe(false);
  expect(first.result).toMatchObject({ score: expect.any(Number), die: expect.any(Number) });
  const second = await call(f, run);
  expect(second.result).toEqual(first.result);
  expect(runBehaviorProgress(f.store, run.id)!.entries.map((e) => e.actionId)).toEqual([
    'day',
    'check',
  ]);
  expect(current(f).state).toEqual({ days: 0, score: 0, die: 0 });
  const changed = await call(f, run, 2);
  expect(changed).toMatchObject({
    denied: true,
    result: { code: 'BEHAVIOR_OPPORTUNITY_INPUT_CHANGED' },
  });
  const source = finish(f, run),
    result = first.result as { die: number; score: number };
  expect(current(f)).toMatchObject({
    stateRevision: 2,
    state: { days: 1, ...result },
    status: 'ready',
  });
  expect(f.store.source(source.id).text).toBe('Original synthetic fiction.');
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 2 }
  );
});

test('BRUN03 cancellation leaves no applied state and a new request at the same source reuses the recorded opportunity', async () => {
  const f = fixture(),
    first = start(f),
    result = await call(f, first);
  f.store.finishRun(first.id, 'cancelled', 'Synthetic cancellation');
  await expect(call(f, first)).rejects.toThrow('BEHAVIOR_RUN_NOT_RUNNING');
  expect(current(f).state).toEqual({ days: 0, score: 0, die: 0 });
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 0 }
  );
  const retry = start(f);
  expect(retry.snapshot.behaviorExecution!.opportunityId).toBe(
    first.snapshot.behaviorExecution!.opportunityId
  );
  expect((await call(f, retry)).result).toEqual(result.result);
  finish(f, retry);
  expect(current(f).stateRevision).toBe(2);
});

test('BRUN04 candidate uses the original dice and pre-automatic state without applying the automatic action twice', async () => {
  const f = fixture(),
    original = start(f),
    result = await call(f, original);
  finish(f, original);
  const candidate = f.store.candidate(original.id, randomUUID(), 'Alternative').run;
  expect(current(f, candidate.snapshot.branchId).stateRevision).toBe(0);
  expect(candidate.snapshot.packageStates![0].stateRevision).toBe(1);
  start(f, candidate);
  expect((await call(f, candidate)).result).toEqual(result.result);
  finish(f, candidate, 'Alternate fiction.');
  expect(current(f, candidate.snapshot.branchId)).toMatchObject({
    stateRevision: 2,
    state: { days: 1, ...(result.result as object) },
  });
  expect(current(f).stateRevision).toBe(2);
});

test('BRUN05 UI cannot invoke a model/automatic-only action even through the API', () => {
  const f = fixture();
  for (const [actionId, input] of [
    ['day', {}],
    ['check', { bonus: 1 }],
  ] as const)
    expect(() =>
      performBehaviorAction(f.store, f.chat.id, undefined, f.instanceId, {
        actionId,
        input,
        expectedStateRevision: 0,
        expectedSourceHash: null,
        idempotencyKey: randomUUID(),
      })
    ).toThrow('BEHAVIOR_USER_ACTION_NOT_ALLOWED');
  expect(current(f).stateRevision).toBe(0);
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 0 }
  );
});

test('BRUN06 failed output parsing rolls all staged effects back while preserving the completed original source', async () => {
  const f = fixture((b) => {
      b.outputParsers = [
        {
          id: 'score',
          format: 'json',
          start: '<state>',
          end: '</state>',
          fields: [{ path: ['score'], from: ['score'] }],
        },
      ];
    }),
    run = start(f);
  await call(f, run);
  const source = finish(f, run, 'Fiction with a broken state payload.');
  expect(f.store.run(run.id).status).toBe('completed');
  expect(f.store.source(source.id).text).toBe('Fiction with a broken state payload.');
  expect(current(f)).toMatchObject({
    stateRevision: 0,
    state: { days: 0, die: 0, score: 0 },
    status: 'stale',
  });
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 0 }
  );
  const next = admit(f);
  expect(next.snapshot.packageStates).toEqual([]);
  expect(next.snapshot.packageBehaviorUnavailable).toHaveLength(1);
});

test('BRUN07 source edits reject subsequent actions and fence stale completion without changing original prose', async () => {
  const f = fixture(),
    prior = start(f),
    source = finish(f, prior);
  const run = start(f);
  f.store.editSource(source.id, { text: 'Author changed the source.', expectedRevision: 0 });
  await expect(call(f, run)).rejects.toThrow('BEHAVIOR_SOURCE_DEPENDENCY_CHANGED');
  const completed = finish(f, run, 'Original completion at the old basis.');
  expect(f.store.source(completed.id).text).toBe('Original completion at the old basis.');
  expect(current(f)).toMatchObject({ stateRevision: 1, state: { days: 1 }, status: 'stale' });
});

test('BRUN08 automatic when=false does not draw; dual-trigger action can be requested once later', async () => {
  const f = fixture((b) => {
      b.actions[0].when = false;
      b.actions[1].triggers = ['before-turn', 'model'];
      b.actions[1].automaticInput = { bonus: 1 };
    }),
    run = start(f);
  const before = runBehaviorProgress(f.store, run.id)!;
  expect(before.entries.map((e) => e.actionId)).toEqual(['check']);
  const result = await call(f, run);
  expect(result.result).toEqual(before.entries[0].result);
  expect(runBehaviorProgress(f.store, run.id)!.entries).toHaveLength(1);
  finish(f, run);
  expect(current(f)).toMatchObject({ stateRevision: 1, state: { days: 0 } });
});

test('BRUN09 state CAS rejects tool execution and rolls completion effects back', async () => {
  const f = fixture((b) => {
      b.actions.push({
        id: 'user',
        inputSchema: { type: 'record', properties: {} },
        triggers: ['user'],
        effects: [{ path: ['score'], value: 99 }],
      });
    }),
    run = start(f);
  const scope = {
    chatId: f.chat.id,
    branchId: f.branchId,
    attachmentInstanceId: f.instanceId,
    packageId: f.content.id,
    packageRevision: 1,
    behaviorRevision: 1,
    schemaVersion: 1,
  };
  f.store.behavior.execute(scope, f.behavior, {
    actionId: 'user',
    input: {},
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'synthetic-race',
  });
  expect(await call(f, run)).toMatchObject({
    denied: true,
    result: { code: 'BEHAVIOR_STATE_STALE' },
  });
  finish(f, run);
  expect(current(f)).toMatchObject({
    stateRevision: 1,
    state: { days: 0, score: 99 },
    status: 'stale',
  });
});

test('BRUN10 cancelling a request before its first tool does not expose or commit hidden state', async () => {
  const f = fixture(),
    run = start(f),
    controller = new AbortController();
  controller.abort();
  const binding = listBehaviorTools(run.snapshot)[0];
  await expect(
    executeRunBehaviorTool(
      f.store,
      run.id,
      binding,
      { callId: 'late', name: binding.tool.name, args: { bonus: 1 } },
      controller.signal
    )
  ).rejects.toThrow('BEHAVIOR_RUN_CANCELLED');
  expect(runBehaviorProgress(f.store, run.id)!.entries.map((e) => e.actionId)).toEqual(['day']);
  expect(current(f).stateRevision).toBe(0);
});

test('BRUN11 current-format archive and chat fork retain staged outcomes and independent successor state', async () => {
  const f = fixture(),
    run = start(f),
    result = await call(f, run),
    source = finish(f, run);
  const fork = forkChat(f.store, f.chat.id, {
      fromRevision: source.id,
      idempotencyKey: randomUUID(),
    }),
    forkedRun = f.store.run(f.store.source(fork.headRevision!).runId);
  expect(runBehaviorProgress(f.store, forkedRun.id)!.entries.map((e) => e.result)).toEqual(
    runBehaviorProgress(f.store, run.id)!.entries.map((e) => e.result)
  );
  expect(forkedRun.snapshot.behaviorExecution!.opportunityId).not.toBe(
    run.snapshot.behaviorExecution!.opportunityId
  );
  expect(behaviorDetail(f.store, fork.id).instances[0]).toMatchObject({
    stateRevision: 2,
    state: { days: 1, ...(result.result as object) },
  });
  const archive = f.store.product.export(),
    restored = database();
  expect(archive.version).toBe(15);
  expect(restored.product.import(archive)).toMatchObject({ restored: true, chats: 2 });
  expect(restored.run(run.id).snapshot).toEqual(f.store.run(run.id).snapshot);
  expect(runBehaviorProgress(restored, run.id)).toEqual(runBehaviorProgress(f.store, run.id));
});

test('BRUN12 authoritative parser failure rolls dependent actions back across all packages', () => {
  const f = fixture((b) => {
    b.outputParsers = [
      {
        id: 'days',
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['days'], from: ['days'] }],
      },
    ];
  });
  dependentModule(f, 'before-turn');
  const run = start(f);
  expect(run.snapshot.packageStates!.map((s) => s.state)).toEqual([
    { days: 1, score: 0, die: 0 },
    { copied: 1 },
  ]);
  const source = finish(f, run, 'Fiction without its required state.');
  const detail = behaviorDetail(f.store, f.chat.id);
  expect(detail.instances.map((i) => i.state)).toEqual([
    { days: 0, score: 0, die: 0 },
    { copied: 0 },
  ]);
  expect(detail.instances.every((i) => i.status === 'stale')).toBe(true);
  expect(f.store.db.prepare('SELECT COUNT(*) n FROM package_behavior_journal').get()).toMatchObject(
    { n: 0 }
  );
  expect(f.store.source(source.id).text).toBe('Fiction without its required state.');
});

test('BRUN13 annotation parse failure preserves the shared action facts and does not fence the authoritative successor', () => {
  const f = fixture((b) => {
    b.mode = 'annotation';
    b.outputParsers = [
      {
        id: 'days',
        format: 'json',
        start: '<state>',
        end: '</state>',
        fields: [{ path: ['days'], from: ['days'] }],
      },
    ];
  });
  dependentModule(f, 'before-turn');
  const run = start(f);
  finish(f, run, 'Fiction with no optional overlay.');
  const detail = behaviorDetail(f.store, f.chat.id);
  expect(detail.instances.map((i) => i.state)).toEqual([
    { days: 1, score: 0, die: 0 },
    { copied: 1 },
  ]);
  expect(detail.instances.map((i) => i.status)).toEqual(['stale', 'ready']);
  const next = admit(f);
  expect(next.snapshot.packageStates).toEqual([]);
  expect(next.snapshot.packageBehaviorUnavailable).toHaveLength(2);
  expect(detail.instances.map((i) => i.state)).toEqual([
    { days: 1, score: 0, die: 0 },
    { copied: 1 },
  ]);
});

test('BRUN14 a cached result cannot be reused before its cross-package dependencies have been applied', async () => {
  const f = fixture((b) => {
    b.actions[0].triggers = ['model'];
  });
  dependentModule(f, 'model');
  const original = start(f);
  expect((await namedCall(f, original, 'day')).denied).toBe(false);
  expect(await namedCall(f, original, 'copy')).toMatchObject({ denied: false, result: 1 });
  finish(f, original);
  const candidate = f.store.candidate(original.id, randomUUID(), 'Changed order').run;
  start(f, candidate);
  expect(await namedCall(f, candidate, 'copy')).toMatchObject({
    denied: true,
    result: { code: 'BEHAVIOR_OPPORTUNITY_DEPENDENCY_CHANGED' },
  });
  expect(runBehaviorProgress(f.store, candidate.id)!.entries).toHaveLength(0);
  expect(await namedCall(f, candidate, 'day')).toMatchObject({ denied: false, result: 1 });
  expect(await namedCall(f, candidate, 'copy')).toMatchObject({ denied: false, result: 1 });
  finish(f, candidate);
  expect(
    behaviorDetail(f.store, f.chat.id, candidate.snapshot.branchId).instances.map((i) => i.state)
  ).toEqual([{ days: 1, score: 0, die: 0 }, { copied: 1 }]);
});

test('BRUN15 result-only user functions expose the persisted result without requiring a state effect', () => {
  const f = fixture((b) => {
    b.actions = [
      {
        id: 'pure',
        triggers: ['user'],
        inputSchema: { type: 'record', properties: {} },
        draws: [{ id: 'die', type: 'integer', min: 1, max: 6 }],
        effects: [],
        result: { context: ['draws', 'die'] },
      },
    ];
  });
  const command = {
    actionId: 'pure',
    input: {},
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'pure-result',
  };
  const first = performBehaviorAction(f.store, f.chat.id, undefined, f.instanceId, command);
  expect(first.instances[0].lastAction).toMatchObject({
    actionId: 'pure',
    result: expect.any(Number),
    trigger: 'user',
    stateRevision: 1,
  });
  expect(first.instances[0].state).toEqual({ days: 0, score: 0, die: 0 });
  expect(
    performBehaviorAction(f.store, f.chat.id, undefined, f.instanceId, command).instances[0]
      .lastAction
  ).toEqual(first.instances[0].lastAction);
});

test('BRUN16 the published hybrid fixture executes all three invocation paths with one local engine', async () => {
  const definition = validatePackageBehavior(
    JSON.parse(
      readFileSync(new URL('../fixtures/hybrid-actions-behavior.json', import.meta.url), 'utf8')
    )
  );
  const f = fixture((b) => Object.assign(b, definition));
  const detail = performBehaviorAction(f.store, f.chat.id, undefined, f.instanceId, {
    actionId: 'roll_die',
    input: {},
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'example-roll',
  });
  expect(detail.instances[0].lastAction!.result).toMatchObject({
    주사위: 'd6',
    결과: expect.any(Number),
  });
  const run = start(f);
  expect(run.snapshot.behaviorExecution!.automaticResults).toMatchObject([
    {
      actionId: 'prepare_scene',
      result: { 날씨: expect.any(String), '우연한 만남': expect.any(Boolean) },
    },
  ]);
  const binding = listBehaviorTools(run.snapshot)[0];
  const result = await executeRunBehaviorTool(f.store, run.id, binding, {
    callId: 'example-persuasion',
    name: binding.tool.name,
    args: { target: 'gatekeeper' },
  });
  expect(result).toMatchObject({
    denied: false,
    result: { target: 'gatekeeper', roll: expect.any(Number), outcome: expect.any(String) },
  });
  finish(f, run);
  expect(current(f).state).toMatchObject({
    turn: 1,
    lastCheck: (result.result as { outcome: string }).outcome,
  });
});
