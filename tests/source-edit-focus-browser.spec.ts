import { test, expect, type APIRequestContext } from './fixtures/browser-test.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';

async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function seed(request: APIRequestContext, label: string) {
  const response = await postFixtureChat(request, {
    data: { title: `Synthetic source editor ${label}` },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  const settings = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...chat.settings,
      expectedSettingsRevision: chat.settingsRevision,
    },
  });
  expect(settings.ok()).toBeTruthy();
  const current = (await settings.json()) as Chat;
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: 'A synthetic scene for the source editor focus regression.',
      expectedRevision: null,
      expectedSettingsRevision: current.settingsRevision,
      idempotencyKey: `source-editor-${chat.id}`,
    },
  });
  expect(started.ok()).toBeTruthy();
  const run = (await started.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  const generated = await detail(request, chat.id);
  const source = generated.sources[0];
  const text = Array.from(
    { length: 40 },
    (_, index) =>
      `Synthetic paragraph ${index + 1}. The lighthouse keeper follows the quiet shoreline and records the changing light. This is public synthetic prose for a long reading viewport.`
  ).join('\n\n');
  const replaced = await request.put(`/api/sources/${source.id}/text`, {
    data: { text, expectedRevision: source.editRevision ?? 0 },
  });
  expect(replaced.ok()).toBeTruthy();
  return detail(request, chat.id);
}

test('C04V saved versions stay read-only until saved, preserve the previous draft, and named scenes remain searchable', async ({
  page,
  request,
}) => {
  const before = await seed(request, 'saved versions');
  const source = before.sources[0];
  expect(
    (
      await request.put(`/api/sources/${source.id}/text`, {
        data: { text: 'Current saved manuscript.', expectedRevision: source.editRevision },
      })
    ).ok()
  ).toBe(true);
  await page.goto(`/?chat=${before.chat.id}`);
  const scene = page.locator(`[data-source-id="${source.id}"][data-testid="source"]`);
  await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
  const field = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
  await field.fill('My unsaved wording.');
  await scene.getByText('저장본 비교', { exact: true }).click();
  await expect(scene.getByRole('combobox', { name: '비교할 저장본' })).toHaveValue(
    String(source.editRevision)
  );
  const load = scene.getByRole('button', { name: '선택한 저장본 불러오기' });
  await load.click();
  await expect(field).toHaveValue(source.text);
  expect((await detail(request, before.chat.id)).sources[0].text).toBe('Current saved manuscript.');
  await scene.getByRole('button', { name: '불러오기 전 초안으로 돌아가기' }).click();
  await expect(field).toHaveValue('My unsaved wording.');
  await load.click();
  await scene.getByRole('button', { name: '원문 저장', exact: true }).click();
  await expect(field).toHaveCount(0);
  expect((await detail(request, before.chat.id)).sources[0].text).toBe(source.text);

  await page.getByRole('button', { name: '장면 목록 열기', exact: true }).click();
  const list = page.getByRole('dialog', { name: '장면 목록', exact: true });
  await list.getByRole('button', { name: '1번째 장면 이름 편집' }).click();
  const name = page.getByRole('dialog', { name: '장면 이름', exact: true });
  await name.getByRole('textbox', { name: '장면 이름', exact: true }).fill('The quiet lighthouse');
  await name.getByRole('button', { name: '이름 저장' }).click();
  await expect(
    list.getByRole('button', { name: '1번째 장면, The quiet lighthouse', exact: true })
  ).toBeVisible();
  const search = list.getByRole('searchbox', { name: '장면 검색어' });
  await search.fill('lighthouse');
  await expect(list.getByText('The quiet lighthouse', { exact: true })).toBeVisible();
  await search.fill('source editor focus');
  await expect(list.getByText('The quiet lighthouse', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '장면 목록 열기', exact: true }).click();
  await expect(list.getByText('The quiet lighthouse', { exact: true })).toBeVisible();
  const after = await detail(request, before.chat.id);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
});
