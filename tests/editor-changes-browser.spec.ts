import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content, PromptPreset } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
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

async function seedBot(request: APIRequestContext, title: string) {
  const pkg = nativeContent({
    name: title,
    description: '처음 쓴 카드 설명',
    first_mes: '처음 인사',
    character_book: { entries: [{ keys: ['등대'], content: '등대 로어', comment: '등대' }] },
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

async function capture(page: Page, name: string, colorScheme: 'light' | 'dark' = 'light') {
  if (!visualReview) return;
  await page.emulateMedia({ colorScheme });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
}

const drawer = (page: Page) => page.getByRole('dialog', { name: '변경한 편집 영역', exact: true });
const compareDialog = (page: Page) =>
  page.getByRole('dialog', { name: '이전 저장본과 비교', exact: true });

test('EDIT01 the header counts changed sections, the drawer jumps to one and a pending draft counts', async ({
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
  await capture(page, 'edit01-header-1440', 'dark');
  await chip.click();
  const sheet = drawer(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveCSS('transform', 'none');
  const items = sheet
    .getByRole('list', { name: '변경한 편집 영역', exact: true })
    .getByRole('button');
  await expect(items).toHaveText(['기본 정보', '첫 메시지', 'JSON 소스적용 전 입력']);
  await capture(page, 'edit01-drawer-1440-dark', 'dark');
  await sheet.getByRole('button', { name: '첫 메시지', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(chip).toBeFocused();
  await expect(editorTab(page, '첫 메시지')).toHaveAttribute('aria-selected', 'true');
  await expectCodeFieldValue(page.getByLabel('기본 첫 메시지', { exact: true }), '고친 인사');

  await chip.click();
  await sheet.getByRole('button', { name: '편집 취소', exact: true }).click();
  await expect(chip).toHaveCount(0);
  await expectCodeFieldValue(page.getByLabel('기본 첫 메시지', { exact: true }), '처음 인사');
  await expect(page.getByLabel('봇 이름', { exact: true })).toHaveValue(title);
  await expect(page.getByLabel('봇 이름', { exact: true })).toBeFocused();
});

for (const width of [700, 390]) {
  test(`EDIT02 ${width}px the changes drawer holds the cancel action that left the header`, async ({
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
    await capture(page, `edit02-header-${width}`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await chip.click();
    const sheet = drawer(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveCSS('transition-duration', '0.15s, 0.15s');
    await expect(sheet).toHaveCSS('transform', 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const box = (await sheet.boundingBox())!;
    expect(box.x + box.width).toBeCloseTo(width, 0);
    const cancel = sheet.getByRole('button', { name: '편집 취소', exact: true });
    await expect(cancel).toBeInViewport();
    await capture(page, `edit02-drawer-${width}`);
    await sheet.getByRole('button', { name: '기본 정보', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expectEditorSection(page, '기본 정보');
    await chip.click();
    await cancel.click();
    await expect(name).toHaveValue(title);
    await expect(chip).toHaveCount(0);
  });
}

test('EDIT03 comparing with the previous save lists the differing sections, restores it and takes the restore back', async ({
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
  const sections = dialog
    .getByRole('list', { name: '다른 영역', exact: true })
    .getByRole('listitem');
  await expect(sections).toHaveText(['기본 정보', '첫 메시지']);
  await capture(page, 'edit03-compare-1440');
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
  await capture(page, 'edit04-no-previous-1440');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
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
  await editorChanges(editor).click();
  await expect(
    drawer(page).getByRole('list', { name: '변경한 편집 영역', exact: true }).getByRole('button')
  ).toHaveText(['구성', '기본 옵션']);
  await page.keyboard.press('Escape');
  await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
  await expect(editorChanges(editor)).toHaveCount(0);
  await editor.getByLabel('프롬프트 관리', { exact: true }).click();
  await editor.getByRole('button', { name: '이전 저장본과 비교', exact: true }).click();
  const dialog = compareDialog(page);
  await expect(
    dialog.getByRole('list', { name: '다른 영역', exact: true }).getByRole('listitem')
  ).toHaveText(['구성', '기본 옵션']);
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
