import { countTextTokens } from '../core/text-tokens.js';
import {
  emptyIllustrationPreset,
  DEFAULT_ILLUSTRATION_PRESET_ID,
} from '../core/illustration-presets.js';
import { illustrationPresetCatalog } from '../server/illustration-presets.js';
import {
  illustrationJob,
  illustrationReferences,
  illustrationsForChat,
  updateIllustrationReferences,
  updateIllustrationSettings,
} from '../server/illustrations.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { describeHelperTools, helperToolTraits } from '../server/helper-app-tools.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { ChatOverridesStore } from '../server/chat-overrides.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { completedSource, fixtureSettings, PNG_BASE64 } from './fixtures/illustration.js';
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
  expectedStatus: HelperTask['status'] = 'completed',
  requestKey = randomUUID()
) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/helper/conversations/' + f.conversation.id + '/messages',
    payload: { requestKey, text: request },
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

test.each(['resource.read', 'chat.lore'] as const)(
  '%s preserves requested pages when the selected model has room for the complete round',
  async (name) => {
    // Dense multilingual pages exceed the former 32k round cap together.
    const prose = '한글漢字 설정 記録 경계 '.repeat(6000);
    const f = await fixture('library', prose);
    const attachment = new ChatOverridesStore(f.store).get(f.chat.id).attachments[0];
    const selector = { ...attachment.scope, loreId: attachment.lore[0].id, field: 'text' };
    const args =
      name === 'resource.read'
        ? {
            kind: 'content',
            id: f.bot.id,
            path: '/package/nativeRisu/card/character_book/entries/0/content',
            textOffset: 37,
            textLimit: 10000,
          }
        : { chatId: f.chat.id, action: 'read', selector, textOffset: 37, textLimit: 10000 };
    mockSend((request, round) => {
      if (round === 0)
        return calls(
          ...Array.from({ length: 7 }, (_, index) =>
            call(`page-${index}`, 'app.call', { name, arguments: args })
          )
        );
      expect(round).toBe(1);
      expect((request.input.results as unknown as ToolEvent[]).every((item) => !item.denied)).toBe(
        true
      );
      expect(result(request, 'page-6')).toMatchObject(
        name === 'resource.read'
          ? {
              id: f.bot.id,
              revision: f.bot.revision,
              path: args.path,
              text: prose.slice(37, 10037),
              textOffset: 37,
              nextOffset: 10037,
            }
          : {
              chatId: f.chat.id,
              selector,
              original: { text: prose.slice(37, 10037), offset: 37, nextOffset: 10037 },
            }
      );
      return structuredClone(success);
    });
    await submit(f, '큰 자료에서 읽지 못한 범위를 이어서 확인해줘');
  }
);

