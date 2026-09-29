import {
  emptyIllustrationPreset,
  DEFAULT_ILLUSTRATION_PRESET_ID,
} from '../core/illustration-presets.js';
import { illustrationPresetCatalog } from '../server/illustration-presets.js';
import { describeHelperTools, helperToolTraits } from '../server/helper-app-tools.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { HelperWorkspace, helperCallOperationId } from '../server/helper-workspace.js';
import { ChatOverridesStore } from '../server/chat-overrides.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import { chatOverrideHash } from '../core/chat-overrides.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import type { Content } from '../core/product.js';
import type { HelperConversation, HelperTask } from '../core/helper.js';
import type { ToolEvent } from '../core/types.js';
import type { LibraryOrganization } from '../core/library-organization.js';
import * as transport from '../core/transport.js';
import * as modelRunner from '../server/model-runner.js';

const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    const inside = relative(tmpdir(), path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-helper-tools-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function fixture(
  kind: 'chat' | 'library' = 'chat',
  loreText = 'Original shared lore: Q7x-α9.'
) {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-tools-'));
  const app = await createApp({
    dbPath: join(path, 'test.sqlite'),
    buildId: 'helper-tool-contracts',
    testMode: true,
  });
  owned.push({ app, path });
  const store = app.store;
  const connection = store.product.connection({
    title: 'Synthetic helper only',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic helper only',
    connectionId: connection.id,
    modelId: 'fixture-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: { id: model.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  const input = fixtureBotInput('Synthetic lore owner', 'Unchanged shared body');
  input.package.nativeRisu.card.character_book = {
    entries: [
      {
        comment: '항구',
        keys: ['원래 장소 설명'],
        content: loreText,
        constant: true,
        enabled: true,
      },
    ],
  };
  const bot = store.product.content(input) as Content;
  const chat = createFixtureChat(store, 'Synthetic chat', { botId: bot.id });
  const scope =
    kind === 'chat' ? { kind, chatId: chat.id } : { kind, workId: 'helper-tool-contracts' };
  const opened = await app.inject({
    method: 'POST',
    url: '/api/helper/conversations',
    payload: { scope },
  });
  expect(opened.statusCode).toBe(200);
  return {
    app,
    store,
    bot,
    chat,
    conversation: opened.json<HelperConversation>(),
    workspace: new HelperWorkspace(store),
  };
}
const success: transport.ProviderResult = {
  status: 'completed',
  text: '실제 도구 결과를 확인했어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
const asJson = (value: unknown): transport.Json => JSON.parse(JSON.stringify(value));
function call(id: string, name: string, args: Record<string, unknown>): transport.ProviderToolCall {
  return { id, name, arguments: asJson(args) as Record<string, transport.Json> };
}
function calls(...toolCalls: transport.ProviderToolCall[]): transport.ProviderResult {
  return { ...structuredClone(success), status: 'tool_calls', text: '', toolCalls };
}
function mockSend(
  action: (request: transport.ProviderRequest, round: number) => transport.ProviderResult
) {
  let round = 0;
  return vi
    .spyOn(transport, 'executeProvider')
    .mockImplementation(async (connection, request, options) => {
      expect(request.role).toBe('helper');
      transport.validateConnection(connection);
      options.beforeTurn?.();
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: connection.endpoint,
        headers: {},
        body: asJson(request),
        bodySha256: 'synthetic',
        stablePrefixSha256: 'synthetic',
      });
      return action(request, round++);
    });
}
function event(request: transport.ProviderRequest, id: string): ToolEvent {
  const found = (request.input.results as unknown as ToolEvent[]).find(
    (item) => item.callId === id
  );
  expect(found).toBeDefined();
  return found!;
}
function result<T>(request: transport.ProviderRequest, id: string): T {
  const found = event(request, id);
  expect(found.denied, JSON.stringify(found)).toBe(false);
  return found.result as T;
}
async function submit(
  f: Awaited<ReturnType<typeof fixture>>,
  request: string,
  expectedStatus: HelperTask['status'] = 'completed'
) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/helper/conversations/' + f.conversation.id + '/messages',
    payload: { requestKey: randomUUID(), text: request },
  });
  expect(response.statusCode).toBe(200);
  const task = response.json<HelperTask>();
  await vi.waitFor(
    () => expect(['queued', 'running']).not.toContain(f.workspace.task(task.id).status),
    {
      timeout: 3000,
    }
  );
  const completed = f.workspace.task(task.id);
  expect(completed.status, completed.error ?? 'helper task failed').toBe(expectedStatus);
  return completed;
}
function definition(request: transport.ProviderRequest, name: string) {
  expect(request.stable.tools.some((tool) => tool.name === 'app.tools')).toBe(true);
  const tool = describeHelperTools({ names: [name] }).tools[0];
  expect(tool).toBeDefined();
  return tool!.inputSchema;
}

