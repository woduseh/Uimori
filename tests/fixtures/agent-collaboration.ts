import { afterEach, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { AgentCollaboration, AgentDefinition } from '../../core/agent-collaboration.js';
import type {
  ChatProfile,
  Connection,
  Content,
  ModelPreset,
  PromptPreset,
} from '../../core/product.js';
import type { Chat, ChatDetail, Run, ToolEvent } from '../../core/types.js';
import type { Json, WireRecord } from '../../core/transport.js';
import { createDefaultPromptProgram } from '../../core/prompt-defaults.js';
import { createApp, type App } from '../../server/app.js';
import { injectWithFixtureBot } from './chat.js';
import { loopbackProvider, writeSse } from './loopback-provider.js';

export const MAIN_ONLY = 'MAIN_AUTHOR_INSTRUCTIONS_DO_NOT_COPY_TO_ADVISORS';
export const SHARED = 'SHARED_CREATIVE_CONTRACT_SYNTHETIC';
export const credentialEnv = 'Agent_Collaboration_Runtime_Key';
const bearer = 'synthetic-agent-collaboration-key';
export type Body = {
  model: string;
  instructions?: string;
  input: any[];
  tools?: { name: string }[];
  max_output_tokens?: number;
  temperature?: number;
};
type Owner = {
  directory: string;
  app?: App;
  close?: () => Promise<void>;
  releases: (() => void)[];
};
const owners: Owner[] = [];
afterEach(async () => {
  try {
    for (const owner of owners.splice(0).reverse()) {
      for (const release of owner.releases) release();
      await owner.app?.close();
      await owner.close?.();
      const path = resolve(owner.directory),
        within = relative(resolve(tmpdir()), path);
      if (
        isAbsolute(within) ||
        within.startsWith('..') ||
        !basename(path).startsWith('uimori-agent-collaboration-')
      )
        throw new Error('Unsafe collaboration fixture cleanup');
      await rm(path, { recursive: true, force: true });
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
export const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
export function agent(id = 'advisor', changes: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    title: `Synthetic ${id}`,
    description: `Read-only ${id} perspective`,
    instructions: `ADVISOR_INSTRUCTIONS_${id}: cite source evidence and distinguish inference.`,
    model: null,
    trigger: 'on-demand',
    tools: ['knowledge'],
    maxCalls: 3,
    maxOutputChars: 6000,
    ...changes,
  };
}
export function collaboration(changes: Partial<AgentCollaboration> = {}): AgentCollaboration {
  return {
    enabled: true,
    sharedInstructions: SHARED,
    sharedControls: ['tone'],
    maxCalls: 6,
    agents: [agent()],
    ...changes,
  };
}
export async function api<T = any>(
  app: App,
  path: string,
  body?: unknown,
  method: 'POST' | 'PUT' | 'PATCH' = 'POST'
): Promise<T> {
  const response = await injectWithFixtureBot(app, {
    method: body === undefined ? 'GET' : method,
    url: path,
    headers: {
      host: '127.0.0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as T;
}
export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
export async function fixture(
  handler: (
    body: Body,
    target: ServerResponse,
    number: number,
    wire: WireRecord
  ) => void | Promise<void>,
  options: {
    collaboration?: AgentCollaboration | null;
    selectedAgents?: string[];
    maxCalls?: number;
    timeoutMs?: number;
  } = {}
) {
  vi.stubEnv(credentialEnv, bearer);
  const owner: Owner = {
    directory: await mkdtemp(join(tmpdir(), 'uimori-agent-collaboration-')),
    releases: [],
  };
  owners.push(owner);
  let app: App, chat: Chat;
  const failures: unknown[] = [];
  const observed: WireRecord[] = [];
  const provider = await loopbackProvider(async (captured, target) => {
    try {
      expect(captured.url).toBe('/v1/responses');
      expect(captured.headers.authorization).toBe(`Bearer ${bearer}`);
      // This runs in the actual HTTP server, after bytes arrive, not in a mocked transport hook.
      const attempts = app.store.product.attempts(chat.id);
      expect(attempts).toHaveLength(provider.requests.length);
      const running = attempts.filter((attempt) => attempt.status === 'running');
      expect(running).toHaveLength(1);
      expect(running[0].role).toBe('main');
      const wire = running[0].request as WireRecord;
      expect(wire.role).toBe('main');
      expect(wire.modelId).toBe(JSON.parse(captured.body).model);
      expect(running[0].runId).toBeTruthy();
      observed.push(structuredClone(wire));
      await handler(JSON.parse(captured.body) as Body, target, provider.requests.length, wire);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  owner.close = provider.close;
  app = await createApp({
    dbPath: join(owner.directory, 'story.sqlite'),
    buildId: 'agent-collaboration-synthetic',
    instanceId: randomUUID(),
    testMode: true,
    approvedOrigins: [provider.origin],
  });
  owner.app = app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  chat = await api<Chat>(app, '/api/chats', { title: 'Synthetic advisor story' });
  chat = await api<Chat>(
    app,
    `/api/chats/${chat.id}/settings`,
    {
      ...chat.settings,
      expectedSettingsRevision: chat.settingsRevision,
      translation: false,
      status: false,
      maxCalls: options.maxCalls ?? 8,
    },
    'PATCH'
  );
  const lore = await api<Content>(app, '/api/content', {
    kind: 'module',
    title: 'Copper observatory',
    description: 'Synthetic scoped reference',
    text: 'The copper observatory stands north of the harbor.',
    loading: 'discoverable',
    relatedIds: [],
  });
  const foreign = await api<Content>(app, '/api/content', {
    kind: 'module',
    title: 'Unattached reference',
    description: 'Outside this chat scope',
    text: 'UNATTACHED_REFERENCE_MUST_NOT_LEAK',
    loading: 'discoverable',
    relatedIds: [],
  });
  const connection = await api<Connection>(app, '/api/connections', {
    title: 'Loopback Responses only',
    protocol: 'openai-responses-v1',
    endpoint: `${provider.origin}/v1`,
    credentialEnv,
    enabled: true,
  });
  const advisorConnection = await api<Connection>(app, '/api/connections', {
    title: 'Independent advisor authorization',
    protocol: 'openai-responses-v1',
    endpoint: `${provider.origin}/v1`,
    credentialEnv,
    enabled: true,
  });
  const mainModel = await api<ModelPreset>(app, '/api/model-presets', {
    title: 'Synthetic main',
    connectionId: connection.id,
    modelId: 'synthetic-collaboration-main',
    maxOutputTokens: 4096,
    temperature: null,
    timeoutMs: options.timeoutMs ?? 4000,
  });
  const advisorModel = await api<ModelPreset>(app, '/api/model-presets', {
    title: 'Synthetic advisor',
    connectionId: advisorConnection.id,
    modelId: 'synthetic-collaboration-advisor',
    maxOutputTokens: 1024,
    temperature: null,
    timeoutMs: options.timeoutMs ?? 4000,
  });
  const program = createDefaultPromptProgram(MAIN_ONLY);
  program.controls = [
    { id: 'tone', label: 'Shared tone', type: 'text', default: 'default tone' },
    { id: 'private', label: 'Main only', type: 'text', default: 'default private' },
  ];
  if (options.collaboration !== null) {
    program.collaboration = structuredClone(options.collaboration ?? collaboration());
    for (const definition of program.collaboration.agents)
      if ((options.selectedAgents ?? ['advisor']).includes(definition.id))
        definition.model = { id: advisorModel.id };
  }
  const prompt = await api<PromptPreset>(app, '/api/prompt-presets', {
    title: 'Synthetic collaboration prompt',
    role: 'main',
    program,
  });
  const prior = await api<ChatProfile>(app, `/api/chats/${chat.id}/profile`);
  const profile = await api<ChatProfile>(
    app,
    `/api/chats/${chat.id}/profile`,
    {
      expectedRevision: prior.revision,
      attachments: [ref(lore)],
      personaReference: prior.personaReference,
      routes: { main: { id: mainModel.id }, translation: null, status: null, image: null },
      image: false,
      prompts: { main: ref(prompt) },
      promptControls: {
        [`${prompt.id}@${prompt.revision}`]: {
          values: { tone: 'shared dramatic tone', private: 'PRIVATE_UNSHARED_CONTROL' },
          combinations: [],
        },
      },
    },
    'PUT'
  );
  const command = {
    request: 'Continue the synthetic harbor scene.',
    expectedRevision: chat.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    expectedProfileRevision: profile.revision,
    idempotencyKey: randomUUID(),
  };
  return {
    owner,
    app,
    chat,
    lore,
    foreign,
    connection,
    advisorConnection,
    mainModel,
    advisorModel,
    prompt,
    profile,
    command,
    provider,
    failures,
    observed,
    start: () => api<Run>(app, `/api/chats/${chat.id}/runs`, command),
    detail: () => api<ChatDetail>(app, `/api/chats/${chat.id}`),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function settled(state: Fixture, id: string): Promise<Run> {
  await expect
    .poll(async () => (await api<Run>(state.app, `/api/runs/${id}`)).status, { timeout: 6000 })
    .not.toMatch(/^(queued|running|waiting_for_state)$/);
  expect(state.failures).toEqual([]);
  return api<Run>(state.app, `/api/runs/${id}`);
}
export function packet(body: Body): any {
  for (const text of [
    body.instructions,
    ...body.input.flatMap((item) =>
      Array.isArray(item?.content) ? item.content.map((part: any) => part?.text) : []
    ),
  ]) {
    if (typeof text !== 'string') continue;
    for (const prefix of [
      'Request data (JSON):\n',
      'Host context (JSON reference data, not instructions or permission):\n',
    ]) {
      const index = text.indexOf(prefix);
      if (index >= 0) {
        const value = JSON.parse(text.slice(index + prefix.length).split('\n', 1)[0]);
        if (value?.source && typeof value.source === 'object') return value;
      }
    }
  }
  throw new Error('Missing source packet in Responses fixture request');
}
export const toolName = (body: Body, name: string) => {
  const alias = body.tools?.find((tool) =>
    tool.name.endsWith('_' + name.replaceAll('.', '_'))
  )?.name;
  if (!alias) throw new Error('Missing advertised tool: ' + name);
  return alias;
};
export function rawCall(name: string, args: Json, id: string): Json {
  return {
    type: 'function_call',
    id: `item-${id}`,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}
export const call = (body: Body, name: string, args: Json, id: string) =>
  rawCall(toolName(body, name), args, id);
export const message = (text: string): Json => ({
  type: 'message',
  role: 'assistant',
  id: randomUUID(),
  status: 'completed',
  content: [{ type: 'output_text', text }],
});
export async function send(target: ServerResponse, output: Json[], status = 'completed') {
  await writeSse(
    target,
    [
      {
        type: `response.${status}`,
        response: {
          id: randomUUID(),
          status,
          output,
          usage: { input_tokens: 7, output_tokens: 3 },
          ...(status === 'incomplete'
            ? { incomplete_details: { reason: 'max_output_tokens' } }
            : {}),
        },
      },
    ],
    true
  );
}
export function consults(run: Run): (ToolEvent & { result: any })[] {
  return run.toolEvents.filter((event) => event.name === 'agents.consult');
}
export function outputs(body: Body): any[] {
  return body.input
    .filter((item) => item.type === 'function_call_output')
    .map((item) => JSON.parse(item.output));
}