test('retired artifact writes are unavailable while historical revisions remain readable', async () => {
  const f = await fixture();
  const prose = 'A'.repeat(3999) + '😀' + '합성 독립 장면.\n'.repeat(9000);
  const prompt = '독립 장면의 조건. '.repeat(1000);
  const usage = { modelCalls: 1, inputTokens: 10, outputTokens: 4, costUsd: null };
  const generate = vi.spyOn(modelRunner, 'runMain');
  const historical = f.workspace.enqueue(
    f.conversation.id,
    'historical-artifact',
    'Original draft',
    {
      scope: f.conversation.scope,
      model: f.store.product.modelSnapshot(modelWorkspace(f.store).helperModel!.id),
      history: [],
      persona: '',
      limits: { totalCalls: 24, helperCalls: 12 },
    }
  );
  f.workspace.start(historical.id, 'history');
  f.workspace.finish(historical.id, 'history', 1, 'completed', 'A saved scene', null);
  const artifact = { id: randomUUID(), revision: 1 };
  const insert = f.store.db.prepare('INSERT INTO helper_artifacts VALUES(?,?,?,?,?,?,?,?,?)');
  insert.run(
    artifact.id,
    1,
    f.conversation.id,
    historical.id,
    prompt,
    prose,
    JSON.stringify(usage),
    historical.createdAt,
    'model'
  );
  insert.run(
    artifact.id,
    2,
    f.conversation.id,
    historical.id,
    prompt,
    'A historical edit.',
    JSON.stringify(usage),
    historical.createdAt,
    'edit'
  );
  f.store.db
    .prepare("UPDATE helper_messages SET artifacts=? WHERE task_id=? AND role='assistant'")
    .run(JSON.stringify([artifact]), historical.id);
  const legacyJob = randomUUID(),
    legacySnapshot = '{"legacy":"unmodified"}';
  f.store.db
    .prepare("INSERT INTO helper_artifact_jobs VALUES(?,?,?,?,'running',NULL,NULL,NULL,?)")
    .run(legacyJob, historical.id, 'legacy-job', legacySnapshot, historical.createdAt);
  f.workspace.interrupt();
  expect(
    f.store.db.prepare('SELECT status,snapshot FROM helper_artifact_jobs WHERE id=?').get(legacyJob)
  ).toEqual({ status: 'interrupted', snapshot: legacySnapshot });
  expect(() => describeHelperTools({ names: ['artifact.generate'] })).toThrow('UNKNOWN_APP_TOOL');
  expect(describeHelperTools({ names: ['artifact.read'] }).tools[0].name).toBe('artifact.read');
  const patch = await f.app.inject({
    method: 'PATCH',
    url: '/api/helper/artifacts/' + artifact.id,
    payload: { expectedRevision: 2, text: 'Must not save', requestKey: 'retired-edit' },
  });
  expect(patch.statusCode).toBe(404);
  mockSend((request, round) => {
    if (round === 0) {
      return calls(
        call('generate', 'app.call', {
          name: 'artifact.generate',
          arguments: { request: prompt },
        })
      );
    }
    if (round === 1) {
      expect(event(request, 'generate')).toMatchObject({
        denied: true,
        result: { error: 'UNKNOWN_APP_TOOL' },
      });
      return calls(call('first', 'app.call', { name: 'artifact.read', arguments: artifact }));
    }
    if (round === 2) {
      const first = result<{ text: string; nextOffset: number }>(request, 'first');
      expect(first).toMatchObject({
        field: 'text',
        range: { start: 0, end: first.nextOffset, unit: 'utf16-code-unit' },
        totalChars: prose.length,
      });
      expect(first.nextOffset).toBeGreaterThan(3999);
      expect(first.text).toBe(prose.slice(0, first.nextOffset));
      expect(countTextTokens(first.text)).toBeLessThanOrEqual(2000);
      expect(new TextDecoder().decode(new TextEncoder().encode(first.text))).toBe(first.text);
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
      expect(event(request, 'page-6')).toMatchObject({
        denied: false,
        result: {
          text: prose.slice(60000, 70000),
          range: { start: 60000, end: 70000 },
          nextOffset: 70000,
        },
      });
      return structuredClone(success);
    }
    throw new Error('Unexpected reread');
  });
  const task = await submit(f, '이전 가정 장면을 읽고 생성을 재시도하지 마세요.');
  expect(generate).not.toHaveBeenCalled();
  const saved = await f.app.inject({ url: `/api/helper/artifacts/${artifact.id}?revision=1` });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ text: prose, request: prompt });
  expect(
    f.workspace
      .messages(f.conversation.id)
      .find((message) => message.taskId === historical.id && message.role === 'assistant')
      ?.artifacts
  ).toEqual([{ id: artifact.id, revision: 1 }]);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_artifacts').get()).toEqual({
    n: 2,
  });
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 0 });
});

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
  const readers = ['data.search', 'data.read', 'db.query'];
  for (const review of [false, true]) {
    expect(describeHelperTools({ names: readers }, review).tools.map((tool) => tool.name)).toEqual(
      readers
    );
    expect(() => describeHelperTools({ names: ['data.exec'] }, review)).toThrow('UNKNOWN_APP_TOOL');
  }
  expect(() => describeHelperTools({ names: ['chat.lore'] }, true)).toThrow('UNKNOWN_APP_TOOL');
  expect(describeHelperTools({ names: ['outline.read', 'story.read'] }, true).tools).toHaveLength(
    2
  );
});

test('discovery uses current scope to break relevance ties without hiding explicit operations', () => {
  const library = describeHelperTools({ query: 'shared appearance' }, false, 'library');
  const chat = describeHelperTools({ query: 'shared appearance' }, false, 'chat');
  if (!('total' in library) || !('total' in chat)) throw new Error('Expected catalog');
  expect(library.tools.slice(0, 2).map((tool) => tool.name)).toEqual([
    'resource.read',
    'resource.patch',
  ]);
  expect(chat.tools.slice(0, 2).map((tool) => tool.name)).toEqual([
    'illustration.profiles.read',
    'illustration.profiles.save',
  ]);
  expect(
    describeHelperTools({ names: ['illustration.profiles.read'] }, false, 'library').tools
  ).toHaveLength(1);
});

test('discovery keeps shared and chat-local profiles searchable in English and Korean', () => {
  for (const query of ['library profile', 'shared profiles', '기본 외형', '라이브러리 프로필']) {
    const result = describeHelperTools({ query }, false, 'library');
    expect(result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['resource.read', 'resource.patch'])
    );
  }
  expect(
    describeHelperTools({ query: '채팅 프로필' }, false, 'chat').tools.map((tool) => tool.name)
  ).toEqual(['illustration.profiles.read', 'illustration.profiles.save']);
  expect(() => describeHelperTools({ names: ['프로필'] })).toThrow('UNKNOWN_APP_TOOL');
});

test('discovery ranks operation names before scope and returns exact schemas for the top three matches', () => {
  const settings = describeHelperTools({ query: 'settings' }, false, 'library');
  expect(settings.tools.slice(0, 2).map((tool) => tool.name)).toEqual([
    'settings.read',
    'settings.update',
  ]);
  const exact = describeHelperTools({ query: 'illustration.profiles.read' }, false, 'library');
  expect(exact.tools[0]?.name).toBe('illustration.profiles.read');

  const query = describeHelperTools({ query: 'appearanceProfiles' }, false, 'library');
  expect(query.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['resource.read', 'resource.patch'])
  );
  expect(query.tools.length).toBeGreaterThan(3);
  for (const [index, tool] of query.tools.entries()) {
    if (index < 3)
      expect(tool).toMatchObject(describeHelperTools({ names: [tool.name] }).tools[0]!);
    else expect(tool).not.toHaveProperty('inputSchema');
  }
  const later = describeHelperTools({ query: 'appearanceProfiles', offset: 3 });
  expect(later.tools.length).toBeGreaterThan(0);
  for (const tool of later.tools) expect(tool).not.toHaveProperty('inputSchema');
  for (const tool of describeHelperTools({}).tools) expect(tool).not.toHaveProperty('inputSchema');
});