test.each(['generate', 'receipt'] as const)(
  'artifact %s returns a small saved reference and paged reads preserve the full stored scene',
  async (mode) => {
    const f = await fixture();
    const prose = 'A'.repeat(3999) + '😀' + '합성 독립 장면.\n'.repeat(9000);
    const prompt = '독립 장면의 조건. '.repeat(1000);
    const usage = { modelCalls: 1, inputTokens: 10, outputTokens: 4, costUsd: null };
    const generate = vi.spyOn(modelRunner, 'runMain').mockResolvedValue({
      status: 'completed',
      text: prose,
      error: null,
      usage,
    });
    let artifact!: { id: string; revision: number };
    let retry!: { name: string; arguments: Record<string, unknown> };
    mockSend((request, round) => {
      if (round === 0) {
        if (mode === 'receipt') {
          const taskId = String(
            f.store.db.prepare("SELECT id FROM helper_tasks WHERE status='running'").get()!.id
          );
          f.workspace.saveArtifact(
            taskId,
            `${taskId}:${helperCallOperationId(taskId, 'generate')}`,
            prompt,
            prose,
            usage
          );
        }
        return calls(
          call('generate', 'app.call', {
            name: 'artifact.generate',
            arguments: { request: prompt },
          })
        );
      }
      if (round === 1) {
        const saved = result<{ id: string; revision: number }>(request, 'generate');
        artifact = { id: saved.id, revision: saved.revision };
        expect(saved).toMatchObject({
          revision: 1,
          origin: 'model',
          textChars: prose.length,
          usage,
        });
        expect(saved).not.toHaveProperty('text');
        expect(saved).not.toHaveProperty('request');
        expect(JSON.stringify(saved).length).toBeLessThan(1000);
        return calls(call('first', 'app.call', { name: 'artifact.read', arguments: artifact }));
      }
      if (round === 2) {
        expect(result(request, 'first')).toMatchObject({
          field: 'text',
          text: 'A'.repeat(3999),
          range: { start: 0, end: 3999, unit: 'utf16-code-unit' },
          totalChars: prose.length,
          nextOffset: 3999,
        });
        return calls(
          call('emoji', 'app.call', {
            name: 'artifact.read',
            arguments: { ...artifact, offset: 3999, limit: 1 },
          }),
          call('prompt', 'app.call', {
            name: 'artifact.read',
            arguments: { ...artifact, field: 'request', limit: 20 },
          }),
          ...Array.from({ length: 7 }, (_, index) =>
            call(`page-${index}`, 'app.call', {
              name: 'artifact.read',
              arguments: { ...artifact, offset: index * 10000, limit: 10000 },
            })
          )
        );
      }
      if (round === 3) {
        expect(result(request, 'emoji')).toMatchObject({
          text: '😀',
          range: { start: 3999, end: 4001 },
          nextOffset: 4001,
        });
        expect(result(request, 'prompt')).toMatchObject({
          field: 'request',
          text: prompt.slice(0, 20),
          totalChars: prompt.length,
          nextOffset: 20,
        });
        const denied = event(request, 'page-6');
        expect(denied).toMatchObject({ denied: true, result: { error: 'HELPER_READ_TOO_LARGE' } });
        retry = (denied.result as { nextRead: typeof retry }).nextRead;
        expect(retry).toMatchObject({
          name: 'app.call',
          arguments: {
            name: 'artifact.read',
            arguments: { id: artifact.id, revision: 1, offset: 60000, limit: 1000 },
          },
        });
        return calls(call('retry-page', retry.name, retry.arguments));
      }
      expect(result(request, 'retry-page')).toMatchObject({
        text: prose.slice(60000, 61000),
        range: { start: 60000, end: 61000 },
        nextOffset: 61000,
      });
      return structuredClone(success);
    });
    const task = await submit(f, '독립 장면을 만들어 저장하고 필요한 부분만 확인해줘');
    expect(generate).toHaveBeenCalledTimes(mode === 'generate' ? 1 : 0);
    const saved = await f.app.inject({ url: `/api/helper/artifacts/${artifact.id}?revision=1` });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ text: prose, request: prompt });
    expect(
      f.workspace
        .messages(f.conversation.id)
        .find((message) => message.taskId === task.id && message.role === 'assistant')?.artifacts
    ).toEqual([{ id: artifact.id, revision: 1 }]);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_artifacts').get()).toEqual({
      n: 1,
    });
    expect(
      f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
    ).toEqual({ n: 1 });
  }
);

