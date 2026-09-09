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
  credentialEnv: 'PM_SYNTHETIC_KEY',
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
  credentialEnv: item.credentialEnv,
  enabled: item.enabled,
  expectedRevision: item.revision,
  ...changes,
});
async function settings(page: Page) {
  await page.goto('/');
  const button = page.getByRole('button', { name: '설정', exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  await button.click();
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
  await page.setViewportSize({ width: 390, height: 844 });
  const title = 'PMUI01 ' + Date.now(),
    observed = observe(page);
  await settings(page);
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' }),
    modelForm = page.getByRole('form', { name: '모델 편집 양식' });
  await startProviderConnection(page);
  await page
    .getByRole('region', { name: '제공자 선택', exact: true })
    .getByRole('button', { name: /OpenAI · Responses/ })
    .click();
  await form.getByLabel('프로바이더 프로토콜').selectOption('openai-responses-v1');
  await expect(form.getByLabel('API 기본 주소')).toHaveValue('https://api.openai.com/v1');
  await form.getByText('프로바이더 템플릿 정보', { exact: true }).click();
  await expect(form.getByText('openai-responses-v1', { exact: true })).toBeVisible();
  await expect(form).toContainText(/\d{4}-\d{2}-\d{2}/);
  await form.getByLabel('API 기본 주소').fill('http://127.0.0.1:9/v1');
  await form.getByLabel('프로바이더 이름', { exact: true }).fill(title);
  await form.getByLabel('서버 환경변수 이름').fill('PM_SYNTHETIC_KEY');
  await form.getByLabel('이 프로바이더 사용').check();
  await form.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: title + ' 프로바이더 등록됨' })
  ).toBeVisible();
  const connection = (await library(request)).connections.find((item) => item.title === title)!;
  expect(connection).toBeTruthy();
  await expect(modelForm.getByLabel('프로바이더', { exact: true })).toHaveValue(`${connection.id}`);
  await modelForm.getByText('프로바이더 준비 상태와 목록 새로고침', { exact: true }).click();
  await expect(
    modelForm.getByRole('region', { name: '선택한 프로바이더 준비 상태' })
  ).toContainText('사용 전 설정 확인이 필요해요');
  // Only the UI's error handling is mocked; no outbound catalog request is sent.
  await page.route(`**/api/connections/${connection.id}/catalog`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...connection, catalogError: 'CATALOG_UNAVAILABLE' }),
    })
  );
  await modelForm.getByLabel('모델 ID', { exact: true }).fill('synthetic/manual-id');
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
      .filter({ hasText: '새 모델 선택에 표시' })
      .screenshot({ path: info.outputPath('model-visibility-switch.png') });
  await modelForm.getByRole('button', { name: '고급', exact: true }).click();
  await expect(modelForm.getByLabel('이 모델 프리셋에 평가 도구 4개 사용')).not.toBeChecked();
  await modelForm.getByLabel('이 모델 프리셋에 평가 도구 4개 사용').check();
  if (visualReview)
    await modelForm
      .locator('.toggle-row')
      .filter({ hasText: '이 모델 프리셋에 평가 도구 4개 사용' })
      .screenshot({ path: info.outputPath('model-evaluation-switch.png') });

  await modelForm.getByLabel('최대 평가 도구 라운드').fill('2');
  await expect(modelForm.getByLabel('이 모델 프리셋에 문맥 메모·전환 도구 사용')).not.toBeChecked();
  await modelForm.getByLabel('이 모델 프리셋에 문맥 메모·전환 도구 사용').check();
  await modelForm.getByText('요금과 추정 비용', { exact: true }).click();
  await modelForm.getByLabel('요금 기준', { exact: true }).selectOption('manual');
  await modelForm.getByLabel('Standard 입력 요금', { exact: true }).fill('2');
  await modelForm.getByLabel('Standard 출력 요금', { exact: true }).fill('8');
  for (const label of [
    '모델 프리셋 이름',
    '프로바이더',
    '모델 ID',
    '평가 문맥 제공',
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
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await modelForm.getByLabel('Standard 입력 요금').scrollIntoViewIfNeeded();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('provider-management-mobile-pricing.png') });
  await modelForm.getByRole('button', { name: '기본', exact: true }).click();
  await modelForm.getByLabel('모델 프리셋 이름').scrollIntoViewIfNeeded();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('provider-management-mobile-model.png') });
  await modelForm.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: title + ' 수동 모델 모델 프리셋 등록됨' })
  ).toBeVisible();
  const saved = (await library(request)).models.find(
    (item) => item.title === title + ' 수동 모델'
  )!;
  expect(saved).toMatchObject({
    connectionId: connection.id,
    modelId: 'synthetic/manual-id',
    evaluationTools: { maximumToolRounds: 2 },
    contextTools: true,
    source: { kind: 'manual', catalogUpdatedAt: null },
  });
  await expect(page.getByRole('region', { name: '등록한 모델 사용 방법' })).toContainText(
    '설정 → 현재 모델에서 사용할 역할을 선택하고 저장해요.'
  );
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI02 connection clone requires review and stale edits retain their draft and CAS revision until explicit reload', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const title = 'PMUI02 ' + Date.now(),
    observed = observe(page);
  const original = await api<Connection>(request, '/connections', connectionInput(title));
  await settings(page);
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' });
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page.getByLabel('프로바이더·모델 검색').fill(title);
  await openProviderMenu(page, '프로바이더', title);
  await page.getByRole('button', { name: title + ' 프로바이더 복제', exact: true }).click();
  await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(title + ' 복사');
  await expect(form.getByLabel('이 프로바이더 사용')).not.toBeChecked();
  await expect(form.getByLabel('서버 환경변수 이름')).toHaveValue('PM_SYNTHETIC_KEY');
  expect(
    (await library(request)).connections.filter((item) => item.title.startsWith(title))
  ).toHaveLength(1);
  await form.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: title + ' 복사 프로바이더 등록됨' })
  ).toBeVisible();
  const copied = (await library(request)).connections.find(
    (item) => item.title === title + ' 복사'
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
  await page.getByRole('button', { name: '목록 새로고침', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '목록을 새로 읽었어요' })).toBeVisible();
  await expect(form.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(title + ' 내 초안');
  await expect(form).toContainText('다른 곳에서 프로바이더가 변경됐어요');
  const put = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith(`/connections/${original.id}`)
  );
  await form.getByRole('button', { name: '프로바이더 변경 저장', exact: true }).click();
  expect((await put).postDataJSON().expectedRevision).toBe(1);
  await expect(form.getByRole('alert')).toContainText('초안은 유지했어요');
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
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  await page.getByLabel('프로바이더·모델 검색').fill(title);
  await page.getByRole('button', { name: original.title + ' 모델 수정', exact: true }).click();
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
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await actions.scrollIntoViewIfNeeded();
    for (const action of [closeAction, deleteAction]) {
      await expect(action).toBeVisible();
      await expect(action.locator('svg')).toHaveCount(1);
      await expect(action).toHaveText('');
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeCloseTo(44, 0);
      expect(box!.height).toBeCloseTo(44, 0);
    }
    // Saving is the confirming action, so it keeps the glyph and says the word.
    await expect(saveAction).toBeVisible();
    await expect(saveAction.locator('svg')).toHaveCount(1);
    await expect(saveAction).toHaveText('저장');
    const saveBounds = (await saveAction.boundingBox())!;
    expect(saveBounds.width).toBeGreaterThanOrEqual(44);
    expect(saveBounds.height).toBeCloseTo(44, 0);
    const saveBox = (await saveAction.boundingBox())!;
    const closeBox = (await closeAction.boundingBox())!;
    const deleteBox = (await deleteAction.boundingBox())!;
    const actionsBox = (await actions.boundingBox())!;
    expect(deleteBox.x).toBeLessThan(closeBox.x);
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(saveBox.x);
    expect(saveBox.x + saveBox.width).toBeCloseTo(actionsBox.x + actionsBox.width, 0);
    expect(deleteBox.y).toBeCloseTo(saveBox.y, 0);
    expect(closeBox.y).toBeCloseTo(saveBox.y, 0);
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
  await expect(form.getByLabel('모델 프리셋 이름')).toHaveValue(changed.title + ' 복사');
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
    (item) => item.title === changed.title + ' 복사'
  )!;
  expect(copied.id).not.toBe(original.id);
  expect(copied).toMatchObject({
    maxOutputTokens: 4096,
    evaluationTools: original.evaluationTools,
  });
  await openProviderMenu(page, '모델', changed.title);
  await page.getByRole('button', { name: changed.title + ' 모델 비활성', exact: true }).click();
  const confirmation = page.getByRole('region', { name: '비활성 영향 확인' });
  await expect(confirmation).toContainText('이 모델을 사용하는 이후 실행이 차단');
  expect((await library(request)).models.find((item) => item.id === original.id)?.enabled).toBe(
    true
  );
  await confirmation.getByRole('button', { name: '모델 비활성 확인', exact: true }).click();
  await expect
    .poll(
      async () => (await library(request)).models.find((item) => item.id === original.id)?.enabled
    )
    .toBe(false);
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await openProviderMenu(page, '프로바이더', title + ' 연결 최신판');
  await page
    .getByRole('button', { name: title + ' 연결 최신판 프로바이더 비활성', exact: true })
    .click();
  await expect(confirmation).toContainText('이 프로바이더를 사용하는 이후 호출이 차단');
  await confirmation.getByRole('button', { name: '비활성 취소', exact: true }).click();
  expect(
    (await library(request)).connections.find((item) => item.id === connection.id)?.enabled
  ).toBe(true);
  await page.keyboard.press('Escape');
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('button', { name: /^현재 본문 모델/ })).toContainText(changed.title);
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await selectCurrentSettingsSection(page, '모델');
  await expect(page.getByLabel('원문 모델', { exact: true })).toHaveValue(`${original.id}`);
  await expect(
    page.getByLabel('원문 모델', { exact: true }).locator('option:checked')
  ).toContainText(changed.title + ' · 모델 또는 프로바이더 비활성');
  await expect(
    page.getByLabel('원문 모델', { exact: true }).locator('option:checked')
  ).not.toContainText(' · v');
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

