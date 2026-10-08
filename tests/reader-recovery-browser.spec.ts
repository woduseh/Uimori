import { expect, test } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { navigationAction, visibleNavigation } from './ui-navigation.js';

test('READERREC initial reader loading becomes a recoverable error without losing the draft', async ({
  page,
  request,
}, info) => {
  const { chat } = await createReadingChat(request, 'Initial reader loading recovery', 1);
  const clockStart = Date.now();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart + 1000);
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let failed = true;
  await page.addInitScript((id) => {
    sessionStorage.setItem(`draft:${id}`, '본문 재조회 중에도 남을 초안');
    // Isolate initial loading and the explicit retry from unrelated SSE wakeups.
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    });
  }, chat.id);
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    if (!failed) return route.continue();
    await heldRead;
    await route.fulfill({ status: 503, json: { error: 'Reader temporarily unavailable' } });
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    const loading = page.getByRole('status').filter({ hasText: '본문을 불러오는 중이에요…' });
    await expect(page.locator('.reader-awaiting')).toHaveAttribute('aria-busy', 'true');
    await page.clock.runFor(50);
    await expect(loading).toHaveCount(0);
    await page.clock.fastForward(250);
    await expect(loading).toBeVisible();
    const spinner = loading.locator('svg');
    await expect(spinner).toHaveCSS('animation-name', 'activity-spin');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(spinner).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByRole('button', { name: '본문 다시 불러오기', exact: true })).toHaveCount(
      0
    );
    if (process.env.UIMORI_VISUAL_REVIEW === '1')
      await page.screenshot({ path: info.outputPath('reader-loading.png') });
    releaseRead();
    const error = page.getByRole('alert').filter({ hasText: '본문을 불러오지 못했어요.' });
    await expect(error).toBeVisible();
    await expect(error).toContainText('서버 작업을 완료하지 못했어요. (503)');
    await expect(loading).toHaveCount(0);
    if (process.env.UIMORI_VISUAL_REVIEW === '1')
      await page.screenshot({ path: info.outputPath('reader-loading-error.png') });
    failed = false;
    await page.getByRole('button', { name: '본문 다시 불러오기', exact: true }).click();
    await expect(page.getByTestId('source')).toHaveCount(1);
    await expect(page.getByTestId('source-request')).toContainText('검증 장면 1');
    await expect(page.getByRole('textbox', { name: '다음 장면 요청' })).toHaveValue(
      '본문 재조회 중에도 남을 초안'
    );
    await expect(error).toHaveCount(0);
    await expect(loading).toHaveCount(0);
  } finally {
    releaseRead();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('NOTICECOLOR reader error banners stay legible in light and dark themes', async ({
  page,
  request,
}, info) => {
  const { chat } = await createReadingChat(request, '오류 안내 대비 검증', 1);
  await page.route(`**/api/chats/${chat.id}/reading-position?*`, (route) =>
    route.fulfill({ status: 503, json: { error: 'Reading position unavailable' } })
  );
  await page.goto(`/?chat=${chat.id}`);
  for (const mode of ['light', 'dark']) {
    await page.evaluate((mode) => localStorage.setItem('uimori:theme', mode), mode);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    const banner = page.getByRole('alert', { name: '읽기 위치 연결 오류', exact: true });
    await expect(banner).toBeVisible();
    const contrast = await banner.evaluate((node) => {
      const style = getComputedStyle(node);
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map((value) => Number(value) / 255)
          .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const fg = luminance(style.color),
        bg = luminance(style.backgroundColor);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await expect(banner.getByRole('button', { name: '연결 다시 확인', exact: true })).toBeEnabled();
    if (process.env.UIMORI_VISUAL_REVIEW === '1')
      await page.screenshot({
        path: info.outputPath(`error-banner-${mode}.png`),
        animations: 'disabled',
      });
  }
});

test('READERREC confirming an uncertain request never turns into cancelling its admitted run', async ({
  page,
  request,
}) => {
  const chat = await (
    await postFixtureChat(request, { data: { title: 'Running admission recovery' } })
  ).json();
  const payload = {
    request: '수락된 요청 확인',
    expectedRevision: null,
    expectedSettingsRevision: chat.settingsRevision,
  };
  const key = 'running-admission-recovery';
  const accepted = await request.post(`/api/chats/${chat.id}/runs`, {
    data: { ...payload, idempotencyKey: key },
  });
  expect(accepted.ok()).toBe(true);
  const run = await accepted.json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/chats/${chat.id}`)).json()).runs.find(
          (item: { id: string }) => item.id === run.id
        )?.status
    )
    .toBe('completed');
  let confirmed = false,
    cancellations = 0;
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (!confirmed) {
      body.sources = [];
      body.runs = body.runs.map((item: { id: string }) =>
        item.id === run.id ? { ...item, status: 'running', sourceRevision: null } : item
      );
      body.reader.pendingRunIds = [run.id];
      body.reader.order = [];
    }
    await route.fulfill({ response, json: body });
  });
  page.on('request', (req) => {
    if (req.url().endsWith(`/runs/${run.id}/cancel`)) cancellations++;
  });
  await page.route(`**/api/chats/${chat.id}/runs`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ ...payload, idempotencyKey: key });
    const response = await route.fetch();
    expect((await response.json()).id).toBe(run.id);
    confirmed = true;
    await route.fulfill({ response });
  });
  await page.addInitScript(
    ({ id, key, payload }) =>
      sessionStorage.setItem(
        `command:${id}`,
        JSON.stringify({ id: key, payload: JSON.stringify(payload) })
      ),
    { id: chat.id, key, payload }
  );
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('pending-run')).toBeVisible();
  await expect(page.getByRole('button', { name: '원문 생성 취소', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeVisible();
  expect(confirmed).toBe(true);
  expect(cancellations).toBe(0);
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).runs).toHaveLength(1);
});

test('READERREC invalid view caches do not prevent opening a saved conversation', async ({
  page,
  request,
}) => {
  const chat = await (await postFixtureChat(request, { data: { title: 'Cache recovery' } })).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((id) => {
    sessionStorage.setItem(`reading:${id}:`, '{broken');
    sessionStorage.setItem(`cursor:draft:${id}`, '{broken');
    sessionStorage.setItem(`draft:${id}`, '살아 있는 초안');
  }, chat.id);
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('textbox', { name: '다음 장면 요청' })).toHaveValue('살아 있는 초안');
  expect(errors).toEqual([]);
});

test('READERREC failed view cache writes preserve library and chat navigation and saved drafts', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, 'View cache write recovery', 2);
  const other = await (
    await request.post('/api/chats', {
      data: { title: 'Other cache recovery chat', botId: chat.botId },
    })
  ).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source').first()).toBeVisible();
  const draft = page.getByRole('textbox', { name: '다음 장면 요청' });
  await draft.fill('화면 캐시 저장 실패에도 남을 초안');
  await page.evaluate(() => {
    const failed = new Set<string>();
    Object.assign(window, { failedViewCacheWrites: failed });
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && (key.startsWith('reading:') || key.startsWith('cursor:'))) {
        failed.add(key.split(':')[0]);
        throw new DOMException('Full', 'QuotaExceededError');
      }
      return setItem.call(this, key, value);
    };
  });
  await navigationAction(page, '서재');
  await expect(page.getByTestId('library-panel')).toBeVisible();
  await expect(page).toHaveURL(/workspace=library/);
  await page.goBack();
  await expect(draft).toHaveValue('화면 캐시 저장 실패에도 남을 초안');
  await (await visibleNavigation(page))
    .getByRole('button', { name: other.title, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`chat=${other.id}`));
  await expect(draft).toHaveValue('');
  await (await visibleNavigation(page))
    .getByRole('button', { name: chat.title, exact: true })
    .click();
  await expect(draft).toHaveValue('화면 캐시 저장 실패에도 남을 초안');
  expect(
    await page.evaluate(() =>
      [
        ...(window as unknown as { failedViewCacheWrites: Set<string> }).failedViewCacheWrites,
      ].sort()
    )
  ).toEqual(['cursor', 'reading']);
  await page.reload();
  await expect(draft).toHaveValue('화면 캐시 저장 실패에도 남을 초안');
  expect(errors).toEqual([]);
});

test('READERREC failed command persistence prevents generation and preserves the draft', async ({
  page,
  request,
}) => {
  const chat = await (
    await postFixtureChat(request, { data: { title: 'Storage failure' } })
  ).json();
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('command:')) throw new DOMException('quota', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  let submissions = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith(`/chats/${chat.id}/runs`)) submissions++;
  });
  await page.goto(`/?chat=${chat.id}`);
  const draft = page.getByRole('textbox', { name: '다음 장면 요청' });
  await draft.fill('저장 실패에도 남을 초안');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect(
    page.getByText(
      '요청 복구 기록을 저장하지 못해 요청을 보내지 않았어요. 브라우저 저장 공간을 확인해 주세요.'
    )
  ).toBeVisible();
  await expect(draft).toHaveValue('저장 실패에도 남을 초안');
  expect(submissions).toBe(0);
});

test('READERREC final SSE event recovers from one failed reader GET without another event', async ({
  page,
  request,
}) => {
  const chat = await (
    await postFixtureChat(request, { data: { title: 'Final event recovery' } })
  ).json();
  const initialReader = await (await request.get(`/api/chats/${chat.id}/reader`)).json();
  let recovering = false,
    refreshes = 0;
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    if (!recovering) return route.fulfill({ json: initialReader });
    refreshes++;
    if (refreshes === 1)
      await route.fulfill({ status: 503, json: { error: 'Transient reader failure' } });
    else await route.continue();
  });
  await page.addInitScript(() => {
    class ControlledEvents {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      listener = (event: Event) =>
        this.onmessage?.(
          new MessageEvent('message', { data: JSON.stringify((event as CustomEvent).detail) })
        );
      constructor() {
        addEventListener('test-reader-event', this.listener);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {
        removeEventListener('test-reader-event', this.listener);
      }
    }
    Object.defineProperty(window, 'EventSource', { value: ControlledEvents });
  });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('textbox', { name: '다음 장면 요청' })).toBeVisible();
  const response = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '마지막 이벤트 뒤 복구할 장면',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'final-event',
    },
  });
  expect(response.ok()).toBe(true);
  const run = await response.json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/chats/${chat.id}`)).json()).runs.find(
          (item: { id: string }) => item.id === run.id
        )?.status
    )
    .toBe('completed');
  const detail = await (await request.get(`/api/chats/${chat.id}/reader`)).json();
  await expect(page.getByTestId('source-request')).toHaveCount(0);
  recovering = true;
  await page.evaluate(
    (seq) =>
      dispatchEvent(
        new CustomEvent('test-reader-event', { detail: { kind: 'run.completed', seq } })
      ),
    detail.reader.cursor
  );
  await expect(page.getByTestId('source-request')).toContainText('마지막 이벤트 뒤 복구할 장면');
  expect(refreshes).toBeGreaterThanOrEqual(2);
});

