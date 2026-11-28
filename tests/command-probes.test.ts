import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { splitHeadBody } from '#contracts/operations';
import { executeOperation } from '../server/command.js';
import { applyRisuCommand } from '../server/commands/risu-import.js';
import { updateStoryGuideCommand } from '../server/commands/story-guide.js';
import { Store } from '../server/store.js';
import {
  buildPorts,
  type CommandException,
  type CommandInput,
  type CommandModule,
  type CommandSamplesFile,
  defaultStaleAnswer,
  missingSamples,
  registeredCommands,
  registryProblems,
  discoveredModules,
  discoveredSampleFiles,
} from './fixtures/command-registry.js';
import { createTestDirectory } from './fixtures/test-directory.js';
import { analyzeSchema, valuesAtPath } from './stale-tab/schema.js';

const owned: { store: Store; remove: () => void }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    item.remove();
  }
});

function createStoreFixture() {
  const directory = createTestDirectory('uimori-command-probes-');
  const store = new Store(join(directory.directory, 'app.sqlite'));
  owned.push({ store, remove: directory.remove });
  return store;
}

const writes = (store: Store) => store.db.prepare('SELECT total_changes() AS count').get();

test('every command module under server/commands has samples in tests/fixtures/command-samples', () => {
  expect(registryProblems(discoveredModules, discoveredSampleFiles)).toEqual([]);
  expect(registeredCommands().length).toBeGreaterThan(0);
});

test('a sample file cannot cut the probe off from the events port', () => {
  const publish = vi.fn();
  const store = createStoreFixture();
  const ports = buildPorts(
    { ports: () => ({ events: { publish: () => undefined }, extra: 1 }) },
    store,
    publish
  ) as unknown as { events: { publish: (chatId: string) => void }; extra: number };
  ports.events.publish('chat-1');
  expect(publish).toHaveBeenCalledWith('chat-1');
  expect(ports.extra).toBe(1);
});

test('a command that is not picked up, has no samples, or carries an unjustified exception is reported with what to add', () => {
  const guide: CommandModule = {
    path: 'server/commands/guide.ts',
    exports: { updateStoryGuideCommand },
  };
  const risu: CommandModule = { path: 'server/commands/risu.ts', exports: { applyRisuCommand } };
  const samples = (
    file: Partial<CommandSamplesFile>,
    path = 'tests/fixtures/command-samples/x.ts'
  ) => ({
    path,
    file: { samples: {}, ...file },
  });
  const guideSamples = { 'chat-settings.updateStoryGuide': () => ({ inputs: [{}] }) };
  const risuSamples = { 'risu.import.apply': () => ({ inputs: [{}] }) };

  expect(registryProblems([{ path: 'server/commands/helpers.ts', exports: {} }], [])).toEqual([
    expect.stringContaining('server/commands/helpers.ts exports no command'),
  ]);
  expect(registryProblems([guide], [])).toEqual([missingSamples('chat-settings.updateStoryGuide')]);
  expect(
    registryProblems(
      [guide],
      [samples({ samples: { ...guideSamples, 'typo.name': () => ({ inputs: [] }) } })]
    )
  ).toEqual([expect.stringContaining('typo.name, which no module under server/commands/ exports')]);
  expect(
    registryProblems(
      [guide],
      [
        samples({ samples: guideSamples }),
        samples({ samples: guideSamples }, 'tests/fixtures/command-samples/y.ts'),
      ]
    )
  ).toEqual([
    expect.stringContaining('already has samples in tests/fixtures/command-samples/x.ts'),
  ]);

  const exceptions = (
    value: CommandException,
    module = guide,
    own: CommandSamplesFile['samples'] = guideSamples,
    name: string = 'chat-settings.updateStoryGuide'
  ) => registryProblems([module], [samples({ samples: own, exceptions: { [name]: value } })]);
  expect(exceptions({})).toEqual([expect.stringContaining('no staleAnswers or noChatEvent')]);
  expect(
    exceptions({
      staleAnswers: {
        chatId: {
          statusCode: 409,
          code: 'REVISION_CONFLICT',
          reason: 'The default answer, repeated for no reason.',
        },
        missing: {
          statusCode: 410,
          code: 'LIBRARY_ITEM_DELETED',
          reason: 'A path the command does not have.',
        },
        expectedRevision: { statusCode: 410, code: 'LIBRARY_ITEM_DELETED', reason: 'short' },
      },
    })
  ).toEqual([
    expect.stringContaining('staleAnswers.chatId repeats the default'),
    expect.stringContaining('staleAnswers.missing names no head path'),
    expect.stringContaining('staleAnswers.expectedRevision needs a reason'),
  ]);
  expect(exceptions({ staleAnswers: {}, noChatEvent: undefined })).toEqual([
    expect.stringContaining('no staleAnswers or noChatEvent'),
  ]);
  expect(
    exceptions({
      staleAnswers: {
        chatId: {
          statusCode: 400,
          code: 'INVALID_REQUEST',
          reason: 'The broken body already does this.',
        },
        expectedRevision: {
          statusCode: 410,
          code: 'MADE_UP',
          reason: 'A code the app does not define.',
        },
      },
    })
  ).toEqual([
    expect.stringContaining('staleAnswers.chatId answers 400 INVALID_REQUEST'),
    expect.stringContaining('staleAnswers.expectedRevision names MADE_UP'),
  ]);
  expect(exceptions({ noChatEvent: 'short' })).toEqual([
    expect.stringContaining('noChatEvent needs a reason'),
  ]);
  expect(
    exceptions(
      { noChatEvent: 'This command has no head path to publish for.' },
      risu,
      risuSamples,
      'risu.import.apply'
    )
  ).toEqual([expect.stringContaining('noChatEvent is unneeded')]);
});

