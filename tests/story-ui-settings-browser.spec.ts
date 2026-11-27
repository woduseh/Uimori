import { expect, test } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import type { ChatDetail, Run } from '../core/types.js';
import { parseStoryUi } from '../core/story-ui.js';
import { openHelper } from './ui-navigation.js';

test('STORYUI generated source renders in the compiled app and submits a short continuation', async ({
  page,
  request,
}) => {
  const created = await postFixtureChat(request, { data: { title: 'Story UI generated scene' } });
  const chat = await created.json();
  const saved = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...chat.settings,
      expectedSettingsRevision: chat.settingsRevision,
      storyUi: true,
      autoTranslate: false,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const configured = await saved.json();
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request:
        '<a2ui>\n$/_uimori/style = "blue-archive"\nroot = Column([Text("항구의 소식"), TextField("답장", $/reply), Button(Text("편지 답장"), action=Event("reply", {text: $/reply}))])</a2ui>',
      expectedRevision: null,
      expectedSettingsRevision: configured.settingsRevision,
      idempotencyKey: `story-ui-${chat.id}`,
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const run = (await started.json()) as Run;
  const read = async () =>
    (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  await expect
    .poll(async () => (await read()).runs.find((item) => item.id === run.id)?.status)
    .toBe('completed');
  const before = await read();
  await page.addInitScript(() => localStorage.setItem('uimori:reading-language', 'original'));
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.locator('.story-ui').getByText('항구의 소식', { exact: true })).toBeVisible();
  await expect(page.locator('.story-ui')).toHaveAttribute('data-story-ui-style', 'blue-archive');
  await page.locator('.story-ui').getByLabel('답장', { exact: true }).fill('조금 뒤에 도착할게요.');
  const override = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...before.chat.settings,
      expectedSettingsRevision: before.chat.settingsRevision,
      storyUiStyle: 'east-asian',
    },
  });
  expect(override.ok(), await override.text()).toBe(true);
  await page.reload();
  await expect(page.locator('.story-ui')).toHaveAttribute('data-story-ui-style', 'east-asian');
  await expect(page.locator('.story-ui')).toHaveCSS('background-color', 'rgb(244, 239, 226)');
  await expect(page.locator('.story-ui').getByLabel('답장', { exact: true })).toHaveValue(
    '조금 뒤에 도착할게요.'
  );
  await page.locator('.story-ui').getByRole('button', { name: '편지 답장', exact: true }).click();
  await expect(
    page.locator('.story-ui-block').getByRole('radio', { name: '이 대화만 이어가기', exact: true })
  ).toBeChecked();
  await page
    .locator('.story-ui-block')
    .getByRole('button', { name: '보내기', exact: true })
    .click();
  await expect
    .poll(async () => (await read()).chat.headRevision)
    .not.toBe(before.chat.headRevision);
  const after = await read();
  const head = after.sources.find((source) => source.id === after.chat.headRevision);
  expect(head).toBeDefined();
  const prose = parseStoryUi(head!.text).find((part) => part.kind === 'prose');
  const excerpt =
    prose?.kind === 'prose'
      ? prose.text.match(/[\p{L}\p{N}]+(?: +[\p{L}\p{N}]+){1,3}/u)?.[0]
      : undefined;
  expect(excerpt).toBeTruthy();
  await expect(page.locator(`[data-source-id="${head!.id}"]`).getByText(excerpt!)).toBeVisible();
  expect(
    after.runs.find((item) => item.snapshot.storyUiAction)?.snapshot.storyUiAction
  ).toMatchObject({
    mode: 'short',
    name: 'reply',
    context: { text: '조금 뒤에 도착할게요.' },
  });
  expect(after.sources.find((source) => source.id === before.chat.headRevision)?.text).toBe(
    before.sources.find((source) => source.id === before.chat.headRevision)?.text
  );
  await page.screenshot({ path: 'output/story-ui-app.png', fullPage: true });
});

test('STORYUI the status tab shows the latest pinned block up to the scene being read', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const created = await postFixtureChat(request, { data: { title: 'Story UI board' } });
  const chat = await created.json();
  const saved = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...chat.settings,
      expectedSettingsRevision: chat.settingsRevision,
      storyUi: true,
      autoTranslate: false,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  let settingsRevision = (await saved.json()).settingsRevision;
  const read = async () =>
    (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const scenes: string[] = [];
  for (const [day, hp] of [
    [0, 0],
    [1, 10],
    [2, 4],
  ]) {
    const detail = await read();
    const started = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request:
          day === 0
            ? '항구에 아직 아무 일도 없다.\n\n'.repeat(30)
            : `${'항구의 하루가 천천히 지나간다.\n\n'.repeat(30)}<a2ui>\n$/_uimori/pin = "status"\n${day === 2 ? '$/_uimori/style = "fantasy"\n' : ''}root = Frame(body, "${day}일차 상태", kind="system")\nbody = Column([Text("HP ${hp}")])\n</a2ui>`,
        expectedRevision: detail.chat.headRevision,
        expectedSettingsRevision: settingsRevision,
        idempotencyKey: `story-ui-board-${chat.id}-${day}`,
      },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const run = (await started.json()) as Run;
    await expect
      .poll(async () => (await read()).runs.find((item) => item.id === run.id)?.status)
      .toBe('completed');
    const after = await read();
    scenes.push(after.chat.headRevision!);
    settingsRevision = after.chat.settingsRevision;
  }
  await page.addInitScript(() => localStorage.setItem('uimori:reading-language', 'original'));
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const scrollTo = (sourceId: string) =>
    page
      .locator(`[data-source-id="${sourceId}"]`)
      .first()
      .evaluate((node) => node.scrollIntoView({ block: 'start' }));
  const tab = page.getByRole('tab', { name: '현황', exact: true });
  await expect(page.getByRole('tab', { name: '플롯', exact: true })).toBeVisible();
  await expect(tab).toHaveCount(0);
  await scrollTo(scenes[1]);
  await tab.click();
  const board = page.getByRole('region', { name: '이야기 현황', exact: true });
  await expect(board.getByText('HP 10', { exact: true })).toBeVisible();
  const body = board.locator('.story-board-body');
  await expect(body).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await scrollTo(scenes[2]);
  await expect(board.getByText('HP 4', { exact: true })).toBeVisible();
  await expect(body).toHaveAttribute('data-story-ui-style', 'fantasy');
  const blockPaper = await board
    .locator('.story-ui')
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  await expect(body).toHaveCSS('background-color', blockPaper);
  await page.screenshot({ path: info.outputPath('story-board-second-scene.png') });
  await scrollTo(scenes[1]);
  await expect(board.getByText('HP 10', { exact: true })).toBeVisible();
  await board.getByRole('button', { name: '이야기 현황 닫기', exact: true }).click();
  await expect(board).toBeHidden();
});
