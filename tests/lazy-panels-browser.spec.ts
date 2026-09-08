import { visualReview } from './fixtures/visual-review.js';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectChatSettingsSection } from './ui-navigation.js';

async function scriptEvidence(page: Page, info: TestInfo, name: string) {
  const scripts = await page.evaluate(() =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((entry) => new URL(entry.name).pathname.endsWith('.js'))
      .map((entry) => ({
        path: new URL(entry.name).pathname,
        decodedBytes: entry.decodedBodySize,
        transferBytes: entry.transferSize,
      }))
  );
  await info.attach(name, {
    body: JSON.stringify(
      { scripts, totalDecodedBytes: scripts.reduce((sum, entry) => sum + entry.decodedBytes, 0) },
      null,
      2
    ),
    contentType: 'application/json',
  });
  return scripts;
}

test('LAZY01 library entry defers settings and prompt authoring scripts', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.getByTestId('library-panel')).toBeVisible();
  const scripts = await scriptEvidence(page, info, 'library-entry-scripts');
  expect(
    scripts.some((entry) => /WorkspacePanels-|ChatSettingsPanel-|PromptLibrary-/.test(entry.path))
  ).toBe(false);
});

test('LAZY04 failed library keeps desktop and mobile navigation available', async ({
  page,
}, info) => {
  await page.route('**/assets/LibraryPanel-*.js', (route) => route.abort('failed'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('불러오지 못했어요');
    await expect(page.getByRole('heading', { name: '서재', exact: true })).toBeVisible();
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`library-load-failure-${width}.png`) });
    await navigationAction(page, '설정');
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(settings.locator('.settings-navigation')).toBeVisible();
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(page.getByRole('alert')).toContainText('불러오지 못했어요');
  }
  expect(errors).toEqual([]);
});

test('LAZY05 unavailable library data keeps prompt navigation usable', async ({ page }, info) => {
  await page.route(/\/api\/library(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'SYNTHETIC_LIBRARY_UNAVAILABLE' },
    })
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const failed = page.waitForResponse(/\/api\/library(?:\?.*)?$/);
    await page.goto('/');
    expect((await failed).status()).toBe(503);
    await navigationAction(page, '프롬프트');
    await expect(page.getByRole('heading', { name: '프롬프트', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('status')).toContainText(
      '프롬프트 목록을 불러오지 못했어요.'
    );
    if (width === 390)
      await expect(page.getByRole('button', { name: '탐색 메뉴', exact: true })).toBeVisible();
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`prompt-data-failure-${width}.png`) });
    await navigationAction(page, '설정');
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(settings.locator('.settings-navigation')).toBeVisible();
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(page.getByRole('heading', { name: '프롬프트', exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('LAZY02 delayed settings keep the reader and composer draft available', async ({
  page,
  request,
}, info) => {
  const response = await postFixtureChat(request, { data: { title: 'SYNTHETIC_LAZY_DELAY' } });
  expect(response.ok()).toBeTruthy();
  const chat = await response.json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/assets/WorkspacePanels-*.js', async (route) => {
    await gate;
    await route.continue();
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`/?chat=${chat.id}`);
    const draft = page.getByLabel('다음 장면 요청');
    await expect(draft).toBeVisible();
    await draft.fill('SYNTHETIC_UNSENT_LAZY_DRAFT');
    const initial = await scriptEvidence(page, info, 'chat-entry-scripts');
    expect(
      initial.some((entry) =>
        /LibraryPanel-|WorkspacePanels-|ChatSettingsPanel-|PromptLibrary-|NewStory-/.test(
          entry.path
        )
      )
    ).toBe(false);
    await navigationAction(page, '설정');
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(settings.getByRole('status')).toContainText('불러오는 중');
    if (visualReview)
      await info.attach('settings-loading', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await expect(draft).toHaveValue('SYNTHETIC_UNSENT_LAZY_DRAFT');
    release();
    await navigationAction(page, '설정');
    await expect(settings.locator('.settings-navigation').filter({ visible: true })).toBeVisible();
    await expect(
      settings
        .getByRole('tab', { name: '일반', exact: true })
        .or(
          settings
            .locator('.settings-navigation')
            .getByRole('button', { name: '일반', exact: true })
        )
        .filter({ visible: true })
    ).toBeVisible();
    const opened = await scriptEvidence(page, info, 'settings-open-scripts');
    expect(opened.some((entry) => /WorkspacePanels-/.test(entry.path))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(draft).toHaveValue('SYNTHETIC_UNSENT_LAZY_DRAFT');
    expect(errors).toEqual([]);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('LAZY03 failed settings script stays local and preserves unsent text', async ({
  page,
  request,
}, info) => {
  const response = await postFixtureChat(request, { data: { title: 'SYNTHETIC_LAZY_FAILURE' } });
  expect(response.ok()).toBeTruthy();
  const chat = await response.json();
  await page.route('**/assets/WorkspacePanels-*.js', (route) => route.abort('failed'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?chat=${chat.id}`);
  const draft = page.getByLabel('다음 장면 요청');
  await draft.fill('SYNTHETIC_PRESERVED_AFTER_CHUNK_FAILURE');
  await navigationAction(page, '설정');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(settings.getByRole('alert')).toContainText('불러오지 못했어요');
  if (visualReview)
    await info.attach('settings-load-failure', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(draft).toHaveValue('SYNTHETIC_PRESERVED_AFTER_CHUNK_FAILURE');
  await draft.fill('SYNTHETIC_STILL_EDITABLE');
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  const profile = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await selectChatSettingsSection(page, '봇·페르소나·모듈');
  await expect(profile.getByTestId('profile-editor')).toBeVisible();
  if (visualReview)
    await info.attach('profile-after-settings-failure', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  await page.keyboard.press('Escape');
  await expect(draft).toHaveValue('SYNTHETIC_STILL_EDITABLE');
  expect(errors).toEqual([]);
});