for (const registered of registeredCommands()) {
  const { name, command, exception } = registered;
  const { revisions, targets } = analyzeSchema(command.op.head);
  const paths = [...new Set([...revisions, ...targets])];
  const branches = analyzeSchema(command.op.body).branches;
  const publishesNoEvent = exception.noChatEvent !== undefined;
  const staleAnswerOf = (path: string) => exception.staleAnswers?.[path] ?? defaultStaleAnswer;
  const makePorts = (store: Store, publish: (chatId: string) => void) =>
    buildPorts(registered, store, publish);
  const arrange = (store: Store) => {
    if (!registered.samples) throw new Error(missingSamples(name));
    const samples = registered.samples(store);
    if (!samples.inputs.length) throw new Error(`${name}: add a valid sample input`);
    return samples;
  };
  const breakBody = (sample: CommandInput) => {
    const { headRaw, bodyRaw } = splitHeadBody(command.op.head, sample);
    const broken = Object.fromEntries(Object.keys(bodyRaw).map((key) => [key, null]));
    return {
      ...headRaw,
      ...broken,
      ...(command.op.body.safeParse(broken).success ? { __invalidBodyField: true } : {}),
    };
  };
  const numericRevisions = revisions.filter((revision) => !revision.includes('.'));
  const scope = !paths.length
    ? 'no target or revision probes'
    : publishesNoEvent
      ? 'no chat event on success'
      : 'one event on success';

  const applyBranches = branches.length ? branches : [undefined];
  for (const branch of applyBranches) {
    if (!branch && !paths.length && command.receipt) continue;
    test(`${name} applies ${branch?.label ?? 'body'} (${scope})`, async () => {
      const store = createStoreFixture();
      const { inputs } = arrange(store);
      const sample = inputs.find(
        (input) => !branch || branch.matches(splitHeadBody(command.op.head, input).bodyRaw)
      );
      if (!sample) throw new Error(`${name}: add a valid sample for body branch ${branch?.label}`);
      const publish = vi.fn();
      const apply = vi.spyOn(command, 'apply');
      await executeOperation(command, makePorts(store, publish), sample);
      expect(apply).toHaveBeenCalledOnce();
      if (paths.length)
        expect(
          publish,
          publishesNoEvent ? 'noChatEvent is declared' : undefined
        ).toHaveBeenCalledTimes(publishesNoEvent ? 0 : 1);
    });
  }

  for (const path of paths) {
    test(`${name} rejects stale ${path} before parsing the body without writing`, async () => {
      const store = createStoreFixture();
      const { inputs, stale } = arrange(store);
      const makeStale = stale?.[path];
      if (!makeStale) throw new Error(`${name}: add a stale-maker for head path ${path}`);
      const sample = inputs.find((input) =>
        valuesAtPath(input, path).some((value) => value !== undefined)
      );
      if (!sample) throw new Error(`${name}: add a valid sample containing head path ${path}`);
      const publish = vi.fn();
      const ports = makePorts(store, publish);
      const broken = breakBody(sample);
      await expect(executeOperation(command, ports, broken)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_REQUEST',
      });
      await makeStale(sample);
      const before = writes(store);
      const { statusCode, code } = staleAnswerOf(path);
      await expect(executeOperation(command, ports, broken)).rejects.toMatchObject({
        statusCode,
        code,
      });
      expect(writes(store)).toEqual(before);
      expect(publish).not.toHaveBeenCalled();
    });

    if (exception.staleAnswers?.[path] && !revisions.includes(path) && numericRevisions.length)
      test(`${name} answers a revision one ahead with 409 before a stale ${path}`, async () => {
        const store = createStoreFixture();
        const { inputs, stale } = arrange(store);
        const sample = inputs.find(
          (input) =>
            valuesAtPath(input, path).some((value) => value !== undefined) &&
            numericRevisions.some((revision) => typeof input[revision] === 'number')
        );
        if (!sample)
          throw new Error(
            `${name}: add a valid sample containing head path ${path} and a numeric ${numericRevisions.join(' or ')}`
          );
        const publish = vi.fn();
        const ports = makePorts(store, publish);
        const makeStale = stale?.[path];
        if (!makeStale) throw new Error(`${name}: add a stale-maker for head path ${path}`);
        await makeStale(sample);
        const ahead = Object.fromEntries(
          numericRevisions
            .filter((revision) => typeof sample[revision] === 'number')
            .map((revision) => [revision, Number(sample[revision]) + 1])
        );
        const before = writes(store);
        await expect(
          executeOperation(command, ports, { ...breakBody(sample), ...ahead })
        ).rejects.toMatchObject(defaultStaleAnswer);
        expect(writes(store)).toEqual(before);
        expect(publish).not.toHaveBeenCalled();
      });
  }

  if (command.receipt) {
    test(`${name} replays its receipt and rejects a changed body (${revisions.length ? 'after guard state changes' : scope})`, async () => {
      const store = createStoreFixture();
      const { inputs, stale } = arrange(store);
      const sample = inputs[0]!;
      const publish = vi.fn();
      const ports = makePorts(store, publish);
      const onReplay = vi.spyOn(command.receipt!, 'onReplay');
      await executeOperation(command, ports, sample);
      expect(onReplay).not.toHaveBeenCalled();
      const path = revisions.find((key) =>
        valuesAtPath(sample, key).some((value) => value !== undefined)
      );
      if (path) {
        const makeStale = stale?.[path];
        if (!makeStale) throw new Error(`${name}: add a stale-maker for head path ${path}`);
        await makeStale(sample);
      }
      const guard = vi.spyOn(command, 'guard');
      publish.mockClear();
      const before = writes(store);
      await executeOperation(command, ports, sample);
      expect(onReplay).toHaveBeenCalledOnce();
      await expect(executeOperation(command, ports, breakBody(sample))).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(guard).not.toHaveBeenCalled();
      expect(writes(store)).toEqual(before);
      expect(publish).not.toHaveBeenCalled();
    });
  }
}
