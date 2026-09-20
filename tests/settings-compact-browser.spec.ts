import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { reviewWidths, visualReview } from './fixtures/visual-review.js';
import { test, expect } from '@playwright/test';
import { fixtureBotInput } from './fixtures/chat.js';
import {
  navigationAction,
  selectSettingsSection,
  startProviderConnection,
} from './ui-navigation.js';

test('SCUI04 recovery settings expose real build information and grouped data at desktop and phone sizes', async ({
  page,
  request,
}, info) => {
  const health = await (await request.get('/api/health')).json();
  await page.route('**/api/agent-runtimes/codex', (route) =>
    route.fulfill({
      json: {
        available: false,
        authenticated: false,
        authMode: null,
        limits: [],
        error: 'CODEX_DISABLED',
      },
    })
  );
  for (const viewport of [
    { width: 2560, height: 1440 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await navigationAction(page, '설정');
    const dialog = page.getByRole('dialog', { name: '설정', exact: true });
    for (const section of ['일반', '데이터 관리', 'Codex 연결', '앱 정보·라이선스']) {
      await selectSettingsSection(page, section);
      const pane = dialog.getByRole('tabpanel');
      if (section === '일반') {
        await expect(pane.getByLabel('앱 화면 테마')).toBeVisible();
      } else if (section === '데이터 관리') {
        await expect(pane.getByRole('heading', { name: '백업', exact: true })).toBeVisible();
        const restore = pane.locator('.archive-restore');
        await expect(restore).not.toHaveAttribute('open', '');
        await expect(pane.getByLabel('가져올 JSON 파일', { exact: true })).toBeHidden();
        await restore.getByText('전체 데이터 복원', { exact: true }).click();
        await expect(pane.getByLabel('가져올 JSON 파일', { exact: true })).toBeVisible();
        await restore.getByText('전체 데이터 복원', { exact: true }).click();
        await expect(
          pane
            .locator('details')
            .filter({ has: page.locator('summary', { hasText: '서버 관리' }) })
            .first()
        ).not.toHaveAttribute('open', '');
      } else if (section === 'Codex 연결') {
        await expect(pane.getByText('서버 설정 필요', { exact: true })).toBeVisible();
        await expect(
          pane.getByRole('list', { name: 'Codex 연결 단계' }).getByRole('listitem')
        ).toHaveCount(3);
        await expect(
          pane.getByRole('button', { name: 'ChatGPT로 로그인', exact: true })
        ).toHaveCount(0);
        await expect(pane.locator('.provider-actions')).toBeHidden();
      } else {
        await expect(pane.getByTestId('app-build-id')).toHaveText(health.buildId);
        await pane.getByText('라이선스 전문', { exact: true }).click();
        await expect(pane.locator('.app-about-document').first()).toContainText(
          'GNU AFFERO GENERAL PUBLIC LICENSE'
        );
        await pane.getByText('라이선스 전문', { exact: true }).click();
        await pane.getByText('저작권·제3자 고지', { exact: true }).click();
        await expect(pane.locator('.app-about-document').last()).toContainText('RisuAI');
        await pane.getByText('저작권·제3자 고지', { exact: true }).click();
      }
      expect(
        await pane.evaluate((node) => node.scrollWidth - node.clientWidth)
      ).toBeLessThanOrEqual(1);
      const bounds = (await dialog.boundingBox())!;
      expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
      if (viewport.width > 760) expect(bounds.width).toBeLessThan(1300);
      await pane.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({ path: info.outputPath(`recovery-${section}-${viewport.width}.png`) });
    }
    await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  }
});

test('SCUI03 multi-entry browser back keeps the address and chat consistent with clean and dirty settings', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const created = await request.post('/api/content', {
    data: fixtureBotInput('설정 이력 검사 합성 봇'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const chats = [];
  for (const title of ['설정 이력 첫 채팅', '설정 이력 두번째 채팅']) {
    const response = await request.post('/api/chats', { data: { botId: bot.id, title } });
    expect(response.ok()).toBe(true);
    chats.push(await response.json());
  }
  await page.goto(`/?chat=${chats[0].id}`);
  const next = page.locator('.sidebar').getByRole('button', { name: chats[1].title, exact: true });
  await next.click();
  await expect(page).toHaveURL(new RegExp(`chat=${chats[1].id}`));
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('두번째 채팅의 미전송 요청');
  await navigationAction(page, '설정');
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(dialog.locator('.settings-navigation')).toBeVisible();
  await page.evaluate(() => history.go(-2));
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`chat=${chats[0].id}`));
  await expect(page.locator('.header-title h1')).toHaveText(chats[0].title);
  await next.click();
  await expect(composer).toHaveValue('두번째 채팅의 미전송 요청');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '프로바이더·모델');
  await startProviderConnection(page);
  await page.getByRole('button', { name: /OpenAI · Responses/ }).click();
  const name = page
    .getByRole('form', { name: '프로바이더 편집 양식' })
    .getByLabel('프로바이더 이름', { exact: true });
  await name.fill('이력을 건너뛰어도 보존할 초안');
  await page.evaluate(() => history.go(-2));
  const confirm = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`chat=${chats[1].id}`));
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(name).toHaveValue('이력을 건너뛰어도 보존할 초안');
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`chat=${chats[1].id}`));
  await expect(page.locator('.header-title h1')).toHaveText(chats[1].title);
  await expect(composer).toHaveValue('두번째 채팅의 미전송 요청');
});

