import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { selectChatSettingsSection, openPromptTools } from './ui-navigation.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureBotInput } from './fixtures/chat.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { PromptProgram } from '../core/prompt-program.js';

const botBody = 'Synthetic prompt editor owning bot reference.';

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function chat(request: APIRequestContext, title: string): Promise<Chat> {
  const owner = await request.post('/api/content', {
    data: fixtureBotInput(`${title} owner`, botBody),
  });
  expect(owner.ok(), await owner.text()).toBe(true);
  const response = await request.post('/api/chats', {
    data: { title, botId: (await owner.json()).id },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function generate(request: APIRequestContext, id: string) {
  const before = await detail(request, id);
  const response = await request.post(`/api/chats/${id}/runs`, {
    data: {
      request: 'Synthetic harbor scene.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      expectedProfileRevision: before.profile!.revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.ok()).toBe(true);
  const run = (await response.json()) as Run;
  await expect
    .poll(async () => (await detail(request, id)).runs.find((r) => r.id === run.id)?.status)
    .toBe('completed');
}
async function settings(page: Page, id: string) {
  await page.goto(`/?chat=${id}`);
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  return page.getByRole('dialog', { name: '채팅 설정', exact: true });
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  const dialog = page.getByRole('dialog').filter({ visible: true });
  if (await dialog.count())
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}
const program: PromptProgram = {
  version: 1,
  controls: [
    {
      id: 'tone',
      label: '합성 분위기',
      type: 'select',
      default: null,
      options: [
        { label: '차분하게', value: 'calm' },
        { label: '활기차게', value: 'bright' },
      ],
    },
  ],
  blocks: [
    {
      id: 'system',
      title: '합성 지침',
      kind: 'message',
      role: 'system',
      template: [
        { kind: 'text', text: 'SYNTHETIC TONE=' },
        { kind: 'value', expression: { control: 'tone' } },
      ],
    },
    {
      id: 'user',
      title: '합성 예시 질문',
      kind: 'message',
      role: 'user',
      template: [{ kind: 'text', text: 'Synthetic example question.' }],
    },
    {
      id: 'assistant',
      title: '합성 예시 응답',
      kind: 'message',
      role: 'assistant',
      template: [{ kind: 'text', text: 'Synthetic example response.' }],
      completion: 'complete',
    },
    { id: 'history', title: '합성 대화 범위', kind: 'history', from: 0, to: 'end' },
  ],
};

test('NUI01 native prompt import, draft preservation, roles, history and saved combinations', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const c = await chat(request, 'Synthetic native prompt UI');
  await generate(request, c.id);
  const before = await detail(request, c.id);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await settings(page, c.id);
  await selectChatSettingsSection(page, '프롬프트·창작 프리셋');
  await page.getByRole('button', { name: '전역 프롬프트 설정', exact: true }).click();
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' });
  await editor.getByLabel('현재 프롬프트 이름', { exact: true }).fill('Synthetic native composed');
  const composer = page.getByTestId('prompt-composer');
  await openPromptTools(composer);
  await composer.getByLabel('프롬프트 구성 JSON 불러오기', { exact: true }).setInputFiles({
    name: 'synthetic-native-pheme.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        program,
        suggestedCombination: { id: 'suggested', title: '합성 권장', values: { tone: 'bright' } },
      })
    ),
  });
  await expect(composer.locator('.pc-block')).toHaveCount(4);
  await expect(composer.getByLabel('합성 분위기', { exact: true })).toHaveValue('null');
  await composer.getByRole('button', { name: '가져온 권장 옵션 적용', exact: true }).click();
  await expect(composer.getByLabel('합성 분위기', { exact: true })).toHaveValue('"bright"');
  const jsonSection = composer
    .locator('.pc-section')
    .filter({ has: page.locator('summary', { hasText: '전체 구성 JSON · 고급 편집' }) });
  await jsonSection.locator('summary').first().click();
  const raw = composer.getByLabel('전체 프롬프트 구성 JSON', { exact: true });
  await raw.fill('{ malformed native JSON');
  await jsonSection.getByRole('button', { name: 'JSON 적용', exact: true }).click();
  await expect(raw).toHaveValue('{ malformed native JSON');
  await expect(composer.locator('.pc-block')).toHaveCount(4);
  await jsonSection.getByRole('button', { name: '적용된 값으로 되돌리기', exact: true }).click();
  await expect(raw).toHaveValue(JSON.stringify(program, null, 2));
  await jsonSection.locator('summary').first().click();
  await editor.getByRole('button', { name: '현재 설정 저장', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.title)
    .toBe('Synthetic native composed');
  await composer.getByLabel('합성 분위기', { exact: true }).selectOption('"calm"');
  await composer.getByLabel('새 조합 이름', { exact: true }).fill('차분한 장면');
  await composer.getByRole('button', { name: '옵션 조합 저장', exact: true }).click();
  await expect(composer.getByLabel('새 조합 이름', { exact: true })).toHaveValue('');
  await composer.getByLabel('합성 분위기', { exact: true }).selectOption('"bright"');
  await composer
    .getByLabel('이 프롬프트의 옵션 조합', { exact: true })
    .selectOption({ label: '차분한 장면' });
  await expect(composer.getByLabel('합성 분위기', { exact: true })).toHaveValue('"calm"');
  await editor.getByRole('button', { name: '현재 설정 저장', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.values)
    .toEqual({ tone: 'calm' });
  const after = await detail(request, c.id);
  expect(after.profile).toEqual(before.profile);
  expect(after.profile!.routes.main).toEqual(before.profile!.routes.main);
  await composer.getByLabel('전송 미리보기 접기/펼치기', { exact: true }).click();
  await composer.getByLabel('미리보기 현재 요청', { exact: true }).fill('Synthetic next turn.');
  await composer.getByRole('button', { name: '미리보기 갱신', exact: true }).click();
  // This authored program has no reference slots. Its owning package is delivered
  // through the shared background fallback before history without changing authored roles.
  const messages = composer.locator('.pc-message-list > li');
  await expect(messages).toHaveCount(8);
  const roles = await composer
    .locator('.pc-message-list > li > details > summary')
    .allTextContents();
  expect(roles.map((x) => x.match(/\. (system|user|assistant) /)?.[1])).toEqual([
    'system',
    'user',
    'assistant',
    'user',
    'user',
    'assistant',
    'user',
    'user',
  ]);
  await expect(messages.locator('summary small')).toHaveText([
    '1. 합성 지침 · prompt',
    '2. 합성 예시 질문 · prompt',
    '3. 합성 예시 응답 · prompt',
    '공통 배경 자료 · prompt',
    '4. 합성 대화 범위 · history',
    '4. 합성 대화 범위 · history',
    '추가 실행 문맥 · prompt',
    '4. 합성 대화 범위 · current',
  ]);
  await expect(messages.nth(3).locator('pre')).toContainText(botBody);
  await expect(messages.nth(4).locator('pre')).toHaveText('Synthetic harbor scene.');
  await expect(messages.nth(5).locator('pre')).toHaveText(before.sources[0].text);
  await expect(messages.nth(7).locator('pre')).toHaveText('Synthetic next turn.');
  await composer.locator('.pc-message-list > li').first().locator('summary').click();
  await expect(composer.locator('.pc-message-list pre').first()).toHaveText('SYNTHETIC TONE=calm');
  await fits(page);
  if (visualReview) await page.screenshot({ path: info.outputPath('native-composer-desktop.png') });
  const firstBlock = composer.locator('.pc-block').first();
  await firstBlock.locator('summary').first().click();
  await expect(firstBlock.getByRole('combobox', { name: '메시지 역할', exact: true })).toHaveValue(
    'system'
  );
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await firstBlock.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await fits(page);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`native-composer-block-${name}.png`) });
  }
  await firstBlock.locator('summary').first().click();
  const historyBlock = composer.locator('.pc-block').last();
  await historyBlock.locator('summary').first().click();
  await expect(historyBlock.getByLabel('시작 위치', { exact: true })).toHaveValue('0');
  await historyBlock.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await fits(page);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('native-composer-history-mobile.png') });
  await historyBlock.locator('summary').first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await composer.scrollIntoViewIfNeeded();
  await fits(page);
  if (visualReview) await page.screenshot({ path: info.outputPath('native-composer-mobile.png') });
  await page.reload();
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await selectChatSettingsSection(page, '프롬프트·창작 프리셋');
  await page.getByRole('button', { name: '전역 프롬프트 설정', exact: true }).click();
  await expect(
    page.getByTestId('prompt-composer').getByLabel('합성 분위기', { exact: true })
  ).toHaveValue('"calm"');
  const final = await detail(request, c.id);
  expect(final.runs).toEqual(before.runs);
  expect(final.attempts).toEqual(before.attempts);
  expect(errors).toEqual([]);
});

preservePromptWorkspace();
