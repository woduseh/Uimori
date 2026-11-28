import type { Json, ProviderTool } from '../core/transport.js';
import { HelperToolError } from './app-errors.js';
import {
  describeAppTools,
  HELPER_APP_TOOLS,
  HELPER_GATEWAY_TOOLS,
  isHelperChatTool,
  operationIndex,
} from './helper-app-tools.js';
import { readHelperChatState, HELPER_CHAT_STATE_TOOLS } from './helper-chat-state-tools.js';
import { HELPER_CODE_TOOLS, invokeHelperCodeTool } from './helper-code-tools.js';
import { helperConfirmationTrait } from './helper-confirmation-traits.js';
import { HELPER_DATA_TOOLS, runDataProcess } from './helper-data-tools.js';
import type { DataOperation } from './helper-data-worker.js';
import { HELPER_GUIDE_TOOLS, invokeHelperGuideTool } from './helper-guide-tools.js';
import { HELPER_IMAGE_TOOLS, listHelperImages } from './helper-image-tools.js';
import { invokeResourceTool, RESOURCE_TOOLS } from './helper-resource-tools.js';
import { tokenFit } from './helper-read-fit.js';
import { HELPER_TASK_TOOLS, readTaskTool } from './helper-task-tools.js';
import { helperToolError } from './helper-tool-error.js';
import { imageContent, MCP_APP_OPERATIONS, type McpAppOperation } from './mcp-app-operations.js';
import { mcpDeleteAllowed } from './prompt-workspace.js';
import { text } from './request-validation.js';
import type { Store } from './store.js';

export type McpEffects = {
  chatChanged: (chatId: string) => void;
  chatDeleted: (chatId: string) => void;
};
export type McpPorts = { store: Store; signal: AbortSignal } & McpEffects;

type Run = (name: string, args: Record<string, unknown>, ports: McpPorts) => unknown;
type Family = { tools: ProviderTool[]; run: Run; chat?: true };

export const MCP_READ_TOKEN_BUDGET = 32_000;
export const MCP_DELETE_SETTING = 'Allow deletion over MCP without confirmation';
const mcpReadFit = tokenFit(MCP_READ_TOKEN_BUDGET);

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
  run: (name, args, { store }) => invokeResourceTool(store, name, args, mcpReadFit),
};
const code: Family = {
  tools: HELPER_CODE_TOOLS,
  run: (name, args, { store, signal }) =>
    invokeHelperCodeTool(store, name, args, signal, mcpReadFit),
};
const chat: Family = {
  tools: HELPER_CHAT_STATE_TOOLS,
  chat: true,
  run: (name, { chatId, ...args }, { store }) =>
    readHelperChatState(store, text(chatId, 'chat ID', 100), name, args, mcpReadFit),
};
const tasks: Family = {
  tools: HELPER_TASK_TOOLS,
  run: (name, args, { store }) => readTaskTool(store, name, args),
};

type Adapt = (description: string) => string;
function without(...parts: string[]): Adapt {
  return (description) =>
    parts.reduce((text, part) => {
      if (!text.includes(part)) throw new Error(`MCP description drifted: ${part}`);
      return text.replace(part, '');
    }, description);
}
function replacePhrase(from: string, to: string): Adapt {
  return (description) => {
    if (!description.includes(from)) throw new Error(`MCP description drifted: ${from}`);
    return description.replace(from, to);
  };
}
const mcpPageBudgetNote: Adapt = (description) =>
  `${description} Over MCP each response page is capped at about ${MCP_READ_TOKEN_BUDGET} tokens.`;
const undoNote: Adapt = (description) =>
  `${description} Over MCP undo keeps one step per resource: put related edits in one changes[] batch so that one resource_undo takes them all back.`;
