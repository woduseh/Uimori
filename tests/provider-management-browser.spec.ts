import { openProviderModel, navigationAction } from './ui-navigation.js';
import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { selectCurrentSettingsSection } from './ui-navigation.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { setCurrentModels } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';
import {
  openProviderMenu,
  revealProviderDiagnostics,
  selectSettingsSection,
  startProviderConnection,
} from './ui-navigation.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Connection, Library, ModelPreset } from '../core/product.js';
import type { Chat, ChatDetail } from '../core/types.js';
import { generateKeyPairSync } from 'node:crypto';
import { defaultEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { postFixtureChat } from './fixtures/chat.js';

async function api<T>(
  request: APIRequestContext,
  path: string,
  body?: unknown,
  method = 'POST'
): Promise<T> {
  const response =
    body === undefined
      ? await request.get('/api' + path)
      : await request.fetch('/api' + path, { method, data: body });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
const library = (request: APIRequestContext) => api<Library>(request, '/library');
const connectionInput = (title: string) => ({
  title,
  protocol: 'openai-responses-v1',
  endpoint: 'http://127.0.0.1:9/v1',
  apiKey: 'PM_SYNTHETIC_KEY',
  enabled: true,
});
const modelInput = (connection: Connection, title: string) => ({
  title,
  connectionId: connection.id,
  modelId: 'synthetic-model',
  maxOutputTokens: 8192,
  temperature: null,
  evaluationTools: defaultEvaluationToolOptions(),
  enabled: true,
});
const connectionBody = (item: Connection, changes: Record<string, unknown> = {}) => ({
  title: item.title,
  protocol: item.protocol,
  endpoint: item.endpoint,
  credentialRef: item.credentialRef,
  enabled: item.enabled,
  expectedRevision: item.revision,
  ...changes,
});
async function settings(page: Page) {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '프로바이더와 모델');
  await expect(page.getByTestId('connection-editor')).toBeVisible();
}
function observe(page: Page) {
  const errors: string[] = [],
    generations: string[] = [],
    legacyReads: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/\/api\/revisions\/(?:model|connection)\//.test(new URL(request.url()).pathname))
      legacyReads.push(request.url());
    if (
      request.method() === 'POST' &&
      /\/(?:runs|translation|retranslate)$/.test(new URL(request.url()).pathname)
    )
      generations.push(request.url());
  });
  return { errors, generations, legacyReads };
}

