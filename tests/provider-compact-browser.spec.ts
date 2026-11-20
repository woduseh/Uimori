import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { expect, test, type Page } from '@playwright/test';
import type { Connection, Library, ModelPreset } from '../core/product.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

const connection: Connection = {
  id: 'compact-synthetic-connection',
  revision: 1,
  title: '합성 개인 연결',
  protocol: 'openai-responses-v1',
  endpoint: 'http://127.0.0.1:9/v1',
  enabled: true,
  catalog: [],
  catalogError: null,
};

async function projectLibrary(
  page: Page,
  value: { connections: Connection[]; models: ModelPreset[] }
) {
  await page.route(/\/api\/library(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const library = (await response.json()) as Library;
    await route.fulfill({ response, json: { ...library, ...value } });
  });
  const calls: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(?:catalog|test|runs|translation|retranslate)$/.test(new URL(request.url()).pathname)
    )
      calls.push(request.url());
  });
  return { calls, errors };
}

async function openProviders(page: Page) {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '프로바이더와 모델');
  await expect(page.getByTestId('connection-editor')).toBeVisible();
}

test('PCUI01 empty connections and empty models each expose one relevant starting action', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const value: { connections: Connection[]; models: ModelPreset[] } = {
    connections: [],
    models: [],
  };
  const observed = await projectLibrary(page, value);
  let registrationReads = 0;
  await page.route('**/api/provider-management/jev', async (route) => {
    registrationReads++;
    if (registrationReads === 1)
      await route.fulfill({ status: 503, json: { error: 'Synthetic registration read failed' } });
    else await route.continue();
  });
  await openProviders(page);
  const editor = page.getByTestId('connection-editor');
  const registrationFailure = editor
    .getByRole('alert')
    .filter({ hasText: 'TypeSafe AI 등록 상태' });
  await expect(registrationFailure).toBeVisible();
  await registrationFailure
    .getByRole('button', { name: 'TypeSafe AI 등록 상태 다시 불러오기', exact: true })
    .click();
  await expect(registrationFailure).toBeHidden();
  expect(registrationReads).toBe(2);
  await expect(editor.getByRole('searchbox', { name: '프로바이더와 모델 검색' })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '프로바이더 추가', exact: true })).toHaveCount(1);
  await expect(editor.getByRole('button', { name: '새 모델 입력', exact: true })).toHaveCount(0);
  const start = await editor
    .getByRole('button', { name: '프로바이더 추가', exact: true })
    .boundingBox();
  expect(start!.y + start!.height).toBeLessThan(844);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('provider-compact-empty-mobile.png') });
  await editor.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await expect(editor.getByRole('button', { name: '프로바이더 추가', exact: true })).toHaveCount(1);
  await editor.getByRole('button', { name: '프로바이더 추가', exact: true }).click();
  await expect(editor.getByRole('region', { name: '프로바이더 선택', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '목록으로', exact: true }).click();
  value.connections = [connection];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    editor.getByRole('article', { name: connection.title + ' 프로바이더', exact: true })
  ).toBeVisible();
  await editor.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  await expect(editor.getByRole('button', { name: '새 모델 입력', exact: true })).toHaveCount(1);
  await expect(editor.getByRole('button', { name: '프로바이더 추가', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('searchbox', { name: '프로바이더와 모델 검색' })).toHaveCount(0);
  await editor.getByRole('button', { name: '새 모델 입력', exact: true }).click();
  await expect(
    editor.getByRole('form', { name: '모델 편집 양식' }).getByLabel('프로바이더', { exact: true })
  ).toHaveValue(connection.id);
  expect(observed.calls).toEqual([]);
  expect(observed.errors).toEqual([]);
});
