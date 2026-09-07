import { postFixtureChat } from './fixtures/chat.js';
import { test, expect } from '@playwright/test';
import type { PromptProgram } from '../core/prompt-program.js';

test('PRUI01 optional template draft safety and reusable prompt-owned combinations', async ({
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
    data: { title: 'Synthetic reusable prompt', role: 'main', text: '', program },
  });
  expect(savedResponse.ok()).toBe(true);
  const saved = await savedResponse.json();
  const foreignResponse = await request.post('/api/prompt-presets', {
    data: { title: 'Synthetic other prompt', role: 'main', text: '', program },
  });
  expect(foreignResponse.ok()).toBe(true);
  const foreign = await foreignResponse.json();
  for (const [prompt, title] of [
    [saved, 'Reusable detailed'],
    [foreign, 'Foreign combination'],
  ] as const) {
    const response = await request.post('/api/prompt-combinations', {
      data: { title, prompt: { id: prompt.id, revision: prompt.revision }, values: { detail: 3 } },
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
  await page.getByRole('tab', { name: '프롬프트·창작 프리셋', exact: true }).click();
  const editor = page.getByTestId('prompt-editor'),
    composer = page.getByTestId('prompt-composer');
  await editor
    .getByLabel('불러올 프롬프트', { exact: true })
    .selectOption(`${saved.id}@${saved.revision}`);
  const global = composer.getByLabel('전역 창작 조합', { exact: true });
  await expect(global.locator('option')).toHaveText(['직접 선택', 'Reusable detailed']);
  await global.selectOption({ label: 'Reusable detailed' });
  await expect(composer.getByLabel('합성 상세도', { exact: true })).toHaveValue('3');
  await composer.getByLabel('합성 상세도', { exact: true }).fill('2');
  await expect(composer.getByText('불러온 조합에서 수정됨', { exact: true })).toBeVisible();
  await composer.getByLabel('새 조합 이름', { exact: true }).fill('Reusable medium');
  await composer.getByRole('button', { name: '전역 창작 조합으로 저장', exact: true }).click();
  await expect(global.locator('option')).toHaveCount(3);
  await expect(global).toContainText('Reusable medium');
  await composer.getByRole('button', { name: '구성 편집', exact: true }).click();
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
    editor.getByRole('button', { name: '새 프롬프트로 저장', exact: true })
  ).toBeDisabled();
  await expect(editor.getByLabel('불러올 프롬프트', { exact: true })).toBeDisabled();
  await source.fill(
    '{% if options.detail >= 2 %}Detailed {{ options.detail }}{% else %}Brief{% endif %}'
  );
  await block.getByRole('button', { name: '문법 초안 적용', exact: true }).click();
  await expect(
    editor.getByRole('button', { name: '기존 프롬프트 수정 저장', exact: true })
  ).toBeEnabled();
  await editor.getByRole('button', { name: '기존 프롬프트 수정 저장', exact: true }).click();
  await expect(editor.getByLabel('불러올 프롬프트', { exact: true })).toHaveValue(`${saved.id}@2`);
  await expect(global.locator('option')).toHaveText(['직접 선택']);
  const response = await request.get(`/api/revisions/prompt-preset/${saved.id}/2`);
  expect(response.ok()).toBe(true);
  const revised = await response.json();
  expect(revised.program.blocks[0].template[0].kind).toBe('if');
  await expect(composer.getByLabel('합성 상세도', { exact: true })).toHaveValue('2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  await page.screenshot({ path: info.outputPath('prompt-redesign-mobile.png') });
  expect(errors).toEqual([]);
});
