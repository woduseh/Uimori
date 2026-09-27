import { test, expect, type APIRequestContext } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectSettingsSection, visibleNavigation } from './ui-navigation.js';
import { DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import type { Chat, ChatDetail } from '../core/types.js';
import type { ChatTranscript } from '../core/chat-transcript.js';

test.setTimeout(60000);
async function createReadingChat(request: APIRequestContext, title: string, count = 8) {
  const owner = await postFixtureChat(request, { data: { title: `${title} 자료` } });
  expect(owner.ok()).toBe(true);
  const original = (await owner.json()) as Chat;
  const transcript = (await (
    await request.get(`/api/chats/${original.id}/transcript`)
  ).json()) as ChatTranscript;
  transcript.title = title;
  transcript.entries = Array.from({ length: count }, (_, index) => ({
    request: `검증 장면 ${index + 1}`,
    text: `Scene ${index + 1}. Mira carried a purple umbrella.\n\n${'The quiet river reflected the lanterns.\n\n'.repeat(5)}`,
    translation: `장면 ${index + 1}. 미카는 보라색 우산을 들었다.\n\n${'조용한 강물이 등불을 비추었다.\n\n'.repeat(5)}`,
  }));
  const imported = await request.post('/api/chats/import-transcript', {
    data: { transcript, idempotencyKey: crypto.randomUUID() },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const chat = (await imported.json()).chat as Chat;
  const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  return { chat, detail };
}

test('PWUI01 search uses the saved translation and opens its exact scene on desktop and mobile without model work', async ({
  page,
  request,
}, info) => {
  const { chat } = await createReadingChat(request, `검색 검증 ${Date.now()}`);
  const modelCalls: string[] = [];
  page.on('request', (event) => {
    if (event.method() === 'POST' && /\/(?:runs|retranslate)$/.test(new URL(event.url()).pathname))
      modelCalls.push(event.url());
  });
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await visibleNavigation(page);
    await page
      .getByRole('button', { name: '전체 채팅 검색', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: '전체 채팅 검색', exact: true });
    await dialog.getByLabel('전체 채팅 검색', { exact: true }).fill('미카');
    await dialog.getByRole('button', { name: '검색', exact: true }).click();
    const result = dialog
      .locator('.manuscript-search-results article')
      .filter({ hasText: chat.title })
      .first();
    await expect(result).toContainText('보라색 우산');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`search-${width}.png`) });
    await result.getByRole('button', { name: '번역 장면 열기', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('[data-testid="source"]').first()).toHaveAttribute(
      'data-representation',
      'translation'
    );
    await expect(page.getByRole('heading', { name: chat.title, exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('mode')).toBe('translation');
    await page.screenshot({ path: info.outputPath(`reader-target-${width}.png`) });
  }
  expect(modelCalls).toEqual([]);
});

test('PWUI02 backup settings, status, verified download and retention are reachable without a live deployment', async ({
  page,
  request,
}, info) => {
  const { chat } = await createReadingChat(request, `백업 검증 ${Date.now()}`, 2);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '데이터 관리');
  const panel = page.getByRole('region', { name: '자동 백업', exact: true });
  await expect(panel.getByLabel('매일 자동 백업')).not.toBeChecked();
  await panel.getByLabel('성공본 보관 개수').fill('2');
  await panel.getByRole('button', { name: '백업 설정 저장', exact: true }).click();
  await expect(panel.getByRole('button', { name: '백업 설정 저장', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '지금 백업', exact: true }).click();
  await expect(panel).toContainText('마지막 성공:', { timeout: 30000 });
  const response = await request.get('/api/backups');
  const status = await response.json();
  expect(status.backups.length).toBeGreaterThan(0);
  const downloaded = await request.get(`/api/backups/${status.backups[0].id}/download`);
  expect(downloaded.ok()).toBe(true);
  expect((await downloaded.body()).subarray(0, 15).toString()).toBe('SQLite format 3');
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`backups-${width}.png`) });
  }
});

