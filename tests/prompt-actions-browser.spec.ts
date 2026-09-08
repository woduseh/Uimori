import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { PromptPreset } from '../core/product.js';
import type { PromptProgram } from '../core/prompt-program.js';
import type { ChatDetail } from '../core/types.js';
import {
  navigationAction,
  openPromptActions,
  openPromptTools,
  selectChatSettingsSection,
} from './ui-navigation.js';
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
      /\/(?:runs|translation|retranslate|test|registrations)$/.test(new URL(request.url()).pathname)
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
  const save = editor.getByRole('button', { name: '수정 저장', exact: true });
  await expect(save).toBeDisabled();
  await expect(
    editor.getByRole('button', { name: '복사본으로 저장', exact: true })
  ).not.toBeVisible();
  const title = preset.title + ' 수정';
  await editor.getByLabel('프롬프트 이름', { exact: true }).fill(title);
  const updatedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/prompt-presets/${preset.id}`) &&
      response.request().method() === 'PUT'
  );
  await save.click();
  const update = await updatedResponse;
  expect(update.ok()).toBe(true);
  expect(update.request().postDataJSON().expectedRevision).toBe(preset.revision);
  const updated = (await update.json()) as PromptPreset;
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
      response.url().endsWith('/api/prompt-presets') && response.request().method() === 'POST'
  );
  await copy.click();
  const response = await copiedResponse;
  expect(response.ok()).toBe(true);
  const copied = (await response.json()) as PromptPreset;
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
  const preset = await seed(request),
    observed = observe(page);
  const response = await postFixtureChat(request, { data: { title: 'PAUI 합성 저장과 적용' } });
  expect(response.ok()).toBe(true);
  const chat = await response.json();
  const before = await detail(request, chat.id);
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await selectChatSettingsSection(page, '프롬프트·창작 프리셋');
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' });
  await editor.getByLabel('현재 프롬프트 프리셋', { exact: true }).selectOption(preset.id);
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.title)
    .toBe(preset.title);
  const name = editor.getByLabel('현재 프롬프트 이름', { exact: true });
  await name.fill(preset.title + ' 현재 수정');
  const snapshot = await (await request.get(`/api/prompt-presets/${preset.id}`)).json();
  await editor.getByRole('button', { name: '현재 설정 저장', exact: true }).click();
  await expect(
    editor.getByText('현재 프롬프트와 옵션을 저장했어요.', { exact: true })
  ).toBeVisible();
  expect(await (await request.get(`/api/prompt-presets/${preset.id}`)).json()).toEqual(snapshot);
  expect((await detail(request, chat.id)).profile).toEqual(before.profile);
  await name.fill(preset.title + ' 별도 사본');
  await editor.getByRole('button', { name: '현재 내용을 새 프리셋으로 저장', exact: true }).click();
  await expect(editor.getByText('독립된 프리셋으로 저장했어요.', { exact: true })).toBeVisible();
  expect((await (await request.get('/api/prompt-workspace')).json()).main.title).toBe(
    preset.title + ' 현재 수정'
  );
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await editor
      .getByRole('button', { name: '현재 설정 저장', exact: true })
      .scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    if (visualReview)
      await page.screenshot({
        path: info.outputPath(`prompt-actions-${width === 390 ? 'mobile' : 'desktop'}.png`),
      });
  }
  await page.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  const discard = page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(name).toHaveValue(preset.title + ' 별도 사본');
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
  await block.locator(':scope > summary').click();
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
  await expect(editor.getByRole('button', { name: '수정 저장', exact: true })).toBeDisabled();
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
  await expect(block.locator(':scope > summary')).toBeFocused();
  await source.fill('SYNTHETIC_UPDATED {{ options.tone }}');
  await block.getByRole('button', { name: '문법 초안 적용', exact: true }).click();
  await block.getByLabel('합성 지침 블록 메뉴', { exact: true }).click();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-block-tools-mobile.png') });
  await block.getByRole('button', { name: '블록 삭제', exact: true }).click();
  await expect(block).toHaveCount(0);
  await expect(composer.locator('#prompt-block-example > summary')).toBeFocused();
  await composer.getByRole('button', { name: '이전 편집으로', exact: true }).click();
  await expect(block).toHaveCount(1);
  await expect(block.locator(':scope > summary')).toBeFocused();
  await openPromptTools(editor);
  const downloadEvent = page.waitForEvent('download');
  await composer.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  const download = await downloadEvent;
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as PromptProgram;
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
  await composer.getByRole('button', { name: '이전 편집으로', exact: true }).click();
  await expect(block.locator(':scope > summary')).toContainText('합성 지침');
  expect(observed.calls).toEqual([]);
  expect(observed.errors).toEqual([]);
});

preservePromptWorkspace();
