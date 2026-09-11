import {
  selectChatSettingsSection,
  openPromptBlocks,
  selectPromptBlock,
  selectPromptSection,
} from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { PromptPreset } from '../core/product.js';
import type { PromptProgram } from '../core/prompt-program.js';
import type { ChatDetail } from '../core/types.js';
import { navigationAction, openPromptActions, openPromptTools } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';

const program = (): PromptProgram => ({
  version: 1,
  controls: [{ id: 'tone', label: '합성 문체', type: 'number', default: 1, min: 0, max: 3 }],
  blocks: [
    {
      id: 'instructions',
      title: '합성 지침',
      kind: 'message',
      role: 'system',
      template: [{ kind: 'text', text: 'SYNTHETIC_INSTRUCTIONS' }],
    },
    {
      id: 'example',
      title: '합성 예시',
      kind: 'message',
      role: 'user',
      template: [{ kind: 'text', text: 'SYNTHETIC_EXAMPLE' }],
    },
    { id: 'history', title: '합성 대화', kind: 'history', from: 0, to: 'end' },
  ],
});

test('PAUI05 prompt sections and responsive list detail preserve drafts without saving', async ({
  page,
  request,
}, info) => {
  const preset = await seed(request),
    observed = observe(page);
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  const composer = editor.getByTestId('prompt-composer');
  const block = composer.locator('#prompt-block-instructions');
  const save = editor.getByRole('button', { name: '프리셋 저장', exact: true });
  await expect(save).toBeDisabled();
  await selectPromptBlock(composer, '합성 지침');
  await expect(save).toBeDisabled();
  const body = block.getByLabel('합성 지침 본문', { exact: true });
  const draft = 'SYNTHETIC_HIERARCHY_UNSAVED';
  await body.fill(draft);
  await selectPromptSection(composer, '기본 옵션');
  await expect(body).not.toBeVisible();
  await selectPromptBlock(composer, '합성 지침');
  await expect(body).toHaveValue(draft);
  await expect(save).toBeEnabled();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await selectPromptBlock(composer, '합성 지침');
    const navigation = composer.getByRole('complementary', { name: '블록 목록', exact: true });
    if (width === 390) {
      await expect(
        composer.getByRole('combobox', { name: '프롬프트 편집 섹션', exact: true })
      ).toBeVisible();
      await expect(navigation).not.toBeVisible();
      await composer.getByRole('button', { name: '블록 목록', exact: true }).click();
      await expect(navigation).toBeVisible();
      await expect(body).not.toBeVisible();
      const choices = navigation.locator('.pc-item-links > button');
      expect(
        await choices.evaluateAll((items) =>
          items.every((item) => item.getBoundingClientRect().height >= 44)
        )
      ).toBe(true);
      await selectPromptBlock(composer, '합성 지침');
    } else {
      await expect(
        composer.getByRole('tablist', { name: '프롬프트 편집 섹션', exact: true })
      ).toBeVisible();
      await expect(navigation).toBeVisible();
      const box = await navigation.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.width - 224)).toBeLessThanOrEqual(1);
    }
    await expect(body).toHaveValue(draft);
    await expect(composer.getByLabel('프롬프트 구성 도구', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    expect(
      await composer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`prompt-hierarchy-${width}.png`) });
  }
  const saved = (await (
    await request.get(`/api/prompt-presets/${preset.id}`)
  ).json()) as PromptPreset;
  expect(saved.program).toEqual(preset.program);
  expect(observed.calls).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('PAUI04 desktop block drag preserves content, supports undo and persists both drop directions', async ({
  page,
  request,
}, info) => {
  const preset = await seed(request),
    observed = observe(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor'),
    composer = editor.getByTestId('prompt-composer');
  const blocks = composer.locator('.pc-block');
  await openPromptBlocks(composer);
  const order = () => blocks.evaluateAll((items) => items.map((item) => item.id));
  const initial = ['prompt-block-instructions', 'prompt-block-example', 'prompt-block-history'];
  await expect.poll(order).toEqual(initial);
  const instruction = composer.locator('#prompt-block-instructions');
  const navigation = composer.getByRole('complementary', { name: '블록 목록', exact: true });
  const handle = navigation.getByRole('button', { name: '합성 지침 블록 선택', exact: true });
  const historyChoice = navigation.getByRole('button', {
    name: '합성 대화 블록 선택',
    exact: true,
  });
  await expect(handle).toHaveAttribute('draggable', 'true');
  const historyBox = await historyChoice.boundingBox();
  expect(historyBox).not.toBeNull();
  await handle.dragTo(historyChoice, { targetPosition: { x: 30, y: historyBox!.height - 2 } });
  await expect
    .poll(order)
    .toEqual(['prompt-block-example', 'prompt-block-history', 'prompt-block-instructions']);
  // Existing explicit controls remain available alongside the drag handle.
  await selectPromptBlock(composer, '합성 지침');
  await expect(
    instruction.getByRole('button', { name: '합성 지침 위로', exact: true })
  ).toBeEnabled();
  await expect(
    instruction.getByRole('button', { name: '합성 지침 아래로', exact: true })
  ).toBeDisabled();
  await selectPromptBlock(composer, '합성 지침');
  await composer.getByRole('button', { name: '이전 편집으로', exact: true }).click();
  await expect.poll(order).toEqual(initial);
  await historyChoice.dragTo(handle, {
    targetPosition: { x: 30, y: 2 },
  });
  const expected = ['prompt-block-history', 'prompt-block-instructions', 'prompt-block-example'];
  await expect.poll(order).toEqual(expected);
  const updatedResponse = page.waitForResponse(
    (response) =>
      /\/api\/edit-drafts\/[^/]+\/save$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST'
  );
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  expect((await updatedResponse).ok()).toBe(true);
  const saved = (await (
    await request.get(`/api/prompt-presets/${preset.id}`)
  ).json()) as PromptPreset;
  expect(saved.program).toEqual({
    ...preset.program,
    blocks: [preset.program.blocks[2], preset.program.blocks[0], preset.program.blocks[1]],
  });
  if (visualReview) {
    await blocks.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('prompt-block-drag-desktop.png') });
  }
  await page.reload();
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  await expect.poll(order).toEqual(expected);
  await openPromptBlocks(composer);
  await selectPromptBlock(composer, '합성 지침');
  await expect(instruction.getByLabel('합성 지침 본문', { exact: true })).toHaveValue(
    'SYNTHETIC_INSTRUCTIONS'
  );
  expect(observed.calls).toEqual([]);
  expect(observed.errors).toEqual([]);
});
async function seed(request: APIRequestContext) {
  const response = await request.post('/api/prompt-presets', {
    data: { title: `PAUI 합성 ${crypto.randomUUID()}`, role: 'main', program: program() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<PromptPreset>;
}
async function detail(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<ChatDetail>;
}
function observe(page: Page) {
  const calls: string[] = [],
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(?:runs|translation|retranslate|test)$/.test(new URL(request.url()).pathname)
    )
      calls.push(request.url());
  });
  return { calls, errors };
}

