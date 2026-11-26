import { visualReview } from './fixtures/visual-review.js';
import { test, expect } from '@playwright/test';
import type { PromptPreset } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import {
  editorChanges,
  navigationAction,
  expectEditorSection,
  selectEditorSection,
} from './ui-navigation.js';
import { isResourceSaveRequest, waitForResourceSave } from './fixtures/resource-save.js';
import { expectCodeFieldValue } from './code-field.js';

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
    await expectEditorSection(editor, '구성');
    await expect(name).toHaveCount(1);
    await expect(name).toBeInViewport({ ratio: 1 });
    await expect(name).toHaveAttribute('required', '');
    await expect(editor.getByRole('button', { name: '프롬프트 저장', exact: true })).toBeDisabled();
    if (visualReview && role === 'main')
      await page.screenshot({ path: info.outputPath('prompt-create-name-mobile.png') });
    await expect(selection.locator('option[value="builtin"], option[value="new"]')).toHaveCount(0);
    if (role === 'translation') {
      await selectEditorSection(editor, '기본 옵션');
      await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption(role);
      await selectEditorSection(editor, '구성');
    }
    await expectCodeFieldValue(native.getByLabel('1번 프롬프트 본문', { exact: true }), text);
    const title = `PLR 기본 ${role} ${crypto.randomUUID()}`;
    await name.fill(title);
    await expect(saveState).toHaveText('');
    await expect(editorChanges(editor)).toHaveAccessibleName('바뀐 영역 1곳');
    const savedResponse = page.waitForResponse(
      (response) =>
        /\/api\/resources\/save$/.test(response.url()) && response.request().method() === 'POST'
    );
    await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
    const response = await savedResponse;
    expect(response.ok()).toBe(true);
    const saved = (await response.json()).saved as PromptPreset;
    presets.push(saved);
    expect(saved.title).toBe(title);
    await expect(saveState).toBeEmpty();
    const persisted = await request.get(
      `/api/revisions/prompt-preset/${saved.id}/${saved.revision}`
    );
    expect(persisted.ok()).toBe(true);
    expect((await persisted.json()).program).toEqual(createDefaultRisuPrompt(text, role));
    if (role === 'main')
      await editor.getByRole('button', { name: '프롬프트 목록', exact: true }).click();
  }
  await selectEditorSection(editor, '정규식');
  await native.getByText('고급 JSON 편집', { exact: true }).click();
  const regex = native.getByLabel('Risu 정규식 JSON', { exact: true });
  const savedPreset = presets.at(-1)!;
  let saveRequests = 0;
  page.on('request', (request) => {
    if (isResourceSaveRequest(request)) saveRequests++;
  });
  await regex.fill('[{"unfinished":');
  await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
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
  await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
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
  await expect(editor.locator('.resource-editor-status').getByRole('status')).toBeEmpty();
  await selectEditorSection(editor, '정규식');
  await native.getByText('고급 JSON 편집', { exact: true }).click();
  await expect(regex).toHaveValue('[]');
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-library-refinements-mobile.png') });
});
