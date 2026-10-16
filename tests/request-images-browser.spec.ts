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

for (const width of [360, 1440]) {
  test(`RIMAGE ${width} draft reload, translation, image-only generation and edited retry preserve attachments`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const chat = await createChat(request);
    await open(page, chat);
    await composer(page).fill('이미지의 옷차림을 참고해 줘.');
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    const choosingFile = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '참고 이미지 첨부', exact: true }).click();
    await (await choosingFile).setFiles(await image());
    await composer(page).click();
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
    await page.getByRole('button', { name: '입력 번역', exact: true }).click();
    await expect(composer(page)).toHaveValue('Use these clothes.');
    await expect(thumbnails(page)).toHaveCount(1);
    await composer(page).fill('');
    await expect(send(page)).toBeEnabled();
    const removeBounds = await page
      .getByRole('button', { name: 'reference.png 제거', exact: true })
      .boundingBox();
    expect(removeBounds).not.toBeNull();
    expect(removeBounds!.width).toBe(26);
    expect(removeBounds!.height).toBe(26);
    const formBounds = await page.locator('form.composer:visible').boundingBox();
    expect(formBounds!.x).toBeGreaterThanOrEqual(0);
    expect(formBounds!.x + formBounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath('reference-image-composer.png') });
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
    await page.getByRole('button', { name: '요청 편집', exact: true }).click();
    await page
      .getByRole('textbox', { name: '요청 수정 내용', exact: true })
      .fill('같은 옷차림으로 다시 이어 줘.');
    await page.getByRole('button', { name: '수정한 요청 보내기', exact: true }).click();
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
  await expect(
    page.getByRole('alert').filter({ hasText: '요청을 처리할 수 없어요. (400)' })
  ).toBeVisible();
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
  // Await the real stored tuple before making later storage writes unavailable.
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
          request.onsuccess = () => resolve(request.result?.model.images.length ?? 0);
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
  // Typing while deciding must not overwrite the only durable copy of earlier images.
  await composer(page).fill('선택하는 동안 다시 고친 최신 텍스트');
  await page.reload();
  await expect(composer(page)).toHaveValue('선택하는 동안 다시 고친 최신 텍스트');
  await page.getByRole('button', { name: '이전 첨부 복구', exact: true }).click();
  await expect(thumbnails(page)).toHaveCount(1);
  await expect(composer(page)).toHaveValue('선택하는 동안 다시 고친 최신 텍스트');
});

