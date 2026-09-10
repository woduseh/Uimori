import { visualReview } from './fixtures/visual-review.js';
import { selectChatSettingsSection } from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type Page, type APIRequestContext, type Request } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Chat, ChatDetail, Run } from '../core/types.js';

const commands = new Map<string, Record<string, unknown>>();
async function control(
  request: APIRequestContext,
  action: string,
  extra: Record<string, string> = {}
) {
  const response = await request.post('/api/test/control', { data: { action, ...extra } });
  expect(response.ok()).toBeTruthy();
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  return (await request.get(`/api/chats/${id}`)).json();
}
async function newStatusChat(page: Page, title: string): Promise<Chat> {
  // These M0 cases exercise automatic status jobs, so select that setting explicitly.
  const response = await postFixtureChat(page.request, { data: { title } });
  expect(response.ok()).toBeTruthy();
  const created = (await response.json()) as Chat;
  const settings = await page.request.patch(`/api/chats/${created.id}/settings`, {
    data: {
      ...created.settings,
      status: true,
      expectedSettingsRevision: created.settingsRevision,
    },
  });
  expect(settings.ok()).toBeTruthy();
  const chat = (await settings.json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return chat;
}
async function sourceDetails(page: Page) {
  await page.getByTestId('source').first().waitFor();
  for (const source of await page.getByTestId('source').all()) {
    const original = source.getByRole('button', { name: '원문 보기', exact: true });
    if (await original.count()) await original.click();
    const activity = source.getByTestId('turn-activity');
    if ((await activity.count()) && (await activity.getAttribute('open')) === null)
      await activity.locator(':scope > summary').click();
  }
}
async function expectSourceRaw(page: Page, text: string) {
  const source = page.getByTestId('source').first();
  await source.getByLabel('장면 작업 메뉴', { exact: true }).click();
  await source.getByRole('button', { name: '원문 연결 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '원문 연결 정보', exact: true });
  await dialog.getByText('현재 원문', { exact: true }).click();
  await expect(dialog.getByTestId('source-raw')).toHaveText(text);
  await dialog.getByRole('button', { name: '원문 연결 정보 닫기' }).click();
}
async function storySettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  if (!(await dialog.isVisible())) await openChatSettings(page);
  await selectChatSettingsSection(page, '자동 후속 작업');
  const fixture = dialog
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: '개발자용 모의 실행 제어' }) });
  if ((await fixture.count()) && (await fixture.getAttribute('open')) === null)
    await fixture.locator('summary').click();
}
async function openWork(page: Page) {
  await closeDialog(page);
  // The sidebar lists tasks only while something runs; the chat ⋯ menu always has the panel.
  await page.locator('.chat-menu').getByLabel('채팅 메뉴').click();
  await page.getByRole('button', { name: '작업 현황', exact: true }).click();
}
async function closeDialog(page: Page) {
  const dialog = page.getByRole('dialog').filter({ visible: true });
  if (await dialog.count()) await page.keyboard.press('Escape');
}
async function send(page: Page, prompt: string): Promise<Run> {
  await closeDialog(page);
  await page.getByLabel('다음 장면 요청').fill(prompt);
  const response = page.waitForResponse(
    (r) => /\/api\/chats\/[^/]+\/runs$/.test(r.url()) && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  const received = await response;
  const run = (await received.json()) as Run;
  commands.set(run.id, received.request().postDataJSON());
  return run;
}

test.afterEach(async ({ request }) => {
  for (const barrier of ['run', 'translation', 'status'])
    await control(request, 'release', { barrier });
});

test('F02 F03 F05 two contexts and two tabs keep commands, snapshots, source jobs and reconnection isolated', async ({
  page,
  context,
  browser,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const bPage = await other.newPage();
  bPage.on('pageerror', (e) => errors.push(e.message));
  const base = process.env.NR_BASE_URL!;
  // A new independent context needs the same explicit server URL, no shared browser storage.
  await bPage.goto(base);
  try {
    const a = await newStatusChat(page, '합성 A · 등대');
    const b = await newStatusChat(bPage, '합성 B · 정원');
    await storySettings(bPage);
    await bPage.getByLabel('서술 프리셋').selectOption('vivid');
    await bPage.getByLabel('모의 생성 경로').selectOption('research');
    await bPage.getByRole('button', { name: '설정 저장', exact: true }).click();
    await expect
      .poll(async () => (await detail(request, b.id)).chat.settingsRevision)
      .toBe(b.settingsRevision + 1);

    const aSecondTab = await context.newPage();
    await aSecondTab.goto(`/?chat=${a.id}`);
    await expect(aSecondTab.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    await storySettings(aSecondTab);
    await aSecondTab.getByLabel('서술 프리셋').selectOption('vivid');
    await control(request, 'hold', { barrier: 'run' });
    await control(request, 'hold', { barrier: 'translation' });
    await control(request, 'hold', { barrier: 'status' });
    const aRun = await send(page, '(OOC: Write a quiet lighthouse scene.) SYNTHETIC_A');
    const bRun = await send(
      bPage,
      'Write a garden scene after researching the harbor. SYNTHETIC_B'
    );
    expect(aRun.id).not.toBe(bRun.id);
    // Keep the second tab's unsaved settings intact for the later revision conflict.
    const aWorkTab = await context.newPage();
    aWorkTab.on('pageerror', (error) => errors.push(error.message));
    try {
      await aWorkTab.goto(`/?chat=${a.id}`);
      await openWork(aWorkTab);
      await expect(
        aWorkTab.getByRole('dialog', { name: '작업 현황', exact: true }).getByTestId('run')
      ).toHaveAttribute('data-run-id', aRun.id);
    } finally {
      await aWorkTab.close();
    }
    await expect(aSecondTab.getByLabel('서술 프리셋')).toHaveValue('vivid');
    // Duplicate identical HTTP command uses the exact browser-submitted body/key.
    const command = commands.get(aRun.id)!;
    expect(command).toMatchObject({
      request: '(OOC: Write a quiet lighthouse scene.) SYNTHETIC_A',
      expectedRevision: null,
    });
    const dup = await Promise.all([
      request.post(`/api/chats/${a.id}/runs`, { data: command }),
      request.post(`/api/chats/${a.id}/runs`, { data: command }),
    ]);
    for (const response of dup) {
      expect(response.ok()).toBeTruthy();
      expect((await response.json()).id).toBe(aRun.id);
    }
    const conflict = await request.post(`/api/chats/${a.id}/runs`, {
      data: { ...command, idempotencyKey: 'other-request' },
    });
    expect(conflict.status()).toBe(409);
    // A changed setting while held must not alter the existing run snapshot.
    await storySettings(page);
    await page.getByLabel('서술 프리셋').selectOption('vivid');
    await page.getByRole('button', { name: '설정 저장', exact: true }).click();
    await expect
      .poll(async () => (await detail(request, a.id)).chat.settingsRevision)
      .toBe(a.settingsRevision + 1);
    await aSecondTab.getByRole('button', { name: '설정 저장', exact: true }).click();
    await expect(
      aSecondTab.getByRole('dialog', { name: '채팅 설정', exact: true }).getByRole('alert')
    ).toContainText('다른 요청이 먼저 반영됐어요');
    await aSecondTab.getByRole('button', { name: '저장된 설정 다시 불러오기' }).click();
    await expect(aSecondTab.getByRole('alert')).toHaveCount(0);
    expect((await detail(request, a.id)).runs[0].snapshot.settings.preset).toBe('calm');
    await page.close();
    await control(request, 'release', { barrier: 'run' });
    await expect.poll(async () => (await detail(request, a.id)).runs[0].status).toBe('completed');
    await expect.poll(async () => (await detail(request, b.id)).runs[0].status).toBe('completed');
    const aDone = await detail(request, a.id);
    const bDone = await detail(request, b.id);
    expect(aDone.sources).toHaveLength(1);
    expect(bDone.sources).toHaveLength(1);
    expect(aDone.runs[0].inputs[0].task).toContain('SYNTHETIC_A');
    expect(bDone.runs[0].inputs[0].task).toContain('SYNTHETIC_B');
    expect(JSON.stringify(aDone.runs[0].inputs)).not.toContain('SYNTHETIC_B');
    expect(JSON.stringify(bDone.runs[0].inputs)).not.toContain('SYNTHETIC_A');
    const aSource = aDone.sources[0];
    expect(
      aDone.jobs.every((j) => j.sourceRevision === aSource.id && j.status !== 'completed')
    ).toBeTruthy();
    // Original source is already readable while BOTH auxiliary workers remain held.
    await closeDialog(aSecondTab);
    await sourceDetails(aSecondTab);
    await expectSourceRaw(aSecondTab, aSource.text);
    expect(aDone.jobs.some((job) => job.kind === 'translation')).toBe(false);
    await aSecondTab.getByRole('button', { name: '번역 보기', exact: true }).click();
    await expect(aSecondTab.getByTestId('source').getByTestId('job-translation')).toContainText(
      '한국어 번역'
    );
    await aSecondTab.goto(`/?chat=${b.id}`); // same context's tab changes its own view only
    await expect(aSecondTab.getByRole('heading', { name: b.title, exact: true })).toBeVisible();
    await control(request, 'release', { barrier: 'status' });
    await expect
      .poll(async () => (await detail(request, a.id)).jobs.find((j) => j.kind === 'status')?.status)
      .toBe('completed');
    expect(
      (await detail(request, a.id)).jobs.find((j) => j.kind === 'translation')?.status
    ).not.toBe('completed');
    await control(request, 'release', { barrier: 'translation' });
    await expect
      .poll(async () => (await detail(request, a.id)).jobs.every((j) => j.status === 'completed'))
      .toBe(true);
    const returned = await context.newPage();
    await returned.goto(`/?chat=${a.id}`);
    await openWork(returned);
    await expect(returned.getByTestId('run')).toHaveAttribute('data-run-id', aRun.id);
    await closeDialog(returned);
    await sourceDetails(returned);
    await expectSourceRaw(returned, aSource.text);
    await expect(returned.getByTestId('source').getByTestId('job-status')).toHaveAttribute(
      'data-source-id',
      aSource.id
    );
    await expect(returned.getByTestId('source').getByTestId('job-translation')).toHaveAttribute(
      'data-source-id',
      aSource.id
    );
    await expect(aSecondTab.getByTestId('source')).toHaveAttribute(
      'data-source-id',
      bDone.sources[0].id
    );
    const stale = await request.post(`/api/chats/${a.id}/runs`, {
      data: {
        request: 'old head',
        expectedRevision: null,
        expectedSettingsRevision: aDone.chat.settingsRevision,
        idempotencyKey: 'stale-after-complete',
      },
    });
    expect(stale.status()).toBe(409);
    expect(
      await returned.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    ).toBeTruthy();
    if (visualReview)
      await returned.screenshot({ path: testInfo.outputPath('mobile-source.png'), fullPage: true });
    // Independent file connection, not a mocked API, verifies storage and logical uniqueness.
    const db = new DatabaseSync(process.env.NR_DB!, { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM runs WHERE chat_id=?').get(a.id)?.n).toBe(1);
      expect(db.prepare('SELECT text,hash FROM sources WHERE id=?').get(aSource.id)).toEqual({
        text: aSource.text,
        hash: createHash('sha256').update(aSource.text).digest('hex'),
      });
      expect(
        db
          .prepare(
            'SELECT count(*) AS n FROM job_results r JOIN jobs j ON j.id=r.job_id WHERE j.source_revision=?'
          )
          .get(aSource.id)?.n
      ).toBe(2);
    } finally {
      db.close();
    }
    if (process.env.NR_ARTIFACT_DIR) {
      await mkdir(join(process.env.NR_ARTIFACT_DIR, 'evidence'), { recursive: true });
      await writeFile(
        join(process.env.NR_ARTIFACT_DIR, 'evidence', 'browser-observations.json'),
        JSON.stringify(
          {
            a: await detail(request, a.id),
            b: await detail(request, b.id),
            browserErrors: errors,
            twoContexts: true,
            sameContextTwoTabs: true,
          },
          null,
          2
        )
      );
    }
    expect(errors).toEqual([]);
    await returned.close();
    await aSecondTab.close();
  } finally {
    for (const barrier of ['run', 'translation', 'status'])
      await control(request, 'release', { barrier });
    await other.close();
  }
});

test('F05 failed auxiliary result retries independently while a later source is selected', async ({
  page,
  request,
}) => {
  const chat = await newStatusChat(page, '합성 · 보조 재시도');
  await control(request, 'fail-next', { point: 'translation' });
  await send(page, 'SYNTHETIC_FIRST: A letter rests on the desk.');
  await expect(page.getByTestId('source')).toHaveCount(1);
  await page.getByRole('button', { name: '번역 보기', exact: true }).click();
  await sourceDetails(page);
  await expect(page.getByTestId('source').getByTestId('job-translation')).toContainText('실패');
  const before = await detail(request, chat.id);
  const source = before.sources[0];
  const failedJob = before.jobs.find((j) => j.kind === 'translation')!;
  await send(page, 'SYNTHETIC_SECOND: The letter remains sealed.');
  await expect(page.getByTestId('source')).toHaveCount(2);
  await sourceDetails(page);
  await control(request, 'hold', { barrier: 'translation' });
  await page
    .getByTestId('source')
    .getByTestId('job-translation')
    .filter({ hasText: '실패' })
    .getByRole('button', { name: '현재 설정으로 번역 재시도' })
    .click();
  await expect
    .poll(async () =>
      (await detail(request, chat.id)).jobs.some(
        (job) =>
          job.kind === 'translation' && job.sourceRevision === source.id && job.id !== failedJob.id
      )
    )
    .toBe(true);
  const retriedJob = (await detail(request, chat.id)).jobs.find(
    (job) => job.kind === 'translation' && job.sourceRevision === source.id
  )!;
  expect(retriedJob.id).not.toBe(failedJob.id);
  expect(retriedJob.revision).toBe(failedJob.revision! + 1);
  // Concurrent retry deliveries join the active new job for the original source.
  const repeated = await Promise.all([
    request.post(`/api/jobs/${failedJob.id}/retry`, { data: {} }),
    request.post(`/api/jobs/${failedJob.id}/retry`, { data: {} }),
  ]);
  for (const response of repeated) {
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).id).toBe(retriedJob.id);
  }
  await control(request, 'release', { barrier: 'translation' });
  await expect
    .poll(
      async () =>
        (await detail(request, chat.id)).jobs.find((job) => job.id === retriedJob.id)?.status
    )
    .toBe('completed');
  const after = await detail(request, chat.id);
  expect(after.runs).toHaveLength(2);
  expect(after.sources.find((s) => s.id === source.id)).toEqual({
    ...source,
    translationRevision: source.translationRevision! + 1,
  });
  const later = after.sources.find((s) => s.id !== source.id)!;
  expect(later.parentRevision).toBe(source.id);
  expect(after.jobs.find((j) => j.id === retriedJob.id)?.sourceRevision).toBe(source.id);
  const db = new DatabaseSync(process.env.NR_DB!, { readOnly: true });
  try {
    expect(db.prepare('SELECT status FROM jobs WHERE id=?').get(failedJob.id)?.status).toBe(
      'failed'
    );
  } finally {
    db.close();
  }
  expect(after.jobs.filter((j) => j.sourceRevision === source.id)).toHaveLength(2);
  expect(after.runs.find((r) => r.sourceRevision === later.id)?.inputs[0].history).toEqual([
    {
      revision: source.id,
      text: source.text,
      contentHash: source.hash,
      requestRanges: [{ start: 0, end: source.text.length }],
      excludedRanges: [],
    },
  ]);
});

test('F03 F05 an older real HTTP response cannot hide a newly committed source', async ({
  page,
  request,
}) => {
  const chat = await newStatusChat(page, '합성 · 역순 응답');
  // End the old document's SSE first: otherwise its last refresh can be
  // intercepted and then cancelled by navigation, so no delayed response arrives.
  await page.goto('about:blank');
  const pending = new Set<Request>();
  const readerPath = `/api/chats/${chat.id}/reader`;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === readerPath && request.method() === 'GET')
      pending.add(request);
  });
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const firstCaptured = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let first = true;
  await page.route(`**${readerPath}?**`, async (route) => {
    if (!first || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    first = false;
    const realResponse = await route.fetch();
    const realBody = await realResponse.body();
    captured();
    await barrier;
    await route.fulfill({
      status: realResponse.status(),
      body: realBody,
      headers: { ...realResponse.headers(), 'x-m0-delayed': 'true' },
    });
  });
  try {
    await page.goto(`/?chat=${chat.id}`, { waitUntil: 'domcontentloaded' });
    await firstCaptured;
    const response = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: 'SYNTHETIC delayed HTTP response',
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: 'reorder-source',
      },
    });
    expect(response.ok()).toBeTruthy();
    await expect(page.getByTestId('source')).toHaveCount(1);
    await page.getByRole('button', { name: '번역 보기', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await detail(request, chat.id)).jobs.some((job) => job.kind === 'translation') &&
          (await detail(request, chat.id)).jobs.every((j) => j.status === 'completed')
      )
      .toBe(true);
    const source = (await detail(request, chat.id)).sources[0];
    await sourceDetails(page);
    await expect(page.getByTestId('source').getByTestId('job-status')).toContainText('완료');
    await expect(page.getByTestId('source').getByTestId('job-translation')).toContainText('완료');
    await expect.poll(() => pending.size).toBe(1);
    // Deliver the stale network response after latest source/job events have ended.
    const delivered = page.waitForResponse((r) => r.headers()['x-m0-delayed'] === 'true');
    release();
    await (await delivered).finished();
    await expect.poll(() => pending.size).toBe(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await page.getByLabel('다음 장면 요청').fill('local draft after the stale response');
    await expectSourceRaw(page, source.text);
    await sourceDetails(page);
    await expect(page.getByTestId('source').getByTestId('job-status')).toContainText('완료');
  } finally {
    release();
    // On timeout the runner can already have closed the page. Preserve the
    // original assertion instead of masking it with a cleanup target-closed error.
    if (!page.isClosed())
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch((error) => {
        if (!page.isClosed()) throw error;
      });
  }
});
