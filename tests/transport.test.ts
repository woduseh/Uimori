import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { nativeContent } from './fixtures/native-content.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import {
  executeProvider,
  parseCatalog,
  transportConnection,
  validateConnection,
  validateRequest,
  type ProviderConnection,
  type ProviderRequest,
  type WireRecord,
} from '../core/transport.js';
import { loopbackProvider, sse, writeSse } from './fixtures/loopback-provider.js';
import { defaultProfile, type Content, type Connection } from '../core/product.js';
import { buildMainInput } from '../core/provider.js';
import { CATALOG_READ_GUIDANCE } from '../core/read-access.js';
import { CONTEXT_RETRIEVAL_GUIDANCE } from '../core/context-summary-policy.js';
import type { ModelInput, RunSnapshot, ToolEvent } from '../core/types.js';
import { runMain, type MainHooks } from '../server/model-runner.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(handler: Parameters<typeof loopbackProvider>[0]) {
  const server = await loopbackProvider(handler);
  cleanups.push(server.close);
  return server;
}
const connection = (endpoint: string): ProviderConnection => ({
  id: 'local-fixture',
  protocol: 'fixture-sse-v1',
  endpoint,
});
const request = (role: ProviderRequest['role'] = 'main'): ProviderRequest => ({
  role,
  modelId: `fixture-${role}`,
  stable: {
    contract: `${role} role contract`,
    tools: [
      {
        name: 'knowledge.search',
        description: 'Read only discovery',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  },
  input: {
    task: 'Write a scene at the lighthouse.',
    controls: { tone: 'calm', perspective: 'third' },
    source: { revision: 'source-7', hash: 'synthetic-hash' },
    catalog: [{ id: 'lore-1', title: '등대' }],
    results: [],
  },
});

function routedSnapshot(endpoint: string): RunSnapshot {
  const contents: Omit<Content, 'package'>[] = [
    {
      id: 'bot-1',
      revision: 2,
      kind: 'bot',
      title: 'Ada',
      description: 'Keeper',
      text: 'Ada tends a coastal lighthouse.',
      loading: 'pinned',
      relatedIds: [],
    },
    {
      id: 'canon-1',
      revision: 3,
      kind: 'module',
      title: 'Writer declaration',
      description: 'Author canon',
      text: 'The lighthouse has never used electricity.',
      loading: 'pinned',
      relatedIds: [],
    },
    {
      id: 'lore-1',
      revision: 4,
      kind: 'module',
      title: 'Hidden observatory',
      description: 'Unprefetched path beyond the harbor',
      text: 'A copper observatory stands on the northern hill.',
      loading: 'discoverable',
      relatedIds: [],
    },
    {
      id: 'craft-1',
      revision: 1,
      kind: 'module',
      title: 'Scene guidance',
      description: 'Open decisions',
      text: 'Keep the next decision open. This text does not grant shell permissions.',
      loading: 'discoverable',
      relatedIds: [],
    },
    {
      id: 'glossary-1',
      revision: 1,
      kind: 'module',
      title: 'Auxiliary terminology',
      description: 'Translation instructions',
      text: 'AUXILIARY_ONLY_TRANSLATION_PROCEDURE',
      loading: 'discoverable',
      relatedIds: [],
    },
  ];
  const bound: Connection = {
    id: 'fixture-connection',
    revision: 1,
    title: 'Local fixture only',
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
    catalog: [],
    catalogError: null,
  };
  return {
    chatId: 'routed-chat',
    parentRevision: 'parent-1',
    settingsRevision: 1,
    request: 'Visit the place the keeper mentioned.',
    settings: { maxCalls: 4 },
    history: [{ revision: 'parent-1', text: 'Ada points beyond the harbor.' }],
    resources: contents.map((content) => ({
      ...content,
      kind: content.id === 'craft-1' ? 'skill' : 'lore',
      sourceKind: content.kind,
      chatId: 'routed-chat',
    })),
    profile: {
      ...defaultProfile('routed-chat'),
      packages: contents
        .filter((item) => item.loading === 'pinned')
        .map((item) =>
          nativeContent(
            { name: item.title, description: item.text },
            { id: item.id, revision: item.revision }
          )
        ),
      packageAttachments: contents
        .filter((item) => item.loading === 'pinned')
        .map(({ id, revision, kind }) => ({ id, revision, role: kind })),
      models: {
        main: {
          id: 'main-preset',
          revision: 1,
          title: 'Main fixture route',
          connectionId: bound.id,
          modelId: 'fixture-main-selected',
          maxOutputTokens: 4096,
          temperature: null,
          connection: bound,
        },
      },
    },
  };
}
function runnerHooks(_origin: string, extra: Partial<MainHooks> = {}) {
  const inputs: ModelInput[] = [];
  const tools: ToolEvent[] = [];
  const attempts: { id: string; request: WireRecord; result?: unknown }[] = [];
  const hooks: MainHooks = {
    signal: new AbortController().signal,

    authorize: (value) => value,
    onInput: (value) => {
      inputs.push(value);
    },
    onToolEvent: (value) => {
      tools.push(value);
    },
    onAttemptStart: (wire) => {
      const id = `attempt-${attempts.length + 1}`;
      attempts.push({ id, request: wire });
      return id;
    },
    onAttemptFinish: (id, result) => {
      attempts.find((item) => item.id === id)!.result = result;
    },
    ...extra,
  };
  return { hooks, inputs, tools, attempts };
}

describe('server main runner through the actual loopback adapter', () => {
  test('public response progress keeps tool announcements and final output under separate durable attempt IDs', async () => {
    let calls = 0;
    const server = await fixture(async (_captured, response) => {
      if (++calls === 1)
        await writeSse(response, [
          { type: 'text_delta', delta: '자료를 확인할게요.' },
          {
            type: 'tool_delta',
            index: 0,
            id: 'read-1',
            name: 'knowledge.read',
            argumentsDelta: '{"ids":["lore-1"]}',
          },
          { type: 'opaque_state', state: 'PRIVATE_CONTINUATION' },
          { type: 'done', reason: 'tool_calls' },
        ]);
      else
        await writeSse(response, [
          { type: 'text_delta', delta: '등대의 ' },
          { type: 'text_delta', delta: '불이 켜졌다.' },
          { type: 'done', reason: 'stop' },
        ]);
    });
    const progress: Parameters<NonNullable<MainHooks['onResponseProgress']>>[0][] = [];
    const observed = runnerHooks(server.origin, {
      onResponseProgress: (item) => {
        expect(observed.attempts.some((attempt) => attempt.id === item.attemptId)).toBe(true);
        progress.push(item);
      },
    });
    const result = await runMain(
      await prepareNativeRisuRun(routedSnapshot(server.endpoint)),
      observed.hooks
    );
    expect(result.status).toBe('completed');
    expect(result.text).toBe('등대의 불이 켜졌다.');
    expect(progress).toEqual([
      {
        attemptId: 'attempt-1',
        segment: 0,
        text: '자료를 확인할게요.',
        offset: '자료를 확인할게요.'.length,
      },
      { attemptId: 'attempt-2', segment: 0, text: '등대의 ', offset: 4 },
      {
        attemptId: 'attempt-2',
        segment: 0,
        text: '불이 켜졌다.',
        offset: '등대의 불이 켜졌다.'.length,
      },
    ]);
    expect(JSON.stringify(progress)).not.toContain('PRIVATE_CONTINUATION');
    expect(JSON.stringify(progress)).not.toContain('lore-1');
  });
  test('P01 P02 P05 pins attached canon, compiles active controls and journals real tool turns before fetch', async () => {
    let count = 0;
    const server = await fixture(async (captured, response) => {
      count++;
      expect(observed.attempts).toHaveLength(count);
      if (count === 1)
        await writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: 'read-lore',
            name: 'knowledge.read',
            argumentsDelta: '{"ids":["lore-1"]}',
          },
          {
            type: 'tool_delta',
            index: 1,
            id: 'read-skill',
            name: 'skills.load',
            argumentsDelta: '{"id":"craft-1"}',
          },
          { type: 'opaque_state', state: { continuation: 'fixture-opaque-9' } },
          { type: 'usage', inputTokens: 7, outputTokens: 2 },
          { type: 'done', reason: 'tool_calls' },
        ]);
      else {
        const body = JSON.parse(captured.body);
        expect(body.input.results.map((item: ToolEvent) => item.callId)).toEqual([
          'read-lore',
          'read-skill',
        ]);
        expect(body.input.results[0].result.items[0].read.text).toBe(
          'A copper observatory stands on the northern hill.'
        );
        expect(body.opaqueState).toEqual({ continuation: 'fixture-opaque-9' });
        await writeSse(response, [
          { type: 'text_delta', delta: 'Ada walked toward the copper observatory.' },
          { type: 'usage', inputTokens: 11, outputTokens: 3 },
          { type: 'done', reason: 'stop' },
        ]);
      }
    });
    const observed = runnerHooks(server.origin);
    const snapshot = routedSnapshot(server.endpoint);
    const outcome = await runMain(await prepareNativeRisuRun(snapshot), observed.hooks);
    expect(outcome).toMatchObject({
      status: 'completed',
      text: 'Ada walked toward the copper observatory.',
      usage: { modelCalls: 2, inputTokens: 18, outputTokens: 5, costUsd: null },
    });
    expect(observed.attempts.every((attempt) => !!attempt.result)).toBe(true);
    expect(observed.tools).toHaveLength(2);
    const first = JSON.parse(server.requests[0].body);
    expect(first.input.controls).toEqual({});
    expect(JSON.stringify(first)).not.toMatch(/minWords|maxWords|customWords|"preset"/);
    expect(
      first.prompt.messages.some((message: any) =>
        message.content.some((part: any) =>
          part.text.includes('The lighthouse has never used electricity.')
        )
      )
    ).toBe(true);
    expect(
      JSON.stringify(first).split('The lighthouse has never used electricity.').length - 1
    ).toBe(1);
    expect(first.input.source.facts).toEqual([]);
    expect(first.input).not.toHaveProperty('history');
    expect(
      first.prompt.messages
        .filter((m: any) => m.provenance.origin === 'history')
        .map((m: any) => m.content[0].text)
    ).toEqual(snapshot.history.map((h) => h.text));
    expect(JSON.stringify(first)).not.toContain('AUXILIARY_ONLY');
    expect(first.input.catalog.find((item: Content) => item.id === 'lore-1')).not.toHaveProperty(
      'text'
    );
    expect(first.input.source.prefetch).toEqual([]);
    expect(first.generation).toEqual({ maxOutputTokens: 4096, temperature: null });
  });

  test('P05 rejects reused tool IDs across main rounds before executing any tools from the invalid round', async () => {
    let calls = 0;
    const originalId = 'Read-Lore_Original.7';
    const server = await fixture(async (_captured, response) => {
      calls++;
      if (calls === 1)
        await writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: originalId,
            name: 'knowledge.read',
            argumentsDelta: '{"ids":["lore-1"]}',
          },
          { type: 'usage', inputTokens: 7, outputTokens: 2 },
          { type: 'done', reason: 'tool_calls' },
        ]);
      else if (calls === 2)
        await writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: 'fresh-call',
            name: 'skills.load',
            argumentsDelta: '{"id":"craft-1"}',
          },
          {
            type: 'tool_delta',
            index: 1,
            id: originalId,
            name: 'knowledge.read',
            argumentsDelta: '{"ids":["lore-1"]}',
          },
          { type: 'usage', inputTokens: 11, outputTokens: 4 },
          { type: 'done', reason: 'tool_calls' },
        ]);
      else
        await writeSse(response, [
          { type: 'text_delta', delta: 'Unexpected third request.' },
          { type: 'done', reason: 'stop' },
        ]);
    });
    const observed = runnerHooks(server.origin);
    const outcome = await runMain(
      await prepareNativeRisuRun(routedSnapshot(server.endpoint)),
      observed.hooks
    );
    expect(outcome).toMatchObject({
      status: 'error',
      error: 'DUPLICATE_TOOL_ID',
      text: '',
      usage: { modelCalls: 2, inputTokens: 18, outputTokens: 6, costUsd: null },
    });
    expect(server.requests).toHaveLength(2);
    expect(observed.attempts).toHaveLength(2);
    expect(observed.attempts.every((attempt) => !!attempt.result)).toBe(true);
    expect(observed.tools.map((event) => event.callId)).toEqual([originalId]);
    expect(
      JSON.parse(server.requests[1].body).input.results.map((event: ToolEvent) => event.callId)
    ).toEqual([originalId]);
  });

  test.each([
    { selection: 'hook before preset', hookTimeout: 100, presetTimeout: 5000 },
    { selection: 'preset', hookTimeout: undefined, presetTimeout: 100 },
  ])(
    'P05 honors main timeout from $selection and forwards selected thinking level',
    async ({ hookTimeout, presetTimeout }) => {
      const server = await fixture((_captured, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(sse({ type: 'text_delta', delta: 'Observed main prefix.' }));
        response.write(sse({ type: 'usage', inputTokens: 5, outputTokens: 2 }));
      });
      const observed = runnerHooks(server.origin, { timeoutMs: hookTimeout });
      const snapshot = routedSnapshot(server.endpoint);
      snapshot.profile!.models.main!.timeoutMs = presetTimeout;
      snapshot.profile!.models.main!.thinkingLevel = 'LOW';
      const outcome = await runMain(await prepareNativeRisuRun(snapshot), observed.hooks);
      expect(outcome).toMatchObject({ error: 'TIMEOUT', usage: { modelCalls: 1 } });
      expect(server.requests).toHaveLength(1);
      expect(observed.tools).toEqual([]);
      expect(observed.attempts).toHaveLength(1);
      expect(observed.attempts[0].result).toMatchObject({ error: { code: 'TIMEOUT' } });
      expect(JSON.parse(server.requests[0].body).generation).toEqual({
        maxOutputTokens: 4096,
        temperature: null,
        thinkingLevel: 'LOW',
      });
    }
  );

  test('P04 P05 checks current connection policy before each call and never retries a revoked route', async () => {
    const server = await fixture(async (_captured, response) => {
      await writeSse(response, [
        {
          type: 'tool_delta',
          index: 0,
          id: 'read-lore',
          name: 'knowledge.read',
          argumentsDelta: '{"ids":["lore-1"]}',
        },
        { type: 'done', reason: 'tool_calls' },
      ]);
    });
    let checks = 0;
    const observed = runnerHooks(server.origin, {
      authorize: (value) => ({ ...value, enabled: ++checks === 1 }),
    });
    const result = await runMain(
      await prepareNativeRisuRun(routedSnapshot(server.endpoint)),
      observed.hooks
    );
    expect(result).toMatchObject({
      status: 'error',
      error: 'CONNECTION_NOT_AUTHORIZED',
      usage: { modelCalls: 1, inputTokens: null, costUsd: null },
    });
    expect(server.requests).toHaveLength(1);
    expect(observed.attempts).toHaveLength(1);
    expect(checks).toBe(2);
  });

  test('P01 P04 excludes unapproved resources and never runs a tool the app does not have', async () => {
    let turns = 0;
    const server = await fixture(async (_captured, response) => {
      await writeSse(
        response,
        ++turns === 1
          ? [
              {
                type: 'tool_delta',
                index: 0,
                id: 'escape',
                name: 'shell.execute',
                argumentsDelta: '{"command":"PRIVATE_ARGUMENT"}',
              },
              { type: 'done', reason: 'tool_calls' },
            ]
          : [
              { type: 'text_delta', delta: '등대의 불이 켜졌다.' },
              { type: 'done', reason: 'stop' },
            ]
      );
    });
    const snapshot = routedSnapshot(server.endpoint);
    snapshot.resources[0].relatedIds = ['lore-1', 'persona-1', 'unknown-private-id'];
    expect(
      buildMainInput(snapshot).catalog.find((item) => item.id === snapshot.resources[0].id)
        ?.relatedIds
    ).toEqual(['lore-1']);
    const observed = runnerHooks(server.origin);
    const result = await runMain(await prepareNativeRisuRun(snapshot), observed.hooks);
    expect(result).toMatchObject({ status: 'completed' });
    expect(observed.tools).toMatchObject([
      {
        callId: 'escape',
        name: 'unapproved',
        args: {},
        denied: true,
        errorKind: 'recoverable',
        result: { code: 'TOOL_NOT_ALLOWED' },
      },
    ]);
    expect(server.requests).toHaveLength(2);
  });
});
const options = (_origin: string, extra: Partial<Parameters<typeof executeProvider>[2]> = {}) => ({
  signal: new AbortController().signal,
  ...extra,
});

