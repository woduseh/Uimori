import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { nativeContent } from './fixtures/native-content.js';
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import {
  editLibraryContent,
  navigationAction,
  selectPackageSection,
  editorTab,
} from './ui-navigation.js';
import { browserPath } from '../scripts/browser-path.mjs';
import { waitForContentSave } from './fixtures/resource-save.js';

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
    await editorTab(page, name).click();
    await expect(editorTab(page, name)).toHaveAttribute('aria-selected', 'true');
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
      ['기본 정보', '첫 메시지', '로어북', '에셋', '번역 지침', '고급 설정'],
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
  await editorTab(page, '로어북').click();
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
  const tiles = page
    .getByLabel('Risu 이미지 목록', { exact: true })
    .locator('.native-assets-tile-select');
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

const visualReview = process.env.UIMORI_VISUAL_REVIEW === '1';

async function dropImages(page: Page, names: string[]) {
  const files = await Promise.all(
    names.map(async (name, index) => ({
      name,
      base64: (
        await sharp({
          create: {
            width: 40 + index * 10,
            height: 30,
            channels: 3,
            background: { r: 40 * index, g: 120, b: 200 },
          },
        })
          .png()
          .toBuffer()
      ).toString('base64'),
    }))
  );
  const area = page.getByRole('region', { name: 'Risu 에셋 편집', exact: true });
  const transfer = await page.evaluateHandle((items) => {
    const data = new DataTransfer();
    for (const item of items) {
      const bytes = Uint8Array.from(atob(item.base64), (char) => char.charCodeAt(0));
      data.items.add(new File([bytes], `${item.name}.png`, { type: 'image/png' }));
    }
    return data;
  }, files);
  await area.dispatchEvent('dragover', { dataTransfer: transfer });
  await area.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(
    page.getByLabel('Risu 이미지 목록', { exact: true }).locator('.native-assets-tile-select')
  ).toHaveCount(names.length);
}

async function openPrompt(page: Page, request: APIRequestContext, title: string) {
  const prompt = await request.post('/api/prompt-presets', {
    data: {
      title,
      role: 'main',
      program: createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT, 'main'),
      values: {},
    },
  });
  expect(prompt.ok(), await prompt.text()).toBe(true);
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
  await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
  await expect(page.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(title);
}

async function capture(page: Page, name: string) {
  if (!visualReview) return;
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: test.info().outputPath(`${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('EFRAME05 collection tabs name their current counts and follow local edits', async ({
  page,
  request,
}) => {
  const title = `EFRAME05 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, ['둘째 인사']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const tabs = page.getByLabel('자료 편집 영역', { exact: true });
  await expect(tabs.getByRole('tab', { name: '첫 메시지 2개', exact: true })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: '로어북 30개', exact: true })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: '에셋', exact: true })).toHaveText('에셋');
  await expect(tabs.getByRole('tab', { name: '기본 정보', exact: true })).toHaveText('기본 정보');
  await selectPackageSection(page, '첫 메시지');
  await page.getByRole('button', { name: '첫 메시지 추가', exact: true }).first().click();
  await expect(tabs.getByRole('tab', { name: '첫 메시지 3개', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '선택한 첫 메시지 삭제', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: '첫 메시지 2개', exact: true })).toBeVisible();
  await selectPackageSection(page, '에셋');
  await dropImages(page, ['count_a', 'count_b']);
  await expect(tabs.getByRole('tab', { name: '에셋 2개', exact: true })).toHaveText('에셋2');
});

