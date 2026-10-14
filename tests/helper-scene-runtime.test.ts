import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createApp, type App } from '../server/app.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { editTranslation } from '../server/source-editing.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import type { HelperConversation, HelperTask } from '../core/helper.js';
import type { ToolEvent } from '../core/types.js';
import * as transport from '../core/transport.js';

const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    const inside = relative(tmpdir(), path);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-scene-runtime-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function fixture(kind: 'chat' | 'library' = 'chat') {
  const path = mkdtempSync(join(tmpdir(), 'uimori-scene-runtime-'));
  const app = await createApp({
    dbPath: join(path, 'test.sqlite'),
    buildId: 'helper-scene-runtime',
    testMode: true,
  });
  owned.push({ app, path });
  const store = app.store;
  const connection = store.product.connection({
    title: 'Synthetic helper',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic helper',
    connectionId: connection.id,
    modelId: 'fixture-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: { id: model.id }, translation: { id: model.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  const chat = createFixtureChat(store, 'Scene editing');
  const source = completedSource(store, chat.id, 'Yoshino said, “Hello.”');
  const response = await app.inject({
    method: 'POST',
    url: '/api/helper/conversations',
    payload: {
      scope: kind === 'chat' ? { kind, chatId: chat.id } : { kind, workId: 'scene-test' },
    },
  });
  expect(response.statusCode).toBe(200);
  return {
    app,
    store,
    chat,
    source,
    conversation: response.json<HelperConversation>(),
    workspace: new HelperWorkspace(store),
  };
}
const success: transport.ProviderResult = {
  status: 'completed',
  text: '저장 결과를 확인했어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
const asJson = (value: unknown): transport.Json => JSON.parse(JSON.stringify(value));
function call(
  id: string,
  name: string,
  arguments_: Record<string, unknown>
): transport.ProviderToolCall {
  return { id, name: 'app.call', arguments: { name, arguments: asJson(arguments_) } };
}
function calls(...toolCalls: transport.ProviderToolCall[]): transport.ProviderResult {
  return { ...structuredClone(success), status: 'tool_calls', text: '', toolCalls };
}
function mockSend(
  action: (request: transport.ProviderRequest, round: number) => transport.ProviderResult
) {
  let round = 0;
  vi.spyOn(transport, 'executeProvider').mockImplementation(
    async (_connection, request, options) => {
      expect(request.role).toBe('helper');
      options.beforeTurn?.();
      return action(request, round++);
    }
  );
}
function event(request: transport.ProviderRequest, id: string): ToolEvent {
  const found = (request.input.results as unknown as ToolEvent[]).find(
    (item) => item.callId === id
  );
  expect(found).toBeDefined();
  return found!;
}
function result(request: transport.ProviderRequest, id: string): Record<string, unknown> {
  const found = event(request, id);
  expect(found.denied, JSON.stringify(found)).toBe(false);
  return found.result as Record<string, unknown>;
}
async function submit(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  status: HelperTask['status'] = 'completed'
) {
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${f.conversation.id}/messages`,
    payload: { requestKey: randomUUID(), text },
  });
  expect(response.statusCode).toBe(200);
  const task = response.json<HelperTask>();
  await vi.waitFor(
    () => expect(['queued', 'running']).not.toContain(f.workspace.task(task.id).status),
    { timeout: 3000 }
  );
  expect(f.workspace.task(task.id).status, f.workspace.task(task.id).error ?? '').toBe(status);
  return f.workspace.task(task.id);
}

test.each([false, true])(
  'helper edits an original once and invalidates its translation (duplicate call: %s)',
  async (duplicate) => {
    const f = await fixture();
    const translation = editTranslation(f.store, f.source.id, {
      text: '요시노가 “안녕.” 하고 말했다.',
      expectedRevision: 0,
      expectedSourceHash: f.source.hash,
    });
    let patch: Record<string, unknown>;
    mockSend((request, round) => {
      if (round === 0)
        return calls({
          id: 'discover',
          name: 'app.tools',
          arguments: { names: ['scene.read', 'scene.patch', 'scene.versions', 'scene.restore'] },
        });
      if (round === 1) {
        const tools = result(request, 'discover').tools as { name: string }[];
        expect(tools.map((tool) => tool.name)).toEqual([
          'scene.read',
          'scene.patch',
          'scene.versions',
          'scene.restore',
        ]);
        return calls(call('read', 'scene.read', { sourceId: f.source.id, target: 'original' }));
      }
      if (round === 2) {
        const read = result(request, 'read');
        patch = {
          ...(read.editTarget as Record<string, unknown>),
          changes: [{ oldText: 'Hello.', newText: 'Good evening.' }],
        };
        return calls(call('patch-once', 'scene.patch', patch));
      }
      result(request, 'patch-once');
      if (round === 3 && duplicate) return calls(call('patch-once', 'scene.patch', patch));
      return structuredClone(success);
    });
    const task = await submit(
      f,
      'Scene 1 요시노 대사를 수정하고 저장해줘.',
      duplicate ? 'failed' : 'completed'
    );
    if (duplicate) {
      expect(task.error).toContain('DUPLICATE_TOOL_ID');
      expect(task.completedEffects?.count).toBe(1);
    }
    expect(f.store.source(f.source.id)).toMatchObject({
      text: 'Yoshino said, “Good evening.”',
      editRevision: 1,
    });
    expect(f.store.job(translation.id).status).toBe('stale');
    expect(
      f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
        ?.n
    ).toBe(1);
  }
);

test('library helper targets an explicit chat and edits translation without changing original', async () => {
  const f = await fixture('library');
  editTranslation(f.store, f.source.id, {
    text: '요시노가 “안녕.” 하고 말했다.',
    expectedRevision: 0,
    expectedSourceHash: f.source.hash,
  });
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('read', 'scene.read', {
          chatId: f.chat.id,
          sourceId: f.source.id,
          target: 'translation',
        })
      );
    if (round === 1)
      return calls(
        call('patch', 'scene.patch', {
          ...(result(request, 'read').editTarget as Record<string, unknown>),
          chatId: f.chat.id,
          text: '요시노가 “안녕하세요.” 하고 말했다.',
        })
      );
    result(request, 'patch');
    return structuredClone(success);
  });
  await submit(f, '지정한 채팅 Scene 1 번역을 다듬어서 저장해줘.');
  expect(f.store.source(f.source.id)).toMatchObject({
    text: f.source.text,
    hash: f.source.hash,
    editRevision: 0,
  });
  const latest = f.store.db
    .prepare(
      "SELECT id FROM jobs WHERE source_revision=? AND kind='translation' ORDER BY revision DESC LIMIT 1"
    )
    .get(f.source.id)!;
  expect(f.store.job(String(latest.id)).result).toMatchObject({
    text: '요시노가 “안녕하세요.” 하고 말했다.',
  });
});

test('scene patch rejects a source outside the helper chat before mutating it', async () => {
  const f = await fixture();
  const otherChat = createFixtureChat(f.store, 'Unrelated chat');
  const other = completedSource(f.store, otherChat.id, 'Keep this unrelated scene.');
  mockSend((request, round) => {
    if (round === 0)
      return calls(
        call('forbidden', 'scene.patch', {
          sourceId: other.id,
          target: 'original',
          expectedRevision: 0,
          expectedSourceHash: other.hash,
          text: 'Wrong chat overwrite',
        })
      );
    expect(event(request, 'forbidden')).toMatchObject({
      denied: true,
      result: { error: 'Scene is not in the current chat ancestry' },
    });
    return structuredClone(success);
  });
  const task = await submit(f, 'Scene 1을 고쳐서 저장해줘.');
  expect(f.store.source(other.id)).toMatchObject({ text: other.text, editRevision: 0 });
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
      ?.n
  ).toBe(0);
});

test('helper translation save aborts the active provider and preserves the manual result', async () => {
  const f = await fixture();
  editTranslation(f.store, f.source.id, {
    text: '이전 성공 번역',
    expectedRevision: 0,
    expectedSourceHash: f.source.hash,
  });
  let activeSignal: AbortSignal | undefined;
  let helperRound = 0;
  vi.spyOn(transport, 'executeProvider').mockImplementation(
    async (_connection, request, options) => {
      options.beforeTurn?.();
      if (request.role === 'translation') {
        activeSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      }
      expect(request.role).toBe('helper');
      if (helperRound++ === 0)
        return calls(call('read', 'scene.read', { sourceId: f.source.id, target: 'translation' }));
      if (helperRound === 2)
        return calls(
          call('save', 'scene.patch', {
            ...(result(request, 'read').editTarget as Record<string, unknown>),
            text: '직접 다듬어 저장한 번역',
          })
        );
      result(request, 'save');
      return structuredClone(success);
    }
  );
  const regenerate = await f.app.inject({
    method: 'POST',
    url: `/api/sources/${f.source.id}/retranslate`,
    payload: {},
  });
  expect(regenerate.statusCode).toBe(200);
  const pending = regenerate.json<{ id: string }>();
  await vi.waitFor(() => expect(activeSignal).toBeDefined(), { timeout: 3000 });
  await submit(f, 'Scene 1 번역을 직접 다듬어서 저장해줘.');
  expect(activeSignal!.aborted).toBe(true);
  expect(f.store.job(pending.id).status).toBe('cancelled');
  const current = f.store.db
    .prepare(
      "SELECT id FROM jobs WHERE source_revision=? AND kind='translation' ORDER BY revision DESC LIMIT 1"
    )
    .get(f.source.id)!;
  expect(f.store.job(String(current.id))).toMatchObject({
    status: 'completed',
    result: { text: '직접 다듬어 저장한 번역' },
  });
});

test.each(['scene.read', 'scene.versions'] as const)(
  '%s round-budget recovery preserves the selected chat, version and unread range',
  async (name) => {
    const f = await fixture('library');
    const prose = 'Exact saved scene. '.repeat(6000);
    const source = completedSource(f.store, f.chat.id, prose);
    let args: Record<string, unknown>;
    mockSend((request, round) => {
      if (round === 0)
        return calls(
          call('guards', 'scene.read', {
            chatId: f.chat.id,
            sourceId: source.id,
            target: 'original',
            limit: 1,
          })
        );
      if (round === 1) {
        const guards = result(request, 'guards').editTarget as Record<string, unknown>;
        const { target: _target, ...versionGuards } = guards;
        args = {
          ...(name === 'scene.read' ? guards : versionGuards),
          chatId: f.chat.id,
          ...(name === 'scene.versions' ? { versionRevision: 0 } : {}),
          offset: 37,
          limit: 10000,
        };
        return calls(...Array.from({ length: 7 }, (_, index) => call(`page-${index}`, name, args)));
      }
      if (round === 2) {
        const denied = (request.input.results as unknown as ToolEvent[]).find(
          (item) =>
            item.denied && (item.result as { error?: string }).error === 'HELPER_READ_TOO_LARGE'
        );
        expect(denied).toBeDefined();
        const retry = (
          denied!.result as {
            nextRead: { name: string; arguments: Record<string, unknown> };
          }
        ).nextRead;
        expect(request.stable.tools.map((tool) => tool.name)).toContain(retry.name);
        expect(retry).toEqual({
          name: 'app.call',
          arguments: { name, arguments: { ...args, limit: 2000 } },
        });
        return calls({
          id: 'retry-page',
          name: retry.name,
          arguments: asJson(retry.arguments) as Record<string, transport.Json>,
        });
      }
      expect(result(request, 'retry-page')).toMatchObject({
        chatId: f.chat.id,
        text: prose.slice(37, 2037),
        offset: 37,
        nextOffset: 2037,
      });
      return structuredClone(success);
    });
    await submit(f, '지정한 채팅의 장면 본문을 이어서 읽어줘.');
  }
);