test('targeted chat metadata and rename avoid writing projections while preserving CAS and receipts', async () => {
  const f = await fixture('library');
  const other = createFixtureChat(f.store, 'Other chat', { botId: f.bot.id });
  const projections = vi.spyOn(f.store.product, 'snapshot');
  const appCall = (id: string, name: string, args: Record<string, unknown> = {}) =>
    call(id, 'app.call', { name, arguments: { ...args, chatId: other.id } });
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        appCall('chat', 'chat.read'),
        appCall('lore', 'chat.lore', { action: 'read' }),
        appCall('context', 'context.read')
      );
    if (round === 1) {
      expect(result(request, 'chat')).toMatchObject({ chat: { id: other.id }, messages: [] });
      expect(result<HelperLoreRead>(request, 'lore').items).toHaveLength(1);
      expect(result(request, 'context')).toHaveProperty('notesRevision');
      return calls(
        appCall('rename', 'chat.rename', {
          title: 'Renamed other chat',
          expectedRevision: other.titleRevision ?? 0,
        })
      );
    }
    if (round === 2) {
      expect(result(request, 'rename')).toMatchObject({
        id: other.id,
        title: 'Renamed other chat',
      });
      return calls(
        appCall('stale-rename', 'chat.rename', {
          title: 'Must not overwrite',
          expectedRevision: other.titleRevision ?? 0,
        })
      );
    }
    expect(event(request, 'stale-rename')).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
    });
    return structuredClone(success);
  });
  const task = await submit(f, '다른 채팅의 정보를 확인하고 제목을 바꿔줘');
  expect(f.store.chat(other.id).title).toBe('Renamed other chat');
  expect(f.store.chat(f.chat.id).title).toBe('Synthetic chat');
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 1 });
  expect(projections).not.toHaveBeenCalled();
});

test('targeted story reads and forks use the selected chat ancestry without changing the default scope', async () => {
  const f = await fixture();
  const other = createFixtureChat(f.store, 'Other story', { botId: f.bot.id });
  const source = completedSource(f.store, other.id, 'Only the other story contains this scene.');
  let forkId = '';
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('targeted-read', 'app.call', {
          name: 'story.read',
          arguments: { chatId: other.id, sceneNumber: 1 },
        }),
        call('default-read', 'app.call', { name: 'story.search', arguments: {} })
      );
    if (round === 1) {
      expect(result(request, 'targeted-read')).toMatchObject({ text: source.text });
      expect(JSON.stringify(result(request, 'default-read'))).not.toContain(source.text);
      return calls(
        call('targeted-fork', 'app.call', {
          name: 'chat.fork',
          arguments: { chatId: other.id, sourceId: source.id, title: 'Fork of other story' },
        }),
        call('outside-fork', 'app.call', {
          name: 'chat.fork',
          arguments: { chatId: f.chat.id, sourceId: source.id },
        })
      );
    }
    forkId = result<{ id: string }>(request, 'targeted-fork').id;
    expect(event(request, 'outside-fork')).toMatchObject({
      denied: true,
      result: { code: 'SOURCE_OUTSIDE_SCOPE', outcome: 'unchanged' },
    });
    return structuredClone(success);
  });
  await submit(f, '다른 이야기의 첫 장면을 읽고 그 장면에서 분기해줘');
  const fork = f.store.chat(forkId);
  expect(fork.title).toBe('Fork of other story');
  expect(fork.headRevision).not.toBe(source.id);
  expect(f.store.history(fork.headRevision).map((item) => item.text)).toEqual([source.text]);
  expect(f.store.chat(f.chat.id).headRevision).toBeNull();
});

test('conditional reads remain distinct from writes and the narrower outline review tool set', () => {
  for (const name of ['chat.lore', 'library.organize']) {
    expect(helperToolTraits(name, { action: 'read' })).toMatchObject({
      readOnly: true,
      reviewAllowed: false,
    });
    for (const action of ['patch', 'remove', 'create-folder', 'move', undefined])
      expect(helperToolTraits(name, { action }).readOnly).toBe(false);
  }
  expect(helperToolTraits('unknown.read').readOnly).toBe(false);
  expect(() => describeHelperTools({ names: ['chat.lore'] }, true)).toThrow('UNKNOWN_APP_TOOL');
  expect(describeHelperTools({ names: ['outline.read', 'story.read'] }, true).tools).toHaveLength(
    2
  );
});

