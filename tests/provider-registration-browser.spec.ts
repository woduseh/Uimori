import { visualReview } from './fixtures/visual-review.js';
import { selectSettingsSection } from './ui-navigation.js';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Connection, Library, ModelPreset } from '../core/product.js';
import type { RegistrationView } from '../core/provider-registration.js';

async function settings(page: Page) {
  const button = page.getByRole('button', { name: '설정', exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  await button.click();
  await selectSettingsSection(page, '연결과 모델');
  await page.getByTestId('provider-registration-assistant').locator('summary').first().click();
}
async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const r = await request.post('/api' + path, { data });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
const getLibrary = async (request: APIRequestContext) =>
  (await request.get('/api/library')).json() as Promise<Library>;

test('PMUI05 agent proposal is reviewed, survives reload, and applies once before role assignment', async ({
  page,
  request,
}, info) => {
  const endpoint = process.env.NR_REGISTRATION_FIXTURE_URL;
  if (!endpoint) throw new Error('Dedicated registration loopback fixture is required');
  const title = 'PMUI05 보조 ' + Date.now();
  const connection = await post<Connection>(request, '/connections', {
    title,
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
  });
  const model = await post<ModelPreset>(request, '/model-presets', {
    title,
    connectionId: connection.id,
    modelId: 'synthetic-registration-assistant',
    maxOutputTokens: 512,
    temperature: null,
  });
  const before = await getLibrary(request);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await settings(page);
  const assistant = page.getByTestId('provider-registration-assistant');
  await assistant.getByLabel('등록을 도울 모델').selectOption(`${model.id}`);
  await assistant
    .getByLabel('등록 요청', { exact: true })
    .fill(
      '합성 로컬 연결과 synthetic-created-model 모델을 새로 등록해 줘. 최대 출력 토큰은 512야.'
    );
  await assistant.getByRole('button', { name: '설정안 제안 요청', exact: true }).click();
  const apply = assistant.getByRole('button', { name: '검토한 연결·모델 등록 적용', exact: true });
  await expect(apply).toBeVisible();
  const planned = await getLibrary(request);
  expect(planned.connections).toHaveLength(before.connections.length);
  expect(planned.models).toHaveLength(before.models.length);
  await expect(assistant).toContainText('새 연결 · 비활성 상태로 등록');
  await expect(assistant).toContainText('synthetic-created-model');
  await expect(assistant).toContainText('실행 요청 1회');
  await apply.scrollIntoViewIfNeeded();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('provider-registration-mobile-review.png') });
  const key = await page.evaluate(() =>
    sessionStorage.getItem('uimori.provider-registration.request-key')
  );
  expect(key).toBeTruthy();
  const snapshot = (await (
    await request.get(`/api/provider-management/registrations/by-key/${key}`)
  ).json()) as RegistrationView;
  expect(snapshot.status).toBe('ready');
  await page.reload();
  await settings(page);
  await expect(assistant).toContainText('synthetic-created-model');
  await expect(apply).toBeVisible();
  await apply.click();
  await expect(assistant.getByRole('status')).toContainText('설정 목록에 저장했어요');
  const after = await getLibrary(request);
  expect(after.connections).toHaveLength(before.connections.length + 1);
  expect(after.models).toHaveLength(before.models.length + 1);
  const created = after.models.find((item) => !before.models.some((old) => old.id === item.id))!,
    createdConnection = after.connections.find((item) => item.id === created.connectionId)!;
  expect(created).toMatchObject({
    modelId: 'synthetic-created-model',
    maxOutputTokens: 512,
    source: { kind: 'manual' },
  });
  expect(createdConnection.enabled).toBe(false);
  const repeated = await post<RegistrationView>(
    request,
    `/provider-management/registrations/${snapshot.id}/apply`,
    { expectedRevision: snapshot.revision, planHash: snapshot.planHash }
  );
  expect(repeated.applied?.model.id).toBe(created.id);
  expect((await getLibrary(request)).models).toHaveLength(after.models.length);
  const stats = await (await request.get(new URL('stats', endpoint).href)).json();
  expect(stats.registrationCalls).toBe(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await assistant.getByRole('region', { name: '모델 등록 제안' }).scrollIntoViewIfNeeded();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('provider-registration-applied.png') });
  expect(pageErrors).toEqual([]);
});

test('PMUI06 rejected admission releases the request key while uncertain delivery reuses it without a second call', async ({
  page,
  request,
}) => {
  const endpoint = process.env.NR_REGISTRATION_FIXTURE_URL;
  if (!endpoint) throw new Error('Dedicated registration loopback fixture is required');
  const connection = await post<Connection>(request, '/connections', {
    title: 'PMUI06 보조',
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
  });
  const model = await post<ModelPreset>(request, '/model-presets', {
    title: 'PMUI06 보조 모델',
    connectionId: connection.id,
    modelId: 'synthetic-registration-assistant',
    maxOutputTokens: 512,
    temperature: null,
  });
  const stats = async () =>
    (await (await request.get(new URL('stats', endpoint).href)).json()).registrationCalls as number;
  const before = await stats();
  await page.goto('/');
  await settings(page);
  const assistant = page.getByTestId('provider-registration-assistant');
  await assistant.getByLabel('등록을 도울 모델').selectOption(`${model.id}`);
  await assistant
    .getByLabel('등록 요청', { exact: true })
    .fill('synthetic sk-this-is-a-fake-rejected-credential-not-a-key');
  await assistant.getByRole('button', { name: '설정안 제안 요청', exact: true }).click();
  await expect(assistant.getByRole('alert')).toBeVisible();
  expect(await stats()).toBe(before);
  expect(
    await page.evaluate(() => sessionStorage.getItem('uimori.provider-registration.request-key'))
  ).toBeNull();
  await assistant.getByLabel('등록 요청', { exact: true }).fill('합성 로컬 모델을 새로 등록해 줘.');
  let lost = true;
  await page.route('**/api/provider-management/registrations', async (route) => {
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await assistant.getByRole('button', { name: '설정안 제안 요청', exact: true }).click();
  await expect(assistant.getByRole('alert')).toBeVisible();
  const key = await page.evaluate(() =>
    sessionStorage.getItem('uimori.provider-registration.request-key')
  );
  expect(key).toBeTruthy();
  await assistant.getByRole('button', { name: '동일 요청 상태 확인', exact: true }).click();
  await expect(
    assistant.getByRole('button', { name: '검토한 연결·모델 등록 적용', exact: true })
  ).toBeVisible();
  expect(await stats()).toBe(before + 1);
  expect(
    await page.evaluate(() => sessionStorage.getItem('uimori.provider-registration.request-key'))
  ).toBe(key);
});
