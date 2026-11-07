import {
  MOBILE_HEIGHT,
  MOBILE_WIDTH,
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
} from './fixtures/browser-viewports.js';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { openHelper } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';

test('AUDIT2 helper deletion clears a recovered read error and keeps a rejected delete across successful polls', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, {
    data: { title: `세션 삭제 오류 구분 ${randomUUID()}` },
  });
  expect(created.ok()).toBe(true);
  const chat = (await created.json()) as Chat;
  const generated = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: 'Synthetic scene: preserve this manuscript while reviewing helper deletion.',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: `helper-deletion-${chat.id}`,
    },
  });
  expect(generated.ok()).toBe(true);
  const run = (await generated.json()) as Run;
  await expect
    .poll(async () => {
      const current = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
      return current.runs.find((item) => item.id === run.id)?.status;
    })
    .toBe('completed');
  const manuscript = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  expect(manuscript.sources).toHaveLength(1);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  const input = panel.getByLabel('도우미에게 요청');
  await expect(input).toBeEnabled();
  await input.fill('삭제 검토 중에도 유지할 초안');
  const session = await panel.getByLabel('도우미 대화 선택').inputValue();
  let releaseInitial = () => {};
  const initial = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  let releaseRecovery = () => {};
  const recovery = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  let reads = 0;
  let successfulReads = 0;
  let deleteRequests = 0;
  const deleteFailure = '세션 삭제를 완료하지 못했어요. 먼저 작업 상태를 확인해 주세요.';
  await page.route(`**/api/helper/conversations/${session}/deletion`, async (route) => {
    reads++;
    if (reads === 1) {
      await initial;
      await route.fulfill({ status: 503, json: { error: 'SYNTHETIC_DELETION_READ_FAILURE' } });
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await recovery;
    await route.fulfill({ response });
    successfulReads++;
  });
  await page.route(`**/api/helper/conversations/${session}`, async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    deleteRequests++;
    await route.fulfill({ status: 409, json: { error: deleteFailure } });
  });
  try {
    await panel.getByLabel('도우미 대화 관리', { exact: true }).click();
    await panel.getByRole('button', { name: '대화 삭제', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: '도우미 대화 삭제', exact: true });
    const remove = dialog.getByRole('button', { name: '대화 영구 삭제', exact: true });
    await expect(dialog.getByRole('status')).toContainText('삭제할 자료와 진행 중인 작업');
    await expect(remove).toBeDisabled();
    releaseInitial();
    await expect(dialog.getByRole('alert')).toContainText('(503)');
    if (visualReview)
      await page.screenshot({ path: info.outputPath('helper-deletion-read-failed-412.png') });
    releaseRecovery();
    await expect.poll(() => successfulReads).toBeGreaterThan(0);
    await expect(dialog).toContainText(
      '이 도우미 대화를 삭제해요. 진행 중인 작업은 먼저 중지해 주세요.'
    );
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(remove).toBeEnabled();
    expect(deleteRequests).toBe(0);
    await remove.click();
    await expect(dialog.getByRole('alert')).toHaveText(deleteFailure);
    const afterFailure = successfulReads;
    await expect.poll(() => successfulReads).toBeGreaterThan(afterFailure);
    await expect(dialog.getByRole('alert')).toHaveText(deleteFailure);
    expect(deleteRequests).toBe(1);
    if (visualReview)
      await page.screenshot({ path: info.outputPath('helper-deletion-operation-failed-412.png') });
    await dialog.getByRole('button', { name: '계속 사용', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(input).toHaveValue('삭제 검토 중에도 유지할 초안');
    expect((await request.get(`/api/helper/conversations/${session}`)).ok()).toBe(true);
    const preserved = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
    expect(preserved.sources).toEqual(manuscript.sources);
    expect(preserved.runs).toEqual(manuscript.runs);
  } finally {
    releaseInitial();
    releaseRecovery();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('HSESSION09 copy conflict keeps the helper menu usable on a narrow screen', async ({
  page,
  request,
}) => {
  const created = await postFixtureChat(request, {
    data: { title: `도우미 복사 충돌 ${randomUUID()}` },
  });
  expect(created.ok()).toBe(true);
  const chat = (await created.json()) as Chat;
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  const input = panel.getByLabel('도우미에게 요청', { exact: true });
  await expect(input).toBeEnabled();
  await input.fill('복사 충돌 중에도 남길 초안');
  const picker = panel.getByLabel('도우미 대화 선택', { exact: true });
  const session = await picker.inputValue();
  await page.route(`**/api/helper/conversations/${session}/copy`, async (route) => {
    const payload = route.request().postDataJSON();
    const changed = await request.patch(`/api/helper/conversations/${session}`, {
      data: { expectedRevision: payload.expectedRevision, title: '복사 전에 바뀐 대화' },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    await route.continue();
  });
  const menu = panel.getByLabel('도우미 대화 관리', { exact: true });
  await menu.click();
  const response = page.waitForResponse((value) =>
    value.url().endsWith(`/api/helper/conversations/${session}/copy`)
  );
  await panel.getByRole('button', { name: '대화 복사', exact: true }).click();
  expect((await response).status()).toBe(409);
  const notice = panel.getByRole('alert');
  await expect(notice).toHaveText('도우미 대화가 바뀌었어요. 다시 복사해 주세요.');
  await expect(input).toHaveValue('복사 충돌 중에도 남길 초안');
  const close = panel.getByRole('button', { name: '도우미 닫기', exact: true });
  const [noticeBox, menuBox, pickerBox, closeBox] = await Promise.all([
    notice.boundingBox(),
    menu.boundingBox(),
    picker.boundingBox(),
    close.boundingBox(),
  ]);
  expect(noticeBox).not.toBeNull();
  for (const control of [menuBox, pickerBox, closeBox]) {
    expect(control?.width).toBeGreaterThan(0);
    expect(control!.x).toBeGreaterThanOrEqual(0);
    expect(control!.x + control!.width).toBeLessThanOrEqual(321);
    expect(noticeBox!.y).toBeGreaterThanOrEqual(control!.y + control!.height - 1);
  }
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: '대화 복사', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('복사 충돌 중에도 남길 초안');
});

test('HSESSION01 sessions retain their own drafts after switching and reload, rename and delete only the selected session', async ({
  page,
  request,
}, info) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `세션 분리 ${randomUUID()}` } })
  ).json()) as Chat;
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  const input = panel.getByLabel('도우미에게 요청');
  await expect(input).toBeEnabled();
  await expect(panel.getByRole('heading', { name: '채팅 도우미', exact: true })).toBeVisible();
  const picker = panel.getByLabel('도우미 대화 선택');
  const first = await picker.inputValue();
  await input.fill('첫 세션에 남겨 둘 초안');
  await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
  await expect(picker).not.toHaveValue(first);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('');
  const second = await picker.inputValue();
  await input.fill('두 번째 세션 초안');
  await picker.selectOption(first);
  await expect(input).toHaveValue('첫 세션에 남겨 둘 초안');
  await picker.selectOption(second);
  await expect(input).toHaveValue('두 번째 세션 초안');
  await panel.getByLabel('도우미 대화 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '대화 이름 변경', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '도우미 대화 이름 변경' });
  await rename.getByLabel('대화 이름', { exact: true }).fill('다른 결말 검토');
  await rename.getByRole('button', { name: '이름 저장', exact: true }).click();
  await expect(rename).toBeHidden();
  await expect(picker.locator('option:checked')).toContainText('다른 결말 검토');
  await page.reload();
  await openHelper(page);
  await expect(picker).toHaveValue(second);
  await expect(input).toHaveValue('두 번째 세션 초안');
  for (const width of [DESKTOP_WIDTH, 1280, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(panel).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`helper-sessions-${width}.png`) });
  }
  if (visualReview)
    for (const viewport of [
      { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
      { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
    ]) {
      await page.setViewportSize(viewport);
      await page.screenshot({
        path: info.outputPath(`helper-session-${viewport.width}x${viewport.height}.png`),
      });
    }
  if (!visualReview) await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  const deletion = page.getByRole('alertdialog', { name: '도우미 대화 삭제', exact: true });
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 900 });
    for (const dismissal of ['continue', 'Escape', 'backdrop'] as const) {
      await panel.getByLabel('도우미 대화 관리', { exact: true }).click();
      await panel.getByRole('button', { name: '대화 삭제', exact: true }).click();
      await expect(deletion).toContainText(
        '이 도우미 대화를 삭제해요. 진행 중인 작업은 먼저 중지해 주세요.'
      );
      const cancel = deletion.getByRole('button', { name: '계속 사용', exact: true });
      const remove = deletion.getByRole('button', { name: '대화 영구 삭제', exact: true });
      await expect(remove).toBeEnabled();
      const cancelBox = (await cancel.boundingBox())!;
      const removeBox = (await remove.boundingBox())!;
      expect(cancelBox.height).toBeGreaterThanOrEqual(44);
      expect(removeBox.height).toBeGreaterThanOrEqual(44);
      expect(removeBox.x).toBeGreaterThan(cancelBox.x);
      expect(await remove.evaluate((node) => getComputedStyle(node).marginRight)).toBe('0px');
      await expect(remove).toHaveClass(/delete-button/);
      if (dismissal === 'continue') {
        await page.screenshot({ path: info.outputPath(`helper-delete-${width}.png`) });
        await cancel.click();
      } else if (dismissal === 'Escape') await page.keyboard.press('Escape');
      else await page.mouse.click(8, 8);
      await expect(deletion).toBeHidden();
      await expect(input).toHaveValue('두 번째 세션 초안');
      expect((await request.get(`/api/helper/conversations/${second}`)).ok()).toBe(true);
    }
  }
  await panel.getByLabel('도우미 대화 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '대화 삭제', exact: true }).click();
  await deletion.getByRole('button', { name: '대화 영구 삭제', exact: true }).click();
  await expect(deletion).toBeHidden();
  await expect(picker).toHaveValue(first);
  await expect(input).toHaveValue('첫 세션에 남겨 둘 초안');
  expect((await request.get(`/api/helper/conversations/${second}`)).status()).toBe(404);
  expect((await request.get(`/api/helper/conversations/${first}`)).ok()).toBe(true);
});