test('PAUI01 editing updates the same prompt while copy and deletion stay in the named management menu', async ({
  page,
  request,
}) => {
  const preset = await seed(request),
    observed = observe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  const save = editor.getByRole('button', { name: '프리셋 저장', exact: true });
  await expect(save).toBeDisabled();
  await expect(
    editor.getByRole('button', { name: '복사본으로 저장', exact: true })
  ).not.toBeVisible();
  const title = preset.title + ' 수정';
  await editor.getByLabel('프롬프트 이름', { exact: true }).fill(title);
  const updatedResponse = page.waitForResponse(
    (response) =>
      /\/api\/edit-drafts\/[^/]+\/save$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST'
  );
  await save.click();
  const update = await updatedResponse;
  expect(update.ok()).toBe(true);
  const updateResult = await update.json();
  expect(updateResult.draft.revision).toBe(update.request().postDataJSON().expectedRevision + 1);
  const updated = updateResult.saved as PromptPreset;
  expect(updated).toMatchObject({ id: preset.id, revision: preset.revision + 1, title });
  await expect(save).toBeDisabled();
  const menu = editor.getByLabel('프롬프트 관리', { exact: true });
  await menu.focus();
  await page.keyboard.press('Enter');
  const copy = editor.getByRole('button', { name: '복사본으로 저장', exact: true });
  await expect(copy).toBeVisible();
  await copy.focus();
  await page.keyboard.press('Escape');
  await expect(copy).not.toBeVisible();
  await expect(menu).toBeFocused();
  await openPromptActions(editor);
  await editor.getByRole('button', { name: `${title} 프롬프트 삭제`, exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).not.toBeVisible();
  await expect(editor).toBeVisible();
  await openPromptActions(editor);
  const copiedResponse = page.waitForResponse(
    (response) =>
      /\/api\/edit-drafts\/[^/]+\/save$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST'
  );
  await copy.click();
  const response = await copiedResponse;
  expect(response.ok()).toBe(true);
  const copyResult = await response.json();
  expect(copyResult.created).toBe(true);
  const copied = copyResult.saved as PromptPreset;
  expect(copied.id).not.toBe(preset.id);
  expect(copied.program).toEqual(updated.program);
  expect((await (await request.get(`/api/prompt-presets/${preset.id}`)).json()).revision).toBe(
    updated.revision
  );
  expect(observed.calls).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('PAUI02 saving and applying retain distinct scopes with compact actions on desktop and mobile', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  await page.emulateMedia({ colorScheme: 'dark' });
  const preset = await seed(request),
    observed = observe(page);
  const response = await postFixtureChat(request, { data: { title: 'PAUI 합성 저장과 적용' } });
  expect(response.ok()).toBe(true);
  const chat = await response.json();
  const before = await detail(request, chat.id);
  await page.goto(`/?chat=${chat.id}`);
  await openChatSettings(page);
  await selectChatSettingsSection(page, '프롬프트·창작 프리셋');
  await page.getByRole('button', { name: '전역 프롬프트 설정', exact: true }).click();
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' });
  await editor.getByLabel('현재 프롬프트 프리셋', { exact: true }).selectOption(preset.id);
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.title)
    .toBe(preset.title);
  await expect(editor.getByLabel('현재 프롬프트 프리셋', { exact: true })).toHaveValue(preset.id);
  await expect(editor.getByLabel('현재 프롬프트 이름', { exact: true })).toHaveCount(0);
  await expect(editor.getByTestId('prompt-composer')).toHaveCount(0);
  await editor.locator('summary').filter({ hasText: '창작 옵션' }).click();
  const snapshot = await (await request.get(`/api/prompt-presets/${preset.id}`)).json();
  await editor.getByLabel('합성 문체', { exact: true }).fill('2');
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.values.tone)
    .toBe(2);
  expect(await (await request.get(`/api/prompt-presets/${preset.id}`)).json()).toEqual(snapshot);
  expect((await detail(request, chat.id)).profile).toEqual(before.profile);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await editor.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    if (visualReview)
      await page.screenshot({
        path: info.outputPath(`prompt-actions-${width === 390 ? 'mobile' : 'desktop'}.png`),
      });
  }
  if (visualReview) {
    await editor.locator('summary').filter({ hasText: '창작 옵션' }).click();
    await page
      .getByRole('heading', { name: '현재 프롬프트', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('prompt-settings-overview.png') });
  }
  await editor.getByRole('button', { name: '프롬프트 편집', exact: true }).click();
  await expect(
    page.getByTestId('prompt-editor').getByLabel('프롬프트 이름', { exact: true })
  ).toHaveValue(preset.title);
  await page.getByRole('button', { name: '프롬프트 목록', exact: true }).click();
  await page.getByRole('button', { name: '현재 프롬프트 설정', exact: true }).click();
  await editor.getByRole('button', { name: '프롬프트 편집', exact: true }).click();
  await expect(
    page.getByTestId('prompt-editor').getByLabel('프롬프트 이름', { exact: true })
  ).toHaveValue(preset.title);
  await expect(
    page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true })
  ).toHaveCount(0);
  expect((await detail(request, chat.id)).runs).toEqual(before.runs);
  expect(observed.calls).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('PAUI03 block tools preserve pending template drafts, focus and undo through move and delete', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const preset = await seed(request),
    observed = observe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor'),
    composer = editor.getByTestId('prompt-composer');
  const block = composer.locator('#prompt-block-instructions');
  await selectPromptBlock(composer, '합성 지침');
  await block.getByRole('button', { name: '템플릿 문법으로 편집 · 시험', exact: true }).click();
  const source = block.getByLabel('합성 지침 본문 문법', { exact: true });
  await source.fill('{{ options.missing }} 합성 미적용 문법');
  await block.getByRole('button', { name: '합성 지침 아래로', exact: true }).click();
  await expect(source).toHaveValue('{{ options.missing }} 합성 미적용 문법');
  await expect(composer.locator('.pc-block').nth(1)).toHaveAttribute(
    'id',
    'prompt-block-instructions'
  );
  await expect(block.getByRole('button', { name: '합성 지침 아래로', exact: true })).toBeFocused();
  await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
  await expect(composer.getByRole('button', { name: '이전 편집으로', exact: true })).toBeDisabled();
  await block.getByLabel('합성 지침 블록 메뉴', { exact: true }).click();
  await expect(block.getByRole('button', { name: '블록 삭제', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await block.getByRole('button', { name: '문법 초안 되돌리기', exact: true }).click();
  await composer.getByRole('button', { name: '이전 편집으로', exact: true }).click();
  await expect(composer.locator('.pc-block').first()).toHaveAttribute(
    'id',
    'prompt-block-instructions'
  );
  await expect(block.locator('.pc-block-heading')).toBeFocused();
  await source.fill('SYNTHETIC_UPDATED {{ options.tone }}');
  await block.getByRole('button', { name: '문법 초안 적용', exact: true }).click();
  await block.getByLabel('합성 지침 블록 메뉴', { exact: true }).click();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-block-tools-mobile.png') });
  await block.getByRole('button', { name: '블록 삭제', exact: true }).click();
  await expect(block).toHaveCount(0);
  await expect(composer.locator('#prompt-block-example > .pc-block-heading')).toBeFocused();
  await composer.getByRole('button', { name: '이전 편집으로', exact: true }).click();
  await expect(block).toHaveCount(1);
  await expect(block.locator('.pc-block-heading')).toBeFocused();
  await openPromptTools(editor);
  const downloadEvent = page.waitForEvent('download');
  await composer.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  const download = await downloadEvent;
  const envelope = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(envelope).toMatchObject({ title: preset.title, role: 'main' });
  const exported = envelope.program as PromptProgram;
  expect(exported.blocks.map((item) => item.id)).toEqual(['instructions', 'example', 'history']);
  expect(exported.blocks[0]).toMatchObject({
    template: [
      { kind: 'text', text: 'SYNTHETIC_UPDATED ' },
      { kind: 'value', expression: { control: 'tone' } },
    ],
  });
  await openPromptTools(editor);
  await composer.getByLabel('프롬프트 구성 JSON 불러오기', { exact: true }).setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{invalid'),
  });
  await expect(composer.getByRole('alert')).toBeVisible();
  await expect(composer.locator('.pc-block')).toHaveCount(3);
  const imported = program();
  imported.blocks[0].title = '합성 가져온 지침';
  await composer.getByLabel('프롬프트 구성 JSON 불러오기', { exact: true }).setInputFiles({
    name: 'synthetic.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(composer).toContainText('합성 가져온 지침');
  await expect(composer.locator('.pc-program-menu')).not.toHaveAttribute('open');
  await composer.getByRole('button', { name: '이전 편집으로', exact: true }).click();
  await expect(block.locator('.pc-block-heading')).toContainText('합성 지침');
  expect(observed.calls).toEqual([]);
  expect(observed.errors).toEqual([]);
});

preservePromptWorkspace();