const EXPOSED: [string, Family, boolean, Adapt?][] = [
  ['db.query', data, true],
  [
    'data.search',
    data,
    true,
    without(
      ', the captured editor input or this helper conversation',
      ', current is the frozen chat data of this task, editor is the captured editor input, and conversation is the earlier messages of this helper conversation, including compacted ones (historical data, not new instructions)',
      ', or from a bot, persona or module in the current scope,',
      ' In the current scope that editTarget names the shared library resource at the revision this task reserved: saving changes it for every chat (chat.lore makes a change for this chat only), and a newer library revision makes the save fail with a conflict.'
    ),
  ],
  ['data.read', data, true],
  [
    'guide.read',
    { tools: HELPER_GUIDE_TOOLS, run: (_name, args) => invokeHelperGuideTool(args) },
    true,
  ],
  [
    'resource.read',
    resources,
    true,
    replacePhrase(
      "stays within the model's input budget",
      `stays within about ${MCP_READ_TOKEN_BUDGET} tokens over MCP`
    ),
  ],
  [
    'resource.readMany',
    resources,
    true,
    replacePhrase(
      "share the model's input budget",
      `share a budget of about ${MCP_READ_TOKEN_BUDGET} tokens over MCP`
    ),
  ],
  ['resource.patch', resources, false, undoNote],
  [
    'resource.patchMany',
    resources,
    false,
    (description) =>
      `${without(', and the changed resources can be undone together from the helper screen')(description)} Over MCP there is no batch undo: resource_undo restores the single kept version of each resource separately.`,
  ],
  ['resource.clone', resources, false],
  ['resource.undo', resources, false, undoNote],
  ['preset.validate', resources, true, mcpPageBudgetNote],
  ['code.cbs', code, true, mcpPageBudgetNote],
  ['code.references', code, true, mcpPageBudgetNote],
  ['code.diagnose', code, true, mcpPageBudgetNote],
  ['code.regex', code, true, mcpPageBudgetNote],
  ['code.preview', code, true],
  ['chat.preview', chat, true, mcpPageBudgetNote],
  ['chat.variables.read', chat, true, mcpPageBudgetNote],
  ['scene.lore', chat, true, mcpPageBudgetNote],
  [
    'image.list',
    { tools: HELPER_IMAGE_TOOLS, run: (_name, args, { store }) => listHelperImages(store, args) },
    true,
  ],
  [
    'task.list',
    tasks,
    true,
    (description) =>
      `${without(
        ', task.cancel or task.retry',
        ' By default it lists active work in the current chat; a library helper without a chat sees all chats.'
      )(
        description
      )} Without chatId it lists all chats. Over MCP tasks are cancelled or retried in the app.`,
  ],
  ['task.inspect', tasks, true],
];

const mcpName = (name: string) => name.replaceAll('.', '_');
const SOURCE_NAMES = new Map<string, string>([
  ...EXPOSED.map(([name]): [string, string] => [name, mcpName(name)]),
  ['app.tools', 'app_tools'],
  ['app.call', 'app_call'],
]);
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
    'Where to search: library (default) for saved bots, personas, modules and prompt presets, chats for saved chat scenes.',
};
const CHAT_ID: Json = {
  type: 'string',
  description: 'Id of the chat. List chats with db_query over agent_chats.',
};
const GATEWAY_CHAT_ID: Record<McpAppOperation['chat'], Json | undefined> = {
  required: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
    description: 'Id of the chat, from app_call chat.list.',
  },
  optional: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
    description: 'Chat whose own settings to include. Omit for the global settings only.',
  },
  none: undefined,
};

type Schema = { properties?: Record<string, Json>; required?: string[] } & Record<string, Json>;
const renamedSchema = (schema: Json): Schema =>
  JSON.parse(
    JSON.stringify(schema, (key, value) =>
      key === 'description' && typeof value === 'string' ? renamed(value) : value
    )
  ) as Schema;
