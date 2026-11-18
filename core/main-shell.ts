import type { ProviderTool } from './transport.js';

export const SHELL_TIMEOUT_MAX_MS = 300_000;
export const SHELL_OUTPUT_DEFAULT_BYTES = 16_384;
export const SHELL_OUTPUT_MAX_BYTES = 65_536;
export const SHELL_EXEC_PROPERTIES = {
  command: { type: 'string', minLength: 1, maxLength: 50_000 },
  timeoutMs: { type: 'integer', minimum: 1000, maximum: SHELL_TIMEOUT_MAX_MS },
  maxOutputBytes: { type: 'integer', minimum: 256, maximum: SHELL_OUTPUT_MAX_BYTES },
};

/** Shell lifetime remains subordinate to the enclosing model run's cancellation/deadline. */
export function shellExecutionOptions(args: Record<string, unknown>) {
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
    maxOutputBytes: bounded(
      'maxOutputBytes',
      SHELL_OUTPUT_DEFAULT_BYTES,
      256,
      SHELL_OUTPUT_MAX_BYTES
    ),
  };
}

export const MAIN_SHELL_TOOL: ProviderTool = {
  name: 'data.exec',
  description:
    'Run Bash, rg, jq, Python or Node in this writing run’s Linux workspace for multi-step searches and local processing. INDEX.md lists the paths: current/ holds the frozen effective references, complete source history and existing summary, ready on the first call. For other saved library or chat data, run uimori export with JSON: {"scope":"library"} or {"scope":"chats"} writes an index; add "id":"..." for one resource or chat, or "all":true for a full export. Those exports are live data, separate from the frozen current/ files. Workspace edits are scratch work and never save to the app, and output is working evidence, not adopted lore or canonical memory. Commands run synchronously (10 seconds by default, up to 300000ms, within the run deadline) and cannot leave background jobs running. maxOutputBytes sets the UTF-8 head/tail preview (default 16384, max 65536); the complete stdout/stderr log stays in outputFile for further filtering. No server credentials or database file are exported.',
  inputSchema: {
    type: 'object',
    properties: SHELL_EXEC_PROPERTIES,
    required: ['command'],
    additionalProperties: false,
  },
};
