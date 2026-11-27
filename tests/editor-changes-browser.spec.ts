import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import { visualReview } from './fixtures/visual-review.js';
import { waitForContentSave } from './fixtures/resource-save.js';
import {
  editLibraryContent,
  editorChanges,
  editorTab,
  selectEditorSection,
} from './ui-navigation.js';
import { expectCodeFieldValue } from './code-field.js';

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
  await expect(editorChanges(header)).toHaveAccessibleName('바뀐 영역 1곳');
  await selectEditorSection(page, '첫 메시지');
  await page.getByLabel('기본 첫 메시지', { exact: true }).fill('고친 인사');
  await selectEditorSection(page, 'JSON 소스');
  await page.getByLabel('Risu 원문 JSON', { exact: true }).fill('{"unfinished":');
  const chip = editorChanges(header);
  await expect(chip).toHaveAccessibleName('바뀐 영역 3곳');
  await chip.click();
  const sheet = review(page);
  await expect(sheet).toBeVisible();
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

test('EDIT03 the previous-save comparison opens in the review workspace, restores it and takes the restore back', async ({
  page,
  request,
}) => {
  const title = `EDIT03 ${randomUUID().slice(0, 8)}`;
  const seeded = await seedBot(request, title);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBot(page, title);
  const description = page.getByRole('textbox', { name: '카드 설명', exact: true });
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
