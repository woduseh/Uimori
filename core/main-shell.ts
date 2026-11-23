import type { ProviderTool } from './transport.js';

export const SHELL_TIMEOUT_MAX_MS = 86_400_000;
export const SHELL_OUTPUT_DEFAULT_BYTES = 16_384;
export const SHELL_OUTPUT_MAX_BYTES = 65_536;
export const SHELL_EXEC_PROPERTIES = {
  command: {
    type: 'string',
    minLength: 1,
    maxLength: 50_000,
    description: 'Bash command or script to run.',
  },
  timeoutMs: {
    type: 'integer',
    minimum: 1000,
    maximum: SHELL_TIMEOUT_MAX_MS,
    description:
      'Time limit in milliseconds. Default 10000; it never extends past the enclosing task deadline.',
  },
  maxOutputBytes: {
    type: 'integer',
    minimum: 256,
    maximum: SHELL_OUTPUT_MAX_BYTES,
    description:
      'Size of the UTF-8 head/tail output preview in bytes. Default 16384. The complete log is always kept in outputFile.',
  },
};

export function shellExecutionOptions(
  args: Record<string, unknown>,
  defaultOutputBytes = SHELL_OUTPUT_DEFAULT_BYTES
) {
  if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 50_000)
    throw new Error('SHELL_COMMAND_INVALID');
  const bounded = (name: string, fallback: number, min: number, max: number) => {
    const value = args[name] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      throw new Error(`SHELL_${name.toUpperCase()}_INVALID`);
    return value;
  };
  return {
    command: args.command,
    timeoutMs: bounded('timeoutMs', 10_000, 1000, SHELL_TIMEOUT_MAX_MS),
    maxOutputBytes: bounded('maxOutputBytes', defaultOutputBytes, 256, SHELL_OUTPUT_MAX_BYTES),
  };
}

export const MAIN_SHELL_TOOL: ProviderTool = {
  name: 'data.exec',
  description:
    'Run Bash with rg, jq, Python or Node in the Linux workspace of this writing run. Use it for multi-step reference searches and local processing that single reads cannot do in one call; knowledge.read stays the shorter route for known ids. Start with INDEX.md for file paths. current/ holds the frozen effective references, the complete source history and the existing summary, ready on the first call. To read other saved library or chat data, run uimori export with JSON: {"scope":"library"} or {"scope":"chats"} writes an index, "id":"..." adds one resource or chat, and "all":true exports everything. These live exports are separate from the frozen current/ files. File edits here are scratch work and never save to the app, and printed output is working evidence, not adopted lore or memory. Each call is synchronous and cannot leave background jobs running. The result shows a head/tail preview of the output and the path of the complete log in outputFile; filter that file for more passages.',
  inputSchema: {
    type: 'object',
    properties: SHELL_EXEC_PROPERTIES,
    required: ['command'],
    additionalProperties: false,
  },
};