describe('fixture HTTP transport (no live provider compatibility claim)', () => {
  test('P02 P05 preserves exact role requests and stable prefix while dynamic controls and source change', async () => {
    const server = await fixture(async (_req, response) => {
      await writeSse(response, [
        { type: 'text_delta', delta: 'fixture narrative' },
        { type: 'done', reason: 'stop' },
      ]);
    });
    const wire: WireRecord[] = [];
    const first = request();
    const second = structuredClone(first);
    second.input.controls.tone = 'vivid';
    second.input.source = { revision: 'source-8', hash: 'different' };
    const translated = request('translation');
    translated.stable.tools = [];
    const bootstrapped = request();
    bootstrapped.bootstrap = [
      {
        callId: 'bootstrap-context',
        name: 'bootstrap_context',
        args: {},
        result: { session: 'synthetic' },
        denied: false,
      },
    ];
    bootstrapped.toolChoice = 'knowledge.search';
    for (const input of [first, second, translated, bootstrapped]) {
      expect(
        (
          await executeProvider(
            connection(server.endpoint),
            input,
            options(server.origin, {
              onWire: (record) => {
                wire.push(record);
              },
            })
          )
        ).status
      ).toBe('completed');
    }
    expect(wire[0].stablePrefixSha256).toBe(wire[1].stablePrefixSha256);
    expect(wire[0].bodySha256).not.toBe(wire[1].bodySha256);
    expect(wire[2].role).toBe('translation');
    expect(wire[2].modelId).toBe('fixture-translation');
    for (let index = 0; index < wire.length; index++) {
      expect(wire[index].body).toEqual(JSON.parse(server.requests[index].body));
      expect(wire[index].bodySha256).toBe(
        createHash('sha256').update(server.requests[index].body).digest('hex')
      );
    }
    expect(server.requests[2].body).not.toContain('main role contract');
    expect(JSON.parse(server.requests[3].body)).toMatchObject({
      bootstrap: [{ callId: 'bootstrap-context', name: 'bootstrap_context' }],
      toolChoice: 'knowledge.search',
    });
    expect(server.requests[0].body.indexOf('stable')).toBeLessThan(
      server.requests[0].body.indexOf('controls')
    );
    const unsupported = { ...request(), headers: { authorization: 'injected' } };
    expect(() => validateRequest(unsupported)).toThrow('UNSUPPORTED_OPTIONS');
  });

  test('P04 validates catalog data separately and keeps unknown metadata', () => {
    const models = parseCatalog({
      models: [
        { id: 'new-catalog-entry', label: 'New fixture entry', capabilities: { tools: true } },
      ],
    });
    expect(models.map((item) => item.id)).toEqual(['new-catalog-entry']);
    expect(models[0].pricing).toEqual({
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      revision: null,
    });
    expect(models[0].capabilities.structuredOutput).toBeNull();
    expect(() =>
      parseCatalog({
        models: [],
        credentialRef: 'UIMORI_PROVIDER_OTHER',
        preset: 'override',
      })
    ).toThrow('UNSUPPORTED_OPTIONS');
    expect(() =>
      parseCatalog({
        models: [{ id: 'bad', label: 'bad', headers: { authorization: 'overwrite' } }],
      })
    ).toThrow('UNSUPPORTED_OPTIONS');
    expect(() =>
      parseCatalog({ models: [{ id: 'a', label: 'a', pricing: { inputUsdPerMillion: -1 } }] })
    ).toThrow('INVALID_USAGE');
  });

  test('P12 P04 rejects implicit redirects and malformed connection options; credentials stay server-side and redacted', async () => {
    const target = await fixture((_req, response) => {
      response.end('must not follow');
    });
    const server = await fixture(async (req, response) => {
      if (req.url === '/redirect') {
        response.writeHead(307, { location: target.endpoint });
        response.end();
        return;
      }
      await writeSse(response, [
        { type: 'text_delta', delta: 'synthetic' },
        { type: 'done', reason: 'stop' },
      ]);
    });
    const secret = 'SYNTHETIC_TEST_CREDENTIAL_DO_NOT_LOG';
    const records: WireRecord[] = [];
    const bound = { ...connection(server.endpoint), credentialRef: 'UIMORI_PROVIDER_FIXTURE' };
    const input = request();
    input.input.source = { secret, text: `accidental ${secret} inside content` };
    const outcome = await executeProvider(
      bound,
      input,
      options(server.origin, {
        resolveCredential: (name) => {
          expect(name).toBe('UIMORI_PROVIDER_FIXTURE');
          return secret;
        },
        onWire: (record) => {
          records.push(record);
        },
      })
    );
    expect(outcome.status).toBe('completed');
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(records[0].headers.authorization).toBe('[REDACTED]');
    expect(JSON.stringify(bound)).not.toContain(secret);
    expect(
      (await executeProvider(connection(server.endpoint), request(), options(target.origin))).status
    ).toBe('completed');
    const redirect = await executeProvider(
      connection(`${server.origin}/redirect`),
      request(),
      options(server.origin)
    );
    expect(redirect.status).toBe('error');
    expect(redirect.error?.code).toBe('TRANSPORT_ERROR');
    expect(target.requests).toHaveLength(0);
    for (const endpoint of [
      `http://user:password@127.0.0.1:${new URL(server.origin).port}/turn`,
      `${server.endpoint}?api_key=secret`,
      `${server.endpoint}#fragment`,
    ]) {
      expect(() => validateConnection(connection(endpoint))).toThrow('INVALID_ENDPOINT');
    }
    expect(() => validateConnection({ ...bound, headers: { authorization: 'escape' } })).toThrow(
      'UNSUPPORTED_OPTIONS'
    );
    expect(() =>
      validateConnection({ ...bound, credentialRef: 'invalid reference with spaces' })
    ).toThrow('INVALID_CREDENTIAL_REFERENCE');
    expect(() => validateConnection(connection('https://example.com/turn'))).toThrow(
      'FIXTURE_REQUIRES_LOOPBACK'
    );
  });

  test('stored connection settings reach the transport only through the narrowing helper', () => {
    const stored: Connection = {
      id: 'local-fixture',
      revision: 3,
      title: 'Fixture connection',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/turn',
      credentialRef: 'UIMORI_PROVIDER_FIXTURE',
      enabled: true,
      catalog: [],
      catalogError: null,
      catalogUpdatedAt: null,
    };
    expect(() => validateConnection(stored)).toThrow('UNSUPPORTED_OPTIONS');
    const narrowed = transportConnection(stored);
    expect(narrowed).toEqual({
      id: stored.id,
      protocol: stored.protocol,
      endpoint: stored.endpoint,
      credentialRef: stored.credentialRef,
    });
    expect(validateConnection(narrowed)).toEqual(narrowed);
    const { credentialRef: _anonymous, ...withoutCredential } = stored;
    expect(transportConnection(withoutCredential)).not.toHaveProperty('credentialRef');
  });
});

