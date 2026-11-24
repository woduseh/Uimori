import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { nativeContent } from './fixtures/native-content.js';
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { editLibraryContent, navigationAction, selectPackageSection } from './ui-navigation.js';
import { browserPath } from '../scripts/browser-path.mjs';

test.use({
  launchOptions: {
    executablePath: browserPath(),
    args: ['--no-proxy-server'],
    ignoreDefaultArgs: ['--hide-scrollbars'],
  },
});

async function seedBot(request: APIRequestContext, title: string, greetings: string[] = []) {
  const pkg = nativeContent({
    name: title,
    description: '긴 설명 '.repeat(300),
    first_mes: '<div class="intro">{{char}}</div>',
    alternate_greetings: greetings,
    character_book: {
      entries: Array.from({ length: 30 }, (_, i) => ({
        keys: [`key${i}`],
        content: '로어 본문',
        comment: `로어 ${i}`,
      })),
    },
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

function frameGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width };
    };
    const scroll = document.querySelector<HTMLElement>('.destination-scroll')!;
    return {
      gutter: scroll.offsetWidth - scroll.clientWidth,
      header: box('.editor-frame-top > :first-child'),
      tabs: box('.editor-frame-tabs'),
      body: box('.library-page [role="tabpanel"]:not([hidden])'),
      outerOverflow: scroll.scrollHeight - scroll.clientHeight,
      documentOverflow: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
}

async function checkFrame(page: Page, tabs: string[], panes: string[]) {
  const first = await frameGeometry(page);
  for (const name of tabs) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const current = await frameGeometry(page);
    expect(current.gutter, `${name} gutter`).toBe(first.gutter);
    for (const part of ['header', 'tabs'] as const)
      for (const edge of ['left', 'top', 'width'] as const)
        expect(
          Math.abs(current[part][edge] - first[part][edge]),
          `${name} ${part} ${edge}`
        ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(current.body.left - current.tabs.left),
      `${name} body left`
    ).toBeLessThanOrEqual(1);
    expect(current.documentOverflow, `${name} document`).toBeLessThanOrEqual(0);
    if (panes.includes(name))
      expect(current.outerOverflow, `${name} outer scroll`).toBeLessThanOrEqual(1);
  }
}

for (const [width, height] of [
  [1440, 900],
  [DESKTOP_WIDTH, DESKTOP_HEIGHT],
] as const) {
  test(`EFRAME01 ${width}px resource and prompt editors keep one frame across tabs`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);
    const title = `EFRAME01 ${width} ${randomUUID().slice(0, 8)}`;
    await seedBot(request, title, ['둘째 인사']);
    const prompt = await request.post('/api/prompt-presets', {
      data: {
        title: `${title} 프롬프트`,
        role: 'main',
        program: createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT, 'main'),
        values: {},
      },
    });
    expect(prompt.ok(), await prompt.text()).toBe(true);
    await page.setViewportSize({ width, height });
    await openBot(page, title);
    await checkFrame(
      page,
      ['기본 정보', '첫 메시지', '로어북', '에셋', '번역 지침', '고급 설정', '제작 정보'],
      ['첫 메시지', '로어북', '고급 설정']
    );
    await page.getByRole('tab', { name: '기본 정보', exact: true }).click();
    await navigationAction(page, '프롬프트');
    await page.getByLabel('프롬프트 검색', { exact: true }).fill(`${title} 프롬프트`);
    await page
      .getByRole('button', { name: `${title} 프롬프트 프롬프트 편집`, exact: true })
      .click();
    await expect(page.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(
      `${title} 프롬프트`
    );
    await checkFrame(page, ['구성', '기본 옵션', '변수와 토글', '정규식', '협업'], ['구성']);
  });
}

test('EFRAME02 save is emphasized only with unsaved changes and chat start stays in the header', async ({
  page,
  request,
}) => {
  const title = `EFRAME02 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const header = page.locator('.editor-frame-top');
  const save = header.getByRole('button', { name: '변경사항 저장', exact: true });
  const start = header.getByRole('button', { name: '채팅 시작', exact: true });
  await expect(save).toBeDisabled();
  await expect(start).toBeEnabled();
  await page.getByRole('tab', { name: '로어북', exact: true }).click();
  await expect(start).toBeInViewport();
  await page.getByRole('tab', { name: '기본 정보', exact: true }).click();
  await page.getByLabel('Risu 자료 이름', { exact: true }).fill(`${title} 수정`);
  await expect(header.locator('.resource-editor-status').getByRole('status')).toHaveText(
    '미저장 변경'
  );
  await expect(save).toBeEnabled();
  await expect(start).toBeDisabled();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(start).toBeEnabled();
});

test('EFRAME03 first messages use one label, remember the monospace choice and hide single-item arrows', async ({
  page,
  request,
}) => {
  const title = `EFRAME03 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await selectPackageSection(page, '첫 메시지');
  const text = page.getByLabel('기본 첫 메시지', { exact: true });
  await expect(text).toHaveValue('<div class="intro">{{char}}</div>');
  await expect(page.locator('label').filter({ hasText: '기본 첫 메시지' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '첫 메시지 위로', exact: true })).toHaveCount(0);
  const mono = page.getByRole('button', { name: '고정폭 글꼴', exact: true });
  await expect(mono).toHaveAttribute('aria-pressed', 'false');
  const font = () => text.evaluate((node) => getComputedStyle(node).fontFamily);
  const bodyFont = await font();
  await mono.click();
  await expect(mono).toHaveAttribute('aria-pressed', 'true');
  expect(await font()).toMatch(/monospace/);
  expect(await font()).not.toBe(bodyFont);
  await openBot(page, title);
  await selectPackageSection(page, '첫 메시지');
  await expect(page.getByRole('button', { name: '고정폭 글꼴', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await page.getByRole('button', { name: '첫 메시지 추가', exact: true }).first().click();
  await expect(page.getByRole('button', { name: '첫 메시지 위로', exact: true })).toBeVisible();
});

test('EFRAME04 dropping image files on the asset area uses the upload validation', async ({
  page,
  request,
}) => {
  const title = `EFRAME04 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await selectPackageSection(page, '에셋');
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
  const tiles = page.getByLabel('Risu 이미지 목록', { exact: true }).getByRole('button');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('dropped_scene');
  await expect(area.locator('.native-assets-error')).toContainText('notes.txt');
  await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeEnabled();
  const upload = page.getByLabel('Risu 이미지 추가', { exact: true });
  await area.getByRole('searchbox').focus();
  await page.keyboard.press('Tab');
  await expect(upload).toBeFocused();
  expect(
    await area
      .locator('.file-picker-button')
      .first()
      .evaluate((node) => getComputedStyle(node).outlineStyle)
  ).not.toBe('none');
});
