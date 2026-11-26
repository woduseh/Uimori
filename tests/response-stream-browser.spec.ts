import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import type { ModelWorkspace } from '../core/product.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { loopbackProvider, sse } from './fixtures/loopback-provider.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';

preservePromptWorkspace();

async function body<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

type Writer = {
  write: (text: string) => void;
  finish: () => void;
};

async function streamingWriter(request: APIRequestContext) {
  let connected = (_writer: Writer) => {};
  const writer = new Promise<Writer>((resolve) => {
    connected = resolve;
  });
  const peer = await loopbackProvider(
    (_wire, response: ServerResponse) =>
      new Promise<void>((done) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        connected({
          write: (text) => response.write(sse({ type: 'text_delta', delta: text })),
          finish: () => {
            response.write(
              sse({ type: 'usage', inputTokens: 10, outputTokens: 10, costUsd: null })
            );
            response.end(sse({ type: 'done', reason: 'stop' }));
            done();
          },
        });
      })
  );
  const connection = await body<{ id: string }>(
    await request.post('/api/connections', {
      data: {
        title: `Streaming writer ${randomUUID()}`,
        protocol: 'fixture-sse-v1',
        endpoint: peer.endpoint,
        enabled: true,
      },
    })
  );
  const model = await body<{ id: string }>(
    await request.post('/api/model-presets', {
      data: {
        title: 'Streaming writer',
        connectionId: connection.id,
        modelId: 'streaming-writer',
        tokenizer: 'gemini-gemma4',
        inputTokenLimit: 65536,
        maxOutputTokens: 4096,
        temperature: null,
      },
    })
  );
  const models = await body<ModelWorkspace>(await request.get('/api/model-workspace'));
  await body(
    await request.put('/api/model-workspace', {
      data: {
        expectedRevision: models.revision,
        routes: { ...models.routes, main: { id: model.id } },
        titleModel: null,
        translationPolicy: models.translationPolicy,
      },
    })
  );
  const chat = await body<Chat>(
    await postFixtureChat(request, { data: { title: `Streaming chat ${randomUUID()}` } })
  );
  const themes = await body<{ preferences: { revision: number } }>(
    await request.get('/api/themes')
  );
  await body(
    await request.post('/api/themes/selection', {
      data: {
        themeId: 'builtin:forest',
        targetId: chat.id,
        scope: 'chat',
        expectedRevision: themes.preferences.revision,
      },
    })
  );
  return { peer, writer, chat };
}

async function startRun(request: APIRequestContext, chat: Chat, text: string) {
  return body<Run>(
    await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: text,
        expectedRevision: chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
    })
  );
}

function trackStreamReads(page: Page, runId: string) {
  const open = new Set<unknown>();
  const cursors: string[] = [];
  const matches = (url: string) => url.includes(`/api/response-streams/main/${runId}?`);
  page.on('request', (item) => {
    if (!matches(item.url())) return;
    open.add(item);
    cursors.push(new URL(item.url()).searchParams.get('after') ?? '');
  });
  page.on('requestfinished', (item) => open.delete(item));
  page.on('requestfailed', (item) => open.delete(item));
  return { open: () => open.size, cursors };
}

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

test('STREAMLIVE hiding the tab pauses main stream reads and resuming continues from its cursor', async ({
  page,
  request,
}) => {
  const { peer, writer, chat } = await streamingWriter(request);
  try {
    const run = await startRun(request, chat, '등대 장면을 이어 써 주세요.');
    const streams = trackStreamReads(page, run.id);
    await page.goto(`/?chat=${chat.id}`);
    const pending = page.locator(`[data-testid="pending-run"][data-run-id="${run.id}"]`);
    const live = await writer;
    const first = '미라는 등대 계단을 올랐다.';
    const second = ' 바람이 창을 두드렸다.';
    const third = ' 불빛이 바다를 갈랐다.';
    live.write(first);
    await expect(pending.locator('.streaming-text')).toHaveText(first);

    await setHidden(page, true);
    await expect.poll(streams.open).toBe(0);
    const reads = streams.cursors.length;
    live.write(second);
    await page.waitForTimeout(700);
    expect(streams.cursors).toHaveLength(reads);
    await expect(pending.locator('.streaming-text')).toHaveText(first);

    await setHidden(page, false);
    await expect(pending.locator('.streaming-text')).toHaveText(first + second);
    expect(Number(streams.cursors.at(-1))).toBeGreaterThan(0);
    live.write(third);
    await expect(pending.locator('.streaming-text')).toHaveText(first + second + third);
    live.finish();
    await expect
      .poll(async () => (await body<Run>(await request.get(`/api/runs/${run.id}`))).status)
      .toBe('completed');
    const detail = await body<ChatDetail>(await request.get(`/api/chats/${chat.id}`));
    expect(detail.sources.at(-1)?.text).toBe(first + second + third);
    await expect(pending).toHaveCount(0);
    await settle(page);
    expect(streams.open()).toBe(0);
  } finally {
    await peer.close();
  }
});