test('helper read events retain recoverable argument and missing-scene errors', async () => {
  const f = await fixture();
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('valid-list', 'story.search', {}),
        call('bad-args', 'story.read', { sceneNumber: 1, offset: -1 }),
        call('outside-source', 'story.read', { sceneNumber: 999 }),
        call('bad-catalog', 'app.tools', { names: [] }),
        call('bad-envelope', 'app.call', { name: 'chat.lore', arguments: null }),
        call('missing-reference', 'knowledge.read', { ids: [] })
      );
    expect(event(request, 'valid-list')).toMatchObject({ denied: false });
    expect(event(request, 'bad-args')).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: { code: 'INVALID_ARGUMENTS' },
    });
    expect(event(request, 'outside-source')).toMatchObject({
      denied: true,
      result: { code: 'RESOURCE_UNAVAILABLE' },
    });
    expect(event(request, 'outside-source').errorKind).toBe('recoverable');
    expect(event(request, 'missing-reference')).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: { code: 'INVALID_ARGUMENTS' },
    });
    expect(event(request, 'bad-catalog')).toMatchObject({
      denied: true,
      result: { code: 'INVALID_ARGUMENTS', retryMode: 'correct_arguments', outcome: 'unchanged' },
    });
    expect(event(request, 'bad-envelope')).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: { retryMode: 'correct_arguments', outcome: 'unchanged' },
    });
    // The fixture protocol has no Anthropic continuation. Its supported bootstrap
    // envelope still checks that these exact host events carry the native error flag.
    const encoded = encodeAnthropic({
      ...request,
      input: { ...request.input, results: [] },
      bootstrap: (request.input.results as unknown as ToolEvent[]).map((item) => ({
        callId: item.callId,
        name: item.name,
        args: asJson(item.args) as Record<string, transport.Json>,
        result: asJson(item.result),
        denied: item.denied,
      })),
    }).body as {
      messages: { content: { type: string; tool_use_id?: string; is_error?: boolean }[] }[];
    };
    const returns = encoded.messages
      .flatMap((message) => message.content)
      .filter((item) => item.type === 'tool_result');
    expect(returns.find((item) => item.tool_use_id === 'bad-args')?.is_error).toBe(true);
    expect(returns.find((item) => item.tool_use_id === 'outside-source')?.is_error).toBe(true);
    expect(returns.find((item) => item.tool_use_id === 'valid-list')?.is_error).toBeUndefined();
    return structuredClone(success);
  });
  const task = await submit(f, '현재 원문과 참고 자료를 읽고 설명해줘');
  const stored = f.workspace
    .events(f.conversation.id)
    .filter((item) => item.taskId === task.id && item.kind === 'tool.finished')
    .map((item) => item.data);
  expect(stored).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'story.read', denied: true, errorKind: 'recoverable' }),
      expect.objectContaining({ name: 'knowledge.read', denied: true, errorKind: 'recoverable' }),
    ])
  );
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
});

