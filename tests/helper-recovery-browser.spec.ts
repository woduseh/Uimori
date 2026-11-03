import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { MOBILE_HEIGHT, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { openHelper, openSourceActions } from './ui-navigation.js';

test('HELPREC01 failed draft reads preserve the old draft and selected source; failed saves remain visible and retryable', async ({
  page,
  request,
}, info) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `도우미 복구 ${randomUUID()}` } })
  ).json()) as Chat;
  const created = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '복구 검사의 합성 장면이에요.',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(created.ok()).toBe(true);
  const run = (await created.json()) as Run;
  await expect
    .poll(async () => {
      const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
      return detail.runs.find((item) => item.id === run.id)?.status;
    })
    .toBe('completed');
  const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  const input = panel.getByLabel('도우미에게 요청');
  await expect(input).toBeEnabled();
  const conversationId = await panel.getByLabel('도우미 대화 선택').inputValue();
  const original = '다시 불러와야 하는 기존 초안';
  const replacement = '저장 실패 뒤에도 남아야 하는 새 초안';
  const diskValue = () =>
    page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opened = indexedDB.open('uimori-editor-recovery', 1);
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
      return await new Promise<string | undefined>((resolve, reject) => {
        const read = db
          .transaction('buffers')
          .objectStore('buffers')
          .get(`helper:helper-input:${id}`);
        read.onsuccess = () => resolve(read.result?.model);
        read.onerror = () => reject(read.error);
      });
    }, conversationId);
  await input.fill(original);
  await expect.poll(diskValue).toBe(original);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();

  await page.addInitScript((id) => {
    const key = `helper:helper-input:${id}`;
    const get = IDBObjectStore.prototype.get;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.get = function (query) {
      if (query === key && localStorage.getItem('test-helper-read-fails') === '1')
        throw new DOMException('Synthetic read failure', 'UnknownError');
      return get.call(this, query);
    };
    IDBObjectStore.prototype.put = function (value, query) {
      if (query === key && localStorage.getItem('test-helper-write-fails') === '1')
        throw new DOMException('Synthetic write failure', 'QuotaExceededError');
      return put.call(this, value, query);
    };
  }, conversationId);
  await page.evaluate(() => localStorage.setItem('test-helper-read-fails', '1'));
  await page.reload();
  const article = page.locator(`[data-testid="source"][data-source-id="${detail.sources[0].id}"]`);
  await openSourceActions(article);
  await article.getByRole('button', { name: '도우미에게 물어보기' }).click();
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText('이 기기의 도우미 초안을 읽지 못했어요. 다시 불러와 주세요.')
  ).toBeVisible();
  await expect(input).toBeDisabled();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('helper-draft-read-failed.png') });
  await page.evaluate(() => localStorage.removeItem('test-helper-read-fails'));
  expect(await diskValue()).toBe(original);
  await panel.getByRole('button', { name: '초안 다시 불러오기' }).click();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue(original);
  await expect(panel.locator('.helper-selection')).toBeVisible();

  await page.evaluate(() => localStorage.setItem('test-helper-write-fails', '1'));
  await input.fill(replacement);
  await expect(panel.getByText(/도우미 초안을 기기에 저장하지 못했어요/)).toBeVisible();
  await expect(input).toHaveValue(replacement);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('helper-draft-save-failed.png') });
  await page.evaluate(() => localStorage.removeItem('test-helper-write-fails'));
  await panel.getByRole('button', { name: '다시 저장', exact: true }).click();
  await expect(panel.getByText(/도우미 초안을 기기에 저장하지 못했어요/)).toHaveCount(0);
  await expect.poll(diskValue).toBe(replacement);
  await page.reload();
  await openHelper(page);
  await expect(input).toHaveValue(replacement);
  await expect(panel.locator('.helper-selection')).toBeVisible();
});

