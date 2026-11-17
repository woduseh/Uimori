import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { revealProviderModel, openProviderModel } from './ui-navigation.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import {
  selectSettingsSection,
  startProviderConnection,
  navigationAction,
} from './ui-navigation.js';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Connection, Library, ModelPreset } from '../core/product.js';

async function navigation(page: Page, name: string) {
  await navigationAction(page, name);
}
async function library(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function settings(page: Page) {
  await navigation(page, '설정');
  await selectSettingsSection(page, '프로바이더와 모델');
  await startProviderConnection(page);
  await page
    .getByRole('region', { name: '프로바이더 선택', exact: true })
    .getByRole('button', { name: /OpenAI Responses/ })
    .click();
  await expect(page.getByLabel('프로바이더 프로토콜')).toBeVisible();
  await page.getByLabel('프로바이더 프로토콜').selectOption('openai-responses-v1');
}
function observe(page: Page) {
  const errors: string[] = [],
    forbidden: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/\/(?:catalog|runs)(?:\?|$)/.test(request.url())) forbidden.push(request.url());
  });
  return { errors, forbidden };
}
async function register(
  page: Page,
  request: APIRequestContext,
  title: string,
  gateway: 'llm-gateway' | 'vercel'
) {
  await page
    .getByLabel('API 기본 주소')
    .fill(
      gateway === 'vercel' ? 'https://ai-gateway.vercel.sh/v1' : 'https://api.llmgateway.io/v1'
    );
  await page.getByLabel('프로바이더 이름', { exact: true }).fill(title);
  await page.getByLabel('API 키').fill('Evaluation_Browser_Key');
  await page.getByLabel('이 프로바이더 사용').check();
  await page.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: title + ' 프로바이더 등록됨' })
  ).toBeVisible();
  const connection = (await library(request)).connections.find((item) => item.title === title)!;
  expect(connection).toMatchObject({
    protocol: 'openai-responses-v1',
    enabled: true,
  });
  await page.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
  await page.getByLabel('모델 프리셋 이름').fill(title + ' 모델');
  await page
    .getByLabel('모델 ID', { exact: true })
    .fill(gateway === 'vercel' ? 'openai/synthetic-evaluation' : 'synthetic-evaluation');
  return connection;
}
async function saveModel(
  page: Page,
  request: APIRequestContext,
  connection: Connection
): Promise<ModelPreset> {
  await page.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: connection.title + ' 모델 모델 프리셋 등록됨' })
  ).toBeVisible();
  return (await library(request)).models.find((item) => item.connectionId === connection.id)!;
}

