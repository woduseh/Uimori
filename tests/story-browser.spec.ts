import { visualReview } from './fixtures/visual-review.js';
import { selectChatSettingsSection } from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import {
  test,
  expect,
  type Page,
  type APIRequestContext,
  type Locator,
} from './fixtures/browser-test.js';
import type { Chat } from '../core/types.js';
import type { StoryDetail } from '../core/story.js';

async function control(
  request: APIRequestContext,
  action: string,
  extra: Record<string, string> = {}
) {
  const response = await request.post('/api/test/control', { data: { action, ...extra } });
  expect(response.ok()).toBeTruthy();
}
async function story(request: APIRequestContext, chatId: string): Promise<StoryDetail> {
  const response = await request.get(`/api/chats/${chatId}/story`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function create(page: Page, title: string): Promise<Chat> {
  const response = await postFixtureChat(page.request, { data: { title } });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return chat;
}
async function panel(page: Page) {
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  if (!(await dialog.isVisible())) await openChatSettings(page);
  await selectChatSettingsSection(page, '기억과 메모');
  const section = dialog.getByRole('region', { name: '이야기 기억과 컨텍스트', exact: true });
  await expect(section).toBeVisible();
  return section;
}
async function open(section: Locator, title: RegExp) {
  const summary = section.locator('summary').filter({ hasText: title }).first();
  const parent = summary.locator('..');
  if ((await parent.getAttribute('open')) === null) await summary.click();
  return parent;
}

test.afterEach(async ({ request }) => {
  await control(request, 'release', { barrier: 'run' });
});

test('S04 explicit user note and correction remain separate from prose after reload', async ({
  page,
  request,
}, testInfo) => {
  const chat = await create(page, 'S04 합성 사용자 메모');
  const notes = await open(await panel(page), /^사용자 메모와 정정/);
  await notes.getByRole('button', { name: '메모 추가', exact: true }).click();
  await notes.getByLabel('메모와 정정 내용').fill('항구의 종은 파란색이다.');
  await notes.getByRole('button', { name: '새 메모 저장', exact: true }).click();
  await expect.poll(async () => (await story(request, chat.id)).notes.length).toBe(1);
  await notes
    .getByRole('button', { name: '메모 수정: 항구의 종은 파란색이다.', exact: true })
    .click();
  await notes.getByLabel('메모와 정정 내용').fill('항구의 종은 초록색이다.');
  await notes.getByRole('button', { name: '메모 수정 저장', exact: true }).click();
  await expect
    .poll(async () => (await story(request, chat.id)).notes.map((entry) => entry.text))
    .toEqual(['항구의 종은 초록색이다.']);
  await page.reload();
  const reloaded = await open(await panel(page), /^사용자 메모와 정정/);
  await expect(reloaded.getByText('항구의 종은 초록색이다.', { exact: true })).toBeVisible();
  await expect(reloaded.getByText('항구의 종은 파란색이다.', { exact: true })).toHaveCount(0);
  expect((await story(request, chat.id)).notes[0]).toMatchObject({
    kind: 'author-note',
    declaration: { author: '사용자' },
  });
  if (visualReview)
    await page.screenshot({
      path: testInfo.outputPath('S04-mobile-author-notes.png'),
      fullPage: true,
    });
});