test('READERREC rejudgment survives an uncertain response and reload without sending a generation request', async ({
  page,
  request,
}) => {
  const chat = await (
    await postFixtureChat(request, { data: { title: 'Judgment recovery' } })
  ).json();
  const accepted = await (
    await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: 'Preserved response request',
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: 'judgment-ui-fixture',
      },
    })
  ).json();
  await expect
    .poll(async () => (await (await request.get(`/api/runs/${accepted.id}`)).json()).status)
    .toBe('completed');
  let recovered = false;
  try {
    await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (!recovered) {
        body.sources = [];
        body.reader.order = [];
        body.reader.pendingRunIds = [accepted.id];
        body.runs = body.runs.map((run: { id: string }) =>
          run.id === accepted.id
            ? {
                ...run,
                status: 'failed',
                error: 'JEV_EXECUTION_FAILED',
                sourceRevision: null,
                canRejudge: true,
              }
            : run
        );
      }
      await route.fulfill({ response, json: body });
    });
    const payloads: unknown[] = [];
    let writerRequests = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && (req.url().endsWith('/runs') || req.url().endsWith('/retry')))
        writerRequests++;
    });
    await page.route(`**/api/runs/${accepted.id}/rejudge`, async (route) => {
      payloads.push(route.request().postDataJSON());
      if (payloads.length === 1) await route.abort('failed');
      else {
        recovered = true;
        await route.fulfill({ json: accepted });
      }
    });
    await page.goto(`/?chat=${chat.id}`);
    await page
      .getByRole('textbox', { name: '다음 장면 요청', exact: true })
      .fill('Keep this new draft');
    await page.getByRole('button', { name: '판정만 다시 시도', exact: true }).click();
    await expect(page.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(payloads[0]).toEqual({ idempotencyKey: expect.any(String) });
    await expect(page.getByRole('textbox', { name: '다음 장면 요청', exact: true })).toHaveValue(
      'Keep this new draft'
    );
    await expect(page.getByTestId('source')).toHaveCount(1);
    expect(writerRequests).toBe(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});
