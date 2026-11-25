import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Content, PromptPreset } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { BUILTIN_PALETTES, THEME_PALETTE_ID } from '../core/theme-palettes.js';
import { editableResource } from '../core/resource-editing.js';
import { nativeContent } from './fixtures/native-content.js';
import { visualReview } from './fixtures/visual-review.js';
import { waitForContentSave } from './fixtures/resource-save.js';
import {
  editLibraryContent,
  editorChanges,
  editorTab,
  expectEditorSection,
  navigationAction,
  selectEditorSection,
} from './ui-navigation.js';
import { expectCodeFieldValue, codeFieldValue } from './code-field.js';

const SHOTS = 'output/change-review';
const regexOut = [
  '<div class="status">',
  '  <span>{{getvar::mood}}</span>',
  '  <span>장소: 항구</span>',
  '  <span>시간: 저녁</span>',
  '  <span>날씨: 맑음</span>',
  '  <span>동행: 리아</span>',
  '  <span>소지품: 우산</span>',
  '  <span>목표: 등대</span>',
  '  <span>기분: 차분함</span>',
  '  <span>체력: 80</span>',
  '</div>',
].join('\n');

async function seedBot(
  request: APIRequestContext,
  title: string,
  card: Record<string, unknown> = {}
) {
  const pkg = nativeContent({
    name: title,
    description: '처음 쓴 카드 설명',
    first_mes: '처음 인사',
    character_book: { entries: [{ keys: ['등대'], content: '등대 로어', comment: '등대' }] },
    ...card,
  });
  const response = await request.post('/api/content', {
    data: { kind: 'bot', title, package: pkg, loading: 'pinned', relatedIds: [] },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Content;
}

const loreEntries = (names: readonly string[]) =>
  names.map((name, id) => ({ id, keys: [name], content: `${name} 로어`, comment: name }));
const richCard = {
  character_book: { entries: loreEntries(['등대', '항구', '숲']) },
  extensions: {
    risuai: {
      customScripts: [
        { comment: '상태창', in: '\\[status\\]', out: regexOut, type: 'editdisplay' },
      ],
    },
  },
};

async function openBot(page: Page, title: string) {
  await page.goto('/');
  await page.getByTestId('library-panel').getByLabel('서재 검색', { exact: true }).fill(title);
  await editLibraryContent(page, title);
}

async function capture(page: Page, name: string, colorScheme: 'light' | 'dark' = 'light') {
  if (!visualReview) return;
  await page.emulateMedia({ colorScheme });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function editLore(page: Page, name: string, content: string) {
  const editor = page.getByRole('region', { name: '자료 상세', exact: true });
  await selectEditorSection(editor, '로어북');
  const navigation = editor.getByRole('complementary', { name: '로어 목록', exact: true });
  if (!(await navigation.isVisible()))
    await editor.getByRole('button', { name: '로어 목록 보기', exact: true }).click();
  await navigation.getByRole('button', { name, exact: true }).click();
  await editor.getByLabel('로어 본문', { exact: true }).fill(content);
}

async function editRegexOut(page: Page, content: string) {
  await selectEditorSection(page, '정규식');
  await page.getByRole('textbox', { name: '정규식 바꿀 내용', exact: true }).fill(content);
}

async function fiveChanges(page: Page, title: string) {
  await page.getByLabel('카드 설명', { exact: true }).fill('바닷가 마을의 등대지기 이야기');
  await page.getByLabel('봇 이름', { exact: true }).fill(`${title} 개정`);
  await editLore(page, '항구', '비가 그친 뒤 항구에 불이 하나둘 켜져요.');
  await editLore(page, '숲', '숲 로어에 새 길잡이 등불을 더했어요.');
  await editRegexOut(page, regexOut.replace('맑음', '흐림').replace('80', '65'));
}

const review = (page: Page) => page.getByRole('dialog', { name: '변경 검토', exact: true });
const compareDialog = (page: Page) =>
  page.getByRole('dialog', { name: '이전 저장본과 비교', exact: true });
const rail = (page: Page) =>
  review(page).getByRole('navigation', { name: '변경 목록', exact: true });

test('EDIT01 the header counts changed sections, the workspace shows every change open and jumps to one', async ({
  page,
  request,
}) => {
  const title = `EDIT01 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const header = page.locator('.editor-studio-header');
  await expect(editorChanges(header)).toHaveCount(0);
  await page.getByLabel('카드 설명', { exact: true }).fill('고친 카드 설명');
  await page.getByLabel('봇 이름', { exact: true }).fill(`${title} 수정`);
  await expect(editorChanges(header)).toHaveAccessibleName('변경 1건');
  await selectEditorSection(page, '첫 메시지');
  await page.getByLabel('기본 첫 메시지', { exact: true }).fill('고친 인사');
  await selectEditorSection(page, 'JSON 소스');
  await page.getByLabel('Risu 원문 JSON', { exact: true }).fill('{"unfinished":');
  const chip = editorChanges(header);
  await expect(chip).toHaveAccessibleName('변경 3건');
  await chip.click();
  const sheet = review(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveCSS('transform', 'none');
  await expect(sheet.locator('.change-review-subject')).toHaveText(`${title} 수정`);
  await expect(rail(page).locator('.change-review-rail-section')).toHaveText([
    '기본 정보',
    '첫 메시지',
    'JSON 소스적용 전 입력',
  ]);
  await expect(rail(page).locator('.change-review-rail-item .change-review-rail-label')).toHaveText(
    ['이름', '카드 설명', '기본 첫 메시지']
  );
  const description = sheet.getByRole('region', { name: '카드 설명 변경 내용', exact: true });
  await expect(description.locator('del')).toHaveText('삭제된 부분 처음 쓴');
  await expect(description.locator('ins')).toHaveText('추가된 부분 고친');
  await expect(sheet.getByRole('region', { name: '이름 변경 내용', exact: true })).toHaveCount(1);
  await expect(sheet).toContainText('적용하지 않은 입력은 아직 비교에 들어가지 않아요.');
  await expect(sheet.getByRole('heading', { level: 4 })).toHaveText([
    '이름',
    '카드 설명',
    '기본 첫 메시지',
  ]);
  await expect(sheet.getByRole('group', { name: '비교 보기 방식', exact: true })).toBeVisible();
  await expect(sheet.locator('.change-review-totals')).toContainText('영역 3곳');
  await expect(sheet.locator('.change-review-totals')).toContainText('항목 3개');
  await capture(page, 'edit01-review-1440-dark', 'dark');
  await sheet.getByRole('button', { name: '기본 첫 메시지 위치로 이동', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(editorTab(page, '첫 메시지')).toHaveAttribute('aria-selected', 'true');
  const greeting = page.getByRole('textbox', { name: '기본 첫 메시지', exact: true });
  await expectCodeFieldValue(greeting, '고친 인사');

  await chip.click();
  await sheet.getByRole('button', { name: '모든 편집 취소', exact: true }).click();
  await expect(chip).toHaveCount(0);
  await expectCodeFieldValue(page.getByLabel('기본 첫 메시지', { exact: true }), '처음 인사');
  await expect(page.getByLabel('봇 이름', { exact: true })).toHaveValue(title);
  await expect(page.getByLabel('봇 이름', { exact: true })).toBeFocused();
});

for (const width of [700, 390]) {
  test(`EDIT02 ${width}px the review fills the screen in one column with the cancel action that left the header`, async ({
    page,
    request,
  }) => {
    const title = `EDIT02 ${width} ${randomUUID().slice(0, 8)}`;
    await seedBot(request, title);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await openBot(page, title);
    const name = page.getByLabel('봇 이름', { exact: true });
    await name.fill(`${title} 수정`);
    const chip = editorChanges(page);
    await expect(chip).toHaveAccessibleName('변경 1건');
    await expect(chip.locator('.resource-editor-changes-count')).toHaveText('1');
    await expect(chip.locator('.resource-editor-changes-count')).toBeVisible();
    await expect(page.getByRole('button', { name: '편집 취소', exact: true })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await chip.click();
    const sheet = review(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveCSS('transition-duration', '0.15s, 0.15s');
    await expect(sheet).toHaveCSS('transform', 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const box = (await sheet.boundingBox())!;
    if (width === 390) {
      expect(box.x).toBe(0);
      expect(box.width).toBeCloseTo(width, 0);
      const picker = sheet.locator('.change-review-picker > summary');
      await expect(picker).toHaveText('변경 목록 1개');
      await picker.click();
      await rail(page).getByRole('button', { name: '이름', exact: true }).click();
      await expect(sheet.locator('.change-review-picker')).not.toHaveAttribute('open');
    } else expect(box.x + box.width).toBeLessThanOrEqual(width);
    await expect(sheet.getByRole('group', { name: '비교 보기 방식', exact: true })).toHaveCount(0);
    await expect(sheet.locator('.text-diff-document')).toHaveAttribute('data-layout', 'unified');
    const fits = await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth);
    expect(fits).toBe(true);
    const cancel = sheet.getByRole('button', { name: '모든 편집 취소', exact: true });
    await expect(cancel).toBeInViewport();
    await expect(
      sheet.getByRole('button', { name: '변경사항 저장', exact: true })
    ).toBeInViewport();
    if (width === 390) await shot(page, 'phone-390-review');
    await sheet.getByRole('button', { name: '이름 위치로 이동', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expectEditorSection(page, '기본 정보');
    await chip.click();
    await cancel.click();
    await expect(name).toHaveValue(title);
    await expect(chip).toHaveCount(0);
  });
}

test('EDIT03 the previous-save comparison opens in the review workspace, restores it and takes the restore back', async ({
  page,
  request,
}) => {
  const title = `EDIT03 ${randomUUID().slice(0, 8)}`;
  const seeded = await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const description = page.getByLabel('카드 설명', { exact: true });
  await description.fill('두 번째 카드 설명');
  await selectEditorSection(page, '첫 메시지');
  await page.getByLabel('기본 첫 메시지', { exact: true }).fill('두 번째 인사');
  const saved = waitForContentSave(page);
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await saved;
  const menu = page.getByLabel('자료 메뉴', { exact: true });
  await menu.click();
  await page.getByRole('button', { name: '이전 저장본과 비교', exact: true }).click();
  const dialog = compareDialog(page);
  const sections = dialog.locator('.change-review-rail-section');
  await expect(sections).toHaveText(['기본 정보', '첫 메시지']);
  await expect(
    page.locator('.action-menu-body').filter({ has: page.locator('.change-review-dialog') })
  ).toBeHidden();
  const greeting = dialog.getByRole('region', { name: '기본 첫 메시지 변경 내용', exact: true });
  await expect(greeting.locator('del')).toHaveText('삭제된 부분 처음');
  await expect(greeting.locator('ins')).toHaveText('추가된 부분 두 번째');
  await expect(dialog.getByRole('button', { name: /되돌리기$/u })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /위치로 이동$/u })).toHaveCount(0);
  await shot(page, 'previous-save-1440-light');
  await dialog.getByRole('button', { name: '이전 저장본으로 복원', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectCodeFieldValue(page.getByLabel('기본 첫 메시지', { exact: true }), '처음 인사');
  await selectEditorSection(page, '기본 정보');
  await expectCodeFieldValue(description, '처음 쓴 카드 설명');
  const stored = await (await request.get(`/api/content/${seeded.id}`)).json();
  expect(stored.revision).toBe(3);
  const notice = page.locator('.editor-restored-notice');
  await expect(notice).toContainText('이전 저장본으로 복원했어요.');
  await notice.getByRole('button', { name: '복원 취소', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expectCodeFieldValue(description, '두 번째 카드 설명');

  await menu.click();
  await page.getByRole('button', { name: '이전 저장본과 비교', exact: true }).click();
  await expect(sections).toHaveText(['기본 정보', '첫 메시지']);
  await dialog.getByRole('button', { name: '이전 저장본으로 복원', exact: true }).click();
  await expectCodeFieldValue(description, '처음 쓴 카드 설명');
  await menu.click();
  await page.getByRole('button', { name: '이전 저장본과 비교', exact: true }).click();
  await dialog.getByRole('button', { name: '이전 저장본으로 복원', exact: true }).click();
  await expectCodeFieldValue(description, '두 번째 카드 설명');
  await description.fill('세 번째 카드 설명');
  await menu.click();
  await expect(
    page.getByRole('button', { name: '이전 저장본과 비교', exact: true })
  ).toBeDisabled();
});

test('EDIT04 a resource saved once explains that there is no previous save to compare', async ({
  page,
  request,
}) => {
  const title = `EDIT04 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await page.getByLabel('자료 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '이전 저장본과 비교', exact: true }).click();
  const dialog = compareDialog(page);
  await expect(dialog).toContainText(
    '이전 저장본이 없어요. 한 번 더 저장하면 그 전 내용을 여기서 비교하고 복원할 수 있어요.'
  );
  await expect(
    dialog.getByRole('button', { name: '이전 저장본으로 복원', exact: true })
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('자료 메뉴', { exact: true })).toBeFocused();
});

test('EDIT05 prompt presets count sections and restore the previous save', async ({
  page,
  request,
}) => {
  const title = `EDIT05 ${randomUUID().slice(0, 8)}`;
  const program = createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT, 'main');
  const created = await request.post('/api/prompt-presets', {
    data: { title, role: 'main', program, values: {} },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const preset = (await created.json()) as PromptPreset;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
  await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  const body = editor.getByLabel('1번 프롬프트 본문', { exact: true });
  const original = await codeFieldValue(body);
  await body.fill('고친 프롬프트 본문');
  await editor.getByLabel('프롬프트 이름', { exact: true }).fill(`${title} 수정`);
  await expect(editorChanges(editor)).toHaveAccessibleName('변경 2건');
  await expect(editorTab(editor, '구성').locator('.section-navigation-changed')).toHaveCount(1);
  await editorChanges(editor).click();
  await expect(review(page).locator('.change-review-rail-section')).toHaveText([
    '구성',
    '기본 옵션',
  ]);
  await expect(
    review(page)
      .getByRole('region', { name: /본문 \(Risu CBS\) 변경 내용$/u })
      .locator('ins')
  ).toHaveText(['추가된 부분 고친 프롬프트 본문']);
  await review(page)
    .getByRole('button', { name: /본문 \(Risu CBS\) 위치로 이동$/u })
    .click();
  await expect(review(page)).toBeHidden();
  await expect(body).toBeFocused();
  await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
  await expect(editorChanges(editor)).toHaveCount(0);
  await editor.getByLabel('프롬프트 관리', { exact: true }).click();
  await editor.getByRole('button', { name: '이전 저장본과 비교', exact: true }).click();
  const dialog = compareDialog(page);
  await expect(dialog.locator('.change-review-rail-section')).toHaveText(['구성', '기본 옵션']);
  await dialog.getByRole('button', { name: '이전 저장본으로 복원', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectCodeFieldValue(body, original);
  await expect(editor.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(title);
  const stored = await (await request.get(`/api/resources/prompt-preset/${preset.id}`)).json();
  expect(stored.title).toBe(title);
  await editor.getByRole('button', { name: '복원 취소', exact: true }).click();
  await expectCodeFieldValue(body, '고친 프롬프트 본문');
  await expectEditorSection(editor, '구성');
});

test('EDIT06 360px the review and the previous-save comparison show one edited lore entry without page overflow', async ({
  page,
  request,
}) => {
  const title = `EDIT06 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, {
    character_book: { entries: loreEntries(['등대', '항구', '숲']) },
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await openBot(page, title);
  await editLore(page, '항구', '바람이 부는 항구 로어');
  await editorChanges(page).click();
  const sheet = review(page);
  await expect(sheet.locator('.change-review-card')).toHaveCount(1);
  const diff = sheet.getByRole('region', { name: '항구 / 로어 본문 변경 내용', exact: true });
  await expect(diff.locator('ins')).toHaveText('추가된 부분 바람이 부는');
  const fits = (selector: string) =>
    page.locator(selector).evaluate((node) => node.scrollWidth <= node.clientWidth);
  expect(await fits('.change-review-dialog .change-review-canvas')).toBe(true);
  const box = (await sheet.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await capture(page, 'edit06-review-360', 'dark');
  await page.keyboard.press('Escape');
  const saved = waitForContentSave(page);
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await saved;

  const menu = page.getByLabel('자료 메뉴', { exact: true });
  await menu.click();
  await page.getByRole('button', { name: '이전 저장본과 비교', exact: true }).click();
  const dialog = compareDialog(page);
  await expect(dialog.locator('.change-review-picker > summary')).toHaveText('변경 목록 1개');
  await expect(dialog.locator('.change-review-card')).toHaveCount(1);
  await expect(
    dialog.getByRole('region', { name: '항구 / 로어 본문 변경 내용', exact: true }).locator('del')
  ).toHaveCount(0);
  expect(await fits('.change-review-dialog .change-review-canvas')).toBe(true);
  const dialogBox = (await dialog.boundingBox())!;
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(360);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
});

test('EDIT07 a rewritten lore entry reads as two blocks while a light edit stays word by word', async ({
  page,
  request,
}) => {
  const title = `EDIT07 ${randomUUID().slice(0, 8)}`;
  const harbour =
    '비가 그치자 항구의 불빛이 하나둘 켜졌어요. 리아는 낡은 우산을 접고 부두 끝까지 천천히 걸어갔어요.';
  const forest = '숲은 해가 지면 금세 어두워져요. 길잡이 등불은 오래된 참나무 아래에 걸려 있어요.';
  await seedBot(request, title, {
    character_book: {
      entries: [
        { id: 0, keys: ['항구'], content: harbour, comment: '항구' },
        { id: 1, keys: ['숲'], content: forest, comment: '숲' },
      ],
    },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'dark'));
  await openBot(page, title);
  await editLore(
    page,
    '항구',
    '항구에 다시 불이 들어온 건 비가 그친 뒤였어요. 리아는 젖은 우산을 털며 부두 끝으로 서둘러 걸어갔어요.'
  );
  await editLore(page, '숲', forest.replace('금세', '순식간에').replace('오래된', '커다란'));
  await editorChanges(page).click();
  const sheet = review(page);
  for (const layout of ['나란히 보기', '통합 보기']) {
    await sheet.getByRole('button', { name: layout, exact: true }).click();
    const rewritten = sheet.getByRole('region', {
      name: '항구 / 로어 본문 변경 내용',
      exact: true,
    });
    await expect(rewritten.locator('del')).toHaveCount(1);
    await expect(rewritten.locator('del')).toContainText(
      '비가 그치자 항구의 불빛이 하나둘 켜졌어요.'
    );
    await expect(rewritten.locator('ins')).toHaveCount(1);
    const light = sheet.getByRole('region', { name: '숲 / 로어 본문 변경 내용', exact: true });
    await expect(light.locator('del')).toHaveText(['삭제된 부분 금세', '삭제된 부분 오래된']);
    await expect(light.locator('ins')).toHaveText(['추가된 부분 순식간에', '추가된 부분 커다란']);
  }
  await sheet.getByRole('button', { name: '나란히 보기', exact: true }).click();
});

test('EDIT08 a one-line script change emphasises the changed words with line numbers and hidden context', async ({
  page,
  request,
}) => {
  const title = `EDIT08 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, richCard);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await editRegexOut(page, regexOut.replace('날씨: 맑음', '날씨: 흐림'));
  await editorChanges(page).click();
  const sheet = review(page);
  const diff = sheet.getByRole('region', {
    name: '상태창 / 바꿀 내용 (OUT) 변경 내용',
    exact: true,
  });
  await expect(diff.locator('.text-diff-document')).toHaveAttribute('data-layout', 'split');
  const removed = diff.locator('.helper-diff-line[data-op="delete"]');
  const added = diff.locator('.helper-diff-line[data-op="insert"]');
  await expect(removed).toHaveCount(1);
  await expect(removed.locator('.text-diff-emphasis')).toHaveText('맑음');
  await expect(added.locator('.text-diff-emphasis')).toHaveText('흐림');
  await expect(removed.locator('.text-diff-number')).toHaveText('5');
  await expect(added.locator('.text-diff-number')).toHaveText('5');
  await expect(diff.locator('.text-diff-split-row')).toHaveCount(5);
  const before = diff.getByRole('button', { name: '숨긴 줄 2개 펼치기', exact: true });
  const after = diff.getByRole('button', { name: '숨긴 줄 4개 펼치기', exact: true });
  await expect(before).toBeVisible();
  await expect(after).toBeVisible();
  await before.click();
  await expect(diff.locator('.text-diff-split-row')).toHaveCount(7);
  await expect(diff.locator('.text-diff-split-row').first()).toContainText('<div class="status">');
  await shot(page, 'line-mode-split-1440-light');
  await sheet.getByRole('button', { name: '통합 보기', exact: true }).click();
  await expect(diff.locator('.text-diff-document')).toHaveAttribute('data-layout', 'unified');
  await expect(diff.locator('.helper-diff-line[data-op="delete"] .text-diff-emphasis')).toHaveText(
    '맑음'
  );
  await expect(diff.locator('.helper-diff-line[data-op="insert"] .text-diff-emphasis')).toHaveText(
    '흐림'
  );
  await page.keyboard.press('Escape');
  await editorChanges(page).click();
  await expect(diff.locator('.text-diff-document')).toHaveAttribute('data-layout', 'unified');
  await shot(page, 'line-mode-unified-1440-light');
  await sheet.getByRole('button', { name: '나란히 보기', exact: true }).click();
  await expect(diff.locator('.text-diff-document')).toHaveAttribute('data-layout', 'split');
});

test('EDIT09 the rail lists five changes across three sections, scrolls to a card and marks it', async ({
  page,
  request,
}) => {
  const title = `EDIT09 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, richCard);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await fiveChanges(page, title);
  const chip = editorChanges(page);
  await expect(chip).toHaveAccessibleName('변경 3건');
  await chip.click();
  const sheet = review(page);
  const items = rail(page).locator('.change-review-rail-item');
  await expect(items.locator('.change-review-rail-label')).toHaveText([
    '이름',
    '카드 설명',
    '항구 / 로어 본문',
    '숲 / 로어 본문',
    '상태창 / 바꿀 내용 (OUT)',
  ]);
  await expect(items.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(sheet.locator('.change-review-totals')).toContainText('항목 5개');
  await items.nth(4).click();
  await expect(items.nth(4)).toHaveAttribute('aria-current', 'true');
  await expect(sheet.locator('.change-review-card').nth(4)).toBeFocused();
  await expect(sheet.locator('.change-review-card').nth(4)).toBeInViewport();
  await items.nth(4).focus();
  await page.keyboard.press('ArrowUp');
  await expect(rail(page).getByRole('button', { name: '정규식', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(rail(page).getByRole('button', { name: '기본 정보', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(items.nth(0)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(chip).toBeFocused();
});

test('EDIT10 the footer saves like the header: a missing name keeps the review open, a valid save closes it', async ({
  page,
  request,
}) => {
  const title = `EDIT10 ${randomUUID().slice(0, 8)}`;
  const seeded = await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const name = page.getByLabel('봇 이름', { exact: true });
  await name.fill('');
  await page.getByLabel('카드 설명', { exact: true }).fill('저장할 카드 설명');
  await editorChanges(page).click();
  const sheet = review(page);
  const save = sheet.getByRole('button', { name: '변경사항 저장', exact: true });
  await save.click();
  await expect(sheet.getByRole('alert')).toHaveText('이름을 입력해 주세요.');
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await name.fill(`${title} 저장`);
  await editorChanges(page).click();
  await expect(sheet.getByRole('alert')).toHaveCount(0);
  const saved = waitForContentSave(page);
  await save.click();
  await saved;
  await expect(sheet).toBeHidden();
  await expect(editorChanges(page)).toHaveCount(0);
  const stored = await (await request.get(`/api/content/${seeded.id}`)).json();
  expect(stored.revision).toBe(2);
  expect(stored.title).toBe(`${title} 저장`);
});

test('EDIT11 moving to a lore change selects that entry and focuses its body', async ({
  page,
  request,
}) => {
  const title = `EDIT11 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, {
    character_book: { entries: loreEntries(['등대', '항구', '숲']) },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await editLore(page, '항구', '안개 낀 항구 로어');
  await editLore(page, '등대', '등대 로어');
  await selectEditorSection(page, '기본 정보');
  await editorChanges(page).click();
  await review(page)
    .getByRole('button', { name: '항구 / 로어 본문 위치로 이동', exact: true })
    .click();
  await expect(review(page)).toBeHidden();
  await expectEditorSection(page, '로어북');
  const navigation = page.getByRole('complementary', { name: '로어 목록', exact: true });
  await expect(navigation.getByRole('button', { name: '항구', exact: true })).toHaveAttribute(
    'aria-current',
    'true'
  );
  const body = page.getByRole('textbox', { name: '로어 본문', exact: true });
  await expect(body).toBeFocused();
  await expectCodeFieldValue(body, '안개 낀 항구 로어');
});

test('EDIT12 reverting one item removes its card, offers undo once and leaves the other change', async ({
  page,
  request,
}) => {
  const title = `EDIT12 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, richCard);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await fiveChanges(page, title);
  const chip = editorChanges(page);
  await chip.click();
  const sheet = review(page);
  const harbour = sheet.getByRole('heading', { name: '항구 / 로어 본문', exact: true });
  await expect(harbour).toBeVisible();
  await sheet.getByRole('button', { name: '항구 / 로어 본문 되돌리기', exact: true }).click();
  await expect(harbour).toHaveCount(0);
  const notice = sheet.locator('.change-review-undo');
  await expect(notice).toContainText('항구 / 로어 본문 변경을 되돌렸어요.');
  await expect(sheet.locator('.change-review-card')).toHaveCount(4);
  await shot(page, 'after-revert-1440-dark-pending');
  await notice.getByRole('button', { name: '되돌리기 취소', exact: true }).click();
  await expect(harbour).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(sheet.locator('.change-review-card')).toHaveCount(5);
  await sheet
    .getByRole('button', { name: '상태창 / 바꿀 내용 (OUT) 되돌리기', exact: true })
    .click();
  await expect(chip).toHaveAccessibleName('변경 2건');
  await page.keyboard.press('Escape');
  await selectEditorSection(page, '정규식');
  await expectCodeFieldValue(
    page.getByRole('textbox', { name: '정규식 바꿀 내용', exact: true }),
    regexOut
  );
  await expect(editorTab(page, '정규식').locator('.section-navigation-changed')).toHaveCount(0);
  await expect(editorTab(page, '로어북').locator('.section-navigation-changed')).toHaveCount(1);
});

test('EDIT13 changed sections carry a rail dot and edited code lines a gutter mark until the save', async ({
  page,
  request,
}) => {
  const title = `EDIT13 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, {
    description: '첫 줄 설명\n둘째 줄 설명\n셋째 줄 설명',
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const basic = editorTab(page, '기본 정보');
  await expect(basic.locator('.section-navigation-changed')).toHaveCount(0);
  const field = page.locator('[data-code-field="basic::description"]');
  const before = await field.boundingBox();
  await page
    .getByLabel('카드 설명', { exact: true })
    .fill('첫 줄 설명\n고친 둘째 줄 설명\n셋째 줄 설명\n넷째 줄 설명');
  await expect(basic.locator('.section-navigation-changed')).toHaveCount(1);
  await expect(basic).toHaveAccessibleDescription('저장하지 않은 변경 있음');
  await expect(field.locator('.cm-line.cm-change-changed')).toHaveCount(1);
  await expect(field.locator('.cm-line.cm-change-added')).toHaveCount(1);
  await expect(field.locator('.cm-line.cm-change-changed')).toHaveText('고친 둘째 줄 설명');
  const after = await field.boundingBox();
  expect(after!.x).toBe(before!.x);
  await shot(page, 'editor-markers-1440-light');
  const saved = waitForContentSave(page);
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await saved;
  await expect(basic.locator('.section-navigation-changed')).toHaveCount(0);
  await expect(field.locator('.cm-line[class*="cm-change-"]')).toHaveCount(0);
});

test('EDIT14 review screenshots across widths, themes and a named palette', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const title = `EDIT14 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, richCard);
  const palette = BUILTIN_PALETTES.find((item) => item.id.endsWith('midnight'))!;
  const select = async (paletteId: string) => {
    const catalog = await (await request.get('/api/themes')).json();
    const changed = await request.post('/api/themes/selection', {
      data: {
        dimension: 'palette',
        scope: 'global',
        paletteId,
        expectedRevision: catalog.preferences.revision,
      },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
  };
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'system'));
  await openBot(page, title);
  await fiveChanges(page, title);
  await selectEditorSection(page, '기본 정보');
  await shot(page, 'editor-rail-dots-1920-dark');
  await editorChanges(page).click();
  const sheet = review(page);
  await expect(sheet.locator('.change-review-card')).toHaveCount(5);
  await shot(page, 'review-split-1920-dark');
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, 'review-split-1440-dark');
  await sheet.getByRole('button', { name: '통합 보기', exact: true }).click();
  await shot(page, 'review-unified-1440-dark');
  await sheet.getByRole('button', { name: '나란히 보기', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await shot(page, 'review-split-1440-light');
  await rail(page).getByRole('button', { name: '상태창 / 바꿀 내용 (OUT)', exact: true }).click();
  await shot(page, 'review-line-mode-1440-light');
  await sheet.getByRole('button', { name: '숲 / 로어 본문 되돌리기', exact: true }).click();
  await expect(sheet.locator('.change-review-undo')).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await shot(page, 'review-after-revert-1440-dark');
  await sheet.locator('.change-review-undo').getByRole('button').click();
  try {
    await select(palette.id);
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect
      .poll(() =>
        page
          .locator('html')
          .evaluate((root) => getComputedStyle(root).getPropertyValue('--accent').trim())
      )
      .toBe(palette.colors.dark.accent);
    await shot(page, 'review-split-1440-midnight-dark');
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await expect
      .poll(() =>
        page
          .locator('html')
          .evaluate((root) => getComputedStyle(root).getPropertyValue('--accent').trim())
      )
      .toBe(palette.colors.light.accent);
    await shot(page, 'review-split-1440-midnight-light');
  } finally {
    await select(THEME_PALETTE_ID);
  }
  await page.keyboard.press('Escape');
  await selectEditorSection(page, '기본 정보');
  await page.getByLabel('카드 설명', { exact: true }).fill('바닷가 마을의\n등대지기 이야기');
  await expect(page.locator('[data-code-field="basic::description"] .cm-change-added')).toHaveCount(
    1
  );
  await shot(page, 'editor-gutter-1440-light');
  await page.setViewportSize({ width: 390, height: 844 });
  await editorChanges(page).click();
  await shot(page, 'review-phone-390-light');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await shot(page, 'review-phone-390-dark');
});

test('EDIT15 three hundred changed lore entries open quickly and render diffs only near the view', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const title = `EDIT15 ${randomUUID().slice(0, 8)}`;
  const entries = loreEntries(Array.from({ length: 300 }, (_, index) => `항목 ${index + 1}`));
  const seeded = await seedBot(request, title, { character_book: { entries } });
  const changed = nativeContent({
    name: title,
    description: '처음 쓴 카드 설명',
    first_mes: '처음 인사',
    character_book: {
      entries: entries.map((entry) => ({
        ...entry,
        content: `${entry.content}에 새 문장을 덧붙였어요.`,
      })),
    },
  });
  const updated = await request.post('/api/resources/save', {
    data: {
      kind: 'content',
      id: seeded.id,
      expectedRevision: seeded.revision,
      model: { ...editableResource('content', seeded), package: changed },
    },
  });
  expect(updated.ok(), await updated.text()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  await page.getByLabel('자료 메뉴', { exact: true }).click();
  const started = Date.now();
  await page.getByRole('button', { name: '이전 저장본과 비교', exact: true }).click();
  const dialog = compareDialog(page);
  await expect(dialog.locator('[data-review-section="lore"] .change-review-card')).toHaveCount(300);
  await expect(dialog.locator('.change-review-diff').first()).toBeVisible();
  const opened = Date.now() - started;
  const rendered = await dialog.locator('.change-review-diff').count();
  expect(rendered).toBeLessThan(80);
  const jumpStarted = Date.now();
  await dialog.getByRole('button', { name: '항목 300 / 로어 본문', exact: true }).click();
  const last = dialog.getByRole('region', { name: '항목 300 / 로어 본문 변경 내용', exact: true });
  await expect(last).toBeInViewport();
  const jumped = Date.now() - jumpStarted;
  test.info().annotations.push({
    type: 'measurement',
    description: `300 changes: open ${opened}ms, ${rendered} diffs rendered, rail jump to the last ${jumped}ms`,
  });
  console.log(`EDIT15 open ${opened}ms, rendered ${rendered}, jump ${jumped}ms`);
});
