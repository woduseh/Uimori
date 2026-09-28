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
      'Find authored resources with output="documents" (one document per result, no body), then grep selected IDs with output="matches" (default). query filters title/ID only: if a name is absent there, retry without query using patterns for aliases in the body. For a saved bot edit, use scope="library", output="documents", patterns:["Hinano","히나노"] to find IDs, then ids:[id], patterns:["Age:"], optionally paths:["/card/description"] for exact excerpts. paths accepts JSON Pointer fields or subtree prefixes; omitted paths keep HTML/scripts searchable. Matches default to five and page under an 8k serialized-character budget; follow nextOffset. A library native string hit includes editTarget for resource.patch replaceText with a unique exact oldText; do not read the full field if the excerpt suffices. Numeric/boolean fields need a typed resource.read; current and editor refs are not saved-resource edit targets. current = frozen chat, library/chats = live, editor = captured input. Default scope is editor when supplied, otherwise current chat or library. No-match is not proof of absence.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['current', 'library', 'chats', 'editor'] },
        output: { type: 'string', enum: ['documents', 'matches'] },
        query: str,
        patterns: list,
        paths: { type: 'array', maxItems: 16, items: str },
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
      'Read one to 16 refs from search. Always pass refs, including a one-item array. Copy references unchanged. Each item returns its own result/error; follow nextIndex for unread refs. Empty field gives a paged field directory. Text offset/limit are UTF-16 units; directory offset/limit count fields. Changed revision/hash requires searching again. Exact library native string reads include editTarget for resource.patch replaceText; use a unique literal excerpt without reconstructing the whole resource. For typed or missing fields use app.call resource.read before resource.patch.',
    inputSchema: {
      type: 'object',
      properties: {
        refs: { type: 'array', minItems: 1, maxItems: 16, items: reference },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 10000 },
      },
      required: ['refs'],
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
