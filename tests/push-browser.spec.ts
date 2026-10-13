import { test, expect } from '@playwright/test';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';
import { DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';

test.setTimeout(60000);

test('AUDIT2 push settings initial read shows centered loading and recovers from 503 without permission or subscription writes', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    Reflect.set(window, 'pushPermissionCalls', 0);
    Reflect.set(window, 'pushSubscribeCalls', 0);
    Object.defineProperty(Notification, 'permission', {
      configurable: true,
      get: () => 'default',
    });
    Notification.requestPermission = async () => {
      Reflect.set(
        window,
        'pushPermissionCalls',
        Number(Reflect.get(window, 'pushPermissionCalls')) + 1
      );
      return 'denied';
    };
    PushManager.prototype.subscribe = async () => {
      Reflect.set(
        window,
        'pushSubscribeCalls',
        Number(Reflect.get(window, 'pushSubscribeCalls')) + 1
      );
      throw new Error('This read-only fixture must not subscribe');
    };
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let phase: 'pending' | 'failed' | 'recovered' = 'pending';
  let reads = 0;
  const writes: string[] = [];
  await page.route('**/api/push**', async (route) => {
    const entry = route.request();
    const path = new URL(entry.url()).pathname;
    if (entry.method() !== 'GET' || path !== '/api/push') {
      writes.push(`${entry.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: 'Unexpected push mutation' } });
    }
    reads++;
    if (phase === 'pending') await pending;
    if (phase !== 'recovered')
      return route.fulfill({ status: 503, json: { error: 'Synthetic push info read failure' } });
    return route.fulfill({
      json: { available: true, reason: null, publicKey: null, device: null },
    });
  });
  await page.setViewportSize({ width: 412, height: 915 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  try {
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
    const panel = page.getByRole('region', { name: '작업 완료 알림', exact: true });
    const loading = panel.locator('.loading-state-compact');
    await expect(loading.getByRole('status')).toContainText('알림 설정을 불러오는 중이에요…');
    await expect(panel.getByRole('button', { name: '알림 켜기', exact: true })).toBeHidden();
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 915 });
      await loading.scrollIntoViewIfNeeded();
      const bounds = (await loading.boundingBox())!;
      const status = (await loading.getByRole('status').boundingBox())!;
      expect(
        Math.abs(bounds.x + bounds.width / 2 - status.x - status.width / 2)
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(bounds.y + bounds.height / 2 - status.y - status.height / 2)
      ).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(`audit2-push-initial-loading-${width}.png`) });
    }
    phase = 'failed';
    release();
    const failure = panel.getByRole('alert');
    await expect(failure).toContainText('서버 작업을 완료하지 못했어요.');
    await expect(failure).toContainText('(503)');
    await expect(loading).toBeHidden();
    const retry = panel.getByRole('button', { name: '알림 연결 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    await page.screenshot({ path: info.outputPath('audit2-push-initial-read-failed-412.png') });
    const beforeRetry = reads;
    phase = 'recovered';
    await retry.click();
    await expect(panel.getByRole('status')).toContainText('이 기기의 알림 꺼짐');
    await expect(panel.getByRole('button', { name: '알림 켜기', exact: true })).toBeVisible();
    await expect(failure).toBeHidden();
    await expect(loading).toBeHidden();
    expect(reads).toBeGreaterThan(beforeRetry);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'pushPermissionCalls'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'pushSubscribeCalls'))).toBe(0);
    await page.screenshot({ path: info.outputPath('audit2-push-initial-read-recovered-412.png') });
  } finally {
    release();
  }
});

test('PWUI06 push consent is explicit, preferences are acknowledged before changing, and server opt-out survives browser unsubscribe failure', async ({
  page,
}, info) => {
  const { createECDH, randomBytes } = await import('node:crypto');
  const { default: webPush } = await import('web-push');
  const keys = webPush.generateVAPIDKeys();
  const ec = createECDH('prime256v1');
  ec.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/browser-fixture-only',
    keys: {
      p256dh: ec.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
  await page.addInitScript(
    ({ value }) => {
      let permission: NotificationPermission = 'default';
      let subscribed = false;
      let appKey: ArrayBuffer | null = null;
      Reflect.set(window, 'pushPermissionCalls', 0);
      Reflect.set(window, 'pushSubscribeCalls', 0);
      Object.defineProperty(Notification, 'permission', {
        configurable: true,
        get: () => permission,
      });
      Notification.requestPermission = async () => {
        Reflect.set(
          window,
          'pushPermissionCalls',
          Number(Reflect.get(window, 'pushPermissionCalls')) + 1
        );
        permission = 'granted';
        return permission;
      };
      const item = () =>
        ({
          endpoint: value.endpoint,
          expirationTime: null,
          options: { userVisibleOnly: true, applicationServerKey: appKey },
          toJSON: () => value,
          getKey: () => null,
          unsubscribe: async () => {
            throw new Error('Synthetic browser-side unsubscribe failure');
          },
        }) as PushSubscription;
      PushManager.prototype.getSubscription = async () => (subscribed ? item() : null);
      PushManager.prototype.subscribe = async (options) => {
        Reflect.set(
          window,
          'pushSubscribeCalls',
          Number(Reflect.get(window, 'pushSubscribeCalls')) + 1
        );
        appKey = (options!.applicationServerKey as Uint8Array<ArrayBuffer>).buffer;
        subscribed = true;
        return item();
      };
    },
    { value: subscription }
  );
  const defaults = {
    main: true,
    failures: true,
    translation: false,
    illustration: false,
    showTitle: false,
  };
  let device: { revision: number; preferences: typeof defaults; lastError: null } | null = null;
  let rejectNextChange = true,
    prepareCalls = 0,
    subscribeCalls = 0,
    testCalls = 0,
    disabled = false;
  await page.route('**/api/push**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const body = request.method() === 'GET' ? null : request.postDataJSON();
    if (path === '/api/push/prepare') prepareCalls++;
    if (path === '/api/push/subscription' && request.method() === 'POST') {
      subscribeCalls++;
      expect(body.subscription).toEqual(subscription);
      device = { revision: 1, preferences: body.preferences, lastError: null };
    }
    if (path === '/api/push/subscription' && request.method() === 'PUT') {
      if (rejectNextChange) {
        rejectNextChange = false;
        await route.fulfill({
          status: 409,
          json: { error: 'PUSH_SETTINGS_CHANGED' },
        });
        return;
      }
      expect(body.expectedRevision).toBe(device!.revision);
      device = { revision: device!.revision + 1, preferences: body.preferences, lastError: null };
    }
    if (path === '/api/push/subscription' && request.method() === 'DELETE') {
      disabled = true;
      device = null;
    }
    if (path === '/api/push/test') {
      testCalls++;
      await route.fulfill({ status: 202, json: { status: 'queued' } });
      return;
    }
    await route.fulfill({
      json: { available: true, reason: null, publicKey: keys.publicKey, device },
    });
  });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '일반');
  const panel = page.getByRole('region', { name: '작업 완료 알림', exact: true });
  await expect(panel).toContainText('이 기기의 알림 꺼짐');
  expect(await page.evaluate(() => Reflect.get(window, 'pushPermissionCalls'))).toBe(0);
  expect(prepareCalls).toBe(0);
  await panel.getByRole('button', { name: '알림 켜기', exact: true }).click();
  await expect(panel).toContainText('이 기기의 알림 켜짐');
  expect(await page.evaluate(() => Reflect.get(window, 'pushPermissionCalls'))).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, 'pushSubscribeCalls'))).toBe(1);
  expect(prepareCalls).toBe(1);
  expect(subscribeCalls).toBe(1);
  await panel.locator('summary').filter({ hasText: '알림 옵션' }).click();
  await expect(panel.getByLabel('본문 생성 완료', { exact: true })).toBeChecked();
  await expect(panel.getByLabel('번역 완료·실패', { exact: true })).not.toBeChecked();
  const title = panel.getByLabel('잠금 화면에 채팅 제목 표시', { exact: true });
  await title.click();
  await expect(panel.getByRole('alert')).toContainText('바뀌었어요');
  await expect(title).not.toBeChecked();
  await title.click();
  await expect(title).toBeChecked();
  await panel.getByRole('button', { name: '테스트 알림 보내기', exact: true }).click();
  await expect(page.locator('.transient-notice[role="status"]')).toContainText('발송 대기열');
  expect(testCalls).toBe(1);
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`push-settings-${width}.png`) });
  }
  await panel.getByRole('button', { name: '알림 끄기', exact: true }).click();
  await expect(panel).toContainText('이 기기의 알림 꺼짐');
  await expect(panel).toContainText('서버 알림은 껐어요.');
  expect(disabled).toBe(true);
  await page.reload();
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '일반');
  await expect(panel).toContainText('이 기기의 알림 꺼짐');
  expect(subscribeCalls).toBe(1);
});

test('PWUI07 a worker notification focuses a semantic scene without reloading; an open manuscript editor defers the navigation', async ({
  page,
  request,
}, info) => {
  const first = await createReadingChat(request, `알림 현재 원고 ${Date.now()}`, 2);
  const next = await createReadingChat(request, `알림 이동 원고 ${Date.now()}`, 2);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto(`/?chat=${first.chat.id}`);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  const scene = page.locator('[data-testid="source"]').first();
  await scene.getByRole('button', { name: '원문 보기', exact: true }).click();
  await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
  const editor = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
  await editor.fill('저장하지 않은 원고 초안');
  const before = page.url();
  const initialDocument = await page.evaluate(() => {
    Reflect.set(window, 'notificationDocumentIdentity', crypto.randomUUID());
    return Reflect.get(window, 'notificationDocumentIdentity');
  });
  await page.evaluate(
    async (target) => {
      const registration = await navigator.serviceWorker.ready;
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          source: registration.active,
          data: { type: 'uimori:notification-open', payload: target },
        })
      );
    },
    {
      chatId: next.chat.id,
      sourceId: next.detail.sources[1].id,
      representation: 'translation',
    }
  );
  const banner = page.getByRole('status', { name: '알림의 장면 이동', exact: true });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: '알림으로 이동', exact: true })).toBeDisabled();
  expect(page.url()).toBe(before);
  await expect(editor).toHaveValue('저장하지 않은 원고 초안');
  await page.screenshot({ path: info.outputPath('notification-edit-preserved.png') });
  await scene.getByRole('button', { name: '수정 취소', exact: true }).click();
  await banner.getByRole('button', { name: '알림으로 이동', exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('source'))
    .toBe(next.detail.sources[1].id);
  await expect(page.locator(`[data-source-id="${next.detail.sources[1].id}"]`)).toHaveAttribute(
    'data-representation',
    'translation'
  );
  expect(await page.evaluate(() => Reflect.get(window, 'notificationDocumentIdentity'))).toBe(
    initialDocument
  );
  const markedScene = page.locator(`[data-source-id="${next.detail.sources[1].id}"]`);
  await markedScene.getByRole('button', { name: '책갈피 추가', exact: true }).click();
  await markedScene.getByRole('button', { name: '책갈피 추가됨 · 메모 편집', exact: true }).click();
  const bookmarkEditor = page.getByRole('dialog', { name: '책갈피 편집', exact: true });
  await bookmarkEditor.getByLabel('책갈피 메모').fill('알림으로 이동해도 남아야 하는 메모');
  const bookmarkUrl = page.url();
  await page.evaluate(
    async (target) => {
      const registration = await navigator.serviceWorker.ready;
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          source: registration.active,
          data: { type: 'uimori:notification-open', payload: target },
        })
      );
    },
    {
      chatId: first.chat.id,
      sourceId: first.detail.sources[0].id,
      representation: 'original',
    }
  );
  expect(page.url()).toBe(bookmarkUrl);
  await expect(bookmarkEditor.getByLabel('책갈피 메모')).toHaveValue(
    '알림으로 이동해도 남아야 하는 메모'
  );
  await expect(banner.getByRole('button', { name: '알림으로 이동', exact: true })).toBeDisabled();
  await bookmarkEditor.getByRole('button', { name: '책갈피 변경 저장', exact: true }).click();
  await expect(bookmarkEditor).not.toBeVisible();
  await banner.getByRole('button', { name: '알림으로 이동', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(first.chat.id);
  const savedBookmarks = await (await request.get(`/api/chats/${next.chat.id}/bookmarks`)).json();
  expect(savedBookmarks[0].note).toBe('알림으로 이동해도 남아야 하는 메모');
});
