import { expect, test, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import { editLibraryContent, editorTab, selectEditorSection } from './ui-navigation.js';
import { browserPath } from '../scripts/browser-path.mjs';

test.use({
  launchOptions: {
    executablePath: browserPath(),
    args: ['--no-proxy-server'],
    ignoreDefaultArgs: ['--hide-scrollbars'],
  },
});

async function seedBot(request: APIRequestContext, title: string) {
  const pkg = nativeContent({
    name: title,
    description: '설명',
    first_mes: '<div class="intro">{{char}}</div>',
  });
  const response = await request.post('/api/content', {
    data: { kind: 'bot', title, package: pkg, loading: 'pinned', relatedIds: [] },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Content;
}

async function openBot(page: Page, title: string) {
  await page.goto('/');
  await page.getByTestId('library-panel').getByLabel('서재 검색', { exact: true }).fill(title);
  await editLibraryContent(page, title);
}

test('EFRAME04 dropping image files on the asset area uses the upload validation', async ({
  page,
  request,
}) => {
  const title = `EFRAME04 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await selectEditorSection(page, '에셋');
  const image = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .png()
    .toBuffer();
  const area = page.getByRole('region', { name: 'Risu 에셋 편집', exact: true });
  const transfer = await page.evaluateHandle((base64) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    data.items.add(new File([bytes], 'dropped_scene.png', { type: 'image/png' }));
    data.items.add(new File(['not an image'], 'notes.txt', { type: 'text/plain' }));
    return data;
  }, image.toString('base64'));
  await area.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(area).toHaveAttribute('data-drop-active', 'true');
  await area.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(area).not.toHaveAttribute('data-drop-active', 'true');
  const tiles = page
    .getByLabel('Risu 이미지 목록', { exact: true })
    .locator('.native-assets-tile-select');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('dropped_scene');
  await expect(area.locator('.native-assets-error')).toContainText('notes.txt');
  await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeEnabled();
});

test('EFRAME13 a source draft blocks the other panels until it is checked or reverted', async ({
  page,
  request,
}) => {
  const title = `EFRAME13 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const rail = page.getByRole('tablist', { name: '자료 편집 영역', exact: true });
  await selectEditorSection(page, 'JSON 소스');
  const raw = page.getByLabel('Risu 원문 JSON', { exact: true });
  await raw.fill('{"unfinished":');
  const notice = page.getByRole('status').filter({ hasText: '적용하지 않은 원문이 있어요.' });
  await expect(notice).toBeVisible();
  await selectEditorSection(page, '변수와 토글 초기값');
  await expect(page.getByRole('textbox', { name: '기본 변수', exact: true })).toBeDisabled();
  await selectEditorSection(page, '기본 정보');
  await expect(page.getByLabel('카드 설명', { exact: true })).toBeDisabled();
  await selectEditorSection(page, '정규식');
  await expect(
    page.getByRole('button', { name: '정규식 추가', exact: true }).first()
  ).toBeDisabled();
  await selectEditorSection(page, '트리거 / Lua');
  await expect(page.getByRole('button', { name: '항목 추가', exact: true })).toBeDisabled();
  await notice.getByRole('button', { name: '원문 확인', exact: true }).click();
  await expect(editorTab(rail, 'JSON 소스')).toHaveAttribute('aria-selected', 'true');
  await expect(raw).toHaveValue('{"unfinished":');
  await page.getByRole('button', { name: '입력 되돌리기', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await selectEditorSection(page, '변수와 토글 초기값');
  await expect(page.getByRole('textbox', { name: '기본 변수', exact: true })).toBeEnabled();
});
