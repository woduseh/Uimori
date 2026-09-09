import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Attempt, Connection, Library } from '../core/product.js';
import type { Chat, ChatDetail, ReaderDetail, Run } from '../core/types.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';

async function settings(page: Page) {
  await page.goto('/');
  const button = page.getByRole('button', { name: '설정', exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  await button.click();
  await selectSettingsSection(page, '연결과 모델');
}

async function library(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

for (const width of [390, 1440]) {
  test(`PRICEUI${width} official Flex and manual zero/unknown rates survive save and restore`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const title = `PRICEUI${width} ${Date.now()}`;
    const created = await request.post('/api/connections', {
      data: {
        title,
        protocol: 'openai-responses-v1',
        endpoint: 'https://api.openai.com/v1',
        credentialEnv: 'PM_SYNTHETIC_KEY',
        enabled: false,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const connection = (await created.json()) as Connection;
    const errors: string[] = [];
    const providerCalls: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (req) => {
      if (
        req.method() === 'POST' &&
        /\/(runs|response-test|connection-test)$/.test(new URL(req.url()).pathname)
      )
        providerCalls.push(req.url());
    });
    await settings(page);
    await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
    const form = page.getByRole('form', { name: '모델 편집 양식' });
    await form.getByLabel('모델 연결').selectOption(connection.id);
    await form.getByLabel('모델 프리셋 이름').fill(title);
    await form.getByLabel('모델 ID', { exact: true }).fill('gpt-5.6-sol');
    await form.getByRole('button', { name: '고급', exact: true }).click();
    await form.getByLabel('Service Tier', { exact: true }).selectOption('flex');
    const pricing = form.getByTestId('model-pricing-editor');
    await pricing.locator('summary').first().click();
    await expect(pricing).toContainText('공식 요금');
    await expect(pricing).toContainText('50%');
    await expect(pricing.getByRole('link', { name: '요금 출처' })).toHaveAttribute(
      'href',
      /https:\/\//
    );
    await pricing.getByLabel('요금 기준').selectOption('manual');
    await pricing.getByLabel('Standard 입력 요금', { exact: true }).fill('3');
    await pricing.getByLabel('Standard 캐시 읽기 요금', { exact: true }).fill('0');
    await pricing.getByLabel('Standard 캐시 쓰기 요금', { exact: true }).fill('');
    await pricing.getByLabel('Standard 출력 요금', { exact: true }).fill('12');
    await expect(pricing).toContainText('요금은 미확인');
    await pricing.getByRole('switch', { name: 'Flex 요금 직접 입력', exact: true }).check();
    await pricing.getByLabel('Flex 입력 요금', { exact: true }).fill('2');
    await pricing.getByLabel('Flex 캐시 읽기 요금', { exact: true }).fill('0');
    await pricing.getByLabel('Flex 캐시 쓰기 요금', { exact: true }).fill('');
    await pricing.getByLabel('Flex 출력 요금', { exact: true }).fill('9');
    await pricing.getByLabel('Standard 입력 요금', { exact: true }).fill('-1');
    await expect(pricing.getByRole('alert')).toContainText('0 이상의 유한한 숫자');
    await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
    await expect(pricing.getByLabel('Standard 입력 요금', { exact: true })).toHaveValue('-1');
    expect((await library(request)).models.find((model) => model.title === title)).toBeUndefined();
    await pricing.getByLabel('Standard 입력 요금', { exact: true }).fill('3');
    await expect(pricing.getByRole('alert')).toHaveCount(0);
    await expect(pricing).toContainText('실제 청구액과 다를 수 있어요');
    expect(await pricing.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await pricing.screenshot({ path: info.outputPath(`model-pricing-${width}.png`) });
    await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
    await expect
      .poll(async () => (await library(request)).models.find((model) => model.title === title))
      .toMatchObject({
        pricing: {
          mode: 'manual',
          rates: { input: 3, cacheRead: 0, cacheWrite: null, output: 12 },
          flexRates: { input: 2, cacheRead: 0, cacheWrite: null, output: 9 },
        },
      });
    await settings(page);
    await page.getByLabel('연결·모델 검색').fill(title);
    await page.getByRole('button', { name: title + ' 모델 수정', exact: true }).click();
    await form.getByRole('button', { name: '고급', exact: true }).click();
    await pricing.locator('summary').first().click();
    await expect(pricing.getByLabel('Standard 캐시 읽기 요금', { exact: true })).toHaveValue('0');
    await expect(pricing.getByLabel('Standard 캐시 쓰기 요금', { exact: true })).toHaveValue('');
    await expect(pricing.getByLabel('Flex 입력 요금', { exact: true })).toHaveValue('2');
    await pricing.getByRole('button', { name: '공식 요금으로 복원' }).click();
    await expect(pricing.getByLabel('요금 기준')).toHaveValue('official');
    await expect(pricing).toContainText('50%');
    await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
    await expect
      .poll(
        async () => (await library(request)).models.find((model) => model.title === title)?.pricing
      )
      .toEqual({ mode: 'official' });
    expect(errors).toEqual([]);
    expect(providerCalls).toEqual([]);
  });
}

test('PRICECOST01 source and attempt cost disclosures separate actual, estimated and unavailable amounts', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  // The run uses the local scripted fixture; monetary payloads below are presentation fixtures.
  const created = await postFixtureChat(request, { data: { title: 'PRICECOST01 합성 비용 화면' } });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = (await created.json()) as Chat;
  const configured = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...chat.settings,
      translation: false,
      status: false,
      expectedSettingsRevision: chat.settingsRevision,
    },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  const detail = async (): Promise<ChatDetail> => {
    const response = await request.get(`/api/chats/${chat.id}`);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const before = await detail();
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '등대지기는 항구에서 편지를 읽고 다음 항해를 준비했다.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      expectedProfileRevision: before.profile!.revision,
      idempotencyKey: `pricecost-${chat.id}`,
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const run = (await started.json()) as Run;
  await expect
    .poll(async () => (await detail()).runs.find((item) => item.id === run.id)?.status)
    .toBe('completed');
  const known: Attempt = {
    id: 'pricecost-known',
    runId: run.id,
    jobId: null,
    role: 'main',
    connectionId: 'synthetic',
    modelId: 'priced-fixture',
    status: 'completed',
    inputTokens: 1500,
    outputTokens: 100,
    costUsd: 0.125,
    priceRevision: null,
    error: null,
    request: { protocol: 'anthropic-messages-v1' },
    response: {},
    rawUsage: {
      input_tokens: 1000,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 100,
      output_tokens: 100,
    },
    pricingSnapshot: {
      version: 1,
      protocol: 'anthropic-messages-v1',
      modelId: 'priced-fixture',
      source: 'manual',
      checkedAt: '2026-09-09T00:00:00Z',
      serviceTier: 'standard',
      rates: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
      notes: [],
    },
    estimatedCost: {
      status: 'estimated',
      usd: 0.004995,
      subtotalUsd: 0.004995,
      notes: [],
      lines: [
        { kind: 'input', tokens: 1000, rate: 3, usd: 0.003 },
        { kind: 'cacheRead', tokens: 400, rate: 0.3, usd: 0.00012 },
        { kind: 'cacheWrite', tokens: 100, rate: 3.75, usd: 0.000375 },
        { kind: 'output', tokens: 100, rate: 15, usd: 0.0015 },
      ],
    },
  };
  const unknown: Attempt = {
    ...known,
    id: 'pricecost-unknown',
    modelId: 'unpriced-fixture',
    costUsd: null,
    pricingSnapshot: undefined,
    estimatedCost: {
      status: 'unavailable',
      usd: null,
      subtotalUsd: 0,
      lines: [],
      notes: ['PRICING_UNAVAILABLE'],
    },
  };
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as ReaderDetail;
    for (const item of payload.runs)
      if (item.id === run.id)
        item.estimatedCost = {
          usd: null,
          subtotalUsd: 0.004995,
          unknownCount: 1,
          attemptCount: 2,
        };
    await route.fulfill({ response, json: payload });
  });
  await page.route(`**/api/chats/${chat.id}/attempts`, (route) =>
    route.fulfill({
      json: [known, unknown].map(
        ({ request: _request, response: _response, rawUsage: _usage, ...summary }) => summary
      ),
    })
  );
  await page.route('**/api/attempts/pricecost-*', (route) =>
    route.fulfill({ json: route.request().url().endsWith(known.id) ? known : unknown })
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/?chat=${chat.id}`);
    const sourceCost = page.locator('.source-estimated-cost');
    await expect(sourceCost).toContainText('확인분 부분합 $0.004995 · 미확인 1회 포함');
    await sourceCost.locator('summary').click();
    await expect(sourceCost).toContainText('실제 청구액과 다를 수 있어요');
    await expect(sourceCost).toContainText('전체 추정 비용은 아직 미확인');
    await sourceCost.screenshot({ path: info.outputPath(`estimate-cost-source-${width}.png`) });
    await navigationAction(page, '작업 현황');
    const dialog = page.getByRole('dialog', { name: '작업 현황', exact: true });
    const usage = dialog.getByTestId('usage-inspector');
    await usage.locator(':scope > details > summary').click();
    await expect(usage).toContainText('전송 시도 2회');
    await expect(usage).toContainText('확인분 부분합 $0.004995 · 1회 미확인 항목 포함');
    await expect(
      usage
        .getByRole('row')
        .filter({ has: page.getByRole('rowheader', { name: '원문', exact: true }) })
    ).toContainText('미확인');
    await usage.locator('summary').filter({ hasText: '원문 · priced-fixture · completed' }).click();
    const pricing = usage.getByRole('region', { name: '호출 추정 비용' });
    await expect(pricing).toContainText('공급자 보고 비용: $0.125');
    await expect(pricing).toContainText('추정 비용: $0.004995');
    const table = pricing.getByRole('table', { name: '호출 추정 비용 계산 내역' });
    await expect(table.getByRole('rowheader')).toHaveText([
      '입력',
      '캐시 읽기',
      '캐시 쓰기',
      '출력',
    ]);
    await expect(table.getByRole('row').filter({ hasText: '캐시 읽기' })).toContainText('400');
    await expect(table.getByRole('row').filter({ hasText: '캐시 쓰기' })).toContainText('100');
    await expect(usage).toContainText('공급자 보고 캐시 토큰 · 읽기 400 / 쓰기 100');
    await expect(pricing).toContainText('실제 청구액과 다를 수 있어요');
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await pricing.screenshot({ path: info.outputPath(`estimate-cost-${width}.png`) });
    await usage
      .locator('summary')
      .filter({ hasText: '원문 · unpriced-fixture · completed' })
      .click();
    const unavailable = usage.getByRole('region', { name: '호출 추정 비용' }).last();
    await expect(unavailable).toContainText('공급자 보고 비용: 미확인');
    await expect(unavailable).toContainText('추정 비용: 미확인');
    await expect(unavailable).toContainText('이 호출에 사용할 요금을 확인하지 못했어요');
    await expect(unavailable).not.toContainText('PRICING_UNAVAILABLE');
  }
  expect(errors).toEqual([]);
});

preservePromptWorkspace();