test('PMUI01 mobile template registration selects the connection, reports catalog failure honestly and saves manual options', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const title = 'PMUI01 ' + Date.now(),
    observed = observe(page);
  await page.route('**/api/health', async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    await route.fulfill({ response, json: { ...health, testMode: false } });
  });
  await settings(page);
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' }),
    modelForm = page.getByRole('form', { name: '모델 편집 양식' });
  await startProviderConnection(page);
  await expect(page.getByText('개발 및 검사용 프로바이더', { exact: true })).toHaveCount(0);
  await page
    .getByRole('region', { name: '프로바이더 선택', exact: true })
    .getByRole('button', { name: /OpenAI Responses/ })
    .click();
  await expect(
    form.getByLabel('프로바이더 프로토콜').locator('option[value="fixture-sse-v1"]')
  ).toHaveCount(0);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    const colors = await form.locator('.provider-save-actions').evaluate((actions) => ({
      actions: getComputedStyle(actions).backgroundColor,
      dialog: getComputedStyle(actions.closest('dialog')!).backgroundColor,
    }));
    expect(colors.actions).toBe(colors.dialog);
  }
  await form.getByLabel('프로바이더 프로토콜').selectOption('openai-responses-v1');
  await expect(form.getByLabel('API 기본 주소')).toHaveValue('https://api.openai.com/v1');
  await form.getByText('연결 안내', { exact: true }).click();
  await expect(form.locator('.provider-definition')).toContainText(
    '서버에서 허용한 HTTPS 주소나 이 컴퓨터의 로컬 HTTP 주소를 사용할 수 있어요.'
  );
  await expect(form.locator('.provider-definition')).not.toContainText('로컬 어댑터');
  await expect(form.locator('.provider-definition')).not.toContainText('bearer');
  await form.getByLabel('API 기본 주소').fill('http://127.0.0.1:9/v1');
  await form.getByLabel('프로바이더 이름', { exact: true }).fill(title);
  await form.getByLabel('API 키').fill('PM_SYNTHETIC_KEY');
  await form.getByLabel('이 프로바이더 사용').check();
  const registerConnection = form.getByRole('button', { name: '프로바이더 등록', exact: true });
  await expect(registerConnection).toHaveText('등록');
  await registerConnection.click();
  await expect(
    page.getByRole('status').filter({ hasText: title + ' 프로바이더 등록됨' })
  ).toBeVisible();
  const connection = (await library(request)).connections.find((item) => item.title === title)!;
  expect(connection).toBeTruthy();
  expect(JSON.stringify(connection)).not.toContain('PM_SYNTHETIC_KEY');
  await expect(modelForm.getByLabel('프로바이더', { exact: true })).toHaveValue(`${connection.id}`);
  await page.route(`**/api/connections/${connection.id}/catalog`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...connection, catalogError: 'CATALOG_UNAVAILABLE' }),
        })
      : route.fallback()
  );
  await modelForm.getByLabel('모델 ID', { exact: true }).fill('synthetic/manual-id');
  await modelForm.getByText('모델 목록에서 선택', { exact: true }).click();
  await modelForm.getByRole('button', { name: '모델 목록 새로고침', exact: true }).click();
  await expect(page.getByTestId('connection-editor').getByRole('alert')).toContainText(
    '모델 목록을 확인하지 못했어요'
  );
  await expect(page.getByRole('status').filter({ hasText: '모델 목록 조회 완료' })).toHaveCount(0);
  await expect(modelForm.getByLabel('모델 ID', { exact: true })).toHaveValue('synthetic/manual-id');
  await modelForm.getByLabel('모델 프리셋 이름').fill(title + ' 수동 모델');
  if (visualReview)
    await modelForm
      .locator('.toggle-row')
      .filter({ hasText: '새 실행에 이 모델 사용' })
      .screenshot({ path: info.outputPath('model-visibility-switch.png') });
  await modelForm.getByRole('button', { name: '고급', exact: true }).click();
  await expect(modelForm.getByLabel('이 모델 프리셋에 평가 도구 사용')).not.toBeChecked();
  await modelForm.getByLabel('이 모델 프리셋에 평가 도구 사용').check();
  if (visualReview)
    await modelForm
      .locator('.toggle-row')
      .filter({ hasText: '이 모델 프리셋에 평가 도구 사용' })
      .screenshot({ path: info.outputPath('model-evaluation-switch.png') });

  await expect(modelForm.getByLabel('최대 평가 도구 라운드')).toHaveCount(0);
  await expect(modelForm.getByLabel('이 모델 프리셋에 컨텍스트 메모·전환 도구 사용')).toHaveCount(
    0
  );
  await modelForm.getByText('요금과 추정 비용', { exact: true }).click();
  await modelForm.getByLabel('요금 기준', { exact: true }).selectOption('manual');
  await modelForm.getByLabel('Standard 입력 요금', { exact: true }).fill('2');
  await modelForm.getByLabel('Standard 출력 요금', { exact: true }).fill('8');
  for (const label of [
    '모델 프리셋 이름',
    '프로바이더',
    '모델 ID',
    '평가 컨텍스트 제공',
    'Standard 입력 요금',
    'Standard 출력 요금',
  ]) {
    await modelForm
      .getByRole('button', {
        name: ['모델 프리셋 이름', '프로바이더', '모델 ID'].includes(label) ? '기본' : '고급',
        exact: true,
      })
      .click();
    const control = modelForm.getByLabel(label, { exact: true });
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE_WIDTH);
  }
  await modelForm.getByLabel('Standard 입력 요금').scrollIntoViewIfNeeded();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('provider-management-mobile-pricing.png') });
  await modelForm.getByRole('button', { name: '기본', exact: true }).click();
  await modelForm.getByLabel('모델 프리셋 이름').scrollIntoViewIfNeeded();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('provider-management-mobile-model.png') });
  const registerModel = modelForm.getByRole('button', { name: '모델 프리셋 등록', exact: true });
  await expect(registerModel).toHaveText('등록');
  await registerModel.click();
  await expect(
    page.getByRole('status').filter({ hasText: title + ' 수동 모델 모델 프리셋 등록됨' })
  ).toBeVisible();
  const saved = (await library(request)).models.find(
    (item) => item.title === title + ' 수동 모델'
  )!;
  expect(saved).toMatchObject({
    connectionId: connection.id,
    modelId: 'synthetic/manual-id',
    evaluationTools: {
      contextMode: 'model-selected',
      approvalReasoningMode: 'configured',
      metadataProfile: 'neutral',
    },
    source: { kind: 'manual', catalogUpdatedAt: null },
  });
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI02 connection clone requires review and stale edits retain their draft and CAS revision until explicit reload', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const title = 'PMUI02 ' + Date.now(),
    observed = observe(page);
  await page.route('**/api/health', async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    await route.fulfill({ response, json: { ...health, testMode: false } });
  });
  const original = await api<Connection>(request, '/connections', connectionInput(title));
  await settings(page);
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' });
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page.getByLabel('프로바이더와 모델 검색').fill(title);
  await openProviderMenu(page, '프로바이더', title);
  await page.getByRole('button', { name: title + ' 프로바이더 복제', exact: true }).click();
  await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(title + ' 사본');
  await expect(form.getByLabel('이 프로바이더 사용')).not.toBeChecked();
  await expect(form.getByLabel('API 키')).toHaveValue('');
  expect(
    (await library(request)).connections.filter((item) => item.title.startsWith(title))
  ).toHaveLength(1);
  await form.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: title + ' 사본 프로바이더 등록됨' })
  ).toBeVisible();
  const copied = (await library(request)).connections.find(
    (item) => item.title === title + ' 사본'
  )!;
  expect(copied.id).not.toBe(original.id);
  expect(copied.enabled).toBe(false);
  expect((await library(request)).connections.find((item) => item.id === original.id)).toEqual(
    original
  );
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page.getByRole('button', { name: title + ' 프로바이더 수정', exact: true }).click();
  await form.getByLabel('프로바이더 이름', { exact: true }).fill(title + ' 내 초안');
  const changed = await api<Connection>(
    request,
    `/connections/${original.id}`,
    connectionBody(original, { title: title + ' 다른 변경' }),
    'PUT'
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(title + ' 내 초안');
  await expect(form).toContainText('프로바이더가 변경됐어요.');
  const put = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith(`/connections/${original.id}`)
  );
  await form.getByRole('button', { name: '프로바이더 변경 저장', exact: true }).click();
  expect((await put).postDataJSON().expectedRevision).toBe(1);
  const conflictDialog = page.getByRole('alertdialog', { name: '저장본 확인' });
  await expect(
    conflictDialog.getByRole('button', { name: '현재 입력 유지', exact: true })
  ).toBeFocused();
  await expect(conflictDialog.getByLabel('현재 저장본')).toContainText(changed.title);
  await expect(conflictDialog.getByLabel('현재 저장본')).not.toContainText(title + ' 내 초안');
  await conflictDialog.getByRole('button', { name: '현재 입력 유지', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('프로바이더가 변경됐어요.');
  await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(title + ' 내 초안');
  expect((await library(request)).connections.find((item) => item.id === original.id)).toEqual(
    changed
  );
  if (visualReview)
    await form.screenshot({ path: info.outputPath('provider-management-desktop-conflict.png') });
  await form.getByRole('button', { name: '최신 프로바이더 설정 불러오기', exact: true }).click();
  await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(changed.title);
  await expect(form).not.toContainText('편집 기준');
  await form.getByLabel('프로바이더 이름', { exact: true }).fill(title + ' 검토 완료');
  await form.getByRole('button', { name: '프로바이더 변경 저장', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await library(request)).connections.find((item) => item.id === original.id)?.revision
    )
    .toBe(3);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI03 model edits use the latest connection without changing role IDs; deactivation blocks new runs and keeps the selection', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const title = 'PMUI03 ' + Date.now(),
    observed = observe(page);
  const connection = await api<Connection>(request, '/connections', connectionInput(title));
  const original = await api<ModelPreset>(
    request,
    '/model-presets',
    modelInput(connection, title + ' 원본')
  );
  const created = await postFixtureChat(request, { data: { title: title + ' 기존 이야기' } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chat = (await created.json()) as Chat;
  await setCurrentModels(request, { main: { id: original.id } });
  await api(
    request,
    `/connections/${connection.id}`,
    connectionBody(connection, { title: title + ' 연결 최신판' }),
    'PUT'
  );
  await settings(page);
  await page.getByLabel('프로바이더와 모델 검색').fill(title);
  await openProviderModel(page, original.title);
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await expect(form.getByLabel('프로바이더', { exact: true })).toHaveValue(`${connection.id}`);
  await expect(
    form.getByLabel('프로바이더', { exact: true }).locator('option:checked')
  ).toContainText(title + ' 연결 최신판');
  await expect(form).not.toContainText('보관된 버전');
  const actions = form.locator('.provider-model-save-actions');
  const saveAction = actions.getByRole('button', { name: '모델 변경 저장', exact: true });
  const closeAction = actions.getByRole('button', { name: '모델 편집 끝내기', exact: true });
  const deleteAction = actions.getByRole('button', {
    name: original.title + ' 모델 삭제',
    exact: true,
  });
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: width === MOBILE_WIDTH ? 844 : 1000 });
    await actions.scrollIntoViewIfNeeded();
    for (const action of [closeAction, deleteAction, saveAction]) {
      await expect(action).toBeVisible();
      await expect(action).toBeInViewport();
    }
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`provider-model-action-icons-${width}.png`) });
  }
  await form.getByLabel('모델 프리셋 이름').fill(title + ' 수정 모델');
  await form.getByLabel('최대 출력 토큰').fill('4096');
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect
    .poll(
      async () => (await library(request)).models.find((item) => item.id === original.id)?.revision
    )
    .toBe(2);
  const changed = (await library(request)).models.find((item) => item.id === original.id)!;
  expect(changed).not.toHaveProperty('connectionRevision');
  expect((await api<ChatDetail>(request, `/chats/${chat.id}`)).profile?.routes.main).toEqual({
    id: original.id,
  });
  await openProviderMenu(page, '모델', changed.title);
  await page.getByRole('button', { name: changed.title + ' 모델 복제', exact: true }).click();
  await expect(form.getByLabel('모델 프리셋 이름')).toHaveValue(changed.title + ' 사본');
  expect(
    (await library(request)).models.filter((item) => item.title.startsWith(title))
  ).toHaveLength(1);
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await library(request)).models.filter((item) => item.title.startsWith(title)).length
    )
    .toBe(2);
  const copied = (await library(request)).models.find(
    (item) => item.title === changed.title + ' 사본'
  )!;
  expect(copied.id).not.toBe(original.id);
  expect(copied).toMatchObject({
    maxOutputTokens: 4096,
    evaluationTools: original.evaluationTools,
  });
  await openProviderMenu(page, '모델', changed.title);
  await page.getByRole('button', { name: changed.title + ' 모델 비활성화', exact: true }).click();
  await expect(page.getByRole('region', { name: '비활성 영향 확인' })).toHaveCount(0);
  await expect
    .poll(
      async () => (await library(request)).models.find((item) => item.id === original.id)?.enabled
    )
    .toBe(false);
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await openProviderMenu(page, '프로바이더', title + ' 연결 최신판');
  await page
    .getByRole('button', { name: title + ' 연결 최신판 프로바이더 비활성화', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await library(request)).connections.find((item) => item.id === connection.id)?.enabled
    )
    .toBe(false);
  await openProviderMenu(page, '프로바이더', title + ' 연결 최신판');
  await page
    .getByRole('button', { name: title + ' 연결 최신판 프로바이더 활성화', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await library(request)).connections.find((item) => item.id === connection.id)?.enabled
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('button', { name: /^현재 본문 모델/ })).toContainText(changed.title);
  await selectCurrentSettingsSection(page, '역할별 모델');
  await expect(page.getByLabel('본문 모델', { exact: true })).toHaveValue(`${original.id}`);
  await expect(
    page.getByLabel('본문 모델', { exact: true }).locator('option:checked')
  ).toContainText(changed.title + ' (모델 또는 프로바이더 비활성)');
  await expect(
    page.getByLabel('본문 모델', { exact: true }).locator('option:checked')
  ).not.toContainText(' v');
  if (visualReview)
    await page.screenshot({ path: info.outputPath('provider-management-current-model.png') });
  const after = await api<ChatDetail>(request, `/chats/${chat.id}`);
  expect(after.profile?.routes.main).toEqual({ id: original.id });
  expect(after.runs).toEqual([]);
  expect(after.attempts).toEqual([]);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI04 selecting a provider does not refresh its model catalog until requested', async ({
  page,
  request,
}) => {
  const title = 'PMUI04 ' + Date.now();
  const connection = await api<Connection>(request, '/connections', connectionInput(title));
  let catalogRequests = 0;
  page.on('request', (value) => {
    if (
      value.method() === 'POST' &&
      new URL(value.url()).pathname.endsWith(`/connections/${connection.id}/catalog`)
    )
      catalogRequests++;
  });

  await settings(page);
  await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await form.getByLabel('프로바이더', { exact: true }).selectOption(connection.id);
  await expect(form.getByLabel('모델 ID', { exact: true })).toBeVisible();
  await form.getByText('모델 목록에서 선택', { exact: true }).click();
  const refresh = form.getByRole('button', { name: '모델 목록 새로고침', exact: true });
  await expect(refresh).toBeVisible();
  expect(catalogRequests).toBe(0);

  await refresh.click();
  await expect.poll(() => catalogRequests).toBe(1);
});