test('HSESSION03 a delayed session creation does not replace a later user selection or draft', async ({
  page,
  request,
}) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `늦은 세션 응답 ${randomUUID()}` } })
  ).json()) as Chat;
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel'),
    input = panel.getByLabel('도우미에게 요청');
  const picker = panel.getByLabel('도우미 대화 선택');
  await expect(input).toBeEnabled();
  const first = await picker.inputValue();
  await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
  await expect(picker).not.toHaveValue(first);
  await expect(input).toBeEnabled();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = false;
  let fulfilled = false;
  await page.route('**/api/helper/conversations/new', async (route) => {
    const response = await route.fetch();
    received = true;
    await held;
    await route.fulfill({ response });
    fulfilled = true;
  });
  try {
    await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
    await expect.poll(() => received).toBe(true);
    await picker.selectOption(first);
    await input.fill('응답을 기다리는 동안 내가 선택한 초안');
    release();
    await expect.poll(() => fulfilled).toBe(true);
    await expect(panel.getByRole('button', { name: '새 도우미 대화', exact: true })).toBeEnabled();
    await expect(picker).toHaveValue(first);
    await expect(input).toHaveValue('응답을 기다리는 동안 내가 선택한 초안');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('HSESSION04 current helper input survives reload and navigation without reading old local storage', async ({
  page,
  request,
}) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `초안 이전 ${randomUUID()}` } })
  ).json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel'),
    input = panel.getByLabel('도우미에게 요청');
  await expect(input).toBeEnabled();
  const picker = panel.getByLabel('도우미 대화 선택');
  const first = await picker.inputValue();
  await page.evaluate(
    (id) => localStorage.setItem(`uimori:helper-input:${id}`, '이전 저장소의 초안'),
    first
  );
  await page.reload();
  await openHelper(page);
  await expect(input).toHaveValue('');
  expect(
    await page.evaluate((id) => localStorage.getItem(`uimori:helper-input:${id}`), first)
  ).toBe('이전 저장소의 초안');
  await input.fill('새로 입력한 원고');
  await page.reload();
  await openHelper(page);
  await expect(input).toHaveValue('새로 입력한 원고');
  await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
  await expect(input).toHaveValue('');
  await picker.selectOption(first);
  await expect(input).toHaveValue('새로 입력한 원고');
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await openHelper(page);
  await expect(input).toHaveValue('새로 입력한 원고');
});

