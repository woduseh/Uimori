import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { APP_VERSION } from './app-version.js';
import { registerRawRoute } from './endpoint.js';
import { executeMcpTool, mcpToolDefinitions, McpUnknownToolError } from './mcp-tools.js';
import { getMcpSkill, listMcpResources, listMcpSkills, readMcpResource } from './mcp-skills.js';
import { MCP_ROUTE } from './network-policy.js';
import type { Store } from './store.js';

// https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning (2026-11-28): every
// request carries its revision in _meta; clients that predate it open with initialize instead.
const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const SKILLS = 'io.modelcontextprotocol/skills';
// https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
// (2026-11-28): header errors are -32020 and unsupported revisions -32022, both with HTTP 400.
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
const CACHEABLE = new Set([
  'server/discover',
  'tools/list',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'skills/list',
  'skills/get',
]);
const SERVER_INFO = { name: 'uimori', title: 'Uimori', version: APP_VERSION };
const CAPABILITIES = { tools: {}, resources: {}, extensions: { [SKILLS]: {} } };
const INSTRUCTIONS =
  "Uimori's saved library: bots, personas and modules (character cards, lorebooks, CBS, Lua, regex and triggers) and prompt presets. Find with data_search or db_query, read with resource_read, edit with resource_patch at the revision you read, and take the last save back with resource_undo. Find why a run failed with task_list and task_inspect, which return its error, request text and model. Chats, scenes, outlines, settings and the other app operations are found with app_tools and run with app_call. No tool here starts paid generation or deletes a resource, chat or folder; a save replaces content as it does in the app.";

type Id = string | number | null;
type Params = Record<string, unknown>;
class RpcError extends Error {
  readonly code: number;
  readonly status: number;
  readonly data: unknown;
  constructor(code: number, message: string, status = 200, data?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

const object = (value: unknown): Params | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Params) : undefined;
const requiredString = (params: Params, key: string): string => {
  if (typeof params[key] !== 'string') throw new RpcError(-32602, `params.${key} is required`);
  return params[key];
};

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value !== 'string') return undefined;
  const encoded = /^=\?base64\?(.*)\?=$/u.exec(value)?.[1];
  return encoded === undefined ? value : Buffer.from(encoded, 'base64').toString('utf8');
}

function checkModernHeaders(request: FastifyRequest, method: string, params: Params, id?: Id) {
  const declared = header(request, 'mcp-protocol-version');
  const meta = object(params._meta) ?? {};
  if (declared !== undefined && declared !== meta[VERSION_KEY])
    throw new RpcError(
      HEADER_MISMATCH,
      `Header mismatch: MCP-Protocol-Version does not match ${VERSION_KEY}`,
      400
    );
  if (meta[VERSION_KEY] !== MODERN)
    throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version', 400, {
      supported: [MODERN, ...LEGACY],
      requested: meta[VERSION_KEY],
    });
  if (!object(meta[CAPABILITIES_KEY]))
    throw new RpcError(-32602, `_meta.${CAPABILITIES_KEY} is required`, 400);
  if (id === undefined) return;
  if (declared === undefined)
    throw new RpcError(HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version is required', 400);
  if (header(request, 'mcp-method') !== method)
    throw new RpcError(HEADER_MISMATCH, 'Header mismatch: Mcp-Method must equal method', 400);
  const named =
    method === 'tools/call' ? params.name : method === 'resources/read' ? params.uri : undefined;
  if (named !== undefined && header(request, 'mcp-name') !== named)
    throw new RpcError(HEADER_MISMATCH, 'Header mismatch: Mcp-Name must equal the body', 400);
}

function checkLegacyHeader(request: FastifyRequest) {
  const declared = header(request, 'mcp-protocol-version');
  if (declared !== undefined && !LEGACY.includes(declared))
    throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version', 400, {
      supported: [MODERN, ...LEGACY],
      requested: declared,
    });
}

