import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

async function openAppearance(page: Page, url = '/') {
  await page.goto(url);
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마와 색상');
  const advanced = page.locator('.theme-advanced:not([open]) > summary');
  if (await advanced.isVisible()) await advanced.click();
}
async function appearanceMode(page: Page, mode: 'light' | 'dark') {
  await selectSettingsSection(page, '일반');
  await page.getByLabel('앱 화면 테마', { exact: true }).selectOption(mode);
  await selectSettingsSection(page, '테마와 색상');
}
async function cssVariable(page: Page, name: string) {
  return page
    .locator('html')
    .evaluate((element, key) => getComputedStyle(element).getPropertyValue(key).trim(), name);
}

for (const width of [1440, 412]) {
  test(`APPEARANCE ${width} custom palette UI roundtrip preserves layout and authored controls`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await openAppearance(page);
    await appearanceMode(page, 'light');
    await page.getByRole('button', { name: '편지지 테마 적용', exact: true }).click();
    await page.getByText('현재 테마로 예문 보기', { exact: true }).click();
    const sample = page.locator('.theme-sample');
    await sample.getByText('봇이 만든 상태창', { exact: true }).click();
    const memo = sample.getByLabel('테마 예문 메모', { exact: true });
    await memo.fill('Authored memo survives custom palette changes');
    await memo.evaluate((element) => element.setAttribute('data-acceptance-node', 'original'));
    const manager = page.getByRole('region', { name: '팔레트 관리', exact: true });
    const title = `Acceptance palette ${width} ${randomUUID()}`;
    await manager.getByRole('button', { name: '새 팔레트', exact: true }).click();
    await manager.getByLabel('이름', { exact: true }).fill(title);
    await manager.getByLabel('강조 밝게', { exact: true }).fill('#123456');
    await manager.getByRole('button', { name: '어둡게', exact: true }).click();
    await manager.getByLabel('강조 어둡게', { exact: true }).fill('#abcdef');
    await manager.getByRole('button', { name: '팔레트 저장', exact: true }).click();
    const choice = page.getByRole('button', { name: `${title} 팔레트 적용`, exact: true });
    await expect(choice).toBeVisible();
    await choice.click();
    await expect.poll(() => cssVariable(page, '--accent')).toBe('#123456');
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
    await expect(memo).toHaveValue('Authored memo survives custom palette changes');
    await expect(memo).toHaveAttribute('data-acceptance-node', 'original');
    await appearanceMode(page, 'dark');
    await expect.poll(() => cssVariable(page, '--accent')).toBe('#abcdef');
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
    await expect(memo).toHaveValue('Authored memo survives custom palette changes');
    await expect(memo).toHaveAttribute('data-acceptance-node', 'original');
    const row = manager
      .locator('.palette-management-row')
      .filter({ has: page.getByText(title, { exact: true }) });
    await manager.locator('details > summary').click();
    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('button', { name: `${title} 내보내기`, exact: true }).click();
    const download = await downloadPromise;
    const exported = await readFile((await download.path())!);
    const file = JSON.parse(exported.toString());
    expect(JSON.stringify(file)).toContain('#123456');
    expect(JSON.stringify(file)).toContain('#abcdef');
    await manager.getByRole('button', { name: '닫기', exact: true }).click();
    await manager.locator('input[type=file]').setInputFiles({
      name: 'roundtrip.palette.json',
      mimeType: 'application/json',
      buffer: exported,
    });
    await expect(manager.getByLabel('이름', { exact: true })).toHaveValue(title);
    await manager.getByLabel('이름', { exact: true }).fill(`${title} imported`);
    await manager.getByRole('button', { name: '팔레트 저장', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `${title} imported 팔레트 적용`, exact: true })
    ).toBeVisible();
    await manager.getByRole('button', { name: '닫기', exact: true }).click();
    await openAppearance(page);
    await expect.poll(() => cssVariable(page, '--accent')).toBe('#abcdef');
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
    await manager.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`custom-palette-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '기본 테마 적용', exact: true }).click();
    await page.getByRole('button', { name: '팔레트 기본값으로', exact: true }).click();
    await manager.locator('details > summary').click();
    for (const name of [title, `${title} imported`]) {
      const saved = manager
        .locator('.palette-management-row')
        .filter({ has: page.getByText(name, { exact: true }) });
      await saved.getByRole('button', { name: `${name} 팔레트 삭제`, exact: true }).click();
      await page
        .getByRole('dialog', { name: '팔레트 삭제', exact: true })
        .getByRole('button', { name: '팔레트 삭제', exact: true })
        .click();
      await expect(saved).toHaveCount(0);
    }
  });
}

// The 1 KB TTF fixture contains only original triangle/space glyphs and is CC0.
// It tests Chromium's real font decoder without redistributing a system font.
test('APPEARANCE uploaded font loads, applies independently, persists, recovers and deletes', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openAppearance(page);
  const fonts = page.getByRole('region', { name: '글꼴', exact: true });
  const name = `Synthetic acceptance ${randomUUID()}`;
  const management = fonts.locator('.font-management');
  const manage = fonts.getByText('글꼴 관리', { exact: true });
  const preview = fonts.locator('.font-preview');
  const previewFamily = () => preview.evaluate((element) => getComputedStyle(element).fontFamily);
  await expect(management).not.toHaveAttribute('open');
  await expect(fonts.getByRole('combobox')).toHaveCount(2);
  await expect(fonts.getByText('본문 글꼴 미리보기', { exact: true })).toBeVisible();
  await expect(preview).toBeVisible();
  await manage.click();
  await fonts.getByLabel('글꼴 이름', { exact: true }).fill(name);
  await manage.click();
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  const unsaved = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await unsaved.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(
    unsaved.getByText('저장하지 못했어요. 계속 편집에서 오류나 미적용 입력을 확인해 주세요.')
  ).toBeVisible();
  await unsaved.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(management).toHaveAttribute('open');
  await expect(fonts.getByLabel('글꼴 이름', { exact: true })).toHaveValue(name);
  await fonts
    .getByLabel('글꼴 파일', { exact: true })
    .setInputFiles('tests/fixtures/appearance-synthetic.ttf');
  await fonts.getByLabel('글꼴 이름', { exact: true }).fill(name);
  await manage.click();
  await expect(fonts.getByLabel('글꼴 파일', { exact: true })).toBeHidden();
  await manage.click();
  await expect(fonts.getByLabel('글꼴 이름', { exact: true })).toHaveValue(name);
  expect(
    await fonts
      .getByLabel('글꼴 파일', { exact: true })
      .evaluate((element: HTMLInputElement) => element.files?.length)
  ).toBe(1);
  await expect(fonts.getByLabel('라이선스 (선택)', { exact: true })).toHaveCount(0);
  await expect(fonts.getByLabel('출처 주소 (선택)', { exact: true })).toHaveCount(0);
  await fonts.getByRole('button', { name: '글꼴 등록', exact: true }).click();
  const app = fonts.getByRole('combobox', { name: '앱 글꼴', exact: true });
  const reader = fonts.getByRole('combobox', { name: '본문 글꼴', exact: true });
  await expect(app.locator('option').filter({ hasText: name })).toHaveCount(1);
  await expect(app).toHaveValue('');
  await expect(reader).toHaveValue('');
  expect(await previewFamily()).not.toContain('uimori-font-');
  await manage.click();
  const catalog = await (await request.get('/api/fonts')).json();
  const font = catalog.fonts.find((entry: { title: string }) => entry.title === name);
  expect(font).toBeTruthy();
  expect(font).not.toHaveProperty('license');
  expect(font).not.toHaveProperty('sourceUrl');
  await expect(fonts.locator('.font-preview')).toContainText('달은 지금 긴 산허리에 걸려 있다.');
  await expect(fonts.getByText('이효석, 「메밀꽃 필 무렵」', { exact: true })).toBeVisible();
  const originalReader = await cssVariable(page, '--reading-font-family');
  await page.route('**/api/font-preferences', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 503, json: { error: 'Synthetic preference failure' } })
      : route.continue()
  );
  await app.selectOption(font.id);
  await expect(fonts.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요. (503)');
  await expect(app).toHaveValue('');
  expect(await previewFamily()).not.toContain('uimori-font-');
  expect((await (await request.get('/api/fonts')).json()).preferences).toMatchObject({
    appFontId: null,
    readerFontId: null,
  });
  await page.unroute('**/api/font-preferences');
  await app.selectOption(font.id);
  await expect(fonts.getByText('앱 글꼴 미리보기', { exact: true })).toBeVisible();
  await expect.poll(() => cssVariable(page, '--app-font-family')).toContain('uimori-font-');
  await expect.poll(previewFamily).toContain('uimori-font-');
  expect(await cssVariable(page, '--reading-font-family')).toBe(originalReader);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.fonts).some(
          (face) => face.family.startsWith('uimori-font-') && face.status === 'loaded'
        )
      )
    )
    .toBe(true);
  await reader.selectOption(font.id);
  await expect(fonts.getByText('본문 글꼴 미리보기', { exact: true })).toBeVisible();
  await expect.poll(() => cssVariable(page, '--reading-font-family')).toContain('uimori-font-');
  await app.selectOption('');
  await expect.poll(() => cssVariable(page, '--app-font-family')).not.toContain('uimori-font-');
  await expect.poll(previewFamily).not.toContain('uimori-font-');
  await expect.poll(() => cssVariable(page, '--reading-font-family')).toContain('uimori-font-');
  await app.selectOption(font.id);
  await openAppearance(page);
  await expect(app).toHaveValue(font.id);
  await expect(reader).toHaveValue(font.id);
  await expect(management).not.toHaveAttribute('open');
  await expect(fonts.getByText('본문 글꼴 미리보기', { exact: true })).toBeVisible();
  await expect.poll(previewFamily).toContain('uimori-font-');
  await expect.poll(() => cssVariable(page, '--app-font-family')).toContain('uimori-font-');
  await expect.poll(() => cssVariable(page, '--reading-font-family')).toContain('uimori-font-');
  await fonts.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('uploaded-font-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 412, height: 1000 });
  await fonts.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('uploaded-font-mobile.png'), fullPage: true });
  await page.route(`**/api/fonts/${font.id}/file`, (route) =>
    route.fulfill({ status: 503, body: 'synthetic font unavailable' })
  );
  await openAppearance(page);
  await expect(
    page.getByText('일부 글꼴을 불러오지 못해 기본 글꼴로 표시해요.', { exact: true })
  ).toBeVisible();
  await expect.poll(() => cssVariable(page, '--app-font-family')).not.toContain('uimori-font-');
  await expect.poll(() => cssVariable(page, '--reading-font-family')).not.toContain('uimori-font-');
  await expect.poll(previewFamily).not.toContain('uimori-font-');
  await expect(reader).toHaveValue(font.id);
  await page.unroute(`**/api/fonts/${font.id}/file`);
  await openAppearance(page, '/?theme-safe=1');
  await expect.poll(() => cssVariable(page, '--app-font-family')).not.toContain('uimori-font-');
  await expect.poll(() => cssVariable(page, '--reading-font-family')).not.toContain('uimori-font-');
  await expect(app).toHaveValue(font.id);
  await expect.poll(previewFamily).not.toContain('uimori-font-');
  await manage.click();
  await fonts.getByRole('button', { name: `${name} 글꼴 삭제`, exact: true }).click();
  await page
    .getByRole('dialog', { name: '글꼴 삭제', exact: true })
    .getByRole('button', { name: '글꼴 삭제', exact: true })
    .click();
  await expect(app).toHaveValue('');
  await expect(reader).toHaveValue('');
  const after = await (await request.get('/api/fonts')).json();
  expect(after.fonts.some((entry: { id: string }) => entry.id === font.id)).toBe(false);
  expect(after.preferences).toMatchObject({ appFontId: null, readerFontId: null });
});