test('HSESSION05 a full localStorage uses sessionStorage to create a session and clears the request after success', async ({
  page,
  request,
}) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `생성 저장소 대체 ${randomUUID()}` } })
  ).json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
  const picker = panel.getByLabel('도우미 대화 선택');
  const first = await picker.inputValue();
  const count = await picker.locator('option:not([disabled])').count();
  const key = `uimori:helper-create:${JSON.stringify({ kind: 'chat', chatId: chat.id })}`;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key.startsWith('uimori:helper-create:'))
        throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  let storedRequest: string | null = null;
  let sentRequest: unknown;
  await page.route('**/api/helper/conversations/new', async (route) => {
    storedRequest = await page.evaluate((key) => sessionStorage.getItem(key), key);
    sentRequest = route.request().postDataJSON();
    await route.continue();
  });
  await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
  await expect(picker).not.toHaveValue(first);
  await expect(picker.locator('option:not([disabled])')).toHaveCount(count + 1);
  expect(storedRequest).not.toBeNull();
  expect(JSON.parse(storedRequest ?? 'null')).toEqual(sentRequest);
  expect(
    await page.evaluate((key) => [localStorage.getItem(key), sessionStorage.getItem(key)], key)
  ).toEqual([null, null]);
});

for (const failure of ['transport', 'invalid-json'] as const) {
  test(`HSESSION06 ${failure} after server creation preserves the fallback key across reload and storage recovery`, async ({
    page,
    request,
  }) => {
    const chat = (await (
      await postFixtureChat(request, { data: { title: `생성 응답 복구 ${randomUUID()}` } })
    ).json()) as Chat;
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    const panel = page.locator('#helper-panel');
    await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
    const picker = panel.getByLabel('도우미 대화 선택');
    const count = await picker.locator('option:not([disabled])').count();
    const key = `uimori:helper-create:${JSON.stringify({ kind: 'chat', chatId: chat.id })}`;
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key.startsWith('uimori:helper-create:'))
          throw new DOMException('Full', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    const payloads: unknown[] = [];
    const ids: string[] = [];
    await page.route('**/api/helper/conversations/new', async (route) => {
      payloads.push(route.request().postDataJSON());
      if (payloads.length === 2)
        return route.fulfill({ status: 409, json: { error: 'Temporary confirmation failure' } });
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      ids.push(((await response.json()) as { id: string }).id);
      if (payloads.length === 1) {
        if (failure === 'transport') await route.abort('failed');
        else await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
      } else await route.fulfill({ response });
    });
    await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    expect(payloads).toHaveLength(1);
    const pending = await page.evaluate((key) => sessionStorage.getItem(key), key);
    expect(pending).not.toBeNull();
    expect(JSON.parse(pending ?? 'null')).toEqual(payloads[0]);

    // Reload restores localStorage writes while preserving the pending sessionStorage request.
    await page.reload();
    await openHelper(page);
    await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
    await page.evaluate(() => {
      const key = 'uimori:helper-create:storage-recovery-probe';
      localStorage.setItem(key, 'available');
      localStorage.removeItem(key);
    });
    await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(2);
    await expect(panel.getByRole('alert')).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBe(pending);
    await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
    await expect.poll(() => ids.length).toBe(2);
    await expect(picker).toHaveValue(ids[0]);
    await expect(panel.getByRole('button', { name: '새 도우미 대화', exact: true })).toBeEnabled();
    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[2]).toEqual(payloads[0]);
    expect(ids[1]).toBe(ids[0]);
    await expect(picker.locator('option:not([disabled])')).toHaveCount(count + 1);
    const persisted = await request.get(`/api/helper/conversations?kind=chat&chatId=${chat.id}`);
    expect(persisted.ok()).toBe(true);
    expect(await persisted.json()).toHaveLength(count + 1);
    expect(
      await page.evaluate((key) => [localStorage.getItem(key), sessionStorage.getItem(key)], key)
    ).toEqual([null, null]);
  });
}

