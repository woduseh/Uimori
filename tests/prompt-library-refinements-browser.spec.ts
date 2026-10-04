import { visualReview } from './fixtures/visual-review.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Content, PromptPreset } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { navigationAction } from './ui-navigation.js';
import { isResourceSaveRequest, waitForResourceSave } from './fixtures/resource-save.js';

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
      await expect(library.getByLabel('Risu 자료 이름', { exact: true })).toHaveValue(item.title);
      await expect(library.getByLabel('캐릭터 설정', { exact: true })).toHaveValue(
        'Synthetic only.'
      );
      await library.getByRole('button', { name: '서재 목록', exact: true }).click();
    }
  }
});

test('PLR03 native prompt creation saves role defaults and preserves invalid regex drafts', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const editor = page.getByTestId('prompt-editor');
  const native = editor.getByRole('region', { name: 'Risu 프롬프트 원본 편집' });
  const selection = editor.getByLabel('불러올 프롬프트', { exact: true });
  const presets: PromptPreset[] = [];
  for (const [role, text] of [
    ['main', DEFAULT_MAIN_PROMPT],
    ['translation', DEFAULT_TRANSLATION_PROMPT],
  ] as const) {
    await page
      .getByTestId('prompt-library')
      .getByRole('button', { name: '새 프롬프트', exact: true })
      .first()
      .click();
    const saveState = editor.locator('.resource-editor-status').getByRole('status');
    const name = editor.getByLabel('프롬프트 이름', { exact: true });
    await expect(saveState).toHaveText('등록 전');
    await expect(native.getByRole('tab', { name: '구성', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(name).toHaveCount(1);
    await expect(name).toBeInViewport({ ratio: 1 });
    await expect(name).toHaveAttribute('required', '');
    await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
    if (visualReview && role === 'main')
      await page.screenshot({ path: info.outputPath('prompt-create-name-mobile.png') });
    await expect(selection.locator('option[value="builtin"], option[value="new"]')).toHaveCount(0);
    if (role === 'translation') {
      await native.getByRole('tab', { name: '기본 옵션', exact: true }).click();
      await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption(role);
      await native.getByRole('tab', { name: '구성', exact: true }).click();
    }
    await expect(native.getByLabel('1번 프롬프트 본문', { exact: true })).toHaveValue(text);
    const title = `PLR 기본 ${role} ${crypto.randomUUID()}`;
    await name.fill(title);
    await expect(saveState).toHaveText('미저장 변경');
    const savedResponse = page.waitForResponse(
      (response) =>
        /\/api\/resources\/save$/.test(response.url()) && response.request().method() === 'POST'
    );
    await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
    const response = await savedResponse;
    expect(response.ok()).toBe(true);
    const saved = (await response.json()).saved as PromptPreset;
    presets.push(saved);
    expect(saved.title).toBe(title);
    await expect(saveState).toHaveText('저장됨');
    const persisted = await request.get(
      `/api/revisions/prompt-preset/${saved.id}/${saved.revision}`
    );
    expect(persisted.ok()).toBe(true);
    expect((await persisted.json()).program).toEqual(createDefaultRisuPrompt(text, role));
    if (role === 'main')
      await editor.getByRole('button', { name: '프롬프트 목록', exact: true }).click();
  }
  await native.getByRole('tab', { name: '정규식', exact: true }).click();
  await native.getByText('고급 JSON 편집', { exact: true }).click();
  const regex = native.getByLabel('Risu 정규식 JSON', { exact: true });
  const savedPreset = presets.at(-1)!;
  let saveRequests = 0;
  page.on('request', (request) => {
    if (isResourceSaveRequest(request)) saveRequests++;
  });
  await regex.fill('[{"unfinished":');
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  await expect(editor.getByRole('alert').filter({ hasText: /JSON/ })).toBeVisible();
  await expect(regex).toHaveValue('[{"unfinished":');
  const unchanged = await request.get(`/api/prompt-presets/${savedPreset.id}`);
  expect(unchanged.ok()).toBe(true);
  expect(await unchanged.json()).toMatchObject({
    revision: savedPreset.revision,
    program: savedPreset.program,
  });
  expect(saveRequests).toBe(0);
  await regex.fill('[]');
  const restoredTitle = `${savedPreset.title} 복구`;
  await editor.getByLabel('프롬프트 이름', { exact: true }).fill(restoredTitle);
  const restoredResponse = waitForResourceSave(page, 'prompt-preset', savedPreset.id);
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  const restored = (await restoredResponse).saved as PromptPreset;
  expect(restored.revision).toBe(savedPreset.revision + 1);
  expect(restored.program).toEqual(savedPreset.program);
  expect(saveRequests).toBe(1);
  await expect(editor.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await navigationAction(page, '프롬프트');
  await page.getByLabel('프롬프트 검색', { exact: true }).fill(restoredTitle);
  await page.getByRole('button', { name: `${restoredTitle} 프롬프트 편집`, exact: true }).click();
  await expect(editor.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(restoredTitle);
  await expect(editor.locator('.resource-editor-status').getByRole('status')).toHaveText('저장됨');
  await native.getByRole('tab', { name: '정규식', exact: true }).click();
  await native.getByText('고급 JSON 편집', { exact: true }).click();
  await expect(regex).toHaveValue('[]');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-library-refinements-mobile.png') });
});