test('EFRAME06 basic info folds the authoring fields, fills the height and syncs the header name', async ({
  page,
  request,
}) => {
  const title = `EFRAME06 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const description = page.getByLabel('카드 설명', { exact: true });
  await expect(page.getByText('1,500자', { exact: true })).toBeVisible();
  const box = await description.boundingBox();
  expect(box!.height).toBeGreaterThan(300);
  const overflow = await page
    .locator('.destination-scroll')
    .evaluate((node) => node.scrollHeight - node.clientHeight);
  expect(overflow).toBeLessThanOrEqual(1);
  await capture(page, 'eframe06-basic-1440');
  await description.fill('가'.repeat(20));
  await expect(page.getByText('20자', { exact: true })).toBeVisible();

  const authoring = page.locator('details.native-authoring');
  await expect(authoring).not.toHaveAttribute('open', '');
  await expect(page.getByLabel('제작자 코멘트', { exact: true })).toBeHidden();
  await authoring.getByText('제작 정보', { exact: true }).click();
  await page.getByLabel('제작자 코멘트', { exact: true }).fill('합성 메모');
  await page.getByLabel('제작자', { exact: true }).fill('합성 제작자');
  await page.getByLabel('자료 버전', { exact: true }).fill('1.2');
  const portrait = page.getByRole('region', { name: '대표 이미지 설정', exact: true });
  await expect(portrait.getByText('제작자 합성 제작자', { exact: true })).toBeVisible();
  await expect(portrait.getByText('버전 1.2', { exact: true })).toBeVisible();

  const header = page.getByLabel('봇 이름', { exact: true });
  const field = page.getByLabel('Risu 자료 이름', { exact: true });
  await expect(header).toHaveValue(title);
  await header.fill(`${title} 머리글`);
  await expect(field).toHaveValue(`${title} 머리글`);
  await field.fill(`${title} 본문`);
  await expect(header).toHaveValue(`${title} 본문`);
  const saved = waitForContentSave(page);
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  const result = await saved;
  const card = result.package!.nativeRisu.card;
  expect(result.title).toBe(`${title} 본문`);
  expect(card.name).toBe(`${title} 본문`);
  expect(card.creator_notes).toBe('합성 메모');
  expect(card.creator).toBe('합성 제작자');
  expect(card.character_version).toBe('1.2');

  await openBot(page, `${title} 본문`);
  await expect(page.locator('details.native-authoring')).not.toHaveAttribute('open', '');
});

test('EFRAME07 the asset grid keeps its columns, shows an inspector hint and offers tile actions by keyboard', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const title = `EFRAME07 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await selectPackageSection(page, '에셋');
  const inspector = page.getByRole('complementary', { name: '선택한 에셋', exact: true });
  await expect(inspector).toHaveText('에셋을 선택하면 이름과 설명을 편집할 수 있어요.');
  await dropImages(page, ['tile_a', 'tile_b', 'tile_c', 'tile_d']);
  const grid = page.getByLabel('Risu 이미지 목록', { exact: true });
  const columns = () =>
    grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  await grid.getByRole('button', { name: /tile_d/u }).click();
  await expect(inspector).toHaveText('에셋을 선택하면 이름과 설명을 편집할 수 있어요.');
  const before = await columns();
  expect(before).toBeGreaterThanOrEqual(2);
  const tile = grid.getByRole('button', { name: /tile_b/u });
  await tile.click();
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  await expect(inspector.getByLabel('이미지 이름', { exact: true })).toHaveValue('tile_b');
  expect(await columns()).toBe(before);
  await capture(page, 'eframe07-assets-1440');

  await tile.focus();
  await page.keyboard.press('Tab');
  const menu = grid.getByLabel('tile_b 작업', { exact: true });
  await expect(menu).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: '대표 이미지로 지정', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tile).toContainText('대표 이미지');
  await expect(page.getByText('대표 이미지로 지정했어요. 자료를 저장하면 반영돼요.')).toBeVisible();

  await menu.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: '참조 이름 복사', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('참조 이름을 복사했어요.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('tile_b');

  const other = grid.getByLabel('tile_d 작업', { exact: true });
  await other.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: '에셋 삭제', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page
    .getByRole('alertdialog', { name: '이 에셋을 자료에서 제거할까요?', exact: true })
    .getByRole('button', { name: '에셋 삭제', exact: true })
    .click();
  await expect(grid.getByRole('button', { name: /tile_d/u })).toHaveCount(0);
  await expect(editorTab(page, '에셋')).toHaveAccessibleName('에셋 3개');

  await page.setViewportSize({ width: 412, height: 915 });
  await expect(inspector).toHaveCount(0);
  const narrow = await columns();
  const third = grid.getByRole('button', { name: /tile_c/u });
  await third.click();
  const sheet = page.getByRole('dialog', { name: 'tile_c', exact: true });
  await expect(sheet.getByLabel('이미지 이름', { exact: true })).toHaveValue('tile_c');
  expect(await columns()).toBe(narrow);
  await capture(page, 'eframe07-assets-412');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(third).toHaveAttribute('aria-pressed', 'false');
});

