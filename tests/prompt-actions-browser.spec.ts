import { selectChatSettingsSection } from './ui-navigation.js';
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

test('PAUI05 prompt hierarchy aligns disclosures and compact tools while folding preserves drafts', async ({
  page,
  request,
}, info) => {
  const preset = await seed(request);
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  const composer = editor.getByTestId('prompt-composer');
  const parent = composer.locator('.pc-composer-fold > summary');
  const block = composer.locator('#prompt-block-instructions');
  await block.locator(':scope > summary').click();
  const body = block.getByLabel('합성 지침 본문', { exact: true });
  const draft = 'SYNTHETIC_HIERARCHY_UNSAVED';
  await body.fill(draft);
  await parent.click();
  await expect(body).not.toBeVisible();
  await parent.click();
  await expect(body).toHaveValue(draft);
  await expect(editor.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
  const sections = composer.locator('.pc-section');
  for (let index = 0; index < (await sections.count()); index++) {
    const section = sections.nth(index);
    if ((await section.getAttribute('open')) !== null)
      await section.locator(':scope > summary').click();
  }
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await parent.scrollIntoViewIfNeeded();
    const children = composer.locator('.pc-section > summary').filter({ visible: true });
    expect(await children.count()).toBeGreaterThanOrEqual(4);
    const childBoxes = await children.evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return { x: box.x, height: box.height };
      })
    );
    expect(childBoxes.every((box) => box.height >= 44)).toBe(true);
    expect(childBoxes.every((box) => Math.abs(box.x - childBoxes[0].x) < 1)).toBe(true);
    const parentLabel = await parent.locator('strong').boundingBox();
    expect(parentLabel).not.toBeNull();
    const childIconPositions = await children
      .locator(':scope > .pc-disclosure-icon')
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().x));
    expect(childIconPositions.every((x) => Math.abs(x - parentLabel!.x) < 1)).toBe(true);
    const disclosureIcons = composer.locator('.pc-disclosure-icon').filter({ visible: true });
    expect(await disclosureIcons.count()).toBeGreaterThanOrEqual((await children.count()) + 1);
    const iconBoxes = await disclosureIcons.evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return { width: box.width, height: box.height };
      })
    );
    expect(
      iconBoxes.every((box) => Math.abs(box.width - 16) < 1 && Math.abs(box.height - 16) < 1)
    ).toBe(true);
    const tools = composer.locator('.pc-composer-tools');
    await expect(tools).toBeVisible();
    await expect(tools).toHaveCSS('position', 'absolute');
    const parentBox = await parent.boundingBox();
    const toolsBox = await tools.boundingBox();
    expect(parentBox).not.toBeNull();
    expect(toolsBox).not.toBeNull();
    expect(
      Math.abs(parentBox!.y + parentBox!.height / 2 - toolsBox!.y - toolsBox!.height / 2)
    ).toBeLessThanOrEqual(2);
    expect(toolsBox!.x).toBeGreaterThan(parentBox!.x + parentBox!.width / 2);
    if (width === 390) await expect(parent.locator('.pc-badge')).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    expect(
      await composer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`prompt-hierarchy-${width}.png`) });
  }
  await composer.getByLabel('프롬프트 블록 접기/펼치기', { exact: true }).click();
  await expect(body).toHaveValue(draft);
  const saved = (await (
    await request.get(`/api/prompt-presets/${preset.id}`)
  ).json()) as PromptPreset;
  expect(saved.program).toEqual(preset.program);
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
  const order = () => blocks.evaluateAll((items) => items.map((item) => item.id));
  const initial = ['prompt-block-instructions', 'prompt-block-example', 'prompt-block-history'];
  await expect.poll(order).toEqual(initial);
  const instruction = composer.locator('#prompt-block-instructions');
  const history = composer.locator('#prompt-block-history');
  const handle = instruction.getByRole('button', { name: '합성 지침 블록 드래그', exact: true });
  await expect(handle).toHaveAttribute('draggable', 'true');
  const historyBox = await history.boundingBox();
  expect(historyBox).not.toBeNull();
  await handle.dragTo(history, { targetPosition: { x: 30, y: historyBox!.height - 2 } });
  await expect
    .poll(order)
    .toEqual(['prompt-block-example', 'prompt-block-history', 'prompt-block-instructions']);
  // Existing explicit controls remain available alongside the drag handle.
  await instruction.locator(':scope > summary').click();
  await expect(
    instruction.getByRole('button', { name: '합성 지침 위로', exact: true })
  ).toBeEnabled();
  await expect(
    instruction.getByRole('button', { name: '합성 지침 아래로', exact: true })
  ).toBeDisabled();
  await instruction.locator(':scope > summary').click();
  await composer.getByRole('button', { name: '이전 편집으로', exact: true }).click();
  await expect.poll(order).toEqual(initial);
  await history
    .getByRole('button', { name: '합성 대화 블록 드래그', exact: true })
    .dragTo(instruction, {
      targetPosition: { x: 30, y: 2 },
    });
  const expected = ['prompt-block-history', 'prompt-block-instructions', 'prompt-block-example'];
  await expect.poll(order).toEqual(expected);
  const updatedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/prompt-presets/${preset.id}`) &&
      response.request().method() === 'PUT'
  );
  await editor.getByRole('button', { name: '저장', exact: true }).click();
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
  await instruction.locator(':scope > summary').click();
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
  const save = editor.getByRole('button', { name: '저장', exact: true });
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
  await page.getByRole('button', { name: '전역 프롬프트 설정', exact: true }).click();
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' });
  await editor.getByLabel('현재 프롬프트 프리셋', { exact: true }).selectOption(preset.id);
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.title)
    .toBe(preset.title);
  const name = editor.getByLabel('현재 프롬프트 이름', { exact: true });
  await name.fill(preset.title + ' 현재 수정');
  const snapshot = await (await request.get(`/api/prompt-presets/${preset.id}`)).json();
  const saveIcon = editor.getByRole('button', { name: '현재 설정 저장', exact: true });
  await expect(saveIcon.locator('svg')).toHaveCount(1);
  await expect(saveIcon).toHaveText('');
  await saveIcon.focus();
  await expect(editor.getByRole('tooltip')).toBeVisible();
  await editor.getByRole('button', { name: '현재 설정 저장', exact: true }).click();
  await expect(
    editor.getByText('현재 프롬프트와 옵션을 저장했어요.', { exact: true })
  ).toBeVisible();
  expect(await (await request.get(`/api/prompt-presets/${preset.id}`)).json()).toEqual(snapshot);
  expect((await detail(request, chat.id)).profile).toEqual(before.profile);
  await name.fill(preset.title + ' 별도 사본');
  await editor.getByLabel('현재 프롬프트 저장 메뉴', { exact: true }).click();
  await editor.getByRole('button', { name: '새 프리셋으로 저장', exact: true }).click();
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
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  const discard = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
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
  await expect(editor.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
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
