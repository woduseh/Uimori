import { visualReview } from './fixtures/visual-review.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Content } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { navigationAction } from './ui-navigation.js';

async function seed(request: APIRequestContext, kind: Content['kind'], title: string) {
  const response = await request.post('/api/content', {
    data: {
      kind,
      title,
      description: '합성 자료',
      text: 'Synthetic only.',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Content>;
}

test('PLR02 every package category is editable from card and list controls', async ({
  page,
  request,
}) => {
  for (const [kind, label] of [
    ['bot', '봇'],
    ['persona', '페르소나'],
    ['module', '모듈'],
  ] as const) {
    const item = await seed(request, kind, `PLR 직접 편집 ${kind} ${crypto.randomUUID()}`);
    await page.goto('/');
    await navigationAction(page, label);
    const library = page.getByTestId('library-panel');
    await library.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(item.title);
    for (const view of ['카드', '목록']) {
      const options = library.locator('.library-list-options > summary');
      if (!(await options.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
        await options.click();
      await library.getByRole('button', { name: view, exact: true }).click();
      await options.click();
      const directEdit = library.getByRole('button', { name: `${item.title} 편집`, exact: true });
      if (await directEdit.isVisible()) await directEdit.click();
      else {
        const menu = library.getByLabel(`${item.title} 메뉴`, { exact: true });
        await menu.click();
        await menu.locator('..').getByRole('button', { name: '편집', exact: true }).click();
      }
      await expect(library.getByLabel('자료 이름', { exact: true })).toHaveValue(item.title);
      await expect(library.getByLabel('자료 본문', { exact: true })).toHaveValue('Synthetic only.');
      await library.getByRole('button', { name: '← 서재 목록', exact: true }).click();
    }
  }
});

test('PLR03 creation displays and saves role defaults and preview uses block names', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page
    .getByTestId('prompt-library')
    .getByRole('button', { name: '새 프롬프트', exact: true })
    .first()
    .click();
  const editor = page.getByTestId('prompt-editor');
  const composer = editor.getByTestId('prompt-composer');
  const selection = editor.getByLabel('불러올 프롬프트', { exact: true });
  await expect(selection.locator('option[value="builtin"], option[value="new"]')).toHaveCount(0);
  await expect(composer.getByRole('button', { name: '간단 편집', exact: true })).toHaveCount(0);
  for (const [role, text] of [
    ['main', DEFAULT_MAIN_PROMPT],
    ['translation', DEFAULT_TRANSLATION_PROMPT],
  ] as const) {
    await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption(role);
    const instructions = editor.locator('#prompt-block-instructions');
    if (!(await instructions.evaluate((node) => (node as HTMLDetailsElement).open)))
      await instructions.locator(':scope > summary').click();
    await expect(instructions.getByLabel('지침 본문', { exact: true })).toHaveValue(text);
    const title = `PLR 기본 ${role} ${crypto.randomUUID()}`;
    await editor.getByLabel('프롬프트 이름', { exact: true }).fill(title);
    const savedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/prompt-presets') && response.request().method() === 'POST'
    );
    await editor.getByRole('button', { name: '새 프롬프트 저장', exact: true }).click();
    const response = await savedResponse;
    expect(response.ok()).toBe(true);
    const saved = await response.json();
    const persisted = await request.get(
      `/api/revisions/prompt-preset/${saved.id}/${saved.revision}`
    );
    expect(persisted.ok()).toBe(true);
    expect((await persisted.json()).program).toEqual(createDefaultPromptProgram(text, role));
  }
  const fold = composer.getByLabel('전송 미리보기 접기/펼치기', { exact: true });
  const input = composer.getByLabel('미리보기 원문', { exact: true });
  await expect(input).not.toBeVisible();
  await fold.click();
  await input.fill('합성 미리보기 접기 입력 보존');
  await composer.getByRole('button', { name: '미리보기 갱신', exact: true }).click();
  await expect(composer.locator('.pc-preview-result')).toBeVisible();
  await composer.locator('summary').filter({ hasText: '블록별 조건과 포함 결과' }).click();
  const trace = composer.locator('.pc-preview-result table');
  await expect(trace).toContainText('지침');
  await expect(trace).not.toContainText('instructions');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-library-refinements-mobile.png') });
});
