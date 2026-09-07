import type { Connection, ModelPreset } from '../core/product.js';
import { defaultSolOptions, validateSolOptions } from '../core/sol-config.js';
import { executeSolTool, solToolDefinitions } from '../core/sol-tools.js';
import type { ProviderToolCall } from '../core/transport.js';

/** One server execution owns the deadline and local tool surface; no cross-run replay. */
export function createSolSession(target: (ModelPreset & { connection: Connection }) | undefined, timeoutMs?: number) {
  if (target?.connection.protocol !== 'sol-responses-v1') return undefined;
  const options = target.sol === undefined ? defaultSolOptions() : validateSolOptions(target.sol);
  const duration = timeoutMs ?? target.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 1_800_000) throw new Error('INVALID_TIMEOUT');
  const deadline = Date.now() + duration;
  const toolNames = solToolDefinitions(options).map(tool => tool.name);
  return {
    options, toolNames, maxCalls: options.maximumToolRounds + 1,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    execute: (call: ProviderToolCall) => executeSolTool(call, options),
  };
}