test('the full helper catalog includes actionable metadata and ranks exact operations', () => {
  const seen = new Map<string, { required: string[]; effect: string; description: string }>();
  let offset = 0;
  for (;;) {
    const page = describeHelperTools({ offset }, false, 'library');
    if (!('nextOffset' in page)) throw new Error('Expected catalog');
    for (const tool of page.tools) {
      expect(seen.has(tool.name)).toBe(false);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(['read', 'write', 'mixed']).toContain(tool.effect);
      seen.set(tool.name, tool);
    }
    if (page.nextOffset === null) {
      expect(seen.size).toBe(page.total);
      break;
    }
    offset = page.nextOffset;
  }
  expect(seen.get('resource.patch')).toMatchObject({
    effect: 'write',
    required: ['kind', 'id', 'expectedRevision', 'changes'],
  });
  expect(seen.get('chat.lore')).toMatchObject({ effect: 'mixed', required: ['action'] });
  expect(seen.get('task.inspect')).toMatchObject({ effect: 'read', required: ['kind', 'id'] });
  const query = describeHelperTools({ query: 'generate illustration' }, false, 'chat');
  if (!('total' in query)) throw new Error('Expected ranked catalog');
  expect(query.tools[0]?.name).toBe('illustration.generate');
});

test('chat discovery and scene indexes stay compact and follow nextOffset', async () => {
  const f = await fixture('chat');
  for (let index = 0; index < 3; index++)
    createFixtureChat(f.store, `Paginated catalog ${index}`, { botId: f.bot.id });
  for (let index = 0; index < 3; index++)
    completedSource(f.store, f.chat.id, `An original scene ${index}`);
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('first-chats', 'chat.list', { query: 'Paginated catalog', limit: 2 }),
        call('scene-page', 'chat.read', { offset: 1, limit: 1, includePreview: true })
      );
    if (round === 1) {
      const first = result<{
        chats: { id: string; title: string; settings?: unknown }[];
        total: number;
        nextOffset: number;
      }>(request, 'first-chats');
      expect(first).toMatchObject({ total: 3, nextOffset: 2 });
      expect(first.chats).toHaveLength(2);
      expect(first.chats[0]).not.toHaveProperty('settings');
      expect(result(request, 'scene-page')).toMatchObject({
        total: 3,
        nextOffset: 2,
        messages: [expect.objectContaining({ sceneNumber: 2, preview: 'An original scene 1' })],
      });
      return calls(
        call('last-chats', 'chat.list', {
          query: 'Paginated catalog',
          offset: first.nextOffset,
          limit: 2,
        })
      );
    }
    expect(result(request, 'last-chats')).toMatchObject({ total: 3, nextOffset: null });
    return success;
  });
  await submit(f, 'Inspect the second story scene and find paged chats.');
});

test('library chat-only tools explain how to select a chat instead of telling the model to stop', async () => {
  const f = await fixture('library');
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('chat-read', 'chat.read', {}),
        call('scene-read', 'scene.read', { sourceId: 'scene', target: 'original' })
      );
    for (const id of ['chat-read', 'scene-read'])
      expect(event(request, id)).toMatchObject({
        denied: true,
        errorKind: 'recoverable',
        result: {
          code: 'CHAT_SCOPE_REQUIRED',
          retryMode: 'correct_arguments',
          outcome: 'unchanged',
          nextAction: { tool: 'chat.list' },
        },
      });
    return success;
  });
  await submit(f, 'Inspect a chat from the library scope.');
});

test('library appearance profiles return a specific switch-tool recovery', async () => {
  const f = await fixture('library');
  mockSend((request, round) => {
    if (round === 0) return calls(call('wrong-scope', 'illustration.profiles.read', {}));
    expect(event(request, 'wrong-scope')).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: {
        code: 'ILLUSTRATION_PROFILE_CHAT_ONLY',
        retryMode: 'switch_tool',
        outcome: 'unchanged',
        nextAction: { tool: 'resource.read' },
      },
    });
    return success;
  });
  await submit(f, 'Inspect shared appearance without finding a chat.');
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
      expect(countTextTokens(JSON.stringify(overview))).toBeLessThan(12000);
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
      expect(countTextTokens(JSON.stringify(read))).toBeLessThanOrEqual(12000);
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
      expect(countTextTokens(JSON.stringify(list))).toBeLessThanOrEqual(12000);
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
      expect(countTextTokens(JSON.stringify(read))).toBeLessThanOrEqual(12000);
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

