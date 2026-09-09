import { reviewWidths, visualReview } from './fixtures/visual-review.js';
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
const model: ModelPreset = {
  id: 'compact-synthetic-model',
  revision: 1,
  title: '합성 글쓰기 모델',
  connectionId: connection.id,
  modelId: 'synthetic/model',
  maxOutputTokens: 4096,
  temperature: null,
  enabled: true,
};

// Only the library read is projected. No saved settings or external provider requests are needed.
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
  await page.setViewportSize({ width: 390, height: 844 });
  const value: { connections: Connection[]; models: ModelPreset[] } = {
    connections: [],
    models: [],
  };
  const observed = await projectLibrary(page, value);
  await openProviders(page);
  const editor = page.getByTestId('connection-editor');
  await expect(editor.getByRole('searchbox', { name: '프로바이더·모델 검색' })).toHaveCount(0);
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
  await expect(editor.getByRole('region', { name: '제공자 선택', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '목록으로', exact: true }).click();
  value.connections = [connection];
  await editor.getByRole('button', { name: '목록 새로고침', exact: true }).click();
  await editor.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  await expect(editor.getByRole('button', { name: '새 모델 입력', exact: true })).toHaveCount(1);
  await expect(editor.getByRole('button', { name: '프로바이더 추가', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('searchbox', { name: '프로바이더·모델 검색' })).toHaveCount(0);
  await editor.getByRole('button', { name: '새 모델 입력', exact: true }).click();
  await expect(
    editor.getByRole('form', { name: '모델 편집 양식' }).getByLabel('프로바이더', { exact: true })
  ).toHaveValue(connection.id);
  expect(observed.calls).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('PCUI02 compact provider lists align at six widths and retain accessible menus and search recovery', async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const observed = await projectLibrary(page, {
    connections: [{ ...connection, protocol: 'anthropic-messages-v1' }],
    models: [model],
  });
  await openProviders(page);
  const editor = page.getByTestId('connection-editor');
  const search = editor.getByRole('searchbox', { name: '프로바이더·모델 검색' });
  const item = editor.getByRole('article', { name: model.title + ' 모델', exact: true });
  for (const width of reviewWidths([360, 390, 430, 768, 1024, 1440])) {
    await page.setViewportSize({ width, height: 900 });
    await expect(item).toBeVisible();
    const geometry = await editor.evaluate((node) => {
      const rect = (selector: string) => node.querySelector(selector)!.getBoundingClientRect();
      const input = rect('.provider-toolbar input');
      const icon = rect('.provider-toolbar .provider-search > svg');
      const tab = rect('.provider-workspace-navigation > button');
      const refresh = rect('.provider-refresh');
      return {
        input: { left: input.left, right: input.right },
        iconOffset: Math.abs(icon.top + icon.height / 2 - input.top - input.height / 2),
        tabOffset: Math.abs(tab.top + tab.height / 2 - refresh.top - refresh.height / 2),
        refreshWidth: refresh.width,
        refreshHeight: refresh.height,
        overflow: node.scrollWidth - node.clientWidth,
      };
    });
    expect(geometry.input.left).toBeGreaterThanOrEqual(0);
    expect(geometry.input.right).toBeLessThanOrEqual(width);
    if (visualReview) expect(geometry.iconOffset).toBeLessThanOrEqual(1);
    if (visualReview) expect(geometry.tabOffset).toBeLessThanOrEqual(1);
    expect(geometry.refreshWidth).toBeGreaterThanOrEqual(44);
    expect(geometry.refreshHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    if (width === 390 || width === 1440)
      if (visualReview)
        await page.screenshot({
          path: info.outputPath(`provider-compact-${width === 390 ? 'mobile' : 'desktop'}.png`),
        });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = item.getByLabel(model.title + ' 모델 메뉴', { exact: true });
  const copy = item.getByRole('button', { name: model.title + ' 모델 복제', exact: true });
  await expect(copy).not.toBeVisible();
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(copy).toBeVisible();
  await expect(item.locator('.action-menu-body > .delete-control > button > svg')).toHaveCount(1);
  await copy.focus();
  await page.keyboard.press('Escape');
  await expect(copy).not.toBeVisible();
  await expect(menu).toBeFocused();
  await expect(page.getByRole('dialog', { name: '설정', exact: true })).toBeVisible();
  await menu.click();
  await search.click();
  await expect(copy).not.toBeVisible();
  await search.fill('찾을 수 없는 합성 검색어');
  await expect(editor.getByText('검색 조건에 맞는 모델이 없어요.', { exact: true })).toBeVisible();
  await expect(search).toHaveValue('찾을 수 없는 합성 검색어');
  await editor.getByRole('button', { name: '검색 지우기', exact: true }).click();
  await expect(item).toBeVisible();
  await expect(item.getByText('진단과 상세', { exact: true })).toHaveCount(0);
  await expect(item).not.toContainText(model.modelId);
  await expect(item).not.toContainText('4096');
  await expect(item).not.toContainText('옵션 앱 확인');
  await expect(
    item.getByRole('button', { name: model.title + ' 응답 테스트', exact: true })
  ).toBeVisible();
  await editor.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await search.fill('찾을 수 없는 합성 검색어');
  await expect(
    editor.getByText('검색 조건에 맞는 프로바이더가 없어요.', { exact: true })
  ).toBeVisible();
  await editor.getByRole('button', { name: '검색 지우기', exact: true }).click();
  await expect(
    editor.getByRole('article', { name: connection.title + ' 프로바이더', exact: true })
  ).toBeVisible();
  const provider = editor.getByRole('article', {
    name: connection.title + ' 프로바이더',
    exact: true,
  });
  await provider.getByLabel(connection.title + ' 프로바이더 메뉴', { exact: true }).click();
  await expect(provider.locator('.action-menu-body > .delete-control > button > svg')).toHaveCount(
    1
  );
  await editor.getByRole('button', { name: '모델 프리셋', exact: true }).click();
  await item.getByRole('button', { name: model.title + ' 모델 수정', exact: true }).click();
  const form = editor.getByRole('form', { name: '모델 편집 양식' });
  await form.getByRole('button', { name: '고급', exact: true }).click();
  const stops = form.locator('.provider-stop-sequences');
  await expect(stops).toHaveJSProperty('open', false);
  await stops.locator('summary').click();
  const add = stops.getByRole('button', { name: '추가', exact: true });
  await add.click();
  await stops.locator('summary').click();
  await form.getByRole('button', { name: '모델 변경 저장', exact: true }).click();
  await expect(stops).toHaveJSProperty('open', true);
  await expect(form.getByLabel('생성 중단 문자열 1', { exact: true })).toBeFocused();
  await form.getByLabel('생성 중단 문자열 1', { exact: true }).fill('END');
  await form.getByRole('button', { name: '기본', exact: true }).click();
  await form.getByRole('button', { name: '고급', exact: true }).click();
  await expect(stops).toHaveJSProperty('open', true);
  await expect(form.getByLabel('생성 중단 문자열 1', { exact: true })).toHaveValue('END');
  if (visualReview) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const button = await add.boundingBox(),
        section = await stops.boundingBox();
      expect(button!.width).toBeLessThan(section!.width / 2);
      expect(button!.height).toBeGreaterThanOrEqual(44);
      await stops.screenshot({ path: info.outputPath(`provider-stop-controls-${width}.png`) });
    }
  }
  expect(observed.calls).toEqual([]);
  expect(observed.errors).toEqual([]);
});
