import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, openChatMenu, selectSettingsSection } from './ui-navigation.js';
import type { ChatBackup } from '../core/chat-backup.js';
import type { ChatDetail, Run } from '../core/types.js';

test(`CBACK01 downloads every branch and restores the same file twice as new chats at ${MOBILE_WIDTH} and ${DESKTOP_WIDTH}px`, async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, { data: { title: '채팅 백업 합성 자료' } });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = await created.json();
  const runResponse = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '합성 백업 원문 하나',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: `backup-ui:${chat.id}`,
    },
  });
  expect(runResponse.ok(), await runResponse.text()).toBe(true);
  const run = (await runResponse.json()) as Run;
  await expect
    .poll(
      async () =>
        ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail).runs.find(
          (entry) => entry.id === run.id
        )?.status
    )
    .toBe('completed');
  const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const branched = await request.post(`/api/chats/${chat.id}/branches`, {
    data: { title: '백업의 다른 분기', fromRevision: detail.sources[0].id },
  });
  expect(branched.ok(), await branched.text()).toBe(true);
  await page.goto(`/?chat=${chat.id}`);
  const copied: string[] = [];
  await page.exposeFunction('recordClipboard', (value: string) => {
    copied.push(value);
  });
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) =>
          (
            window as unknown as { recordClipboard: (value: string) => Promise<void> }
          ).recordClipboard(text),
      },
    })
  );
  await page.getByRole('button', { name: '본문 복사', exact: true }).click();
  expect(copied).toEqual([detail.sources[0].text]);
  await openChatMenu(page);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '채팅 백업 내보내기', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.uimori-chat\.json$/u);
  const path = await download.path();
  const bytes = await readFile(path!);
  const backup = JSON.parse(bytes.toString()) as ChatBackup;
  expect(backup.format).toBe('uimori-chat-backup');
  expect(backup.records.branches).toHaveLength(2);
  const restored: string[] = [];
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '데이터 관리');
    const section = page.getByRole('region', { name: '채팅 백업 가져오기', exact: true });
    const file = section.getByLabel('채팅 백업 파일 선택', { exact: true });
    await file.setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/json',
      buffer: bytes,
    });
    const submit = section.getByRole('button', { name: '새 채팅으로 가져오기', exact: true });
    await expect(submit).toBeEnabled();
    await expect(section.getByText(/분기 2개 · 본문 1개/)).toBeVisible();
    expect(
      await section.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    await submit.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`chat-backup-${width}.png`) });
    const responseEvent = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/chats/import-backup') &&
        response.request().method() === 'POST'
    );
    await submit.click();
    const response = await responseEvent;
    expect(response.ok(), await response.text()).toBe(true);
    const result = await response.json();
    restored.push(result.chat.id);
    await expect(section.getByRole('status')).toContainText('분기 2개, 본문 1개를 복원했어요');
    expect(await file.evaluate((node) => (node as HTMLInputElement).files?.length)).toBe(0);
    const restoredBackup = await request.get(`/api/chats/${result.chat.id}/backup`);
    expect(restoredBackup.ok(), await restoredBackup.text()).toBe(true);
    expect(
      (await restoredBackup.json()).records.sources.map((row: { text: string }) => row.text)
    ).toEqual(backup.records.sources.map((row) => row.text));
    await page.keyboard.press('Escape');
  }
  expect(new Set([chat.id, ...restored]).size).toBe(3);
});

test('CBACK02 rejected or uncertain imports keep the selection and reuse only its own request key', async ({
  page,
}) => {
  const calls: { backup: ChatBackup; idempotencyKey: string }[] = [];
  await page.route('**/api/chats/import-backup', async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    if (calls.length === 1)
      return route.fulfill({ status: 503, json: { error: 'SYNTHETIC_UNCERTAIN_IMPORT' } });
    return route.fulfill({
      json: {
        chat: { id: 'synthetic-restored', title: '합성 백업' },
        created: false,
        branches: 1,
        sources: 0,
      },
    });
  });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '데이터 관리');
  const section = page.getByRole('region', { name: '채팅 백업 가져오기', exact: true });
  const file = section.getByLabel('채팅 백업 파일 선택', { exact: true });
  const backup = {
    format: 'uimori-chat-backup',
    version: 1,
    records: { chat: [{ title: '합성 백업' }], branches: [{}], sources: [] },
  };
  await file.setInputFiles({
    name: 'wrong.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...backup, version: 999 })),
  });
  await expect(section.getByRole('alert')).toContainText('지원하지 않아요');
  expect(calls).toHaveLength(0);
  await file.setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  const submit = section.getByRole('button', { name: '새 채팅으로 가져오기', exact: true });
  await submit.click();
  await expect(section.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요');
  await expect(submit).toBeEnabled();
  expect(await file.evaluate((node) => (node as HTMLInputElement).files?.[0]?.name)).toBe(
    'backup.json'
  );
  await submit.click();
  await expect(section.getByRole('status')).toContainText('새 채팅으로 가져왔어요');
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
});
