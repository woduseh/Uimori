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

function trackEventStreams(page: Page, runId: string) {
  const open = new Set<unknown>();
  const cursors: string[] = [];
  const matches = (url: string) => url.includes(`/api/response-streams/main/${runId}/events`);
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

test('STREAMLIVE hiding the tab releases the main stream and resuming continues from its cursor', async ({
  page,
  request,
}) => {
  const { peer, writer, chat } = await streamingWriter(request);
  try {
    const run = await startRun(request, chat, '등대 장면을 이어 써 주세요.');
    const streams = trackEventStreams(page, run.id);
    await page.goto(`/?chat=${chat.id}`);
    const pending = page.locator(`[data-testid="pending-run"][data-run-id="${run.id}"]`);
    const live = await writer;
    const first = '미라는 등대 계단을 올랐다.';
    const second = ' 바람이 창을 두드렸다.';
    const third = ' 불빛이 바다를 갈랐다.';
    live.write(first);
    await expect(pending.locator('.streaming-text')).toHaveText(first);
    await expect.poll(streams.open).toBe(1);

    await setHidden(page, true);
    await expect.poll(streams.open).toBe(0);
    const reconnects = streams.cursors.length;
    live.write(second);
    await page.waitForTimeout(400);
    expect(streams.cursors).toHaveLength(reconnects);
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

const paragraphGeometry = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        text: element.textContent,
        height: rect.height,
        left: rect.left,
        width: rect.width,
        font: [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.color],
      };
    });

test('STREAMRENDER completed paragraphs stream with the compiler, font and line width of the finished text', async ({
  page,
  request,
}) => {
  const { peer, writer, chat } = await streamingWriter(request);
  try {
    const run = await startRun(request, chat, '두 문단으로 써 주세요.');
    await page.goto(`/?chat=${chat.id}`);
    const pending = page.locator(`[data-testid="pending-run"][data-run-id="${run.id}"]`);
    const live = await writer;
    const first = '미라는 **등대** 계단을 올랐다.';
    live.write(`${first}\n\n바람이 창을`);
    const streamed = pending.locator('.streaming-text p');
    await expect(streamed).toHaveCount(2);
    await expect(streamed.first().locator('strong')).toHaveText('등대');
    await expect(pending.locator('.streaming-pending')).toHaveText('바람이 창을');
    await settle(page);
    const before = await paragraphGeometry(page, '[data-testid="pending-run"] .streaming-text p');
    const pendingFont = await paragraphGeometry(
      page,
      '[data-testid="pending-run"] .streaming-pending'
    );
    expect(pendingFont.font).toEqual(before.font);
    live.write(' 두드렸다.');
    live.finish();
    await expect(pending).toHaveCount(0);
    await expect(page.getByTestId('source-text').locator('p')).toHaveCount(2);
    await settle(page);
    const after = await paragraphGeometry(page, '[data-testid="source-text"] p');
    expect(after).toEqual(before);
  } finally {
    await peer.close();
  }
});
