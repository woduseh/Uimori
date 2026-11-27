import { test, expect, type Page } from './fixtures/browser-test.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_THEME_TEMPLATE, emptyTheme, themeFile } from '../core/themes.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

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

for (const width of [412]) {
  test(`THEMES ${width} palette, custom editor, persistence and portable import`, async ({
    page,
    request,
  }) => {
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
    await page.getByLabel('밝은 색 강조 색상', { exact: true }).fill('#663399');
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
}) => {
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
