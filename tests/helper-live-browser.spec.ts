import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { HelperConversation } from '../core/helper.js';
import type { ModelWorkspace } from '../core/product.js';
import type { Chat } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { sse } from './fixtures/loopback-provider.js';
import { openHelper } from './ui-navigation.js';

test.setTimeout(90_000);

function helperReads(page: Page) {
  const paths: string[] = [];
  page.on('request', (entry) => {
    const path = new URL(entry.url()).pathname;
    if (path.startsWith('/api/helper/')) paths.push(path);
  });
  return {
    paths,
    async quiet() {
      for (;;) {
        const before = paths.length;
        await page.waitForTimeout(1000);
        if (paths.length === before) return paths.length;
      }
    },
  };
}

async function helperModel(
  request: APIRequestContext,
  respond: (response: ServerResponse) => Promise<void>
) {
  const provider = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    await respond(response);
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start');
  const baseline = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  const connection = await (
    await request.post('/api/connections', {
      data: {
        title: `실시간 도우미 연결 ${randomUUID()}`,
        protocol: 'fixture-sse-v1',
        endpoint: `http://127.0.0.1:${address.port}/`,
        enabled: true,
      },
    })
  ).json();
  const model = await (
    await request.post('/api/model-presets', {
      data: {
        title: '실시간 도우미 모델',
        connectionId: connection.id,
        modelId: 'synthetic-live-helper',
        inputTokenLimit: 200000,
        maxOutputTokens: 1024,
        temperature: null,
      },
    })
  ).json();
  const selected = await request.put('/api/model-workspace', {
    data: {
      expectedRevision: baseline.revision,
      routes: baseline.routes,
      translationPolicy: baseline.translationPolicy,
      helperModel: { id: model.id },
    },
  });
  expect(selected.ok(), await selected.text()).toBe(true);
  return async () => {
    const current = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
    await request.put('/api/model-workspace', {
      data: {
        expectedRevision: current.revision,
        routes: baseline.routes,
        translationPolicy: baseline.translationPolicy,
        helperModel: baseline.helperModel ? { id: baseline.helperModel.id } : null,
      },
    });
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  };
}

async function libraryTask(request: APIRequestContext, text: string) {
  const conversation = (await (
    await request.post('/api/helper/conversations/new', {
      data: { scope: { kind: 'library', workId: 'workspace' }, requestKey: randomUUID() },
    })
  ).json()) as HelperConversation;
  const admitted = await request.post(`/api/helper/conversations/${conversation.id}/messages`, {
    data: { requestKey: randomUUID(), text },
  });
  expect(admitted.ok(), await admitted.text()).toBe(true);
  return conversation;
}

const taskStatus = async (request: APIRequestContext, conversation: HelperConversation) =>
  (
    (await (await request.get(`/api/helper/conversations/${conversation.id}/view`)).json()) as {
      tasks: { id: string; status: string }[];
    }
  ).tasks[0];

test('HELPLIVE02 a helper task finishing on another device refreshes library and prompt data while the panel is closed', async ({
  page,
  request,
}) => {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cleanup = await helperModel(request, async (response) => {
    await finished;
    response.end(
      sse({ type: 'text_delta', delta: '다른 기기에서 끝낸 답이에요.' }) +
        sse({ type: 'usage', inputTokens: 40, outputTokens: 8, costUsd: null }) +
        sse({ type: 'done', reason: 'stop' })
    );
  });
  try {
    const reads: string[] = [];
    page.on('request', (entry) => {
      const path = new URL(entry.url()).pathname;
      if (path === '/api/library' || path === '/api/prompt-workspace') reads.push(path);
    });
    await page.goto('/');
    await expect(page.locator('#helper-panel')).toBeHidden();
    const conversation = await libraryTask(request, '패널을 닫아 둔 동안 끝낼 요청');
    await expect
      .poll(async () => (await taskStatus(request, conversation))?.status)
      .toBe('running');
    await page.waitForTimeout(1000);
    const before = reads.length;
    finish();
    await expect
      .poll(async () => (await taskStatus(request, conversation))?.status)
      .toBe('completed');
    await expect
      .poll(() => [...new Set(reads.slice(before))].sort(), { timeout: 3000 })
      .toEqual(['/api/library', '/api/prompt-workspace']);
  } finally {
    finish();
    await cleanup();
  }
});