test(`EVALUI02 mobile ${MOBILE_WIDTH}px evaluation controls save only for opted-in presets and can be disabled`, async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const observed = observe(page);
  const title = '합성 평가 mobile ' + Date.now();
  const manualResponse = await request.post('/api/connections', {
    data: {
      title: title + ' 호환',
      protocol: 'openai-chat-v1',
      endpoint: 'http://127.0.0.1:9/v1',
      apiKey: 'Evaluation_Browser_Key',
      enabled: true,
    },
  });
  expect(manualResponse.ok()).toBeTruthy();
  const manualConnection = (await manualResponse.json()) as Connection;
  await page.goto('/');
  await settings(page);
  await expect(page.getByLabel('API 기본 주소')).toBeEditable();
  await page.getByLabel('API 기본 주소').fill('http://127.0.0.1:8080/v1');
  const connection = await register(page, request, title, 'vercel');
  await page.getByRole('button', { name: '고급', exact: true }).click();
  await expect(page.getByLabel('이 모델 프리셋에 평가 도구 사용')).not.toBeChecked();
  await page.getByLabel('이 모델 프리셋에 평가 도구 사용').check();
  await expect(page.getByLabel('평가 컨텍스트 제공')).toHaveValue('model-selected');
  await page.getByLabel('평가 컨텍스트 제공').selectOption('preloaded');
  await page.getByLabel('첫 평가 단계의 추론 설정').selectOption('economized');
  await page.getByLabel('평가 컨텍스트 제공').selectOption('model-selected');
  await expect(page.getByLabel('첫 평가 단계의 추론 설정')).toHaveCount(0);
  await expect(page.getByLabel('평가 메타데이터')).toBeVisible();
  await page.getByLabel('평가 컨텍스트 제공').selectOption('preloaded');
  await page.getByRole('button', { name: '기본', exact: true }).click();
  await page.getByLabel('프로바이더', { exact: true }).selectOption(manualConnection.id);
  await page.getByRole('button', { name: '고급', exact: true }).click();
  await expect(page.getByLabel('평가 메타데이터')).toHaveValue('neutral');
  expect(
    await page
      .getByLabel('평가 메타데이터')
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
  ).toEqual(['openai', 'anthropic', 'deepmind', 'neutral']);
  await page.getByLabel('평가 메타데이터').selectOption('deepmind');
  await page.getByRole('button', { name: '기본', exact: true }).click();
  await page.getByLabel('프로바이더', { exact: true }).selectOption(connection.id);
  await page.getByRole('button', { name: '고급', exact: true }).click();
  await expect(page.getByLabel('평가 메타데이터')).toHaveValue('OpenAI, 프로바이더 자동 선택');
  await expect(page.getByLabel('평가 메타데이터')).not.toBeEditable();
  await page.getByRole('button', { name: '기본', exact: true }).click();
  await page.getByLabel('프로바이더', { exact: true }).selectOption(manualConnection.id);
  await page.getByRole('button', { name: '고급', exact: true }).click();
  await expect(page.getByLabel('평가 메타데이터')).toHaveValue('deepmind');
  await page.getByRole('button', { name: '기본', exact: true }).click();
  await page.getByLabel('모델 프리셋 이름').fill(manualConnection.title + ' 모델');
  await page.getByLabel('모델 ID', { exact: true }).fill('synthetic-evaluation');
  await page.getByRole('button', { name: '고급', exact: true }).click();
  await page.getByLabel('평가 컨텍스트 제공').selectOption('model-selected');
  await expect(page.getByLabel('평가 메타데이터')).toHaveValue('deepmind');
  await expect(page.getByLabel('최대 평가 도구 라운드')).toHaveCount(0);
  await expect(page.getByLabel('제출할 원고의 문구 찾아 바꾸기 허용')).toHaveCount(0);
  await expect(page.getByText('기능 확인과 사용자 판단', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '모델 프리셋 등록', exact: true })).toBeEnabled();
  const model = await saveModel(page, request, manualConnection);
  expect(model.evaluationTools).toEqual({
    metadataProfile: 'deepmind',
    contextMode: 'model-selected',
    approvalReasoningMode: 'economized',
  });
  await page.reload();
  await navigation(page, '설정');
  await selectSettingsSection(page, '프로바이더와 모델');
  await revealProviderModel(page, model.title);
  await expect(page.getByText(model.title, { exact: true })).toBeVisible();
  expect((await library(request)).models.find((item) => item.id === model.id)).toEqual(model);
  expect(observed.errors).toEqual([]);
  expect(observed.forbidden).toEqual([]);
  await openProviderModel(page, model.title);
  await page.getByRole('button', { name: '고급', exact: true }).click();
  await expect(page.getByLabel('이 모델 프리셋에 평가 도구 사용')).toBeChecked();
  await expect(page.getByLabel('평가 컨텍스트 제공')).toHaveValue('model-selected');
  await expect(page.getByLabel('평가 메타데이터')).toHaveValue('deepmind');
  await expect(page.getByLabel('첫 평가 단계의 추론 설정')).toHaveCount(0);
  await page.getByLabel('평가 컨텍스트 제공').selectOption('preloaded');
  await expect(page.getByLabel('첫 평가 단계의 추론 설정')).toHaveValue('economized');
  await expect(page.getByLabel('평가 메타데이터')).toHaveValue('deepmind');
  await page.getByLabel('평가 컨텍스트 제공').selectOption('model-selected');
  await page.getByLabel('이 모델 프리셋에 평가 도구 사용').uncheck();
  await expect(page.getByLabel('평가 컨텍스트 제공')).toHaveCount(0);
  await page.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect
    .poll(async () => {
      const latest = (await library(request)).models.find((item) => item.id === model.id)!;
      return { revision: latest.revision, evaluationTools: latest.evaluationTools ?? null };
    })
    .toEqual({ revision: model.revision + 1, evaluationTools: null });
});

preservePromptWorkspace();
