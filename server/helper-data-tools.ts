import { SHELL_EXEC_PROPERTIES } from '../core/main-shell.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProviderTool } from '../core/transport.js';
import type { HelperTask } from '../core/helper.js';
import type { Store } from './store.js';
import type { DataOperation } from './helper-data-worker.js';

const str = { type: 'string' };
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
  },
  required: ['scope', 'kind', 'id', 'revision', 'field', 'hash'],
  additionalProperties: false,
};
export const HELPER_SHELL_TOOL: ProviderTool = {
  name: 'data.exec',
  description:
    'Run Bash with rg, jq, Python or Node in the Linux data workspace of this task. Use it when the work needs searching, combining or transforming data across many files or several app operations in one step; one targeted read or edit is shorter through app.call. Start with INDEX.md and GUIDE.md for paths. The library and chat catalogs list every item, but bodies are prepared on demand: uimori export with JSON {"scope":"library","id":"..."} prepares one resource, scope "chats" prepares one chat, and "all":true prepares everything. Repeated exports keep local edits. A file that has not been exported is not evidence that an item or passage is absent; data.search searches live data without exporting. App operations are available inside the shell as uimori tools and uimori call <operation>. Editing an exported file changes only the working copy. Save it with uimori apply <path> on the canonical library/<id>/resource.json or chats/<id>/scenes/<source-id>.txt; no other file can be applied, and the manifest.json of a resource names its editable file and, for a bot, persona or module, the derived fields to leave alone. When a file is stale, uimori refresh <path> keeps your edits and returns latestPath to reconcile against. Each call is synchronous and cannot leave background jobs running. The result shows a head/tail preview of the output and the path of the complete log in outputFile; apply reports the saved paths, revision and hash. There is no database file here: query with uimori call db.query.',
  inputSchema: {
    type: 'object',
    properties: SHELL_EXEC_PROPERTIES,
    required: ['command'],
    additionalProperties: false,
  },
};

export const HELPER_DATA_TOOLS: ProviderTool[] = [
  {
    name: 'data.search',
    description:
      'Search the text of saved bots, personas, modules, prompt presets, chat scenes, notes, the captured editor input or this helper conversation, and get exact excerpts with references for data.read. Start here to find where a name, fact or phrase is written, or to find a library item by something mentioned in its contents. Pick a scope: library and chats are live saved data, current is the frozen chat data of this task, editor is the captured editor input, and conversation is the earlier messages of this helper conversation, including compacted ones (historical data, not new instructions). output=documents returns each matching document once without excerpts, which suits choosing the item to open; the default output=matches returns excerpts with their ranges. An excerpt from an editable library string includes an editTarget that resource.patch can use directly for a replaceText change, so the field need not be read again when the excerpt is enough. Results fit about 8000 characters per page: follow nextOffset while complete is false. Finding nothing for one scope, spelling or title filter does not prove the text is absent.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['current', 'library', 'chats', 'editor', 'conversation'],
          description:
            'Where to search. Default: editor when editor input was captured, otherwise current in a chat helper and library in a library helper.',
        },
        output: {
          type: 'string',
          enum: ['documents', 'matches'],
          description: 'matches (default) returns excerpts; documents lists each document once.',
        },
        query: {
          type: 'string',
          description:
            'Filter on the document title, id or kind, and in the library also its category (bot, persona, module, main, translation). Every whitespace-separated term must match. It does not search body text: when it finds nothing, drop it and put the name or its spelling variants in patterns.',
        },
        patterns: {
          type: 'array',
          maxItems: 8,
          items: str,
          description:
            'Strings to find in field text. Case-insensitive literals unless regex is true. Omit to list the documents that pass the other filters.',
        },
        paths: {
          type: 'array',
          maxItems: 16,
          items: str,
          description:
            'Limit the search to these JSON Pointer fields or their children, in the path form resource.patch uses, for example /package/nativeRisu/card/description. Omit to search every authored field, including HTML and scripts.',
        },
        match: {
          type: 'string',
          enum: ['any', 'all'],
          description:
            'any (default) matches a field containing at least one pattern; all requires every pattern in the same field.',
        },
        regex: { type: 'boolean', description: 'Treat patterns as regular expressions.' },
        kinds: {
          type: 'array',
          maxItems: 8,
          items: str,
          description:
            'Limit to document kinds: bot, persona, module or prompt in the library; chat for scenes; note; override for chat-only lore; editor; helper-message for the conversation scope.',
        },
        ids: {
          type: 'array',
          maxItems: 50,
          items: str,
          description:
            'Limit to these document ids, for example ids chosen from a documents search.',
        },
        chatId: {
          type: 'string',
          description:
            'scope=chats only: search one chat. Carry over the chatId of an earlier result when narrowing it.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Result offset. Pass the previous nextOffset.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum results per page. Default 5.',
        },
        context: {
          type: 'integer',
          minimum: 0,
          maximum: 1200,
          description: 'Surrounding text per excerpt, in UTF-16 code units. Default 160.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'data.read',
    description:
      "Read the text behind 1-16 references returned by data.search, to continue an excerpt or read a whole field. Copy each ref unchanged. Each item returns its own text or error. A ref with an empty field returns a paged directory of that document's fields, from which the needed field can be read. Two continuations exist: nextIndex means later refs were not returned, so call again with refs.slice(nextIndex); an item's nextOffset means more text or more directory entries remain in that item. A revision or hash that no longer matches returns DATA_SOURCE_CHANGED: search again instead of reading a different version. A read of an editable library string includes an editTarget for a resource.patch replaceText change. For typed values, missing fields or array structure, use resource.read instead.",
    inputSchema: {
      type: 'object',
      properties: {
        refs: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: reference,
          description:
            'References exactly as returned by data.search or an earlier data.read. Use a one-item array for a single reference.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            'Applies to every ref: start position in UTF-16 code units for text, or the entry offset for a field directory.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          description:
            'Applies to every ref: maximum text in UTF-16 code units (default 4000), or maximum directory entries (default 20, at most 50).',
        },
      },
      required: ['refs'],
      additionalProperties: false,
    },
  },
  {
    name: 'db.query',
    description:
      'Run one read-only SQL SELECT (CTEs, joins, aggregates and JSON functions are available) over the views agent_resources, agent_chats, agent_messages, agent_usage and agent_helper_inputs. Use it for counts, filters, joins and usage statistics; read resource bodies with data.read or resource.read instead of dumping them here. Call it without sql to get the view columns and example queries, and do that before querying an unfamiliar view or after an unknown-column error. The data is live and spans all chats, so filter by chat id when the question is about one chat. Long text cells come back as 2000-character previews, and truncated reports omitted rows. A query stops after 3 seconds; narrow it if that happens.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          maxLength: 12000,
          description: 'A single SELECT statement with ? placeholders. Omit to read the schema.',
        },
        params: {
          type: 'array',
          maxItems: 50,
          items: { type: ['string', 'number', 'null'] },
          description: 'Values for the ? placeholders, in order.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum rows returned. Default 50.',
        },
      },
      additionalProperties: false,
    },
  },
];

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

export function invokeSceneRegexSearch(
  store: Store,
  chatId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
) {
  return runDataProcess(
    {
      path: store.path,
      taskId: '',
      name: 'scene.regex',
      args: { ...args, chatId },
    },
    signal
  );
}
