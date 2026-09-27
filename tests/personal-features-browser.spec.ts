import { test, expect, type APIRequestContext } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectSettingsSection, visibleNavigation } from './ui-navigation.js';
import { DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import type { Chat, ChatDetail } from '../core/types.js';
import type { ChatTranscript } from '../core/chat-transcript.js';

test.setTimeout(60000);
async function createReadingChat(request: APIRequestContext, title: string, count = 8) {
  const owner = await postFixtureChat(request, { data: { title: `${title} 자료` } });
  expect(owner.ok()).toBe(true);
  const original = (await owner.json()) as Chat;
  const transcript = (await (
    await request.get(`/api/chats/${original.id}/transcript`)
  ).json()) as ChatTranscript;
  transcript.title = title;
  transcript.entries = Array.from({ length: count }, (_, index) => ({
    request: `검증 장면 ${index + 1}`,
    text: `Scene ${index + 1}. Mira carried a purple umbrella.\n\n${'The quiet river reflected the lanterns.\n\n'.repeat(5)}`,
    translation: `장면 ${index + 1}. 미카는 보라색 우산을 들었다.\n\n${'조용한 강물이 등불을 비추었다.\n\n'.repeat(5)}`,
  }));
  const imported = await request.post('/api/chats/import-transcript', {
    data: { transcript, idempotencyKey: crypto.randomUUID() },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const chat = (await imported.json()).chat as Chat;
  const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  return { chat, detail };
}

test('PWUI01 search uses the saved translation and opens its exact scene on desktop and mobile without model work', async ({
  page,
  request,
}, info) => {
  const { chat } = await createReadingChat(request, `검색 검증 ${Date.now()}`);
  const modelCalls: string[] = [];
  page.on('request', (event) => {
    if (event.method() === 'POST' && /\/(?:runs|retranslate)$/.test(new URL(event.url()).pathname))
      modelCalls.push(event.url());
  });
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await visibleNavigation(page);
    await page
      .getByRole('button', { name: '전체 채팅 검색', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: '전체 채팅 검색', exact: true });
    await dialog.getByLabel('전체 채팅 검색', { exact: true }).fill('미카');
    await dialog.getByRole('button', { name: '검색', exact: true }).click();
    const result = dialog
      .locator('.manuscript-search-results article')
      .filter({ hasText: chat.title })
      .first();
    await expect(result).toContainText('보라색 우산');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`search-${width}.png`) });
    await result.getByRole('button', { name: '번역 장면 열기', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('[data-testid="source"]').first()).toHaveAttribute(
      'data-representation',
      'translation'
    );
    await expect(page.getByRole('heading', { name: chat.title, exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('mode')).toBe('translation');
    await page.screenshot({ path: info.outputPath(`reader-target-${width}.png`) });
  }
  expect(modelCalls).toEqual([]);
});

test('PWUI02 backup settings, status, verified download and retention are reachable without a live deployment', async ({
  page,
  request,
}, info) => {
  const { chat } = await createReadingChat(request, `백업 검증 ${Date.now()}`, 2);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '데이터 관리');
  const panel = page.getByRole('region', { name: '자동 백업', exact: true });
  await expect(panel.getByLabel('매일 자동 백업')).not.toBeChecked();
  await panel.getByLabel('성공본 보관 개수').fill('2');
  await panel.getByRole('button', { name: '백업 설정 저장', exact: true }).click();
  await expect(panel.getByRole('button', { name: '백업 설정 저장', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '지금 백업', exact: true }).click();
  await expect(panel).toContainText('마지막 성공:', { timeout: 30000 });
  const response = await request.get('/api/backups');
  const status = await response.json();
  expect(status.backups.length).toBeGreaterThan(0);
  const downloaded = await request.get(`/api/backups/${status.backups[0].id}/download`);
  expect(downloaded.ok()).toBe(true);
  expect((await downloaded.body()).subarray(0, 15).toString()).toBe('SQLite format 3');
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`backups-${width}.png`) });
  }
});
