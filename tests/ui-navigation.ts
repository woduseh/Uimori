import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { PromptPreset, SavedPromptCombination } from '../core/product.js';
import type { PromptProgram } from '../core/prompt-program.js';

export async function visibleNavigation(page: Page) {
  let nav = page.getByTestId('bot-navigation').filter({ visible: true });
  if (!(await nav.count())) {
    await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    nav = page.getByTestId('bot-navigation').filter({ visible: true });
  }
  await expect(nav).toBeVisible();
  return nav;
}
export async function navigationAction(page: Page, name: string, botTitle?: string) {
  const dialog = page.getByRole('dialog').filter({ visible: true });
  if (await dialog.count()) await page.keyboard.press('Escape');
  const nav = await visibleNavigation(page);
  if (name === '새 채팅' || name === '새 이야기') {
    const back = nav.getByRole('button', { name: '봇 목록', exact: true });
    if (await back.count()) await back.click();
    const choice = botTitle
      ? nav.locator('.bot-choice').filter({ has: page.locator('strong', { hasText: botTitle }) })
      : nav.locator('.bot-choice').first();
    await expect(choice).toBeVisible();
    await choice.click();
    await nav.getByRole('button', { name: '새 채팅', exact: true }).click();
    return;
  }
  const libraryTab = ['봇', '페르소나', '모듈'].includes(name);
  await nav.getByRole('button', { name: libraryTab ? '서재' : name, exact: true }).click();
  if (libraryTab)
    await page.getByTestId('library-panel').getByRole('tab', { name, exact: true }).click();
}
export async function editLibraryContent(page: Page, title: string) {
  await page.getByRole('button', { name: `${title} 상세 보기`, exact: true }).click();
  await page
    .getByRole('region', { name: '자료 상세', exact: true })
    .getByRole('button', { name: '편집', exact: true })
    .first()
    .click();
  await revealLibraryEditor(page);
}
export async function revealLibraryEditor(page: Page) {
  const sections = page
    .getByTestId('library-panel')
    .locator('summary')
    .filter({
      hasText: /^(대표 이미지 · 선택|고급 패키지 설정|분류·읽기 설정)$/,
    });
  for (const section of await sections.all()) {
    if (!(await section.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
      await section.click();
  }
}
export async function selectContent(page: Page, label: string, title: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const picker = page.getByRole('dialog', { name: label, exact: true });
  const all = picker.getByRole('button', { name: '모든 자료', exact: true });
  if (await all.count()) await all.click();
  await picker.getByRole('searchbox', { name: `${label} 검색`, exact: true }).fill(title);
  await picker
    .locator('[data-content-choice]')
    .filter({ has: page.locator('strong').filter({ hasText: title }) })
    .first()
    .click();
}
export async function createPromptChoice(request: APIRequestContext, title: string) {
  const program: PromptProgram = {
    version: 1,
    controls: [
      { id: 'detail', label: '합성 상세도', type: 'number', default: 1, min: 0, max: 3 },
      { id: 'coNarration', label: '합성 공동 서술', type: 'boolean', default: false },
    ],
    blocks: [
      {
        id: 'instructions',
        title: '합성 지침',
        kind: 'message',
        role: 'system',
        template: [
          { kind: 'text', text: 'Synthetic detail ' },
          { kind: 'value', expression: { control: 'detail' } },
          { kind: 'text', text: '; shared narration ' },
          { kind: 'value', expression: { control: 'coNarration' } },
        ],
      },
      { id: 'history', title: '대화', kind: 'history', from: 0, to: 'end' },
    ],
  };
  const saved = await request.post('/api/prompt-presets', {
    data: { title: `${title} prompt`, role: 'main', text: '', program },
  });
  expect(saved.ok()).toBeTruthy();
  const prompt = (await saved.json()) as PromptPreset;
  const response = await request.post('/api/prompt-combinations', {
    data: {
      title: `${title} choices`,
      prompt: { id: prompt.id, revision: prompt.revision },
      values: { detail: 3, coNarration: true },
    },
  });
  expect(response.ok()).toBeTruthy();
  const combination = (await response.json()) as SavedPromptCombination;
  return { prompt, combination };
}
export async function selectStartPrompt(
  page: Page,
  choice: Awaited<ReturnType<typeof createPromptChoice>>
) {
  await openNewStoryOptions(page);
  await page
    .getByLabel('시작 프롬프트', { exact: true })
    .selectOption(`${choice.prompt.id}@${choice.prompt.revision}`);
  await page
    .getByLabel('시작 옵션 조합', { exact: true })
    .selectOption(`${choice.combination.id}@${choice.combination.revision}`);
}

export async function openNewStoryOptions(page: Page) {
  const options = page
    .getByRole('dialog', { name: '새 채팅', exact: true })
    .locator('.new-story-options');
  if (!(await options.evaluate((node) => (node as HTMLDetailsElement).open)))
    await options.locator('summary').click();
}