async function handoffFixture(page: Page, request: APIRequestContext) {
  const response = await postFixtureChat(request, {
    data: { title: `도우미 전달 순서 ${randomUUID()}` },
  });
  expect(response.ok()).toBe(true);
  const chat = (await response.json()) as Chat;
  const writing = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '전달 순서를 확인할 합성 장면',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(writing.ok()).toBe(true);
  const run = (await writing.json()) as Run;
  await expect
    .poll(async () => {
      const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
      return detail.runs.find((item) => item.id === run.id)?.status;
    })
    .toBe('completed');
  const outline = await request.post(`/api/chats/${chat.id}/outline`, {
    data: {
      idempotencyKey: randomUUID(),
      operations: [
        {
          op: 'create',
          ref: 'chapter',
          level: 'episode',
          title: '나중에 선택한 구성',
          intent: '원래 초안을 보존해요.',
        },
      ],
    },
  });
  expect(outline.ok(), await outline.text()).toBe(true);
  const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  const picker = panel.getByLabel('도우미 대화 선택');
  const input = panel.getByLabel('도우미에게 요청');
  await expect(input).toBeEnabled();
  const first = await picker.inputValue();
  await input.fill('첫 대화의 기존 초안');
  await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
  await expect(picker).not.toHaveValue(first);
  const second = await picker.inputValue();
  await expect(input).toBeEnabled();
  await input.fill('두 번째 대화의 기존 초안');
  await picker.selectOption(first);
  await expect(input).toHaveValue('첫 대화의 기존 초안');
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(panel).toBeHidden();
  return { chat, panel, picker, input, first, second, sourceId: detail.sources[0].id };
}

async function delayHandoffOwner(page: Page, conversationId: string) {
  let entered!: () => void;
  let release!: () => void;
  let delivered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  let held = false;
  await page.route(`**/api/helper/conversations/${conversationId}`, async (route) => {
    if (route.request().method() !== 'GET' || held) return route.continue();
    held = true;
    entered();
    await gate;
    const response = await route.fetch();
    await route.fulfill({ response });
    delivered();
  });
  return { started, release, done };
}

async function askAboutSource(page: Page, sourceId: string) {
  const article = page.locator(`[data-testid="source"][data-source-id="${sourceId}"]`);
  await openSourceActions(article);
  await article.getByRole('button', { name: '도우미에게 물어보기' }).click();
}

async function settleHandoffResponse(page: Page, done: Promise<void>) {
  await done;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

test('HELPHANDOFF01 a late source handoff cannot undo a manual session selection', async ({
  page,
  request,
}) => {
  const f = await handoffFixture(page, request);
  const held = await delayHandoffOwner(page, f.first);
  try {
    await askAboutSource(page, f.sourceId);
    await held.started;
    await expect(f.panel).toBeVisible();
    await f.picker.selectOption(f.second);
    await expect(f.input).toHaveValue('두 번째 대화의 기존 초안');
    held.release();
    await settleHandoffResponse(page, held.done);
    await expect(f.picker).toHaveValue(f.second);
    await expect(f.input).toHaveValue('두 번째 대화의 기존 초안');
    await f.picker.selectOption(f.first);
    await expect(f.input).toHaveValue('첫 대화의 기존 초안');
    await expect(f.panel.locator('.helper-selection')).toHaveCount(0);
  } finally {
    held.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('HELPHANDOFF02 a newer outline handoff wins over an earlier delayed source handoff', async ({
  page,
  request,
}) => {
  const f = await handoffFixture(page, request);
  const held = await delayHandoffOwner(page, f.first);
  const posts: string[] = [];
  page.on('request', (item) => {
    if (
      item.method() === 'POST' &&
      /\/api\/helper\/conversations\/[^/]+\/messages$/u.test(new URL(item.url()).pathname)
    )
      posts.push(item.url());
  });
  try {
    await askAboutSource(page, f.sourceId);
    await held.started;
    await expect(f.panel).toBeVisible();
    await f.panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
    await expect(f.panel).toBeHidden();
    const chatMenu = page.locator('.chat-menu');
    await chatMenu.getByLabel('채팅 메뉴').click();
    await chatMenu.getByRole('button', { name: '계층형 플롯', exact: true }).click();
    const outline = page.locator('.outline-panel');
    await expect(outline).toBeVisible();
    await outline
      .locator('.outline-navigation .outline-title')
      .getByText('나중에 선택한 구성', { exact: true })
      .click();
    await outline.getByRole('button', { name: '상세화', exact: true }).click();
    await expect(f.panel.locator('.helper-outline-selection')).toContainText('나중에 선택한 구성');
    await expect(f.input).toHaveValue('첫 대화의 기존 초안');
    held.release();
    await settleHandoffResponse(page, held.done);
    await expect(f.panel.locator('.helper-outline-selection')).toContainText('나중에 선택한 구성');
    await expect(f.panel.locator('.helper-selection')).toHaveCount(0);
    await expect(f.input).toHaveValue('첫 대화의 기존 초안');
    expect(posts).toEqual([]);
  } finally {
    held.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