test('native CBS prompt stays frozen across tools after the caller changes its profile', async () => {
  const custom = '  CUSTOM MAIN\r\n{{char}} `verbatim`  ';
  const server = await fixture(async (captured, response) => {
    const body = JSON.parse(captured.body);
    if (!body.input.results.length)
      await writeSse(response, [
        {
          type: 'tool_delta',
          index: 0,
          id: 'custom-read',
          name: 'knowledge.read',
          argumentsDelta: '{"ids":["lore-1"]}',
        },
        { type: 'opaque_state', state: { test: 'custom-continuation' } },
        { type: 'done', reason: 'tool_calls' },
      ]);
    else
      await writeSse(response, [
        { type: 'text_delta', delta: 'Custom scene received.' },
        { type: 'done', reason: 'stop' },
      ]);
  });
  const seed = routedSnapshot(server.endpoint);
  seed.profile!.promptPresets = {
    main: {
      id: 'writing-custom',
      revision: 4,
      role: 'main',
      title: 'Custom writing',
      program: createDefaultRisuPrompt(custom),
    },
  };
  const observed = runnerHooks(server.origin, {
    onInput: () => {
      seed.profile!.promptPresets!.main!.program = createDefaultRisuPrompt('FUTURE PROMPT');
    },
  });
  expect(await runMain(await prepareNativeRisuRun(seed), observed.hooks)).toMatchObject({
    status: 'completed',
    text: 'Custom scene received.',
  });
  expect(server.requests).toHaveLength(2);
  for (const captured of server.requests) {
    const wire = JSON.parse(captured.body);
    expect(wire.stable.contract).toBe(
      '\n' + CONTEXT_RETRIEVAL_GUIDANCE + '\n' + CATALOG_READ_GUIDANCE
    );
    expect(wire.prompt.messages[0].content[0].text).toBe(custom.replace('{{char}}', 'Ada'));
    expect(wire.stable.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'knowledge.search',
      'knowledge.read',
      'skills.list',
      'skills.load',
      'story.search',
      'story.read',
    ]);
    expect(captured.body).not.toContain('FUTURE PROMPT');
  }
  expect(JSON.parse(server.requests[1].body).input.results[0].callId).toBe('custom-read');
});
