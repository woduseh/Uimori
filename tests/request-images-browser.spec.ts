import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Chat, ChatDetail } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';

const composer = (page: Page) => page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '원문 생성', exact: true });
const thumbnails = (page: Page) => page.locator('.draft-request-images .request-image-open');
async function createChat(request: APIRequestContext) {
  const response = await postFixtureChat(request, {
    data: { title: `Reference image ${randomUUID()}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Chat>;
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  return (await request.get(`/api/chats/${id}`)).json();
}
async function image(name = 'reference.png') {
  return {
    name,
    mimeType: 'image/png',
    buffer: await sharp({ create: { width: 64, height: 48, channels: 3, background: '#bc9147' } })
      .png()
      .toBuffer(),
  };
}
async function open(page: Page, chat: Chat) {
  await page.goto(`/?chat=${chat.id}`);
  await expect(composer(page)).toBeEnabled();
}

for (const width of [360]) {
  test(`RIMAGE ${width} draft reload, translation, image-only generation and edited retry preserve attachments`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const chat = await createChat(request);
    await open(page, chat);
    await composer(page).fill('이미지의 옷차림을 참고해 줘.');
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    const choosingFile = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '참고 이미지 첨부', exact: true }).click();
    await (await choosingFile).setFiles(await image());
    await expect(page.getByRole('button', { name: '입력창 더보기', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await expect(thumbnails(page)).toHaveCount(1);
    await page.reload();
    await expect(composer(page)).toHaveValue('이미지의 옷차림을 참고해 줘.');
    await expect(thumbnails(page)).toHaveCount(1);
    await thumbnails(page).click();
    const viewer = page.getByRole('dialog', { name: 'reference.png', exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('img')).toBeVisible();
    await viewer.press('Escape');
    await page.route('**/api/chats/*/input-translation', (route) =>
      route.fulfill({ json: { text: 'Use these clothes.', targetLanguage: 'en' } })
    );
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await page.getByRole('button', { name: '입력 번역', exact: true }).click();
    await expect(composer(page)).toHaveValue('Use these clothes.');
    await expect(thumbnails(page)).toHaveCount(1);
    await composer(page).fill('');
    await expect(send(page)).toBeEnabled();
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '다음 요청 미리보기', exact: true })
    ).toBeEnabled();
    await page.keyboard.press('Escape');
    await send(page).click();
    await expect
      .poll(async () => (await detail(request, chat.id)).runs[0]?.status)
      .toBe('completed');
    const first = (await detail(request, chat.id)).runs[0];
    expect(first.request).toBe('');
    expect(first.snapshot.requestImages).toMatchObject([
      { name: 'reference.png', width: 64, height: 48 },
    ]);
    await expect(thumbnails(page)).toHaveCount(0);
    await expect(
      page.getByTestId('source-request').getByRole('img', { name: 'reference.png', exact: true })
    ).toBeVisible();
    await page.getByRole('button', { name: '다시 쓰기', exact: true }).first().click();
    await page
      .getByRole('textbox', { name: '다시 쓸 요청', exact: true })
      .fill('같은 옷차림으로 다시 이어 줘.');
    await page.getByRole('button', { name: '새 채팅에서 다시 요청', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(chat.id);
    const copied = new URL(page.url()).searchParams.get('chat')!;
    await expect
      .poll(async () => (await detail(request, copied)).runs[0]?.status)
      .toBe('completed');
    expect((await detail(request, copied)).runs[0].snapshot.requestImages).toEqual(
      first.snapshot.requestImages
    );
    await page.reload();
    await expect(thumbnails(page)).toHaveCount(0);
    await expect(
      page.getByTestId('source-request').getByRole('img', { name: 'reference.png', exact: true })
    ).toBeVisible();
  });
}

test('RIMAGE image-only uncertain admission keeps exact upload refs across reload and preserves a newer image draft', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  const calls: unknown[] = [];
  await page.route(`**/api/chats/${chat.id}/runs`, async (route) => {
    calls.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (calls.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await open(page, chat);
  await page.getByLabel('참고 이미지 파일', { exact: true }).setInputFiles(await image());
  await expect(thumbnails(page)).toHaveCount(1);
  await send(page).click();
  const confirm = () => page.getByRole('button', { name: '이전 요청 확인', exact: true });
  await expect(confirm()).toBeVisible();
  await page.reload();
  await expect(thumbnails(page)).toHaveCount(1);
  await composer(page).fill('새로 작성하는 다음 요청');
  await page.getByLabel('참고 이미지 파일', { exact: true }).setInputFiles(await image('next.png'));
  await expect(thumbnails(page)).toHaveCount(2);
  await confirm().click();
  await page
    .getByRole('dialog', { name: '이전 요청 접수 확인', exact: true })
    .getByRole('button', { name: '접수 확인', exact: true })
    .click();
  await expect(composer(page)).toHaveValue('새로 작성하는 다음 요청');
  await expect(thumbnails(page)).toHaveCount(2);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect((await detail(request, chat.id)).runs).toHaveLength(1);
  await page.reload();
  await expect(composer(page)).toHaveValue('새로 작성하는 다음 요청');
  await expect(thumbnails(page)).toHaveCount(2);
});

test('RIMAGE rejected submission and another tab do not lose or inherit a local image draft', async ({
  page,
  request,
  context,
}) => {
  const chat = await createChat(request);
  await open(page, chat);
  await composer(page).fill('보존할 초안');
  await page.getByLabel('참고 이미지 파일', { exact: true }).setInputFiles(await image());
  await expect(thumbnails(page)).toHaveCount(1);
  const other = await context.newPage();
  await open(other, chat);
  await expect(composer(other)).toHaveValue('');
  await expect(thumbnails(other)).toHaveCount(0);
  await other.close();
  await page.route(`**/api/chats/${chat.id}/runs`, (route) =>
    route.fulfill({ status: 400, json: { error: 'Rejected image fixture' } })
  );
  await send(page).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.reload();
  await expect(composer(page)).toHaveValue('보존할 초안');
  await expect(thumbnails(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'reference.png 제거', exact: true }).click();
  await expect(thumbnails(page)).toHaveCount(0);
  await page.reload();
  await expect(composer(page)).toHaveValue('보존할 초안');
  await expect(thumbnails(page)).toHaveCount(0);
});

test('RIMAGE failed IndexedDB writes retain latest text and offer the previous attachments explicitly', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  await open(page, chat);
  await composer(page).fill('처음 텍스트');
  await page.getByLabel('참고 이미지 파일', { exact: true }).setInputFiles(await image());
  await expect(thumbnails(page)).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = indexedDB.open('uimori-editor-recovery', 1);
          request.onsuccess = () => resolve(request.result);
        });
        const key = `request:${sessionStorage.getItem('uimori:request-draft-tab')}:draft:${id}`;
        return new Promise<number>((resolve) => {
          const request = db.transaction('buffers').objectStore('buffers').get(key);
          request.onsuccess = () => resolve(request.result?.model.imageIds.length ?? 0);
        });
      }, chat.id)
    )
    .toBe(1);
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      if (args[1] === 'readwrite')
        throw new DOMException('Synthetic storage full', 'QuotaExceededError');
      return transaction.apply(this, args);
    };
  });
  await composer(page).fill('저장 실패 직전의 최신 텍스트');
  await expect(
    page.getByRole('alert').filter({ hasText: '초안을 기기에 저장하지 못했어요' })
  ).toBeVisible();
  await page.reload();
  await expect(composer(page)).toHaveValue('저장 실패 직전의 최신 텍스트');
  await expect(thumbnails(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '이전 첨부 복구', exact: true })).toBeVisible();
  await composer(page).fill('선택하는 동안 다시 고친 최신 텍스트');
  await page.reload();
  await expect(composer(page)).toHaveValue('선택하는 동안 다시 고친 최신 텍스트');
  await page.getByRole('button', { name: '이전 첨부 복구', exact: true }).click();
  await expect(thumbnails(page)).toHaveCount(1);
  await expect(composer(page)).toHaveValue('선택하는 동안 다시 고친 최신 텍스트');
});

test('RIMAGE leaving a chat during upload keeps late failures in the original scope and retains its draft', async ({
  page,
  request,
}) => {
  const first = await createChat(request),
    second = await createChat(request);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/uploads', async (route) => {
    started();
    await held;
    await route.fulfill({ status: 503, json: { error: 'Synthetic upload failure' } });
  });
  await open(page, first);
  await composer(page).fill('이 채팅에만 남을 초안');
  await page.getByLabel('참고 이미지 파일', { exact: true }).setInputFiles(await image());
  await expect(thumbnails(page)).toHaveCount(1);
  await send(page).click();
  await ready;
  try {
    await page.evaluate((id) => {
      history.pushState(null, '', '/?chat=' + id);
      dispatchEvent(new PopStateEvent('popstate'));
    }, second.id);
    await expect(composer(page)).toHaveValue('');
    const failedUpload = page.waitForResponse((response) =>
      response.url().endsWith('/api/uploads')
    );
    release();
    await failedUpload;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(send(page)).toBeDisabled();
    await expect(
      page.getByRole('alert').filter({ hasText: '서버 작업을 완료하지 못했어요.' })
    ).toHaveCount(0);
    await open(page, first);
    await expect(composer(page)).toHaveValue('이 채팅에만 남을 초안');
    await expect(thumbnails(page)).toHaveCount(1);
    expect((await detail(request, first.id)).runs).toHaveLength(0);
    expect((await detail(request, second.id)).runs).toHaveLength(0);
  } finally {
    release();
  }
});
