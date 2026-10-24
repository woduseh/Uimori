import { fixtureBotInput } from './fixtures/chat.js';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_THEME_TEMPLATE, emptyTheme, themeFile } from '../core/themes.js';
import { BUILTIN_PALETTES } from '../core/theme-palettes.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

async function expectPalette(page: Page, id: string, mode: 'light' | 'dark' = 'light') {
  const palette = BUILTIN_PALETTES.find((entry) => entry.id === id)!;
  await expect
    .poll(() =>
      page
        .locator('html')
        .evaluate((element) => getComputedStyle(element).getPropertyValue('--bg').trim())
    )
    .toBe(palette.colors[mode].bg);
}

async function setAppearance(page: Page, mode: 'light' | 'dark') {
  await selectSettingsSection(page, '일반');
  await page.getByLabel('앱 화면 테마', { exact: true }).selectOption(mode);
  await selectSettingsSection(page, '테마와 색상');
}

async function openThemes(page: Page, url = '/') {
  await page.goto(url);
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마와 색상');
  {
    const advanced = page.locator('.theme-advanced:not([open]) > summary');
    if (await advanced.isVisible()) await advanced.click();
  }
}

test('THEMES mobile primary choices precede background and preserve its unsaved edits', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 412, height: 844 });
  const before = await (await request.get('/api/themes')).json();
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마와 색상');
  await expect(page.getByLabel('기본 외관', { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel('테마 화면 모드', { exact: true })).toHaveCount(0);
  await expect(page.locator('.theme-advanced')).not.toHaveAttribute('open', '');
  const layout = page.getByRole('region', { name: '레이아웃', exact: true });
  const palette = page.getByRole('region', { name: '색상 팔레트', exact: true });
  const background = page.getByRole('region', { name: '본문 바깥 배경', exact: true });
  await expect(layout).toBeHidden();
  await expect(background).toBeHidden();
  await page.screenshot({ path: info.outputPath('theme-primary-mobile.png') });
  await page.getByText('고급 테마 설정', { exact: true }).click();
  await expect(layout).toBeVisible();
  const layoutBox = await layout.boundingBox();
  const paletteBox = await palette.boundingBox();
  const backgroundBox = await background.boundingBox();
  expect(layoutBox!.y + layoutBox!.height).toBeLessThan(paletteBox!.y);
  expect(paletteBox!.y + paletteBox!.height).toBeLessThan(backgroundBox!.y);
  await page.screenshot({ path: info.outputPath('theme-order.png') });

  const blur = background.getByLabel('배경 흐림', { exact: true });
  const original = await blur.inputValue();
  const changed = original === '7' ? '8' : '7';
  await blur.fill(changed);
  await expect(page.getByLabel('테마 적용 범위', { exact: true })).toBeDisabled();
  await expect(layout.getByRole('button', { name: '기본 테마 적용', exact: true })).toBeDisabled();
  await expect(
    palette.getByRole('button', { name: '크림 팔레트 적용', exact: true })
  ).toBeDisabled();
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  const guard = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(blur).toHaveValue(changed);
  await background.getByRole('button', { name: '배경 변경 취소', exact: true }).click();
  await expect(blur).toHaveValue(original);
  await expect(background.getByRole('button', { name: '배경 저장', exact: true })).toBeDisabled();
  expect((await (await request.get('/api/themes')).json()).preferences).toEqual(before.preferences);
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(guard).toBeHidden();
});

