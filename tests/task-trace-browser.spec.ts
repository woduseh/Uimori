import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { ChatTraceCall } from '../core/task-trace.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction } from './ui-navigation.js';

test.setTimeout(90_000);

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function seed(request: APIRequestContext) {
  const response = await postFixtureChat(request, {
    data: { title: `Task trace synthetic ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  const before = await detail(request, chat.id);
  const created = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '등대지기는 항구의 편지를 다시 읽고, 다음 항해에 필요한 지도를 찾아 나섰다.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: `task-trace-${chat.id}`,
    },
  });
  expect(created.ok()).toBeTruthy();
  const run = (await created.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  return { chat, run };
}

function call(
  runId: string | null,
  id: string,
  fields: Partial<ChatTraceCall> & Pick<ChatTraceCall, 'kind'>
): ChatTraceCall {
  return {
    id,
    owner: runId ? 'run' : 'chat',
    sceneRunId: runId,
    modelId: 'gemini-3-pro',
    status: 'completed',
    startedAt: null,
    elapsedMs: null,
    firstByteMs: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    internalModelCalls: null,
    costUsd: null,
    estimatedUsd: null,
    estimatedSubtotalUsd: 0,
    tools: [],
    runId,
    jobId: null,
    role: 'main',
    connectionId: 'synthetic',
    priceRevision: null,
    error: null,
    ...fields,
  };
}

function productionLike(runId: string): ChatTraceCall[] {
  const priced = (usd: number) => ({ estimatedUsd: usd, estimatedSubtotalUsd: usd });
  return [
    call(null, 'trace-input-translation', {
      kind: 'input-translation',
      modelId: 'gpt-5-mini',
      inputTokens: 420,
      outputTokens: 96,
      elapsedMs: 1900,
      ...priced(0.00031),
    }),
    call(runId, 'trace-writing-1', {
      kind: 'writing',
      status: 'tool_calls',
      inputTokens: 21_480,
      outputTokens: 212,
      cachedInputTokens: 12_800,
      reasoningTokens: 180,
      elapsedMs: 8_420,
      firstByteMs: 2_310,
      tools: [{ name: 'knowledge.read', resultChars: 11_023, elapsedMs: 60, failed: false }],
      ...priced(0.02912),
    }),
    call(runId, 'trace-writing-2', {
      kind: 'writing',
      inputTokens: 24_310,
      outputTokens: 2_890,
      cachedInputTokens: 21_000,
      reasoningTokens: 940,
      elapsedMs: 41_870,
      firstByteMs: 3_020,
      ...priced(0.2531),
    }),
    call(runId, 'trace-refusal', {
      kind: 'refusal-judgment',
      modelId: 'typesafe-jev',
      inputTokens: 2_880,
      outputTokens: 4,
      elapsedMs: 640,
      ...priced(0.00041),
    }),
    call(runId, 'trace-title', {
      kind: 'chat-title',
      role: 'title',
      modelId: 'gpt-5-mini',
      inputTokens: 610,
      outputTokens: 14,
      elapsedMs: 1_120,
      ...priced(0.00018),
    }),
    call(runId, 'trace-translation', {
      kind: 'scene-translation',
      owner: 'job',
      runId: null,
      jobId: 'trace-job',
      role: 'translation',
      modelId: 'gemini-3-flash',
      inputTokens: 5_120,
      outputTokens: 3_402,
      elapsedMs: 18_900,
      ...priced(0.01227),
    }),
    call(runId, 'trace-translation-check', {
      kind: 'translation-judgment',
      owner: 'job',
      runId: null,
      jobId: 'trace-job',
      role: 'translation',
      modelId: 'typesafe-jev',
      inputTokens: 3_610,
      outputTokens: 3,
      elapsedMs: 710,
    }),
  ];
}

async function routeTrace(page: Page, chatId: string, runId: string) {
  const calls = productionLike(runId);
  await page.route(`**/api/chats/${chatId}/attempts`, (route) => route.fulfill({ json: calls }));
  await page.route('**/api/attempts/trace-*', (route) => {
    const id = route.request().url().split('/').pop()!;
    const found = calls.find((item) => item.id === id)!;
    return route.fulfill({
      json: {
        ...found,
        role: found.role,
        request: { protocol: 'gemini-generate-content-v1', detailsOmitted: true },
        response: { detailsOmitted: true },
        rawUsage: null,
        estimatedCost: {
          status: found.estimatedUsd === null ? 'unavailable' : 'estimated',
          usd: found.estimatedUsd,
          subtotalUsd: found.estimatedSubtotalUsd,
          lines: [],
          notes: [],
        },
      },
    });
  });
  return calls;
}

async function openRecord(page: Page, chatId: string, runId: string) {
  await page.goto(`/?chat=${chatId}`);
  await navigationAction(page, '작업 현황');
  const panel = page.getByRole('dialog', { name: '작업 현황', exact: true });
  const task = panel.locator(`[data-testid="run"][data-run-id="${runId}"]`);
  await task.getByRole('button', { name: '자세히 보기', exact: true }).click();
  return { panel, task, record: task.locator('.task-history-detail') };
}

test('TRACE01 a scene record lists every call of the scene with its tool, and the summary matches the rows', async ({
  page,
  request,
}) => {
  const { chat, run } = await seed(request);
  await routeTrace(page, chat.id, run.id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { task, record } = await openRecord(page, chat.id, run.id);
  await expect(
    task.locator('.task-history-row-actions').getByRole('button', { name: '새 채팅으로 분기' })
  ).toBeVisible();
  await expect(record.locator('.task-history-section-head > h3')).toHaveText([
    '호출과 비용',
    '실행 흐름',
  ]);
  await expect(record).not.toContainText('조회 로어 유지 기록이 없어요');
  const table = record.getByRole('table', { name: '실행 흐름', exact: true });
  await expect(table.getByRole('rowheader')).toHaveText([
    /^본문/,
    /^본문/,
    /^거절 판정/,
    /^채팅 제목/,
    /^장면 번역/,
    /^번역 판정/,
  ]);
  await expect(table.locator('thead th')).not.toContainText(['보고 비용']);
  const first = table.locator('tr[data-attempt-id="trace-writing-1"]');
  await expect(first.locator('.trace-status')).toHaveText('도구 호출');
  await expect(first.locator('.trace-tools')).toHaveText('knowledge.read결과 11,023자60ms');
  await expect(first).toContainText('8.4초');
  const summary = record.locator('.trace-summary');
  await expect(summary.locator('[data-row="calls"] dd')).toContainText('모델 6회');
  await expect(summary.locator('[data-row="calls"] dd')).toContainText('장면 번역 1');
  await expect(summary.locator('[data-row="input"] dd > span').first()).toHaveText('58,010');
  await expect(summary.locator('[data-row="output"] dd > span').first()).toHaveText('6,525');
  await expect(summary.locator('[data-row="cost"] dd > span').first()).toHaveText('$0.295+');
  await expect(summary.locator('[data-row="cost"]')).toContainText('미확인 1회');
  await expect(summary.locator('.trace-summary-parts')).toHaveText(
    '본문 $0.283번역 $0.0123+채팅 제목 < $0.001'
  );
  await expect(record.locator('.trace-footer code')).toHaveText(run.id);
  await expect(record.getByRole('button', { name: '원본 JSON 보기', exact: true })).toBeVisible();
});
