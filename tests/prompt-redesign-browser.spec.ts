import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { selectChatSettingsSection, selectPromptBlock, navigationAction } from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect } from '@playwright/test';
import type { PromptProgram } from '../core/prompt-program.js';

test('PRUI01 template drafts retain same-owner combinations and reject identical controls from another preset', async ({
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
  const foreignResponse = await request.post('/api/prompt-presets', {
    data: { title: 'Different prompt with identical controls', role: 'main', program },
  });
  expect(foreignResponse.ok()).toBe(true);
  const foreign = await foreignResponse.json();
  let foreignCombinationId = '';
  for (const [title, owner] of [
    ['Reusable detailed', saved],
    ['Foreign combination', foreign],
  ] as const) {
    const response = await request.post('/api/prompt-combinations', {
      data: {
        title,
        role: 'main',
        values: { detail: 3 },
        owner: { kind: 'preset', id: owner.id },
        expectedRevision: owner.revision,
      },
    });
    expect(response.ok()).toBe(true);
    if (owner.id === foreign.id) foreignCombinationId = (await response.json()).id;
  }
  const beforeForeign = await (await request.get('/api/prompt-workspace')).json();
  const denied = await request.post('/api/prompt-workspace/apply-options', {
    data: {
      expectedRevision: beforeForeign.revision,
      role: 'main',
      combinationId: foreignCombinationId,
    },
  });
  expect(denied.status()).toBe(409);
  expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(beforeForeign);
  const chatResponse = await postFixtureChat(request, {
    data: { title: 'Synthetic prompt redesign browser' },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?chat=${chat.id}`);
  await openChatSettings(page);
  await selectChatSettingsSection(page, '프롬프트·창작 프리셋');
  await page.getByRole('button', { name: '전역 프롬프트 설정', exact: true }).click();
  const settings = page.getByRole('region', { name: '현재 프롬프트 설정' });
  await settings.locator('summary').filter({ hasText: '창작 옵션' }).click();
  const global = settings.getByLabel('옵션 조합', { exact: true });
  await expect(global.getByRole('option', { name: 'Reusable detailed', exact: true })).toHaveCount(
    1
  );
  await expect(
    global.getByRole('option', { name: 'Foreign combination', exact: true })
  ).toHaveCount(0);
  await global.selectOption({ label: 'Reusable detailed' });
  await expect(settings.getByLabel('합성 상세도', { exact: true })).toHaveValue('3');
  await expect
    .poll(
      async () => (await (await request.get('/api/prompt-workspace')).json()).main.values.detail
    )
    .toBe(3);
  await settings.getByLabel('합성 상세도', { exact: true }).fill('2');
  await expect
    .poll(
      async () => (await (await request.get('/api/prompt-workspace')).json()).main.values.detail
    )
    .toBe(2);
  await expect(global.locator('option:checked')).toHaveText('사용자 설정');
  await settings.getByLabel('옵션 조합 메뉴', { exact: true }).click();
  await settings.getByRole('button', { name: '현재 선택을 새 조합으로 저장', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '옵션 조합 저장', exact: true });
  await dialog.getByLabel('조합 이름', { exact: true }).fill('Reusable medium');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(global).toContainText('Reusable medium');
  await global.selectOption({ label: 'Reusable detailed' });
  await expect(settings.getByLabel('합성 상세도', { exact: true })).toHaveValue('3');
  await expect
    .poll(
      async () => (await (await request.get('/api/prompt-workspace')).json()).main.values.detail
    )
    .toBe(3);
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${saved.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  const composer = editor.getByTestId('prompt-composer');
  const block = composer.locator('.pc-block').first();
  await selectPromptBlock(composer, '합성 지침');
  await block.getByRole('button', { name: '템플릿 문법으로 편집 · 시험', exact: true }).click();
  const source = block.getByLabel('합성 지침 본문 문법', { exact: true });
  await expect(source).toHaveValue('Synthetic {{ options.detail }}');
  await source.fill('Line\n{{ options.missing }}');
  await block.getByRole('button', { name: '문법 초안 적용', exact: true }).click();
  await expect(source).toHaveValue('Line\n{{ options.missing }}');
  await expect(block.getByRole('alert')).toContainText('PROMPT_UNKNOWN_CONTROL (2:4)');
  await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
  await source.fill(
    '{% if options.detail >= 2 %}Detailed {{ options.detail }}{% else %}Brief{% endif %}'
  );
  await block.getByRole('button', { name: '문법 초안 적용', exact: true }).click();
  await expect(block.getByRole('alert')).toHaveCount(0);
  const beforeSave = await (await request.get(`/api/prompt-presets/${saved.id}`)).json();
  const savePath = /\/api\/edit-drafts\/[^/]+\/save$/u;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saveStarted = false;
  await page.route(savePath, async (route) => {
    saveStarted = true;
    await saveGate;
    await route.continue();
  });
  const saveResponse = page.waitForResponse(
    (response) => savePath.test(response.url()) && response.request().method() === 'POST'
  );
  try {
    await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
    await expect.poll(() => saveStarted).toBe(true);
    // Busy disables the fieldset before persistence; disabled alone is not a save receipt.
    await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
    expect(await (await request.get(`/api/prompt-presets/${saved.id}`)).json()).toEqual(beforeSave);
  } finally {
    releaseSave();
  }
  const response = await saveResponse;
  expect(response.ok()).toBe(true);
  const accepted = (await response.json()).saved;
  await page.unroute(savePath);
  await expect(
    editor.getByRole('status').filter({ hasText: '프롬프트를 저장했어요.' })
  ).toBeVisible();
  await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
  const revised = await (await request.get(`/api/prompt-presets/${saved.id}`)).json();
  expect(revised).toEqual(accepted);
  expect(revised.revision).toBeGreaterThan(beforeSave.revision);
  expect(revised.program.blocks[0].template).toEqual([
    {
      kind: 'if',
      condition: { op: 'greaterEqual', args: [{ control: 'detail' }, 2] },
      then: [
        { kind: 'text', text: 'Detailed ' },
        { kind: 'value', expression: { control: 'detail' } },
      ],
      else: [{ kind: 'text', text: 'Brief' }],
    },
  ]);
  const current = (await (await request.get('/api/prompt-workspace')).json()).main;
  expect(current.program).toEqual(program);
  expect(current.values.detail).toBe(3);
  await page.reload();
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${saved.title} 프롬프트 편집`, exact: true }).click();
  await selectPromptBlock(composer, '합성 지침');
  await block.getByRole('button', { name: '템플릿 문법으로 편집 · 시험', exact: true }).click();
  await expect(source).toHaveValue(
    '{% if greaterEqual(options.detail, 2) %}Detailed {{ options.detail }}{% else %}Brief{% endif %}'
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview) await page.screenshot({ path: info.outputPath('prompt-redesign-mobile.png') });
  expect(errors).toEqual([]);
});

preservePromptWorkspace();