function schemaFor(source: ProviderTool, family: Family): Schema {
  const schema = renamedSchema(source.inputSchema);
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
const TOOLS: McpTool[] = EXPOSED.map(([source, family, readOnly, adapt]) => {
  const tool = family.tools.find((candidate) => candidate.name === source);
  if (!tool) throw new Error(`MCP tool source missing: ${source}`);
  if (helperConfirmationTrait(source))
    throw new Error(`MCP direct tool must not delete or start paid generation: ${source}`);
  return {
    name: mcpName(source),
    source,
    readOnly,
    family,
    definition: {
      name: mcpName(source),
      description: renamed(adapt ? adapt(tool.description) : tool.description),
      inputSchema: schemaFor(tool, family),
      annotations: { readOnlyHint: readOnly, openWorldHint: false },
    },
  };
});

function gatewaySchema(source: ProviderTool, operation: McpAppOperation): Schema {
  const schema = renamedSchema(source.inputSchema);
  const properties = { ...schema.properties };
  const { chatId: _injected, ...rest } = properties;
  if (operation.chat === 'none' && isHelperChatTool(source.name))
    throw new Error(`MCP app operation needs a chat mode: ${source.name}`);
  const chatId = GATEWAY_CHAT_ID[operation.chat];
  schema.properties = chatId ? { chatId, ...rest } : properties;
  const required = (schema.required ?? []).filter((key) => key !== 'chatId');
  schema.required = operation.chat === 'required' ? ['chatId', ...required] : required;
  if (operation.fields) {
    const missing = operation.fields.filter((key) => !Object.hasOwn(schema.properties!, key));
    if (missing.length)
      throw new Error(`MCP app operation fields drifted: ${source.name} ${missing.join(', ')}`);
    schema.properties = Object.fromEntries(
      Object.entries(schema.properties).filter(
        ([key]) => (key === 'chatId' && chatId) || operation.fields!.includes(key)
      )
    );
    schema.required = schema.required.filter((key) => Object.hasOwn(schema.properties!, key));
  }
  if (operation.actions) {
    const action = schema.properties.action as { enum?: string[] } | undefined;
    if (!operation.actions.every((name) => action?.enum?.includes(name)))
      throw new Error(`MCP app operation actions drifted: ${source.name}`);
    schema.properties.action = {
      ...(action as Record<string, Json>),
      enum: [...operation.actions],
    };
  }
  return schema;
}

const OWNER_CONFIRMATION = ', so the call waits for the owner confirmation';
const GATEWAY_ADAPT: Record<string, Adapt> = {
  'chat.delete': without(
    OWNER_CONFIRMATION,
    ', and the chat this helper conversation belongs to cannot be deleted from here, because the deletion would delete this conversation and the task making the call'
  ),
  'prompt.combination.delete': without(OWNER_CONFIRMATION),
};
const DELETE_ACTION = /delete|remove/u;
const deletes = (operation: McpAppOperation, action: unknown) =>
  operation.deletes === true ||
  (typeof action === 'string' && !!operation.deletes?.includes(action));

const GATEWAY: (ProviderTool & { operation: McpAppOperation })[] = Object.entries(
  MCP_APP_OPERATIONS
).map(([name, operation]) => {
  const source = HELPER_APP_TOOLS.find((tool) => tool.name === name);
  if (!source) throw new Error(`MCP app operation source missing: ${name}`);
  const trait = helperConfirmationTrait(name);
  if (trait === 'paid' || SOURCE_NAMES.has(name))
    throw new Error(`MCP app operation must not be exposed through the gateway: ${name}`);
  if (trait === 'delete' && operation.deletes !== true)
    throw new Error(`MCP delete operation must be listed under deletes: ${name}`);
  const unguarded = (operation.actions ?? []).filter(
    (action) => DELETE_ACTION.test(action) && !deletes(operation, action)
  );
  if (unguarded.length)
    throw new Error(
      `MCP delete action must be listed under deletes: ${name} ${unguarded.join(', ')}`
    );
  if (operation.deletes && operation.readOnly)
    throw new Error(`MCP delete operation must not be read-only: ${name}`);
  return {
    name,
    description: renamed((GATEWAY_ADAPT[name] ?? ((text) => text))(source.description)),
    inputSchema: gatewaySchema(source, operation),
    operation,
  };
});
const GATEWAY_TOOLS: ProviderTool[] = GATEWAY.map(({ operation: _operation, ...tool }) => tool);

const [helperAppTools, helperAppCall] = HELPER_GATEWAY_TOOLS;
const GATEWAY_DEFINITIONS = [
  {
    name: 'app_tools',
    description: `Look up the Uimori app operations that have no tool of their own here: what each one does and its exact argument schema. Run them with app_call. Pass names for the schemas of operations listed below, for example ["chat.read","scene.read"]. Pass query, an English purpose such as "find a scene by its text" or an exact operation name, for ranked candidates with complete schemas (3 by default; limit and offset page them). Pass neither to page through a compact catalog without schemas. The descriptions were written for the in-app helper: over MCP there is no current chat, task, editor or helper conversation, so chat operations take chatId, and a phrase about the current chat or the frozen data of a task does not apply. Paid generation and saves that still run inside an in-app helper task are not available here. Delete operations are listed, and they run only while the owner has turned on "${MCP_DELETE_SETTING}" in the app settings; otherwise they answer MCP_DELETE_DISABLED and change nothing. Operations by area, written as area.operation: ${operationIndex(GATEWAY_TOOLS, false)}.`,
    inputSchema: renamedSchema(helperAppTools!.inputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'app_call',
    description:
      'Run one Uimori app operation from app_tools by its exact name, with arguments that follow its schema. Read operations return data with continuation fields such as nextOffset, nextIndex or a ready nextRead. A save takes the revision you read and returns the new one, so a stale revision fails with REVISION_CONFLICT instead of overwriting. A delete runs at once, without a confirmation, and nothing here restores what it removed, so read the target first. A failed call returns an error code and says whether to correct the arguments, refresh and retry, or stop.',
    inputSchema: renamedSchema(helperAppCall!.inputSchema),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
] as const;

export const mcpToolDefinitions = () => [
  ...TOOLS.map((tool) => tool.definition),
  ...GATEWAY_DEFINITIONS,
];

export class McpUnknownToolError extends Error {}

function nextCall(name: string, args: unknown) {
  const core = SOURCE_NAMES.get(name);
  if (core && core !== 'app_call') return { name: core, arguments: callNames(args) };
  return { name: 'app_call', arguments: { name, arguments: callNames(args) } };
}
function callNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(callNames);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const inner = object.arguments as Record<string, unknown> | undefined;
  if (object.name === 'app.call' && inner && typeof inner.name === 'string')
    return nextCall(inner.name, inner.arguments);
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, callNames(item)]));
}

