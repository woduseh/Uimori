import { setCurrentModels } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import type { PromptPreset } from '../core/product.js';
import { navigationAction, openPromptTools } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';

test('AGENTUI03 shared selections remain independent and binary switches fit and persist at 390 and 1440px', async ({
  page,
  request,
}, info) => {
  const program = createDefaultPromptProgram('Synthetic boolean controls.');
  const longLabel = '인물의 선택과 관계를 충분히 설명하는 긴 창작 옵션 이름';
  const description =
    '긴 설명이 여러 줄로 표시되어도 스위치와 겹치거나 화면 밖으로 밀려나지 않아요.';
  program.controls = [
    { id: 'inner', label: longLabel, description, type: 'boolean', default: false },
    { id: 'dialogue', label: '대화 중심 서술', type: 'boolean', default: false },
  ];
  const created = await request.post('/api/prompt-presets', {
    data: { title: `Boolean UI ${crypto.randomUUID()}`, role: 'main', program },
  });
  expect(created.ok()).toBe(true);
  const preset = (await created.json()) as PromptPreset;
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  const collaboration = editor.getByRole('region', { name: '에이전트 협업' });
  const enabled = collaboration.getByRole('switch', { name: '협업 사용', exact: true });
  const save = editor.getByRole('button', { name: /^(수정 )?저장$/ });
  await enabled.check();
  await collaboration.getByRole('button', { name: '인물 에이전트 추가', exact: true }).click();
  await enabled.uncheck();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await enabled.focus();
    await page.keyboard.press('Space');
    await expect(enabled).toBeChecked();
    const first = collaboration.getByRole('checkbox', { name: longLabel, exact: true });
    const second = collaboration.getByRole('checkbox', { name: '대화 중심 서술', exact: true });
    await first.uncheck();
    await second.uncheck();
    await first.focus();
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
    await expect(second).not.toBeChecked();
    await second.focus();
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
    await expect(second).toBeChecked();
    const value = editor.getByRole('switch', { name: longLabel, exact: true });
    await expect(value).not.toBeChecked();
    const field = value.locator(
      'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," prompt-option-field ")][1]'
    );
    await expect(field.getByRole('button', { name: /미설정/ })).toHaveCount(0);
    await expect(field.getByText(description, { exact: true })).toBeVisible();
    const textBox = await field.locator('.toggle-row-text').boundingBox();
    const valueBox = await value.boundingBox();
    expect(textBox).not.toBeNull();
    expect(valueBox).not.toBeNull();
    expect(textBox!.x + textBox!.width).toBeLessThanOrEqual(valueBox!.x);
    for (const control of [enabled, value]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBe(44);
      expect(box!.height).toBe(26);
    }
    for (const region of [field, collaboration, editor])
      expect(
        await region.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    await save.click();
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/prompt-presets/${preset.id}`)).json()).program
            .collaboration
      )
      .toMatchObject({ enabled: true, sharedControls: ['inner', 'dialogue'] });
    await enabled.scrollIntoViewIfNeeded();
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`boolean-controls-${width}.png`) });
    await enabled.focus();
    await page.keyboard.press('Space');
    await expect(enabled).not.toBeChecked();
    await save.click();
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/prompt-presets/${preset.id}`)).json()).program
            .collaboration.enabled
      )
      .toBe(false);
  }
  await page.reload();
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  await expect(enabled).not.toBeChecked();
});

