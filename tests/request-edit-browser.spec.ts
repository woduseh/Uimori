import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  return (await request.get(`/api/chats/${id}`)).json();
}
async function seed(request: APIRequestContext, width: number, text = '원래 합성 요청') {
  const response = await postFixtureChat(request, { data: { title: `요청 편집 합성 ${width}` } });
  expect(response.ok()).toBe(true);
  const chat: Chat = await response.json();
  const result = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: text,
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(result.ok()).toBe(true);
  const run: Run = await result.json();
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  return { chat, run, before: await detail(request, chat.id) };
}
for (const width of [390, 1440]) {
  test(`RINFO01 ${width} expanded requests avoid duplicate previews and source metadata opens from the menu`, async ({
    page,
    request,
  }, info) => {
    const text = '긴 합성 요청이에요.\n'.repeat(35);
    const { chat } = await seed(request, width, text);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    const source = page.getByTestId('source').first();
    const message = source.getByTestId('source-request');
    await message.locator('summary').click();
    await expect(message.locator('.request-preview')).toBeHidden();
    await expect(message.locator('summary')).toHaveText('접기', { useInnerText: true });
    await expect(message.locator('p')).toHaveText(text);
    await page.screenshot({ path: info.outputPath(`request-expanded-${width}.png`) });
    await message.locator('summary').click();
    await expect(message.locator('.request-preview')).toBeVisible();
    await expect(source.getByText('표시 문구 바꾸기', { exact: true })).toHaveCount(0);
    const menu = source.getByLabel('장면 작업 메뉴', { exact: true });
    const metadata = source.getByRole('button', { name: '원문 연결 정보', exact: true });
    await expect(metadata).not.toBeVisible();
    await menu.click();
    await metadata.click();
    const dialog = page.getByRole('dialog', { name: '원문 연결 정보', exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(menu).toBeFocused();
    await page.route('**/api/sources/*/translation', (route) =>
      route.fulfill({ status: 400, json: { error: 'Synthetic invalid request' } })
    );
    await source.getByRole('button', { name: '번역 보기', exact: true }).click();
    const error = source.locator('.source-action-error');
    await expect(error).toContainText('요청을 처리할 수 없어요. (400)');
    const action = error.getByRole('button', { name: '전역 모델 설정' });
    const container = await error.boundingBox(),
      button = await action.boundingBox();
    expect(container!.x + container!.width - button!.x - button!.width).toBeLessThanOrEqual(24);
    expect(await error.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`source-error-${width}.png`) });
  });
  test(`REDIT01 ${width} inline request editing preserves drafts and original answers while branching`, async ({
    page,
    request,
  }, info) => {
    const { chat, run, before } = await seed(request, width);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    const source = page.getByTestId('source').first();
    const edit = source.getByRole('button', { name: '요청 편집', exact: true });
    const composer = page.getByRole('textbox', { name: '다음 장면 요청' });
    await composer.fill('입력창에 보존할 초안');
    await source.getByTestId('source-request').hover();
    await expect(edit).toBeVisible();
    await expect(edit.locator('svg')).toHaveCount(1);
    if (width === 1440) {
      await page.mouse.move(0, 0);
      await expect(source.locator('.request-message-actions')).toHaveCSS('opacity', '0');
      await edit.focus();
      await expect(source.locator('.request-message-actions')).toHaveCSS('opacity', '1');
    }
    await edit.click();
    const field = page.getByRole('textbox', { name: '요청 수정 내용' });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('원래 합성 요청');
    await field.fill('취소할 초안');
    await page.keyboard.press('Escape');
    await expect(edit).toBeFocused();
    await expect(field).not.toBeVisible();
    await edit.click();
    await expect(field).toHaveValue('원래 합성 요청');
    await field.fill('수정한 합성 요청');
    await page.reload();
    await edit.click();
    await expect(field).toHaveValue('수정한 합성 요청');
    await page.screenshot({ path: info.outputPath(`request-edit-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    const calls: Record<string, unknown>[] = [];
    await page.route(`**/api/runs/${run.id}/retry`, async (route) => {
      calls.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (calls.length === 1) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '수정한 요청 보내기' }).click();
    await expect(field).toHaveValue('수정한 합성 요청');
    await expect(field).toBeDisabled();
    await page.getByRole('button', { name: '이전 요청 확인' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('branch')).toBeTruthy();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0].request).toBe('수정한 합성 요청');
    const after = await detail(request, chat.id);
    expect(after.runs).toHaveLength(2);
    const edited = after.runs.find((item) => item.id !== run.id)!;
    expect(edited.parentRevision).toBeNull();
    expect(edited.request).toBe('수정한 합성 요청');
    expect(edited.snapshot.branchId).not.toBe(run.snapshot.branchId);
    expect(new URL(page.url()).searchParams.get('branch')).toBe(edited.snapshot.branchId);
    expect(after.sources.find((item) => item.id === before.sources[0].id)).toEqual(
      before.sources[0]
    );
    expect(after.runs.find((item) => item.id === run.id)?.request).toBe('원래 합성 요청');
    expect(await page.evaluate((id) => sessionStorage.getItem(`draft:${id}`), chat.id)).toBe(
      '입력창에 보존할 초안'
    );
  });
}
