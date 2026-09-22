import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProviderTool } from '../core/transport.js';
import type { HelperTask } from '../core/helper.js';
import type { Store } from './store.js';
import type { DataOperation } from './helper-data-worker.js';

const str = { type: 'string' };
const list = { type: 'array', maxItems: 8, items: str };
const reference = {
  type: 'object',
  properties: {
    scope: str,
    kind: str,
    id: str,
    revision: { type: ['number', 'string'] },
    field: str,
    hash: str,
    chatId: str,
    branchId: str,
  },
  required: ['scope', 'kind', 'id', 'revision', 'field', 'hash'],
  additionalProperties: false,
};
export const HELPER_DATA_TOOLS: ProviderTool[] = [
  {
    name: 'data.search',
    description:
      'Grep authored bot/persona/module/prompt text, chat originals, notes or unsaved editor fields. Returns exact matched excerpts and data.read references, never whole editor JSON. query filters title/ID; patterns search each text field (any/all, case-insensitive literal by default). Empty patterns list documents. current = frozen current chat, library/chats = live, editor = unsaved. Default: editor when supplied, otherwise current chat or library. Follow nextOffset; absence from a search is not proof of absence.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['current', 'library', 'chats', 'editor'] },
        query: str,
        patterns: list,
        match: { type: 'string', enum: ['any', 'all'] },
        regex: { type: 'boolean' },
        kinds: list,
        ids: { type: 'array', maxItems: 50, items: str },
        chatId: str,
        branchId: str,
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        context: { type: 'integer', minimum: 0, maximum: 1200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'data.read',
    description:
      'Read one ref or batch up to 4 refs from search. Copy references unchanged. Batches return independent results/errors; follow nextIndex for unread refs. Empty field gives a paged field directory; choose a returned ref for exact text. Text offset/limit are UTF-16 units; directory offset/limit count fields. Changed revision/hash requires searching again. Full edit models remain available through app.call resource.read or workspace.read(editor).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: reference,
        refs: { type: 'array', minItems: 1, maxItems: 4, items: reference },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 10000 },
      },
      oneOf: [{ required: ['ref'] }, { required: ['refs'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'db.query',
    description:
      'Read-only SQL SELECT/CTE over agent_resources, agent_chats, agent_messages, agent_usage, agent_helper_inputs. Omit sql to read schemas/examples. Use for joins, filters and counts, not full resource dumps. Live database across chats: filter chat_id/branch_id explicitly. Positional ? params, row/cell/output bounds and a 3-second execution deadline. No mutations, credentials or arbitrary filesystem access; save through app.call.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', maxLength: 12000 },
        params: { type: 'array', maxItems: 50, items: { type: ['string', 'number', 'null'] } },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
];

/** A short-lived OS process can terminate even while SQLite is executing native code.
 * No server transaction, file mirror, new dependency or persistent worker is needed. */
export function runDataProcess(
  input: DataOperation,
  signal?: AbortSignal,
  timeoutMs = 3000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('CANCELLED'));
    const compiled = new URL('./helper-data-worker.js', import.meta.url);
    const file = existsSync(compiled)
      ? compiled
      : new URL('./helper-data-worker.ts', import.meta.url);
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=128', '--disable-warning=ExperimentalWarning', fileURLToPath(file)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    let output = '',
      error: Error | undefined;
    const stop = (reason: string) => {
      error ??= new Error(reason);
      child.kill('SIGKILL');
    };
    const abort = () => stop('CANCELLED');
    const timer = setTimeout(
      () => stop('DATA_QUERY_TIMEOUT: narrow the search or SQL query'),
      timeoutMs
    );
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 100_000) stop('DATA_RESULT_TOO_LARGE');
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (cause) => {
      error ??= cause;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) return reject(error);
      if (code !== 0) return reject(new Error('DATA_PROCESS_FAILED'));
      try {
        const result = JSON.parse(output);
        result.ok ? resolve(result.result) : reject(new Error(String(result.error)));
      } catch {
        reject(new Error('DATA_RESULT_INVALID'));
      }
    });
    try {
      child.stdin.end(JSON.stringify(input));
    } catch {
      stop('DATA_INPUT_INVALID');
    }
    if (signal?.aborted) abort();
  });
}
export function invokeDataTool(
  store: Store,
  task: HelperTask,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
) {
  if (!HELPER_DATA_TOOLS.some((tool) => tool.name === name)) throw new Error('DATA_TOOL_UNKNOWN');
  return runDataProcess(
    { path: store.path, taskId: task.id, name: name as DataOperation['name'], args },
    signal
  );
}