test('PMUI07 quick setup selects a cached catalog model and keeps drafts across workspace pages', async ({
  page,
  request,
}, info) => {
  const observed = observe(page);
  const catalogSnapshots = new Map<
    string,
    Pick<Connection, 'catalog' | 'catalogError' | 'catalogUpdatedAt'>
  >();
  await page.route(/\/api\/library(?:\?.*)?$/u, async (route) => {
    const response = await route.fetch(),
      body = (await response.json()) as Library;
    body.connections = body.connections.map((connection) => ({
      ...connection,
      ...catalogSnapshots.get(connection.id),
    }));
    await route.fulfill({ response, json: body });
  });
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: width === MOBILE_WIDTH ? 915 : 1440 });
    await settings(page);
    const title = `PMUI07 ${width} ${Date.now()}`,
      form = page.getByRole('form', { name: '프로바이더 편집 양식' }),
      modelForm = page.getByRole('form', { name: '모델 편집 양식' });
    await startProviderConnection(page);
    await expect(page.getByRole('region', { name: '프로바이더 선택', exact: true })).toBeVisible();
    await page.getByText('개발 및 검사용 프로바이더', { exact: true }).click();
    await page.getByRole('button', { name: '로컬 fixture로 설정', exact: true }).click();
    await form.getByLabel('프로바이더 이름', { exact: true }).fill(title);
    await form.getByLabel('로컬 요청 주소').fill('http://127.0.0.1:9/turn');
    await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
    await expect(form).not.toBeVisible();
    await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
    await page
      .getByRole('button', { name: '프로바이더 편집 이어 하기: ' + title, exact: true })
      .click();
    await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(title);
    await form.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
    await expect(modelForm).toBeVisible();
    const connection = (await library(request)).connections.find((item) => item.title === title)!;
    expect(connection).toBeTruthy();
    const catalog = [
      {
        id: 'synthetic/catalog-alpha',
        name: title + ' Alpha',
        capabilities: {},
        priceRevision: null,
      },
      {
        id: 'synthetic/catalog-beta',
        name: title + ' Beta',
        capabilities: {},
        priceRevision: null,
      },
    ];
    let catalogRequests = 0;
    await page.route(`**/api/connections/${connection.id}/catalog`, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      catalogRequests++;
      const snapshot = {
        catalog,
        catalogError: null,
        catalogUpdatedAt: '2026-09-07T00:00:00.000Z',
      };
      catalogSnapshots.set(connection.id, snapshot);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...connection, ...snapshot }),
      });
    });
    await modelForm.getByText('모델 목록에서 선택', { exact: true }).click();
    await modelForm.getByRole('button', { name: '모델 목록 새로고침', exact: true }).click();
    await modelForm.getByLabel('모델 목록 검색').fill('catalog-beta');
    const picker = modelForm.getByRole('region', { name: '저장된 모델 목록에서 선택' });
    await expect(picker.locator('.provider-catalog-choice')).toHaveCount(1);
    await picker.getByRole('button', { name: new RegExp(title + ' Beta') }).click();
    await expect(modelForm.getByLabel('모델 프리셋 이름')).toHaveValue(title + ' Beta');
    await expect(modelForm.getByLabel('모델 ID', { exact: true })).toHaveValue(
      'synthetic/catalog-beta'
    );
    await modelForm.getByLabel('최대 출력 토큰').fill('1024');
    await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
    await expect(modelForm).not.toBeVisible();
    await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
    await page
      .getByRole('button', { name: '모델 편집 이어 하기: ' + title + ' Beta', exact: true })
      .click();
    await expect(modelForm.getByLabel('최대 출력 토큰')).toHaveValue('1024');
    await expect(modelForm.getByLabel('모델 ID', { exact: true })).toHaveValue(
      'synthetic/catalog-beta'
    );
    const dialog = page.getByRole('dialog', { name: '설정', exact: true });
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`provider-management-catalog-${width}.png`) });
    await modelForm.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
    await expect(page.getByRole('region', { name: '저장한 모델 프리셋' })).toBeVisible();
    await expect(modelForm).not.toBeVisible();
    await expect
      .poll(async () =>
        (await library(request)).models.find((item) => item.title === title + ' Beta')
      )
      .toMatchObject({
        modelId: 'synthetic/catalog-beta',
        connectionId: connection.id,
        maxOutputTokens: 1024,
      });
    expect(catalogRequests).toBe(1);
  }
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI08 Vertex JSON draft is validated and saved with the connection', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await settings(page);
  const title = 'PMUI08 ' + Date.now(),
    observed = observe(page);
  await startProviderConnection(page);
  await page
    .getByRole('region', { name: '프로바이더 선택', exact: true })
    .getByRole('button', { name: /Google Agent Platform/ })
    .click();
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' }),
    upload = form.getByRole('region', { name: 'Google 서비스 계정 JSON' }),
    file = upload.getByLabel('Google 키 JSON 파일');
  const originalEndpoint =
    'https://aiplatform.googleapis.com/v1/projects/synthetic-original/locations/global/publishers/google/models';
  await form.getByLabel('프로바이더 이름', { exact: true }).fill(title);
  await form.getByLabel('Google Agent Platform 요청 주소').fill(originalEndpoint);
  const projectId = 'synthetic-project',
    clientEmail = 'test@synthetic-project.iam.gserviceaccount.com';
  let uploads = 0;
  let uploadBody: unknown;
  page.on('request', (r) => {
    if (
      r.method() === 'POST' &&
      r.url().endsWith('/api/provider-management/vertex-credentials/validate')
    ) {
      uploads++;
      uploadBody = r.postDataJSON();
    }
  });
  for (const [body, message] of [
    ['{broken', '파일 형식을 확인해 주세요'],
    [JSON.stringify({ project_id: projectId }), 'type이 service_account'],
    [' '.repeat(64 * 1024 + 1), '64 KB 이하'],
  ]) {
    await file.setInputFiles({
      name: 'synthetic-invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from(body),
    });
    await expect(upload.getByRole('alert')).toContainText(message);
    await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(title);
    await expect(form.getByLabel('Google Agent Platform 요청 주소')).toHaveValue(originalEndpoint);
    await expect(form.getByLabel('API 키', { exact: true })).toHaveCount(0);
    await expect(form.getByLabel('모델 목록 API 키', { exact: true })).toHaveCount(0);
    expect(uploads).toBe(0);
  }
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const serviceAccount = {
    type: 'service_account',
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey,
    private_key_id: 'a'.repeat(40),
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const uploaded = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/provider-management/vertex-credentials/validate') &&
      r.request().method() === 'POST'
  );
  await file.setInputFiles({
    name: 'synthetic-service-account.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(serviceAccount)),
  });
  await expect(upload.getByRole('status')).toContainText(`프로젝트: ${projectId}`);
  const uploadResponse = await uploaded;
  expect(uploadResponse.ok()).toBeTruthy();
  expect(await uploadResponse.json()).toEqual({ projectId, clientEmail });
  expect(uploads).toBe(1);
  expect(uploadBody).toEqual({ serviceAccount });
  await expect(form.getByLabel('API 키', { exact: true })).toHaveCount(0);
  await expect(form.getByLabel('모델 목록 API 키', { exact: true })).toHaveCount(0);
  await expect(upload.getByRole('status')).toContainText(projectId);
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models`;
  await expect(form.getByLabel('Google Agent Platform 요청 주소')).toHaveValue(endpoint);
  expect(
    await page.getByRole('dialog', { name: '설정', exact: true }).evaluate((node) => node.outerHTML)
  ).not.toContain(serviceAccount.private_key);
  await expect(file).toHaveValue('');
  await upload.scrollIntoViewIfNeeded();
  if (visualReview)
    await page.screenshot({
      path: info.outputPath('provider-management-vertex-upload-mobile.png'),
    });
  const replacement = {
    ...serviceAccount,
    client_email: `replacement@${projectId}.iam.gserviceaccount.com`,
  };
  await file.setInputFiles({
    name: 'synthetic-replacement.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(replacement)),
  });
  await expect(upload.getByRole('status')).toContainText(replacement.client_email);
  expect(uploads).toBe(2);
  expect(uploadBody).toEqual({ serviceAccount: replacement });
  let rejectOnce = true;
  await page.route('**/api/connections', async (route) => {
    if (route.request().method() === 'POST' && rejectOnce) {
      rejectOnce = false;
      await route.fulfill({ status: 400, json: { error: 'Synthetic save rejection' } });
    } else await route.continue();
  });
  const rejected = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/connections')
  );
  await form.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  expect((await rejected).status()).toBe(400);
  await expect(form.getByRole('button', { name: '프로바이더 등록', exact: true })).toBeEnabled();
  await expect(upload.getByRole('status')).toContainText(replacement.client_email);
  await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(title);
  expect((await library(request)).connections.some((item) => item.title === title)).toBe(false);
  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/connections')
  );
  await form.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  const saved = await posted;
  expect(saved.ok()).toBeTruthy();
  expect(saved.request().postDataJSON()).toMatchObject({
    serviceAccount: replacement,
    endpoint,
    title,
    protocol: 'vertex-gemini-v1',
  });
  const { credentialRef } = (await saved.json()) as { credentialRef: string };
  expect(credentialRef).toMatch(/^UIMORI_PROVIDER_VERTEX_FILE_[A-F0-9]{32}$/);
  await expect
    .poll(async () => (await library(request)).connections.find((item) => item.title === title))
    .toMatchObject({ credentialRef, endpoint });
  expect(JSON.stringify(await library(request))).not.toContain('BEGIN PRIVATE KEY');
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page.getByLabel('프로바이더와 모델 검색').fill(title);
  await page.getByRole('button', { name: title + ' 프로바이더 수정', exact: true }).click();
  await expect(form.getByRole('region', { name: 'Google 서비스 계정 JSON' })).toBeVisible();
  expect(
    (await library(request)).connections.find((item) => item.title === title)?.credentialRef
  ).toBe(credentialRef);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI09 invalid hidden model fields receive focus and a reversible disable finishes before another draft', async ({
  page,
  request,
}) => {
  const title = 'PMUI09 ' + Date.now(),
    connection = await api<Connection>(request, '/connections', {
      title,
      protocol: 'anthropic-messages-v1',
      endpoint: 'https://api.anthropic.com/v1',
      apiKey: 'SYNTHETIC_ANTHROPIC_KEY',
      enabled: true,
    });
  await settings(page);
  await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
  let form = page.getByRole('form', { name: '모델 편집 양식' });
  await form.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
  await form.getByLabel('모델 프리셋 이름').fill('');
  await form.getByLabel('모델 ID', { exact: true }).fill('');
  await form.getByLabel('최대 출력 토큰').fill('0');
  let modelWrites = 0;
  page.on('request', (r) => {
    if (
      ['POST', 'PUT'].includes(r.method()) &&
      new URL(r.url()).pathname.startsWith('/api/model-presets')
    )
      modelWrites++;
  });
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(form.getByRole('button', { name: '기본', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(form.getByLabel('모델 프리셋 이름')).toBeFocused();
  await form.getByLabel('모델 프리셋 이름').fill(title + ' 초안');
  await form.getByLabel('모델 ID', { exact: true }).fill('synthetic-model');
  await form.getByLabel('최대 출력 토큰').fill('');
  await expect(form.getByLabel('최대 출력 토큰')).toHaveValue('');
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(form.getByLabel('최대 출력 토큰')).toBeFocused();
  expect(modelWrites).toBe(0);
  await form.getByLabel('최대 출력 토큰').pressSequentially('4096');
  await expect(form.getByLabel('최대 출력 토큰')).toHaveValue('4096');
  await form.getByLabel('최대 출력 토큰').fill('500001');
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(form.getByLabel('최대 출력 토큰')).toBeFocused();
  expect(modelWrites).toBe(0);
  await form.getByLabel('최대 출력 토큰').fill('4096');
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await form.getByLabel('캐시 방식', { exact: true }).selectOption('automatic');
  await form.getByLabel('캐시 유지 시간', { exact: true }).selectOption('1h');
  await form.getByLabel('캐시 방식', { exact: true }).selectOption('');
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(form.getByRole('button', { name: '고급', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(form.getByLabel('캐시 유지 시간', { exact: true })).toBeFocused();
  expect(modelWrites).toBe(0);
  const a = await api<ModelPreset>(request, '/model-presets', {
    title: title + ' A',
    connectionId: connection.id,
    modelId: 'synthetic-a',
    maxOutputTokens: 4096,
    temperature: null,
    enabled: true,
  });
  const b = await api<ModelPreset>(request, '/model-presets', {
    title: title + ' B',
    connectionId: connection.id,
    modelId: 'synthetic-b',
    maxOutputTokens: 4096,
    temperature: null,
    enabled: true,
  });
  await settings(page);
  await openProviderModel(page, a.title);
  form = page.getByRole('form', { name: '모델 편집 양식' });
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await form.getByRole('switch', { name: '새 실행에 이 모델 사용' }).uncheck();
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect
    .poll(async () => (await library(request)).models.find((item) => item.id === a.id)?.enabled)
    .toBe(false);
  await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  await openProviderModel(page, b.title);
  await expect(form.getByLabel('모델 프리셋 이름')).toHaveValue(b.title);
  await form.getByLabel('모델 프리셋 이름').fill(b.title + ' 내 초안');
  expect((await library(request)).models.find((item) => item.id === b.id)).toEqual(b);
  expect(modelWrites).toBe(1);
});

const providerOptionCases = [
  {
    protocol: 'openai-responses-v1',
    endpoint: 'https://api.openai.com/v1',
    modelId: 'gpt-5.6-sol',
    choices: {
      '추론 강도': 'none',
      '응답 길이': 'high',
      '서비스 등급': 'flex',
      '캐시 방식': 'automatic',
      '캐시 유지 시간': '30m',
    },
    saved: {
      reasoningEffort: 'none',
      verbosity: 'high',
      serviceTier: 'flex',
      cacheMode: 'automatic',
      cacheTtl: '30m',
    },
    absent: ['outputEffort'],
    hidden: ['사고 모드', '실행 방식'],
  },
  {
    protocol: 'anthropic-messages-v1',
    endpoint: 'https://api.anthropic.com/v1',
    modelId: 'claude-opus-5-5',
    choices: {
      '추론 강도': 'high',
      '실행 방식': 'batch',
      '사고 모드': 'disabled',
      '캐시 방식': 'explicit',
      '캐시 유지 시간': '5m',
    },
    saved: {
      outputEffort: 'high',
      executionMode: 'batch',
      thinkingMode: 'disabled',
      cacheMode: 'explicit',
      cacheTtl: '5m',
    },
    absent: ['reasoningEffort'],
    hidden: ['응답 길이'],
  },
];
for (const [index, item] of providerOptionCases.entries()) {
  test(`PMUI11 ${item.protocol}/${item.modelId} documented provider options lead each select and round-trip without generation`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
    const observed = observe(page),
      prefix = 'PMUI11 ' + Date.now();
    const tabFor = (label: string) =>
      ['추론 강도', '서비스 등급', '실행 방식'].includes(label) ? '기본' : '고급';
    const title = prefix + ' ' + item.modelId,
      connection = await api<Connection>(request, '/connections', {
        title,
        protocol: item.protocol,
        endpoint: item.endpoint,
        apiKey: 'PM_SYNTHETIC_KEY',
        enabled: false,
      });
    await settings(page);
    await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
    const form = page.getByRole('form', { name: '모델 편집 양식' });
    await form.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
    await form.getByLabel('모델 프리셋 이름').fill(title);
    await form.getByLabel('모델 ID', { exact: true }).fill(item.modelId);
    await expect(form.getByLabel('모델 ID', { exact: true })).toBeEditable();
    for (const [label, value] of Object.entries(item.choices)) {
      await form.getByRole('button', { name: tabFor(label), exact: true }).click();
      await form.getByLabel(label, { exact: true }).selectOption(value!);
    }
    for (const label of item.hidden)
      await expect(form.getByLabel(label, { exact: true })).toHaveCount(0);
    if (item.choices['서비스 등급'])
      await expect(form.getByLabel('서비스 등급').locator('option[value="flex"]')).toHaveText(
        'Flex'
      );
    if (item.modelId === 'claude-opus-5-5') {
      await form.getByRole('button', { name: '고급', exact: true }).click();
      const mode = form.getByLabel('사고 모드', { exact: true });
      await expect(mode.locator('optgroup[label="권장"] option')).toHaveText(['적응형']);
      await expect(mode.locator('optgroup[label="권장"] option')).toHaveAttribute(
        'value',
        'adaptive'
      );
      await expect(mode.locator('optgroup[label="기타"] option[value="disabled"]')).toHaveCount(1);
      await form.getByLabel('이 모델 프리셋에 평가 도구 사용').check();
      await expect(
        form.getByLabel('평가 컨텍스트 제공').locator('option[value="preloaded"]')
      ).toHaveJSProperty('disabled', true);
      await expect(form.getByLabel('평가 컨텍스트 제공')).toHaveValue('model-selected');
    }
    await form.getByRole('button', { name: '기본', exact: true }).click();
    expect(
      await page
        .getByRole('dialog', { name: '설정', exact: true })
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
    ).toBe(true);
    if (visualReview)
      await form.screenshot({ path: info.outputPath(`provider-parameters-${index}-mobile.png`) });
    if (item.choices['캐시 방식']) {
      await form.getByRole('button', { name: '고급', exact: true }).click();
      await form.getByLabel('캐시 방식', { exact: true }).scrollIntoViewIfNeeded();
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`provider-cache-${index}-mobile.png`) });
    }
    await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
    await expect
      .poll(async () => (await library(request)).models.find((model) => model.title === title))
      .toMatchObject({ modelId: item.modelId, ...item.saved });
    const saved = (await library(request)).models.find((model) => model.title === title)!;
    for (const key of item.absent) expect(saved).not.toHaveProperty(key);
    expect(connection).not.toHaveProperty('requestTier');
    await openProviderModel(page, title);
    for (const [label, value] of Object.entries(item.choices)) {
      await form.getByRole('button', { name: tabFor(label), exact: true }).click();
      await expect(form.getByLabel(label, { exact: true })).toHaveValue(value!);
    }
    expect(observed.errors).toEqual([]);
    expect(observed.generations).toEqual([]);
    expect(observed.legacyReads).toEqual([]);
  });
}

test('PMUI12 changing provider clears unrepresentable options, keeps common fields and permits unknown model values', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const title = 'PMUI12 ' + Date.now(),
    observed = observe(page),
    connection = await api<Connection>(request, '/connections', {
      title,
      protocol: 'openai-responses-v1',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'PM_SYNTHETIC_KEY',
      enabled: false,
    }),
    anthropic = await api<Connection>(request, '/connections', {
      title: title + ' Anthropic',
      protocol: 'anthropic-messages-v1',
      endpoint: 'https://api.anthropic.com/v1',
      apiKey: 'PM_SYNTHETIC_KEY',
      enabled: false,
    });
  await settings(page);
  await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await form.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
  await form.getByLabel('모델 프리셋 이름').fill(title);
  await form.getByLabel('모델 ID', { exact: true }).fill('gpt-5.6-sol');
  const strength = form.getByLabel('추론 강도', { exact: true });
  await strength.selectOption('none');
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await form.getByLabel('응답 길이', { exact: true }).selectOption('low');
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await form.getByLabel('프로바이더', { exact: true }).selectOption(`${anthropic.id}`);
  await expect(
    form.getByLabel('이전 설정의 추론 강도: reasoningEffort', { exact: true })
  ).toHaveCount(0);
  await expect(form.getByLabel('모델 ID', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('모델 프리셋 이름')).toHaveValue(title);
  await expect(form.getByLabel('최대 출력 토큰')).toHaveValue('8192');
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await expect(form.getByLabel('응답 길이', { exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await form.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
  await form.getByLabel('모델 ID', { exact: true }).fill('gpt-5.6-sol');
  await strength.selectOption('none');
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await form.getByLabel('응답 길이', { exact: true }).selectOption('low');
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await form.getByLabel('모델 ID', { exact: true }).fill('synthetic-future-model');
  await expect(strength).toHaveValue('none');
  await expect(strength.locator('option[value="none"]')).toBeEnabled();
  expect(await strength.evaluate((node) => (node as HTMLSelectElement).checkValidity())).toBe(true);
  if (visualReview)
    await form.screenshot({
      path: info.outputPath('provider-parameters-preserved-invalid-desktop.png'),
    });
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await form.getByLabel('캐시 방식', { exact: true }).selectOption('automatic');
  await form.getByLabel('캐시 유지 시간', { exact: true }).selectOption('30m');
  await form.getByLabel('캐시 방식', { exact: true }).selectOption('disabled');
  await expect(form.getByLabel('캐시 유지 시간', { exact: true })).toHaveValue('30m');
  await form.getByLabel('Temperature', { exact: true }).fill('0');
  await form.locator('.provider-specified-settings > summary').click();
  await expect(form.locator('.provider-specified-settings')).toContainText(/Temperature\s*0/);
  await form.getByRole('button', { name: 'Temperature 지정 해제', exact: true }).click();
  await expect(form.getByLabel('Temperature', { exact: true })).toHaveValue('');
  await expect(strength).toHaveValue('none');
  await expect(form.getByLabel('응답 길이', { exact: true })).toHaveValue('low');
  await expect(form.getByLabel('캐시 유지 시간', { exact: true })).toHaveValue('30m');
  await expect(form.getByLabel('캐시 유지 시간', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true'
  );
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(form.getByLabel('캐시 유지 시간', { exact: true })).toBeFocused();
  expect((await library(request)).models.some((model) => model.title === title)).toBe(false);
  await form.getByRole('button', { name: '캐시 유지 시간 지정 해제', exact: true }).click();
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect
    .poll(async () => (await library(request)).models.find((model) => model.title === title))
    .toMatchObject({
      modelId: 'synthetic-future-model',
      reasoningEffort: 'none',
      verbosity: 'low',
      cacheMode: 'disabled',
    });
  const saved = (await library(request)).models.find((model) => model.title === title);
  expect(saved).not.toHaveProperty('cacheTtl');
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI13 response tests are explicit and late results stay with the original model settings token', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const title = 'PMUI13 ' + Date.now(),
    observed = observe(page),
    connection = await api<Connection>(request, '/connections', connectionInput(title));
  const a = await api<ModelPreset>(request, '/model-presets', modelInput(connection, title + ' A')),
    b = await api<ModelPreset>(request, '/model-presets', modelInput(connection, title + ' B'));
  const posts: { expectedRevision: number; idempotencyKey: string }[] = [];
  let seen!: () => void, release!: () => void;
  const requested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const running: ProviderConnectionTest = {
    id: 'synthetic-response-test-a',
    modelId: a.id,
    modelRevision: a.revision,
    providerModelId: a.modelId,
    connectionId: connection.id,
    createdAt: '2026-09-07T00:00:00.000Z',
    finishedAt: null,
    status: 'running',
    text: '',
    truncated: false,
    latencyMs: null,
    error: null,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
  };
  await page.route(`**/api/provider-management/models/${a.id}/test`, (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(running),
    });
  });
  await page.route('**/api/provider-management/tests/synthetic-response-test-a', async (route) => {
    seen();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...running,
        status: 'completed',
        finishedAt: '2026-09-07T00:00:00.124Z',
        latencyMs: 124,
        text: 'A_ONLY_OK',
        usage: { inputTokens: 7, outputTokens: 2, costUsd: null },
      }),
    });
  });
  await settings(page);
  await page.getByLabel('프로바이더와 모델 검색').fill(title);
  expect(posts).toEqual([]);
  await revealProviderDiagnostics(page, a.title);
  const button = page.getByRole('button', { name: a.title + ' 응답 테스트', exact: true });
  const result = page.getByRole('region', { name: a.title + ' 응답 테스트 결과', exact: true });
  await button.click();
  await expect(result).toContainText('응답 확인 중…');
  await requested;
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ expectedRevision: a.revision });
  expect(posts[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  await page.getByLabel('프로바이더와 모델 검색').fill(b.title);
  await openProviderModel(page, b.title);
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await expect(form.getByLabel('모델 프리셋 이름')).toHaveValue(b.title);
  release();
  await expect(form).not.toContainText('A_ONLY_OK');
  await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  await page.getByLabel('프로바이더와 모델 검색').fill(a.title);
  await expect(result).toContainText('응답에 성공했어요.');
  await expect(result).not.toContainText('A_ONLY_OK');
  await expect(result).not.toContainText('124 ms');
  await expect(result).not.toContainText('입력 7, 출력 2');
  await expect(result).not.toContainText('미확인');
  if (visualReview)
    await result.screenshot({ path: info.outputPath('provider-response-test-mobile.png') });
  expect(posts).toHaveLength(1);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI14 an uncertain response test reuses its key until an explicit new test follows a completed result', async ({
  page,
  request,
}) => {
  const title = 'PMUI14 ' + Date.now(),
    connection = await api<Connection>(request, '/connections', connectionInput(title)),
    model = await api<ModelPreset>(request, '/model-presets', modelInput(connection, title));
  const keys: string[] = [];
  const complete: ProviderConnectionTest = {
    id: 'synthetic-idempotent-test',
    modelId: model.id,
    modelRevision: model.revision,
    providerModelId: model.modelId,
    connectionId: connection.id,
    createdAt: '2026-09-07T00:00:00.000Z',
    finishedAt: '2026-09-07T00:00:00.010Z',
    status: 'completed',
    text: 'OK',
    truncated: false,
    latencyMs: 10,
    error: null,
    usage: { inputTokens: 5, outputTokens: 1, costUsd: null },
  };
  await page.route(`**/api/provider-management/models/${model.id}/test`, (route) => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    return keys.length === 1
      ? route.abort('failed')
      : route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify(complete),
        });
  });
  await settings(page);
  await page.getByLabel('프로바이더와 모델 검색').fill(title);
  await revealProviderDiagnostics(page, title);
  const button = page.getByRole('button', { name: title + ' 응답 테스트', exact: true }),
    result = page.getByRole('region', { name: title + ' 응답 테스트 결과', exact: true });
  await button.click();
  await expect(result.getByRole('alert')).toContainText('실행 결과를 확인하지 못했어요.');
  await result.getByText('오류 상세', { exact: true }).click();
  await expect(result.locator('details p')).not.toBeEmpty();
  await revealProviderDiagnostics(page, title);
  await button.click();
  await expect(result).toContainText('응답에 성공했어요.');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await revealProviderDiagnostics(page, title);
  await button.click();
  await expect.poll(() => keys.length).toBe(3);
  expect(keys[2]).not.toBe(keys[1]);
});

test('PMUI15 a forced Google service tier is shown and conflicting saved choices require an explicit correction', async ({
  page,
  request,
}) => {
  const title = 'PMUI15 ' + Date.now(),
    observed = observe(page),
    connection = await api<Connection>(request, '/connections', {
      title,
      protocol: 'vertex-gemini-v1',
      endpoint:
        'https://aiplatform.googleapis.com/v1/projects/synthetic-forced-tier/locations/global/publishers/google/models',
      apiKey: 'PM_SYNTHETIC_KEY',
      enabled: true,
    });
  const model = await api<ModelPreset>(request, '/model-presets', {
    title,
    connectionId: connection.id,
    modelId: 'gemini-4-carbon',
    maxOutputTokens: 8192,
    temperature: null,
    serviceTier: 'standard',
    enabled: true,
  });
  await page.route('**/api/health', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), vertexRequestTier: 'flex' },
    });
  });
  let writes = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === `/api/model-presets/${model.id}`
    )
      writes++;
  });
  await settings(page);
  await page.getByLabel('프로바이더와 모델 검색').fill(title);
  await openProviderModel(page, title);
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await expect(form.getByRole('button', { name: '기본', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(form).toContainText('서버에서 서비스 등급을 Flex로 제한해요');
  await expect(form.getByLabel('서비스 등급')).toHaveValue('standard');
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect(form.getByLabel('서비스 등급')).toBeFocused();
  expect(writes).toBe(0);
  expect((await library(request)).models.find((item) => item.id === model.id)?.serviceTier).toBe(
    'standard'
  );
  await form.getByLabel('서비스 등급').selectOption('');
  await expect(form).toContainText('모델 기본값도 Flex로 실행돼요');
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect
    .poll(
      async () => (await library(request)).models.find((item) => item.id === model.id)?.revision
    )
    .toBe(2);
  expect((await library(request)).models.find((item) => item.id === model.id)).not.toHaveProperty(
    'serviceTier'
  );
  expect(writes).toBe(1);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI10 Codex subscription login preserves drafts and saves a connection and model without generation', async ({
  page,
  request,
}, info) => {
  let authenticated = false,
    pending = false,
    available = true;
  const mutations: string[] = [];
  await page.route('**/api/agent-runtimes/codex**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(`${request.method()} ${path}`);
    if (path.endsWith('/login/cancel')) pending = false;
    else if (path.endsWith('/login')) pending = true;
    else if (request.method() === 'DELETE') {
      authenticated = false;
      pending = false;
    }
    await route.fulfill({
      json: {
        available,
        authenticated,
        authMode: authenticated ? 'chatgpt' : null,
        error: available ? null : 'CODEX_DISABLED',
        login: pending
          ? {
              id: 'synthetic-login',
              verificationUrl: 'https://auth.openai.com/codex/device',
              userCode: 'ABCD-1234',
            }
          : null,
        planType: authenticated ? 'plus' : null,
        credits: authenticated ? { balance: 61842.4, hasCredits: true, unlimited: false } : null,
        limits: authenticated
          ? [
              {
                name: 'codex · primary',
                usedPercent: 25,
                resetsAt: 1800000000,
                windowDurationMins: 300,
              },
            ]
          : [],
      },
    });
  });
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const observed = observe(page);
  await settings(page);
  await startProviderConnection(page);
  await page
    .getByRole('region', { name: '프로바이더 선택', exact: true })
    .getByRole('button', { name: /Codex/ })
    .click();
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' });
  await form.getByLabel('프로바이더 이름', { exact: true }).fill('보존할 Codex 초안');
  await expect(form.getByLabel('Codex 실행 위치')).toHaveValue('codex://local');
  await expect(form.getByLabel('Codex 실행 위치')).toHaveAttribute('readonly', '');
  await expect(form.getByLabel('API 키')).toBeHidden();
  await selectSettingsSection(page, 'Codex 연결');
  const panel = page.getByRole('region', { name: 'Codex 에이전트 연결' });
  await expect(panel).toContainText('로그인 필요');
  await expect(panel.getByRole('button', { name: 'Codex 상태 다시 확인' })).toHaveCount(0);
  expect(mutations).toEqual([]);
  await panel.getByRole('button', { name: 'ChatGPT로 로그인', exact: true }).click();
  await expect(panel.getByRole('link', { name: '로그인 페이지 열기' })).toHaveAttribute(
    'href',
    'https://auth.openai.com/codex/device'
  );
  await expect(panel).toContainText('ABCD-1234');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await panel.getByRole('button', { name: '로그인 코드 복사', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '로그인 코드를 복사했어요.' })
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ABCD-1234');
  await panel.getByRole('button', { name: '로그인 취소', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Codex 로그인 코드' })).toBeHidden();
  await panel.getByRole('button', { name: 'ChatGPT로 로그인', exact: true }).click();
  authenticated = true;
  pending = false;
  await selectSettingsSection(page, '앱 정보');
  await selectSettingsSection(page, 'Codex 연결');
  await expect(panel).toContainText('연결됨');
  const subscription = panel.getByRole('region', { name: 'Codex 구독 상태' });
  await expect(subscription).toContainText('ChatGPT Plus');
  await expect(subscription).toContainText('5시간 사용량');
  await expect(subscription).toContainText('75% 남음');
  await expect(subscription).toContainText('초기화');
  await expect(subscription).toContainText('61,842 크레딧');
  await expect(panel.getByRole('list', { name: 'Codex 연결 단계' })).toHaveCount(0);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('codex-subscription-settings-mobile.png') });
  await panel.getByRole('button', { name: '프로바이더와 모델', exact: true }).click();
  await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(
    '보존할 Codex 초안'
  );
  await form.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  const modelForm = page.getByRole('form', { name: '모델 편집 양식' });
  await expect(modelForm).toBeVisible();
  const savedConnection = (await library(request)).connections.find(
    (item) => item.title === '보존할 Codex 초안'
  )!;
  expect(savedConnection).toMatchObject({
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  });
  expect(savedConnection.credentialRef).toBeUndefined();
  expect(savedConnection).not.toHaveProperty('requestTier');
  await modelForm.getByLabel('모델 프리셋 이름', { exact: true }).fill('PMUI10 Codex 모델');
  await modelForm.getByLabel('모델 ID', { exact: true }).fill('synthetic-codex-model');
  await modelForm.getByLabel('출력 토큰 예산', { exact: true }).fill('2048');
  await expect(modelForm.getByLabel('Temperature', { exact: true })).toBeHidden();
  await modelForm.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'PMUI10 Codex 모델 모델 프리셋 등록됨' })
  ).toBeVisible();
  const savedModel = (await library(request)).models.find(
    (item) => item.title === 'PMUI10 Codex 모델'
  )!;
  expect(savedModel).toMatchObject({
    connectionId: savedConnection.id,
    modelId: 'synthetic-codex-model',
    maxOutputTokens: 2048,
    temperature: null,
  });
  await selectSettingsSection(page, 'Codex 연결');
  await panel.getByRole('button', { name: '연결 해제', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Codex 연결을 해제할까요?', exact: true })
    .getByRole('button', { name: '연결 해제', exact: true })
    .click();
  await expect(panel).toContainText('로그인 필요');
  available = false;
  await selectSettingsSection(page, '앱 정보');
  await selectSettingsSection(page, 'Codex 연결');
  await expect(panel).toContainText('서버 설정 필요');
  await expect(panel.getByText('서버에서 Codex 연결 기능을 활성화해 주세요.')).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(mutations).toEqual([
    'POST /api/agent-runtimes/codex/login',
    'POST /api/agent-runtimes/codex/login/cancel',
    'POST /api/agent-runtimes/codex/login',
    'DELETE /api/agent-runtimes/codex/session',
  ]);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

preservePromptWorkspace();

test('PMLEAVE provider draft switch saves before replacement and applies reversible disable without another confirmation', async ({
  page,
  request,
}) => {
  const title = 'PMLEAVE ' + Date.now();
  const a = await api<Connection>(request, '/connections', connectionInput(title + ' A'));
  const b = await api<Connection>(request, '/connections', connectionInput(title + ' B'));
  await settings(page);
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page.getByRole('button', { name: a.title + ' 프로바이더 수정', exact: true }).click();
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' });
  const discard = page.getByRole('alertdialog', { name: '편집 중인 초안 확인' });
  const switchToB = async () => {
    await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
    await page.getByRole('button', { name: b.title + ' 프로바이더 수정', exact: true }).click();
    await expect(discard).toBeVisible();
  };
  await form.getByLabel('프로바이더 이름', { exact: true }).fill('');
  await switchToB();
  await discard.getByRole('button', { name: '저장하고 이동', exact: true }).click();
  await expect(discard.getByRole('alert')).toBeVisible();
  expect((await library(request)).connections.find((item) => item.id === a.id)).toEqual(a);
  await discard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await form.getByLabel('프로바이더 이름', { exact: true }).fill(title + ' saved');
  await form.getByLabel('이 프로바이더 사용').uncheck();
  await page.route('**/api/library?view=summary', (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic summary failure' } })
  );
  await switchToB();
  await discard.getByRole('button', { name: '저장하고 이동', exact: true }).click();
  await expect(discard).toBeHidden();
  await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(b.title);
  const saved = (await library(request)).connections.find((item) => item.id === a.id)!;
  expect(saved.title).toBe(title + ' saved');
  expect(saved.revision).toBe(a.revision + 1);
  expect(saved.enabled).toBe(false);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '작업은 완료됐어요. 목록을 다시 불러오지 못했어요.' })
  ).toBeVisible();
});

test('PMDRILL a provider detail replaces the list, returns focus and scroll, and leaves through the same guard', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const title = 'PMDRILL ' + Date.now();
  const created: Connection[] = [];
  for (let index = 0; index < 20; index++)
    created.push(
      await api<Connection>(
        request,
        '/connections',
        connectionInput(`${title} ${String(index).padStart(2, '0')}`)
      )
    );
  const target = created.at(-1)!;
  await settings(page);
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  const scroller = dialog.locator('.settings-page:not([hidden])');
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page.getByLabel('프로바이더와 모델 검색').fill(title);
  const opener = page.getByRole('button', { name: target.title + ' 프로바이더 수정', exact: true });
  await opener.scrollIntoViewIfNeeded();
  const listScroll = await scroller.evaluate((node) => node.scrollTop);
  expect(listScroll).toBeGreaterThan(0);
  await opener.click();
  const detail = dialog.getByRole('region', {
    name: `프로바이더와 모델 / ${target.title}`,
    exact: true,
  });
  await expect(detail).toBeFocused();
  await expect(detail.locator('.settings-detail-location > span')).toHaveText([
    '프로바이더와 모델',
    target.title,
  ]);
  await expect(opener).toBeHidden();
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(0);
  const form = detail.getByRole('form', { name: '프로바이더 편집 양식' });
  const name = form.getByLabel('프로바이더 이름', { exact: true });
  await name.fill(target.title + ' 초안');

  await form.getByRole('button', { name: target.title + ' 프로바이더 삭제', exact: true }).click();
  const remove = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
  await expect(remove).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(remove).toBeHidden();
  await expect(detail).toBeVisible();
  await name.focus();
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(opener).toBeFocused();
  const resume = page.getByRole('button', {
    name: `프로바이더 편집 이어 하기: ${target.title} 초안`,
    exact: true,
  });
  await expect(resume).toBeVisible();
  const returned = await scroller.evaluate((node) => node.scrollTop);
  expect(returned).toBeGreaterThanOrEqual(listScroll - 1);
  expect(returned).toBeLessThanOrEqual(listScroll + (await resume.boundingBox())!.height + 24);
  const view = (await scroller.boundingBox())!;
  const row = (await opener.boundingBox())!;
  expect(row.y).toBeGreaterThanOrEqual(view.y - 1);
  expect(row.y + row.height).toBeLessThanOrEqual(view.y + view.height + 1);

  const guard = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await page.keyboard.press('Escape');
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(guard).toBeHidden();
  await resume.click();
  await expect(detail).toBeFocused();
  await expect(name).toHaveValue(target.title + ' 초안');
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await library(request)).connections.find((item) => item.id === target.id)).toEqual(
    target
  );
});

test('SAVEACK saving both provider drafts stops on a failed write but continues after failed summary reads', async ({
  page,
  request,
}) => {
  const title = 'SAVEACK provider ' + Date.now();
  const connection = await api<Connection>(request, '/connections', connectionInput(title));
  const model = await api<ModelPreset>(
    request,
    '/model-presets',
    modelInput(connection, title + ' model')
  );
  const observed = observe(page);
  await settings(page);
  await openProviderModel(page, model.title);
  const modelForm = page.getByRole('form', { name: '모델 편집 양식', includeHidden: true });
  await modelForm.getByLabel('모델 프리셋 이름', { exact: true }).fill(model.title + ' saved');
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page
    .getByRole('button', { name: connection.title + ' 프로바이더 수정', exact: true })
    .click();
  const connectionForm = page.getByRole('form', {
    name: '프로바이더 편집 양식',
    includeHidden: true,
  });
  await connectionForm
    .getByLabel('프로바이더 이름', { exact: true })
    .fill(connection.title + ' saved');

  let failSave = true;
  const writes: string[] = [];
  const connectionPath = '/api/connections/' + connection.id;
  const modelPath = '/api/model-presets/' + model.id;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && [connectionPath, modelPath].includes(path)) writes.push(path);
  });
  await page.route('**' + connectionPath, async (route) => {
    if (route.request().method() === 'PUT' && failSave)
      await route.fulfill({ status: 503, json: { error: 'Synthetic connection save failure' } });
    else await route.continue();
  });
  await page.route('**/api/library?view=summary', (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic summary failure' } })
  );

  await page.keyboard.press('Escape');
  await expect(connectionForm).toBeHidden();
  await page.keyboard.press('Escape');
  const guard = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await guard.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(guard.getByRole('alert')).toContainText('저장하지 못했어요');
  await expect(connectionForm.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(
    connection.title + ' saved'
  );
  await expect(modelForm.getByLabel('모델 프리셋 이름', { exact: true })).toHaveValue(
    model.title + ' saved'
  );
  const before = await library(request);
  expect(before.connections.find((item) => item.id === connection.id)).toEqual(connection);
  expect(before.models.find((item) => item.id === model.id)).toEqual(model);
  expect(writes).toEqual([connectionPath]);

  failSave = false;
  await guard.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(guard).toBeHidden();
  await expect(page.getByRole('dialog', { name: '설정', exact: true })).toBeHidden();
  await expect(
    page.getByRole('alert').filter({ hasText: '작업은 완료됐어요. 목록을 다시 불러오지 못했어요.' })
  ).toBeVisible();
  const saved = await library(request);
  expect(saved.connections.find((item) => item.id === connection.id)).toMatchObject({
    title: connection.title + ' saved',
    revision: connection.revision + 1,
  });
  expect(saved.models.find((item) => item.id === model.id)).toMatchObject({
    title: model.title + ' saved',
    revision: model.revision + 1,
  });
  expect(writes).toEqual([connectionPath, connectionPath, modelPath]);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
});

test('PMUI model presets group by provider, start collapsed and persist manual order', async ({
  page,
  request,
}, info) => {
  const suffix = Date.now().toString();
  const firstConnection = await api<Connection>(request, '/connections', {
    ...connectionInput(`PMUI group A ${suffix}`),
  });
  const secondConnection = await api<Connection>(request, '/connections', {
    ...connectionInput(`PMUI group B ${suffix}`),
  });
  const alpha = await api<ModelPreset>(request, '/model-presets', {
    ...modelInput(firstConnection, `Alpha ${suffix}`),
    modelId: `gpt-alpha-${suffix}`,
    modelFamily: 'openai',
    displayOrder: 0,
  });
  const beta = await api<ModelPreset>(request, '/model-presets', {
    ...modelInput(firstConnection, `Beta ${suffix}`),
    modelId: `gpt-beta-${suffix}`,
    modelFamily: 'openai',
    displayOrder: 100,
  });
  const gamma = await api<ModelPreset>(request, '/model-presets', {
    ...modelInput(secondConnection, `Gamma ${suffix}`),
    modelId: `gpt-gamma-${suffix}`,
    modelFamily: 'openai',
    displayOrder: 0,
  });

  await settings(page);
  const list = page.getByRole('region', { name: '저장한 모델 프리셋' });
  const firstGroup = list
    .locator('.provider-model-group')
    .filter({ hasText: firstConnection.title });
  const secondGroup = list
    .locator('.provider-model-group')
    .filter({ hasText: secondConnection.title });
  await expect(firstGroup.getByText('모델 2개', { exact: true })).toBeVisible();
  await expect(secondGroup.getByText('모델 1개', { exact: true })).toBeVisible();
  await expect(
    firstGroup.getByRole('button', { name: `${beta.title} 모델 수정`, exact: true })
  ).toBeHidden();
  await expect(
    secondGroup.getByRole('button', { name: `Gamma ${suffix} 모델 수정`, exact: true })
  ).toBeHidden();

  await firstGroup.locator(':scope > summary').click();
  await expect(
    firstGroup.getByRole('button', { name: `${beta.title} 모델 수정`, exact: true })
  ).toBeVisible();
  await expect(
    secondGroup.getByRole('button', { name: `Gamma ${suffix} 모델 수정`, exact: true })
  ).toBeHidden();

  const mutations: string[] = [];
  page.on('request', (r) => {
    if (['POST', 'PUT'].includes(r.method()) && r.url().includes('/api/model-presets'))
      mutations.push(new URL(r.url()).pathname);
  });
  await expect(firstGroup.getByRole('button', { name: /모델 (위로|아래로) 이동/ })).toHaveCount(0);
  await firstGroup
    .getByRole('article', { name: `${beta.title} 모델`, exact: true })
    .dragTo(firstGroup.getByRole('article', { name: `${alpha.title} 모델`, exact: true }), {
      targetPosition: { x: 10, y: 10 },
    });
  await expect(
    page.getByRole('status').filter({ hasText: '표시 순서를 저장했어요.' })
  ).toBeVisible();
  const after = await library(request);
  expect(mutations).toEqual([`/api/model-presets/${beta.id}/move`]);
  expect(after.models.find((item) => item.id === beta.id)?.revision).toBe(beta.revision);
  expect(after.models.find((item) => item.id === beta.id)?.displayOrder).toBe(0);
  expect(after.models.find((item) => item.id === alpha.id)?.displayOrder).toBe(1);

  await firstGroup.locator(':scope > summary').click();
  await expect(
    firstGroup.getByRole('button', { name: `${beta.title} 모델 수정`, exact: true })
  ).toBeHidden();
  await page.getByLabel('프로바이더와 모델 검색').fill(beta.title);
  await expect(
    firstGroup.getByRole('button', { name: `${beta.title} 모델 수정`, exact: true })
  ).toBeVisible();
  await page.getByLabel('프로바이더와 모델 검색').fill('');
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  const providers = page.getByRole('region', { name: '저장한 프로바이더', exact: true });
  const sourceProvider = providers.getByRole('article', {
    name: `${secondConnection.title} 프로바이더`,
    exact: true,
  });
  const targetProvider = providers.getByRole('article', {
    name: `${firstConnection.title} 프로바이더`,
    exact: true,
  });
  await expect(sourceProvider).toHaveAttribute('draggable', 'true');
  await expect(targetProvider).toHaveAttribute('draggable', 'true');
  const expectedOrder = (await library(request)).connections.map((item) => item.id);
  await sourceProvider.scrollIntoViewIfNeeded();
  const sourceBounds = await sourceProvider.boundingBox();
  expect(sourceBounds).not.toBeNull();
  const start = { x: sourceBounds!.x + 20, y: sourceBounds!.y + 20 };
  const moved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/connections/${secondConnection.id}/move`
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    // Begin the native drag before scrolling a long list to the other provider.
    // dragTo scrolls its target while the mouse is down but before this first movement.
    await page.mouse.move(start.x + 20, start.y + 4, { steps: 5 });
    await targetProvider.scrollIntoViewIfNeeded();
    const targetBounds = await targetProvider.boundingBox();
    expect(targetBounds).not.toBeNull();
    await page.mouse.move(targetBounds!.x + 20, targetBounds!.y + 10, { steps: 8 });
  } finally {
    await page.mouse.up();
  }
  const moveResponse = await moved;
  expect(moveResponse.ok(), await moveResponse.text()).toBe(true);
  expect(moveResponse.request().postDataJSON()).toEqual({
    targetId: firstConnection.id,
    position: 'before',
    expectedOrder,
  });
  await expect
    .poll(async () =>
      (await library(request)).connections
        .filter((item) => [firstConnection.id, secondConnection.id].includes(item.id))
        .map((item) => item.id)
    )
    .toEqual([secondConnection.id, firstConnection.id]);
  await page.screenshot({ path: info.outputPath('provider-drag-order.png') });
  await page.goto('/');
  await selectCurrentSettingsSection(page, '역할별 모델');
  const selector = page.getByLabel('본문 모델', { exact: true });
  expect(
    (
      await selector
        .locator('option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
    ).filter((id) => [alpha.id, beta.id, gamma.id].includes(id))
  ).toEqual([gamma.id, beta.id, alpha.id]);
});

