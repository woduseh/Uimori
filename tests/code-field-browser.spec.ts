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

async function seedBot(
  request: APIRequestContext,
  title: string,
  card: Record<string, unknown> = {}
) {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      package: nativeContent({
        name: title,
        description: 'First line\r\nSecond line',
        first_mes: greeting,
        ...card,
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
      await completion.getByRole('option', { name: /^getvar/u }).click();
      await page.keyboard.type('::mood');
      await expect(completion).toHaveCount(0);
      await expect.poll(() => codeFieldValue(field)).toBe(`${greeting}\n{{getvar::mood`);

      await expect(field.locator('.cm-lintRange-error')).toHaveCount(1);
      await page.keyboard.press('ArrowLeft');
      await field.locator('.cm-lintRange-error').click();
      await expect(page.locator('.cm-cbs-cursor-diagnostic > span')).toHaveText(
        '{{를 닫는 }}가 없어요.'
      );
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

test('CODEFIELD03 undo history stays with the item it was typed in', async ({ page, request }) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  const title = `CODEFIELD03 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, { alternate_greetings: ['', ''] });
  await openGreetings(page, title);
  const items = page.locator('.native-item-list');
  const alternate = page.getByRole('textbox', { name: '대체 첫 메시지', exact: true });
  await items.locator('[data-studio-item="1"]').click();
  await expect(alternate).toHaveClass(/cm-content/u);
  await alternate.click();
  await page.keyboard.type('첫 번째 대체 인사');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expectCodeFieldValue(alternate, '');
  await items.locator('[data-studio-item="2"]').click();
  await expect(items.locator('[data-studio-item="2"]')).toHaveAttribute('aria-current', 'true');
  await alternate.click();
  await page.keyboard.press('ControlOrMeta+z');
  await expectCodeFieldValue(alternate, '');
  await page.keyboard.type('두 번째');
  await items.locator('[data-studio-item="1"]').click();
  await expectCodeFieldValue(alternate, '');
});

test('CODEFIELD05 a large document keeps marks on their text while its analysis catches up', async ({
  page,
  request,
}) => {
  const title = `CODEFIELD05 ${randomUUID().slice(0, 8)}`;
  const line = '{{#when::{{getvar::mood}}::is::calm}}<p>{{char}} {{random::a::b}}</p>{{/when}}\n';
  const large = line.repeat(Math.ceil(80_000 / line.length));
  await seedBot(request, title, { first_mes: large });
  const field = await openGreetings(page, title);
  await expect(field.locator('.cm-cbs-name', { hasText: 'getvar' }).first()).toBeVisible();
  await field.locator('.cm-line').first().click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('{{nope ');
  const braces = () =>
    field
      .locator('.cm-cbs-brace')
      .evaluateAll((items) => [...new Set(items.map((item) => item.textContent))]);
  expect(await braces()).toEqual(['{{', '}}']);
  await expect(field.locator('.cm-lintRange-error')).toHaveCount(1);
  await expect(field.locator('.cm-lintRange-error')).toHaveText('{{');
  expect(await braces()).toEqual(['{{', '}}']);
  await expectCodeFieldValue(field, `{{nope ${large}`);
});

test('CODEFIELD04 a stale value during Hangul composition waits for the composition', async ({
  page,
  request,
}) => {
  const title = `CODEFIELD04 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, { first_mes: '인사' });
  const field = await openGreetings(page, title);
  await field.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' 안');
  await expectCodeFieldValue(field, '인사 안');
  const protocol = await page.context().newCDPSession(page);
  await protocol.send('Input.imeSetComposition', {
    text: 'ㄴ',
    selectionStart: 1,
    selectionEnd: 1,
  });
  await protocol.send('Input.imeSetComposition', {
    text: '녀',
    selectionStart: 1,
    selectionEnd: 1,
  });
  await expect.poll(() => codeFieldValue(field)).toBe('인사 안녀');
  const composing = await field.evaluate((element) => {
    const host = element.closest('.code-field')!;
    const fiberKey = Object.keys(host).find((key) => key.startsWith('__reactFiber$'))!;
    type Fiber = { return: { memoizedProps: { onChange(value: string): void } } };
    (host as unknown as Record<string, Fiber>)[fiberKey]!.return.memoizedProps.onChange('인사');
    type View = { composing: boolean };
    return (element as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view.composing;
  });
  expect(composing).toBe(true);
  await protocol.send('Input.imeSetComposition', {
    text: '녕',
    selectionStart: 1,
    selectionEnd: 1,
  });
  await protocol.send('Input.insertText', { text: '녕' });
  await expectCodeFieldValue(field, '인사 안녕');
  await page.keyboard.type('하세요');
  await expectCodeFieldValue(field, '인사 안녕하세요');
  const caret = await field.evaluate((element) => {
    type View = { state: { selection: { main: { head: number } }; doc: { length: number } } };
    const { state } = (element as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view;
    return [state.selection.main.head, state.doc.length];
  });
  expect(caret[0]).toBe(caret[1]);
});