test('patch failures identify exact change and batch item without treating text mismatch as a stale revision', async () => {
  const f = await fixture('library');
  const other = f.store.product.content(fixtureBotInput('Other', 'same same')) as Content;
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('missing-literal', 'app.call', {
          name: 'resource.patch',
          arguments: {
            kind: 'content',
            id: f.bot.id,
            expectedRevision: f.bot.revision,
            changes: [
              { op: 'set', path: '/package/nativeRisu/card/name', value: 'Must roll back' },
              {
                op: 'replaceText',
                path: '/package/nativeRisu/card/description',
                oldText: 'Missing literal',
                newText: 'replacement',
              },
            ],
          },
        }),
        call('ambiguous-batch', 'app.call', {
          name: 'resource.patchMany',
          arguments: {
            items: [
              {
                kind: 'content',
                id: f.bot.id,
                expectedRevision: f.bot.revision,
                changes: [
                  { op: 'set', path: '/package/nativeRisu/card/name', value: 'Also roll back' },
                ],
              },
              {
                kind: 'content',
                id: other.id,
                expectedRevision: other.revision,
                changes: [
                  {
                    op: 'replaceText',
                    path: '/package/nativeRisu/card/description',
                    oldText: 'same',
                    newText: 'one',
                  },
                ],
              },
            ],
          },
        })
      );
    expect(event(request, 'missing-literal')).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: {
        code: 'PATCH_TEXT_NOT_FOUND',
        retryMode: 'correct_arguments',
        outcome: 'unchanged',
        details: { changeIndex: 1, path: '/package/nativeRisu/card/description', matchCount: 0 },
      },
    });
    expect(event(request, 'ambiguous-batch')).toMatchObject({
      denied: true,
      result: {
        code: 'PATCH_TEXT_AMBIGUOUS',
        retryMode: 'correct_arguments',
        outcome: 'unchanged',
        details: { itemIndex: 1, id: other.id, changeIndex: 0, matchCount: 2 },
      },
    });
    return structuredClone(success);
  });
  await submit(f, '자료의 문구를 수정해줘');
  expect(f.store.product.get('content', f.bot.id)).toEqual(f.bot);
  expect(f.store.product.get('content', other.id)).toEqual(other);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM resource_undo').get()).toEqual({ n: 0 });
});

test('invalid native batch input rolls back and can be corrected in the same helper task', async () => {
  const f = await fixture('library');
  const other = f.store.product.content(fixtureBotInput('Other')) as Content;
  const items = (target: string) => [
    {
      kind: 'content',
      id: f.bot.id,
      expectedRevision: f.bot.revision,
      changes: [{ op: 'set', path: '/package/nativeRisu/card/name', value: 'Renamed' }],
    },
    {
      kind: 'content',
      id: other.id,
      expectedRevision: other.revision,
      changes: [
        {
          op: 'set',
          path: '/package/nativeRisu/card/extensions/uimori/translationGuide',
          value: { instructions: '', terms: [{ source: 'Rose', target }] },
        },
      ],
    },
  ];
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('invalid-guide', 'app.call', {
          name: 'resource.patchMany',
          arguments: { items: items('') },
        })
      );
    if (round === 1) {
      expect(event(request, 'invalid-guide')).toMatchObject({
        denied: true,
        errorKind: 'recoverable',
        result: {
          code: 'PATCH_INVALID_CHANGE',
          retryMode: 'correct_arguments',
          outcome: 'unchanged',
          details: {
            itemIndex: 1,
            kind: 'content',
            id: other.id,
            stage: 'validation',
            changeIndex: null,
            path: null,
          },
        },
      });
      expect(f.store.product.get('content', f.bot.id)).toEqual(f.bot);
      expect(f.store.product.get('content', other.id)).toEqual(other);
      expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM resource_undo').get()).toEqual({ n: 0 });
      expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations').get()).toEqual({
        n: 0,
      });
      return calls(
        call('corrected-guide', 'app.call', {
          name: 'resource.patchMany',
          arguments: { items: items('로즈') },
        })
      );
    }
    expect(result(request, 'corrected-guide')).toMatchObject({
      items: [
        { id: f.bot.id, revision: f.bot.revision + 1 },
        { id: other.id, revision: other.revision + 1 },
      ],
    });
    return structuredClone(success);
  });
  const task = await submit(f, '두 자료의 이름과 번역 표기를 고쳐줘');
  expect(f.store.product.get<Content>('content', f.bot.id).title).toBe('Renamed');
  expect(
    f.store.product.get<Content>('content', other.id).package.nativeRisu.card.extensions
  ).toMatchObject({
    uimori: { translationGuide: { terms: [{ source: 'Rose', target: '로즈' }] } },
  });
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 1 });
});

