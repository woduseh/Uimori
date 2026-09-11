import { test, expect, type APIRequestContext } from '@playwright/test';
import type { ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, openChatMenu } from './ui-navigation.js';

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test('WORKSPACE01 restores only a valid last workspace while explicit URLs and browser back take priority', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('library-panel')).toBeVisible();
  const chat = await (
    await postFixtureChat(request, { data: { title: 'Remembered workspace' } })
  ).json();
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('textbox', { name: '다음 장면 요청' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('uimori:last-workspace') || 'null')?.chatId
      )
    )
    .toBe(chat.id);
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`));
  await expect(page.getByRole('textbox', { name: '다음 장면 요청' })).toBeVisible();
  await navigationAction(page, '서재');
  await expect(page.getByTestId('library-panel')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('library-panel')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('textbox', { name: '다음 장면 요청' })).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem(
      'uimori:last-workspace',
      JSON.stringify({ destination: 'story', chatId: 'deleted-chat' })
    )
  );
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('textbox', { name: '다음 장면 요청' })).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem(
      'uimori:last-workspace',
      JSON.stringify({ destination: 'story', chatId: 'deleted-chat' })
    )
  );
  await page.goto('/');
  await expect(page.getByTestId('library-panel')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('uimori:last-workspace') || 'null')?.destination
      )
    )
    .toBe('library');
  expect(new URL(page.url()).searchParams.get('chat')).toBeNull();
});
async function write(request: APIRequestContext, chatId: string, text: string, branchId?: string) {
  const before = await detail(request, chatId);
  const branch = before.branches!.find((item) => (branchId ? item.id === branchId : item.default))!;
  const response = await request.post(`/api/chats/${chatId}/runs`, {
    data: {
      request: text,
      branchId: branch.id,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBe(true);
  const run = (await response.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chatId)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  return (await detail(request, chatId)).runs.find((item) => item.id === run.id)!.sourceRevision!;
}

for (const width of [390, 1440])
  test(`BRANCH01 ${width}px remote default changes preserve the open source and draft, and fresh entry uses the new default`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const chat = await (
      await postFixtureChat(request, { data: { title: `Default branch ${width}` } })
    ).json();
    const first = await write(request, chat.id, 'Original branch synthetic scene.');
    const original = (await detail(request, chat.id)).branches!.find((item) => item.default)!;
    const branchResponse = await request.post(`/api/chats/${chat.id}/branches`, {
      data: { title: '대체 전개', fromRevision: null },
    });
    expect(branchResponse.ok()).toBe(true);
    const target = await branchResponse.json();
    const alternate = await write(
      request,
      chat.id,
      'Alternative branch synthetic scene.',
      target.id
    );
    const readerFailures: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes(`/api/chats/${chat.id}/reader?`) && response.status() >= 400)
        readerFailures.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`/?chat=${chat.id}&source=${first}`);
    await expect(page.locator(`[data-testid="source"][data-source-id="${first}"]`)).toBeVisible();
    const input = page.getByRole('textbox', { name: '다음 장면 요청' });
    await input.fill('기본 전개 변경 중에도 보존할 초안');
    const other = await page.context().newPage();
    try {
      await other.goto(`/?chat=${chat.id}`);
      await openChatMenu(other);
      await other.getByRole('button', { name: '보관된 전개', exact: true }).click();
      await other.getByRole('button', { name: '대체 전개 기본 전개로 지정', exact: true }).click();
      await expect(other).toHaveURL(new RegExp(`branch=${target.id}`));
      await other.keyboard.press('Escape');
      await expect(
        other.locator(`[data-testid="source"][data-source-id="${alternate}"]`)
      ).toBeVisible();
      await expect.poll(() => new URL(page.url()).searchParams.get('branch')).toBe(original.id);
      expect(new URL(page.url()).searchParams.get('source')).toBe(first);
      await expect(page.locator(`[data-testid="source"][data-source-id="${first}"]`)).toBeVisible();
      await expect(input).toHaveValue('기본 전개 변경 중에도 보존할 초안');
      await page.reload();
      await expect(input).toHaveValue('기본 전개 변경 중에도 보존할 초안');
      await expect(page.locator(`[data-testid="source"][data-source-id="${first}"]`)).toBeVisible();
      // Re-enter without the explicit branch URL: the saved original source must not be sent
      // as a source in the newly selected default branch.
      await page.goto(`/?chat=${chat.id}`);
      await expect(
        page.locator(`[data-testid="source"][data-source-id="${alternate}"]`)
      ).toBeVisible();
      await expect(input).toHaveValue('');
      await page.goto(`/?chat=${chat.id}&branch=${original.id}&source=${first}`);
      await expect(input).toHaveValue('기본 전개 변경 중에도 보존할 초안');
      expect(readerFailures).toEqual([]);
    } finally {
      await other.close();
    }
  });