test('RIMAGE late acceptance in another chat preserves an edited-then-reverted draft after IndexedDB writes fail', async ({
  page,
  request,
}) => {
  const first = await createChat(request),
    second = await createChat(request);
  const text = '같은 문장이어도 다시 작성한 초안';
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chats/${first.id}/runs`, async (route) => {
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    started();
    await held;
    await route.fulfill({ response });
  });
  try {
    await open(page, first);
    await composer(page).fill(text);
    await page.getByLabel('참고 이미지 파일', { exact: true }).setInputFiles(await image());
    await expect(thumbnails(page)).toHaveCount(1);
    await send(page).click();
    await ready;
    // Newer text still reaches sessionStorage, while the durable tuple stays at the sent token.
    // Cleanup uses delete(), which remains available after these failed put() calls.
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
        if (this.name === 'buffers')
          throw new DOMException('Synthetic storage full', 'QuotaExceededError');
        return put.apply(this, args);
      };
    });
    await composer(page).fill('새로 고치는 중');
    await composer(page).fill(text);
    await expect(
      page.getByRole('alert').filter({ hasText: '초안을 기기에 저장하지 못했어요' })
    ).toBeVisible();
    await page.evaluate((id) => {
      history.pushState(null, '', '/?chat=' + id);
      dispatchEvent(new PopStateEvent('popstate'));
    }, second.id);
    await expect(composer(page)).toHaveValue('');
    release();
    // Observe completed cleanup before returning, rather than racing the late response.
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open('uimori-editor-recovery', 1);
            request.onsuccess = () => resolve(request.result);
          });
          return new Promise<boolean>((resolve) => {
            const request = db
              .transaction('buffers')
              .objectStore('buffers')
              .get(`request:${sessionStorage.getItem('uimori:request-draft-tab')}:draft:${id}`);
            request.onsuccess = () => resolve(request.result === undefined);
          });
        }, first.id)
      )
      .toBe(true);
    await page.evaluate((id) => {
      history.pushState(null, '', '/?chat=' + id);
      dispatchEvent(new PopStateEvent('popstate'));
    }, first.id);
    await expect(composer(page)).toHaveValue(text);
    await expect(send(page)).toBeEnabled();
    expect((await detail(request, first.id)).runs).toHaveLength(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('RIMAGE legacy pending text drafts clear after acceptance while another chat is open', async ({
  page,
  request,
}) => {
  const first = await createChat(request),
    second = await createChat(request);
  const payload = {
    request: '이미지 첨부 이전 버전에서 남은 요청',
    expectedRevision: null,
    expectedSettingsRevision: first.settingsRevision,
  };
  await page.addInitScript(
    ({ id, payload, key }) => {
      sessionStorage.setItem(`draft:${id}`, payload.request);
      sessionStorage.setItem(
        `command:${id}`,
        JSON.stringify({ id: key, payload: JSON.stringify(payload) })
      );
    },
    { id: first.id, payload, key: randomUUID() }
  );
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chats/${first.id}/runs`, async (route) => {
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    started();
    await held;
    await route.fulfill({ response });
  });
  try {
    await open(page, first);
    await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
    await page
      .getByRole('dialog', { name: '이전 요청 접수 확인', exact: true })
      .getByRole('button', { name: '접수 확인', exact: true })
      .click();
    await ready;
    await page.evaluate((id) => {
      history.pushState(null, '', '/?chat=' + id);
      dispatchEvent(new PopStateEvent('popstate'));
    }, second.id);
    await expect(composer(page)).toHaveValue('');
    release();
    await expect
      .poll(() => page.evaluate((id) => sessionStorage.getItem(`draft:${id}`), first.id))
      .toBeNull();
    await page.evaluate((id) => {
      history.pushState(null, '', '/?chat=' + id);
      dispatchEvent(new PopStateEvent('popstate'));
    }, first.id);
    await expect(composer(page)).toHaveValue('');
    expect((await detail(request, first.id)).runs).toHaveLength(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('RIMAGE accepted request never reappears after IndexedDB cleanup fails', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  await open(page, chat);
  await page.getByLabel('참고 이미지 파일', { exact: true }).setInputFiles(await image());
  await expect(thumbnails(page)).toHaveCount(1);
  // A read after the queued write observes the saved Blob; subsequent cleanup is denied.
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('uimori-editor-recovery', 1);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const request = db
        .transaction('buffers')
        .objectStore('buffers')
        .get(`request:${sessionStorage.getItem('uimori:request-draft-tab')}:draft:${id}`);
      request.onsuccess = () => resolve();
    });
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      if (args[1] === 'readwrite')
        throw new DOMException('Synthetic cleanup failure', 'UnknownError');
      return transaction.apply(this, args);
    };
  }, chat.id);
  await send(page).click();
  await expect.poll(async () => (await detail(request, chat.id)).runs[0]?.status).toBe('completed');
  await expect(thumbnails(page)).toHaveCount(0);
  await page.reload();
  await expect(composer(page)).toHaveValue('');
  await expect(thumbnails(page)).toHaveCount(0);
  await expect(send(page)).toBeDisabled();
  expect((await detail(request, chat.id)).runs).toHaveLength(1);
});

test('RIMAGE expired unaccepted upload releases the pending command and an explicit send uploads again', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  const calls: { idempotencyKey: string; requestImages: { uploadId: string }[] }[] = [];
  await page.route(`**/api/chats/${chat.id}/runs`, async (route) => {
    calls.push(route.request().postDataJSON());
    if (calls.length === 1) await route.abort('failed');
    else if (calls.length === 2)
      await route.fulfill({ status: 404, json: { error: '첨부 업로드가 만료됐어요.' } });
    else await route.continue();
  });
  await open(page, chat);
  await page.getByLabel('참고 이미지 파일', { exact: true }).setInputFiles(await image());
  await expect(thumbnails(page)).toHaveCount(1);
  await send(page).click();
  await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await page
    .getByRole('dialog', { name: '이전 요청 접수 확인', exact: true })
    .getByRole('button', { name: '접수 확인', exact: true })
    .click();
  await expect(send(page)).toBeEnabled();
  await expect(thumbnails(page)).toHaveCount(1);
  await send(page).click();
  await expect.poll(async () => (await detail(request, chat.id)).runs[0]?.status).toBe('completed');
  expect(calls).toHaveLength(3);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[2].idempotencyKey).not.toBe(calls[0].idempotencyKey);
  expect(calls[2].requestImages[0].uploadId).not.toBe(calls[0].requestImages[0].uploadId);
  expect((await detail(request, chat.id)).runs).toHaveLength(1);
});

