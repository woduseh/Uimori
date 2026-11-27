import { expect, test, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import type { JevProviderStatus } from '../core/jev-provider.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { MOBILE_WIDTH, MOBILE_HEIGHT } from './fixtures/browser-viewports.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

const endpoint = '/api/provider-management/jev';
const syntheticKey = 'jev-browser-synthetic-never-send-externally';

async function connection(request: APIRequestContext): Promise<JevProviderStatus> {
  const response = await request.get(endpoint);
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.headers()['cache-control']).toContain('no-store');
  return response.json();
}

async function saveKey(request: APIRequestContext, apiKey = syntheticKey) {
  const response = await request.put(endpoint, {
    data: { expectedRevision: (await connection(request)).revision, apiKey },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<JevProviderStatus>;
}

async function removeKey(request: APIRequestContext) {
  const current = await connection(request);
  if (!current.hasSavedKey) return;
  const response = await request.delete(endpoint, {
    data: { expectedRevision: current.revision },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function resetJudgmentSettings(request: APIRequestContext) {
  const { settings } = await connection(request);
  if (!settings.images && !settings.longContext) return;
  const response = await request.put(`${endpoint}/settings`, {
    data: { expectedRevision: settings.revision, images: false, longContext: false },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function openJev(page: Page) {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '프로바이더와 모델');
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page
    .getByRole('button', { name: '새 프로바이더 입력', exact: true })
    .or(page.getByRole('button', { name: '프로바이더 추가', exact: true }))
    .click();
  await page
    .getByRole('region', { name: '프로바이더 선택' })
    .getByRole('button', { name: 'TypeSafe AI 서버 API 키 인증' })
    .click();
  const section = page.getByRole('region', { name: 'TypeSafe AI 프로바이더 설정', exact: true });
  await expect(section.getByLabel('JEV API 키', { exact: true })).toBeEnabled();
  return section;
}

async function openJevModel(page: Page) {
  await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  const group = page
    .getByRole('region', { name: '저장한 모델 프리셋', exact: true })
    .locator('.provider-model-group')
    .filter({ hasText: 'TypeSafe AI' });
  if ((await group.getAttribute('open')) === null) await group.locator(':scope > summary').click();
  await page.getByRole('button', { name: 'JEV 모델 설정', exact: true }).click();
  const section = page.getByRole('region', { name: 'JEV 모델 설정', exact: true });
  await expect(section.getByText('jev-latest', { exact: true })).toBeVisible();
  return section;
}

test.beforeEach(async ({ page, request }) => {
  await removeKey(request);
  await resetJudgmentSettings(request);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  await page.route('**/api/provider-management/jev/test', (route) =>
    route.abort('blockedbyclient')
  );
});

test.afterEach(async ({ request }) => {
  await removeKey(request);
  await resetJudgmentSettings(request);
});

test('JEVUI01 saves and removes a server key without exposing it or changing writing models', async ({
  page,
  request,
}) => {
  const beforeLibrary = await (await request.get('/api/library')).json();
  const beforeModels = await (await request.get('/api/model-workspace')).json();
  const section = await openJev(page);
  await expect(section.getByText('등록되지 않음', { exact: true })).toBeVisible();
  const key = section.getByLabel('JEV API 키', { exact: true });
  const save = section.getByRole('button', { name: 'JEV API 키 저장', exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await expect(save).toBeDisabled();
  await expect(section.getByRole('button', { name: 'JEV 연결 테스트', exact: true })).toHaveCount(
    0
  );
  await key.fill(syntheticKey);
  await save.click();
  await expect(key).toHaveValue('');
  await expect(section.getByText('Uimori에 저장한 키', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'JEV 연결 테스트', exact: true })).toHaveCount(
    0
  );
  const saved = await connection(request);
  expect(saved).toMatchObject({ configured: true, hasSavedKey: true, credentialSource: 'saved' });
  await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  const modelList = page.getByRole('region', { name: '저장한 모델 프리셋', exact: true });
  const typeSafeGroup = modelList
    .locator('.provider-model-group')
    .filter({ hasText: 'TypeSafe AI' });
  const modelRow = page.getByRole('article', { name: 'JEV 모델', exact: true });
  await expect(typeSafeGroup.getByText('모델 1개', { exact: true })).toBeVisible();
  await expect(modelRow).toBeHidden();
  await typeSafeGroup.locator(':scope > summary').click();
  await expect(modelRow).toBeVisible();
  await expect(modelRow.getByLabel('JEV 모델 메뉴', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'JEV 모델 설정', exact: true }).click();
  const modelSection = page.getByRole('region', { name: 'JEV 모델 설정', exact: true });
  await expect(modelSection).toBeVisible();
  await expect(modelSection.getByText('jev-latest', { exact: true })).toBeVisible();
  await expect(modelSection.getByLabel('JEV API 키', { exact: true })).toBeHidden();
  await expect(
    modelSection.getByRole('button', { name: 'JEV 연결 테스트', exact: true })
  ).toBeEnabled();
  await modelSection.getByRole('button', { name: '프로바이더 설정', exact: true }).click();
  await expect(section).toBeVisible();
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await expect(
    page.getByRole('article', { name: 'TypeSafe AI 프로바이더', exact: true })
  ).toBeVisible();
  await expect(page.getByLabel('TypeSafe AI 프로바이더 메뉴', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'TypeSafe AI 프로바이더 수정', exact: true }).click();
  await expect(page.getByRole('button', { name: 'JEV 판단 연결', exact: true })).toHaveCount(0);
  expect(saved).not.toHaveProperty('apiKey');
  expect(JSON.stringify(saved)).not.toContain(syntheticKey);
  const afterLibrary = await (await request.get('/api/library')).json();
  expect(JSON.stringify(afterLibrary)).not.toContain(syntheticKey);
  expect(afterLibrary.connections).toEqual(beforeLibrary.connections);
  expect(afterLibrary.models).toEqual(beforeLibrary.models);
  expect(await (await request.get('/api/model-workspace')).json()).toEqual(beforeModels);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  ).not.toContain(syntheticKey);

  await openJev(page);
  await expect(key).toHaveValue('');
  await expect(section.getByText('Uimori에 저장한 키', { exact: true })).toBeVisible();
  await section.getByRole('button', { name: '저장한 JEV 키 삭제', exact: true }).click();
  await expect(section.getByText('등록되지 않음', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'JEV 연결 테스트', exact: true })).toHaveCount(
    0
  );
  expect(await connection(request)).toMatchObject({ configured: false, hasSavedKey: false });
});

test('JEVUI03 an uncertain test resubmits the same idempotency key and the next test uses a new one', async ({
  page,
  request,
}) => {
  const current = await saveKey(request);
  const submissions: Array<{ expectedRevision: number; idempotencyKey: string }> = [];
  const polls: string[] = [];
  const base: ProviderConnectionTest = {
    id: 'jev-synthetic-success',
    modelId: 'typesafe-judgment',
    modelRevision: current.revision,
    providerModelId: 'jev-latest',
    connectionId: 'typesafe-judgment',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    text: '',
    truncated: false,
    latencyMs: null,
    error: null,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
  };
  await page.route('**/api/provider-management/jev/test', async (route) => {
    submissions.push(route.request().postDataJSON());
    expect(route.request().postData()).not.toContain(syntheticKey);
    if (submissions.length === 1) {
      await route.fulfill({ status: 503, json: { error: 'SYNTHETIC_RESPONSE_LOST' } });
    } else {
      await route.fulfill({
        status: 202,
        json: { ...base, id: submissions.length === 2 ? base.id : 'jev-synthetic-auth-error' },
      });
    }
  });
  await page.route('**/api/provider-management/tests/jev-synthetic-*', async (route) => {
    polls.push(route.request().url());
    const authError = route.request().url().endsWith('jev-synthetic-auth-error');
    await route.fulfill({
      json: {
        ...base,
        id: authError ? 'jev-synthetic-auth-error' : base.id,
        finishedAt: new Date().toISOString(),
        status: authError ? 'error' : 'completed',
        text: authError ? '' : JSON.stringify({ scores: { relevant: 0.97 } }),
        latencyMs: 321,
        error: authError ? 'JEV_HTTP_401' : null,
        usage: { inputTokens: 42, outputTokens: 1, costUsd: 0.000123 },
      },
    });
  });
  await openJev(page);
  const section = await openJevModel(page);
  const run = section.getByRole('button', { name: 'JEV 연결 테스트', exact: true });
  await run.click();
  await expect(section.getByRole('alert')).toBeVisible();
  const statusButton = section.getByRole('button', { name: '테스트 상태 확인', exact: true });
  await expect(statusButton).toBeVisible();
  expect(submissions).toHaveLength(1);
  await statusButton.click();
  await expect(run).toBeEnabled();
  expect(polls).toHaveLength(1);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0]?.expectedRevision).toBe(current.revision);
  await run.click();
  await expect.poll(() => polls.length).toBe(2);
  await expect(run).toBeEnabled();
  expect(submissions).toHaveLength(3);
  expect(submissions[2]?.idempotencyKey).not.toBe(submissions[1]?.idempotencyKey);
});

test('JEVUI04 judgment settings changed on another screen ask for a refresh instead of an unknown outcome', async ({
  page,
  request,
}) => {
  await saveKey(request);
  await openJev(page);
  const section = await openJevModel(page);
  const { settings } = await connection(request);
  const elsewhere = await request.put(`${endpoint}/settings`, {
    data: { expectedRevision: settings.revision, images: false, longContext: true },
  });
  expect(elsewhere.ok(), await elsewhere.text()).toBe(true);
  await section.getByLabel('이미지를 보고 선택').click();
  await expect(section.getByRole('alert')).toContainText('다른 화면에서 판단 설정이 바뀌었어요.');
  expect((await connection(request)).settings).toMatchObject({ images: false, longContext: true });
});
