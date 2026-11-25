import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import { DESKTOP_HEIGHT, DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { editLibraryContent, selectEditorSection } from './ui-navigation.js';
import { codeFieldValue, expectCodeFieldValue } from './code-field.js';

const greeting = [
  '{{#when::{{getvar::mood}}::is::calm}}',
  '<p>{{char}} smiles at {{user}}.</p>',
  '{{:else}}',
  '{{setvar::mood::{{random::calm::tense}}}}',
  '{{/when}}',
].join('\n');
const screenshotDirectory = 'output/editor-studio-4';
const viewports = [
  { name: 'desktop', width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
  { name: 'phone', width: MOBILE_WIDTH, height: 812 },
] as const;

async function seedBot(request: APIRequestContext, title: string) {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      package: nativeContent({
        name: title,
        description: 'First line\r\nSecond line',
        first_mes: greeting,
      }),
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Content;
}

async function openGreetings(page: Page, title: string) {
  await page.goto('/');
  await page.getByTestId('library-panel').getByLabel('서재 검색', { exact: true }).fill(title);
  await editLibraryContent(page, title);
  await selectEditorSection(page, '첫 메시지');
  const field = page.getByRole('textbox', { name: '기본 첫 메시지', exact: true });
  await expect(field).toHaveClass(/cm-content/u);
  return field;
}

async function capture(page: Page, name: string) {
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png` });
}

for (const viewport of viewports)
  for (const theme of ['light', 'dark'] as const)
    test(`CODEFIELD01 ${viewport.name} ${theme} CBS fields highlight, complete and diagnose`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript((mode) => localStorage.setItem('uimori:theme', mode), theme);
      const title = `CODEFIELD01 ${randomUUID().slice(0, 8)}`;
      await seedBot(request, title);
      const field = await openGreetings(page, title);
      await expectCodeFieldValue(field, greeting);
      await expect(field.locator('.cm-cbs-keyword', { hasText: '#when' })).toHaveCount(1);
      await expect(field.locator('.cm-cbs-name', { hasText: 'getvar' })).toHaveCount(1);
      await expect(field.locator('.cm-cbs-depth-1').first()).toBeVisible();

      await field.locator('.cm-cbs-keyword', { hasText: '#when' }).click();
      await expect(field.locator('.cm-cbs-match')).toHaveCount(2);
      await expect(field.locator('.cm-cbs-match').last()).toHaveText('{{/when}}');
      await capture(page, `nested-${viewport.name}-${theme}`);

      await field.locator('.cm-line').last().click();
      await page.keyboard.press('End');
      await page.keyboard.type('\n{{getv');
      const completion = page.locator('.cm-tooltip-autocomplete');
      await expect(completion.getByRole('option', { name: /^getvar/u })).toBeVisible();
      await capture(page, `autocomplete-${viewport.name}-${theme}`);
      await page.keyboard.press('Enter');
      await page.keyboard.type('::mood');
      await expect(completion).toHaveCount(0);
      await expect.poll(() => codeFieldValue(field)).toBe(`${greeting}\n{{getvar::mood`);

      await expect(field.locator('.cm-lintRange-error')).toHaveCount(1);
      await page.keyboard.press('ArrowLeft');
      await field.locator('.cm-lintRange-error').click();
      await expect(page.locator('.cm-cbs-cursor-diagnostic')).toHaveText('{{를 닫는 }}가 없어요.');
      await capture(page, `diagnostic-${viewport.name}-${theme}`);
    });

test('CODEFIELD02 typed CBS saves exactly and untouched CRLF text keeps its line endings', async ({
  page,
  request,
}) => {
  const title = `CODEFIELD02 ${randomUUID().slice(0, 8)}`;
  const seeded = await seedBot(request, title);
  const field = await openGreetings(page, title);
  const typed = '{{#when::toggle::rain}}\n비가 와요.\n{{/when}}{{nope}}';
  await field.fill(typed);
  await expectCodeFieldValue(field, typed);
  await expect(field.locator('.cm-lintRange-warning')).toHaveText('nope');
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
  const stored = await (await request.get(`/api/content/${seeded.id}`)).json();
  expect(stored.package.nativeRisu.card.first_mes).toBe(typed);
  expect(stored.package.nativeRisu.card.description).toBe('First line\r\nSecond line');
});