test('app.call saves shared bot and persona appearance defaults atomically and preserves native data', async () => {
  const f = await fixture('library');
  const input = fixtureBotInput('Persona', 'Persona body');
  input.package.nativeRisu.card.extensions = {
    vendor: { sentinel: 17 },
    uimori: { translationGuide: { instructions: 'Keep this guide', terms: [] } },
  };
  const persona = f.store.product.content({ ...input, kind: 'persona' }) as Content;
  const originals = [f.bot, persona];
  const profiles = [{ id: 'shared', name: 'Shared character', appearance: 'Silver hair' }];
  const path = '/package/nativeRisu/card/extensions/uimori/illustrationProfiles';
  const items = (revisionDelta: number, malformed = false) =>
    originals.map((content, index) => ({
      kind: 'content',
      id: content.id,
      expectedRevision: content.revision + revisionDelta,
      changes: [
        {
          op: 'set',
          path,
          value: malformed && index === 1 ? [{ ...profiles[0], appearance: '' }] : profiles,
        },
      ],
    }));
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        ...originals.map((content, index) =>
          call(`read-${index}`, 'app.call', {
            name: 'resource.read',
            arguments: { kind: 'content', id: content.id },
          })
        )
      );
    if (round === 1) {
      for (const index of [0, 1])
        expect(result(request, `read-${index}`)).toMatchObject({
          source: { appearanceProfilesPath: path },
        });
      return calls(
        call('malformed', 'app.call', {
          name: 'resource.patchMany',
          arguments: { items: items(0, true) },
        })
      );
    }
    if (round === 2) {
      expect(event(request, 'malformed')).toMatchObject({
        denied: true,
        result: { outcome: 'unchanged' },
      });
      for (const original of originals)
        expect(f.store.product.get('content', original.id)).toEqual(original);
      expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM resource_undo').get()).toEqual({ n: 0 });
      return calls(
        call('save-defaults', 'app.call', {
          name: 'resource.patchMany',
          arguments: { items: items(0) },
        })
      );
    }
    if (round === 3) {
      expect(result(request, 'save-defaults')).toMatchObject({
        items: originals.map((content) => ({
          id: content.id,
          revision: content.revision + 1,
          changedPaths: [path],
        })),
      });
      return calls(call('noop', 'app.call', { name: 'resource.patch', arguments: items(1)[0] }));
    }
    expect(result(request, 'noop')).toMatchObject({
      id: f.bot.id,
      revision: f.bot.revision + 1,
      changedPaths: [],
    });
    return structuredClone(success);
  });
  const task = await submit(f, '봇과 페르소나에 공유 외형 기본값을 저장해줘');
  for (const original of originals) {
    const saved = f.store.product.get<Content>('content', original.id);
    const card = structuredClone(saved.package.nativeRisu.card);
    expect((card.extensions as any).uimori.illustrationProfiles).toEqual(profiles);
    delete (card.extensions as any).uimori.illustrationProfiles;
    const before = structuredClone(original.package.nativeRisu.card);
    if (!(before.extensions as any)?.uimori) delete (card.extensions as any).uimori;
    if (!before.extensions) delete card.extensions;
    expect(card).toEqual(before);
    expect(saved.revision).toBe(original.revision + 1);
  }
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 2 });
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

test('helper proposals are read-only and mixed profile edits share one revision and receipt', async () => {
  const f = await fixture();
  const other = createFixtureChat(f.store, 'Other', { botId: f.bot.id });
  const portrait = f.store.product.createAsset(f.chat.id, {
    title: 'Portrait',
    description: '',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'both',
    mime: 'image/png',
    base64: PNG_BASE64,
  });
  const original = {
    id: 'first',
    name: 'Mira',
    appearance: 'Silver hair',
    referenceRef: portrait.id,
  };
  const selected = [{ ref: portrait.id, role: 'style' as const }];
  const before = updateIllustrationReferences(f.store, f.chat.id, {
    expectedRevision: 0,
    references: selected,
    characterProfiles: [original],
  });
  const appCall = (id: string, name: string, args: Record<string, unknown> = {}) =>
    call(id, 'app.call', { name, arguments: args });
  const read = 'illustration.profiles.read',
    save = 'illustration.profiles.save';
  const propose = mockSend((request, round) => {
    if (!round) return calls(appCall('read', read));
    expect(result(request, 'read')).toMatchObject({
      revision: before.revision,
      characterProfiles: [original],
      references: selected,
    });
    return { ...structuredClone(success), text: 'Mira could wear her silver hair in a braid.' };
  });
  const draft = await submit(f, 'Suggest an appearance for Mira.');
  expect(illustrationReferences(f.store, f.chat.id)).toEqual(before);
  expect(readHelperTaskResults(f.store, draft.id).results).toEqual([]);
  propose.mockRestore();
  const add = { name: 'Jun', appearance: 'Dark curls' };
  const edit = { profileId: original.id, appearance: 'Silver braid' };
  const batch = { expectedRevision: 1, profiles: [add, edit] };
  mockSend((request, round) => {
    if (!round)
      return calls(
        appCall('other', save, {
          chatId: other.id,
          expectedRevision: 0,
          profiles: [{ ...add, referenceRef: portrait.id }],
        }),
        appCall('duplicate', save, { ...batch, profiles: [add, edit, edit] }),
        appCall('missing-image', save, {
          ...batch,
          profiles: [add, { ...edit, referenceRef: 'absent' }],
        })
      );
    if (round === 1) {
      expect(event(request, 'other').denied).toBe(true);
      expect(event(request, 'other').result).toMatchObject({
        error: '이 채팅에서 사용할 수 없는 인물 참고 이미지예요.',
      });
      expect(event(request, 'duplicate').denied).toBe(true);
      expect(event(request, 'missing-image').denied).toBe(true);
      expect(illustrationReferences(f.store, f.chat.id)).toEqual(before);
      return calls(appCall('batch', save, batch));
    }
    if (round === 2) {
      expect(result(request, 'batch')).toMatchObject({
        revision: 2,
        profiles: [
          { name: 'Jun', changed: true },
          { profileId: original.id, changed: true },
        ],
      });
      return calls(
        appCall('stale', save, batch),
        appCall('noop', save, { expectedRevision: 2, profiles: [edit] })
      );
    }
    expect(event(request, 'stale')).toMatchObject({
      denied: true,
      result: { retryMode: 'refresh_then_retry' },
    });
    expect(result(request, 'noop')).toMatchObject({ changed: false, revision: 2 });
    return structuredClone(success);
  });
  const saved = await submit(f, 'Save Jun and give Mira a silver braid.');
  expect(illustrationReferences(f.store, f.chat.id)).toMatchObject({
    revision: 2,
    references: selected,
    characterProfiles: [
      { ...original, appearance: 'Silver braid' },
      { name: 'Jun', appearance: 'Dark curls' },
    ],
  });
  expect(illustrationReferences(f.store, other.id).revision).toBe(0);
  const effects = readHelperTaskResults(f.store, saved.id);
  expect(effects.unrecordedOperations).toBe(0);
  expect(
    effects.results.map((item) => [
      item.requestedTargets,
      item.changedTargets,
      item.targets.map((target) => target.title),
    ])
  ).toEqual([
    [2, 2, ['Jun', 'Mira']],
    [1, 0, []],
  ]);
});