type HelperLoreRead = {
  revision: number;
  headRevision: string | null;
  profileRevision: number;
  items: {
    scope: { id: string; role: string; modulePath: string[] };
    id: string;
    packageRevision: number;
    fieldHashes: Record<'title' | 'description' | 'text', string>;
  }[];
};
function patchBody(read: HelperLoreRead, value: string) {
  const lore = read.items[0];
  return {
    selector: { ...lore.scope, loreId: lore.id, field: 'text' },
    expectedRevision: read.revision,
    expectedHeadRevision: read.headRevision,
    expectedProfileRevision: read.profileRevision,
    expectedPackageRevision: lore.packageRevision,
    expectedFieldHash: lore.fieldHashes.text,
    value,
  };
}
test('helper discovers original lore hashes, uses them for consecutive chat patches and rejects a fabricated hash', async () => {
  const f = await fixture(),
    original = structuredClone(f.bot);
  let first!: HelperLoreRead, latest!: HelperLoreRead;
  mockSend((request, round) => {
    if (round === 0) {
      expect(definition(request, 'chat.lore')).toMatchObject({
        properties: {
          body: {
            required: ['selector', 'expectedRevision', 'expectedHeadRevision'],
            properties: {
              expectedRevision: { minimum: 0 },
              expectedFieldHash: { pattern: '^[a-f0-9]{64}$' },
              selector: { required: ['id', 'role', 'modulePath', 'loreId', 'field'] },
            },
          },
        },
      });
      return calls(call('lore-first', 'chat.lore', { action: 'read' }));
    }
    if (round === 1) {
      first = result<HelperLoreRead>(request, 'lore-first');
      const lore = original.package!.lore[0];
      expect(first.items[0].fieldHashes).toEqual({
        title: chatOverrideHash(lore.title),
        description: chatOverrideHash(lore.description),
        text: chatOverrideHash(lore.text),
      });
      return calls(
        call('patch-first', 'chat.lore', {
          action: 'patch',
          body: patchBody(first, 'Chat override one'),
        })
      );
    }
    if (round === 2) {
      expect(result(request, 'patch-first')).toMatchObject({ revision: first.revision + 1 });
      return calls(call('lore-second', 'chat.lore', { action: 'read' }));
    }
    if (round === 3) {
      latest = result<HelperLoreRead>(request, 'lore-second');
      expect(latest.items[0].fieldHashes).toEqual(first.items[0].fieldHashes);
      expect(latest.items[0]).not.toHaveProperty('text');
      return calls(
        call('patch-second', 'chat.lore', {
          action: 'patch',
          body: patchBody(latest, 'Chat override two'),
        })
      );
    }
    if (round === 4) {
      const saved = result<{ revision: number }>(request, 'patch-second');
      latest = { ...latest, revision: saved.revision };
      return calls(
        call('bad-hash', 'chat.lore', {
          action: 'patch',
          body: {
            ...patchBody(latest, 'Must never be applied'),
            expectedFieldHash: '0'.repeat(64),
          },
        })
      );
    }
    expect(event(request, 'bad-hash')).toMatchObject({
      denied: true,
      result: {
        error: '원본 로어 필드가 변경됐어요.',
        retryMode: 'refresh_then_retry',
        outcome: 'unchanged',
      },
    });
    return structuredClone(success);
  });
  await submit(f, '이 채팅의 로어를 두 단계로 수정해줘');
  const state = new ChatOverridesStore(f.store).get(f.chat.id);
  expect(state.revision).toBe(first.revision + 2);
  expect(state.overrides).toHaveLength(1);
  expect(state.overrides[0]).toMatchObject({
    value: 'Chat override two',
    baseHash: first.items[0].fieldHashes.text,
  });
  expect(f.store.product.get('content', f.bot.id)).toEqual(original);
});

test('long chat lore stays paged through helper reads and saves with original field guards', async () => {
  const authored = 'Long original: ' + '\n"\\💫'.repeat(10_000);
  const f = await fixture('chat', authored);
  let selector!: Record<string, unknown>;
  mockSend((request, round) => {
    if (round === 0) return calls(call('list', 'chat.lore', { action: 'read', limit: 1 }));
    if (round === 1) {
      const overview = result<HelperLoreRead>(request, 'list');
      expect(JSON.stringify(overview).length).toBeLessThan(24000);
      expect(overview.items[0]).not.toHaveProperty('text');
      selector = { ...overview.items[0].scope, loreId: overview.items[0].id, field: 'text' };
      return calls(
        call('field', 'chat.lore', {
          action: 'read',
          selector,
          textOffset: 100,
          textLimit: 10000,
        })
      );
    }
    if (round === 2) {
      const read = result<any>(request, 'field');
      expect(JSON.stringify(read).length).toBeLessThanOrEqual(24000);
      expect(read.original.text).toBe(
        authored.slice(read.original.offset, read.original.nextOffset)
      );
      expect(read.original.nextOffset).toBeGreaterThan(read.original.offset);
      expect(read.expectedFieldHash).toBe(chatOverrideHash(authored));
      expect(read.override).toBeNull();
      const {
        expectedRevision,
        expectedHeadRevision,
        expectedProfileRevision,
        expectedPackageRevision,
        expectedFieldHash,
      } = read;
      return calls(
        call('save', 'chat.lore', {
          action: 'patch',
          body: {
            selector,
            expectedRevision,
            expectedHeadRevision,
            expectedProfileRevision,
            expectedPackageRevision,
            expectedFieldHash,
            value: 'Only this chat changes.',
          },
        })
      );
    }
    if (round === 3) {
      expect(JSON.stringify(result(request, 'save')).length).toBeLessThan(1000);
      return calls(call('verify', 'chat.lore', { action: 'read', selector, textLimit: 100 }));
    }
    expect(result(request, 'verify')).toMatchObject({
      original: { text: authored.slice(0, 100), totalChars: authored.length },
      override: { text: 'Only this chat changes.', nextOffset: null, conflicts: [] },
      expectedFieldHash: chatOverrideHash(authored),
    });
    return structuredClone(success);
  });
  await submit(f, '지정한 로어를 이 채팅에서만 수정해줘');
  expect(f.store.product.get<Content>('content', f.bot.id).package.lore[0].text).toBe(authored);
  expect(new ChatOverridesStore(f.store).get(f.chat.id).overrides[0].value).toBe(
    'Only this chat changes.'
  );
});