test('AGENTUI01 collaboration stays editable through incomplete drafts, undo and JSON round trips at 390px', async ({
  page,
  request,
}, info) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const library = page.getByTestId('prompt-library');
  await library.getByRole('button', { name: '새 프롬프트', exact: true }).first().click();
  const editor = library.getByTestId('prompt-editor'),
    collaboration = editor.getByRole('region', { name: '에이전트 협업' });
  await editor
    .getByLabel('프롬프트 이름', { exact: true })
    .fill(`협업 합성 UI ${crypto.randomUUID()}`);
  const enabled = collaboration.getByRole('switch', { name: '협업 사용' });
  const save = editor.getByRole('button', { name: '저장', exact: true });
  await expect(enabled).not.toBeChecked();
  await enabled.check();
  await expect(save).toBeDisabled();
  await editor.locator('#prompt-block-instructions > summary').click();
  const body = editor.getByLabel('지침 본문', { exact: true });
  await body.fill('합성 본문: 인물의 선택을 따라 장면을 쓴다.');
  await expect(body).toHaveValue('합성 본문: 인물의 선택을 따라 장면을 쓴다.');
  await collaboration.getByRole('button', { name: '인물 에이전트 추가', exact: true }).click();
  await expect(editor.getByRole('button', { name: '이전 편집으로', exact: true })).toBeDisabled();
  await collaboration.getByLabel('1번째 에이전트 이름', { exact: true }).fill('인물 관찰자');
  await collaboration
    .getByLabel('1번째 에이전트 참여 시점', { exact: true })
    .selectOption('before');
  await collaboration
    .getByLabel('함께 따를 지침', { exact: true })
    .fill('각 인물이 실제로 알고 있는 정보만 고려한다.');
  await body.fill('합성 본문 수정');
  await editor.getByRole('button', { name: '이전 편집으로', exact: true }).click();
  await expect(body).toHaveValue('합성 본문: 인물의 선택을 따라 장면을 쓴다.');
  await expect(collaboration.getByLabel('1번째 에이전트 이름', { exact: true })).toHaveValue(
    '인물 관찰자'
  );
  await collaboration.getByLabel('1번째 에이전트 지침', { exact: true }).fill('');
  await expect(save).toBeDisabled();
  await collaboration
    .getByLabel('1번째 에이전트 지침', { exact: true })
    .fill('인물의 동기와 관계에서 가능한 선택지를 근거와 함께 제안한다.');
  await expect(save).toBeEnabled();
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/prompt-presets') && response.request().method() === 'POST'
  );
  await save.click();
  const response = await savedResponse;
  expect(response.ok(), await response.text()).toBe(true);
  const saved = (await response.json()) as PromptPreset;
  expect(saved.program.collaboration).toMatchObject({
    enabled: true,
    agents: [{ title: '인물 관찰자', trigger: 'before' }],
  });
  expect((await (await request.get(`/api/prompt-presets/${saved.id}`)).json()).program).toEqual(
    saved.program
  );
  const downloaded = page.waitForEvent('download');
  await openPromptTools(editor);
  await editor.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  const download = await downloaded;
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(saved.program);
  await collaboration.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await page.screenshot({ path: info.outputPath('agent-collaboration-mobile.png') });
  await collaboration
    .locator('.pc-composer-fold > summary')
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  if (visualReview)
    await page.screenshot({ path: info.outputPath('agent-collaboration-mobile-overview.png') });
  const sharedInstructions = collaboration.getByLabel('함께 따를 지침', { exact: true });
  const fold = collaboration.locator('.pc-composer-fold');
  await fold.locator(':scope > summary').click();
  await expect(enabled).toBeHidden();
  await fold.locator(':scope > summary').click();
  await expect(enabled).toBeChecked();
  await enabled.uncheck();
  await expect(sharedInstructions).toBeHidden();
  await expect(collaboration.getByLabel('1번째 에이전트 이름', { exact: true })).toBeHidden();
  await enabled.check();
  await expect(sharedInstructions).toHaveValue('각 인물이 실제로 알고 있는 정보만 고려한다.');
  await expect(collaboration.getByLabel('1번째 에이전트 이름', { exact: true })).toHaveValue(
    '인물 관찰자'
  );
  await enabled.uncheck();
  const updatedResponse = page.waitForResponse(
    (item) =>
      item.url().endsWith(`/api/prompt-presets/${saved.id}`) && item.request().method() === 'PUT'
  );
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  expect((await (await updatedResponse).json()).program.collaboration.enabled).toBe(false);
  await page.reload();
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${saved.title} 프롬프트 편집`, exact: true }).click();
  await expect(page.getByRole('switch', { name: '협업 사용' })).not.toBeChecked();
  await expect(page.getByLabel('1번째 에이전트 이름', { exact: true })).toBeHidden();
  await page.getByRole('switch', { name: '협업 사용' }).check();
  await expect(page.getByLabel('1번째 에이전트 이름', { exact: true })).toHaveValue('인물 관찰자');
  expect(pageErrors).toEqual([]);
});

test('AGENTUI02 saved collaboration options reach the real preview API and translation stays separate on desktop', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const program = createDefaultPromptProgram('Synthetic main instructions.');
  program.controls = [
    { id: 'perspective', label: '합성 시점', type: 'text', default: '가까운 시점' },
  ];
  const created = await request.post('/api/prompt-presets', {
    data: { title: `협업 옵션 ${crypto.randomUUID()}`, role: 'main', program },
  });
  expect(created.ok()).toBe(true);
  const preset = (await created.json()) as PromptPreset;
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor'),
    collaboration = editor.getByRole('region', { name: '에이전트 협업' });
  await collaboration.getByRole('switch', { name: '협업 사용' }).check();
  await collaboration
    .getByRole('button', { name: '설정과 기억 에이전트 추가', exact: true })
    .click();
  await collaboration.getByLabel('합성 시점', { exact: true }).check();
  await collaboration.getByLabel('전체 추가 호출 한도', { exact: true }).fill('4');
  const updated = page.waitForResponse(
    (item) =>
      item.url().endsWith(`/api/prompt-presets/${preset.id}`) && item.request().method() === 'PUT'
  );
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  const saved = (await (await updated).json()) as PromptPreset;
  expect(saved.program.collaboration).toMatchObject({
    maxCalls: 4,
    sharedControls: ['perspective'],
  });
  const connectionResponse = await request.post('/api/connections', {
    data: {
      title: 'No-call preview fixture',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/turn',
      enabled: true,
    },
  });
  expect(connectionResponse.ok()).toBe(true);
  const connection = await connectionResponse.json();
  const modelResponse = await request.post('/api/model-presets', {
    data: {
      title: 'Preview model',
      connectionId: connection.id,
      modelId: 'deterministic-fixture',
      maxOutputTokens: 1024,
      temperature: null,
    },
  });
  expect(modelResponse.ok()).toBe(true);
  const model = await modelResponse.json();
  const chat = await (
    await postFixtureChat(request, { data: { title: '협업 미리보기 합성 채팅' } })
  ).json();
  await setCurrentModels(request, { main: { id: model.id } });
  const workspace = await (await request.get('/api/prompt-workspace')).json();
  expect(
    (
      await request.put('/api/prompt-workspace', {
        data: {
          expectedRevision: workspace.revision,
          main: { title: saved.title, program: saved.program, values: { perspective: '먼 시점' } },
        },
      })
    ).ok()
  ).toBe(true);
  const preview = await request.post(`/api/chats/${chat.id}/prompt-preview`, {
    data: { request: '합성 장면을 이어 줘.' },
  });
  expect(preview.ok(), await preview.text()).toBe(true);
  const plan = JSON.stringify(await preview.json());
  expect(plan).toContain('agents.consult');
  expect(plan).toContain('먼 시점');
  const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(detail.runs).toHaveLength(0);
  expect(detail.attempts).toHaveLength(0);
  await collaboration.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await page.screenshot({ path: info.outputPath('agent-collaboration-desktop.png') });
  await collaboration
    .locator('.pc-composer-fold > summary')
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  if (visualReview)
    await page.screenshot({ path: info.outputPath('agent-collaboration-desktop-overview.png') });
  // Saved presets keep their role. Check translation on a new draft through the normal UI.
  await expect(editor.getByLabel('프롬프트 역할', { exact: true })).toBeDisabled();
  const library = page.getByTestId('prompt-library');
  await library.getByRole('button', { name: '← 프롬프트 목록', exact: true }).click();
  await library.getByRole('button', { name: '새 프롬프트', exact: true }).first().click();
  await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption('translation');
  await expect(editor.getByRole('region', { name: '에이전트 협업' })).toHaveCount(0);
});

preservePromptWorkspace();