test('HSESSION07 unavailable creation storage explains the failure without sending a request', async ({
  page,
  request,
}, info) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `생성 저장 실패 ${randomUUID()}` } })
  ).json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
  const picker = panel.getByLabel('도우미 대화 선택');
  const first = await picker.inputValue();
  const count = await picker.locator('option:not([disabled])').count();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('uimori:helper-create:'))
        throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  let posts = 0;
  await page.route('**/api/helper/conversations/new', async (route) => {
    posts++;
    await route.continue();
  });
  await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
  await expect(panel.getByRole('alert').locator('.notice-banner-message')).toHaveText(
    '대화 생성 요청을 보관하지 못했어요.'
  );
  await expect(panel.getByRole('button', { name: '새 도우미 대화', exact: true })).toBeEnabled();
  expect(posts).toBe(0);
  await expect(picker).toHaveValue(first);
  await expect(picker.locator('option:not([disabled])')).toHaveCount(count);
  await page.screenshot({ path: info.outputPath('helper-create-storage-unavailable.png') });
});

test('HSESSION08 a fallback retry keeps its own request when another tab has a pending localStorage creation', async ({
  page,
  request,
  context,
}) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `여러 탭 생성 복구 ${randomUUID()}` } })
  ).json()) as Chat;
  const key = `uimori:helper-create:${JSON.stringify({ kind: 'chat', chatId: chat.id })}`;
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key.startsWith('uimori:helper-create:'))
        throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  const payloads: unknown[] = [];
  const ids: string[] = [];
  await page.route('**/api/helper/conversations/new', async (route) => {
    payloads.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    ids.push(((await response.json()) as { id: string }).id);
    if (payloads.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  const pending = await page.evaluate((key) => sessionStorage.getItem(key), key);
  expect(pending).not.toBeNull();

  // Resolve the storage failure, then let another tab retain its own uncertain request.
  await page.reload();
  await openHelper(page);
  await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
  const other = await context.newPage();
  try {
    await other.goto(`/?chat=${chat.id}`);
    await openHelper(other);
    const otherPanel = other.locator('#helper-panel');
    await expect(otherPanel.getByLabel('도우미에게 요청')).toBeEnabled();
    const otherIds: string[] = [];
    await other.route('**/api/helper/conversations/new', async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      otherIds.push(((await response.json()) as { id: string }).id);
      if (otherIds.length === 1) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await otherPanel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
    await expect(otherPanel.getByRole('alert')).toBeVisible();
    const otherPending = await other.evaluate((key) => localStorage.getItem(key), key);
    expect(otherPending).not.toBeNull();
    expect(otherPending).not.toBe(pending);

    await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
    await expect(panel.getByRole('button', { name: '새 도우미 대화', exact: true })).toBeEnabled();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual(payloads[0]);
    expect(ids[1]).toBe(ids[0]);
    await expect(panel.getByLabel('도우미 대화 선택')).toHaveValue(ids[0]);
    expect(
      await page.evaluate((key) => [sessionStorage.getItem(key), localStorage.getItem(key)], key)
    ).toEqual([null, otherPending]);

    await otherPanel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
    await expect(
      otherPanel.getByRole('button', { name: '새 도우미 대화', exact: true })
    ).toBeEnabled();
    expect(otherIds).toHaveLength(2);
    expect(otherIds[1]).toBe(otherIds[0]);
    await expect(otherPanel.getByLabel('도우미 대화 선택')).toHaveValue(otherIds[0]);
    expect(await other.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
    const persisted = await request.get(`/api/helper/conversations?kind=chat&chatId=${chat.id}`);
    expect(persisted.ok()).toBe(true);
    expect(await persisted.json()).toHaveLength(3);
  } finally {
    await other.close();
  }
});