test('HELPLIVE01 an idle open helper makes no reads, shows a finished task at once and polls again without the stream', async ({
  page,
  request,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
    }
    await held;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'text_delta', delta: '스트림으로 끝낸 답이에요.' },
      { type: 'usage', inputTokens: 40, outputTokens: 8, costUsd: null },
      { type: 'done', reason: 'stop' },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start');
  const baseline = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  try {
    const connection = await (
      await request.post('/api/connections', {
        data: {
          title: `실시간 도우미 연결 ${randomUUID()}`,
          protocol: 'fixture-sse-v1',
          endpoint: `http://127.0.0.1:${address.port}/`,
          enabled: true,
        },
      })
    ).json();
    const model = await (
      await request.post('/api/model-presets', {
        data: {
          title: '실시간 도우미 모델',
          connectionId: connection.id,
          modelId: 'synthetic-live-helper',
          inputTokenLimit: 200000,
          maxOutputTokens: 1024,
          temperature: null,
        },
      })
    ).json();
    const selected = await request.put('/api/model-workspace', {
      data: {
        expectedRevision: baseline.revision,
        routes: baseline.routes,
        translationPolicy: baseline.translationPolicy,
        helperModel: { id: model.id },
      },
    });
    expect(selected.ok(), await selected.text()).toBe(true);
    const chat = (await (
      await postFixtureChat(request, { data: { title: `실시간 도우미 ${randomUUID()}` } })
    ).json()) as Chat;
    const conversation = (await (
      await request.post('/api/helper/conversations', {
        data: { scope: { kind: 'chat', chatId: chat.id } },
      })
    ).json()) as HelperConversation;

    const reads = helperReads(page);
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    const panel = page.locator('#helper-panel');
    await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
    await expect(panel.getByText('대화를 불러오는 중이에요…', { exact: true })).toHaveCount(0);
    const settled = await reads.quiet();
    await page.waitForTimeout(15_000);
    expect(reads.paths.slice(settled)).toEqual([]);

    const admitted = await request.post(`/api/helper/conversations/${conversation.id}/messages`, {
      data: { requestKey: randomUUID(), text: '다른 기기에서 보낸 요청' },
    });
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const next = panel.getByRole('button', { name: '다음 요청', exact: true });
    const send = panel.getByRole('button', { name: '도우미 요청 보내기', exact: true });
    await expect(next).toBeVisible();
    release();
    await expect(send).toBeVisible({ timeout: 1500 });
    await expect(panel.getByText('다른 기기에서 보낸 요청', { exact: true }).first()).toBeVisible();

    await reads.quiet();
    await page.route('**/api/events**', (route) => route.abort());
    await page.evaluate(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    const degraded = reads.paths.length;
    await expect
      .poll(() => reads.paths.slice(degraded), { timeout: 20_000 })
      .toEqual(
        expect.arrayContaining([
          '/api/helper/conversations',
          `/api/helper/conversations/${conversation.id}/events`,
        ])
      );
  } finally {
    release();
    const current = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
    await request.put('/api/model-workspace', {
      data: {
        expectedRevision: current.revision,
        routes: baseline.routes,
        translationPolicy: baseline.translationPolicy,
        helperModel: baseline.helperModel ? { id: baseline.helperModel.id } : null,
      },
    });
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test('HELPLIVE03 library helper text rides the open stream without cursor reads and falls back to them when the stream is cut', async ({
  page,
  request,
}) => {
  let connected = (_response: ServerResponse) => {};
  const writer = new Promise<ServerResponse>((resolve) => {
    connected = resolve;
  });
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cleanup = await helperModel(request, async (response) => {
    connected(response);
    await finished;
    response.end(
      sse({ type: 'usage', inputTokens: 40, outputTokens: 8, costUsd: null }) +
        sse({ type: 'done', reason: 'stop' })
    );
  });
  try {
    const streamReads: string[] = [];
    page.on('request', (entry) => {
      if (new URL(entry.url()).pathname.startsWith('/api/response-streams/'))
        streamReads.push(entry.url());
    });
    await page.goto('/');
    await openHelper(page);
    const panel = page.locator('#helper-panel');
    await panel.getByLabel('도우미에게 요청').fill('서재에서 길게 답해 주세요.');
    await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
    const live = await writer;
    const text = panel.locator('.streaming-text');
    let written = '서재 도우미의 첫 문장이에요.';
    live.write(sse({ type: 'text_delta', delta: written }));
    await expect(text).toHaveText(written);
    await page.waitForTimeout(500);

    const pushedFrom = streamReads.length;
    for (let index = 0; index < 8; index++) {
      const part = ` ${index}번째 문장.`;
      written += part;
      live.write(sse({ type: 'text_delta', delta: part }));
      await expect(text).toHaveText(written);
      await page.waitForTimeout(150);
    }
    expect(streamReads.slice(pushedFrom)).toEqual([]);

    await page.route('**/api/events**', (route) => route.abort());
    await page.evaluate(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    const polledFrom = streamReads.length;
    for (let index = 0; index < 3; index++) {
      const part = ` 끊긴 동안의 ${index}번째 문장.`;
      written += part;
      live.write(sse({ type: 'text_delta', delta: part }));
      await expect(text).toHaveText(written);
    }
    expect(streamReads.length).toBeGreaterThan(polledFrom);
    finish();
    await expect(panel.getByText(written.trim(), { exact: true })).toBeVisible();
  } finally {
    finish();
    await cleanup();
  }
});