test('PWUI03 a new device resumes a saved scene; remote changes only offer a resume and bookmarks keep editable user notes', async ({
  page,
  request,
}, info) => {
  const { chat, detail } = await createReadingChat(request, `이어 읽기 검증 ${Date.now()}`, 8);
  const remoteId = crypto.randomUUID();
  const target = (index: number) => ({
    chatId: chat.id,
    branchId: `main:${chat.id}`,
    sourceId: detail.sources[index].id,
    representation: 'original',
    contentHash: detail.sources[index].hash,
  });
  const path = `/api/chats/${chat.id}/reading-position`;
  expect(
    (
      await request.put(path, {
        data: { clientId: remoteId, expectedRevision: 0, target: target(5) },
      })
    ).ok()
  ).toBe(true);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('source'))
    .toBe(detail.sources[5].id);
  await expect(page.locator(`[data-source-id="${detail.sources[5].id}"]`)).toHaveAttribute(
    'data-representation',
    'original'
  );
  const localId = await page.evaluate(() => localStorage.getItem('uimori:reading-client'));
  expect(
    (
      await request.put(path, {
        data: { clientId: localId, expectedRevision: 0, target: target(5) },
      })
    ).ok()
  ).toBe(true);
  expect(
    (
      await request.put(path, {
        data: { clientId: remoteId, expectedRevision: 1, target: target(1) },
      })
    ).ok()
  ).toBe(true);
  const previous = page.url();
  await page.evaluate(() => dispatchEvent(new Event('online')));
  const resume = page.getByRole('button', { name: '다른 기기에서 이어 읽기', exact: true });
  await expect(resume).toBeVisible();
  expect(page.url()).toBe(previous);
  await resume.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('source'))
    .toBe(detail.sources[1].id);
  const scene = page.locator(`[data-source-id="${detail.sources[1].id}"]`);
  await scene.getByRole('button', { name: '책갈피 추가', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '책갈피 추가', exact: true });
  await editor.getByLabel('책갈피 이름').fill('비 오는 장면');
  await editor.getByLabel('책갈피 메모').fill('이 대목에서 다시 이어 쓸 것');
  await editor.getByRole('button', { name: '책갈피 저장', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const bookmarks = await (await request.get(`/api/chats/${chat.id}/bookmarks`)).json();
  expect(bookmarks).toHaveLength(1);
  expect(bookmarks[0].target.sourceId).toBe(detail.sources[1].id);
  await page
    .getByRole('button', { name: '장면 목록 열기', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const list = page.getByRole('dialog', { name: '장면 목록', exact: true });
  await list
    .locator('summary')
    .filter({ hasText: /^책갈피$/ })
    .click();
  await expect(list.getByRole('region', { name: '이 채팅의 책갈피' })).toContainText(
    '이 대목에서 다시 이어 쓸 것'
  );
  await list.getByRole('button', { name: '비 오는 장면 책갈피 편집', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '책갈피 편집', exact: true });
  await edit.getByLabel('책갈피 메모').fill('메모 수정 완료');
  await edit.getByRole('button', { name: '책갈피 변경 저장', exact: true }).click();
  await expect(edit).not.toBeVisible();
  await expect(list).toContainText('메모 수정 완료');
  await page.screenshot({ path: info.outputPath('bookmarks-desktop.png') });
  await list.getByRole('button', { name: '비 오는 장면', exact: true }).click();
  await expect(list).not.toBeVisible();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .getByRole('button', { name: '장면 목록 열기', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const bookDisclosure = list.locator('summary').filter({ hasText: /^책갈피$/ });
  if (!(await bookDisclosure.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await bookDisclosure.click();
  await expect(list.getByRole('button', { name: '비 오는 장면', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('bookmarks-mobile.png') });
  await list.getByRole('button', { name: '비 오는 장면', exact: true }).click();
  await expect(list).not.toBeVisible();
  expect(new URL(page.url()).searchParams.get('source')).toBe(detail.sources[1].id);
});

test('PWUI04 real loopback usage receipts appear in period, model and purpose tables with unknown costs and CSV', async ({
  page,
  request,
}, info) => {
  const { loopbackProvider, writeSse } = await import('./fixtures/loopback-provider.js');
  let calls = 0;
  const provider = await loopbackProvider(async (_, response) => {
    calls++;
    await writeSse(response, [
      { type: 'text_delta', delta: 'Synthetic connection response; never a paid model.' },
      {
        type: 'usage',
        inputTokens: calls === 1 ? 1000 : null,
        outputTokens: calls === 1 ? 100 : null,
        costUsd: calls === 1 ? 0.25 : null,
      },
      { type: 'done', reason: 'stop' },
    ]);
  });
  try {
    const connectionResponse = await request.post('/api/connections', {
      data: {
        title: 'Personal usage loopback',
        protocol: 'fixture-sse-v1',
        endpoint: provider.endpoint,
        enabled: true,
      },
    });
    expect(connectionResponse.ok(), await connectionResponse.text()).toBe(true);
    const connection = await connectionResponse.json();
    const modelResponse = await request.post('/api/model-presets', {
      data: {
        title: 'Personal usage fixture',
        connectionId: connection.id,
        modelId: 'personal-usage-fixture',
        maxOutputTokens: 64,
        temperature: null,
      },
    });
    expect(modelResponse.ok(), await modelResponse.text()).toBe(true);
    const model = await modelResponse.json();
    for (let index = 0; index < 2; index++) {
      const admission = await request.post(`/api/provider-management/models/${model.id}/test`, {
        data: { expectedRevision: model.revision, idempotencyKey: crypto.randomUUID() },
      });
      expect(admission.status(), await admission.text()).toBe(202);
      const job = await admission.json();
      await expect
        .poll(
          async () =>
            (await (await request.get(`/api/provider-management/tests/${job.id}`)).json()).status
        )
        .toBe('completed');
    }
    expect(calls).toBe(2);
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const report = await (await request.get(`/api/usage?from=${day}&to=${day}`)).json();
    expect(
      report.models.find((item: { modelId: string }) => item.modelId === model.modelId)
    ).toMatchObject({ calls: 2, reportedUsd: 0.25, unknownCostCalls: 1, unknownInputCalls: 1 });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '사용량');
    const panel = page.getByRole('region', { name: '작업실 사용량', exact: true });
    await panel.getByRole('button', { name: '오늘', exact: true }).click();
    const row = panel.getByRole('row').filter({ hasText: 'personal-usage-fixture' });
    await expect(row).toContainText('1,000');
    await expect(row).toContainText('0.25');
    await expect(row).toContainText('미확인');
    await expect(panel.getByRole('row').filter({ hasText: '연결 테스트' })).toBeVisible();
    const csvPath = await panel
      .getByRole('link', { name: '모델별 CSV', exact: true })
      .getAttribute('href');
    const csv = await request.get(csvPath!);
    expect(csv.ok()).toBe(true);
    expect(await csv.text()).toContain('personal-usage-fixture');
    expect(await csv.text()).not.toContain('Synthetic connection response');
    for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
      await page.setViewportSize({ width, height: 1000 });
      await panel.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({ path: info.outputPath(`usage-${width}.png`) });
    }
    expect(calls).toBe(2);
  } finally {
    await provider.close();
  }
});

test('PWUI05 app installation is explicit, registers a cache-free worker and never prompts for notifications on load', async ({
  page,
  context,
  request,
}, info) => {
  await page.addInitScript(() => {
    Object.assign(window, { permissionCalls: 0, installCalls: 0 });
    if ('Notification' in window)
      Notification.requestPermission = async () => {
        Object.assign(window, {
          permissionCalls: Number(Reflect.get(window, 'permissionCalls')) + 1,
        });
        return 'denied';
      };
  });
  const authoring: string[] = [];
  page.on('request', (event) => {
    if (
      event.method() === 'POST' &&
      /\/(?:runs|retry|retranslate)$/.test(new URL(event.url()).pathname)
    )
      authoring.push(event.url());
  });
  await page.goto('/');
  const registration = await page.evaluate(async () => {
    const value = await navigator.serviceWorker.ready;
    return { scope: value.scope, script: value.active?.scriptURL, caches: await caches.keys() };
  });
  expect(new URL(registration.scope).pathname).toBe('/');
  expect(new URL(registration.script!).pathname).toBe('/sw.js');
  expect(registration.caches).toEqual([]);
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await request.get(manifestUrl!)).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/', id: '/' });
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '일반');
  const panel = page.getByRole('region', { name: '앱 설치', exact: true });
  await expect(panel).toContainText('서버 연결이 필요');
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        Reflect.set(window, 'installCalls', Number(Reflect.get(window, 'installCalls')) + 1);
      },
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    dispatchEvent(event);
  });
  await expect(panel.getByRole('button', { name: 'Uimori 설치', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'installCalls'))).toBe(0);
  await panel.getByRole('button', { name: 'Uimori 설치', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'installCalls'))).toBe(1);
  await expect(panel).toContainText('브라우저 메뉴');
  expect(await page.evaluate(() => Reflect.get(window, 'permissionCalls'))).toBe(0);
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`pwa-install-${width}.png`) });
  }
  await context.setOffline(true);
  const offline = await page.evaluate(async () => {
    try {
      await fetch('/api/session', { cache: 'no-store' });
      return false;
    } catch {
      return true;
    }
  });
  expect(offline).toBe(true);
  await context.setOffline(false);
  expect(
    await page.evaluate(async () =>
      fetch('/api/session', { cache: 'no-store' }).then((response) => response.ok)
    )
  ).toBe(true);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  expect(authoring).toEqual([]);
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
  await panel.getByRole('button', { name: '이 기기에서 알림 받기', exact: true }).click();
  await expect(panel).toContainText('이 기기의 서버 알림 켜짐');
  expect(await page.evaluate(() => Reflect.get(window, 'pushPermissionCalls'))).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, 'pushSubscribeCalls'))).toBe(1);
  expect(prepareCalls).toBe(1);
  expect(subscribeCalls).toBe(1);
  await expect(panel.getByLabel('본문 생성 완료', { exact: true })).toBeChecked();
  await expect(panel.getByLabel('번역 완료·실패', { exact: true })).not.toBeChecked();
  const title = panel.getByLabel('잠금 화면에 채팅 제목 표시', { exact: true });
  await title.click();
  await expect(panel.getByRole('alert')).toContainText('바뀌었어요');
  await expect(title).not.toBeChecked();
  await title.click();
  await expect(title).toBeChecked();
  await panel.getByRole('button', { name: '테스트 알림 보내기', exact: true }).click();
  await expect(panel).toContainText('발송 대기열');
  expect(testCalls).toBe(1);
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`push-settings-${width}.png`) });
  }
  await panel.getByRole('button', { name: '이 기기 알림 끄기', exact: true }).click();
  await expect(panel).toContainText('이 기기의 알림 꺼짐');
  await expect(panel).toContainText('서버 알림은 껐어요.');
  expect(disabled).toBe(true);
  await panel.getByRole('button', { name: '알림 연결 다시 확인', exact: true }).click();
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
      branchId: `main:${next.chat.id}`,
      sourceId: next.detail.sources[1].id,
      representation: 'translation',
    }
  );
  const banner = page.getByRole('complementary', { name: '알림의 장면 이동', exact: true });
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
});