test('EFRAME08 first-message previews show readable text instead of template code', async ({
  page,
  request,
}) => {
  const title = `EFRAME08 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, [
    '{{#if {{? {{getvar::met}} = 1}}}}<p class="again">다시 만났네, {{user}}.</p>{{/if}}',
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await selectPackageSection(page, '첫 메시지');
  const list = page.getByRole('complementary', { name: '첫 메시지 목록', exact: true });
  const rows = list.locator(':scope > button');
  await expect(rows.nth(0).locator('small')).toHaveText('코드만 있는 메시지');
  await expect(rows.nth(1).locator('small')).toHaveText('다시 만났네, .');
  await expect(list).not.toContainText('{{');
  await expect(page.getByLabel('기본 첫 메시지', { exact: true })).toHaveValue(
    '<div class="intro">{{char}}</div>'
  );
  await capture(page, 'eframe08-greetings-1440');
});

test('EFRAME09 prompt blocks show role chips, a block count and per-block characters', async ({
  page,
  request,
}) => {
  const title = `EFRAME09 ${randomUUID().slice(0, 8)}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPrompt(page, request, title);
  const list = page.getByRole('complementary', { name: '프롬프트 블록 목록', exact: true });
  const chips = list.locator('.native-block-chip');
  await expect(chips.first()).toBeVisible();
  const total = await chips.count();
  await expect(editorTab(page, '구성')).toHaveAccessibleName(`구성 ${total}개`);
  const texts = await chips.allTextContents();
  expect(texts.some((text) => ['system', 'user', 'assistant'].includes(text))).toBe(true);
  await page.getByRole('button', { name: '프롬프트 블록 추가', exact: true }).first().click();
  await expect(editorTab(page, '구성')).toHaveAccessibleName(`구성 ${total + 1}개`);
  await expect(chips.last()).toHaveText('system');
  await capture(page, 'eframe09-blocks-1440');
});

test('EFRAME10 the phone header keeps its height with the inline name and tab counts', async ({
  page,
  request,
}) => {
  const title = `EFRAME10 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, ['둘째 인사']);
  await page.setViewportSize({ width: 412, height: 915 });
  await openBot(page, title);
  const sizes = await page.evaluate(() => {
    const height = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().height;
    return {
      header: height('.editor-frame-top > .library-detail-heading'),
      tabs: height('.editor-frame-tabs'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(sizes.header).toBeLessThanOrEqual(113);
  expect(sizes.tabs).toBeLessThanOrEqual(56);
  expect(sizes.overflow).toBeLessThanOrEqual(0);
  await expect(page.getByLabel('봇 이름', { exact: true })).toBeVisible();
  await capture(page, 'eframe10-basic-412');
  await selectPackageSection(page, '첫 메시지');
  await capture(page, 'eframe10-greetings-412');
  await selectPackageSection(page, '에셋');
  await capture(page, 'eframe10-assets-412');
});

test('EFRAME11 basic info and assets fit every sidebar width without horizontal overflow', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const title = `EFRAME11 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1024, height: 800 });
  await openBot(page, title);
  await selectPackageSection(page, '에셋');
  await dropImages(page, ['wide_a', 'wide_b', 'wide_c']);
  const saved = waitForContentSave(page);
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await saved;
  const overflow = () =>
    page.evaluate(() => ({
      document: document.documentElement.scrollWidth - window.innerWidth,
      scroll: (() => {
        const node = document.querySelector<HTMLElement>('.destination-scroll')!;
        return node.scrollWidth - node.clientWidth;
      })(),
    }));
  for (const width of ['248', '320', '400']) {
    await page.evaluate((value) => localStorage.setItem('uimori:sidebar-width', value), width);
    await openBot(page, title);
    for (const section of ['기본 정보', '에셋']) {
      await selectPackageSection(page, section);
      expect(await overflow(), `${width} ${section}`).toEqual({ document: 0, scroll: 0 });
    }
    await capture(page, `eframe11-assets-sidebar-${width}`);
  }
});
