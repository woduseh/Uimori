import { expect, test } from './fixtures/browser-test.js';
import { postFixtureChat } from './fixtures/chat.js';
import { visualReview } from './fixtures/visual-review.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';
import type { ThemeCatalog } from '../core/themes.js';
import type { ChatDetail, Run } from '../core/types.js';

test('creator previews, saves and applies a bot Story UI theme without changing the app theme', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, { data: { title: 'Observatory Story UI' } });
  const chat = await created.json();
  const configured = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...chat.settings,
      storyUi: true,
      autoTranslate: false,
      expectedSettingsRevision: chat.settingsRevision,
    },
  });
  expect(configured.ok()).toBe(true);
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request:
        '<a2ui>root = Column([Text("별의 관측 기록"), TextField("관측 메모", $/note), Button(Text("기록 전달"), action=Event("send", {note: $/note}))])</a2ui>',
      expectedRevision: null,
      expectedSettingsRevision: (await configured.json()).settingsRevision,
      idempotencyKey: `observatory-${chat.id}`,
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const run = (await started.json()) as Run;
  const read = async () =>
    (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  await expect
    .poll(async () => (await read()).runs.find((item) => item.id === run.id)?.status)
    .toBe('completed');
  await page.addInitScript(() => localStorage.setItem('uimori:reading-language', 'original'));
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.locator('.story-ui').getByText('별의 관측 기록')).toBeVisible();
  const before = (await (await request.get('/api/themes')).json()) as ThemeCatalog;
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마와 색상');
  await page.getByLabel('테마 적용 범위', { exact: true }).selectOption('bot');
  await page.getByRole('button', { name: '이야기 UI 테마 만들기', exact: true }).click();
  const editor = page.locator('.theme-editor');
  const title = `별빛 관측소 ${chat.id}`;
  await editor.getByLabel('테마 이름', { exact: true }).fill(title);
  await editor.getByLabel('기본 스타일', { exact: true }).selectOption('modern');
  await editor
    .getByLabel('이야기 UI CSS', { exact: false })
    .fill(
      '& { --story-paper: #efe5fb; --story-ink: #35234b; } button { --a2ui-text-color-text: #46206b; color: #46206b; background: #d6b7ed; } body { background: red; }'
    );
  await expect(editor.locator('.story-ui')).toHaveCSS('background-color', 'rgb(239, 229, 251)');
  await editor
    .getByLabel('현황 패널 CSS', { exact: true })
    .fill(
      '& { --board-paper: #202228; } .story-ui { outline: 5px solid rgb(255, 0, 0); } & > .story-board-slots::after { content: ""; position: fixed; inset: 0; background: rgb(255, 0, 0); }'
    );
  const boardPreview = editor.locator('.story-board-preview');
  await expect(boardPreview).toHaveCSS('background-color', 'rgb(32, 34, 40)');
  await expect(boardPreview.locator('.story-board-slots > button')).toHaveCount(2);
  await expect(boardPreview.locator('.story-ui')).toHaveCSS('outline-style', 'none');
  const heading = await page.getByRole('heading', { name: '테마와 색상' }).boundingBox();
  expect(
    await page.evaluate(
      ([x, y]) => !document.elementFromPoint(x, y)?.closest('.story-board-preview'),
      [heading!.x + heading!.width / 2, heading!.y + heading!.height / 2]
    )
  ).toBe(true);
  await editor.getByRole('button', { name: '테마 저장', exact: true }).click();
  const catalog = async () => (await (await request.get('/api/themes')).json()) as ThemeCatalog;
  await expect
    .poll(async () => (await catalog()).themes.find((theme) => theme.title === title)?.id)
    .toBeTruthy();
  const saved = (await catalog()).themes.find((theme) => theme.title === title)!;
  expect((await catalog()).preferences.botStoryUiThemes?.[chat.botId]).toBeUndefined();
  await page
    .getByRole('combobox', { name: '봇의 이야기 UI 기본값', exact: true })
    .selectOption(saved.id);
  await expect
    .poll(async () => (await catalog()).preferences.botStoryUiThemes?.[chat.botId])
    .toBe(saved.id);
  expect((await catalog()).preferences.botThemes).toEqual(before.preferences.botThemes);
  expect((await catalog()).preferences.defaultThemeId).toBe(before.preferences.defaultThemeId);
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await page.reload();
  const surface = page.locator('.story-ui');
  await expect(surface).toHaveCSS('background-color', 'rgb(239, 229, 251)');
  await expect(page.locator('body')).not.toHaveCSS('background-color', 'rgb(255, 0, 0)');
  await surface.getByLabel('관측 메모').fill('오리온 성운을 확인했어요.');
  await surface.getByRole('button', { name: '기록 전달', exact: true }).click();
  const send = page.locator('.story-ui-block').getByRole('button', { name: '보내기', exact: true });
  await expect(send).toBeVisible();
  await expect(send).not.toHaveCSS('background-color', 'rgb(214, 183, 237)');
  expect(await send.evaluate((element) => element.closest('[data-story-ui-custom]'))).toBeNull();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('story-ui-custom-theme.png'), fullPage: true });
});
