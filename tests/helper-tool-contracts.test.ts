import { editableResource } from '../core/resource-editing.js';
import { nativeDraftTitle } from './fixtures/native-content.js';
import { describeHelperTools } from '../server/helper-app-tools.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { ChatOverridesStore } from '../server/chat-overrides.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { chatOverrideHash } from '../core/chat-overrides.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import type { Content } from '../core/product.js';
import type { HelperConversation, HelperTask } from '../core/helper.js';
import type { ToolEvent } from '../core/types.js';
import type { LibraryOrganization } from '../core/library-organization.js';
import * as transport from '../core/transport.js';

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
async function fixture(kind: 'chat' | 'library' = 'chat') {
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
        content: 'Original shared lore: Q7x-α9.',
        constant: true,
        enabled: true,
      },
    ],
  };
  const bot = store.product.content(input) as Content;
  const chat = createFixtureChat(store, 'Synthetic chat', { botId: bot.id });
  const scope =
    kind === 'chat'
      ? { kind, chatId: chat.id, branchId: 'main:' + chat.id }
      : { kind, workId: 'helper-tool-contracts' };
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
  expect(found.denied).toBe(false);
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

test('helper read events retain recoverable argument and missing-scene errors', async () => {
  const f = await fixture();
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('valid-list', 'story.search', {}),
        call('bad-args', 'story.read', { sceneNumber: 1, offset: -1 }),
        call('outside-source', 'story.read', { sceneNumber: 999 }),
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

type LoreRead = ReturnType<ChatOverridesStore['get']>;
type HelperLoreRead = Omit<LoreRead, 'attachments'> & {
  attachments: (Omit<LoreRead['attachments'][number], 'lore'> & {
    lore: (LoreRead['attachments'][number]['lore'][number] & {
      fieldHashes: Record<'title' | 'description' | 'text', string>;
    })[];
  })[];
};
function patchBody(read: HelperLoreRead, value: string) {
  const attachment = read.attachments[0],
    lore = attachment.lore[0];
  return {
    selector: { ...attachment.scope, loreId: lore.id, field: 'text' },
    expectedRevision: read.revision,
    expectedHeadRevision: read.headRevision,
    expectedProfileRevision: read.profileRevision,
    expectedPackageRevision: attachment.packageRevision,
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
      const lore = first.attachments[0].lore[0];
      expect(lore.fieldHashes).toEqual({
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
      expect(latest.attachments[0].lore[0].fieldHashes).toEqual(
        first.attachments[0].lore[0].fieldHashes
      );
      expect(latest.attachments[0].lore[0].text).toBe(original.package!.lore[0].text);
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
      result: { error: '원본 로어 필드가 변경됐어요.' },
    });
    return structuredClone(success);
  });
  await submit(f, '이 채팅의 로어를 두 단계로 수정해줘');
  const state = new ChatOverridesStore(f.store).get(f.chat.id);
  expect(state.revision).toBe(first.revision + 2);
  expect(state.overrides).toHaveLength(1);
  expect(state.overrides[0]).toMatchObject({
    value: 'Chat override two',
    baseHash: first.attachments[0].lore[0].fieldHashes.text,
  });
  expect(f.store.product.get('content', f.bot.id)).toEqual(original);
});

test('helper may edit discovered lore without a separate grant parser', async () => {
  const f = await fixture();
  mockSend((request, round) => {
    if (round === 0) return calls(call('read-only-lore', 'chat.lore', { action: 'read' }));
    if (round === 1)
      return calls(
        call('direct-patch', 'chat.lore', {
          action: 'patch',
          body: patchBody(result<HelperLoreRead>(request, 'read-only-lore'), 'Updated lore'),
        })
      );
    expect(event(request, 'direct-patch').denied).toBe(false);
    return structuredClone(success);
  });
  await submit(f, '현재 로어를 자연스럽게 다듬어 주세요.');
  expect(new ChatOverridesStore(f.store).get(f.chat.id).overrides).toHaveLength(1);
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

test('resource saves leave real receipts so a later failure cannot offer a duplicate retry', async () => {
  const f = await fixture('library');
  const title = 'Saved before provider failure';
  const model = nativeDraftTitle(editableResource('content', f.bot), title);
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('save-real', 'app.call', {
          name: 'resource.save',
          arguments: { kind: 'content', id: f.bot.id, expectedRevision: f.bot.revision, model },
        })
      );
    expect(result(request, 'save-real')).toMatchObject({
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
