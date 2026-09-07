import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Content } from '../core/product.js';

test.setTimeout(120000);
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`); expect(response.ok()).toBeTruthy(); return response.json();
}
async function seed(request: APIRequestContext, count: number) {
  const response = await request.post('/api/chats', { data: { title: `Loading synthetic ${Date.now()}` } });
  expect(response.ok()).toBeTruthy(); const chat = await response.json() as Chat;
  const settings = await request.patch(`/api/chats/${chat.id}/settings`, { data: { ...chat.settings, translation: false, status: false, expectedSettingsRevision: 1 } });
  expect(settings.ok()).toBeTruthy();
  for (let index = 0; index < count; index++) {
    const before = await detail(request, chat.id);
    const response = await request.post(`/api/chats/${chat.id}/runs`, { data: { request: `Synthetic page ${index + 1}.\n\n` + 'The lantern marks a safe crossing over the river. This is synthetic public test prose.\n\n'.repeat(20), expectedRevision: before.chat.headRevision, expectedSettingsRevision: before.chat.settingsRevision, idempotencyKey: `loading-${chat.id}-${index}` } });
    expect(response.ok()).toBeTruthy(); const run = await response.json() as Run;
    await expect.poll(async () => (await detail(request, chat.id)).runs.find(item => item.id === run.id)?.status).toBe('completed');
  }
  return detail(request, chat.id);
}
const articles = (page: Page) => page.getByTestId('source');
const article = (page: Page, id: string) => page.locator(`[data-testid="source"][data-source-id="${id}"]`);
async function navLibrary(page: Page) {
  const button = page.getByRole('button', { name: '서재', exact: true });
  if (!await button.isVisible()) await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  await button.click();
}

test('LOADUI01 bounded pages, previous/next, deep links and reload preserve reader position', async ({ page, context, request }, info) => {
  const seeded = await seed(request, 12); const ids = seeded.sources.map(source => source.id);
  const requests: string[] = []; page.on('request', request => requests.push(request.url()));
  await page.goto(`/?chat=${seeded.chat.id}`); await expect(articles(page)).toHaveCount(5);
  const pager = page.getByRole('navigation', { name: '원고 구간', exact: true });
  await expect(pager).toContainText('1–5 / 12'); await expect(pager.getByRole('button', { name: '이전 원고' })).toBeDisabled();
  await pager.getByRole('button', { name: '다음 원고' }).click();
  await expect(pager).toContainText('6–10 / 12'); await expect(articles(page)).toHaveCount(5);
  await expect(article(page, ids[5])).toBeAttached(); await expect(article(page, ids[0])).toHaveCount(0);
  await pager.getByRole('button', { name: '다음 원고' }).click(); await expect(pager).toContainText('11–12 / 12');
  await expect(articles(page)).toHaveCount(2); await expect(pager.getByRole('button', { name: '다음 원고' })).toBeDisabled();
  await pager.getByRole('button', { name: '이전 원고' }).click(); await expect(pager).toContainText('6–10 / 12');
  const reader = page.locator('[data-reader-scrollport]');
  const target = article(page, ids[6]).locator('[data-block-anchor]').first();
  await target.evaluate(element => { const viewport = element.closest<HTMLElement>('[data-reader-scrollport]')!; viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24; });
  await expect.poll(async () => page.evaluate(() => {
    const record = Object.keys(sessionStorage).find(key => key.startsWith('reading:'));
    return record ? JSON.parse(sessionStorage.getItem(record)!).source : '';
  })).toBe(ids[6]);
  const before = await target.evaluate(element => element.getBoundingClientRect().top - element.closest('[data-reader-scrollport]')!.getBoundingClientRect().top);
  await page.reload(); await expect(article(page, ids[6])).toBeAttached();
  await expect.poll(async () => Math.abs((await article(page, ids[6]).locator('[data-block-anchor]').first().evaluate(element => element.getBoundingClientRect().top - element.closest('[data-reader-scrollport]')!.getBoundingClientRect().top)) - before)).toBeLessThan(4);
  await expect(articles(page)).toHaveCount(5); await expect(reader).toBeVisible();
  await page.screenshot({ path: info.outputPath('loading-reader-page.png') });
  const deep = await context.newPage(); await deep.goto(`/?chat=${seeded.chat.id}&source=${ids[10]}`);
  await expect(article(deep, ids[10])).toBeVisible(); await expect(articles(deep)).toHaveCount(2);
  expect(requests.some(url => /\/api\/chats\/[^/?]+(?:\?|$)/.test(url))).toBe(false);
  expect(requests.some(url => url.includes('/reader?'))).toBe(true);
  const after = await detail(request, seeded.chat.id); expect(after.runs).toEqual(seeded.runs); expect(after.attempts).toEqual(seeded.attempts);
  await deep.close();
});

test('LOADUI02 same-source tabs keep CAS drafts and isolate another chat, manual translation stays local', async ({ page, context, request }, info) => {
  const seeded = await seed(request, 1); const other = await seed(request, 1); const source = seeded.sources[0];
  const second = await context.newPage(); const third = await context.newPage();
  await Promise.all([page.goto(`/?chat=${seeded.chat.id}`), second.goto(`/?chat=${seeded.chat.id}`), third.goto(`/?chat=${other.chat.id}`)]);
  for (const tab of [page, second]) {
    await expect(article(tab, source.id)).toBeVisible();
    await article(tab, source.id).getByRole('button', { name: '원문 수정', exact: true }).click();
  }
  await second.getByLabel('원문 수정 내용').fill('Stale tab draft must survive.');
  await third.getByLabel('다음 장면 요청').fill('Other chat draft stays here.');
  await page.getByLabel('원문 수정 내용').fill('Accepted source revision from first tab.');
  await page.getByRole('button', { name: '원문 저장', exact: true }).click();
  await expect(page.getByLabel('원문 수정 내용')).toHaveCount(0);
  await expect(second.getByRole('alert')).toContainText('편집 중 저장된 내용이 바뀌었어요');
  await expect(second.getByLabel('원문 수정 내용')).toHaveValue('Stale tab draft must survive.');
  await expect(second.getByRole('button', { name: '원문 저장', exact: true })).toBeDisabled();
  const rejected = await request.put(`/api/sources/${source.id}/text`, { data: { text: 'Stale CAS overwrite', expectedRevision: 0 } }); expect(rejected.status()).toBe(409);
  await expect(third.getByLabel('다음 장면 요청')).toHaveValue('Other chat draft stays here.');
  expect((await detail(request, other.chat.id)).sources).toEqual(other.sources);
  await article(page, source.id).getByRole('button', { name: '번역 수정', exact: true }).click();
  await page.getByLabel('번역 수정 내용').fill('직접 저장한 합성 번역이에요.');
  await page.getByRole('button', { name: '번역 저장', exact: true }).click();
  await expect(article(page, source.id).getByTestId('translation-text')).toContainText('직접 저장한 합성 번역이에요.');
  const after = await detail(request, seeded.chat.id);
  expect(after.sources[0].editRevision).toBe(1); expect(after.sources[0].text).toBe('Accepted source revision from first tab.');
  expect(after.runs).toEqual(seeded.runs); expect(after.attempts).toEqual(seeded.attempts);
  await second.screenshot({ path: info.outputPath('loading-cas.png') });
  await second.close(); await third.close();
});

test('LOADUI03 large library uses summaries then fetches exact displayed revision on click', async ({ page, request }, info) => {
  const prefix = `Loading library ${Date.now()}`;
  let first!: Content;
  for (let index = 0; index < 100; index++) {
    const response = await request.post('/api/content', { data: { kind: 'bot', title: `${prefix} ${String(index).padStart(3,'0')}`, description: 'Synthetic summary', text: `Revision one ${index}: ` + 'Synthetic character document. '.repeat(300), loading: 'pinned', relatedIds: [] } });
    expect(response.ok()).toBeTruthy(); if (!index) first = await response.json() as Content;
  }
  const revisionRequests: string[] = []; page.on('request', request => { if (request.url().includes('/revisions/content/')) revisionRequests.push(request.url()); });
  const summaryResponse = page.waitForResponse(response => response.url().includes('/api/library?'));
  await page.goto('/'); const summaries = await (await summaryResponse).json();
  expect(summaries.contentBodiesOmitted).toBe(true);
  expect(summaries.contents).toHaveLength(100); expect(summaries.contents.every((item: Record<string, unknown>) => item.text === '')).toBe(true);
  expect(JSON.stringify(summaries)).not.toContain('Synthetic character document.');
  expect(JSON.stringify(summaries)).not.toContain(first.text);
  await navLibrary(page); await expect(page.getByTestId('library-panel')).toBeVisible();
  expect(revisionRequests).toHaveLength(0);
  const update = await request.put(`/api/content/${first.id}`, { data: { kind: first.kind, title: first.title, description: first.description, text: 'Revision two must not replace the displayed revision one.', loading: first.loading, relatedIds: first.relatedIds, expectedRevision: 1 } }); expect(update.ok()).toBeTruthy();
  await page.getByRole('button', { name: `${first.title} 자료 편집`, exact: true }).click();
  await expect(page.getByLabel('자료 본문')).toHaveValue(first.text);
  expect(revisionRequests).toHaveLength(1); expect(revisionRequests[0]).toContain(`/revisions/content/${first.id}/1`);
  await page.screenshot({ path: info.outputPath('loading-library.png') });
});

test('LOADUI04 offline edits reappear on reconnect and connected SSE sends only the changed source', async ({ page, context, request }, info) => {
  const seeded = await seed(request, 2); const [first, second] = seeded.sources;
  const generated: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/runs(?:\?|$)/.test(request.url())) generated.push(request.url()); });
  await page.goto(`/?chat=${seeded.chat.id}`); await expect(articles(page)).toHaveCount(2);
  await expect(page.getByText('연결을 다시 확인하는 중이에요.', { exact: true })).toHaveCount(0);
  await context.setOffline(true);
  try {
    await expect(page.getByText('연결을 다시 확인하는 중이에요.', { exact: true })).toBeVisible();
    const edit = await request.put(`/api/sources/${first.id}/text`, { data: { text: 'Source changed while browser was offline.', expectedRevision: 0 } }); expect(edit.ok()).toBeTruthy();
    await expect(article(page, first.id).getByTestId('source-text')).not.toContainText('Source changed while browser was offline.');
  } finally { await context.setOffline(false); }
  await expect(article(page, first.id).getByTestId('source-text')).toContainText('Source changed while browser was offline.');
  await expect(page.getByText('연결을 다시 확인하는 중이에요.', { exact: true })).toHaveCount(0);
  await expect(articles(page)).toHaveCount(2);
  const changedResponse = page.waitForResponse(async response => {
    if (!response.ok() || !response.url().includes(`/chats/${seeded.chat.id}/reader?`) || !new URL(response.url()).searchParams.has('since')) return false;
    const body = await response.json();
    return body.sources.some((source: { id: string; text: string }) => source.id === second.id && source.text === 'Only the second source changed over connected SSE.');
  });
  const nextEdit = await request.put(`/api/sources/${second.id}/text`, { data: { text: 'Only the second source changed over connected SSE.', expectedRevision: 0 } }); expect(nextEdit.ok()).toBeTruthy();
  const delta = await (await changedResponse).json();
  expect(delta.sources.map((source: { id: string }) => source.id)).toEqual([second.id]);
  expect(delta.reader.order).toEqual([first.id, second.id]);
  await expect(article(page, second.id).getByTestId('source-text')).toContainText('Only the second source changed over connected SSE.');
  await expect(article(page, first.id).getByTestId('source-text')).toContainText('Source changed while browser was offline.');
  const after = await detail(request, seeded.chat.id); expect(after.runs).toEqual(seeded.runs); expect(after.attempts).toEqual(seeded.attempts); expect(generated).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('loading-reconnected.png') });
});
