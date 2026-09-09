import { test, expect } from '@playwright/test';
import { isolatePromptDrafts } from './fixtures/prompt-workspace.js';
import { navigationAction } from './ui-navigation.js';
import type { PromptProgram } from '../core/prompt-program.js';

isolatePromptDrafts();

test('PERR01 preview errors stay local, can be dismissed and clear after recovery', async ({
  page,
  request,
}) => {
  const program: PromptProgram = {
    version: 1,
    controls: [],
    blocks: [{ id: 'current', title: '현재 입력', kind: 'current' }],
  };
  const response = await request.post('/api/prompt-presets', {
    data: { title: `오류 복구 합성 ${crypto.randomUUID()}`, role: 'main', program },
  });
  expect(response.ok()).toBe(true);
  const preset = await response.json();
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const openEditor = async () => {
    await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  };
  await openEditor();
  const composer = page.getByTestId('prompt-composer');
  const previewFold = composer.getByLabel('전송 미리보기 접기/펼치기');
  const refresh = composer.getByRole('button', { name: '미리보기 갱신', exact: true });
  const error = composer.getByRole('alert');
  await previewFold.click();
  await refresh.click();
  await expect(error).toContainText('대화 이력 일부가 프롬프트에 포함되지 않았어요.');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await error.getByRole('button', { name: '오류 메시지 닫기' }).click();
  await expect(error).toHaveCount(0);
  // Dismissing a notice must not weaken the compiler invariant.
  await refresh.click();
  await expect(error).toContainText('PROMPT_HISTORY_OMITTED');
  await navigationAction(page, '서재');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await navigationAction(page, '프롬프트');
  await openEditor();
  await expect(error).toHaveCount(0);
  await previewFold.click();
  await refresh.click();
  await expect(error).toContainText('PROMPT_HISTORY_OMITTED');
  await composer.getByText('전체 구성 JSON · 고급 편집', { exact: true }).click();
  const corrected: PromptProgram = {
    ...program,
    blocks: [{ id: 'history', title: '대화', kind: 'history', from: 0, to: 'end' }],
  };
  await composer
    .getByLabel('전체 프롬프트 구성 JSON', { exact: true })
    .fill(JSON.stringify(corrected));
  await composer.getByRole('button', { name: 'JSON 적용', exact: true }).click();
  await refresh.click();
  await expect(composer.locator('.pc-preview-result')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Preview and notice dismissal do not save the edited draft.
  expect((await (await request.get(`/api/prompt-presets/${preset.id}`)).json()).program).toEqual(
    program
  );
});

test('PERR02 global notices can be dismissed and do not follow navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('library-panel')).toBeVisible();
  await page.route('**/api/library?view=summary', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'SYNTHETIC_FAILURE' }),
    })
  );
  const failRefresh = async () => {
    await page.evaluate(() =>
      window.dispatchEvent(new StorageEvent('storage', { key: 'uimori:library-change' }))
    );
    await expect(page.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요.');
  };
  await failRefresh();
  await page.getByRole('button', { name: '오류 메시지 닫기' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await failRefresh();
  await page.unroute('**/api/library?view=summary');
  await navigationAction(page, '프롬프트');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
