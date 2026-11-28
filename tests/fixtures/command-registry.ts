import { isAppErrorCode } from '#contracts';
import type { Command } from '../../server/command.js';
import { type AppPorts, createStorePorts } from '../../server/store-ports.js';
import type { Store } from '../../server/store.js';
import { analyzeSchema } from '../stale-tab/schema.js';

export type AnyCommand = Command<any, any>;
export type CommandInput = Record<string, unknown>;

export type CommandSamples = {
  inputs: CommandInput[];
  stale?: Record<string, (input: CommandInput) => unknown>;
};

export type StaleAnswer = { statusCode: number; code: string; reason: string };

export type CommandException = {
  staleAnswers?: Record<string, StaleAnswer>;
  noChatEvent?: string;
};

export type CommandSamplesFile = {
  samples: Record<string, (store: Store) => CommandSamples>;
  exceptions?: Record<string, CommandException>;
  ports?: (store: Store, base: AppPorts) => Record<string, unknown>;
};

export const defaultStaleAnswer = { statusCode: 409, code: 'REVISION_CONFLICT' };

export function defineCommandSamples(file: CommandSamplesFile): CommandSamplesFile {
  return file;
}

export type CommandModule = { path: string; exports: Record<string, unknown> };
export type SampleFile = { path: string; file: CommandSamplesFile };

const commandModules = import.meta.glob<Record<string, unknown>>('../../server/commands/**/*.ts', {
  eager: true,
});
const sampleFiles = import.meta.glob<CommandSamplesFile>('./command-samples/*.ts', {
  eager: true,
  import: 'default',
});

const repoPath = (path: string) =>
  path.replace(/^(\.\.\/)+/u, '').replace(/^\.\//u, 'tests/fixtures/');

export const discoveredModules: CommandModule[] = Object.entries(commandModules).map(
  ([path, exports]) => ({ path: repoPath(path), exports })
);
export const discoveredSampleFiles: SampleFile[] = Object.entries(sampleFiles).map(
  ([path, file]) => ({ path: repoPath(path), file })
);

export function isCommand(value: unknown): value is AnyCommand {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { op?: { name?: unknown }; guard?: unknown; apply?: unknown };
  return (
    typeof candidate.op?.name === 'string' &&
    typeof candidate.guard === 'function' &&
    typeof candidate.apply === 'function'
  );
}

export function commandsOf(module: CommandModule): AnyCommand[] {
  return [...new Set(Object.values(module.exports).filter(isCommand))];
}

const reasonLength = 20;

export function registryProblems(
  modules: readonly CommandModule[],
  files: readonly SampleFile[]
): string[] {
  const problems: string[] = [];
  const commands = new Map<string, AnyCommand>();
  for (const module of modules) {
    const found = commandsOf(module);
    if (!found.length)
      problems.push(
        `${module.path} exports no command: export each command by name from the module that defines it, and keep helpers that are not commands outside server/commands/`
      );
    for (const command of found) {
      const other = commands.get(command.op.name);
      if (other && other !== command)
        problems.push(`${module.path}: two commands are named ${command.op.name}`);
      commands.set(command.op.name, command);
    }
  }

  const owners = new Map<string, string>();
  for (const { path, file } of files) {
    for (const name of Object.keys(file.samples)) {
      if (!commands.has(name))
        problems.push(
          `${path}: samples for ${name}, which no module under server/commands/ exports as a command`
        );
      const first = owners.get(name);
      if (first) problems.push(`${path}: ${name} already has samples in ${first}`);
      else owners.set(name, path);
    }
    for (const [name, exception] of Object.entries(file.exceptions ?? {})) {
      const command = commands.get(name);
      if (!command) {
        problems.push(`${path}: exception for ${name}, which is not a registered command`);
        continue;
      }
      if (!(name in file.samples))
        problems.push(`${path}: exception for ${name}, whose samples live in another file`);
      const { revisions, targets } = analyzeSchema(command.op.head);
      const paths = new Set([...revisions, ...targets]);
      if (!Object.keys(exception.staleAnswers ?? {}).length && exception.noChatEvent === undefined)
        problems.push(`${path}: ${name} lists an exception with no staleAnswers or noChatEvent`);
      for (const [stalePath, answer] of Object.entries(exception.staleAnswers ?? {})) {
        const label = `${path}: ${name} staleAnswers.${stalePath}`;
        if (!paths.has(stalePath))
          problems.push(
            `${label} names no head path of the command (head paths: ${[...paths].join(', ') || 'none'})`
          );
        if (
          answer.statusCode === defaultStaleAnswer.statusCode &&
          answer.code === defaultStaleAnswer.code
        )
          problems.push(`${label} repeats the default 409 REVISION_CONFLICT; remove it`);
        if (!isAppErrorCode(answer.code))
          problems.push(`${label} names ${answer.code}, which is not an app error code`);
        if (answer.statusCode === 400 && answer.code === 'INVALID_REQUEST')
          problems.push(
            `${label} answers 400 INVALID_REQUEST, which the probe's broken body already produces; declare the answer the stale state itself gives`
          );
        if (answer.reason.trim().length < reasonLength)
          problems.push(`${label} needs a reason of ${reasonLength}+ characters`);
      }
      if (exception.noChatEvent !== undefined) {
        if (!paths.size)
          problems.push(`${path}: ${name} noChatEvent is unneeded: the command has no head path`);
        if (exception.noChatEvent.trim().length < reasonLength)
          problems.push(
            `${path}: ${name} noChatEvent needs a reason of ${reasonLength}+ characters`
          );
      }
    }
  }

  for (const name of commands.keys()) if (!owners.has(name)) problems.push(missingSamples(name));
  return problems;
}

export const missingSamples = (name: string) =>
  `${name}: no samples. Add \`'${name}': (store) => ({ inputs, stale })\` to a file in tests/fixtures/command-samples/ (inputs cover every body branch; stale holds one maker per head path)`;

export function buildPorts(
  registered: Pick<RegisteredCommand, 'ports'>,
  store: Store,
  publish: (chatId: string) => void
): never {
  const base = createStorePorts(store, { publish });
  return { ...base, ...registered.ports?.(store, base), events: base.events } as never;
}

export type RegisteredCommand = {
  name: string;
  command: AnyCommand;
  samples?: (store: Store) => CommandSamples;
  exception: CommandException;
  ports?: CommandSamplesFile['ports'];
};

export function registeredCommands(
  modules: readonly CommandModule[] = discoveredModules,
  files: readonly SampleFile[] = discoveredSampleFiles
): RegisteredCommand[] {
  const byName = new Map(
    modules.flatMap(commandsOf).map((command) => [command.op.name, command] as const)
  );
  return [...byName]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, command]) => {
      const file = files.find((item) => name in item.file.samples)?.file;
      return {
        name,
        command,
        samples: file?.samples[name],
        exception: file?.exceptions?.[name] ?? {},
        ports: file?.ports,
      };
    });
}

export const commandsByName = new Map(
  registeredCommands().map(({ name, command }) => [name, command] as const)
);
