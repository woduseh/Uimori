import { fixtureBotInput } from './fixtures/chat.js';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_THEME_TEMPLATE, emptyTheme, themeFile } from '../core/themes.js';

for (const width of [1440, 412]) {
  test(`THEMES ${width} palette, custom editor, persistence and portable import`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/?panel=settings&section=themes');
    await expect(page.getByRole('button', { name: '서재 테마 적용', exact: true })).toBeVisible();
    await page.getByLabel('테마 화면 모드', { exact: true }).selectOption('light');
    await page.getByRole('button', { name: '미드나이트 테마 적용', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:midnight');
    await page.getByLabel('테마 화면 모드', { exact: true }).selectOption('dark');
    await expect
      .poll(() =>
        page.locator('html').evaluate((e) => getComputedStyle(e).getPropertyValue('--bg').trim())
      )
      .toBe('#131923');
    await page.getByLabel('테마 화면 모드', { exact: true }).selectOption('light');
    const name = `Theme ${width} ${randomUUID().slice(0, 8)}`;
    await page.getByRole('button', { name: '새 커스텀 테마', exact: true }).click();
    await page.getByLabel('테마 이름', { exact: true }).fill(name);
    await page.getByLabel('테마 설명', { exact: true }).fill('Synthetic portable theme');
    await page.getByLabel('light accent 색상', { exact: true }).fill('#663399');
    await page.getByText('CSS·HTML 직접 편집', { exact: true }).click();
    await page
      .getByLabel('레이아웃 HTML', { exact: true })
      .fill(`<section class="theme-test-layout">${DEFAULT_THEME_TEMPLATE}</section>`);
    await page
      .getByLabel('레이아웃 CSS', { exact: true })
      .fill(
        '.theme-test-layout { padding: 16px; border: 1px solid var(--line); border-radius: 16px; }'
      );
    await page.getByLabel('본문 CSS', { exact: true }).fill('p { letter-spacing: 1px; }');
    await page.getByRole('button', { name: '미리 적용', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'preview');
    await page.getByRole('button', { name: '미리보기 끝내기', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:midnight');
    await page.getByRole('button', { name: '테마 저장', exact: true }).click();
    const apply = page.getByRole('button', { name: `${name} 테마 적용`, exact: true });
    await expect(apply).toBeVisible();
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
    await page.goto('/?panel=settings&section=themes');
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
    await page.getByRole('button', { name: '숲 테마 적용', exact: true }).click();
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
  await page.goto('/?panel=settings&section=themes');
  await page.getByRole('button', { name: '숲 테마 적용', exact: true }).click();
  await page.getByText('현재 테마로 예문 보기', { exact: true }).click();
  const sample = page.locator('.theme-sample');
  await sample.getByText('봇이 만든 상태창', { exact: true }).click();
  const input = sample.getByLabel('테마 예문 메모', { exact: true });
  await input.fill('keep me');
  await input.evaluate((e) => e.setAttribute('data-stable-node', 'yes'));
  await page.getByRole('button', { name: '서재 테마 적용', exact: true }).click();
  await expect(input).toHaveValue('keep me');
  await expect(input).toHaveAttribute('data-stable-node', 'yes');
  await expect(sample.locator('.paper')).toBeVisible();
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
  await page.goto('/?theme-safe=1&panel=settings&section=themes');
  await expect(page.locator('#root')).toBeVisible();
  await page.getByRole('button', { name: '숲 테마 적용', exact: true }).click();
  for (const theme of [saved.saved, hidden.saved])
    await request.delete(`/api/themes/${theme.id}`, { data: { expectedRevision: theme.revision } });
});

test('THEMES invalid import leaves selection untouched and closing dirty editor requires a decision', async ({
  page,
}) => {
  await page.goto('/?panel=settings&section=themes');
  await page.getByRole('button', { name: '숲 테마 적용', exact: true }).click();
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
  const url = `/?chat=${chat.id}&panel=settings&section=themes`;
  await page.goto(url);
  const scope = page.getByLabel('테마 적용 범위', { exact: true });
  await expect(scope.locator('option[value="bot"]')).toBeAttached();
  await scope.selectOption('global');
  await page.getByRole('button', { name: '숲 테마 적용', exact: true }).click();
  await scope.selectOption('bot');
  await page.getByRole('button', { name: '서재 테마 적용', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:library');
  await scope.selectOption('chat');
  await page.getByRole('button', { name: '벚꽃 테마 적용', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:blossom');
  const other = await context.newPage();
  await other.goto(`/?chat=${chat.id}`);
  await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:blossom');
  await page.getByRole('button', { name: '상위 설정 따르기', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:library');
  await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:library');
  await scope.selectOption('bot');
  await page.getByRole('button', { name: '상위 설정 따르기', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:forest');
  await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:forest');
  const tabs = page.getByRole('tablist', { name: '설정 항목', exact: true });
  await other.close();
  await tabs.getByRole('tab', { name: '일반', exact: true }).click();
  await page.keyboard.press('ArrowDown');
  await expect(tabs.getByRole('tab', { name: '테마·색상', exact: true })).toBeFocused();
});
