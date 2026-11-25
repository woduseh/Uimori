import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { nativeContent } from './fixtures/native-content.js';
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import {
  discardEdits,
  editLibraryContent,
  editorChanges,
  editorSectionPlacement,
  navigationAction,
  editorTab,
  expectEditorSection,
  selectEditorSection,
} from './ui-navigation.js';
import { browserPath } from '../scripts/browser-path.mjs';
import { waitForContentSave } from './fixtures/resource-save.js';
import { expectCodeFieldValue } from './code-field.js';

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
    const element = (selector: string) => document.querySelector<HTMLElement>(selector)!;
    const box = (selector: string) => {
      const rect = element(selector).getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    };
    const scroll = element('.destination-scroll');
    const canvas = element('.editor-studio-canvas');
    return {
      header: box('.editor-studio-header > :first-child'),
      rail: box('.editor-studio-rail'),
      canvas: box('.editor-studio-canvas'),
      body: box('.library-page [role="tabpanel"]:not([hidden])'),
      viewport: window.innerHeight,
      outerOverflow: scroll.scrollHeight - scroll.clientHeight,
      outerScrollTop: scroll.scrollTop,
      canvasOverflow: canvas.scrollHeight - canvas.clientHeight,
      canvasScrollTop: canvas.scrollTop,
      documentOverflow: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
}

async function checkFrame(page: Page, sections: string[], panes: string[]) {
  const first = await frameGeometry(page);
  expect(first.canvas.top + first.canvas.height, 'canvas reaches the bottom').toBeCloseTo(
    first.viewport,
    0
  );
  expect(first.rail.height, 'rail fills the height').toBeCloseTo(first.canvas.height, 0);
  for (const name of sections) {
    await selectEditorSection(page, name);
    const current = await frameGeometry(page);
    for (const part of ['header', 'rail', 'canvas'] as const)
      for (const edge of ['left', 'top', 'width'] as const)
        expect(
          Math.abs(current[part][edge] - first[part][edge]),
          `${name} ${part} ${edge}`
        ).toBeLessThanOrEqual(1);
    expect(current.body.left, `${name} body left`).toBeGreaterThanOrEqual(current.canvas.left - 1);
    expect(current.documentOverflow, `${name} document`).toBeLessThanOrEqual(0);
    expect(current.outerOverflow, `${name} outer scroll`).toBeLessThanOrEqual(0);
    expect(current.canvasScrollTop, `${name} canvas starts at the top`).toBe(0);
    if (panes.includes(name))
      expect(current.canvasOverflow, `${name} canvas scroll`).toBeLessThanOrEqual(1);
  }
}

async function seedLongPrompt(request: APIRequestContext, title: string) {
  const program = createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT, 'main');
  const blocks = program.nativeRisuPreset.preset.promptTemplate as Record<string, unknown>[];
  while (blocks.length < 45)
    blocks.push({
      type: 'plain',
      role: 'system',
      name: `합성 블록 ${blocks.length + 1}`,
      text: '합성 지시문 '.repeat(40),
    });
  const prompt = await request.post('/api/prompt-presets', {
    data: { title, role: 'main', program, values: {} },
  });
  expect(prompt.ok(), await prompt.text()).toBe(true);
}