test('PMUI04 a delayed readiness response cannot replace the currently selected connection status', async ({
  page,
  request,
}, info) => {
  const title = 'PMUI04 ' + Date.now(),
    first = await api<Connection>(request, '/connections', connectionInput(title + ' 먼저')),
    second = await api<Connection>(request, '/connections', connectionInput(title + ' 나중'));
  let release!: () => Promise<void>, seen!: () => void;
  const firstRequested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  await page.route(
    `**/api/provider-management/connections/${first.id}/readiness`,
    async (route) => {
      seen();
      await new Promise<void>((resolve) => {
        release = async () => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              enabled: false,
              originApproved: false,
              credentialStatus: 'missing',
              catalogKind: 'remote',
            }),
          });
          resolve();
        };
      });
    }
  );
  await page.route(`**/api/provider-management/connections/${second.id}/readiness`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        originApproved: true,
        credentialStatus: 'configured',
        catalogKind: 'remote',
      }),
    })
  );
  await settings(page);
  await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await form.getByLabel('프로바이더', { exact: true }).selectOption(`${first.id}`);
  await firstRequested;
  await form.getByText('프로바이더 준비 상태와 목록 새로고침', { exact: true }).click();
  await form.getByLabel('프로바이더', { exact: true }).selectOption(`${second.id}`);
  const readiness = form.getByRole('region', { name: '선택한 프로바이더 준비 상태' });
  await expect(readiness).toContainText(second.title);
  await expect(readiness).toContainText('서버 설정 준비됨');
  await release();
  await expect(readiness).toContainText(second.title);
  await expect(readiness).not.toContainText('인증 참조 설정 필요');
  if (visualReview)
    await readiness.screenshot({
      path: info.outputPath('provider-management-current-readiness.png'),
    });
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
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await settings(page);
    const title = `PMUI07 ${width} ${Date.now()}`,
      form = page.getByRole('form', { name: '프로바이더 편집 양식' }),
      modelForm = page.getByRole('form', { name: '모델 편집 양식' });
    await startProviderConnection(page);
    await expect(page.getByRole('list', { name: '빠른 프로바이더 진행' })).toContainText(
      '1 제공자'
    );
    await page.getByText('개발·검사용 프로바이더', { exact: true }).click();
    await page.getByRole('button', { name: '로컬 fixture로 설정', exact: true }).click();
    await form.getByLabel('프로바이더 이름', { exact: true }).fill(title);
    await form.getByLabel('로컬 endpoint').fill('http://127.0.0.1:9/turn');
    await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
    await expect(form).not.toBeVisible();
    await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
    await page
      .getByRole('button', { name: '프로바이더 편집 이어서 · ' + title, exact: true })
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
    // The real catalog route saves before reloading the library; mirror that read view without contacting a provider.
    await page.route(`**/api/connections/${connection.id}/catalog`, (route) => {
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
    await modelForm.getByText('프로바이더 준비 상태와 목록 새로고침', { exact: true }).click();
    await modelForm.getByRole('button', { name: '모델 목록 새로고침', exact: true }).click();
    await modelForm.getByLabel('모델 목록 검색').fill('catalog-beta');
    const picker = modelForm.getByRole('region', { name: '저장된 모델 목록에서 선택' });
    await expect(picker.getByRole('button')).toHaveCount(1);
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
      .getByRole('button', { name: '모델 편집 이어서 · ' + title + ' Beta', exact: true })
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

test('PMUI08 Vertex JSON upload validates locally and saves only the returned credential reference', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settings(page);
  const title = 'PMUI08 ' + Date.now(),
    observed = observe(page);
  await startProviderConnection(page);
  await page
    .getByRole('region', { name: '제공자 선택', exact: true })
    .getByRole('button', { name: /Google Agent Platform/ })
    .click();
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' }),
    upload = form.getByRole('region', { name: 'Google 서비스 계정 JSON' }),
    file = upload.getByLabel('Google 키 JSON 파일');
  const originalEndpoint =
    'https://aiplatform.googleapis.com/v1/projects/synthetic-original/locations/global/publishers/google/models';
  await form.getByLabel('프로바이더 이름', { exact: true }).fill(title);
  await form.getByLabel('Google Agent Platform endpoint').fill(originalEndpoint);
  await form.getByLabel('서버 환경변수 이름').fill('NARRATIVE_PROVIDER_SYNTHETIC_ORIGINAL');
  const projectId = 'synthetic-project',
    clientEmail = 'test@synthetic-project.iam.gserviceaccount.com';
  let uploads = 0;
  let uploadBody: unknown;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/provider-management/vertex-credentials')) {
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
    await expect(form.getByLabel('Google Agent Platform endpoint')).toHaveValue(originalEndpoint);
    await expect(form.getByLabel('서버 환경변수 이름')).toHaveValue(
      'NARRATIVE_PROVIDER_SYNTHETIC_ORIGINAL'
    );
    expect(uploads).toBe(0);
  }
  // Fresh synthetic RSA material exercises real isolated file storage; no OAuth or Vertex call is needed.
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
      r.url().endsWith('/api/provider-management/vertex-credentials') &&
      r.request().method() === 'POST'
  );
  await file.setInputFiles({
    name: 'synthetic-service-account.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(serviceAccount)),
  });
  await expect(upload.getByRole('status')).toContainText(projectId);
  const uploadResponse = await uploaded;
  expect(uploadResponse.ok()).toBeTruthy();
  const { credentialEnv } = (await uploadResponse.json()) as { credentialEnv: string };
  expect(credentialEnv).toMatch(/^NARRATIVE_PROVIDER_VERTEX_FILE_[A-F0-9]{32}$/);
  expect(uploads).toBe(1);
  expect(uploadBody).toEqual({ serviceAccount });
  await expect(form.getByLabel('서버 환경변수 이름')).toHaveValue(credentialEnv);
  const authSettings = form.locator('.provider-auth-settings'),
    changeAuth = form.getByRole('button', {
      name: '서버 ADC / 환경변수 방식으로 변경',
      exact: true,
    });
  await expect(form.getByText('등록한 JSON으로 인증해요.', { exact: false })).toBeVisible();
  await expect(changeAuth).toBeHidden();
  await authSettings.getByText('고급 인증 설정', { exact: true }).click();
  await expect(changeAuth).toBeVisible();
  await expect(form.getByLabel('서버 환경변수 이름')).toHaveValue(credentialEnv);
  await authSettings.getByText('고급 인증 설정', { exact: true }).click();
  await expect(changeAuth).toBeHidden();
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models`;
  await expect(form.getByLabel('Google Agent Platform endpoint')).toHaveValue(endpoint);
  expect(
    await page.getByRole('dialog', { name: '설정', exact: true }).evaluate((node) => node.outerHTML)
  ).not.toContain(serviceAccount.private_key);
  await expect(file).toHaveValue('');
  await upload.scrollIntoViewIfNeeded();
  if (visualReview)
    await page.screenshot({
      path: info.outputPath('provider-management-vertex-upload-mobile.png'),
    });
  const posted = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/api/connections')
  );
  await form.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  expect((await posted).postDataJSON()).toMatchObject({
    credentialEnv,
    endpoint,
    title,
    protocol: 'vertex-gemini-v1',
  });
  await expect
    .poll(async () => (await library(request)).connections.find((item) => item.title === title))
    .toMatchObject({ credentialEnv, endpoint });
  expect(JSON.stringify(await library(request))).not.toContain('BEGIN PRIVATE KEY');
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page.getByLabel('프로바이더·모델 검색').fill(title);
  await page.getByRole('button', { name: title + ' 프로바이더 수정', exact: true }).click();
  await expect(changeAuth).toBeHidden();
  await authSettings.getByText('고급 인증 설정', { exact: true }).click();
  await changeAuth.click();
  await expect(form.getByLabel('서버 환경변수 이름')).toBeVisible();
  await expect(form.getByLabel('서버 환경변수 이름')).toHaveValue('');
  expect(
    (await library(request)).connections.find((item) => item.title === title)?.credentialEnv
  ).toBe(credentialEnv);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI09 invalid hidden model fields receive focus and old deactivation confirmation cannot follow another draft', async ({
  page,
  request,
}) => {
  const title = 'PMUI09 ' + Date.now(),
    connection = await api<Connection>(request, '/connections', {
      title,
      protocol: 'anthropic-messages-v1',
      endpoint: 'https://api.anthropic.com/v1',
      credentialEnv: 'NARRATIVE_PROVIDER_ANTHROPIC',
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
  // An unsendable combination hidden in the other tab still receives focus with its tab opened.
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
  await page.getByRole('button', { name: a.title + ' 모델 수정', exact: true }).click();
  form = page.getByRole('form', { name: '모델 편집 양식' });
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await form.getByRole('switch', { name: '새 모델 선택에 표시' }).uncheck();
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  const confirmation = page.getByRole('region', { name: '비활성 영향 확인' });
  await expect(confirmation).toContainText(a.title);
  await expect(form.getByLabel('최대 출력 토큰')).toBeDisabled();
  await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await page.getByRole('button', { name: b.title + ' 모델 수정', exact: true }).click();
  const discard = page.getByRole('alertdialog', { name: '편집 중인 초안 확인' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: '초안 버리고 계속', exact: true }).click();
  await expect(form.getByLabel('모델 프리셋 이름')).toHaveValue(b.title);
  await form.getByLabel('모델 프리셋 이름').fill(b.title + ' 내 초안');
  await expect(confirmation).toHaveCount(0);
  expect((await library(request)).models.find((item) => item.id === a.id)).toEqual(a);
  expect((await library(request)).models.find((item) => item.id === b.id)).toEqual(b);
  expect(modelWrites).toBe(0);
});

test('PMUI11 documented provider options lead each select, round-trip without generation, and include GPT Flex and Fable', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const observed = observe(page),
    prefix = 'PMUI11 ' + Date.now();
  const tabFor = (label: string) =>
    ['사고 강도', '서비스 등급'].includes(label) ? '기본' : '고급';
  const cases = [
    {
      protocol: 'vercel-chat-v1',
      endpoint: 'https://ai-gateway.vercel.sh/v1',
      modelId: 'openai/gpt-5.6-sol',
      choices: { '사고 강도': 'high', '서비스 등급': 'flex' },
      saved: { reasoningEffort: 'high', serviceTier: 'flex' },
      absent: ['thinkingLevel'],
      hidden: ['Thinking Level', 'Output Effort', 'Verbosity'],
    },
    {
      protocol: 'vertex-gemini-v1',
      endpoint:
        'https://aiplatform.googleapis.com/v1/projects/synthetic-parameters/locations/global/publishers/google/models',
      modelId: 'gemini-3.1-pro-preview',
      choices: { '서비스 등급': 'flex' },
      saved: { serviceTier: 'flex' },
      absent: ['thinkingLevel'],
      hidden: ['Verbosity', '사고 모드'],
    },
    {
      protocol: 'vertex-gemini-v1',
      endpoint:
        'https://aiplatform.googleapis.com/v1/projects/synthetic-parameters/locations/global/publishers/google/models',
      modelId: 'gemini-3.8-flash',
      choices: { '사고 강도': 'HIGH', '서비스 등급': 'flex' },
      saved: { thinkingLevel: 'HIGH', serviceTier: 'flex' },
      absent: ['outputEffort'],
      hidden: ['Verbosity', '사고 모드'],
    },
    {
      protocol: 'openai-responses-v1',
      endpoint: 'https://api.openai.com/v1',
      modelId: 'gpt-5.6-sol',
      choices: {
        '사고 강도': 'none',
        Verbosity: 'high',
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
      hidden: ['사고 모드'],
    },
    {
      protocol: 'anthropic-messages-v1',
      endpoint: 'https://api.anthropic.com/v1',
      modelId: 'claude-opus-5',
      choices: {
        '사고 강도': 'high',
        '사고 모드': 'disabled',
        '캐시 방식': 'explicit',
        '캐시 유지 시간': '5m',
      },
      saved: {
        outputEffort: 'high',
        thinkingMode: 'disabled',
        cacheMode: 'explicit',
        cacheTtl: '5m',
      },
      absent: ['reasoningEffort'],
      hidden: ['Verbosity'],
    },
    {
      protocol: 'anthropic-messages-v1',
      endpoint: 'https://api.anthropic.com/v1',
      modelId: 'claude-fable-5-1',
      choices: { '사고 강도': 'max', '캐시 방식': 'automatic', '캐시 유지 시간': '1h' },
      saved: { outputEffort: 'max', cacheMode: 'automatic', cacheTtl: '1h' },
      absent: ['reasoningEffort', 'thinkingMode'],
      hidden: ['Verbosity'],
    },
  ];
  for (const [index, item] of cases.entries()) {
    const title = prefix + ' ' + item.modelId,
      connection = await api<Connection>(request, '/connections', {
        title,
        protocol: item.protocol,
        endpoint: item.endpoint,
        credentialEnv: 'PM_SYNTHETIC_KEY',
        enabled: false,
      });
    await settings(page);
    await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
    const form = page.getByRole('form', { name: '모델 편집 양식' });
    await form.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
    await form.getByLabel('모델 프리셋 이름').fill(title);
    await form.getByLabel('모델 ID', { exact: true }).fill(item.modelId);
    await expect(form.getByLabel('모델 ID', { exact: true })).toBeEditable();
    await expect(form.getByTestId('model-hint-source')).toHaveCount(0);
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
    if (item.modelId === 'claude-fable-5-1') {
      await form.getByRole('button', { name: '고급', exact: true }).click();
      // Fable documents adaptive thinking only; disabling stays selectable as an unverified value.
      const mode = form.getByLabel('사고 모드', { exact: true });
      await expect(mode.locator('optgroup[label="문서로 확인한 값"] option')).toHaveText([
        '적응형 · adaptive',
      ]);
      await expect(
        mode.locator('optgroup[label="미확인 값 · 공급자가 판정"] option[value="disabled"]')
      ).toHaveCount(1);
      await form.getByLabel('이 모델 프리셋에 평가 도구 4개 사용').check();
      await expect(
        form.getByLabel('평가 문맥 제공').locator('option[value="preloaded"]')
      ).toHaveJSProperty('disabled', true);
      await expect(form.getByLabel('평가 문맥 제공')).toHaveValue('model-selected');
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
    await page.getByRole('button', { name: title + ' 모델 수정', exact: true }).click();
    for (const [label, value] of Object.entries(item.choices)) {
      await form.getByRole('button', { name: tabFor(label), exact: true }).click();
      await expect(form.getByLabel(label, { exact: true })).toHaveValue(value!);
    }
  }
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

test('PMUI12 changing the model or connection keeps choices visible as unverified or unsendable, and only unsendable values block saving', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const title = 'PMUI12 ' + Date.now(),
    observed = observe(page),
    connection = await api<Connection>(request, '/connections', {
      title,
      protocol: 'openai-responses-v1',
      endpoint: 'https://api.openai.com/v1',
      credentialEnv: 'PM_SYNTHETIC_KEY',
      enabled: false,
    }),
    anthropic = await api<Connection>(request, '/connections', {
      title: title + ' Anthropic',
      protocol: 'anthropic-messages-v1',
      endpoint: 'https://api.anthropic.com/v1',
      credentialEnv: 'PM_SYNTHETIC_KEY',
      enabled: false,
    });
  await settings(page);
  await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await form.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
  await form.getByLabel('모델 프리셋 이름').fill(title);
  await form.getByLabel('모델 ID', { exact: true }).fill('gpt-5.6-sol');
  const strength = form.getByLabel('사고 강도', { exact: true });
  await strength.selectOption('none');
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await form.getByLabel('Verbosity', { exact: true }).selectOption('low');
  // Switching to another protocol keeps the choices visible as unsendable until the user clears them.
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await form.getByLabel('프로바이더', { exact: true }).selectOption(`${anthropic.id}`);
  const stale = form.getByLabel('이전 프로바이더의 사고 강도 · reasoningEffort', { exact: true });
  await expect(stale).toHaveValue('none');
  await expect(form).toContainText('이 프로바이더에서 보낼 수 없어요');
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await expect(form.getByLabel('Verbosity', { exact: true })).toHaveValue('low');
  await form.getByLabel('Verbosity', { exact: true }).selectOption('');
  await expect(form.getByLabel('Verbosity', { exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await stale.selectOption('');
  await expect(stale).toHaveCount(0);
  await form.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
  await form.getByLabel('모델 ID', { exact: true }).fill('gpt-5.6-sol');
  await strength.selectOption('none');
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await form.getByLabel('Verbosity', { exact: true }).selectOption('low');
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await form.getByLabel('모델 ID', { exact: true }).fill('gpt-6-astra');
  // Astra documents no `none`: the choice is kept and marked unverified rather than rewritten or blocked.
  await expect(strength).toHaveValue('none');
  await expect(
    strength.locator('optgroup[label="미확인 값 · 공급자가 판정"] option[value="none"]')
  ).toHaveCount(1);
  await expect(form).toContainText('이 모델의 지원 여부가 확인되지 않은 값이에요.');
  if (visualReview)
    await form.screenshot({
      path: info.outputPath('provider-parameters-preserved-invalid-desktop.png'),
    });
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await form.getByLabel('캐시 방식').selectOption('automatic');
  await form.getByLabel('캐시 유지 시간').selectOption('30m');
  await form.getByLabel('캐시 방식').selectOption('disabled');
  await expect(form).toContainText('프롬프트의 캐시 기준점도 적용하지 않아요');
  await expect(form.getByLabel('캐시 유지 시간')).toHaveValue('30m');
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(form.getByLabel('캐시 유지 시간')).toBeFocused();
  expect((await library(request)).models.some((model) => model.title === title)).toBe(false);
  await form.getByLabel('캐시 유지 시간').selectOption('');
  await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect
    .poll(async () => (await library(request)).models.find((model) => model.title === title))
    .toMatchObject({
      modelId: 'gpt-6-astra',
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
  await page.setViewportSize({ width: 390, height: 844 });
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
  await page.getByLabel('프로바이더·모델 검색').fill(title);
  expect(posts).toEqual([]);
  await revealProviderDiagnostics(page, a.title);
  const button = page.getByRole('button', { name: a.title + ' 응답 테스트', exact: true });
  await button.click();
  await expect(button).toBeDisabled();
  await requested;
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ expectedRevision: a.revision });
  expect(posts[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  await page.getByLabel('프로바이더·모델 검색').fill(b.title);
  await page.getByRole('button', { name: b.title + ' 모델 수정', exact: true }).click();
  const form = page.getByRole('form', { name: '모델 편집 양식' });
  await expect(form.getByLabel('모델 프리셋 이름')).toHaveValue(b.title);
  release();
  await expect(form).not.toContainText('A_ONLY_OK');
  await page.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  await page.getByLabel('프로바이더·모델 검색').fill(a.title);
  const result = page.getByRole('region', { name: a.title + ' 응답 테스트 결과', exact: true });
  await expect(result).toContainText('응답에 성공했어요.');
  await expect(result).not.toContainText('A_ONLY_OK');
  await expect(result).not.toContainText('124 ms');
  await expect(result).not.toContainText('입력 7 · 출력 2');
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
  await page.getByLabel('프로바이더·모델 검색').fill(title);
  await revealProviderDiagnostics(page, title);
  const button = page.getByRole('button', { name: title + ' 응답 테스트', exact: true }),
    result = page.getByRole('region', { name: title + ' 응답 테스트 결과', exact: true });
  await button.click();
  await expect(result.getByRole('alert')).toContainText('실행 결과를 확인하지 못했어요.');
  await result.getByText('오류 상세', { exact: true }).click();
  await expect(result.locator('details p')).not.toBeEmpty();
  await button.click();
  await expect(result).toContainText('응답에 성공했어요.');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
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
      credentialEnv: 'PM_SYNTHETIC_KEY',
      enabled: true,
    });
  const model = await api<ModelPreset>(request, '/model-presets', {
    title,
    connectionId: connection.id,
    modelId: 'gemini-3.8-flash',
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
  await page.getByLabel('프로바이더·모델 검색').fill(title);
  await page.getByRole('button', { name: title + ' 모델 수정', exact: true }).click();
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
  let statusGate: Promise<void> | undefined;
  await page.route('**/api/agent-runtimes/codex**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'GET') await statusGate;
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
        limits: authenticated ? [{ name: '5시간', usedPercent: 25, resetsAt: 1800000000 }] : [],
      },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const observed = observe(page);
  await settings(page);
  await startProviderConnection(page);
  await page
    .getByRole('region', { name: '제공자 선택', exact: true })
    .getByRole('button', { name: /Codex/ })
    .click();
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' });
  await form.getByLabel('프로바이더 이름', { exact: true }).fill('보존할 Codex 초안');
  await expect(form.getByLabel('Codex 실행 위치')).toHaveValue('codex://local');
  await expect(form.getByLabel('Codex 실행 위치')).toHaveAttribute('readonly', '');
  await expect(form.getByLabel('서버 환경변수 이름')).toBeHidden();
  await selectSettingsSection(page, '에이전트');
  const panel = page.getByRole('region', { name: 'Codex 에이전트 연결' });
  await expect(panel).toContainText('로그인 필요');
  const help = panel.locator('details');
  await expect(help).not.toHaveAttribute('open', '');
  const executionHelp = help.getByText('Codex는 Uimori 서버에서 실행해요.', { exact: false });
  await expect(executionHelp).toBeHidden();
  await help.locator('summary').click();
  await expect(executionHelp).toBeVisible();
  await help.locator('summary').click();
  const refresh = panel.getByRole('button', { name: 'Codex 상태 다시 확인' });
  await expect(refresh).toHaveText('');
  let releaseStatus!: () => void;
  statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  releaseStatus();
  statusGate = undefined;
  await expect(refresh).toBeEnabled();
  await expect(refresh).toHaveAttribute('aria-busy', 'false');
  expect(mutations).toEqual([]);
  await panel.getByRole('button', { name: 'ChatGPT로 로그인', exact: true }).click();
  await expect(panel.getByRole('link', { name: '로그인 페이지 열기' })).toHaveAttribute(
    'href',
    'https://auth.openai.com/codex/device'
  );
  await expect(panel).toContainText('ABCD-1234');
  await panel.getByRole('button', { name: '로그인 취소', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Codex 로그인 코드' })).toBeHidden();
  await panel.getByRole('button', { name: 'ChatGPT로 로그인', exact: true }).click();
  authenticated = true;
  pending = false;
  await panel.getByRole('button', { name: 'Codex 상태 다시 확인' }).click();
  await expect(panel).toContainText('연결됨');
  await expect(panel).toContainText('사용 25%');
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
  expect(savedConnection.credentialEnv).toBeUndefined();
  expect(savedConnection).not.toHaveProperty('requestTier');
  await modelForm.getByLabel('모델 프리셋 이름', { exact: true }).fill('PMUI10 Codex 모델');
  await modelForm.getByLabel('모델 ID', { exact: true }).fill('synthetic-codex-model');
  await modelForm.getByLabel('출력 목표 토큰', { exact: true }).fill('2048');
  await expect(modelForm.getByLabel('Temperature', { exact: true })).toBeHidden();
  await modelForm.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
  await expect(page.getByRole('region', { name: '등록한 모델 사용 방법' })).toContainText(
    'PMUI10 Codex 모델'
  );
  const savedModel = (await library(request)).models.find(
    (item) => item.title === 'PMUI10 Codex 모델'
  )!;
  expect(savedModel).toMatchObject({
    connectionId: savedConnection.id,
    modelId: 'synthetic-codex-model',
    maxOutputTokens: 2048,
    temperature: null,
  });
  await selectSettingsSection(page, '에이전트');
  await panel.getByRole('button', { name: '연결 해제', exact: true }).click();
  await expect(panel).toContainText('로그인 필요');
  available = false;
  await panel.getByRole('button', { name: 'Codex 상태 다시 확인' }).click();
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

test('PMUI16 endpoint guidance checks server policy before saving and ignores a stale draft response', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settings(page);
  await startProviderConnection(page);
  await page
    .getByRole('region', { name: '제공자 선택', exact: true })
    .getByRole('button', { name: /OpenAI · Responses/ })
    .click();
  const form = page.getByRole('form', { name: '프로바이더 편집 양식' }),
    address = form.getByLabel('API 기본 주소'),
    status = form.getByRole('status', { name: '프로바이더 주소 확인' });
  await expect(status).toContainText('별도 주소 허용 설정 없이');
  const before = await library(request);
  await address.fill('https://custom.example/v1');
  await expect(status).toContainText('서버에서 한 번 허용');
  await expect(status).toContainText('https://custom.example');
  await expect(status).toContainText('매번 입력하지 않아도');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await status.scrollIntoViewIfNeeded();
    const box = await status.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    if (visualReview)
      await status.screenshot({ path: info.outputPath(`endpoint-guidance-${width}.png`) });
  }
  let release!: () => void, seen!: () => void;
  const pending = new Promise<void>((resolve) => {
    seen = resolve;
  });
  await page.route('**/api/provider-management/endpoint-status', async (route) => {
    if (route.request().postDataJSON().endpoint !== 'https://delayed.example/v1') {
      await route.continue();
      return;
    }
    seen();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { status: 'needs-approval', origin: 'https://delayed.example' } });
  });
  await address.fill('https://delayed.example/v1');
  await pending;
  await address.fill('https://api.openai.com/v1');
  await expect(status).toContainText('공식 공급자 주소');
  release();
  await expect(status).not.toContainText('delayed.example');
  await form.getByLabel('프로바이더 프로토콜').selectOption('vertex-gemini-v1');
  await form.getByLabel('Google Cloud 프로젝트 ID').fill('synthetic-project');
  await expect(status).toContainText('공식 공급자 주소');
  const after = await library(request);
  expect(after.connections).toEqual(before.connections);
  expect(after.models).toEqual(before.models);
});

test('PMUI17 new Google, Vercel and DeepSeek models are selectable locally and save reviewed options on mobile', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const prefix = 'PMUI17 ' + Date.now(),
    observed = observe(page),
    outboundActions: string[] = [];
  page.on('request', (request) => {
    if (/\/(?:catalog|test)$/.test(new URL(request.url()).pathname))
      outboundActions.push(request.url());
  });
  await settings(page);
  await startProviderConnection(page);
  await page
    .getByRole('region', { name: '제공자 선택', exact: true })
    .getByRole('button', { name: /DeepSeek/ })
    .click();
  const connectionForm = page.getByRole('form', { name: '프로바이더 편집 양식' });
  await expect(connectionForm.getByLabel('프로바이더 프로토콜')).toHaveValue('deepseek-chat-v1');
  await expect(connectionForm.getByLabel('API 기본 주소')).toHaveValue(
    'https://api.deepseek.com/v1'
  );
  await expect(connectionForm.getByLabel('서버 환경변수 이름')).toHaveValue('DEEPSEEK_API_KEY');
  await expect(connectionForm.getByRole('status', { name: '프로바이더 주소 확인' })).toContainText(
    '공식 공급자 주소'
  );
  await connectionForm.getByLabel('프로바이더 이름', { exact: true }).fill(prefix + ' DeepSeek');
  await connectionForm.getByLabel('이 프로바이더 사용').uncheck();
  await connectionForm.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  await expect
    .poll(async () =>
      (await library(request)).connections.find((item) => item.title === prefix + ' DeepSeek')
    )
    .toMatchObject({
      protocol: 'deepseek-chat-v1',
      endpoint: 'https://api.deepseek.com/v1',
      credentialEnv: 'DEEPSEEK_API_KEY',
      enabled: false,
    });
  const cases = [
    {
      protocol: 'vertex-gemini-v1',
      endpoint:
        'https://aiplatform.googleapis.com/v1/projects/synthetic-new-models/locations/global/publishers/google/models',
      modelId: 'gemini-3.5-flash-lite',
      options: { '사고 강도': ['MINIMAL', 'MEDIUM', 'HIGH'] },
      choices: { '사고 강도': 'MINIMAL' },
      saved: { thinkingLevel: 'MINIMAL', temperature: null },
    },
    {
      protocol: 'vercel-chat-v1',
      endpoint: 'https://ai-gateway.vercel.sh/v1',
      modelId: 'spacexai/grok-4.6',
      options: { '사고 강도': ['low', 'medium', 'high', 'xhigh'] },
      choices: { '사고 강도': 'xhigh' },
      saved: { reasoningEffort: 'xhigh' },
    },
    {
      protocol: 'vercel-chat-v1',
      endpoint: 'https://ai-gateway.vercel.sh/v1',
      modelId: 'openai/gpt-5.6-sol',
      options: { '사고 강도': ['none', 'low', 'medium', 'high', 'xhigh'] },
      choices: { '사고 강도': 'xhigh' },
      saved: { reasoningEffort: 'xhigh' },
    },
    ...['deepseek-v4-pro', 'deepseek-v4-flash'].map((modelId) => ({
      protocol: 'deepseek-chat-v1',
      endpoint: 'https://api.deepseek.com/v1',
      modelId,
      options: { '사고 강도': ['none', 'low', 'high', 'max'] },
      choices: { '사고 강도': modelId === 'deepseek-v4-pro' ? 'max' : 'none' },
      saved: { reasoningEffort: modelId === 'deepseek-v4-pro' ? 'max' : 'none' },
    })),
  ];
  for (const [index, item] of cases.entries()) {
    const title = prefix + ' ' + item.modelId,
      connection = await api<Connection>(request, '/connections', {
        title,
        protocol: item.protocol,
        endpoint: item.endpoint,
        credentialEnv: 'PM_SYNTHETIC_KEY',
        enabled: false,
      });
    await settings(page);
    await page.getByRole('button', { name: '새 모델 입력', exact: true }).click();
    const form = page.getByRole('form', { name: '모델 편집 양식' });
    await form.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
    await form.getByLabel('모델 목록 검색').fill(item.modelId);
    const picker = form.getByRole('region', { name: '저장된 모델 목록에서 선택' });
    await expect(picker).toContainText('모델 목록에서 선택');
    await expect(picker.getByRole('button')).toHaveCount(1);
    await picker.getByRole('button').click();
    await expect(form.getByLabel('모델 ID', { exact: true })).toHaveValue(item.modelId);
    await form.getByLabel('모델 프리셋 이름').fill(title);
    // Documented values lead; the rest of the protocol vocabulary stays selectable as unverified.
    for (const [label, values] of Object.entries(item.options)) {
      const optionValues = await form
        .getByLabel(label, { exact: true })
        .locator('optgroup[label="문서로 확인한 값"] option')
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value).filter(Boolean)
        );
      expect(optionValues).toEqual(values);
    }
    for (const [label, value] of Object.entries(item.choices))
      await form.getByLabel(label, { exact: true }).selectOption(value!);
    await expect(form.getByTestId('model-hint-source')).toHaveCount(0);
    if (item.protocol === 'deepseek-chat-v1')
      await expect(form.getByLabel('사고 모드', { exact: true })).toHaveCount(0);
    expect(
      await page
        .getByRole('dialog', { name: '설정', exact: true })
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
    ).toBe(true);
    if (visualReview)
      await form.screenshot({ path: info.outputPath(`provider-new-models-${index}-mobile.png`) });
    await form.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
    await expect
      .poll(async () => (await library(request)).models.find((model) => model.title === title))
      .toMatchObject({ connectionId: connection.id, modelId: item.modelId, ...item.saved });
  }
  expect(outboundActions).toEqual([]);
  expect(observed.errors).toEqual([]);
  expect(observed.generations).toEqual([]);
  expect(observed.legacyReads).toEqual([]);
});

preservePromptWorkspace();