test.each(['library', 'chat'] as const)(
  'illustration profiles can target a chat from %s and default to its full cast',
  async (scope) => {
    const f = await fixture(scope);
    const target = createFixtureChat(f.store, 'Target cast', { botId: f.bot.id });
    const cast = Array.from({ length: 32 }, (_, i) => ({
      id: String(i),
      name: `Character ${i}`,
      appearance: `Portrait ${i}`,
    }));
    const { revision } = updateIllustrationReferences(f.store, target.id, {
      expectedRevision: 0,
      references: [],
      characterProfiles: cast,
    });
    mockSend((request, round) => {
      if (!round)
        return calls(
          call('cast', 'app.call', {
            name: 'illustration.profiles.read',
            arguments: { chatId: target.id },
          })
        );
      if (round === 1) {
        expect(result(request, 'cast')).toMatchObject({
          revision,
          characterProfiles: cast,
          nextOffset: null,
        });
        return calls(
          call('save', 'app.call', {
            name: 'illustration.profiles.save',
            arguments: {
              chatId: target.id,
              expectedRevision: revision,
              profiles: [{ profileId: cast[31].id, appearance: 'Red scarf' }],
            },
          })
        );
      }
      expect(result(request, 'save')).toMatchObject({ chatId: target.id, changed: true });
      return structuredClone(success);
    });
    const task = await submit(f, 'Update the last character in Target cast.');
    expect(readHelperTaskResults(f.store, task.id).results[0].targets[0].id).toBe(target.id);
    expect(illustrationReferences(f.store, target.id).characterProfiles[31].appearance).toBe(
      'Red scarf'
    );
    expect(illustrationReferences(f.store, f.chat.id).revision).toBe(0);
  }
);

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

