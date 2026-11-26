import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Connection, Library } from '../core/product.js';
import { selectSettingsSection } from './ui-navigation.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';

async function settings(page: Page) {
  await page.goto('/');
  const button = page.getByRole('button', { name: '설정', exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  await button.click();
  await selectSettingsSection(page, '프로바이더와 모델');
}

async function library(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

const width = MOBILE_WIDTH;
test(`PRICEUI${width} catalog fallback and manual Flex zero/unknown rates survive save and restore`, async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width, height: 1000 });
  const title = `PRICEUI${width} ${Date.now()}`;
  const created = await request.post('/api/connections', {
    data: {
      title,
      protocol: 'openai-responses-v1',
      endpoint: 'https://api.openai.com/v1',
      credentialRef: 'PM_SYNTHETIC_KEY',
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
      /(?:\/runs|\/provider-management\/models\/[^/]+\/test)$/.test(new URL(req.url()).pathname)
    )
      providerCalls.push(req.url());
  });
  await settings(page);
  await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await form.getByLabel('프로바이더', { exact: true }).selectOption(connection.id);
  await form.getByLabel('모델 프리셋 이름').fill(title);
  await form.getByLabel('모델 ID', { exact: true }).fill('gpt-5.6-sol');
  await form.getByLabel('서비스 등급', { exact: true }).selectOption('flex');
  await form.getByRole('button', { name: '고급', exact: true }).click();
  const pricing = form.getByTestId('model-pricing-editor');
  await pricing.locator('summary').first().click();
  await expect(pricing).toContainText('요금 정보가 없어요');
  await pricing.getByLabel('요금 기준').selectOption('manual');
  await pricing.getByLabel('Standard 입력 요금', { exact: true }).fill('3');
  await pricing.getByLabel('Standard 캐시 읽기 요금', { exact: true }).fill('0');
  await pricing.getByLabel('Standard 캐시 쓰기 요금', { exact: true }).fill('');
  await pricing.getByLabel('Standard 출력 요금', { exact: true }).fill('12');
  await expect(pricing).toContainText('요금 정보가 없어요');
  await pricing.getByRole('switch', { name: 'Flex 요금 직접 입력', exact: true }).check();
  await pricing.getByLabel('Flex 입력 요금', { exact: true }).fill('2');
  await pricing.getByLabel('Flex 캐시 읽기 요금', { exact: true }).fill('0');
  await pricing.getByLabel('Flex 캐시 쓰기 요금', { exact: true }).fill('');
  await pricing.getByLabel('Flex 출력 요금', { exact: true }).fill('9');
  await pricing.getByLabel('요금 출처 URL').fill('https://example.com/pricing');
  await pricing.getByLabel('요금 확인일').fill('2026-10-18');
  await pricing.getByLabel('Standard 입력 요금', { exact: true }).fill('-1');
  await expect(pricing.getByRole('alert')).toContainText('0 이상');
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(pricing.getByLabel('Standard 입력 요금', { exact: true })).toHaveValue('-1');
  expect((await library(request)).models.find((model) => model.title === title)).toBeUndefined();
  await pricing.getByLabel('Standard 입력 요금', { exact: true }).fill('3');
  await expect(pricing.getByRole('alert')).toHaveCount(0);
  await expect(pricing).not.toContainText('실제 청구액과 다를 수 있어요');
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
  await page.getByLabel('프로바이더와 모델 검색').fill(title);
  await page.getByRole('button', { name: title + ' 모델 수정', exact: true }).click();
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await pricing.locator('summary').first().click();
  await expect(pricing.getByLabel('Standard 캐시 읽기 요금', { exact: true })).toHaveValue('0');
  await expect(pricing.getByLabel('Standard 캐시 쓰기 요금', { exact: true })).toHaveValue('');
  await expect(pricing.getByLabel('Flex 입력 요금', { exact: true })).toHaveValue('2');
  await pricing.getByRole('button', { name: '모델 목록 요금으로 복원' }).click();
  await expect(pricing.getByLabel('요금 기준')).toHaveValue('official');
  await expect(pricing).toContainText('요금 정보가 없어요');
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect
    .poll(
      async () => (await library(request)).models.find((model) => model.title === title)?.pricing
    )
    .toEqual({ mode: 'official' });
  expect(errors).toEqual([]);
  expect(providerCalls).toEqual([]);
});

preservePromptWorkspace();
