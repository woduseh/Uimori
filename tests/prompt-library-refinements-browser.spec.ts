import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Content } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { navigationAction } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';

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

test('PLR01 persona picker excludes bots and modules while preserving no-persona selection', async ({
  page,
  request,
}) => {
  const stamp = crypto.randomUUID();
  const bot = await seed(request, 'bot', `PLR 봇 ${stamp}`);
  const persona = await seed(request, 'persona', `PLR 페르소나 ${stamp}`);
  const module = await seed(request, 'module', `PLR 모듈 ${stamp}`);
  await page.goto('/');
  await navigationAction(page, '봇');
  const library = page.getByTestId('library-panel');
  await library.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(bot.title);
  await library.getByRole('button', { name: `${bot.title} 새 채팅`, exact: true }).click();
  const newChat = page.getByRole('dialog', { name: '새 채팅', exact: true });
  const trigger = newChat.getByRole('button', { name: '시작 페르소나', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '시작 페르소나', exact: true });
  await picker.getByRole('searchbox').fill(stamp);
  await expect(picker.getByText(persona.title, { exact: true })).toBeVisible();
  await expect(picker.getByText(bot.title, { exact: true })).toHaveCount(0);
  await expect(picker.getByText(module.title, { exact: true })).toHaveCount(0);
  await expect(picker.getByRole('button', { name: '모든 자료', exact: true })).toHaveCount(0);
  await picker.locator('[data-content-choice]').filter({ hasText: persona.title }).click();
  await expect(trigger).toContainText(persona.title);
  await trigger.click();
  await picker.getByRole('button', { name: '페르소나 없음', exact: true }).click();
  await expect(trigger).toContainText('페르소나 없음');
});

test('PLR02 every package category has direct editing in card and list views', async ({
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
      await library.getByRole('button', { name: view, exact: true }).click();
      await library.getByRole('button', { name: `${item.title} 편집`, exact: true }).click();
      await expect(library.getByLabel('자료 이름', { exact: true })).toHaveValue(item.title);
      await expect(library.getByLabel('자료 본문', { exact: true })).toHaveValue('Synthetic only.');
      await library.getByRole('button', { name: '← 서재 목록', exact: true }).click();
    }
  }
});

test('PLR03 creation uses role defaults and folded preview preserves input and uses block names', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const created = await postFixtureChat(request, { data: { title: 'PLR 프롬프트 기본 생성' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await page.getByRole('tab', { name: '프롬프트·창작 프리셋', exact: true }).click();
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
    await editor.getByRole('button', { name: '새 프롬프트 생성', exact: true }).click();
    const title = `PLR 기본 ${role} ${crypto.randomUUID()}`;
    await editor.getByLabel('프롬프트 이름', { exact: true }).fill(title);
    const savedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/prompt-presets') && response.request().method() === 'POST'
    );
    await editor.getByRole('button', { name: '새 프롬프트로 저장', exact: true }).click();
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
  const input = composer.getByLabel('미리보기 현재 요청', { exact: true });
  await expect(input).not.toBeVisible();
  await fold.click();
  await input.fill('합성 미리보기 접기 입력 보존');
  await composer.getByRole('button', { name: '미리보기 갱신', exact: true }).click();
  await expect(composer.locator('.pc-preview-result')).toBeVisible();
  await composer.locator('summary').filter({ hasText: '블록별 조건과 포함 결과' }).click();
  const trace = composer.locator('.pc-preview-result table');
  await expect(trace).toContainText('지침');
  await expect(trace).not.toContainText('instructions');
  await fold.click();
  await expect(input).not.toBeVisible();
  await fold.click();
  await expect(input).toHaveValue('합성 미리보기 접기 입력 보존');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  await page.screenshot({ path: info.outputPath('prompt-library-refinements-mobile.png') });
});

test('PLR04 library new prompt starts with the app default instructions', async ({ page }) => {
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const library = page.getByTestId('prompt-library');
  await library.getByRole('button', { name: '새 프롬프트', exact: true }).first().click();
  const editor = library.getByTestId('prompt-editor');
  await editor.locator('#prompt-block-instructions > summary').click();
  await expect(editor.getByLabel('지침 본문', { exact: true })).toHaveValue(DEFAULT_MAIN_PROMPT);
  await expect(editor.getByRole('button', { name: '간단 편집', exact: true })).toHaveCount(0);
});
