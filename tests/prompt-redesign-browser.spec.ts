import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { selectChatSettingsSection } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect } from '@playwright/test';
import type { PromptProgram } from '../core/prompt-program.js';

test('PRUI01 optional template draft safety and reusable role-owned combinations', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const program: PromptProgram = {
    version: 1,
    controls: [{ id: 'detail', label: '합성 상세도', type: 'number', default: 1, min: 0, max: 3 }],
    blocks: [
      {
        id: 'instructions',
        title: '합성 지침',
        kind: 'message',
        role: 'system',
        template: [
          { kind: 'text', text: 'Synthetic ' },
          { kind: 'value', expression: { control: 'detail' } },
        ],
      },
      { id: 'history', title: '대화', kind: 'history', from: 0, to: 'end' },
    ],
  };
  const savedResponse = await request.post('/api/prompt-presets', {
    data: { title: 'Synthetic reusable prompt', role: 'main', program },
  });
  expect(savedResponse.ok()).toBe(true);
  const saved = await savedResponse.json();
  const workspace = await (await request.get('/api/prompt-workspace')).json();
  expect(
    (
      await request.post('/api/prompt-workspace/apply', {
        data: { expectedRevision: workspace.revision, role: 'main', presetId: saved.id },
      })
    ).ok()
  ).toBe(true);
  for (const title of ['Reusable detailed', 'Foreign combination']) {
    const response = await request.post('/api/prompt-combinations', {
      data: { title, role: 'main', values: { detail: 3 } },
    });
    expect(response.ok()).toBe(true);
  }
  const chatResponse = await postFixtureChat(request, {
    data: { title: 'Synthetic prompt redesign browser' },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await selectChatSettingsSection(page, '프롬프트·창작 프리셋');
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' }),
    composer = page.getByTestId('prompt-composer');
  const global = composer.getByLabel('전역 창작 조합', { exact: true });
  await expect(global.getByRole('option', { name: 'Reusable detailed', exact: true })).toHaveCount(
    1
  );
  await expect(
    global.getByRole('option', { name: 'Foreign combination', exact: true })
  ).toHaveCount(1);
  await global.selectOption({ label: 'Reusable detailed' });
  await expect(composer.getByLabel('합성 상세도', { exact: true })).toHaveValue('3');
  await composer.getByLabel('합성 상세도', { exact: true }).fill('2');
  await expect(composer.getByText('불러온 조합에서 수정됨', { exact: true })).toBeVisible();
  await composer.getByLabel('새 조합 이름', { exact: true }).fill('Reusable medium');
  await composer.getByRole('button', { name: '전역 창작 조합으로 저장', exact: true }).click();
  await expect(global).toContainText('Reusable medium');
  const block = composer.locator('.pc-block').first();
  await block.locator('summary').first().click();
  await block.getByRole('button', { name: '템플릿 문법으로 편집 · 시험', exact: true }).click();
  const source = block.getByLabel('합성 지침 본문 문법', { exact: true });
  await expect(source).toHaveValue('Synthetic {{ options.detail }}');
  await source.fill('Line\n{{ options.missing }}');
  await block.getByRole('button', { name: '문법 초안 적용', exact: true }).click();
  await expect(source).toHaveValue('Line\n{{ options.missing }}');
  await expect(block.getByRole('alert')).toContainText('PROMPT_UNKNOWN_CONTROL (2:4)');
  await expect(
    editor.getByRole('button', { name: '현재 내용을 새 프리셋으로 저장', exact: true })
  ).toBeDisabled();
  await expect(editor.getByLabel('현재 프롬프트 프리셋', { exact: true })).toBeDisabled();
  await source.fill(
    '{% if options.detail >= 2 %}Detailed {{ options.detail }}{% else %}Brief{% endif %}'
  );
  await block.getByRole('button', { name: '문법 초안 적용', exact: true }).click();
  await expect(editor.getByRole('button', { name: '현재 설정 저장', exact: true })).toBeEnabled();
  await editor.getByRole('button', { name: '현재 설정 저장', exact: true }).click();
  await expect(editor.getByRole('button', { name: '현재 설정 저장', exact: true })).toBeDisabled();
  await expect(global.getByRole('option', { name: 'Reusable detailed', exact: true })).toHaveCount(
    1
  );
  await expect(global.getByRole('option', { name: 'Reusable medium', exact: true })).toHaveCount(1);
  await expect(
    global.getByRole('option', { name: 'Foreign combination', exact: true })
  ).toHaveCount(1);
  const revised = (await (await request.get('/api/prompt-workspace')).json()).main;
  expect(revised.program.blocks[0].template[0].kind).toBe('if');
  await expect(composer.getByLabel('합성 상세도', { exact: true })).toHaveValue('2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview) await page.screenshot({ path: info.outputPath('prompt-redesign-mobile.png') });
  expect(errors).toEqual([]);
});

preservePromptWorkspace();
