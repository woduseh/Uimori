import packageJson from '../package.json' with { type: 'json' };
import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { reviewWidths, visualReview } from './fixtures/visual-review.js';
import { test, expect } from '@playwright/test';
import { fixtureBotInput, postFixtureChat } from './fixtures/chat.js';
import {
  navigationAction,
  openChatSettings,
  selectChatSettingsSection,
  selectSettingsSection,
  startProviderConnection,
} from './ui-navigation.js';

test('SCUI04 recovery settings expose real build information and grouped data at desktop and phone sizes', async ({
  page,
  request,
}, info) => {
  const health = await (await request.get('/api/health')).json();
  expect(health.version).toBe(packageJson.version);
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
    for (const section of [
      '일반',
      '테마·색상',
      '로어 문맥',
      '데이터 관리',
      'Codex 연결',
      '앱 정보·라이선스',
    ]) {
      await selectSettingsSection(page, section);
      const pane = dialog.getByRole('tabpanel');
      if (section === '일반') {
        await expect(pane.getByLabel('앱 화면 테마')).toBeVisible();
      } else if (section === '테마·색상') {
        const controls = pane.locator('.theme-control-bar select');
        await expect(controls).toHaveCount(3);
        const sizes = await controls.evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return { width: box.width, height: box.height };
          })
        );
        for (const size of sizes) {
          expect(Math.abs(size.width - sizes[0].width)).toBeLessThan(2);
          expect(Math.abs(size.height - sizes[0].height)).toBeLessThan(2);
        }
        await expect(
          pane.getByRole('button', { name: '새 커스텀 테마', exact: true })
        ).toBeVisible();
      } else if (section === '로어 문맥') {
        await expect(pane.getByRole('heading', { name: '로어 사용', exact: true })).toBeVisible();
        await expect(pane.locator('fieldset.control-grid')).toBeVisible();
      } else if (section === '데이터 관리') {
        await expect(pane.getByRole('heading', { name: '백업 · 복원', exact: true })).toBeVisible();
        await expect(
          pane.getByRole('button', { name: 'DB 스냅샷 다운로드', exact: true })
        ).toBeVisible();
        const restore = pane
          .locator('details')
          .filter({ has: page.locator('summary', { hasText: '전체 복원 방법' }) });
        await expect(
          pane.getByRole('heading', { name: '자료 가져오기', exact: true })
        ).toBeVisible();
        await expect(
          pane.getByRole('heading', { name: '채팅 가져오기', exact: true })
        ).toBeVisible();
        await expect(restore).not.toHaveAttribute('open', '');
        await restore.locator('summary').click();
        await expect(restore).toContainText('서버를 종료하고');
        await restore.locator('summary').click();
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
        await expect(pane.getByTestId('app-version')).toHaveText(`v${packageJson.version}`);
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

test('SCUIVERSION app version lookup reports a failure and recovers on retry', async ({ page }) => {
  await page.goto('/');
  await navigationAction(page, '설정');
  let failed = false;
  await page.route('**/api/health', (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({ status: 503, json: { error: 'Synthetic health failure' } });
  });
  await selectSettingsSection(page, '앱 정보·라이선스');
  const about = page.getByRole('region', { name: 'Uimori 앱 정보', exact: true });
  await expect(about.getByTestId('app-version')).toHaveText('확인 실패');
  await expect(about.getByTestId('app-build-id')).toHaveText('확인 실패');
  await about.getByRole('button', { name: '다시 확인', exact: true }).click();
  await expect(about.getByTestId('app-version')).toHaveText(`v${packageJson.version}`);
  await expect(about.getByTestId('app-build-id')).toHaveText(/^[a-f0-9]{64}$/);
  await expect(about.getByRole('alert')).toBeHidden();
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

test('SCUI01 settings list and details adapt at six widths with no overflow', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await page.goto('/');
  await navigationAction(page, '설정');
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  const nav = dialog.locator('.settings-navigation');
  await expect(nav.getByRole('button', { name: '삽화', exact: true })).toBeVisible();
  const categoryCount = await nav.getByRole('button').count();
  await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
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
      await expect(nav.getByRole('tab')).toHaveCount(categoryCount);
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

test('SCUI05 global lore defaults are saved and copied only to new chats', async ({
  page,
  request,
}) => {
  const original = await (await request.get('/api/lore-context-defaults')).json();
  const created = await request.post('/api/content', {
    data: fixtureBotInput('로어 기본값 합성 봇'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const firstResponse = await request.post('/api/chats', {
    data: { botId: bot.id, title: '기본값 변경 전 채팅' },
  });
  expect(firstResponse.ok()).toBe(true);
  const first = await firstResponse.json();
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '로어 문맥');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  const section = settings.getByRole('region', { name: '로어 문맥 기본값', exact: true });
  await section.getByText('선별 기준과 용량', { exact: true }).click();
  const retained = section.getByLabel('조회 로어 토큰 한도', { exact: true });
  await expect(retained).toBeVisible();
  await expect(retained).toHaveValue(String(original.maxRetainedTokens));
  const nextLimit = original.maxRetainedTokens === 24_000 ? 20_000 : 24_000;
  await retained.fill(String(nextLimit));
  await section.getByRole('button', { name: '로어 문맥 기본값 저장', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('이후 만드는 새 채팅부터 사용해요');
  const secondResponse = await request.post('/api/chats', {
    data: { botId: bot.id, title: '기본값 변경 후 채팅' },
  });
  expect(secondResponse.ok()).toBe(true);
  const second = await secondResponse.json();
  const firstDetail = await (await request.get(`/api/chats/${first.id}`)).json();
  const secondDetail = await (await request.get(`/api/chats/${second.id}`)).json();
  expect(firstDetail.profile.loreContext.maxRetainedTokens).toBe(original.maxRetainedTokens);
  expect(secondDetail.profile.loreContext.maxRetainedTokens).toBe(nextLimit);
  const saved = await (await request.get('/api/lore-context-defaults')).json();
  const { revision: _revision, ...policy } = original;
  const restored = await request.put('/api/lore-context-defaults', {
    data: { expectedRevision: saved.revision, ...policy },
  });
  expect(restored.ok()).toBe(true);
});

test('SCUI06 global lore defaults require a successful read and preserve chat drafts on retry', async ({
  page,
  request,
}) => {
  const original = await (await request.get('/api/lore-context-defaults')).json();
  const { revision: _revision, ...policy } = original;
  const chat = await (
    await postFixtureChat(request, { data: { title: '로어 기본값 조회 복구' } })
  ).json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route('**/api/lore-context-defaults', async (route) => {
    if (route.request().method() !== 'GET' || ++reads > 1) return route.continue();
    await gate;
    await route.fulfill({ status: 503, json: { error: 'SCUI06 synthetic read failure' } });
  });
  try {
    const updated = await request.put('/api/lore-context-defaults', {
      data: { ...policy, expectedRevision: original.revision, maxRetainedTokens: 32_000 },
    });
    expect(updated.ok()).toBe(true);
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await expect(
      page.locator('.workspace-header').getByText(chat.title, { exact: true })
    ).toBeVisible();
    await openChatSettings(page);
    await selectChatSettingsSection(page, '기억·로어');
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    await dialog.getByText('선별 기준과 용량', { exact: true }).click();
    const retained = dialog.getByLabel('조회 로어 토큰 한도', { exact: true });
    const reset = dialog.getByRole('button', { name: '전역 기본값 적용', exact: true });
    await expect.poll(() => reads).toBe(1);
    await expect(reset).toBeDisabled();
    await retained.fill('12000');
    release();
    await expect(dialog.getByRole('alert')).toContainText('전역 로어 기본값을 불러오지 못했어요');
    await expect(reset).toBeDisabled();
    await expect(retained).toHaveValue('12000');
    await dialog.getByRole('button', { name: '전역 기본값 다시 불러오기', exact: true }).click();
    await expect(reset).toBeEnabled();
    await expect(retained).toHaveValue('12000');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await reset.click();
    await expect(retained).toHaveValue('32000');
    await dialog.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
    await expect
      .poll(async () => {
        const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
        return detail.profile.loreContext.maxRetainedTokens;
      })
      .toBe(32_000);
  } finally {
    release();
    const current = await (await request.get('/api/lore-context-defaults')).json();
    const restored = await request.put('/api/lore-context-defaults', {
      data: { ...policy, expectedRevision: current.revision },
    });
    expect(restored.ok()).toBe(true);
  }
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

test('SCUILEAVE global illustration settings retain failed drafts and save before closing', async ({
  page,
  request,
}) => {
  for (const width of [2560, 412]) {
    const original = await (await request.get('/api/illustration-settings')).json();
    const nextCount = original.maxPerSource === 8 ? 7 : original.maxPerSource + 1;
    await page.setViewportSize({ width, height: 915 });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '삽화');
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    const count = settings.getByLabel('장면당 최대 삽화 개수', { exact: true });
    await count.fill('0');
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
    await confirm.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
    await expect(confirm.getByRole('alert')).toBeVisible();
    expect((await (await request.get('/api/illustration-settings')).json()).revision).toBe(
      original.revision
    );
    await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(count).toHaveValue('0');
    await count.fill(String(nextCount));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted = false;
    await page.route('**/api/illustration-settings', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      intercepted = true;
      await held;
      await route.fulfill({ status: 503, json: { error: 'SCUILEAVE synthetic write failure' } });
    });
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await confirm.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
    await expect.poll(() => intercepted).toBe(true);
    await page.keyboard.press('Escape');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: '계속 편집', exact: true })).toBeDisabled();
    release();
    await expect(confirm.getByRole('alert')).toBeVisible();
    await page.unroute('**/api/illustration-settings');
    await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(count).toHaveValue(String(nextCount));
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await confirm.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
    await expect(settings).toBeHidden();
    const saved = await (await request.get('/api/illustration-settings')).json();
    expect(saved.maxPerSource).toBe(nextCount);
    expect(saved.revision).toBe(original.revision + 1);
    const { revision: _revision, ...body } = original;
    const restored = await request.put('/api/illustration-settings', {
      data: { ...body, expectedRevision: saved.revision },
    });
    expect(restored.ok()).toBe(true);
  }
});