async function dispatch(
  method: string,
  params: Params,
  modern: boolean,
  store: Store,
  signal: AbortSignal
): Promise<Params> {
  switch (method) {
    case 'initialize': {
      if (modern) break;
      const requested = params.protocolVersion;
      return {
        protocolVersion:
          typeof requested === 'string' && LEGACY.includes(requested) ? requested : LEGACY[0],
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      if (modern) break;
      return {};
    case 'server/discover':
      if (!modern) break;
      return {
        supportedVersions: [MODERN, ...LEGACY],
        capabilities: CAPABILITIES,
        instructions: INSTRUCTIONS,
      };
    case 'tools/list':
      return { tools: mcpToolDefinitions() };
    case 'tools/call':
      try {
        return await executeMcpTool(requiredString(params, 'name'), params.arguments, {
          store,
          signal,
        });
      } catch (error) {
        if (error instanceof McpUnknownToolError)
          throw new RpcError(-32602, `Unknown tool: ${error.message}`);
        throw error;
      }
    case 'resources/list':
      return { resources: listMcpResources() };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read': {
      const uri = requiredString(params, 'uri');
      const contents = readMcpResource(uri);
      if (!contents) throw new RpcError(-32602, `Resource not found: ${uri}`);
      return { contents: [contents] };
    }
    case 'skills/list':
      return { skills: listMcpSkills() };
    case 'skills/get': {
      const uri = requiredString(params, 'uri');
      const skill = getMcpSkill(uri);
      if (!skill) throw new RpcError(-32602, `Skill not found: ${uri}`);
      return { skill };
    }
  }
  throw new RpcError(-32601, `Method not found: ${method}`, modern ? 404 : 200);
}

function modernResult(method: string, result: Params): Params {
  return {
    ...result,
    resultType: 'complete',
    ...(CACHEABLE.has(method) ? { ttlMs: 60_000, cacheScope: 'private' } : {}),
    _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
  };
}

const failure = (reply: FastifyReply, id: Id, error: RpcError) =>
  reply.code(error.status).send({
    jsonrpc: '2.0',
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  });

async function handle(request: FastifyRequest, reply: FastifyReply, store: Store) {
  const message = object(request.body);
  const id = message && Object.hasOwn(message, 'id') ? (message.id as Id) : undefined;
  if (
    !message ||
    message.jsonrpc !== '2.0' ||
    typeof message.method !== 'string' ||
    (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number')
  )
    return failure(reply, null, new RpcError(-32600, 'Invalid Request', 400));
  const params = object(message.params) ?? {};
  const modern =
    object(params._meta)?.[VERSION_KEY] !== undefined ||
    header(request, 'mcp-protocol-version') === MODERN;
  try {
    if (modern) checkModernHeaders(request, message.method, params, id);
    else checkLegacyHeader(request);
    if (id === undefined) return reply.code(202).send();
    const disconnected = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) disconnected.abort();
    });
    const result = await dispatch(message.method, params, modern, store, disconnected.signal);
    return reply.send({
      jsonrpc: '2.0',
      id,
      result: modern ? modernResult(message.method, result) : result,
    });
  } catch (error) {
    if (error instanceof RpcError) return failure(reply, id ?? null, error);
    throw error;
  }
}

export function mcpRoutes(app: FastifyInstance, store: Store) {
  registerRawRoute(
    app,
    {
      method: 'POST',
      url: MCP_ROUTE,
      cache: 'no-store',
      errorHandler: (error: FastifyError, _request, reply) => {
        if (error.code?.startsWith('FST_ERR_CTP_') && error.statusCode === 400)
          return failure(reply, null, new RpcError(-32700, 'Parse error', 400));
        throw error;
      },
    },
    (_input, request, reply) => handle(request, reply, store)
  );
  registerRawRoute(
    app,
    { method: ['GET', 'DELETE'], url: MCP_ROUTE, cache: 'no-store' },
    (_input, _request, reply) => reply.code(405).header('Allow', 'POST').send()
  );
}
