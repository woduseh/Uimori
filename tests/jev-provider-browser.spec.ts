import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { JevProviderStatus } from '../core/jev-provider.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import {
  MOBILE_WIDTH,
  DESKTOP_WIDTH,
  MOBILE_HEIGHT,
  DESKTOP_HEIGHT,
} from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
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

async function openJev(page: Page) {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '프로바이더·모델');
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page
    .getByRole('button', { name: '새 프로바이더 입력', exact: true })
    .or(page.getByRole('button', { name: '프로바이더 추가', exact: true }))
    .click();
  await page
    .getByRole('region', { name: '제공자 선택' })
    .getByRole('button', { name: 'TypeSafe AI JEV · 판단 전용 모델' })
    .click();
  const section = page.getByRole('region', { name: 'TypeSafe AI 프로바이더 설정', exact: true });
  await expect(section.getByLabel('JEV API 키', { exact: true })).toBeEnabled();
  return section;
}

async function containedControls(section: Locator, width: number) {
  for (const control of await section.locator('input, button, a').all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
}

async function revealResult(page: Page, section: Locator) {
  const result = section.locator('.jev-test-result');
  await result.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(result).toBeInViewport({ ratio: 1 });
  const box = await result.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(56);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 40);
}

test.beforeEach(async ({ page, request }) => {
  await removeKey(request);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  // A browser spec must never submit this endpoint to the server: doing so could call JEV.
  // Response tests register a more specific later handler and fulfill synthetic receipts.
  await page.route('**/api/provider-management/jev/test', (route) =>
    route.abort('blockedbyclient')
  );
});

test.afterEach(async ({ request }) => {
  await removeKey(request);
});

test('JEVUI01 saves and removes a server key without exposing it or changing writing models', async ({
  page,
  request,
}, info) => {
  const beforeLibrary = await (await request.get('/api/library')).json();
  const beforeModels = await (await request.get('/api/model-workspace')).json();
  const section = await openJev(page);
  await expect(section.getByText('등록되지 않음', { exact: true })).toBeVisible();
  const key = section.getByLabel('JEV API 키', { exact: true });
  const save = section.getByRole('button', { name: 'JEV API 키 저장', exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await expect(save).toBeDisabled();
  await expect(
    section.getByRole('button', { name: 'JEV 연결 테스트', exact: true })
  ).toBeDisabled();
  await key.fill(syntheticKey);
  await save.click();
  await expect(key).toHaveValue('');
  await expect(section.getByText('Uimori에 저장한 키', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'JEV 연결 테스트', exact: true })).toBeEnabled();
  const saved = await connection(request);
  expect(saved).toMatchObject({ configured: true, hasSavedKey: true, credentialSource: 'saved' });
  await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  const modelList = page.getByRole('region', { name: '저장한 모델 프리셋', exact: true });
  const typeSafeGroup = modelList
    .locator('.provider-model-group')
    .filter({ hasText: 'TypeSafe AI' });
  const modelRow = page.getByRole('article', { name: 'JEV 모델', exact: true });
  await expect(typeSafeGroup.getByText('1개 모델', { exact: true })).toBeVisible();
  await expect(modelRow).toBeHidden();
  await typeSafeGroup.locator(':scope > summary').click();
  await expect(modelRow).toBeVisible();
  await expect(modelRow.getByLabel('JEV 모델 메뉴', { exact: true })).toBeVisible();
  if (visualReview) {
    await page.screenshot({ path: info.outputPath('jev-model-list-mobile.png') });
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
    await containedControls(modelRow, DESKTOP_WIDTH);
    await page.screenshot({ path: info.outputPath('jev-model-list-desktop.png') });
    await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  }
  await page.getByRole('button', { name: 'JEV 모델 설정', exact: true }).click();
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
  await containedControls(section, MOBILE_WIDTH);
  if (visualReview) {
    await section.getByRole('heading', { name: 'TypeSafe AI' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('jev-connection-mobile.png') });
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
    await containedControls(section, DESKTOP_WIDTH);
    await page.screenshot({ path: info.outputPath('jev-connection-desktop.png') });
  }
  await section.getByRole('button', { name: '저장한 JEV 키 삭제', exact: true }).click();
  await expect(section.getByText('등록되지 않음', { exact: true })).toBeVisible();
  await expect(
    section.getByRole('button', { name: 'JEV 연결 테스트', exact: true })
  ).toBeDisabled();
  expect(await connection(request)).toMatchObject({ configured: false, hasSavedKey: false });
});

test('JEVUI02 stale key edits preserve the draft until explicit refresh and save', async ({
  page,
  request,
}) => {
  await saveKey(request);
  const section = await openJev(page);
  const key = section.getByLabel('JEV API 키', { exact: true });
  const save = section.getByRole('button', { name: 'JEV API 키 저장', exact: true });
  const draft = syntheticKey + '-draft';
  await key.fill(draft);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  ).not.toContain(draft);
  await saveKey(request, syntheticKey + '-other-window');
  await save.click();
  await expect(section.getByRole('alert')).toContainText('입력한 키는 유지돼요');
  await expect(key).toHaveValue(draft);
  await expect(save).toBeDisabled();
  await section.getByRole('button', { name: '연결 상태 새로고침', exact: true }).click();
  await expect(save).toBeEnabled();
  await expect(key).toHaveValue(draft);
  await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  await page.getByRole('button', { name: 'TypeSafe AI 편집 이어서', exact: true }).click();
  await expect(key).toHaveValue(draft);
  await expect(save).toBeEnabled();
  const expectedRevision = (await connection(request)).revision;
  await save.click();
  await expect(key).toHaveValue('');
  expect((await connection(request)).revision).toBe(expectedRevision + 1);
});

