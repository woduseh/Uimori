import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { openSourceActions } from './ui-navigation.js';

async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext, title: string) {
  const response = await postFixtureChat(request, {
    data: { title: `${title} ${crypto.randomUUID()}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = (await response.json()) as Chat;
  for (let index = 0; index < 3; index++) {
    const before = await detail(request, chat.id);
    const started = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: `장면 삭제 합성 검증 ${index + 1}: 항구의 등대를 바라본다.`,
        expectedRevision: before.chat.headRevision,
        expectedSettingsRevision: before.chat.settingsRevision,
        expectedProfileRevision: before.profile!.revision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const run = (await started.json()) as Run;
    await expect
      .poll(
        async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
      )
      .toBe('completed');
  }
  const completed = await detail(request, chat.id);
  expect(completed.sources).toHaveLength(3);
  return completed;
}

function scene(page: Page, sourceId: string) {
  return page.locator(`[data-testid="source"][data-source-id="${sourceId}"]`);
}

async function openDeletion(page: Page, sourceId: string) {
  const source = scene(page, sourceId);
  await openSourceActions(source);
  await source.getByRole('button', { name: '장면 삭제', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '장면 삭제 범위', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('SCENEDEL01 cancel preserves all scenes and deleting only the middle keeps the later scene', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const before = await seed(request, '중간 장면 삭제');
  const [first, middle, last] = before.sources;
  await page.goto(`/?chat=${before.chat.id}`);

  let dialog = await openDeletion(page, middle.id);
  await expect(dialog.getByRole('radio', { name: '이 장면만', exact: true })).toBeChecked();
  await expect(
    dialog.getByRole('radio', { name: '이 장면부터 이후까지 (2개)', exact: true })
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(scene(page, middle.id).getByLabel('장면 작업 메뉴', { exact: true })).toBeFocused();
  expect((await detail(request, before.chat.id)).sources.map((source) => source.id)).toEqual([
    first.id,
    middle.id,
    last.id,
  ]);
  await expect(page.getByTestId('source')).toHaveCount(3);

  dialog = await openDeletion(page, middle.id);
  await dialog.getByRole('button', { name: '선택한 장면 1개 삭제', exact: true }).click();
  await expect(scene(page, middle.id)).toHaveCount(0);
  await expect(page.getByTestId('source')).toHaveCount(2);
  await expect(scene(page, last.id)).toBeVisible();
  const after = await detail(request, before.chat.id);
  expect(after.sources.map((source) => source.id)).toEqual([first.id, last.id]);
  expect(after.sources.map((source) => source.text)).toEqual([first.text, last.text]);
  expect(after.chat.headRevision).toBe(last.id);
  expect(new URL(page.url()).searchParams.get('chat')).toBe(before.chat.id);
  await page.reload();
  await expect(page.getByTestId('source')).toHaveCount(2);
  await expect(scene(page, middle.id)).toHaveCount(0);
});

test('SCENEDEL02 deleting from a middle scene removes its following range and retains the preceding scene', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const before = await seed(request, '이후 장면 삭제');
  const [first, middle, last] = before.sources;
  await page.goto(`/?chat=${before.chat.id}`);
  const dialog = await openDeletion(page, middle.id);
  await dialog.getByRole('radio', { name: '이 장면부터 이후까지 (2개)', exact: true }).check();
  await dialog.getByRole('button', { name: '선택한 장면 2개 삭제', exact: true }).click();
  await expect(page.getByTestId('source')).toHaveCount(1);
  await expect(scene(page, middle.id)).toHaveCount(0);
  await expect(scene(page, last.id)).toHaveCount(0);
  await expect(scene(page, first.id)).toBeVisible();
  const after = await detail(request, before.chat.id);
  expect(after.sources.map((source) => source.id)).toEqual([first.id]);
  expect(after.sources[0].text).toBe(first.text);
  expect(after.chat.headRevision).toBe(first.id);
  await page.reload();
  await expect(page.getByTestId('source')).toHaveCount(1);
});

test('SCENEDEL04 a deleted scene can be checked after closing and reloading', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const before = await seed(request, '삭제 결과 새로고침');
  const [first, middle, last] = before.sources;
  const commands: unknown[] = [];
  const storageKey = `scene-delete:${before.chat.id}:${middle.id}`;
  await page.route(`**/api/chats/${before.chat.id}/sources/${middle.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    commands.push(route.request().postDataJSON());
    const accepted = await route.fetch();
    expect(accepted.ok(), await accepted.text()).toBe(true);
    if (commands.length === 1)
      await route.fulfill({ status: 503, json: { message: 'Synthetic lost acknowledgement' } });
    else await route.fulfill({ response: accepted });
  });

  await page.goto(`/?chat=${before.chat.id}`);
  let dialog = await openDeletion(page, middle.id);
  await dialog.getByRole('button', { name: '선택한 장면 1개 삭제', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('삭제 결과를 확인하지 못했어요.');
  await expect(scene(page, middle.id)).toHaveCount(0);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await expect(page.getByTestId('source')).toHaveCount(2);
  const recovery = page.getByRole('alert').filter({ hasText: '삭제 결과를 확인하지 못했어요.' });
  await expect(recovery).toBeVisible();
  expect(commands).toHaveLength(1);
  await recovery.getByRole('button', { name: '삭제 결과 다시 확인', exact: true }).click();
  dialog = page.getByRole('alertdialog', { name: '장면 삭제 범위', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: '이 장면만', exact: true })).toBeDisabled();
  expect(commands).toHaveLength(1);
  await dialog.getByRole('button', { name: '삭제 결과 다시 확인', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(recovery).toHaveCount(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBeNull();
  expect((await detail(request, before.chat.id)).sources.map((source) => source.id)).toEqual([
    first.id,
    last.id,
  ]);
});