test('PMUI Gemini Jailbreak on Agent Platform preserves explicit thresholds and removes only the reset category', async ({
  page,
  request,
}, info) => {
  const title = 'Jailbreak settings ' + crypto.randomUUID();
  const connection = await api<Connection>(request, '/connections', {
    title,
    protocol: 'vertex-gemini-v1',
    endpoint:
      'https://aiplatform.googleapis.com/v1/projects/synthetic-safety/locations/global/publishers/google/models',
    apiKey: 'SYNTHETIC_SAFETY_KEY',
    enabled: true,
  });
  const model = await api<ModelPreset>(request, '/model-presets', {
    ...modelInput(connection, title),
    modelId: 'gemini-4-carbon',
    safetySettings: { HARM_CATEGORY_HATE_SPEECH: 'BLOCK_MEDIUM_AND_ABOVE' },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'dark'));
  await settings(page);
  await openProviderModel(page, title);
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await form.getByRole('button', { name: '고급', exact: true }).click();
  const jailbreak = form.getByLabel('Jailbreak 안전 필터', { exact: true });
  await expect(jailbreak).toHaveValue('');
  await jailbreak.selectOption('BLOCK_NONE');
  await jailbreak.scrollIntoViewIfNeeded();
  await form
    .locator('.provider-stop-sequences')
    .filter({ has: page.getByRole('combobox', { name: 'Jailbreak 안전 필터', exact: true }) })
    .screenshot({ path: info.outputPath('gemini-safety-desktop.png') });
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect
    .poll(
      async () => (await api<ModelPreset>(request, '/model-presets/' + model.id)).safetySettings
    )
    .toEqual({
      HARM_CATEGORY_HATE_SPEECH: 'BLOCK_MEDIUM_AND_ABOVE',
      HARM_CATEGORY_JAILBREAK: 'BLOCK_NONE',
    });
  await settings(page);
  await openProviderModel(page, title);
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await expect(jailbreak).toHaveValue('BLOCK_NONE');
  await jailbreak.selectOption('OFF');
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await api<ModelPreset>(request, '/model-presets/' + model.id)).safetySettings
          ?.HARM_CATEGORY_JAILBREAK
    )
    .toBe('OFF');
  await settings(page);
  await openProviderModel(page, title);
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await jailbreak.selectOption('');
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect
    .poll(
      async () => (await api<ModelPreset>(request, '/model-presets/' + model.id)).safetySettings
    )
    .toEqual({ HARM_CATEGORY_HATE_SPEECH: 'BLOCK_MEDIUM_AND_ABOVE' });
});

