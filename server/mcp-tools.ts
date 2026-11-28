import type { Json, ProviderTool } from '../core/transport.js';
import { HelperToolError } from './app-errors.js';
import { readHelperChatState, HELPER_CHAT_STATE_TOOLS } from './helper-chat-state-tools.js';
import { HELPER_CODE_TOOLS, invokeHelperCodeTool } from './helper-code-tools.js';
import { HELPER_DATA_TOOLS, runDataProcess } from './helper-data-tools.js';
import type { DataOperation } from './helper-data-worker.js';
import { HELPER_GUIDE_TOOLS, invokeHelperGuideTool } from './helper-guide-tools.js';
import { HELPER_IMAGE_TOOLS, listHelperImages } from './helper-image-tools.js';
import { invokeResourceTool, RESOURCE_TOOLS } from './helper-resource-tools.js';
import { helperToolError } from './helper-tool-error.js';
import { text } from './request-validation.js';
import type { Store } from './store.js';

export type McpPorts = { store: Store; signal: AbortSignal };

type Run = (name: string, args: Record<string, unknown>, ports: McpPorts) => unknown;
type Family = { tools: ProviderTool[]; run: Run; chat?: true };

const data: Family = {
  tools: HELPER_DATA_TOOLS,
  run: (name, args, { store, signal }) =>
    runDataProcess(
      { path: store.path, taskId: '', name: name as DataOperation['name'], args },
      signal
    ),
};
const resources: Family = {
  tools: RESOURCE_TOOLS,
  run: (name, args, { store }) => invokeResourceTool(store, name, args),
};
const code: Family = {
  tools: HELPER_CODE_TOOLS,
  run: (name, args, { store, signal }) => invokeHelperCodeTool(store, name, args, signal),
};
const chat: Family = {
  tools: HELPER_CHAT_STATE_TOOLS,
  chat: true,
  run: (name, { chatId, ...args }, { store }) =>
    readHelperChatState(store, text(chatId, 'chat ID', 100), name, args),
};

const UNDO_NOTE =
  ' Over MCP undo keeps one step per resource: put related edits in one changes[] batch so that one resource_undo takes them all back.';
const EXPOSED: [string, Family, boolean, string?][] = [
  ['db.query', data, true],
  ['data.search', data, true],
  ['data.read', data, true],
  [
    'guide.read',
    { tools: HELPER_GUIDE_TOOLS, run: (_name, args) => invokeHelperGuideTool(args) },
    true,
  ],
  ['resource.read', resources, true],
  ['resource.readMany', resources, true],
  ['resource.patch', resources, false, UNDO_NOTE],
  [
    'resource.patchMany',
    resources,
    false,
    ' Over MCP there is no batch undo: resource_undo restores the single kept version of each resource separately.',
  ],
  ['resource.clone', resources, false],
  ['resource.undo', resources, false, UNDO_NOTE],
  ['preset.validate', resources, true],
  ['code.cbs', code, true],
  ['code.references', code, true],
  ['code.diagnose', code, true],
  ['code.regex', code, true],
  ['code.preview', code, true],
  ['chat.preview', chat, true],
  ['chat.variables.read', chat, true],
  ['scene.lore', chat, true],
  [
    'image.list',
    { tools: HELPER_IMAGE_TOOLS, run: (_name, args, { store }) => listHelperImages(store, args) },
    true,
  ],
];

const mcpName = (name: string) => name.replaceAll('.', '_');
const SOURCE_NAMES = new Map(EXPOSED.map(([name]) => [name, mcpName(name)]));
const NAME_PATTERN = new RegExp(
  `(?<![\\w.])(${[...SOURCE_NAMES.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replaceAll('.', '\\.'))
    .join('|')})(?![\\w])`,
  'gu'
);
const renamed = (value: string) =>
  value.replace(NAME_PATTERN, (name) => SOURCE_NAMES.get(name) ?? name);

const DATA_SCOPE: Json = {
  type: 'string',
  enum: ['library', 'chats'],
  description:
    'Where to search: library (default) for saved bots, personas, modules and prompt presets, chats for saved chat scenes and notes.',
};
const CHAT_ID: Json = {
  type: 'string',
  description: 'Id of the chat. List chats with db_query over agent_chats.',
};

type Schema = { properties?: Record<string, Json>; required?: string[] } & Record<string, Json>;
function schemaFor(source: ProviderTool, family: Family): Schema {
  const schema = structuredClone(source.inputSchema) as Schema;
  if (source.name === 'data.search')
    schema.properties = { ...schema.properties, scope: DATA_SCOPE };
  if (family.chat) {
    schema.properties = { chatId: CHAT_ID, ...schema.properties };
    schema.required = ['chatId', ...(schema.required ?? [])];
  }
  return schema;
}

type McpTool = {
  name: string;
  source: string;
  readOnly: boolean;
  family: Family;
  definition: {
    name: string;
    description: string;
    inputSchema: Schema;
    annotations: { readOnlyHint: boolean; openWorldHint: false };
  };
};
const TOOLS: McpTool[] = EXPOSED.map(([source, family, readOnly, note]) => {
  const tool = family.tools.find((candidate) => candidate.name === source);
  if (!tool) throw new Error(`MCP tool source missing: ${source}`);
  return {
    name: mcpName(source),
    source,
    readOnly,
    family,
    definition: {
      name: mcpName(source),
      description: renamed(tool.description + (note ?? '')),
      inputSchema: schemaFor(tool, family),
      annotations: { readOnlyHint: readOnly, openWorldHint: false },
    },
  };
});

export const mcpToolDefinitions = () => TOOLS.map((tool) => tool.definition);

export class McpUnknownToolError extends Error {}

function callNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(callNames);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const inner = object.arguments as Record<string, unknown> | undefined;
  if (object.name === 'app.call' && inner && typeof inner.name === 'string')
    return {
      name: SOURCE_NAMES.get(inner.name) ?? inner.name,
      arguments: callNames(inner.arguments),
    };
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, callNames(item)]));
}

function entryArguments(tool: McpTool, raw: unknown): Record<string, unknown> {
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'arguments must be an object');
  const args = raw as Record<string, unknown>;
  const { properties = {}, required = [] } = tool.definition.inputSchema;
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(properties, key));
  if (unknown.length)
    throw new HelperToolError(400, 'INVALID_ARGUMENTS', `unknown argument ${unknown.join(', ')}`);
  const missing = required.filter((key) => args[key] === undefined);
  if (missing.length)
    throw new HelperToolError(400, 'INVALID_ARGUMENTS', `missing argument ${missing.join(', ')}`);
  return args;
}

const content = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }];

export async function executeMcpTool(name: string, rawInput: unknown, ports: McpPorts) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new McpUnknownToolError(name);
  try {
    const result = await tool.family.run(tool.source, entryArguments(tool, rawInput), ports);
    return { content: content(callNames(result)) };
  } catch (error) {
    ports.signal.throwIfAborted();
    const failure = helperToolError(error, tool.readOnly, tool.source);
    const nextAction =
      typeof failure.nextAction === 'string'
        ? renamed(failure.nextAction)
        : {
            tool: SOURCE_NAMES.get(failure.nextAction.tool) ?? failure.nextAction.tool,
            guidance: renamed(failure.nextAction.guidance),
          };
    return { content: content({ ...failure, nextAction }), isError: true };
  }
}