for (const width of [1440, 412]) {
  test(`THEMES ${width} palette, custom editor, persistence and portable import`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openThemes(page);
    await expect(page.getByRole('button', { name: '편지지 테마 적용', exact: true })).toBeVisible();
    await setAppearance(page, 'light');
    await page.getByRole('button', { name: '시네마틱 테마 적용', exact: true }).click();
    await page.getByRole('button', { name: '미드나이트 팔레트 적용', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:cinematic');
    await setAppearance(page, 'dark');
    await expect
      .poll(() =>
        page.locator('html').evaluate((e) => getComputedStyle(e).getPropertyValue('--bg').trim())
      )
      .toBe('#111113');
    await setAppearance(page, 'light');
    const name = `Theme ${width} ${randomUUID().slice(0, 8)}`;
    await page.getByRole('button', { name: '새 커스텀 테마', exact: true }).click();
    await page.getByLabel('테마 이름', { exact: true }).fill(name);
    await page.getByLabel('테마 설명', { exact: true }).fill('Synthetic portable theme');
    await page.getByLabel('light accent 색상', { exact: true }).fill('#663399');
    await page.getByText('CSS와 HTML 직접 편집', { exact: true }).click();
    await page
      .getByLabel('레이아웃 HTML', { exact: true })
      .fill(
        `<section class="theme-test-layout"><slot name='portrait'></slot>${DEFAULT_THEME_TEMPLATE}</section>`
      );
    await page
      .getByLabel('레이아웃 CSS', { exact: true })
      .fill(
        '.theme-test-layout { padding: 16px; border: 1px solid var(--line); border-radius: 16px; }'
      );
    await page.getByLabel('본문 CSS', { exact: true }).fill('p { letter-spacing: 1px; }');
    await page.getByRole('button', { name: '미리 적용', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'preview');
    await page.getByRole('button', { name: '미리보기 끝내기', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:cinematic');
    await page.getByRole('button', { name: '테마 저장', exact: true }).click();
    const apply = page.getByRole('button', { name: `${name} 테마 적용`, exact: true });
    await expect(apply).toBeVisible();
    await page.getByRole('button', { name: '레이아웃 원래 색상 팔레트 적용', exact: true }).click();
    await apply.click();
    await expect
      .poll(() =>
        page
          .locator('html')
          .evaluate((e) => getComputedStyle(e).getPropertyValue('--accent').trim())
      )
      .toBe('#663399');
    await page.reload();
    await expect
      .poll(() =>
        page
          .locator('html')
          .evaluate((e) => getComputedStyle(e).getPropertyValue('--accent').trim())
      )
      .toBe('#663399');
    await openThemes(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: `${name} 내보내기`, exact: true }).click();
    const file = await downloadPromise;
    const body = JSON.parse(await readFile((await file.path())!, 'utf8'));
    expect(body).toMatchObject({ format: 'uimori-theme', version: 1, theme: { title: name } });
    expect(body.theme).not.toHaveProperty('id');
    body.theme.title = `${name} imported`;
    await page.getByLabel('테마 파일', { exact: true }).setInputFiles({
      name: 'theme.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(body)),
    });
    await expect(page.getByLabel('테마 이름', { exact: true })).toHaveValue(`${name} imported`);
    await page.getByRole('button', { name: '테마 저장', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `${name} imported 테마 적용`, exact: true })
    ).toBeVisible();
    await page.getByRole('button', { name: '편집 취소', exact: true }).click();
    await page.getByRole('button', { name: '기본 테마 적용', exact: true }).click();
    await page.screenshot({ path: info.outputPath(`theme-settings-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
    const catalog = await (await request.get('/api/themes')).json();
    for (const theme of catalog.themes.filter((t: { title: string }) => t.title.startsWith(name))) {
      await request.delete(`/api/themes/${theme.id}`, {
        data: { expectedRevision: theme.revision },
      });
    }
  });
}

test('THEMES slot/CSS switches preserve author input and recover from invalid or hiding customizations', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openThemes(page);
  await page.getByRole('button', { name: '기본 테마 적용', exact: true }).click();
  await page.getByText('현재 테마로 예문 보기', { exact: true }).click();
  const sample = page.locator('.theme-sample');
  await sample.getByText('봇이 만든 상태창', { exact: true }).click();
  const input = sample.getByLabel('테마 예문 메모', { exact: true });
  await input.fill('keep me');
  await input.evaluate((e) => e.setAttribute('data-stable-node', 'yes'));
  await page.getByRole('button', { name: '편지지 테마 적용', exact: true }).click();
  await expect(input).toHaveValue('keep me');
  await expect(input).toHaveAttribute('data-stable-node', 'yes');
  await expect(sample.locator('slot[name="body"]')).toBeAttached();
  await sample.scrollIntoViewIfNeeded();
  await sample.screenshot({ path: info.outputPath('library-theme-preview.png') });
  const model = {
    ...emptyTheme(`Invalid ${randomUUID()}`),
    templateHtml: '<div>missing slots</div>',
  };
  const saved = await (
    await request.post('/api/resources/save', { data: { kind: 'theme', model } })
  ).json();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: `${model.title} 테마 적용`, exact: true }).click();
  await expect(page.getByText(/테마 레이아웃 대신 기본 화면/)).toBeVisible();
  await expect(input).toHaveValue('keep me');
  const hidden = await (
    await request.post('/api/resources/save', {
      data: {
        kind: 'theme',
        model: { ...emptyTheme('Hidden recovery'), appCss: '#root {display:none}' },
      },
    })
  ).json();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Hidden recovery 테마 적용', exact: true }).click();
  await expect(page.locator('#root')).toBeHidden();
  await page.keyboard.press('Control+Period');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:forest');
  await expect(input).toHaveValue('keep me');
  await openThemes(page, '/?theme-safe=1');
  await expect(page.locator('#root')).toBeVisible();
  await page.getByRole('button', { name: '기본 테마 적용', exact: true }).click();
  for (const theme of [saved.saved, hidden.saved])
    await request.delete(`/api/themes/${theme.id}`, { data: { expectedRevision: theme.revision } });
});

test('THEMES invalid import leaves selection untouched and closing dirty editor requires a decision', async ({
  page,
}) => {
  await openThemes(page);
  await page.getByRole('button', { name: '기본 테마 적용', exact: true }).click();
  const invalid = themeFile(emptyTheme('Bad layout'));
  invalid.theme.templateHtml = '<div>bad</div>';
  await page.getByLabel('테마 파일', { exact: true }).setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.getByRole('alert')).toContainText('slot name');
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:forest');
  await page.getByRole('button', { name: '새 커스텀 테마', exact: true }).click();
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '미저장 설정 확인' })).toBeVisible();
  await page.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '설정', exact: true })).toBeHidden();
});

test('THEMES imported leading style applies inside the layout without changing its content', async ({
  page,
}, info) => {
  await openThemes(page);
  const file = themeFile(emptyTheme('Leading style contract'));
  file.theme.templateHtml =
    '<style>.contract-marker { color: rgb(1, 2, 3); }</style>' +
    '<p class="contract-marker">가져온 스타일</p>' +
    DEFAULT_THEME_TEMPLATE;
  await page.getByLabel('테마 파일', { exact: true }).setInputFiles({
    name: 'leading-style.uimori-theme.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.getByLabel('테마 이름', { exact: true })).toHaveValue(file.theme.title);
  await page.getByRole('button', { name: '미리 적용', exact: true }).click();
  await page.getByText('현재 테마로 예문 보기', { exact: true }).click();
  const marker = page.locator('.theme-sample .contract-marker');
  await expect(marker).toHaveText('가져온 스타일');
  await expect(marker).toHaveCSS('color', 'rgb(1, 2, 3)');
  await page.locator('.theme-sample').screenshot({ path: info.outputPath('leading-style.png') });
});

test('THEMES rejects leading executable markup instead of silently dropping it on import', async ({
  page,
}) => {
  await openThemes(page);
  const file = themeFile(emptyTheme('Unsupported leading script'));
  file.theme.templateHtml =
    '<script>window.themeScriptExecuted = true;</script>' + DEFAULT_THEME_TEMPLATE;
  await page.getByLabel('테마 파일', { exact: true }).setInputFiles({
    name: 'leading-script.uimori-theme.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.getByRole('alert')).toContainText('지원하지 않는 HTML');
  expect(await page.evaluate(() => 'themeScriptExecuted' in window)).toBe(false);
});

test('THEMES legacy global appearance stays selected across advanced scopes', async ({
  page,
  request,
}) => {
  const botResponse = await request.post('/api/content', {
    data: fixtureBotInput(`Legacy theme scope ${randomUUID()}`),
  });
  expect(botResponse.ok()).toBe(true);
  const bot = await botResponse.json();
  const chatResponse = await request.post('/api/chats', {
    data: { title: 'Legacy theme scope', botId: bot.id },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json();
  for (const selection of [
    { scope: 'global', themeId: 'builtin:library' },
    { scope: 'bot', targetId: bot.id, themeId: 'builtin:letter' },
    { scope: 'chat', targetId: chat.id, themeId: 'builtin:scrapbook' },
  ]) {
    const catalog = await (await request.get('/api/themes')).json();
    const selected = await request.post('/api/themes/selection', {
      data: { ...selection, expectedRevision: catalog.preferences.revision },
    });
    expect(selected.ok()).toBe(true);
  }
  const before = await (await request.get('/api/themes')).json();
  await openThemes(page, `/?chat=${chat.id}`);
  const appearance = page.getByLabel('기본 외관', { exact: true });
  for (const scope of ['global', 'bot', 'chat', 'global']) {
    await page.getByLabel('테마 적용 범위', { exact: true }).selectOption(scope);
    await expect(appearance).toHaveValue('builtin:library');
    await expect(appearance.locator('option:checked')).toHaveText('서재');
  }
  expect((await (await request.get('/api/themes')).json()).preferences).toEqual(before.preferences);
});

test('THEMES bot/chat inheritance, cross-tab refresh and theme settings keyboard navigation', async ({
  page,
  request,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const botResponse = await request.post('/api/content', {
    data: fixtureBotInput(`Theme scope ${randomUUID()}`),
  });
  expect(botResponse.ok()).toBe(true);
  const bot = await botResponse.json();
  const chatResponse = await request.post('/api/chats', {
    data: { title: 'Theme scope', botId: bot.id },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json();
  await openThemes(page, `/?chat=${chat.id}`);
  const scope = page.getByLabel('테마 적용 범위', { exact: true });
  await expect(scope.locator('option[value="bot"]')).toBeAttached();
  await scope.selectOption('global');
  await setAppearance(page, 'light');
  await page.getByRole('button', { name: '기본 테마 적용', exact: true }).click();
  await page.getByRole('button', { name: '세이지 팔레트 적용', exact: true }).click();
  await scope.selectOption('bot');
  await page.getByRole('button', { name: '편지지 테마 적용', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
  await expectPalette(page, 'sage');
  await scope.selectOption('chat');
  await page.getByRole('button', { name: '스크랩북 테마 적용', exact: true }).click();
  await page.getByRole('button', { name: '로즈 팔레트 적용', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:scrapbook');
  await expectPalette(page, 'rose');
  const other = await context.newPage();
  await other.goto(`/?chat=${chat.id}`);
  await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:scrapbook');
  await page.getByRole('button', { name: '레이아웃 상위 설정 따르기', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
  await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
  await expectPalette(page, 'rose');
  await expectPalette(other, 'rose');
  await page.getByRole('button', { name: '팔레트 상위 설정 따르기', exact: true }).click();
  await expectPalette(page, 'sage');
  await expectPalette(other, 'sage');
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
  // An explicit original-colors choice stops palette inheritance only.
  await page.getByRole('button', { name: '레이아웃 원래 색상 팔레트 적용', exact: true }).click();
  await expectPalette(page, 'cream');
  await expectPalette(other, 'cream');
  await page.getByRole('button', { name: '팔레트 상위 설정 따르기', exact: true }).click();
  await expectPalette(page, 'sage');
  await scope.selectOption('bot');
  await page.getByRole('button', { name: '레이아웃 상위 설정 따르기', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:forest');
  await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:forest');
  // Saving notifies the other tab even if the saving tab's follow-up catalog read fails.
  await page.route('**/api/themes', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.getByRole('button', { name: '스크랩북 테마 적용', exact: true }).click();
  await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:scrapbook');
  await page.unroute('**/api/themes');
  const tabs = page.getByRole('tablist', { name: '설정 항목', exact: true });
  await other.close();
  await tabs.getByRole('tab', { name: '일반', exact: true }).click();
  await page.keyboard.press('ArrowDown');
  await expect(tabs.getByRole('tab', { name: '테마와 색상', exact: true })).toBeFocused();
});

for (const width of [1440, 412]) {
  test(`THEMES ${width} independent palette changes preserve layout, draft and author state`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await openThemes(page);
    await setAppearance(page, 'light');
    await page.getByRole('button', { name: '편지지 테마 적용', exact: true }).click();
    await page.getByRole('button', { name: '레이아웃 원래 색상 팔레트 적용', exact: true }).click();
    await expect(page.getByRole('heading', { name: '레이아웃', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '색상 팔레트', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: '미드나이트 테마 적용', exact: true })
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: '벚꽃 테마 적용', exact: true })).toHaveCount(0);
    await page.getByText('현재 테마로 예문 보기', { exact: true }).click();
    const sample = page.locator('.theme-sample');
    await sample.getByText('봇이 만든 상태창', { exact: true }).click();
    const memo = sample.getByLabel('테마 예문 메모', { exact: true });
    await memo.fill('palette keeps this node');
    await memo.evaluate((element) => element.setAttribute('data-stable-node', 'palette'));
    await page.getByRole('button', { name: '새 커스텀 테마', exact: true }).click();
    await page.getByLabel('테마 이름', { exact: true }).fill('Unchanged local palette draft');
    await page.getByLabel('light accent 색상', { exact: true }).fill('#663399');
    for (const palette of BUILTIN_PALETTES) {
      const choice = page.getByRole('button', {
        name: `${palette.title} 팔레트 적용`,
        exact: true,
      });
      await expect(choice).toHaveAccessibleDescription(palette.description);
      await choice.click();
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      await expectPalette(page, palette.id);
      await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
      await expect(memo).toHaveValue('palette keeps this node');
      await expect(memo).toHaveAttribute('data-stable-node', 'palette');
      await expect(page.getByLabel('테마 이름', { exact: true })).toHaveValue(
        'Unchanged local palette draft'
      );
      await expect(page.getByLabel('light accent 색상', { exact: true })).toHaveValue('#663399');
      expect(await page.evaluate(() => localStorage.getItem('uimori:theme'))).toBe('light');
    }
    await page.getByRole('button', { name: '차콜 팔레트 적용', exact: true }).click();
    await page.getByRole('button', { name: '시네마틱 테마 적용', exact: true }).click();
    await expectPalette(page, 'charcoal');
    await expect(memo).toHaveValue('palette keeps this node');
    await expect(memo).toHaveAttribute('data-stable-node', 'palette');
    await setAppearance(page, 'dark');
    await expectPalette(page, 'charcoal', 'dark');
    await page.getByRole('button', { name: '편집 취소', exact: true }).click();
    const beforeReload = await (await request.get('/api/themes')).json();
    expect(beforeReload.preferences).toMatchObject({
      defaultThemeId: 'builtin:cinematic',
      defaultPaletteId: 'charcoal',
    });
    await openThemes(page);
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:cinematic');
    await expect(
      page.getByRole('button', { name: '차콜 팔레트 적용', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await expectPalette(page, 'charcoal', 'dark');
    await page.getByRole('button', { name: '팔레트 기본값으로', exact: true }).click();
    await expectPalette(page, 'midnight', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:cinematic');
    expect(await page.evaluate(() => localStorage.getItem('uimori:theme'))).toBe('dark');
    await setAppearance(page, 'light');
    await page.getByRole('button', { name: '기본 테마 적용', exact: true }).click();
    await page.screenshot({
      path: info.outputPath(`independent-palettes-${width}.png`),
      fullPage: true,
    });
    await page.getByRole('region', { name: '색상 팔레트', exact: true }).screenshot({
      path: info.outputPath(`palette-choices-${width}.png`),
    });
  });
}

test('THEMES palette selections lock duplicate actions and refresh conflicts without discarding drafts', async ({
  page,
  request,
}) => {
  await openThemes(page);
  await page.getByRole('button', { name: '기본 테마 적용', exact: true }).click();
  await page.getByRole('button', { name: '새 커스텀 테마', exact: true }).click();
  await page.getByLabel('테마 이름', { exact: true }).fill('Keep conflicted draft');
  let selections = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/themes/selection', async (route) => {
    selections += 1;
    await pending;
    await route.continue();
  });
  const cream = page.getByRole('button', { name: '크림 팔레트 적용', exact: true });
  await cream.click();
  await expect(cream).toBeDisabled();
  await expect(page.getByRole('button', { name: '기본 테마 적용', exact: true })).toBeDisabled();
  await cream.evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  release();
  await expect(cream).toBeEnabled();
  expect(selections).toBe(1);
  await page.unroute('**/api/themes/selection');
  const current = await (await request.get('/api/themes')).json();
  const changed = await request.post('/api/themes/selection', {
    data: {
      dimension: 'palette',
      scope: 'global',
      paletteId: 'rose',
      expectedRevision: current.preferences.revision,
    },
  });
  expect(changed.ok()).toBe(true);
  // APIRequestContext does not fire a browser storage/focus notification: this page is stale.
  await page.getByRole('button', { name: '세이지 팔레트 적용', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '로즈 팔레트 적용', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByLabel('테마 이름', { exact: true })).toHaveValue('Keep conflicted draft');
  await page.getByRole('button', { name: '세이지 팔레트 적용', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '세이지 팔레트 적용', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '편집 취소', exact: true }).click();
});