test('the library helper proposes cuts, illustrates exact passages across scenes, and redraws only the selected image', async () => {
  const f = await fixture('library');
  const target = createFixtureChat(f.store, 'A night at the pier', { botId: f.bot.id });
  const scenes = [
    completedSource(f.store, target.id, 'Mira stepped outside.\n\nHer lantern went dark.'),
    completedSource(f.store, target.id, 'Jun reached the river.\n\nThe reflection remained.'),
  ];
  const { revision, ...settings } = fixtureSettings({ maxPerSource: 2 });
  updateIllustrationSettings(f.store, { ...settings, expectedRevision: revision }, true);
  const receiptCount = (taskId: string) =>
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(taskId)
      ?.n;
  const act = (id: string, name: string, args: Record<string, unknown>) =>
    call(id, 'app.call', { name, arguments: { chatId: target.id, ...args } });
  type Moment = {
    sourceId: string;
    expectedSourceHash: string;
    startAnchor: string;
    endAnchor: string;
    focus: string;
  };
  let moments: Moment[] = [];
  const propose = mockSend((request, round) => {
    if (!round)
      return calls(
        ...scenes.map((scene, i) =>
          act(String(i), 'illustration.scene.read', { sourceId: scene.id })
        )
      );
    moments = scenes.map((scene, i) => {
      const { sourceHash, blocks } = result<{
        sourceHash: string;
        blocks: { anchor: string; text: string }[];
      }>(request, String(i));
      expect(blocks[1].text).toBe(scene.text.split('\n\n')[1]);
      return {
        sourceId: scene.id,
        expectedSourceHash: sourceHash,
        startAnchor: blocks[1].anchor,
        endAnchor: blocks[1].anchor,
        focus: blocks[1].text,
      };
    });
    return structuredClone(success);
  });
  const proposal = await submit(f, 'Suggest two moments from A night at the pier.');
  expect(receiptCount(proposal.id)).toBe(0);
  expect(illustrationsForChat(f.store, target.id)).toEqual([]);
  propose.mockRestore();
  const coat = 'Mira wears the borrowed red coat.';
  const generate = mockSend((request, round) => {
    if (!round)
      return calls(
        act('coat', 'illustration.continuity.save', {
          expectedRevision: 0,
          edits: [{ fromSourceId: scenes[0].id, toSourceId: scenes[0].id, text: coat }],
        })
      );
    if (round === 1) {
      expect(result(request, 'coat')).toMatchObject({ changed: true });
      return calls(act('draw', 'illustration.generate', { moments }));
    }
    expect(result(request, 'draw')).toMatchObject({ chatId: target.id, count: 2 });
    return structuredClone(success);
  });
  const requestKey = randomUUID();
  const requestText = 'Keep the borrowed coat in the first scene only, then draw both moments.';
  const reserved = await submit(f, requestText, 'completed', requestKey);
  expect(receiptCount(reserved.id)).toBe(2);
  expect((await submit(f, requestText, 'completed', requestKey)).id).toBe(reserved.id);
  const renders = () =>
    illustrationsForChat(f.store, target.id).filter((job) => job.task === 'render');
  await vi.waitFor(() =>
    expect(renders().filter((job) => job.status === 'completed')).toHaveLength(2)
  );
  for (const moment of moments) {
    const cut = renders().find((job) => job.sourceRevision === moment.sourceId)!;
    expect(cut.target).toMatchObject({
      startAnchor: moment.startAnchor,
      endAnchor: moment.endAnchor,
      focus: moment.focus,
    });
    const input = illustrationJob(f.store, cut.id).input;
    if (moment.sourceId === scenes[0].id)
      expect(input).toMatchObject({ sceneAppearanceNotes: [coat] });
    else expect(input).not.toHaveProperty('sceneAppearanceNotes');
  }
  expect(illustrationsForChat(f.store, f.chat.id)).toEqual([]);
  generate.mockRestore();

  const changeRequest = 'Keep the reflection and cool the light.';
  type Cut = {
    currentSourceHash: string;
    latestJobId: string;
    presentationRevision: number;
    images: { imageId: string }[];
  };
  let chosen: Cut;
  let redrawId = '';
  const redraw = mockSend((request, round) => {
    if (!round) return calls(act('cuts', 'illustration.cuts.list', { sourceId: scenes[1].id }));
    if (round === 1) {
      const { cuts } = result<{ cuts: Cut[] }>(request, 'cuts');
      expect(cuts).toHaveLength(1);
      chosen = cuts[0];
      return calls(act('view', 'illustration.cut.read', { imageId: chosen.images[0].imageId }));
    }
    if (round === 2) {
      expect(request.toolImages).toContainEqual({
        callId: 'view',
        images: [expect.objectContaining({ mime: 'image/webp' })],
      });
      return calls(
        act('style', 'illustration.references.save', {
          expectedRevision: 0,
          assignments: [{ imageId: chosen.images[0].imageId, role: 'style' }],
        }),
        act('redraw', 'illustration.cut.redraw', {
          imageId: chosen.images[0].imageId,
          expectedSourceHash: chosen.currentSourceHash,
          expectedLatestJobId: chosen.latestJobId,
          expectedPresentationRevision: chosen.presentationRevision,
          changeRequest,
        })
      );
    }
    expect(result(request, 'style')).toMatchObject({ changed: true, revision: 1 });
    redrawId = result<{ jobId: string }>(request, 'redraw').jobId;
    return structuredClone(success);
  });
  const redrawn = await submit(
    f,
    'Inspect the river reflection, use it as a style reference and redraw only that cut with cooler light.'
  );
  expect(receiptCount(redrawn.id)).toBe(2);
  expect(illustrationReferences(f.store, target.id).references).toEqual([
    { ref: expect.any(String), role: 'style' },
  ]);
  await vi.waitFor(() => expect(illustrationJob(f.store, redrawId).status).toBe('completed'));
  expect(illustrationJob(f.store, redrawId)).toMatchObject({
    chatId: target.id,
    sourceRevision: scenes[1].id,
    input: { redraw: { changeRequest } },
  });
  expect(renders().filter((job) => job.sourceRevision === scenes[0].id)).toHaveLength(1);
  expect(illustrationsForChat(f.store, f.chat.id)).toEqual([]);
  redraw.mockRestore();

  const revised = f.store.editSource(scenes[0].id, {
    text: 'Outside on the pier, the lantern went dark.',
    expectedRevision: 0,
  });
  const beforeMove = renders().map((job) => ({
    jobId: job.id,
    images: job.images.map((image) => image.id),
  }));
  mockSend((request, round) => {
    if (!round)
      return calls(
        act('revised', 'illustration.scene.read', { sourceId: revised.id }),
        act('stale', 'illustration.cuts.list', { sourceId: revised.id })
      );
    if (round === 1) {
      const { blocks } = result<{ blocks: { anchor: string }[] }>(request, 'revised');
      const { cuts } = result<{
        cuts: (Cut & { displayedJobId: string })[];
      }>(request, 'stale');
      expect(cuts[0].currentSourceHash).toBe(revised.hash);
      return calls(
        act('place', 'illustration.cuts.place', {
          placements: [
            {
              jobId: cuts[0].displayedJobId,
              expectedSourceHash: revised.hash,
              expectedPresentationRevision: cuts[0].presentationRevision,
              startAnchor: blocks[0].anchor,
              endAnchor: blocks[0].anchor,
            },
          ],
        })
      );
    }
    expect(result(request, 'place')).toMatchObject({ changed: true });
    return structuredClone(success);
  });
  await submit(
    f,
    'I rewrote the opening. Move its illustration to the new paragraph and keep the drawing.'
  );
  expect(
    renders().map((job) => ({ jobId: job.id, images: job.images.map((image) => image.id) }))
  ).toEqual(beforeMove);
  expect(renders().find((job) => job.sourceRevision === revised.id)).toMatchObject({
    sourceHash: revised.hash,
    generatedSourceHash: scenes[0].hash,
  });
});

