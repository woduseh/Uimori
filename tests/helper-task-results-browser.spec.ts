import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { HelperConversation, HelperTaskResultsView } from '../core/helper.js';
import type { Content, ModelWorkspace } from '../core/product.js';
import type { Chat } from '../core/types.js';
import type { HelperTaskView } from '../web/useHelperConversation.js';
import { postFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { openHelper } from './ui-navigation.js';

test.setTimeout(60000);

/** Persist a real conversation and completed answer through a local synthetic SSE provider. */
async function seed(request: APIRequestContext) {
  const provider = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
      // Drain the input; this fixture does not claim model-quality or live-provider coverage.
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      [
        { type: 'text_delta', delta: '요청 내용을 확인했어요.' },
        { type: 'usage', inputTokens: 120, outputTokens: 12, costUsd: null },
        { type: 'done', reason: 'stop' },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('')
    );
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start');
  const baselineResponse = await request.get('/api/model-workspace');
  expect(baselineResponse.ok()).toBe(true);
  const baseline = (await baselineResponse.json()) as ModelWorkspace;
  let selected = false;
  try {
    const connection = await request.post('/api/connections', {
      data: {
        title: `결과 검증 연결 ${randomUUID()}`,
        protocol: 'fixture-sse-v1',
        endpoint: `http://127.0.0.1:${address.port}/`,
        enabled: true,
      },
    });
    expect(connection.ok(), await connection.text()).toBe(true);
    const model = await request.post('/api/model-presets', {
      data: {
        title: '결과 검증 도우미',
        connectionId: (await connection.json()).id,
        modelId: 'synthetic-results-helper',
        inputTokenLimit: 272000,
        maxOutputTokens: 1024,
        temperature: null,
      },
    });
    expect(model.ok(), await model.text()).toBe(true);
    const selection = await request.put('/api/model-workspace', {
      data: {
        expectedRevision: baseline.revision,
        routes: baseline.routes,
        translationPolicy: baseline.translationPolicy,
        helperModel: { id: (await model.json()).id },
      },
    });
    expect(selection.ok(), await selection.text()).toBe(true);
    selected = true;
    const created = await postFixtureChat(request, {
      data: { title: `도우미 결과 ${randomUUID()}` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const chat = (await created.json()) as Chat;
    const opened = await request.post('/api/helper/conversations', {
      data: { scope: { kind: 'chat', chatId: chat.id } },
    });
    expect(opened.ok(), await opened.text()).toBe(true);
    const conversation = (await opened.json()) as HelperConversation;
    const admitted = await request.post(`/api/helper/conversations/${conversation.id}/messages`, {
      data: { requestKey: randomUUID(), text: '자료를 변경하지 않고 간단히 답해 주세요.' },
    });
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const task = (await admitted.json()) as HelperTaskView;
    await expect
      .poll(async () => {
        const current = await request.get(`/api/helper/tasks/${task.id}`);
        expect(current.ok()).toBe(true);
        return ((await current.json()) as HelperTaskView).status;
      })
      .toBe('completed');
    return { chat, task, conversation };
  } finally {
    try {
      if (selected) {
        const current = (await (
          await request.get('/api/model-workspace')
        ).json()) as ModelWorkspace;
        const restored = await request.put('/api/model-workspace', {
          data: {
            expectedRevision: current.revision,
            routes: baseline.routes,
            translationPolicy: baseline.translationPolicy,
            helperModel: baseline.helperModel ?? null,
          },
        });
        expect(restored.ok(), await restored.text()).toBe(true);
        expect(await (await request.get('/api/model-workspace')).json()).toEqual({
          ...baseline,
          revision: expect.any(Number),
        });
      }
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
}

const usageValue = (results: Locator, label: string) =>
  results
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`, 'u') })
    .locator('xpath=following-sibling::dd[1]');

test('HRESULT01 ordinary answers show usage without a permanent empty-change message', async ({
  page,
  request,
}) => {
  const { chat, task } = await seed(request);
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const answer = page.locator(`.helper-message.assistant[data-task-id="${task.id}"]`);
  await expect(answer).toContainText('요청 내용을 확인했어요.');
  const results = answer.getByTestId('helper-task-results');
  const summary = results.locator('summary');
  await expect(summary).toContainText('사용량');
  await expect(summary).toContainText('입력 120 · 출력 12 토큰');
  await expect(summary).not.toContainText('도구');
  await expect(summary).not.toContainText('일부 미확인');
  await expect(results.locator('.helper-result-note')).toHaveCount(0);
  await expect(results.locator('.helper-result-list > li')).toHaveCount(0);
  await results.locator('summary').click();
  await expect(usageValue(results, '모델 실행 요청')).toHaveText('1');
  await expect(usageValue(results, '확인된 비용')).toHaveText('미확인');
});

for (const width of DEFAULT_WIDTHS) {
  test(`HRESULT02 actual results retain partial usage and recover from refresh/open failures at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const { chat, task } = await seed(request);
    const created = await request.post('/api/content', {
      data: fixtureBotInput('다시 열어 볼 저장 자료'),
    });
    expect(created.ok(), await created.text()).toBe(true);
    const content = (await created.json()) as Content;
    // Only the new result projection is synthetic; admission, saved messages and navigation are real.
    const projection: HelperTaskResultsView = {
      taskId: task.id,
      status: 'completed',
      results: [
        {
          eventSeq: 10,
          receiptId: 'saved',
          operation: 'resource.patch',
          requestedTargets: 1,
          changedTargets: 1,
          targets: [
            { kind: 'content', id: content.id, title: content.title, revision: content.revision },
          ],
        },
        {
          eventSeq: 11,
          receiptId: 'deleted',
          operation: 'resource.delete',
          requestedTargets: 1,
          changedTargets: 1,
          targets: [
            { kind: 'content', id: 'deleted-resource', title: '삭제한 이전 자료', revision: 2 },
          ],
        },
        {
          eventSeq: 12,
          receiptId: 'settings',
          operation: 'settings.update',
          requestedTargets: 1,
          changedTargets: 1,
          targets: [
            {
              kind: 'settings',
              id: 'global',
              title: '공통 설정',
              revision: 2,
              setting: 'global.helperModel',
              before: 'old-id',
              after: 'new-id',
              beforeLabel: '이전 도우미',
              afterLabel: '새 도우미',
            },
          ],
        },
      ],
      unrecordedOperations: 0,
      usage: {
        toolExecutions: 7,
        latestInputEstimate: 850,
        attempts: [
          {
            id: 'known',
            purpose: 'helper',
            status: 'completed',
            inputTokens: 1000,
            outputTokens: 90,
            cachedInputTokens: 600,
            reasoningTokens: 30,
            costUsd: 0.02,
            internalModelCalls: 2,
          },
          {
            id: 'unknown',
            purpose: 'helper',
            status: 'error',
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            reasoningTokens: null,
            costUsd: null,
            internalModelCalls: null,
          },
        ],
      },
    };
    let refreshFails = false;
    let reads = 0;
    await page.route(`**/api/helper/tasks/${task.id}/results`, async (route) => {
      reads++;
      await route.fulfill(
        refreshFails
          ? { status: 503, json: { error: 'SYNTHETIC_RESULT_REFRESH_FAILURE' } }
          : { json: projection }
      );
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    const results = page
      .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
      .getByTestId('helper-task-results');
    const saved = results.getByRole('button', { name: `${content.title} 열기`, exact: true });
    await expect(saved).toBeVisible();
    await expect(results.getByText('삭제한 이전 자료', { exact: true })).toBeVisible();
    await expect(results.getByText('삭제됨', { exact: true })).toBeVisible();
    await expect(
      results.getByRole('button', { name: '삭제한 이전 자료 열기', exact: true })
    ).toHaveCount(0);
    await expect(results.getByText('이전 도우미', { exact: true })).toBeVisible();
    await expect(results.getByText('새 도우미', { exact: true })).toBeVisible();
    await expect(results.locator('summary')).toContainText('입력 1,000 · 출력 90 토큰');
    await expect(results.locator('summary')).toContainText('도구 7회');
    await expect(results.locator('summary')).toContainText('일부 미확인');
    await results.locator('summary').click();
    await expect(usageValue(results, '모델 실행 요청')).toHaveText('2');
    await expect(usageValue(results, '도구 실행')).toHaveText('7');
    await expect(usageValue(results, '누적 입력 토큰')).toHaveText('1,000미확인 1회');
    await expect(usageValue(results, '입력 중 캐시 토큰')).toHaveText('600미확인 1회');
    await expect(usageValue(results, '누적 출력 토큰')).toHaveText('90미확인 1회');
    await expect(usageValue(results, '출력 중 추론 토큰')).toHaveText('30미확인 1회');
    await expect(usageValue(results, '확인된 비용')).toHaveText('US$0.02미확인 1회');
    await expect(usageValue(results, '마지막 입력 추정 토큰')).toHaveText('850');
    await expect(results).not.toContainText('%');
    await expect(results.getByRole('meter')).toHaveCount(0);
    projection.usage.latestInputLimit = 1000;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const inputMeter = results.getByRole('meter', {
      name: '입력 예산 대비 마지막 전송 입력 추정치',
    });
    await expect(inputMeter).toHaveAttribute('max', '1000');
    await expect(inputMeter).toHaveAttribute('value', '850');
    await expect(usageValue(results, '마지막 입력 추정 토큰')).toContainText('850 / 1,00085%');
    refreshFails = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(results.getByRole('alert')).toContainText('결과를 새로 확인하지 못했어요.');
    await expect(saved).toBeVisible();
    await expect(usageValue(results, '누적 입력 토큰')).toHaveText('1,000미확인 1회');
    const beforeRetry = reads;
    refreshFails = false;
    await results.getByRole('button', { name: '다시 불러오기', exact: true }).click();
    await expect.poll(() => reads).toBeGreaterThan(beforeRetry);
    await expect(results.getByRole('alert')).toHaveCount(0);
    let releaseOpen = () => {};
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    await page.route(`**/api/content/${content.id}`, async (route) => {
      await openGate;
      await route.fulfill({ status: 503, json: { error: 'SYNTHETIC_OPEN_FAILURE' } });
    });
    try {
      await saved.click();
      await expect(saved).toBeDisabled();
    } finally {
      releaseOpen();
    }
    await expect(results.getByRole('alert')).toContainText('결과를 열지 못했어요.');
    await expect(saved).toBeEnabled();
    expect(await results.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`helper-results-${width}.png`), fullPage: true });
  });
}