test('helper discovers and retires an override after its shared lore was removed', async () => {
  const f = await fixture();
  const service = new ChatOverridesStore(f.store);
  const initial = service.get(f.chat.id);
  const attachment = initial.attachments[0];
  const lore = attachment.lore[0];
  const selector = { ...attachment.scope, loreId: lore.id, field: 'text' };
  const localText = 'Retained local lore. '.repeat(1600);
  const saved = service.patch(
    f.chat.id,
    {
      selector,
      expectedRevision: initial.revision,
      expectedHeadRevision: initial.headRevision,
      expectedProfileRevision: initial.profileRevision,
      expectedPackageRevision: attachment.packageRevision,
      expectedFieldHash: chatOverrideHash(lore.text),
      value: localText,
      operationId: randomUUID(),
    },
    'synthetic-prior-edit'
  );
  invokeResourceTool(f.store, 'resource.patch', {
    kind: 'content',
    id: f.bot.id,
    expectedRevision: f.bot.revision,
    changes: [{ path: '/package/nativeRisu/card/character_book/entries/0', op: 'remove' }],
  });
  const shared = f.store.product.get<Content>('content', f.bot.id);
  expect(shared.package.lore).toEqual([]);
  expect(service.get(f.chat.id).conflicts).toMatchObject([{ kind: 'entry-missing' }]);
  const appCall = (id: string, args: Record<string, unknown>) =>
    call(id, 'app.call', { name: 'chat.lore', arguments: args });
  mockSend((request, round) => {
    if (round === 0) return calls(appCall('list', { action: 'read', limit: 1 }));
    if (round === 1) {
      const list = result<any>(request, 'list');
      expect(JSON.stringify(list).length).toBeLessThanOrEqual(24000);
      expect(list).toMatchObject({
        total: 1,
        nextOffset: null,
        items: [
          {
            selector,
            originalMissing: true,
            overrideId: saved.entry.id,
            conflicts: ['entry-missing'],
          },
        ],
      });
      return calls(appCall('read', { action: 'read', selector: list.items[0].selector }));
    }
    if (round === 2) {
      const read = result<any>(request, 'read');
      expect(JSON.stringify(read).length).toBeLessThanOrEqual(24000);
      expect(read).toMatchObject({
        original: null,
        override: {
          id: saved.entry.id,
          totalChars: localText.length,
          conflicts: ['entry-missing'],
        },
      });
      expect(read.override.nextOffset).toBeGreaterThan(0);
      expect(read.override.text).toBe(localText.slice(0, read.override.nextOffset));
      expect(read).not.toHaveProperty('expectedProfileRevision');
      expect(read).not.toHaveProperty('expectedPackageRevision');
      expect(read).not.toHaveProperty('expectedFieldHash');
      return calls(
        appCall('remove', {
          action: 'remove',
          body: {
            selector: read.selector,
            expectedRevision: read.expectedRevision,
            expectedHeadRevision: read.expectedHeadRevision,
          },
        })
      );
    }
    expect(result(request, 'remove')).toMatchObject({
      revision: saved.revision + 1,
      selector,
      retired: true,
    });
    return structuredClone(success);
  });
  await submit(f, '원본 로어가 없어진 채팅 전용 변경을 찾아 제거해줘');
  expect(service.get(f.chat.id).overrides).toEqual([]);
  expect(f.store.product.get('content', f.bot.id)).toEqual(shared);
});

test('notes schema exposes CAS but keeps mutation identity host-owned', async () => {
  const f = await fixture();
  let expectedRevision = 0;
  mockSend((request, round) => {
    if (round === 0) {
      const schema = definition(request, 'notes.write') as Record<string, any>;
      expect(schema).toMatchObject({
        required: ['body'],
        properties: {
          body: {
            required: ['expectedRevision'],
            additionalProperties: false,
            properties: { expectedRevision: { minimum: 0 }, text: { maxLength: 32000 } },
          },
        },
      });
      expect(schema.properties).not.toHaveProperty('operationId');
      return calls(call('notes-context', 'context.read', {}));
    }
    if (round === 1) {
      expectedRevision = result<{ notesRevision: number }>(request, 'notes-context').notesRevision;
      return calls(
        call('note-create', 'notes.write', {
          body: { expectedRevision, text: 'USER_CORRECTION: witness=Mira; code=Q7x-α9.' },
        })
      );
    }
    expect(result(request, 'note-create')).toMatchObject({
      revision: expectedRevision + 1,
      note: {
        atRevision: null,
        atHash: null,
        declaration: { author: '사용자 도우미 요청' },
      },
    });
    return structuredClone(success);
  });
  await submit(f, '메모를 저장해줘');
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM author_notes').get()).toEqual({ n: 1 });
});

