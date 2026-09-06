import { test, expect, type Page, type APIRequestContext, type Request } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Chat, ChatDetail, Run } from '../core/types.js';

async function control(request: APIRequestContext, action: string, extra: Record<string, string> = {}) {
  const response = await request.post('/api/test/control', { data: { action, ...extra } });
  expect(response.ok()).toBeTruthy();
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> { return (await request.get(`/api/chats/${id}`)).json(); }
async function newChat(page: Page, title: string): Promise<Chat> {
  await page.goto('/');
  await page.getByLabel('새 이야기 이름').fill(title);
  const response = page.waitForResponse(r => r.url().endsWith('/api/chats') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '이야기 만들기' }).click();
  const chat = await (await response).json() as Chat;
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return chat;
}
async function send(page: Page, prompt: string): Promise<Run> {
  await page.getByLabel('다음 장면 요청').fill(prompt);
  const response = page.waitForResponse(r => /\/api\/chats\/[^/]+\/runs$/.test(r.url()) && r.request().method() === 'POST');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  return (await response).json();
}

test('F02 F03 F05 two contexts and two tabs keep commands, snapshots, source jobs and reconnection isolated', async ({ page, context, browser, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const bPage = await other.newPage();
  bPage.on('pageerror', e => errors.push(e.message));
  const base = process.env.NR_BASE_URL!;
  // A new independent context needs the same explicit server URL, no shared browser storage.
  await bPage.goto(base);
  try {
    const a = await newChat(page, '합성 A · 등대');
    await bPage.getByLabel('새 이야기 이름').fill('합성 B · 정원');
    const bResponse = bPage.waitForResponse(r => r.url().endsWith('/api/chats') && r.request().method() === 'POST');
    await bPage.getByRole('button', { name: '이야기 만들기' }).click();
    const b = await (await bResponse).json() as Chat;
    await expect(bPage.getByRole('heading', { name: b.title, exact: true })).toBeVisible();
    await bPage.getByText('이야기 설정', { exact: false }).first().click();
    await bPage.getByLabel('서술 프리셋').selectOption('vivid');
    await bPage.getByLabel('모의 생성 경로').selectOption('research');
    await bPage.getByRole('button', { name: '설정 저장' }).click();
    await expect(bPage.getByText('저장된 설정 v2')).toBeVisible();

    const aSecondTab = await context.newPage();
    await aSecondTab.goto(`/?chat=${a.id}`);
    await expect(aSecondTab.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    await aSecondTab.getByText('이야기 설정', { exact: false }).first().click();
    await aSecondTab.getByLabel('서술 프리셋').selectOption('vivid');
    await control(request, 'hold', { barrier: 'run' });
    await control(request, 'hold', { barrier: 'translation' });
    await control(request, 'hold', { barrier: 'status' });
    const aRun = await send(page, '(OOC: Write a quiet lighthouse scene.) SYNTHETIC_A');
    const bRun = await send(bPage, 'Write a garden scene after researching the harbor. SYNTHETIC_B');
    expect(aRun.id).not.toBe(bRun.id);
    await expect(aSecondTab.getByTestId('run')).toHaveAttribute('data-run-id', aRun.id);
    // Duplicate identical HTTP command uses the exact browser-submitted body/key.
    const pending = JSON.parse(await page.evaluate(id => sessionStorage.getItem(`command:${id}`), a.id) as string);
    const command = { ...JSON.parse(pending.payload), idempotencyKey: pending.id };
    const dup = await Promise.all([request.post(`/api/chats/${a.id}/runs`, { data: command }), request.post(`/api/chats/${a.id}/runs`, { data: command })]);
    for (const response of dup) { expect(response.ok()).toBeTruthy(); expect((await response.json()).id).toBe(aRun.id); }
    const conflict = await request.post(`/api/chats/${a.id}/runs`, { data: { ...command, idempotencyKey: 'other-request' } });
    expect(conflict.status()).toBe(409);
    // A changed setting while held must not alter the existing run snapshot.
    await page.getByText('이야기 설정', { exact: false }).first().click();
    await page.getByLabel('서술 프리셋').selectOption('vivid');
    await page.getByRole('button', { name: '설정 저장' }).click();
    await expect(page.getByText('저장된 설정 v2')).toBeVisible();
    await aSecondTab.getByRole('button', { name: '설정 저장' }).click();
    await expect(aSecondTab.getByRole('alert')).toContainText('다른 요청이 먼저 반영됐어요');
    await aSecondTab.getByRole('button', { name: '저장된 설정 다시 불러오기' }).click();
    await expect(aSecondTab.getByRole('alert')).toHaveCount(0);
    expect((await detail(request, a.id)).runs[0].snapshot.settings.preset).toBe('calm');
    await page.close();
    await control(request, 'release', { barrier: 'run' });
    await expect.poll(async () => (await detail(request, a.id)).runs[0].status).toBe('completed');
    await expect.poll(async () => (await detail(request, b.id)).runs[0].status).toBe('completed');
    const aDone = await detail(request, a.id);
    const bDone = await detail(request, b.id);
    expect(aDone.sources).toHaveLength(1); expect(bDone.sources).toHaveLength(1);
    expect(aDone.runs[0].inputs[0].task).toContain('SYNTHETIC_A');
    expect(bDone.runs[0].inputs[0].task).toContain('SYNTHETIC_B');
    expect(JSON.stringify(aDone.runs[0].inputs)).not.toContain('SYNTHETIC_B');
    expect(JSON.stringify(bDone.runs[0].inputs)).not.toContain('SYNTHETIC_A');
    const aSource = aDone.sources[0];
    expect(aDone.jobs.every(j => j.sourceRevision === aSource.id && j.status !== 'completed')).toBeTruthy();
    // Original source is already readable while BOTH auxiliary workers remain held.
    await expect(aSecondTab.getByTestId('source-text')).toHaveText(aSource.text);
    await expect(aSecondTab.getByTestId('job-translation')).toContainText('모의 한국어 번역');
    await aSecondTab.goto(`/?chat=${b.id}`); // same context's tab changes its own view only
    await expect(aSecondTab.getByRole('heading', { name: b.title, exact: true })).toBeVisible();
    await control(request, 'release', { barrier: 'status' });
    await expect.poll(async () => (await detail(request, a.id)).jobs.find(j => j.kind === 'status')?.status).toBe('completed');
    expect((await detail(request, a.id)).jobs.find(j => j.kind === 'translation')?.status).not.toBe('completed');
    await control(request, 'release', { barrier: 'translation' });
    await expect.poll(async () => (await detail(request, a.id)).jobs.every(j => j.status === 'completed')).toBe(true);
    const returned = await context.newPage();
    await returned.goto(`/?chat=${a.id}`);
    await expect(returned.getByTestId('run')).toHaveAttribute('data-run-id', aRun.id);
    await expect(returned.getByTestId('source-text')).toHaveText(aSource.text);
    await expect(returned.getByTestId('job-status')).toHaveAttribute('data-source-id', aSource.id);
    await expect(returned.getByTestId('job-translation')).toHaveAttribute('data-source-id', aSource.id);
    await expect(aSecondTab.getByTestId('source')).toHaveAttribute('data-source-id', bDone.sources[0].id);
    const stale = await request.post(`/api/chats/${a.id}/runs`, { data: { request: 'old head', expectedRevision: null, expectedSettingsRevision: 2, idempotencyKey: 'stale-after-complete' } });
    expect(stale.status()).toBe(409);
    expect(await returned.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await returned.screenshot({ path: testInfo.outputPath('mobile-source.png'), fullPage: true });
    // Independent file connection, not a mocked API, verifies storage and logical uniqueness.
    const db = new DatabaseSync(process.env.NR_DB!, { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM runs WHERE chat_id=?').get(a.id)?.n).toBe(1);
      expect(db.prepare('SELECT text,hash FROM sources WHERE id=?').get(aSource.id)).toEqual({ text: aSource.text, hash: createHash('sha256').update(aSource.text).digest('hex') });
      expect(db.prepare('SELECT count(*) AS n FROM job_results r JOIN jobs j ON j.id=r.job_id WHERE j.source_revision=?').get(aSource.id)?.n).toBe(2);
    } finally { db.close(); }
    if (process.env.NR_ARTIFACT_DIR) {
      await mkdir(join(process.env.NR_ARTIFACT_DIR, 'evidence'), { recursive: true });
      await writeFile(join(process.env.NR_ARTIFACT_DIR, 'evidence', 'browser-observations.json'), JSON.stringify({ a: await detail(request, a.id), b: await detail(request, b.id), browserErrors: errors, twoContexts: true, sameContextTwoTabs: true }, null, 2));
    }
    expect(errors).toEqual([]);
    await returned.close(); await aSecondTab.close();
  } finally {
    for (const barrier of ['run', 'translation', 'status']) await control(request, 'release', { barrier });
    await other.close();
  }
});

test('F05 failed auxiliary result retries independently while a later source is selected', async ({ page, request }) => {
  const chat = await newChat(page, '합성 · 보조 재시도');
  await control(request, 'fail-next', { point: 'translation' });
  await send(page, 'SYNTHETIC_FIRST: A letter rests on the desk.');
  await expect(page.getByTestId('job-translation')).toContainText('실패');
  const before = await detail(request, chat.id);
  const source = before.sources[0];
  const failedJob = before.jobs.find(j => j.kind === 'translation')!;
  await send(page, 'SYNTHETIC_SECOND: The letter remains sealed.');
  await expect(page.getByTestId('source')).toHaveCount(2);
  await page.getByTestId('job-translation').filter({ hasText: '실패' }).getByRole('button', { name: '이 작업만 재시도' }).click();
  await expect.poll(async () => (await detail(request, chat.id)).jobs.find(j => j.id === failedJob.id)?.status).toBe('completed');
  const repeated = await Promise.all([request.post(`/api/jobs/${failedJob.id}/retry`, { data: {} }), request.post(`/api/jobs/${failedJob.id}/retry`, { data: {} })]);
  for (const response of repeated) expect(response.ok()).toBeTruthy();
  const after = await detail(request, chat.id);
  expect(after.runs).toHaveLength(2);
  expect(after.sources.find(s => s.id === source.id)).toEqual(source);
  const later = after.sources.find(s => s.id !== source.id)!;
  expect(later.parentRevision).toBe(source.id);
  expect(after.jobs.find(j => j.id === failedJob.id)?.sourceRevision).toBe(source.id);
  expect(after.jobs.filter(j => j.sourceRevision === source.id)).toHaveLength(2);
  expect(after.runs.find(r => r.sourceRevision === later.id)?.inputs[0].history).toEqual([{ revision: source.id, text: source.text }]);
});

test('F03 F05 an older real HTTP response cannot hide a newly committed source', async ({ page, request }) => {
  const chat = await newChat(page, '합성 · 역순 응답');
  const pending = new Set<Request>();
  page.on('request', request => { if (request.url().endsWith(`/api/chats/${chat.id}`) && request.method() === 'GET') pending.add(request); });
  page.on('requestfinished', request => pending.delete(request));
  page.on('requestfailed', request => pending.delete(request));
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const firstCaptured = new Promise<void>(resolve => { captured = resolve; });
  let first = true;
  await page.route(`**/api/chats/${chat.id}`, async route => {
    if (!first || route.request().method() !== 'GET') { await route.continue(); return; }
    first = false;
    const realResponse = await route.fetch();
    captured();
    await barrier;
    await route.fulfill({ response: realResponse, headers: { ...realResponse.headers(), 'x-m0-delayed': 'true' } });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await firstCaptured;
    const response = await request.post(`/api/chats/${chat.id}/runs`, { data: { request: 'SYNTHETIC delayed HTTP response', expectedRevision: null, expectedSettingsRevision: 1, idempotencyKey: 'reorder-source' } });
    expect(response.ok()).toBeTruthy();
    await expect(page.getByTestId('source')).toHaveCount(1);
    await expect.poll(async () => (await detail(request, chat.id)).jobs.every(j => j.status === 'completed')).toBe(true);
    const source = (await detail(request, chat.id)).sources[0];
    await expect(page.getByTestId('job-status')).toContainText('완료');
    await expect(page.getByTestId('job-translation')).toContainText('완료');
    await expect.poll(() => pending.size).toBe(1);
    // Deliver the stale network response after latest source/job events have ended.
    const delivered = page.waitForResponse(r => r.headers()['x-m0-delayed'] === 'true');
    release(); await (await delivered).finished();
    await expect.poll(() => pending.size).toBe(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.getByLabel('다음 장면 요청').fill('local draft after the stale response');
    await expect(page.getByTestId('source-text')).toHaveText(source.text);
    await expect(page.getByTestId('job-status')).toContainText('완료');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