function checkedArguments(schema: Schema, raw: unknown): Record<string, unknown> {
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'arguments must be an object');
  const args = raw as Record<string, unknown>;
  const { properties = {}, required = [] } = schema;
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(properties, key));
  if (unknown.length)
    throw new HelperToolError(400, 'INVALID_ARGUMENTS', `unknown argument ${unknown.join(', ')}`);
  const missing = required.filter((key) => args[key] === undefined);
  if (missing.length)
    throw new HelperToolError(400, 'INVALID_ARGUMENTS', `missing argument ${missing.join(', ')}`);
  return args;
}

function unlistedFields(schema: Json, value: unknown, path: string): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  if (Array.isArray(value))
    return value.flatMap((item, index) => unlistedFields(schema.items, item, `${path}/${index}`));
  if (!value || typeof value !== 'object') return [];
  const properties = schema.properties as Record<string, Json> | undefined;
  if (!properties) return [];
  const object = value as Record<string, unknown>;
  return Object.keys(object).flatMap((key) =>
    Object.hasOwn(properties, key)
      ? unlistedFields(properties[key]!, object[key], `${path}/${key}`)
      : schema.additionalProperties === false
        ? [`${path}/${key}`]
        : []
  );
}

function unavailable(name: string): never {
  const direct = SOURCE_NAMES.get(name);
  if (direct)
    throw new HelperToolError(
      400,
      'MCP_DIRECT_TOOL',
      `${name} is the tool ${direct}; call it directly`
    );
  if (!HELPER_APP_TOOLS.some((tool) => tool.name === name))
    throw new HelperToolError(400, 'UNKNOWN_APP_TOOL', `${name} is not an app operation`);
  const trait = helperConfirmationTrait(name);
  throw new HelperToolError(
    403,
    'MCP_OPERATION_UNAVAILABLE',
    trait === 'paid'
      ? `${name} starts paid generation, which is not available over MCP yet; the user can start it in the app`
      : trait === 'delete'
        ? `${name} deletes permanently, which is not available over MCP; the user can do it in the app`
        : `${name} runs only inside an in-app helper task, which keeps its receipt or frozen task data`
  );
}

const content = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }];
type Outcome = { value: unknown; image?: ReturnType<typeof imageContent>['image'] };