test('resource schemas expose scoped reads and typed native patches without a model-owned identity', async () => {
  const f = await fixture('library');
  mockSend((request) => {
    const read = definition(request, 'resource.read') as Record<string, any>;
    const patch = definition(request, 'resource.patch') as Record<string, any>;
    expect(read).toMatchObject({
      required: ['kind', 'id'],
      properties: {
        path: { type: 'string' },
        textOffset: { type: 'integer', minimum: 0 },
        textLimit: { type: 'integer', minimum: 1, maximum: 10000 },
      },
    });
    expect(patch).toMatchObject({
      required: ['kind', 'id', 'expectedRevision', 'changes'],
      properties: {
        changes: {
          minItems: 1,
          items: { properties: { op: { enum: ['set', 'replaceText', 'insert', 'remove'] } } },
        },
      },
    });
    expect(patch.properties).not.toHaveProperty('operationId');
    return structuredClone(success);
  });
  await submit(f, '현재 자료를 고치는 도구 형식을 확인해줘');
});

test('library schema exposes folder CAS and item identity for a discovered read-create-move flow', async () => {
  const f = await fixture('library');
  mockSend((request, round) => {
    if (round === 0) {
      const organizationSchema = definition(request, 'library.organize') as Record<string, any>;
      expect(organizationSchema).toMatchObject({
        properties: {
          body: {
            required: ['expectedRevision', 'category'],
            properties: {
              expectedRevision: { minimum: 1 },
              items: { items: { required: ['kind', 'id'] } },
              folderId: { type: ['string', 'null'] },
            },
          },
        },
      });
      expect(organizationSchema.properties).not.toHaveProperty('operationId');
      return calls(call('organization', 'library.organize', { action: 'read' }));
    }
    if (round === 1) {
      const organization = result<LibraryOrganization>(request, 'organization');
      return calls(
        call('create-folder', 'library.organize', {
          action: 'create-folder',
          body: { expectedRevision: organization.revision, category: 'bot', title: '검토 중' },
        })
      );
    }
    if (round === 2) {
      const organization = result<LibraryOrganization>(request, 'create-folder');
      const folder = organization.folders.find((item) => item.title === '검토 중')!;
      const item = organization.items.find((item) => item.id === f.bot.id)!;
      return calls(
        call('move-item', 'library.organize', {
          action: 'move',
          body: {
            expectedRevision: organization.revision,
            category: 'bot',
            folderId: folder.id,
            items: [{ kind: item.kind, id: item.id }],
          },
        })
      );
    }
    const organization = result<LibraryOrganization>(request, 'move-item');
    expect(organization.items.find((item) => item.id === f.bot.id)?.folderId).toBe(
      organization.folders[0].id
    );
    return structuredClone(success);
  });
  await submit(f, '서재에 폴더를 만들어줘. 그 폴더로 자료를 이동해줘');
  expect(f.store.libraryOrganization.snapshot().folders).toHaveLength(1);
});

test('app.call supplies distinct host identities without polluting model arguments', async () => {
  const f = await fixture();
  const writes = vi.spyOn(f.store.story.notes, 'write');
  const firstArgs = {
    name: 'notes.write',
    arguments: { body: { expectedRevision: 0, text: 'First note.' } },
  };
  mockSend((request, round) => {
    if (round === 0) return calls(call('note-first', 'app.call', firstArgs));
    const first = result<{ revision: number }>(request, 'note-first');
    expect(event(request, 'note-first').args).toEqual(firstArgs);
    if (round === 1)
      return calls(
        call('note-second', 'app.call', {
          name: 'notes.write',
          arguments: { body: { expectedRevision: first.revision, text: 'Second note.' } },
        })
      );
    expect(result<{ revision: number }>(request, 'note-second').revision).toBe(first.revision + 1);
    expect(JSON.stringify(request.input.results)).not.toContain('operationId');
    return structuredClone(success);
  });
  const task = await submit(f, '서로 다른 메모 두 개를 저장해줘');
  expect(writes).toHaveBeenCalledTimes(2);
  const keys = writes.mock.calls.map(
    ([, body]) => (body as { idempotencyKey: string }).idempotencyKey
  );
  expect(new Set(keys).size).toBe(2);
  for (const key of keys) expect(key).toContain(task.id);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM author_notes').get()).toEqual({ n: 2 });
});