test('helper gateway follows browse results into an exact reference read without adding native tools or saving', async () => {
  const f = await fixture();
  mockSend((request, round) => {
    expect(request.stable.tools.map((tool) => tool.name)).toEqual(['app.tools', 'app.call']);
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

test('helper saves a palette without selecting it, applies explicitly and preserves receipt on stale selection', async () => {
  const f = await fixture('library');
  const { BUILTIN_PALETTES } = await import('../core/theme-palettes.js');
  const { themePreferences, paletteCatalog } = await import('../server/themes.js');
  const before = themePreferences(f.store);
  let paletteId = '';
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('create-palette', 'app.call', {
          name: 'palette.save',
          arguments: {
            model: {
              title: 'Helper test palette',
              description: 'Explicit creation',
              colors: BUILTIN_PALETTES[0].colors,
            },
          },
        })
      );
    if (round === 1) {
      const saved = result<{ id: string; revision: number }>(request, 'create-palette');
      paletteId = saved.id;
      expect(themePreferences(f.store)).toEqual(before);
      return calls(
        call('apply-palette', 'app.call', {
          name: 'theme.select',
          arguments: {
            scope: 'global',
            dimension: 'palette',
            paletteId,
            expectedRevision: before.revision,
          },
        })
      );
    }
    if (round === 2) {
      expect(result<{ defaultPaletteId: string }>(request, 'apply-palette').defaultPaletteId).toBe(
        paletteId
      );
      return calls(
        call('stale-apply', 'app.call', {
          name: 'theme.select',
          arguments: {
            scope: 'global',
            dimension: 'palette',
            paletteId: 'forest',
            expectedRevision: before.revision,
          },
        })
      );
    }
    expect(event(request, 'stale-apply').denied).toBe(true);
    return success;
  });
  const task = await submit(f, 'Create and apply a palette');
  expect(themePreferences(f.store).defaultPaletteId).toBe(paletteId);
  expect(paletteCatalog(f.store).some((palette) => palette.id === paletteId)).toBe(true);
  expect(
    Number(
      f.store.db
        .prepare('SELECT count(*) AS count FROM helper_operations WHERE task_id=?')
        .get(task.id)?.count
    )
  ).toBe(2);
  expect(
    f.workspace.events(f.conversation.id, 0).some((item) => item.kind === 'theme.updated')
  ).toBe(true);
});

test('presentation operations are discoverable and writes remain excluded from read-only review', () => {
  for (const name of [
    'font.list',
    'font.register',
    'font.select',
    'font.delete',
    'palette.list',
    'palette.save',
    'palette.delete',
    'theme.select',
  ]) {
    expect(describeHelperTools({ names: [name] }).tools[0]?.name).toBe(name);
    expect(helperToolTraits(name).readOnly).toBe(name.endsWith('.list'));
    expect(helperToolTraits(name).reviewAllowed).toBe(false);
    expect(helperToolTraits(name).direct).toBe(true);
  }
});

test('helper registers a downloaded font before explicit selection and records both writes', async () => {
  const f = await fixture('library');
  const fonts = await import('../server/fonts.js');
  const bytes = Buffer.alloc(48);
  bytes.write('wOF2');
  bytes.writeUInt32BE(bytes.length, 8);
  bytes.writeUInt16BE(1, 12);
  bytes.writeUInt32BE(48, 16);
  const download = vi.spyOn(fonts, 'downloadFont').mockResolvedValue(bytes);
  const before = fonts.fontPreferences(f.store);
  let fontId = '';
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('register-font', 'app.call', {
          name: 'font.register',
          arguments: {
            title: 'Licensed test font',
            url: 'https://example.org/font.woff2',
          },
        })
      );
    if (round === 1) {
      fontId = result<{ id: string }>(request, 'register-font').id;
      expect(fonts.fontPreferences(f.store)).toEqual(before);
      return calls(
        call('select-font', 'app.call', {
          name: 'font.select',
          arguments: { expectedRevision: before.revision, appFontId: null, readerFontId: fontId },
        })
      );
    }
    expect(result<{ readerFontId: string }>(request, 'select-font').readerFontId).toBe(fontId);
    return success;
  });
  const task = await submit(f, 'Register this licensed font and use it for reading');
  expect(download).toHaveBeenCalledWith('https://example.org/font.woff2', expect.any(AbortSignal));
  const font = fonts.fontCatalog(f.store).fonts.find((font) => font.id === fontId);
  expect(font).toMatchObject({ id: fontId, title: 'Licensed test font' });
  expect(font).not.toHaveProperty('license');
  expect(font).not.toHaveProperty('sourceUrl');
  expect(
    Number(
      f.store.db
        .prepare('SELECT count(*) AS count FROM helper_operations WHERE task_id=?')
        .get(task.id)?.count
    )
  ).toBe(2);
  expect(f.workspace.events(f.conversation.id).some((item) => item.kind === 'font.updated')).toBe(
    true
  );
});
