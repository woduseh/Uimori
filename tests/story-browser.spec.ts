import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { selectChatSettingsSection } from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';
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
  if (!(await dialog.isVisible())) await openChatSettings(page);
  await selectChatSettingsSection(page, '기억·로어');
  const section = dialog.getByRole('region', { name: '이야기 기억과 문맥', exact: true });
  await expect(section).toBeVisible();
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
  expect(
    process.env.UIMORI_DB,
    'Browser suite requires a fresh verifier-owned SQLite DB'
  ).toBeTruthy();
  const db = new DatabaseSync(process.env.UIMORI_DB!, { readOnly: true });
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
  await control(request, 'release', { barrier: 'run' });
});

test('S04 explicit user note and correction remain separate from prose after reload', async ({
  page,
  request,
}, testInfo) => {
  const chat = await create(page, 'S04 합성 사용자 메모');
  const notes = await open(await panel(page), /^사용자 메모·정정/);
  await notes.getByRole('button', { name: '메모 추가', exact: true }).click();
  await notes.getByLabel('메모 작성자').fill('합성 작가');
  await notes.getByLabel('메모·정정 내용').fill('항구의 종은 파란색이다.');
  await notes.getByRole('button', { name: '새 메모 저장', exact: true }).click();
  await expect.poll(async () => (await story(request, chat.id)).notes.length).toBe(1);
  await notes
    .getByRole('button', { name: '메모 수정: 항구의 종은 파란색이다.', exact: true })
    .click();
  await notes.getByLabel('메모·정정 내용').fill('항구의 종은 초록색이다.');
  await notes.getByRole('button', { name: '메모 수정 저장', exact: true }).click();
  await expect
    .poll(async () => (await story(request, chat.id)).notes.map((entry) => entry.text))
    .toEqual(['항구의 종은 초록색이다.']);
  await page.reload();
  const reloaded = await open(await panel(page), /^사용자 메모·정정/);
  await expect(reloaded.getByText('항구의 종은 초록색이다.', { exact: true })).toBeVisible();
  await expect(reloaded.getByText('항구의 종은 파란색이다.', { exact: true })).toHaveCount(0);
  expect((await story(request, chat.id)).notes[0]).toMatchObject({
    kind: 'author-note',
    declaration: { author: '합성 작가' },
  });
  if (visualReview)
    await page.screenshot({
      path: testInfo.outputPath('S04-mobile-author-notes.png'),
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
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  if (visualReview)
    await page.screenshot({
      path: testInfo.outputPath('S05-desktop-command-outcomes.png'),
      fullPage: true,
    });
});

test('S06 S07 reading preserves source text while the asset catalog does not preload bytes', async ({
  page,
  request,
}, testInfo) => {
  const chat = await create(page, 'S06 S07 합성 표현과 에셋');
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQCej5D8IMMAYAP7QHvSBXvZYAAAAASUVORK5CYII=';
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
  await expect(article.getByText('표시 문구 바꾸기', { exact: true })).toHaveCount(0);
  expect(source.text).toContain('Mira');
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
      path: testInfo.outputPath('S07-mobile-asset-catalog-reader.png'),
      fullPage: true,
    });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('STUI01 story memory and scene reservations fit mobile and desktop', async ({
  page,
}, info) => {
  await create(page, '기억과 메모 배치 합성');
  const section = await panel(page);
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 1000 });
    await section.scrollIntoViewIfNeeded();
    await expect(section.locator('summary').filter({ hasText: /^사용자 메모·정정/ })).toBeVisible();
    await expect(section.locator('summary').filter({ hasText: /^장면 예약/ })).toBeVisible();
    await expect(section.getByLabel('상태 정의 JSON 파일')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    if (visualReview) await page.screenshot({ path: info.outputPath(`story-memory-${width}.png`) });
  }
});