test('resource patches leave real receipts so a later failure cannot offer a duplicate retry', async () => {
  const f = await fixture('library');
  const title = 'Saved before provider failure';
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('patch-real', 'app.call', {
          name: 'resource.patch',
          arguments: {
            kind: 'content',
            id: f.bot.id,
            expectedRevision: f.bot.revision,
            changes: [{ path: '/package/nativeRisu/card/name', op: 'set', value: title }],
          },
        })
      );
    expect(result(request, 'patch-real')).toMatchObject({
      id: f.bot.id,
      revision: f.bot.revision + 1,
    });
    return {
      ...structuredClone(success),
      status: 'error',
      text: '',
      error: { code: 'UNEXPECTED_EOF' },
    };
  });
  const request = '자료 이름을 바꾸고 저장해줘';
  const task = await submit(f, request, 'failed');
  expect(task.completedEffects?.count).toBe(1);
  expect(f.store.product.get<Content>('content', f.bot.id)).toMatchObject({
    title,
    revision: f.bot.revision + 1,
  });
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 1 });
  const retry = await f.app.inject({
    method: 'POST',
    url: '/api/helper/conversations/' + f.conversation.id + '/messages',
    payload: { requestKey: randomUUID(), text: request, retryOf: task.id },
  });
  expect(retry.statusCode).toBe(409);
  expect(retry.body).toContain('HELPER_EFFECTS_ALREADY_COMMITTED');
});

test('helper app gateway discovers and authors illustration presets without selecting or generating them', async () => {
  const f = await fixture('library');
  let savedId = '';
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('list', 'app.call', { name: 'illustration-preset.list', arguments: {} }),
        call('guide', 'app.call', { name: 'illustration-preset.guide', arguments: {} })
      );
    if (round === 1) {
      expect(result<{ presets: unknown[] }>(request, 'list').presets).toHaveLength(1);
      expect(result<{ example: unknown }>(request, 'guide').example).toEqual(
        emptyIllustrationPreset()
      );
      return calls(
        call('save', 'app.call', {
          name: 'resource.save',
          arguments: {
            kind: 'illustration-preset',
            model: { ...emptyIllustrationPreset('도우미 수채화'), styleGuidance: 'watercolor' },
          },
        })
      );
    }
    savedId = result<{ id: string }>(request, 'save').id;
    return structuredClone(success);
  });
  const task = await submit(
    f,
    '수채화 삽화 프리셋을 새로 만들어 저장해줘. 적용하거나 이미지를 생성하지는 마.'
  );
  const catalog = illustrationPresetCatalog(f.store);
  expect(catalog.presets.find((item) => item.id === savedId)).toMatchObject({
    title: '도우미 수채화',
    styleGuidance: 'watercolor',
  });
  expect(catalog.preferences.defaultPresetId).toBe(DEFAULT_ILLUSTRATION_PRESET_ID);
  expect(f.store.db.prepare('SELECT count(*) n FROM illustration_jobs').get()?.n).toBe(0);
  expect(
    f.store.db.prepare('SELECT count(*) n FROM helper_operations WHERE task_id=?').get(task.id)?.n
  ).toBe(1);
  expect(
    f.workspace
      .events(f.conversation.id)
      .some((event) => event.kind === 'illustration-preset.updated')
  ).toBe(true);
});

test('helper gateway follows browse results into an exact reference read without adding native tools or saving', async () => {
  const f = await fixture();
  mockSend((request, round) => {
    expect(request.stable.tools.map((tool) => tool.name)).toEqual([
      'data.search',
      'data.read',
      'db.query',
      'app.tools',
      'app.call',
    ]);
    if (round === 0)
      return calls(
        call('browse-0', 'app.call', { name: 'knowledge.search', arguments: { mode: 'browse' } })
      );
    const page = result<any>(request, `browse-${round - 1}`);
    if (round === 3) {
      expect(page.items[0].read.text).toBe('Original shared lore: Q7x-α9.');
      return structuredClone(success);
    }
    expect(page.coverage.content).toBe('metadata-only');
    const selected =
      round === 1
        ? page.items.find((item: any) => item.type === 'package')
        : page.items.find((item: any) => item.id?.includes(':lore:'));
    return calls(call(`browse-${round}`, 'app.call', selected.nextRead));
  });
  const task = await submit(f, '현재 자료 분류를 따라 항구의 원문을 확인해줘');
  const names = f.workspace
    .events(f.conversation.id)
    .filter((item) => item.taskId === task.id && item.kind === 'tool.finished')
    .map((item) => (item.data as { name: string }).name);
  expect(names).toEqual(['knowledge.search', 'knowledge.search', 'knowledge.read']);
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 0 });
});