test('PMUI Vertex location comparison includes the saved custom location, cancels, retries per location and changes the connection location', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const title = 'PMUI location ' + Date.now(),
    observed = observe(page),
    endpoint = (location: string) =>
      `https://${location}-aiplatform.googleapis.com/v1/projects/synthetic-compare/locations/${location}/publishers/google/models`;
  const connection = await api<Connection>(request, '/connections', {
    title,
    protocol: 'vertex-gemini-v1',
    endpoint: endpoint('asia-south1'),
    apiKey: 'PM_SYNTHETIC_KEY',
    enabled: true,
  });
  const model = await api<ModelPreset>(request, '/model-presets', {
    ...modelInput(connection, title),
    modelId: 'gemini-4-carbon',
  });
  const finished: Record<string, Partial<ProviderConnectionTest>> = {
    'asia-south1': { status: 'completed', latencyMs: 500 },
    'asia-northeast3': { status: 'completed', latencyMs: 120 },
    'us-central1': { status: 'completed', latencyMs: 300 },
    eu: { status: 'error', error: 'HTTP_429' },
    'europe-west4': { status: 'error', error: 'HTTP_404' },
  };
  const posts: { idempotencyKey: string; location: string }[] = [],
    tests = new Map<string, ProviderConnectionTest>(),
    released = new Set<string>();
  const view = (
    id: string,
    location: string,
    outcome?: Partial<ProviderConnectionTest>
  ): ProviderConnectionTest => ({
    id,
    modelId: model.id,
    modelRevision: model.revision,
    providerModelId: model.modelId,
    connectionId: connection.id,
    location,
    createdAt: '2026-11-20T00:00:00.000Z',
    finishedAt: outcome ? '2026-11-20T00:00:01.000Z' : null,
    status: 'running',
    text: outcome?.status === 'completed' ? 'OK' : '',
    truncated: false,
    latencyMs: null,
    error: null,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
    ...outcome,
  });
  await page.route(`**/api/provider-management/models/${model.id}/test`, (route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    const test = view(`synthetic-location-${posts.length}`, body.location, finished[body.location]);
    tests.set(test.id, test);
    if (body.location === 'eu') finished.eu = { status: 'completed', latencyMs: 200 };
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(test),
    });
  });
  await page.route('**/api/provider-management/tests/*', (route) => {
    const test = tests.get(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    if (!test) return route.fulfill({ status: 404, body: '{}' });
    const location = test.location ?? '';
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        released.has(location)
          ? view(test.id, location, { status: 'completed', latencyMs: 640 })
          : test
      ),
    });
  });
  await settings(page);
  await page.getByLabel('프로바이더와 모델 검색').fill(title);
  await openProviderMenu(page, '모델', title);
  const card = page.getByRole('article', { name: `${title} 모델`, exact: true });
  const compare = card.getByRole('button', { name: '위치별 응답 비교', exact: true });
  await expect(compare).toHaveAccessibleDescription('9개 위치에 짧은 요청을 하나씩 보내요.');
  await expect(card.getByText('9개 위치에 짧은 요청을 하나씩 보내요.')).toBeVisible();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('provider-location-menu-mobile.png') });
  await compare.click();
  const region = page.getByRole('region', { name: `${title} 응답 테스트 결과`, exact: true }),
    list = region.getByRole('list', { name: `${title} 위치별 응답`, exact: true }),
    row = (label: string) => list.getByRole('listitem').filter({ hasText: label });
  await expect(list.getByRole('listitem')).toHaveCount(9);
  await expect.poll(() => posts.length).toBe(9);
  expect(posts.map((post) => post.location).sort()).toEqual([
    'asia-northeast1',
    'asia-northeast3',
    'asia-south1',
    'eu',
    'europe-west4',
    'global',
    'us',
    'us-central1',
    'us-east4',
  ]);
  await expect(row('asia-south1')).toContainText('현재 위치');
  await expect(row('asia-south1')).toContainText('0.5초');
  await expect(row('asia-south1').getByRole('button')).toHaveCount(0);
  await expect(row('asia-northeast3 (서울)')).toContainText('가장 빠름');
  await expect(row('global (Google 자동 배치)')).toContainText('응답 확인 중…');
  await expect(row('europe-west4 (네덜란드)')).toContainText('이 위치에서는 제공하지 않아요');
  await expect(row('europe-west4 (네덜란드)').getByRole('button')).toHaveCount(0);

  await region.getByRole('button', { name: `${title} 위치별 응답 비교 취소`, exact: true }).click();
  await expect(row('global (Google 자동 배치)')).toContainText('확인을 취소했어요');
  await expect(region.getByRole('button', { name: /위치별 응답 비교 취소/ })).toHaveCount(0);
  if (visualReview)
    await region.screenshot({ path: info.outputPath('provider-location-compare-mobile.png') });

  await row('eu (유럽 다중 리전)')
    .getByRole('button', { name: 'eu (유럽 다중 리전) 다시 시도', exact: true })
    .click();
  await expect(row('eu (유럽 다중 리전)')).toContainText('0.2초');
  expect(posts).toHaveLength(10);
  expect(posts[9].idempotencyKey).not.toBe(
    posts.find((post) => post.location === 'eu')?.idempotencyKey
  );

  released.add('global');
  await row('global (Google 자동 배치)')
    .getByRole('button', { name: 'global (Google 자동 배치) 다시 시도', exact: true })
    .click();
  await expect(row('global (Google 자동 배치)')).toContainText('0.6초');
  expect(posts).toHaveLength(10);

  await row('asia-northeast3 (서울)')
    .getByRole('button', { name: '이 위치로 변경: asia-northeast3 (서울)', exact: true })
    .click();
  await expect(page.getByText(`${title} 프로바이더 변경 저장됨`)).toBeVisible();
  await expect
    .poll(async () => (await api<Connection>(request, `/connections/${connection.id}`)).endpoint)
    .toBe(endpoint('asia-northeast3'));
  await expect(row('asia-northeast3 (서울)')).toContainText('현재 위치');
  await expect(row('asia-south1')).not.toContainText('현재 위치');
  await expect(
    row('asia-south1').getByRole('button', { name: '이 위치로 변경: asia-south1', exact: true })
  ).toBeVisible();
  await expect(list).toBeFocused();

  const moved = await api<Connection>(request, `/connections/${connection.id}`);
  await api(
    request,
    `/connections/${connection.id}`,
    connectionBody(moved, { title: `${title} renamed` }),
    'PUT'
  );
  const useIowa = row('us-central1 (아이오와)').getByRole('button', {
    name: '이 위치로 변경: us-central1 (아이오와)',
    exact: true,
  });
  await useIowa.click();
  await expect(page.getByTestId('connection-editor').getByRole('alert')).toBeVisible();
  expect((await api<Connection>(request, `/connections/${connection.id}`)).endpoint).toBe(
    endpoint('asia-northeast3')
  );
  await useIowa.click();
  await expect
    .poll(async () => (await api<Connection>(request, `/connections/${connection.id}`)).endpoint)
    .toBe(endpoint('us-central1'));
  expect(posts).toHaveLength(10);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
});