for (const [width, height] of [
  [1440, 900],
  [DESKTOP_WIDTH, DESKTOP_HEIGHT],
] as const) {
  test(`EFRAME01 ${width}px resource and prompt editors keep one frame with a section rail and scroll inside their panes`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);
    const title = `EFRAME01 ${width} ${randomUUID().slice(0, 8)}`;
    await seedBot(request, title, ['둘째 인사']);
    await seedLongPrompt(request, `${title} 프롬프트`);
    await page.setViewportSize({ width, height });
    await openBot(page, title);
    const rail = page.getByRole('tablist', { name: '자료 편집 영역', exact: true });
    await expect(rail).toHaveAttribute('aria-orientation', 'vertical');
    await editorTab(rail, '기본 정보').focus();
    await page.keyboard.press('ArrowDown');
    await expect(editorTab(rail, '첫 메시지')).toBeFocused();
    await expect(editorTab(rail, '첫 메시지')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(editorTab(rail, '기본 정보')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('편집 영역 선택', { exact: true })).toHaveCount(0);
    await checkFrame(
      page,
      [
        '기본 정보',
        '첫 메시지',
        '로어북',
        '추가 지침',
        '에셋',
        '기본 인물 외형',
        '번역 지침',
        '배경 HTML과 CSS',
        '변수와 토글 초기값',
        '트리거 / Lua',
        '정규식',
        '함께 쓰는 모듈',
        'JSON 소스',
      ],
      ['첫 메시지', '로어북']
    );
    await selectEditorSection(page, '기본 정보');
    await navigationAction(page, '프롬프트');
    await page.getByLabel('프롬프트 검색', { exact: true }).fill(`${title} 프롬프트`);
    await page
      .getByRole('button', { name: `${title} 프롬프트 프롬프트 편집`, exact: true })
      .click();
    await expect(page.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(
      `${title} 프롬프트`
    );
    await checkFrame(page, ['구성', '기본 옵션', '변수와 토글', '정규식', '협업'], ['구성']);
    await selectEditorSection(page, '구성');
    const list = page.getByRole('complementary', { name: '프롬프트 블록 목록', exact: true });
    await list.getByRole('button', { name: /^37\. 합성 블록 37/u }).click();
    const heading = page.locator('.native-item-detail h3');
    await expect(heading).toHaveText('합성 블록 37');
    await expect(heading).toBeInViewport();
    const geometry = await frameGeometry(page);
    expect(geometry.canvasScrollTop, 'canvas stays at the top').toBe(0);
    expect(geometry.canvasOverflow, 'canvas does not scroll').toBeLessThanOrEqual(1);
    expect(geometry.outerScrollTop, 'page stays at the top').toBe(0);
    expect(await list.evaluate((node) => node.scrollTop), 'list scrolls itself').toBeGreaterThan(0);
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
  const header = page.locator('.editor-studio-header');
  const save = header.getByRole('button', { name: '변경사항 저장', exact: true });
  const start = header.getByRole('button', { name: '채팅 시작', exact: true });
  await expect(save).toBeDisabled();
  await expect(start).toBeEnabled();
  await selectEditorSection(page, '로어북');
  await expect(start).toBeInViewport();
  await selectEditorSection(page, '기본 정보');
  await page.getByLabel(/^(봇|페르소나|모듈) 이름$/u).fill(`${title} 수정`);
  await expect(editorChanges(header)).toHaveAccessibleName('바뀐 영역 1곳');
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
  await selectEditorSection(page, '첫 메시지');
  const text = page.getByLabel('기본 첫 메시지', { exact: true });
  await expectCodeFieldValue(text, '<div class="intro">{{char}}</div>');
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
  await selectEditorSection(page, '첫 메시지');
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
  await selectEditorSection(page, '첫 메시지');
  await page.getByRole('button', { name: '첫 메시지 추가', exact: true }).first().click();
  await expect(tabs.getByRole('tab', { name: '첫 메시지 3개', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '선택한 첫 메시지 삭제', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: '첫 메시지 2개', exact: true })).toBeVisible();
  await selectEditorSection(page, '에셋');
  await dropImages(page, ['count_a', 'count_b']);
  await expect(tabs.getByRole('tab', { name: '에셋 2개', exact: true })).toHaveText('에셋2');
});

test('EFRAME06 basic info puts the description beside a meta column and edits the name only in the header', async ({
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
  const portrait = page.getByRole('region', { name: '대표 이미지 설정', exact: true });
  const credits = page.getByRole('region', { name: '제작 정보', exact: true });
  const portraitBox = (await portrait.boundingBox())!;
  expect(portraitBox.x, 'meta column sits right of the description').toBeGreaterThan(
    box!.x + box!.width
  );
  expect((await credits.boundingBox())!.y).toBeGreaterThan(portraitBox.y);
  await expect(portrait.locator('.native-identity-meta').first()).toHaveText('봇');
  await capture(page, 'eframe06-basic-1440');
  await description.fill('가'.repeat(20));
  await expect(page.getByText('20자', { exact: true })).toBeVisible();

  await credits.getByLabel('제작자 코멘트', { exact: true }).fill('합성 메모');
  await credits.getByLabel('제작자', { exact: true }).fill('합성 제작자');
  await credits.getByLabel('자료 버전', { exact: true }).fill('1.2');
  await expect(page.getByRole('textbox', { name: '이름', exact: true })).toHaveCount(0);
  const header = page.getByLabel('봇 이름', { exact: true });
  await expect(header).toHaveValue(title);
  await header.fill(`${title} 머리글`);
  const saved = waitForContentSave(page);
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  const result = await saved;
  const card = result.package!.nativeRisu.card;
  expect(result.title).toBe(`${title} 머리글`);
  expect(card.name).toBe(`${title} 머리글`);
  expect(card.creator_notes).toBe('합성 메모');
  expect(card.creator).toBe('합성 제작자');
  expect(card.character_version).toBe('1.2');

  await page.setViewportSize({ width: 700, height: 900 });
  const narrowDescription = (await description.boundingBox())!;
  const narrowPortrait = (await portrait.boundingBox())!;
  expect(narrowPortrait.y + narrowPortrait.height).toBeLessThanOrEqual(narrowDescription.y);
  expect((await credits.boundingBox())!.y).toBeGreaterThan(narrowDescription.y);
  expect(
    await page
      .locator('.editor-studio-canvas')
      .evaluate((node) => node.scrollWidth - node.clientWidth)
  ).toBeLessThanOrEqual(0);
});

for (const width of [1440, 390]) {
  test(`EFRAME15 ${width}px a new resource focuses the header name and explains an empty name inline once it is edited or saved`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/');
    const library = page.getByTestId('library-panel');
    await library.getByRole('tab', { name: '모듈', exact: true }).click();
    await library.getByRole('button', { name: '새 모듈', exact: true }).click();
    const name = library.getByLabel('모듈 이름', { exact: true });
    await expect(name).toBeFocused();
    await expectEditorSection(library, '로어북');
    const alert = library.getByRole('alert').filter({ hasText: '이름을 입력해 주세요.' });
    await expect(alert).toHaveCount(0);
    const register = library.getByRole('button', { name: '자료 등록', exact: true });
    await expect(register).toBeDisabled();
    const heading = library.locator('.library-detail-heading');
    const before = (await heading.boundingBox())!.height;
    await editorTab(library, '로어북')
      .or(library.getByLabel('편집 영역 선택', { exact: true }))
      .focus();
    await expect(alert).toHaveCount(0);
    await page.keyboard.press('Control+s');
    await expect(name).toBeFocused();
    await expect(alert).toBeVisible();
    await expect(alert).not.toHaveClass(/(^|\s)error(\s|$)/u);
    await expect(alert).toHaveCSS('font-size', '12px');
    expect((await heading.boundingBox())!.height - before, 'one line at most').toBeLessThanOrEqual(
      24
    );
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription('이름을 입력해 주세요.');
    await capture(page, `eframe15-new-module-${width}`);
    await name.fill('합성 모듈');
    await expect(alert).toHaveCount(0);
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await expect(register).toBeEnabled();
    await name.fill('');
    await expect(alert).toBeVisible();
    await expect(register).toBeDisabled();
  });
}

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
  await selectEditorSection(page, '에셋');
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
  await selectEditorSection(page, '첫 메시지');
  const list = page.getByRole('complementary', { name: '첫 메시지 목록', exact: true });
  const rows = list.locator(':scope > button');
  await expect(rows.nth(0).locator('small')).toHaveText('코드만 있는 메시지');
  await expect(rows.nth(1).locator('small')).toHaveText('다시 만났네, .');
  await expect(list).not.toContainText('{{');
  await expectCodeFieldValue(
    page.getByLabel('기본 첫 메시지', { exact: true }),
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

function headerRow(page: Page) {
  return page.locator('.editor-studio-header > .library-detail-heading').evaluate((row) => {
    const box = row.getBoundingClientRect();
    const controls = [...row.querySelectorAll<HTMLElement>('button, input, summary')]
      .filter((node) => node.checkVisibility({ checkVisibilityCSS: true }))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, middle: rect.top + rect.height / 2 };
      })
      .filter((rect) => rect.bottom - rect.top > 2);
    return {
      height: box.height,
      controls: controls.length,
      middles: controls.map((rect) => rect.middle),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

async function expectOneRow(page: Page, label: string) {
  const row = await headerRow(page);
  expect(row.height, `${label} header height`).toBeLessThanOrEqual(59);
  expect(row.controls, `${label} header controls`).toBeGreaterThanOrEqual(5);
  expect(
    Math.max(...row.middles) - Math.min(...row.middles),
    `${label} controls share one row`
  ).toBeLessThanOrEqual(2);
  expect(row.overflow, `${label} horizontal overflow`).toBeLessThanOrEqual(0);
}

for (const width of [360, 412]) {
  test(`EFRAME10 ${width}px the phone header stays in one row and sections open from one picker`, async ({
    page,
    request,
  }) => {
    const title = `EFRAME10 ${width} ${randomUUID().slice(0, 8)}`;
    await seedBot(request, title, ['둘째 인사']);
    await page.setViewportSize({ width, height: 844 });
    await openBot(page, title);
    await expectOneRow(page, 'saved');
    await expect(page.getByRole('tab')).toHaveCount(0);
    const picker = page.getByLabel('편집 영역 선택', { exact: true });
    expect((await picker.boundingBox())!.height).toBeLessThanOrEqual(44);
    await expect(picker.locator('.editor-studio-picker-current')).toHaveText('기본 정보');
    await capture(page, `eframe10-basic-${width}`);
    await picker.click();
    const sheet = page.getByRole('navigation', { name: '자료 편집 영역', exact: true });
    await expect(sheet.getByRole('button', { name: '기본 정보', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await sheet.getByRole('button', { name: '첫 메시지 2개', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(picker).toBeFocused();
    await expect(picker.locator('.editor-studio-picker-current')).toHaveText('첫 메시지2');
    await expect(page.getByLabel('기본 첫 메시지', { exact: true })).toBeVisible();
    await capture(page, `eframe10-greetings-${width}`);
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(picker).toBeFocused();

    const name = page.getByLabel('봇 이름', { exact: true });
    await name.fill(`${title} 수정`);
    await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeEnabled();
    await expectOneRow(page, 'dirty');
    await expect(page.getByRole('button', { name: '편집 취소', exact: true })).toHaveCount(0);
    await page.getByLabel('자료 메뉴', { exact: true }).click();
    await expect(page.getByRole('button', { name: '편집 취소', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await discardEdits(page);
    await expect(name).toHaveValue(title);
    await expect(name).toBeFocused();
    await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
  });
}

test('EFRAME11 basic info and assets fit every expanded sidebar width without horizontal overflow', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const title = `EFRAME11 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1024, height: 800 });
  await openBot(page, title);
  await selectEditorSection(page, '에셋');
  await dropImages(page, ['wide_a', 'wide_b', 'wide_c']);
  const saved = waitForContentSave(page);
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await saved;
  const overflow = () =>
    page.evaluate(() => {
      const excess = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector)!;
        return node.scrollWidth - node.clientWidth;
      };
      return {
        document: document.documentElement.scrollWidth - window.innerWidth,
        scroll: excess('.destination-scroll'),
        canvas: excess('.editor-studio-canvas'),
      };
    });
  const shell = page.locator('.app-shell');
  for (const width of ['248', '320', '400']) {
    await page.evaluate((value) => localStorage.setItem('uimori:sidebar-width', value), width);
    await openBot(page, title);
    await expect(shell).toHaveClass(/sidebar-collapsed/);
    await page.getByRole('button', { name: '좌측 패널 펼치기', exact: true }).click();
    await expect(shell).not.toHaveClass(/sidebar-collapsed/);
    for (const section of ['기본 정보', '에셋']) {
      await selectEditorSection(page, section);
      expect(await overflow(), `${width} ${section}`).toEqual({
        document: 0,
        scroll: 0,
        canvas: 0,
      });
    }
    await capture(page, `eframe11-assets-sidebar-${width}`);
  }
});

test('EFRAME12 an open editor collapses the sidebar without changing the saved choice', async ({
  page,
  request,
}) => {
  const title = `EFRAME12 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await seedLongPrompt(request, `${title} 프롬프트`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const shell = page.locator('.app-shell');
  const saved = () => page.evaluate(() => localStorage.getItem('uimori:sidebar-collapsed'));
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  const initial = await saved();
  expect(initial).not.toBe('true');

  await openBot(page, title);
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  expect(await saved()).toBe(initial);
  await page.getByRole('button', { name: '좌측 패널 펼치기', exact: true }).click();
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.getByLabel('봇 이름', { exact: true })).toHaveValue(title);
  await page.getByRole('button', { name: '좌측 패널 접기', exact: true }).click();
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  expect(await saved()).toBe(initial);
  await page.getByRole('button', { name: '서재 목록', exact: true }).click();
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  expect(await saved()).toBe(initial);

  await navigationAction(page, '프롬프트');
  await page.getByLabel('프롬프트 검색', { exact: true }).fill(`${title} 프롬프트`);
  await page.getByRole('button', { name: `${title} 프롬프트 프롬프트 편집`, exact: true }).click();
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  await page.getByRole('button', { name: '프롬프트 목록', exact: true }).click();
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  expect(await saved()).toBe(initial);

  await page.getByRole('button', { name: '좌측 패널 접기', exact: true }).click();
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  expect(await saved()).toBe('true');
  await navigationAction(page, '서재');
  await page.getByTestId('library-panel').getByLabel('서재 검색', { exact: true }).fill(title);
  await editLibraryContent(page, title);
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  await page.getByRole('button', { name: '서재 목록', exact: true }).click();
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  expect(await saved()).toBe('true');
});

test('EFRAME13 every former advanced section is one rail click away and a source draft still blocks the other panels', async ({
  page,
  request,
}) => {
  const title = `EFRAME13 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const rail = page.getByRole('tablist', { name: '자료 편집 영역', exact: true });
  await expect(page.getByText('고급 설정', { exact: true })).toHaveCount(0);
  for (const name of [
    '추가 지침',
    '변수와 토글 초기값',
    '배경 HTML과 CSS',
    '트리거 / Lua',
    '정규식',
    '함께 쓰는 모듈',
    'JSON 소스',
  ]) {
    const tab = editorTab(rail, name);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = page.locator(`[id="${await tab.getAttribute('aria-controls')}"]`);
    await expect(panel).toBeVisible();
    await expect(page.locator('.editor-studio [role="tabpanel"]:not([hidden])')).toHaveCount(1);
  }
  await expect(
    page.getByRole('complementary', { name: '정규식 목록', exact: true, includeHidden: true })
  ).toBeHidden();
  await selectEditorSection(page, '정규식');
  await expect(page.getByRole('complementary', { name: '정규식 목록', exact: true })).toBeVisible();

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

test('EFRAME14 the rail follows the content kind, keeps sections with data and offers the rest under more', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const id = randomUUID().slice(0, 8);
  const seed = async (kind: 'persona' | 'module', title: string, card: Record<string, unknown>) => {
    const pkg = nativeContent({ name: title, ...card }, {}, kind);
    if (kind === 'module') {
      pkg.nativeRisu.module = { name: title, lorebook: [{ key: 'k', content: 'c', comment: 'L' }] };
      pkg.nativeRisu.card = {};
    }
    const response = await request.post('/api/content', {
      data: { kind, title, package: pkg, loading: 'pinned', relatedIds: [] },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const empty = `EFRAME14 빈 페르소나 ${id}`;
  const withLore = `EFRAME14 로어 페르소나 ${id}`;
  const module = `EFRAME14 모듈 ${id}`;
  await seed('persona', empty, {});
  await seed('persona', withLore, {
    character_book: { entries: [{ keys: ['k'], content: '로어 본문', comment: '로어' }] },
  });
  await seed('module', module, {});
  await page.setViewportSize({ width: 1440, height: 900 });
  const open = async (tab: '페르소나' | '모듈', title: string) => {
    await page.goto('/');
    await navigationAction(page, tab);
    await page.getByTestId('library-panel').getByLabel('서재 검색', { exact: true }).fill(title);
    await editLibraryContent(page, title);
  };
  const rail = page.getByRole('tablist', { name: '자료 편집 영역', exact: true });
  const more = page.locator('.editor-studio-rail .editor-studio-more');

  await open('페르소나', withLore);
  expect((await editorSectionPlacement(page)).shown).toEqual(['기본 정보', '로어북', '에셋']);

  await open('페르소나', empty);
  const placement = await editorSectionPlacement(page);
  expect(placement.shown).toEqual(['기본 정보', '에셋']);
  expect(placement.more).toEqual(expect.arrayContaining(['로어북', '추가 지침', 'JSON 소스']));
  await expect(more.locator('summary')).toHaveText(`더 보기 (${placement.more.length})`);
  expect(await rail.locator('summary').count()).toBe(0);
  await more.locator('summary').click();
  await more.getByRole('button', { name: '추가 지침', exact: true }).click();
  const instructions = editorTab(rail, '추가 지침');
  await expect(instructions).toHaveAttribute('aria-selected', 'true');
  await expect(instructions).toBeFocused();
  await page.getByRole('textbox', { name: '글로벌 노트', exact: true }).fill('합성 지침');
  await selectEditorSection(page, '번역 지침');
  await selectEditorSection(page, '기본 정보');
  const after = await editorSectionPlacement(page);
  expect(after.shown).toEqual(['기본 정보', '추가 지침', '에셋']);
  expect(after.more).toContain('번역 지침');
  await expect(more.locator('summary')).toHaveText(`더 보기 (${after.more.length})`);
  await discardEdits(page);

  await open('모듈', module);
  const moduleRail = (await editorSectionPlacement(page)).shown;
  expect(moduleRail[0]).toBe('로어북');
  await expect(editorTab(rail, '로어북')).toHaveAttribute('aria-selected', 'true');
  expect(moduleRail).toEqual([
    '로어북',
    '기본 정보',
    '트리거 / Lua',
    '정규식',
    '변수와 토글 초기값',
    '배경 HTML과 CSS',
    '에셋',
  ]);
});

test('EFRAME16 regex list and detail scroll on their own and the rail counts scripts in both editors', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const title = `EFRAME16 ${randomUUID().slice(0, 8)}`;
  const rules = Array.from({ length: 30 }, (_, i) => ({
    comment: `규칙 ${i + 1}`,
    type: 'editdisplay',
    in: `find${i}`,
    out: '합성 치환 문장\n'.repeat(120),
  }));
  const pkg = nativeContent({
    name: title,
    extensions: { risuai: { customScripts: rules, triggerscript: [{ comment: 'a' }, {}] } },
  });
  const bot = await request.post('/api/content', {
    data: { kind: 'bot', title, package: pkg, loading: 'pinned', relatedIds: [] },
  });
  expect(bot.ok(), await bot.text()).toBe(true);
  const program = createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT, 'main');
  program.nativeRisuPreset.preset.regex = rules;
  const prompt = await request.post('/api/prompt-presets', {
    data: { title: `${title} 프롬프트`, role: 'main', program, values: {} },
  });
  expect(prompt.ok(), await prompt.text()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  const check = async (shot: string) => {
    await selectEditorSection(page, '정규식');
    const panel = page.locator('[data-studio-section="regex"]:not([hidden])');
    const list = panel.getByRole('complementary', { name: '정규식 목록', exact: true });
    await list.getByRole('button', { name: /^규칙 25/u }).click();
    const detail = panel.locator('.native-item-detail');
    await expect(detail.getByLabel('정규식 이름', { exact: true })).toHaveValue('규칙 25');
    await detail.evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
    const geometry = await frameGeometry(page);
    expect(
      await detail.evaluate((node) => node.scrollTop),
      'detail scrolls itself'
    ).toBeGreaterThan(0);
    expect(
      await list.evaluate((node) => node.scrollHeight - node.clientHeight),
      'list scrolls itself'
    ).toBeGreaterThan(0);
    expect(geometry.canvasScrollTop, 'canvas stays at the top').toBe(0);
    expect(geometry.outerScrollTop, 'page stays at the top').toBe(0);
    await expect(list).toBeInViewport({ ratio: 0.9 });
    const raw = panel.locator('.native-regex-raw > summary');
    await expect(raw).toBeInViewport();
    await capture(page, shot);
    await raw.click();
    const json = panel.getByLabel('Risu 정규식 JSON', { exact: true });
    await json.scrollIntoViewIfNeeded();
    await expect(json).toBeInViewport();
    await expect(panel.getByRole('button', { name: '편집기에 적용', exact: true })).toBeVisible();
    await raw.click();
  };

  await openBot(page, title);
  const rail = page.getByRole('tablist', { name: '자료 편집 영역', exact: true });
  await expect(editorTab(rail, '정규식')).toHaveAccessibleName('정규식 30개');
  await expect(editorTab(rail, '트리거 / Lua')).toHaveAccessibleName('트리거 / Lua 2개');
  await check('eframe16-content-regex-1440');

  await navigationAction(page, '프롬프트');
  await page.getByLabel('프롬프트 검색', { exact: true }).fill(`${title} 프롬프트`);
  await page.getByRole('button', { name: `${title} 프롬프트 프롬프트 편집`, exact: true }).click();
  await expect(editorTab(page, '정규식')).toHaveAccessibleName('정규식 30개');
  await check('eframe16-prompt-regex-1440');
});