test('SCUI01 settings list and details adapt at six widths with distinct icons and no overflow', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await page.goto('/');
  await navigationAction(page, '설정');
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  const nav = dialog.locator('.settings-navigation');
  await expect(nav.getByRole('button')).toHaveCount(9);
  await expect(nav.getByRole('button', { name: '삽화', exact: true })).toBeVisible();
  await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
  if (visualReview) {
    const icons = await nav
      .locator('svg')
      .evaluateAll((nodes) => nodes.map((node) => node.innerHTML));
    expect(new Set(icons).size).toBe(icons.length);
  }
  if (visualReview)
    await page.screenshot({ path: info.outputPath(`settings-list-${MOBILE_WIDTH}.png`) });
  await selectSettingsSection(page, '일반');
  for (const width of reviewWidths([360, 390, 430, 768, 1024, 1440])) {
    await page.setViewportSize({ width, height: 900 });
    await expect(dialog.getByLabel('앱 화면 테마')).toBeVisible();
    await expect(dialog.getByRole('tabpanel')).toHaveCount(1);
    if (width <= 760) {
      await expect(nav).toBeHidden();
      await expect(dialog.getByRole('heading', { name: '일반', exact: true })).toHaveCount(1);
      const back = dialog.getByRole('button', { name: '설정 목록으로', exact: true });
      const bounds = await back.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    } else {
      await expect(nav).toBeVisible();
      await expect(nav.getByRole('tab')).toHaveCount(9);
    }
    expect(
      await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    if (width === MOBILE_WIDTH || width === DESKTOP_WIDTH)
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`settings-general-${width}.png`) });
  }
  await nav.getByRole('tab', { name: '일반', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(nav.getByRole('tab', { name: '앱 정보·라이선스', exact: true })).toBeFocused();
  await expect(dialog.getByRole('region', { name: 'Uimori 앱 정보' })).toBeVisible();
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  const opener = page
    .getByTestId('bot-navigation')
    .filter({ visible: true })
    .getByRole('button', { name: '설정', exact: true });
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(errors).toEqual([]);
});

test('SCUI02 settings back, resize and close preserve provider and chat drafts until explicit discard', async ({
  page,
  request,
}, info) => {
  const created = await request.post('/api/content', {
    data: fixtureBotInput('설정 초안 보존 합성 봇'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const response = await request.post('/api/chats', {
    data: { botId: bot.id, title: '설정 초안 보존 합성 채팅' },
  });
  expect(response.ok()).toBe(true);
  const chat = await response.json();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('계속 보존할 사용자 요청');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '프로바이더·모델');
  await startProviderConnection(page);
  await page.getByRole('button', { name: /OpenAI · Responses/ }).click();
  const name = page
    .getByRole('form', { name: '프로바이더 편집 양식' })
    .getByLabel('프로바이더 이름', { exact: true });
  await name.fill('아직 저장하지 않은 합성 연결');
  await page.goBack();
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(dialog.locator('.settings-navigation')).toBeVisible();
  await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
  await page.goBack();
  const confirm = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await selectSettingsSection(page, '프로바이더·모델');
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await name.focus();
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await expect(name).toBeFocused();
  await selectSettingsSection(page, '일반');
  await selectSettingsSection(page, '프로바이더·모델');
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await expect(name).toBeVisible();
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(confirm).toBeVisible();
  if (visualReview)
    await page.screenshot({ path: info.outputPath(`settings-unsaved-${MOBILE_WIDTH}.png`) });
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue('계속 보존할 사용자 요청');
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`));
  const after = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.runs).toHaveLength(0);
  expect(after.jobs).toHaveLength(0);
});
