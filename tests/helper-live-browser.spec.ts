import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test, type APIRequestContext } from './fixtures/browser-test.js';
import type { ModelWorkspace } from '../core/product.js';
import { sse } from './fixtures/loopback-provider.js';
import { openHelper } from './ui-navigation.js';

test.setTimeout(60_000);

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

test('HELPLIVE03 library helper text streams into the panel and keeps arriving through cursor reads when the stream is cut', async ({
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
    const next = ' 이어지는 문장.';
    written += next;
    live.write(sse({ type: 'text_delta', delta: next }));
    await expect(text).toHaveText(written);

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
