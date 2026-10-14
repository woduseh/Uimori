import { expect, test } from '@playwright/test';
import type { ChatDetail, Job, ReaderDetail } from '../core/types.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import { postFixtureChat } from './fixtures/chat.js';
import { nativeProse } from './fixtures/native-message.js';
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
    await expect(page.locator('.reader-loading-skeleton')).toHaveCount(0);
    await page.clock.fastForward(250);
    await expect(loading).toBeVisible();
    const skeleton = page.locator('.reader-loading-skeleton');
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    await expect(skeleton.locator('.reader-loading-skeleton-paragraph span')).toHaveCount(7);
    await expect(page.getByText('사용 가능한 전역 본문 모델을 선택해 주세요.')).toHaveCount(0);
    const spinner = loading.locator('svg');
    await expect(spinner).toHaveCSS('animation-name', 'activity-spin');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(spinner).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByRole('button', { name: '본문 다시 불러오기', exact: true })).toHaveCount(
      0
    );
    await page.clock.fastForward(3100);
    await expect(page.getByText('평소보다 조금 오래 걸리고 있어요.')).toBeVisible();
    if (process.env.UIMORI_VISUAL_REVIEW === '1')
      await page.screenshot({ path: info.outputPath('reader-loading.png') });
    releaseRead();
    const error = page.getByRole('alert').filter({ hasText: '본문을 불러오지 못했어요.' });
    await expect(error).toBeVisible();
    await expect(error).toContainText('서버 작업을 완료하지 못했어요. (503)');
    await expect(loading).toHaveCount(0);
    await expect(skeleton).toHaveCount(0);
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