async function answer(
  source: string,
  readOnly: boolean,
  ports: McpPorts,
  run: () => Promise<Outcome>
) {
  try {
    const { value, image } = await run();
    if (!readOnly) ports.store.changed(null);
    return { content: [...content(callNames(value)), ...(image ? [image] : [])] };
  } catch (error) {
    ports.signal.throwIfAborted();
    const failure = helperToolError(error, readOnly, source);
    const nextAction =
      typeof failure.nextAction === 'string'
        ? renamed(failure.nextAction)
        : {
            ...(SOURCE_NAMES.has(failure.nextAction.tool)
              ? { tool: SOURCE_NAMES.get(failure.nextAction.tool)! }
              : { tool: 'app_call', operation: failure.nextAction.tool }),
            guidance: renamed(failure.nextAction.guidance),
          };
    return { content: content({ ...failure, nextAction }), isError: true };
  }
}

const gatewayReadOnly = (operation: McpAppOperation, action: unknown) =>
  operation.readOnly || (!!operation.actions && action === 'read');

function gatewayCall(raw: unknown, ports: McpPorts) {
  const target =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const name = typeof target.name === 'string' ? target.name : '';
  const core = TOOLS.find((tool) => tool.source === name || tool.name === name);
  const entry = GATEWAY.find((tool) => tool.name === name);
  const action = (target.arguments as Record<string, unknown> | undefined)?.action;
  const readOnly = core ? core.readOnly : !entry || gatewayReadOnly(entry.operation, action);
  return answer(core?.source ?? (name || 'app.call'), readOnly, ports, async () => {
    const call = checkedArguments(GATEWAY_DEFINITIONS[1].inputSchema, raw);
    if (core)
      return {
        value: await core.family.run(
          core.source,
          checkedArguments(core.definition.inputSchema, call.arguments),
          ports
        ),
      };
    if (!entry) unavailable(name);
    const { operation } = entry;
    const inner = call.arguments;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner))
      throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'arguments must be an object');
    if (operation.actions && action === undefined)
      throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'missing argument action');
    if (operation.actions && (typeof action !== 'string' || !operation.actions.includes(action)))
      throw new HelperToolError(
        403,
        'MCP_OPERATION_UNAVAILABLE',
        `over MCP ${name} takes action ${operation.actions.join(', ')}`
      );
    if (deletes(operation, action) && !mcpDeleteAllowed(ports.store))
      throw new HelperToolError(
        403,
        'MCP_DELETE_DISABLED',
        `${name}${operation.deletes === true ? '' : ` ${String(action)}`} deletes, and the owner has not allowed deletion over MCP. Nothing was changed. The owner can turn on "${MCP_DELETE_SETTING}" under Settings, Models by role in the app, or delete it there.`
      );
    const checked = checkedArguments(entry.inputSchema as Schema, call.arguments);
    const unlisted = unlistedFields(entry.inputSchema, checked, '');
    if (unlisted.length)
      throw new HelperToolError(
        400,
        'INVALID_ARGUMENTS',
        `unknown argument ${unlisted.join(', ')}`
      );
    const { chatId, ...rest } = checked;
    const args = operation.chat === 'none' ? checked : rest;
    const value = await operation.run(args, {
      ...ports,
      chatId:
        operation.chat === 'none' || chatId === undefined
          ? undefined
          : text(chatId, 'chat ID', 100),
      fit: mcpReadFit,
    });
    if (!operation.image?.(args)) return { value };
    const { result, image } = imageContent(value);
    return { value: result, image };
  });
}

function coreCall(tool: McpTool, raw: unknown, ports: McpPorts) {
  return answer(tool.source, tool.readOnly, ports, async () => ({
    value: await tool.family.run(
      tool.source,
      checkedArguments(tool.definition.inputSchema, raw),
      ports
    ),
  }));
}

export async function executeMcpTool(name: string, rawInput: unknown, ports: McpPorts) {
  if (name === 'app_call') return gatewayCall(rawInput, ports);
  if (name === 'app_tools')
    return answer('app.tools', true, ports, async () => {
      const args = checkedArguments(GATEWAY_DEFINITIONS[0].inputSchema, rawInput);
      for (const listed of Array.isArray(args.names) ? args.names : [])
        if (typeof listed === 'string' && !GATEWAY.some((tool) => tool.name === listed))
          unavailable(listed);
      return {
        value: describeAppTools(GATEWAY_TOOLS, args, undefined, (name) => {
          const { operation } = GATEWAY.find((tool) => tool.name === name)!;
          return operation.readOnly ? 'read' : operation.actions ? 'mixed' : 'write';
        }),
      };
    });
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new McpUnknownToolError(name);
  return coreCall(tool, rawInput, ports);
}