test('JEVUI03 recovers a synthetic uncertain test and shows structured success and auth failure', async ({
  page,
  request,
}, info) => {
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
  await page.route('**/api/provider-management/jev', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        latestTest: {
          ...base,
          modelRevision: current.revision - 1,
          status: 'completed',
          finishedAt: new Date().toISOString(),
          text: JSON.stringify({ scores: { relevant: 0.8 } }),
        },
      },
    });
  });
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
  const section = await openJev(page);
  await expect(
    section.getByText('이 결과는 이전 연결 정보로 실행한 테스트예요.', { exact: true })
  ).toBeVisible();
  await section.getByRole('button', { name: 'JEV 연결 테스트', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('같은 요청을 복구');
  expect(submissions).toHaveLength(1);
  await section.getByRole('button', { name: 'JEV 테스트 상태 확인', exact: true }).click();
  await expect(section.getByLabel('JEV API 키', { exact: true })).toBeDisabled();
  await expect(
    section.getByRole('button', { name: 'JEV 응답 확인 중…', exact: true })
  ).toBeDisabled();
  await expect(section.getByText('JEV 판단 응답을 확인했어요.', { exact: true })).toBeVisible();
  await expect(section.getByText('예제 관련성: 97.0%', { exact: true })).toBeVisible();
  await expect(section.getByText('0.32초', { exact: true })).toBeVisible();
  await expect(section.getByText('$0.000123', { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0]?.expectedRevision).toBe(current.revision);
  expect(polls).toHaveLength(1);
  if (visualReview) {
    await revealResult(page, section);
    await page.screenshot({ path: info.outputPath('jev-test-success-mobile.png') });
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
    await revealResult(page, section);
    await page.screenshot({ path: info.outputPath('jev-test-success-desktop.png') });
    await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  }
  await section.getByRole('button', { name: 'JEV 연결 테스트', exact: true }).click();
  await expect(
    section.getByText('API 키와 TypeSafe 계정의 사용 권한을 확인해 주세요.', { exact: true })
  ).toBeVisible();
  await expect(section.getByText('예제 관련성: 97.0%', { exact: true })).toHaveCount(0);
  expect(submissions).toHaveLength(3);
  expect(submissions[2]?.idempotencyKey).not.toBe(submissions[1]?.idempotencyKey);
  expect(polls).toHaveLength(2);
  await containedControls(section, MOBILE_WIDTH);
  if (visualReview) {
    await revealResult(page, section);
    await page.screenshot({ path: info.outputPath('jev-test-auth-error-mobile.png') });
  }
  expect((await connection(request)).latestTest).toBeNull();
});