test('STREAMFOLLOW the reader follows a sent request, stops when scrolled up and resumes at the bottom', async ({
  page,
  request,
}) => {
  const { peer, writer, chat } = await streamingWriter(request);
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?chat=${chat.id}`);
    await page.locator('[data-uimori-part="composer-input"]').fill('긴 장면을 써 주세요.');
    await page.getByRole('button', { name: '원문 생성', exact: true }).click();
    const live = await writer;
    const scrollport = page.locator('[data-reader-scrollport]');
    const distance = () =>
      scrollport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
    const paragraph = (index: number) =>
      `${index}번째 문단이에요. 등대의 불빛이 파도 위를 천천히 건너가며 항구의 밤을 밝혔다.\n\n`;
    let index = 0;
    const write = async (count: number) => {
      for (let end = index + count; index < end; index++) live.write(paragraph(index));
      await expect(page.getByTestId('pending-run').locator('.streaming-text')).toContainText(
        `${index - 1}번째 문단`
      );
      await settle(page);
    };
    await write(30);
    await expect.poll(distance).toBeLessThan(2);
    await scrollport.evaluate((node) => {
      node.scrollTop -= 400;
    });
    await settle(page);
    const released = await scrollport.evaluate((node) => node.scrollTop);
    await write(5);
    expect(await scrollport.evaluate((node) => node.scrollTop)).toBe(released);
    expect(await distance()).toBeGreaterThan(400);
    await scrollport.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await settle(page);
    await write(5);
    await expect.poll(distance).toBeLessThan(2);
    live.finish();
    await expect(page.getByTestId('pending-run')).toHaveCount(0);
  } finally {
    await peer.close();
  }
});

test('STREAMTRANSLATION a running translation streams into the translation view until the finished translation replaces it', async ({
  page,
  request,
}) => {
  const delta = (content: string, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'local', choices: [{ index: 0, delta: { content }, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } : {}) })}\n\n`;
  let connected = (_writer: Writer) => {};
  const writer = new Promise<Writer>((resolve) => {
    connected = resolve;
  });
  const peer = await loopbackProvider(
    (_wire, response: ServerResponse) =>
      new Promise<void>((done) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        connected({
          write: (text) => response.write(delta(text)),
          finish: () => {
            response.write(delta('', 'stop'));
            response.end('data: [DONE]\n\n');
            done();
          },
        });
      })
  );
  try {
    const connection = await body<{ id: string }>(
      await request.post('/api/connections', {
        data: {
          title: `Streaming translator ${randomUUID()}`,
          protocol: 'openai-chat-v1',
          endpoint: peer.endpoint,
          enabled: true,
        },
      })
    );
    const model = await body<{ id: string }>(
      await request.post('/api/model-presets', {
        data: {
          title: 'Streaming translator',
          connectionId: connection.id,
          modelId: 'streaming-translator',
          tokenizer: 'gemini-gemma4',
          inputTokenLimit: 65536,
          maxOutputTokens: 4096,
          temperature: null,
        },
      })
    );
    const models = await body<ModelWorkspace>(await request.get('/api/model-workspace'));
    await body(
      await request.put('/api/model-workspace', {
        data: {
          expectedRevision: models.revision,
          routes: { ...models.routes, translation: { id: model.id } },
          titleModel: null,
          translationPolicy: {
            ...models.translationPolicy,
            judgment: { ...models.translationPolicy.judgment, enabled: false },
          },
        },
      })
    );
    const owner = await body<Chat>(
      await postFixtureChat(request, { data: { title: `Streaming translation ${randomUUID()}` } })
    );
    const transcript = await body<{ entries: unknown[] }>(
      await request.get(`/api/chats/${owner.id}/transcript`)
    );
    transcript.entries = [
      {
        request: 'Streaming translation fixture',
        text: 'Mira climbed the lighthouse stairs.\n\nThe wind knocked on the window.',
        translation: null,
      },
    ];
    const { chat } = await body<{ chat: Chat }>(
      await request.post('/api/chats/import-transcript', {
        data: { transcript, idempotencyKey: `streaming-translation-${owner.id}` },
      })
    );
    await page.goto(`/?chat=${chat.id}`);
    const scene = page.getByTestId('source');
    await scene.getByRole('button', { name: '번역 생성', exact: true }).click();
    const live = await writer;
    live.write('미라는 **등대** 계단을 올랐다.\n\n바람이 창을');
    const streamed = scene.locator('.streaming-response .streaming-text.prose');
    await expect(streamed.locator('p').first().locator('strong')).toHaveText('등대');
    await expect(streamed.locator('.streaming-pending')).toHaveText('바람이 창을');
    await expect(scene.locator('.translation-placeholder .loading-state')).toHaveCount(0);
    await expect(scene.getByTestId('translation-text')).toHaveCount(0);
    live.write(' 두드렸다.');
    live.finish();
    await expect(scene.getByTestId('translation-text').locator('p')).toHaveText([
      '미라는 등대 계단을 올랐다.',
      '바람이 창을 두드렸다.',
    ]);
    await expect(scene.locator('.streaming-response')).toHaveCount(0);
  } finally {
    await peer.close();
  }
});
