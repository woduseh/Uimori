import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { waitForNativeLayout } from './fixtures/native-message.js';
import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { navigationAction, openChatMenu, selectSettingsSection } from './ui-navigation.js';

test.setTimeout(90000);

const sourceText =
  '그녀는 문 앞에서 돌아섰다. “정말 **괜찮아**?” 나는 고개를 끄덕였다. ‘이번에는 기다리겠어.’\n\n' +
  '"함께 가자." 그는 \'약속을 지키자.\'고 생각했다. 「문이 열렸어.」 책에는 『별의 기록』이라고 적혀 있었다.\n\n' +
  '`“코드 안 인용”`과 [문서](https://example.com/reading)는 그대로 읽는다.' +
  '\n\n“첫째 줄”\n“둘째 줄”\n마지막 줄.' +
  '\n\n바닷바람은 서서히 잦아들고 등대의 불빛이 수면을 건넜다. 두 사람은 오늘의 선택을 서두르지 않았다.'.repeat(
    16
  );
const translatedText =
  '번역된 장면이다. “함께 걸어가자.” 그는 고개를 들었다. ‘아직 늦지 않았어.’\n\n' +
  '「도착했어.」 문 앞에 『여행의 끝』이 놓여 있었다.';

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext) {
  const response = await postFixtureChat(request, {
    data: { title: `읽기 설정 합성 ${randomUUID()}` },
  });
  expect(response.ok()).toBe(true);
  const chat = (await response.json()) as Chat;
  const before = await detail(request, chat.id);
  const generated = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '“본문 요청도 그대로” 보관할 합성 장면.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      expectedProfileRevision: before.profile!.revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(generated.ok(), await generated.text()).toBe(true);
  const run = (await generated.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  const source = (await detail(request, chat.id)).sources[0];
  const edited = await request.put(`/api/sources/${source.id}/text`, {
    data: { text: sourceText, expectedRevision: source.editRevision ?? 0 },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  const currentSource = (await detail(request, chat.id)).sources[0];
  const translated = await request.put(`/api/sources/${source.id}/translation`, {
    data: {
      text: translatedText,
      expectedRevision: currentSource.translationRevision ?? 0,
      expectedSourceHash: currentSource.hash,
    },
  });
  expect(translated.ok(), await translated.text()).toBe(true);
  return detail(request, chat.id);
}

async function readingDialog(page: Page, global = false) {
  if (global) {
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
  } else {
    const menu = await openChatMenu(page);
    await menu.getByRole('button', { name: '읽기 설정', exact: true }).click();
  }
  const dialog = page.getByRole('dialog', { name: global ? '설정' : '읽기 설정', exact: true });
  await expect(dialog.getByLabel('읽기 스타일', { exact: true })).toBeVisible();
  return dialog;
}

async function closeDialog(page: Page, dialog: Locator) {
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

function watch(page: Page) {
  const writes: string[] = [],
    errors: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    const readingPosition =
      request.method() === 'PUT' && /^\/api\/chats\/[^/]+\/reading-position$/u.test(path);
    if (path.startsWith('/api/') && request.method() !== 'GET' && !readingPosition)
      writes.push(`${request.method()} ${path}`);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return { writes, errors };
}

test('READUI01 reading settings change only how the scene is shown, persist across reload and write nothing', async ({
  page,
  request,
}) => {
  const before = await seed(request);
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('uimori:reading-language', 'original');
  });
  const observed = watch(page);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto(`/?chat=${before.chat.id}`);
  const source = page.getByTestId('source');
  await source.getByRole('button', { name: '원문 보기', exact: true }).click();
  const prose = source.getByTestId('source-text').locator('.risu-message-content');
  await expect(prose).toContainText('정말 괜찮아');
  const authored = prose.locator('.risu-chat-text');
  const textBefore = await authored.textContent();
  await waitForNativeLayout(source.getByTestId('source-text'));

  let settings = await readingDialog(page);
  await settings.getByLabel('읽기 스타일', { exact: true }).selectOption({ label: '여유롭게' });
  const slider = settings.getByRole('slider', { name: '본문 크기' });
  await slider.focus();
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('28');
  await closeDialog(page, settings);
  await expect(prose).toHaveCSS('font-size', '28px');
  expect(await authored.textContent()).toBe(textBefore);
  settings = await readingDialog(page);
  await settings.getByLabel('읽기 스타일', { exact: true }).selectOption('dialogue');
  await closeDialog(page, settings);
  expect(await authored.textContent()).toBe(textBefore);
  settings = await readingDialog(page);
  await settings.getByLabel('읽기 스타일', { exact: true }).selectOption('relaxed');
  await closeDialog(page, settings);

  await page.reload();
  settings = await readingDialog(page, true);
  await expect(settings.getByRole('slider', { name: '본문 크기' })).toHaveValue('28');
  await expect(settings.getByLabel('줄 간격', { exact: true })).toHaveValue('2.2');
  await closeDialog(page, settings);
  await expect(prose).toHaveCSS('font-size', '28px');
  await source.getByRole('button', { name: '번역 보기', exact: true }).click();
  const translated = source.getByTestId('translation-text').locator('.risu-message-content');
  await expect(translated).toContainText('번역된 장면이다.');
  await expect(translated).toHaveCSS('font-size', '28px');
  const after = await detail(request, before.chat.id);
  expect(after.sources).toEqual(before.sources);
  expect(after.jobs).toEqual(before.jobs);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.profile).toEqual(before.profile);
  expect(observed).toEqual({ writes: [], errors: [] });
});