test('READERREC missing model warning waits for reader and model lookup to finish', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, 'Delayed model lookup', 1);
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseLibrary!: () => void;
  const libraryGate = new Promise<void>((resolve) => {
    releaseLibrary = resolve;
  });
  await page.route(/\/api\/health(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    await route.fulfill({ response, json: { ...health, testMode: false } });
  });
  await page.route('**/api/library?view=summary', async (route) => {
    await libraryGate;
    const response = await route.fetch();
    const library = await response.json();
    await route.fulfill({ response, json: { ...library, models: [] } });
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.getByTestId('source')).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: /현재 본문 모델 · 본문 모델을 확인하고 있어요/ })
    ).toBeVisible();
    await expect(page.getByText('사용 가능한 전역 본문 모델을 선택해 주세요.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeDisabled();
    releaseLibrary();
    await expect(page.getByText('사용 가능한 전역 본문 모델을 선택해 주세요.')).toBeVisible();
    await expect(
      page.getByRole('button', { name: '현재 본문 모델 · 본문 모델을 선택해 주세요' })
    ).toBeVisible();
  } finally {
    releaseLibrary();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('READERREC a failed model-settings read offers retry instead of a missing-model claim', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, 'Model lookup recovery', 1);
  let failures = 1;
  await page.route('**/api/prompt-workspace', (route) => {
    if (failures-- > 0) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    return route.continue();
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.getByTestId('source')).toHaveCount(1);
    const error = page.getByRole('alert').filter({ hasText: '모델 설정을 확인하지 못했어요.' });
    await expect(error).toBeVisible();
    await expect(page.getByText('사용 가능한 전역 본문 모델을 선택해 주세요.')).toHaveCount(0);
    await error.getByRole('button', { name: '다시 불러오기' }).click();
    await expect(error).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('READERREC failed optional reading sync stays silent until the reader regains focus', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, 'Optional reading sync failure', 1);
  let lookups = 0;
  await page.route(`**/api/chats/${chat.id}/reading-position?*`, (route) => {
    lookups++;
    return route.fulfill({ status: 503, json: { error: 'Reading position unavailable' } });
  });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source').first()).toBeVisible();
  await expect.poll(() => lookups).toBe(1);
  await expect(page.getByRole('alert', { name: '읽기 위치 연결 오류' })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(lookups).toBe(1);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => lookups).toBe(2);
  await expect(page.getByRole('alert', { name: '읽기 위치 연결 오류' })).toHaveCount(0);
});

test('READERREC a failed refocus lookup does not suspend an already healthy reader', async ({
  page,
  request,
}) => {
  const { chat, detail } = await createReadingChat(request, 'Refocus lookup failure', 3);
  let lookups = 0;
  await page.route(`**/api/chats/${chat.id}/reading-position?*`, (route) => {
    lookups++;
    if (lookups === 1) return route.continue();
    return route.fulfill({ status: 503, json: { error: 'Temporary reading sync failure' } });
  });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source').first()).toBeVisible();
  await expect.poll(() => lookups).toBe(1);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => lookups).toBe(2);
  await page
    .getByRole('button', { name: '장면 목록 열기', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page
    .getByRole('dialog', { name: '장면 목록', exact: true })
    .getByRole('button', { name: /^2번째 장면 ·/ })
    .click();
  const clientId = await page.evaluate(() => localStorage.getItem('uimori:reading-client'));
  const path = `/api/chats/${chat.id}/reading-position?${new URLSearchParams({ clientId: clientId! })}`;
  await expect
    .poll(async () => (await (await request.get(path)).json()).own?.target.sourceId, {
      timeout: 4500,
    })
    .toBe(detail.sources[1].id);
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
  await page
    .getByRole('dialog', { name: '이전 요청 접수 확인', exact: true })
    .getByRole('button', { name: '접수 확인', exact: true })
    .click();
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
      if (
        (key.startsWith('reading:') && (this === localStorage || this === sessionStorage)) ||
        (key.startsWith('cursor:') && this === sessionStorage)
      ) {
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
    await page
      .getByRole('dialog', { name: '이전 요청 접수 확인', exact: true })
      .getByRole('button', { name: '접수 확인', exact: true })
      .click();
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

test('NOTICELOAD response waits are centered and keep streamed text until the saved source arrives', async ({
  page,
  request,
}, info) => {
  const { chat, detail } = await createReadingChat(request, 'Response waiting feedback', 1);
  const run = detail.runs[0];
  const clockStart = Date.now();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart + 1000);
  await page.addInitScript(() => {
    localStorage.setItem('uimori:reading-language', 'original');
    if (!localStorage.getItem('uimori:response-display'))
      localStorage.setItem('uimori:response-display', 'complete');
    class ControlledEvents {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
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
  let canonical = false,
    publicText = false,
    completed = false,
    streamReads = 0,
    cursor = 1000000;
  const text = '먼저 도착한 응답은 저장본을 기다리는 동안에도 남아요.';
  // The source is really saved. Only its delayed reader projection and public stream are controlled.
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete('since');
    const response = await route.fetch({ url: url.toString() });
    const body: ReaderDetail = await response.json();
    if (!canonical) {
      body.sources = [];
      body.jobs = [];
      body.runs = [
        { ...body.runs[0], status: completed ? 'completed' : 'running', sourceRevision: null },
      ];
      Object.assign(body.reader, {
        pendingRunIds: [run.id],
        order: [],
        navigation: [],
        activity: [],
        responseActivity: [],
        total: 0,
        latest: null,
        activeJobs: completed ? 0 : 1,
      });
    }
    body.reader.cursor = cursor;
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/response-streams/main/${run.id}?*`, async (route) => {
    streamReads++;
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
    await route.fulfill({
      json: {
        taskKind: 'main',
        taskId: run.id,
        status: completed ? 'completed' : 'running',
        cursor: publicText ? 1 : 0,
        hasMore: false,
        chunks:
          publicText && after === 0
            ? [{ seq: 1, segment: 0, attemptId: 'public', text, offset: text.length }]
            : [],
      } satisfies ResponseStreamPage,
    });
  });
  const refresh = async () => {
    cursor++;
    const response = page.waitForResponse(
      (item) => item.url().includes(`/chats/${chat.id}/reader?`) && item.ok()
    );
    await page.evaluate(
      (seq) =>
        dispatchEvent(
          new CustomEvent('test-reader-event', { detail: { kind: 'run.completed', seq } })
        ),
      cursor
    );
    await page.clock.runFor(150);
    await response;
  };
  try {
    for (const mode of ['complete', 'stream']) {
      canonical = publicText = completed = false;
      const readsBefore = streamReads;
      if (mode === 'stream')
        await page.evaluate((mode) => localStorage.setItem('uimori:response-display', mode), mode);
      await page.goto(`/?chat=${chat.id}`);
      const pending = page.getByTestId('pending-run');
      await expect(pending).toBeVisible();
      const waiting = pending.locator('.loading-state').getByRole('status');
      await page.clock.runFor(50);
      await expect(waiting).toHaveCount(0);
      await page.clock.runFor(200);
      await expect(waiting).toBeVisible();
      const spinner = waiting.locator('svg');
      await expect(spinner).toHaveCSS('animation-name', 'activity-spin');
      const hostBounds = await pending.locator('.loading-state').boundingBox();
      const spinnerBounds = await spinner.boundingBox();
      expect(
        Math.abs(
          spinnerBounds!.x + spinnerBounds!.width / 2 - (hostBounds!.x + hostBounds!.width / 2)
        )
      ).toBeLessThan(2);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(spinner).toHaveCSS('animation-name', 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      if (mode === 'stream') {
        await page.screenshot({ path: info.outputPath('reader-response-waiting.png') });
        publicText = true;
        await page.clock.runFor(350);
        await expect(pending.locator('.streaming-text')).toHaveText(text);
        await expect(waiting).toHaveCount(0);
        completed = true;
        await page.clock.runFor(350);
        await expect(pending.locator('.streaming-response')).toHaveAttribute(
          'data-status',
          'completed'
        );
        await expect(pending.locator('.streaming-text')).toHaveText(text);
        await expect(waiting).toHaveCount(0);
      } else {
        expect(streamReads).toBe(readsBefore);
        completed = true;
        await refresh();
        await expect(waiting).toBeVisible();
      }
      canonical = true;
      await refresh();
      await expect(pending).toHaveCount(0);
      await expect(nativeProse(page.getByTestId('source'))).toContainText(
        'Scene 1. Mira carried a purple umbrella.'
      );
      await expect(page.getByTestId('source').locator('.loading-state')).toHaveCount(0);
    }
    const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(after.sources).toEqual(detail.sources);
    expect(after.runs).toEqual(detail.runs);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('NOTICELOAD translation admission and active jobs wait centrally while failure preserves source and retry', async ({
  page,
  request,
}, info) => {
  const owner = await (
    await postFixtureChat(request, { data: { title: 'Translation waiting source' } })
  ).json();
  const transcript = await (await request.get(`/api/chats/${owner.id}/transcript`)).json();
  const text = 'Saved original text remains available during translation recovery.';
  transcript.entries = [{ request: 'Translation waiting fixture', text, translation: null }];
  const imported = await request.post('/api/chats/import-transcript', {
    data: { transcript, idempotencyKey: `translation-wait-${owner.id}` },
  });
  expect(imported.ok()).toBe(true);
  const chat = (await imported.json()).chat;
  const original: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  const source = original.sources[0];
  let job: Job | null = null,
    submissions = 0,
    cursor = 1000000;
  let release = () => {};
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.addInitScript(() => {
    class ControlledEvents {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
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
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete('since');
    const response = await route.fetch({ url: url.toString() });
    const body: ReaderDetail = await response.json();
    body.jobs = job ? [job] : [];
    body.reader.activeJobs = job && ['queued', 'running'].includes(job.status) ? 1 : 0;
    body.reader.cursor = cursor;
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/sources/${source.id}/translation`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({});
    submissions++;
    if (submissions === 1) await admission;
    job = {
      id: `synthetic-waiting-translation-${submissions}`,
      chatId: chat.id,
      sourceRevision: source.id,
      sourceHash: source.hash,
      kind: 'translation',
      status: 'queued',
      attempt: 1,
      revision: submissions,
      result: null,
      error: null,
    };
    await route.fulfill({ json: job });
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    const scene = page.getByTestId('source');
    const draft = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
    await draft.fill('번역 대기와 재시도 뒤에도 남을 초안');
    await scene.getByRole('button', { name: '번역 보기', exact: true }).click();
    const waiting = scene.locator('.translation-placeholder .loading-state').getByRole('status');
    await expect(waiting).toBeVisible();
    await expect(waiting.locator('svg')).toBeVisible();
    await expect(waiting).toHaveCSS('justify-items', 'center');
    await expect(scene.getByRole('button', { name: '번역 보기', exact: true })).toBeDisabled();
    expect(submissions).toBe(1);
    release();
    await expect.poll(() => job?.status).toBe('queued');
    await expect(waiting).toBeVisible();
    await scene.getByRole('button', { name: '원문부터 읽기', exact: true }).click();
    await expect(nativeProse(scene)).toContainText(text);
    await scene.getByRole('button', { name: '번역 보기', exact: true }).click();
    await expect(waiting).toBeVisible();
    expect(submissions).toBe(1);
    job = { ...job!, status: 'running' };
    await page.reload();
    // Without a completed translation, reopening starts with the saved original.
    await expect(nativeProse(scene)).toContainText(text);
    await expect(waiting).toHaveCount(0);
    await scene.getByRole('button', { name: '번역 보기', exact: true }).click();
    await expect(waiting).toBeVisible();
    expect(submissions).toBe(1);
    await page.screenshot({ path: info.outputPath('reader-translation-waiting.png') });
    job = { ...job, status: 'failed', error: 'AUXILIARY_PROVIDER_TIMEOUT' };
    // Deliver failure while the translation view is open; reopening a failed view
    // instead starts with the original, and its translation button admits a new retry.
    const failedRead = page.waitForResponse(
      (item) => item.url().includes(`/chats/${chat.id}/reader?`) && item.ok()
    );
    await page.evaluate(
      (seq) =>
        dispatchEvent(
          new CustomEvent('test-reader-event', { detail: { kind: 'job.failed', seq } })
        ),
      ++cursor
    );
    await failedRead;
    await expect(waiting).toHaveCount(0);
    const retry = scene.getByRole('button', { name: '번역 다시 시도', exact: true });
    await expect(retry).toBeVisible();
    await expect(scene.locator('.translation-placeholder')).toContainText('원문은 보존돼요.');
    await page.screenshot({ path: info.outputPath('reader-translation-failed.png') });
    await retry.click();
    await expect.poll(() => submissions).toBe(2);
    await expect(waiting).toBeVisible();
    job = {
      ...job!,
      status: 'completed',
      error: null,
      result: {
        mock: false,
        sourceRevision: source.id,
        sourceHash: source.hash,
        text: '복구된 번역이에요.',
      },
    };
    await page.reload();
    await scene.getByRole('button', { name: '번역 보기', exact: true }).click();
    await expect(scene.getByTestId('translation-text')).toContainText('복구된 번역이에요.');
    await expect(waiting).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    expect(submissions).toBe(2);
    await expect(draft).toHaveValue('번역 대기와 재시도 뒤에도 남을 초안');
    const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(after.sources).toEqual(original.sources);
    expect(after.runs).toEqual(original.runs);
    expect(after.jobs).toEqual(original.jobs);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