test('RIMAGE pasted and dropped images preserve order, and invalid files preserve the draft', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  await open(page, chat);
  const source = (await image()).buffer.toString('base64');
  for (const kind of ['paste', 'drop'] as const) {
    await composer(page).evaluate(
      (input, { source, kind }) => {
        const bytes = Uint8Array.from(atob(source), (value) => value.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], `${kind}.png`, { type: 'image/png' }));
        input.dispatchEvent(
          kind === 'paste'
            ? new ClipboardEvent('paste', {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
        );
      },
      { source, kind }
    );
    await expect(thumbnails(page)).toHaveCount(kind === 'paste' ? 1 : 2);
  }
  await composer(page).fill('첨부 순서를 보존해 줘.');
  await page.getByLabel('참고 이미지 파일', { exact: true }).setInputFiles({
    name: 'bad.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not an image'),
  });
  await expect(page.getByRole('alert').filter({ hasText: 'PNG, JPEG, 정지 WebP' })).toBeVisible();
  await expect(thumbnails(page)).toHaveCount(2);
  await send(page).click();
  await expect.poll(async () => (await detail(request, chat.id)).runs[0]?.status).toBe('completed');
  expect(
    (await detail(request, chat.id)).runs[0].snapshot.requestImages?.map((image) => image.name)
  ).toEqual(['paste.png', 'drop.png']);
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

test('RIMAGE opener tabs inherit the initial draft and then preserve their own images independently', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  await open(page, chat);
  await composer(page).fill('원래 탭의 초안');
  await page
    .getByLabel('참고 이미지 파일', { exact: true })
    .setInputFiles(await image('first.png'));
  await expect(thumbnails(page)).toHaveCount(1);
  const firstTab = await page.evaluate(() => sessionStorage.getItem('uimori:request-draft-tab'));
  // A same-origin opener copies sessionStorage, including its draft namespace UUID.
  const opened = page.waitForEvent('popup');
  await page.evaluate((id) => {
    window.open('/?chat=' + id, '_blank');
  }, chat.id);
  const second = await opened;
  try {
    await expect(composer(second)).toHaveValue('원래 탭의 초안');
    await expect(thumbnails(second)).toHaveCount(1);
    await composer(second).fill('새 탭에서 고친 초안');
    await second
      .getByLabel('참고 이미지 파일', { exact: true })
      .setInputFiles(await image('second.png'));
    await expect(thumbnails(second)).toHaveCount(2);
    const secondTab = await second.evaluate(() =>
      sessionStorage.getItem('uimori:request-draft-tab')
    );
    expect(secondTab).not.toBe(firstTab);
    await composer(page).fill('원래 탭에서 다시 고친 초안');
    await page.reload();
    await expect(composer(page)).toHaveValue('원래 탭에서 다시 고친 초안');
    expect(await page.evaluate(() => sessionStorage.getItem('uimori:request-draft-tab'))).toBe(
      firstTab
    );
    await expect(thumbnails(page)).toHaveCount(1);
    await second.reload();
    await expect(composer(second)).toHaveValue('새 탭에서 고친 초안');
    await expect(thumbnails(second)).toHaveCount(2);
    expect(await second.evaluate(() => sessionStorage.getItem('uimori:request-draft-tab'))).toBe(
      secondTab
    );
    await expect(second.getByRole('button', { name: '이전 첨부 복구', exact: true })).toHaveCount(
      0
    );
    await second.getByRole('button', { name: 'first.png 제거', exact: true }).click();
    await expect(thumbnails(second)).toHaveCount(1);
    await page.reload();
    await expect(thumbnails(page)).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'first.png 확대', exact: true })).toBeVisible();
    await second.reload();
    await expect(thumbnails(second)).toHaveCount(1);
    await expect(
      second.getByRole('button', { name: 'second.png 확대', exact: true })
    ).toBeVisible();
  } finally {
    await second.close();
  }
});
