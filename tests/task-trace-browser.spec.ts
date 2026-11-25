import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { ChatTraceCall } from '../core/task-trace.js';
import type { Chat, ChatDetail, ReaderRun, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction } from './ui-navigation.js';

test.setTimeout(90_000);

const shots = process.env.UIMORI_TRACE_SHOTS;
async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false });
}

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

test('TRACE02 a call expands in place under its row and the chat-wide totals stay collapsed and named', async ({
  page,
  request,
}) => {
  const { chat, run } = await seed(request);
  await routeTrace(page, chat.id, run.id);
  const themes = await (await request.get('/api/themes')).json();
  const named = themes.themes.find(
    (theme: { id: string }) => theme.id !== themes.preferences.defaultThemeId
  );
  for (const [width, scheme] of [
    [1440, 'dark'],
    [1440, 'light'],
    [640, 'light'],
    [390, 'light'],
    [360, 'dark'],
  ] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: width > 600 ? 1000 : 844 });
    const { panel, record } = await openRecord(page, chat.id, run.id);
    const table = record.getByRole('table', { name: '실행 흐름', exact: true });
    const row = table.locator('tr[data-attempt-id="trace-writing-2"]');
    const button = row.getByRole('button', { name: '본문 gemini-3-pro 호출 상세' });
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(row).toHaveAttribute('data-expanded', 'true');
    const detailRow = row.locator('xpath=following-sibling::tr[1]');
    await expect(detailRow).toHaveAttribute('id', (await button.getAttribute('aria-controls'))!);
    await expect(detailRow.getByRole('region', { name: '호출 추정 비용' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    expect(
      await record
        .locator('.trace-calls')
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
    ).toBe(true);
    await detailRow.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    expect(await panel.evaluate((node) => node.scrollTop)).toBe(0);
    await shot(page, `scene-record-${width}-${scheme}`);
    const chatUsage = panel.getByTestId('usage-inspector');
    await expect(chatUsage).not.toHaveAttribute('open');
    await expect(chatUsage.locator(':scope > summary')).toHaveText('이 채팅 전체 누적 사용량');
    if ((width === 1440 && scheme === 'dark') || width === 390) {
      await chatUsage.locator(':scope > summary').click();
      await expect(
        chatUsage.getByRole('heading', { name: '장면에 속하지 않은 호출 (1회)' })
      ).toBeVisible();
      const outside = chatUsage.getByRole('table', { name: '장면에 속하지 않은 호출 (1회)' });
      await expect(outside.getByRole('rowheader')).toHaveText([/^입력 번역/]);
      await chatUsage.scrollIntoViewIfNeeded();
      if (width === 390) {
        const sends = chatUsage.locator('.trace-totals td').first();
        expect(
          await sends.evaluate((node) => getComputedStyle(node, '::before').content)
        ).toContain('전송 시도');
      }
      await shot(page, `chat-wide-${width}-${scheme}`);
    }
  }
  if (named) {
    const catalog = await (await request.get('/api/themes')).json();
    const selected = await request.post('/api/themes/selection', {
      data: {
        scope: 'chat',
        themeId: named.id,
        targetId: chat.id,
        expectedRevision: catalog.preferences.revision,
      },
    });
    expect(selected.ok(), await selected.text()).toBe(true);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { panel, record } = await openRecord(page, chat.id, run.id);
    await record
      .locator('tr[data-attempt-id="trace-writing-1"]')
      .getByRole('button', { name: /호출 상세/ })
      .click();
    expect(await panel.evaluate((node) => node.scrollTop)).toBe(0);
    await shot(page, `scene-record-1440-theme-${named.id.replace(/[^a-z0-9-]+/giu, '-')}`);
  }
});

test('TRACE03 the scene list totals use the scene scope of each run', async ({ page, request }) => {
  const { chat, run } = await seed(request);
  await routeTrace(page, chat.id, run.id);
  await page.route(`**/api/chats/${chat.id}/reader-runs`, async (route) => {
    const response = await route.fetch();
    const runs = (await response.json()) as ReaderRun[];
    for (const item of runs) {
      if (item.id !== run.id) continue;
      item.sceneCost = { usd: 0.2951, subtotalUsd: 0.2951, unknownCount: 0, attemptCount: 6 };
      item.sceneTokens = {
        inputTokens: 58010,
        outputTokens: 6525,
        inputPartial: false,
        outputPartial: true,
      };
    }
    await route.fulfill({ response, json: runs });
  });
  await page.goto(`/?chat=${chat.id}`);
  await navigationAction(page, '작업 현황');
  const panel = page.getByRole('dialog', { name: '작업 현황', exact: true });
  await expect(panel.locator('.task-history-summary dd').nth(1)).toHaveText(
    '입력 58,010 / 출력 6,525+'
  );
  await expect(panel.locator(`[data-run-id="${run.id}"] .task-history-meta`)).toContainText(
    '64,535 토큰+'
  );
  await expect(panel.locator('.task-history-summary dd').nth(2)).toHaveText('$0.295');
  await expect(panel.locator(`[data-run-id="${run.id}"] .task-history-meta`)).toContainText(
    '$0.295'
  );
});

test('TRACE04 mixed role usage keeps known amounts and scene record fetch failures can be retried', async ({
  page,
  request,
}) => {
  const { chat, run } = await seed(request);
  let blocked = true;
  await page.route(`**/api/runs/${run.id}`, (route) =>
    blocked
      ? route.fulfill({ status: 503, json: { error: 'Record unavailable' } })
      : route.continue()
  );
  const calls = [
    call(run.id, 'known', {
      kind: 'writing',
      inputTokens: 80,
      outputTokens: 12,
      costUsd: 0.125,
      estimatedUsd: 0.03,
    }),
    call(run.id, 'missing', {
      kind: 'writing',
      tools: [{ name: 'data.exec', failed: true, elapsedMs: 1, resultChars: 0 }],
    }),
    call(run.id, 'free', { kind: 'chat-title', estimatedUsd: 0 }),
    call(run.id, 'unpriced', { kind: 'scene-translation', owner: 'job' }),
  ];
  await page.route(`**/api/chats/${chat.id}/attempts`, (route) => route.fulfill({ json: calls }));
  const { panel, record } = await openRecord(page, chat.id, run.id);
  await expect(record.getByRole('button', { name: '다시 불러오기' })).toBeVisible();
  blocked = false;
  await record.getByRole('button', { name: '다시 불러오기' }).click();
  await expect(record.getByRole('button', { name: '원본 JSON 보기' })).toBeVisible();
  await expect(record.locator('.trace-tools')).toContainText('오류');
  await expect(record.locator('.trace-summary-parts')).toContainText('번역 미확인');
  await expect(record.locator('.trace-summary-parts')).toContainText('채팅 제목 $0');
  const usage = panel.getByTestId('usage-inspector');
  await usage.locator('summary').click();
  const row = usage.locator('.trace-totals tr[data-kind="writing"]');
  await expect(row.locator('[data-label="입력"]')).toHaveText('80미확인 1회');
  await expect(row.locator('[data-label="보고 비용"]')).toHaveText('$0.125미확인 1회');
  await expect(row.locator('[data-label="추정 비용"]')).toHaveText('$0.03+');
});
