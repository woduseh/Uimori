import { visualReview } from './fixtures/visual-review.js';
import { selectChatSettingsSection } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import type { Chat, ChatDetail, Run, Source } from '../core/types.js';
import type { StoryDetail } from '../core/story.js';
import type { AssetMetadata } from '../core/asset-manifest.js';

async function control(
  request: APIRequestContext,
  action: string,
  extra: Record<string, string> = {}
) {
  const response = await request.post('/api/test/control', { data: { action, ...extra } });
  expect(response.ok()).toBeTruthy();
}
async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function story(request: APIRequestContext, chatId: string): Promise<StoryDetail> {
  const response = await request.get(`/api/chats/${chatId}/story`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function create(page: Page, title: string): Promise<Chat> {
  const response = await postFixtureChat(page.request, { data: { title } });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return chat;
}
async function panel(page: Page) {
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  if (!(await dialog.isVisible()))
    await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await selectChatSettingsSection(page, '상태와 기억');
  const section = dialog.getByRole('region', { name: '이야기 상태와 기억', exact: true });
  await expect(
    section.getByRole('button', { name: '상태와 기억 설정 저장', exact: true })
  ).toBeVisible();
  return section;
}
async function open(section: Locator, title: RegExp) {
  const summary = section.locator('summary').filter({ hasText: title }).first();
  const parent = summary.locator('..');
  if ((await parent.getAttribute('open')) === null) await summary.click();
  return parent;
}
async function close(page: Page) {
  if (await page.getByRole('dialog').filter({ visible: true }).count())
    await page.keyboard.press('Escape');
}
async function send(page: Page, request: string): Promise<Run> {
  await close(page);
  await page.getByLabel('다음 장면 요청').fill(request);
  const received = page.waitForResponse(
    (response) =>
      /\/api\/chats\/[^/]+\/runs$/.test(response.url()) && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  const response = await received;
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function complete(request: APIRequestContext, chatId: string, runId: string) {
  await expect
    .poll(async () => (await detail(request, chatId)).runs.find((run) => run.id === runId)?.status)
    .toBe('completed');
  return (await detail(request, chatId)).sources.find((source) => source.runId === runId)!;
}
async function original(page: Page, source: Source) {
  const article = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  await expect(article).toBeVisible();
  const button = article.getByRole('button', { name: '원문 보기', exact: true });
  if (await button.count()) await button.click();
  await expect(article.getByTestId('source-text')).toContainText(source.text.split('\n')[0]);
  return article;
}
function storedSource(source: Source) {
  expect(process.env.NR_DB, 'Browser suite requires a fresh verifier-owned SQLite DB').toBeTruthy();
  const db = new DatabaseSync(process.env.NR_DB!, { readOnly: true });
  try {
    expect(db.prepare('SELECT text,hash FROM sources WHERE id=?').get(source.id)).toEqual({
      text: source.text,
      hash: source.hash,
    });
  } finally {
    db.close();
  }
}

test.afterEach(async ({ request }) => {
  for (const barrier of ['run', 'state', 'memory']) await control(request, 'release', { barrier });
});

test('S01 S02 state settings use synthetic rules, preserve readable original while waiting, then compile persisted state', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(45_000);
  const chat = await create(page, 'S01 S02 합성 항구 상태');
  const section = await panel(page);
  expect((await story(request, chat.id)).config.module).toBeNull();
  await open(section, /^합성 예제 살펴보기$/);
  await section.getByRole('button', { name: '합성 항구 예제를 초안에 넣기' }).click();
  await expect(section.getByRole('heading', { name: '저장 전 미리보기' })).toBeVisible();
  expect((await story(request, chat.id)).config.module).toBeNull(); // Preview is not activation.
  await section.getByLabel('기억 자동 정리 사용').check();
  await expect(section.getByLabel('상태 확인 모델')).toHaveValue('');
  await expect(section.getByLabel('기억 정리 모델')).toHaveValue('');
  await section.getByRole('button', { name: '상태와 기억 설정 저장', exact: true }).click();
  await expect.poll(async () => (await story(request, chat.id)).config.memory.enabled).toBe(true);
  await expect(section.getByRole('status')).toContainText('반영했어요.');
  await control(request, 'hold', { barrier: 'state' });
  try {
    const first = await send(page, 'SYNTHETIC_FIRST [[event:buy-ticket]]');
    const source = await complete(request, chat.id, first.id);
    const article = await original(page, source);
    await expect(article.getByTestId('source-text')).toContainText('[[event:buy-ticket]]');
    await expect
      .poll(async () =>
        (await story(request, chat.id)).jobs.some(
          (job) => job.kind === 'state' && job.status === 'running'
        )
      )
      .toBe(true);
    const second = await send(page, 'SYNTHETIC_SECOND The traveler waits beside the harbor.');
    expect(second.status).toBe('waiting_for_state');
    await expect(
      page.getByTestId('pending-run').getByTestId('turn-activity').locator(':scope > summary')
    ).toContainText('상태 정리 대기');
    await expect(article.getByTestId('source-text')).toContainText('SYNTHETIC_FIRST');
    await page.getByTestId('pending-run').scrollIntoViewIfNeeded();
    if (visualReview)
      await page.screenshot({
        path: testInfo.outputPath('S02-mobile-waiting-original.png'),
        fullPage: true,
      });
    await control(request, 'release', { barrier: 'state' });
    await complete(request, chat.id, second.id);
    const accepted = (await detail(request, chat.id)).runs.find((run) => run.id === second.id)!;
    expect(accepted.snapshot.story?.state?.values.coins).toBe(7);
    expect(accepted.inputs[0]).toMatchObject({
      state: { values: { coins: 7 }, sourceRevision: source.id },
    });
    await expect.poll(async () => (await story(request, chat.id)).state?.values.coins).toBe(7);
    await close(page);
    const firstArticle = await original(page, source);
    const values = await open(firstArticle, /^이 원고의 상태/);
    await expect(values.locator('dt', { hasText: /^coins$/ })).toBeVisible();
    await expect(values.locator('dd', { hasText: /^7$/ })).toBeVisible();
    storedSource(source);
    const db = new DatabaseSync(process.env.NR_DB!, { readOnly: true });
    try {
      const row = db
        .prepare(
          'SELECT body FROM story_states WHERE source_revision=? ORDER BY rowid DESC LIMIT 1'
        )
        .get(source.id);
      expect(JSON.parse(String(row?.body))).toMatchObject({
        sourceHash: source.hash,
        values: { coins: 7 },
      });
    } finally {
      db.close();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel(page);
    if (visualReview)
      await page.screenshot({
        path: testInfo.outputPath('S01-desktop-state-settings.png'),
        fullPage: true,
      });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  } finally {
    await control(request, 'release', { barrier: 'state' });
  }
});

test('S04 explicit author declaration and retcon remain distinct memory after reload', async ({
  page,
  request,
}, testInfo) => {
  const chat = await create(page, 'S04 합성 작가 선언');
  const section = await panel(page);
  const memory = await open(section, /^기억과 작가 선언/);
  await memory.getByLabel('선언 작성자').fill('합성 작가');
  await memory.getByLabel('새 작가 선언').fill('항구의 종은 파란색이다.');
  await memory.getByRole('button', { name: '작가 선언 추가', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await story(request, chat.id)).memory.filter((entry) => entry.kind === 'author-canon')
          .length
    )
    .toBe(1);
  await expect(memory.getByText('작가 선언', { exact: true })).toBeVisible();
  await memory.getByRole('button', { name: '이 선언 고치기', exact: true }).click();
  await memory.getByLabel('기존 선언을 대신할 작가 선언').fill('항구의 종은 초록색이다.');
  await memory.getByRole('button', { name: '수정 선언 저장', exact: true }).click();
  await expect
    .poll(async () => (await story(request, chat.id)).memory.map((entry) => entry.text))
    .toContain('항구의 종은 초록색이다.');
  expect(
    (await story(request, chat.id)).memory.some((entry) => entry.text === '항구의 종은 파란색이다.')
  ).toBe(false);
  await page.reload();
  const reloaded = await open(await panel(page), /^기억과 작가 선언/);
  await expect(reloaded.getByText('항구의 종은 초록색이다.', { exact: true })).toBeVisible();
  await expect(reloaded.getByText('항구의 종은 파란색이다.', { exact: true })).toHaveCount(0);
  expect(
    (await story(request, chat.id)).memory.find((entry) => entry.text === '항구의 종은 초록색이다.')
  ).toMatchObject({ kind: 'author-canon', declaration: { author: '합성 작가' } });
  if (visualReview)
    await page.screenshot({
      path: testInfo.outputPath('S04-mobile-author-memory.png'),
      fullPage: true,
    });
});

test('S06 scene commands distinguish successful original, failed original and cancelled reservation', async ({
  page,
  request,
}, testInfo) => {
  const chat = await create(page, 'S05 합성 장면 예약');
  async function add(label: string) {
    const commands = await open(await panel(page), /^장면 예약/);
    await commands.getByLabel('예약 이름').fill(label);
    await commands.getByLabel('장면 요청').fill(`SYNTHETIC_COMMAND ${label}`);
    await commands.getByRole('button', { name: '장면 예약 추가', exact: true }).click();
    await expect
      .poll(async () =>
        (await story(request, chat.id)).commands.some((item) => item.label === label)
      )
      .toBe(true);
    return commands.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });
  }
  const successful = await add('성공할 장면');
  await successful.getByRole('button', { name: '이 장면 쓰기', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await story(request, chat.id)).commands.find((item) => item.label === '성공할 장면')
          ?.status
    )
    .toBe('consumed');
  const sourceCount = (await detail(request, chat.id)).sources.length;
  expect(sourceCount).toBe(1);
  const failed = await add('실패할 장면');
  await control(request, 'fail-next', { point: 'source-transaction' });
  await failed.getByRole('button', { name: '이 장면 쓰기', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await story(request, chat.id)).commands.find((item) => item.label === '실패할 장면')
          ?.status
    )
    .toBe('failed');
  await expect(failed).toContainText('실패 · 재시도 가능');
  expect((await detail(request, chat.id)).sources).toHaveLength(sourceCount);
  const cancelled = await add('취소할 장면');
  await cancelled.getByRole('button', { name: '예약 취소', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await story(request, chat.id)).commands.find((item) => item.label === '취소할 장면')
          ?.status
    )
    .toBe('cancelled');
  await expect(cancelled).toContainText('취소됨');
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (visualReview)
    await page.screenshot({
      path: testInfo.outputPath('S05-desktop-command-outcomes.png'),
      fullPage: true,
    });
});

test('S06 S07 text presentation keeps malicious HTML inert and asset catalog transfers metadata without preloading bytes', async ({
  page,
  request,
}, testInfo) => {
  const chat = await create(page, 'S06 S07 합성 표현과 에셋');
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=';
  const uploadedIds = new Set<string>();
  for (let index = 0; index < 5; index++) {
    const response = await request.post(`/api/chats/${chat.id}/assets`, {
      data: {
        title: `합성 이미지 ${index}`,
        mime: 'image/png',
        base64: png,
        description: '작성자가 설명한 항구',
        actor: 'Mira',
        outfit: 'coat',
        location: 'harbor',
        allowedUse: 'inline',
      },
    });
    expect(response.ok()).toBeTruthy();
    uploadedIds.add(((await response.json()) as { id: string }).id);
  }
  expect(uploadedIds.size).toBe(5);
  const firstResponse = await request.get(
    `/api/chats/${chat.id}/asset-manifest?limit=2&actor=Mira&allowedUse=inline`
  );
  expect(firstResponse.ok()).toBeTruthy();
  const first = (await firstResponse.json()) as {
    items: AssetMetadata[];
    nextOffset: number | null;
    total: number;
  };
  expect(first.items).toHaveLength(2);
  expect(first.total).toBe(5);
  expect(first.nextOffset).toBe(2);
  expect(JSON.stringify(first)).not.toContain('base64');
  expect(JSON.stringify(first)).not.toContain(png);
  for (const item of first.items) {
    expect(item).not.toHaveProperty('url');
    expect(item).not.toHaveProperty('bytes');
  }
  const last = await (
    await request.get(`/api/chats/${chat.id}/asset-manifest?limit=2&offset=4`)
  ).json();
  expect(last.items).toHaveLength(1);
  expect(last.nextOffset).toBeNull();
  const item = first.items[0],
    ref = { id: item.id, revision: item.revision, hash: item.hash };
  const resolve = async (body: unknown) =>
    (await request.post(`/api/chats/${chat.id}/asset-manifest/resolve`, { data: body })).json();
  expect(await resolve({ ref, use: 'inline', actor: 'Mira', outfit: 'coat' })).toMatchObject({
    ok: true,
  });
  expect(await resolve({ ref: { ...ref, hash: 'stale' }, use: 'inline' })).toMatchObject({
    ok: false,
    fallback: 'no-image',
    error: 'ASSET_STALE',
  });
  expect(await resolve({ ref, use: 'profile' })).toMatchObject({
    ok: false,
    error: 'ASSET_USE_DENIED',
  });
  expect(await resolve({ ref, use: 'inline', outfit: 'gown' })).toMatchObject({
    ok: false,
    error: 'ASSET_COMBINATION_MISMATCH',
  });
  const loads: string[] = [];
  page.on('request', (response) => {
    if (/\/api\/assets\//.test(response.url())) loads.push(response.url());
  });
  await page.reload();
  const run = await send(page, 'SYNTHETIC_RENDER Mira waits at the harbor.');
  const source = await complete(request, chat.id, run.id);
  const article = await original(page, source);
  const preview = await open(article, /^표시 문구 바꾸기$/);
  const malicious =
    '<img src=x onerror="window.XSS=1"><script>window.XSS=2</script><iframe srcdoc="<script>parent.XSS=3</script>"></iframe>';
  await preview.getByLabel('찾을 정규식').fill('Mira');
  await preview.getByLabel('넣을 문자열').fill(malicious);
  await preview.getByRole('button', { name: '텍스트 미리보기', exact: true }).click();
  const rendered = preview.getByLabel('표시 문구 미리보기');
  await expect(rendered).toContainText(malicious);
  await expect(rendered.locator('script, img, iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { XSS?: number }).XSS)).toBeUndefined();
  expect(
    (await detail(request, chat.id)).sources.find((item) => item.id === source.id)
  ).toMatchObject({ text: source.text, hash: source.hash });
  storedSource(source);
  // The visible built-in profile is legitimately loaded. The five catalog-only uploads are not.
  const uploadedLoads = loads.filter((url) =>
    uploadedIds.has(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!))
  );
  await testInfo.attach('S07-asset-network-scope', {
    body: JSON.stringify(
      {
        uploadedIds: [...uploadedIds],
        allAssetRequests: loads,
        uploadedAssetRequests: uploadedLoads,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  expect(uploadedLoads).toEqual([]);
  if (visualReview)
    await page.screenshot({
      path: testInfo.outputPath('S06-mobile-inert-text-preview.png'),
      fullPage: true,
    });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('STUI01 state settings align on mobile and desktop while imported definitions remain drafts', async ({
  page,
  request,
}, info) => {
  const chat = await create(page, '상태 설정 배치 합성');
  const section = await panel(page);
  const fields = section.getByRole('group', { name: '다음 원고에 적용할 설정', exact: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await fields.scrollIntoViewIfNeeded();
    await expect(fields.getByText('상태 정의', { exact: true })).toBeVisible();
    await expect(fields.getByLabel('상태 정의 JSON 파일')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`story-settings-${width}.png`) });
  }
  await open(section, /합성 예제/);
  await section.getByRole('button', { name: '합성 항구 예제를 초안에 넣기' }).click();
  const module = JSON.parse(await section.locator('.story-module-preview pre').innerText());
  module.name = '파일로 불러온 상태';
  await fields.getByLabel('상태 정의 JSON 파일').setInputFiles({
    name: 'state.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(module)),
  });
  await expect(section.locator('.story-module-preview')).toContainText(module.name);
  expect((await story(request, chat.id)).config.module).toBeNull();
  const memory = fields.getByRole('switch', { name: '기억 자동 정리 사용' });
  await memory.check();
  await expect(memory).toBeChecked();
  await fields.getByRole('button', { name: '상태와 기억 설정 저장', exact: true }).click();
  await expect
    .poll(async () => (await story(request, chat.id)).config.module?.name)
    .toBe(module.name);
  expect((await story(request, chat.id)).config.memory.enabled).toBe(true);
});
