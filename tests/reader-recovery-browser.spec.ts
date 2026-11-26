import { expect, test } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { trackPageFetches } from './fixtures/page-fetches.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { navigationAction } from './ui-navigation.js';

test.use({ reducedMotion: 'no-preference' });

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
  let releaseRetry!: () => void;
  const heldRetry = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let failed = true;
  await page.addInitScript((id) => {
    sessionStorage.setItem(`draft:${id}`, '본문 재조회 중에도 남을 초안');
    Object.defineProperty(window, 'EventSource', {
      value: class {
        addEventListener() {}
        close() {}
      },
    });
  }, chat.id);
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    if (!failed) {
      await heldRetry;
      return route.continue();
    }
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
    await expect(page.getByText('사용 가능한 기본 본문 모델을 선택해 주세요.')).toHaveCount(0);
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
    await expect(page.locator('.reader-awaiting')).toHaveCSS('justify-content', 'center');
    const centerDelta = await page.locator('.reader-awaiting').evaluate((reader) => {
      const alert = reader.querySelector('[role="alert"]')!;
      const readerBox = reader.getBoundingClientRect();
      const errorBox = alert.getBoundingClientRect();
      return Math.abs(readerBox.top + readerBox.height / 2 - (errorBox.top + errorBox.height / 2));
    });
    expect(centerDelta).toBeLessThan(36);
    await expect(loading).toHaveCount(0);
    await expect(skeleton).toHaveCount(0);
    if (process.env.UIMORI_VISUAL_REVIEW === '1')
      await page.screenshot({ path: info.outputPath('reader-loading-error.png') });
    failed = false;
    await page.getByRole('button', { name: '본문 다시 불러오기', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '본문을 다시 불러오는 중이에요…' })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '본문 다시 불러오기', exact: true })
    ).toBeDisabled();
    releaseRetry();
    await expect(page.getByTestId('source')).toHaveCount(1);
    await expect(page.getByTestId('source-request')).toContainText('검증 장면 1');
    await expect(page.getByRole('textbox', { name: '다음 장면 요청' })).toHaveValue(
      '본문 재조회 중에도 남을 초안'
    );
    await expect(error).toHaveCount(0);
    await expect(loading).toHaveCount(0);
  } finally {
    releaseRead();
    releaseRetry();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('READERREC leaving during a position write flushes the newer location after acknowledgement', async ({
  page,
  request,
}) => {
  const { chat, detail } = await createReadingChat(request, 'Position write on navigation', 3);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const targets: string[] = [];
  await page.route(`**/api/chats/${chat.id}/reading-position`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    targets.push(route.request().postDataJSON().target.sourceId);
    if (targets.length === 1) await held;
    await route.continue();
  });
  const go = async (number: number) => {
    await page
      .getByRole('button', { name: '장면 목록 열기', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page
      .getByRole('dialog', { name: '장면 목록', exact: true })
      .getByRole('button', { name: new RegExp(`^${number}번째 장면,`) })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('source'))
      .toBe(detail.sources[number - 1].id);
    await page.evaluate(async () => {
      for (let index = 0; index < 3; index++)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  };
  try {
    const loaded = page.waitForResponse(
      (response) => response.url().includes('/reading-position?') && response.ok()
    );
    await page.goto(`/?chat=${chat.id}`);
    await loaded;
    await go(2);
    await expect.poll(() => targets.length).toBe(1);
    await go(3);
    await navigationAction(page, '서재');
    release();
    const clientId = await page.evaluate(() => localStorage.getItem('uimori:reading-client'));
    const path = `/api/chats/${chat.id}/reading-position?${new URLSearchParams({ clientId: clientId! })}`;
    await expect
      .poll(async () => (await (await request.get(path)).json()).own?.target.sourceId)
      .toBe(detail.sources[2].id);
    expect(targets).toEqual([detail.sources[1].id, detail.sources[2].id]);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const scenario of ['old-refresh', 'new-move'] as const) {
  test(`READERREC a late position acknowledgement preserves newer ownership (${scenario})`, async ({
    page,
    request,
  }) => {
    const { chat, detail } = await createReadingChat(request, 'Late position acknowledgement', 4);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delivered!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const positionRequests = await trackPageFetches(
      page,
      new RegExp(`^/api/chats/${chat.id}/reading-position$`, 'u')
    );
    let holdRead = false;
    let firstRevision: number | undefined;
    const targets: string[] = [];
    await page.route(`**/api/chats/${chat.id}/reading-position`, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      targets.push(route.request().postDataJSON().target.sourceId);
      if (targets.length !== 1) return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      firstRevision = (await response.json()).revision;
      await held;
      await route.fulfill({ response });
      delivered();
    });
    await page.route(`**/api/chats/${chat.id}/reading-position?*`, async (route) => {
      if (!holdRead) return route.continue();
      holdRead = false;
      const response = await route.fetch();
      readStarted();
      await heldRead;
      await route.fulfill({ response });
    });
    const go = async (number: number) => {
      await page
        .getByRole('button', { name: '장면 목록 열기', exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await page
        .getByRole('dialog', { name: '장면 목록', exact: true })
        .getByRole('button', { name: new RegExp(`^${number}번째 장면,`) })
        .click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('source'))
        .toBe(detail.sources[number - 1].id);
      await page.evaluate(async () => {
        for (let index = 0; index < 3; index++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    };
    try {
      const initialLoad = page.waitForResponse(
        (response) => response.url().includes('/reading-position?') && response.ok()
      );
      await page.goto(`/?chat=${chat.id}`);
      await initialLoad;
      await go(2);
      await expect.poll(() => firstRevision).toBeDefined();
      await go(3);
      const clientId = await page.evaluate(() => localStorage.getItem('uimori:reading-client'));
      const path = `/api/chats/${chat.id}/reading-position`;
      const updateFromOtherTab = async () => {
        const newer = await request.put(path, {
          data: {
            clientId,
            expectedRevision: firstRevision,
            target: { chatId: chat.id, sourceId: detail.sources[0].id, representation: 'original' },
          },
        });
        expect(newer.ok(), await newer.text()).toBe(true);
        return newer.json();
      };
      let latest: { revision: number };
      if (scenario === 'old-refresh') {
        latest = await updateFromOtherTab();
        const refreshed = page.waitForResponse(
          (response) => response.url().includes('/reading-position?') && response.ok()
        );
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        expect((await (await refreshed).json()).own.revision).toBe(latest.revision);
        await navigationAction(page, '서재');
      } else {
        await navigationAction(page, '서재');
        latest = await updateFromOtherTab();
      }
      const delayedRead = scenario === 'new-move';
      holdRead = delayedRead;
      const reload = page.waitForResponse(
        (response) => response.url().includes('/reading-position?') && response.ok()
      );
      await page.goBack();
      if (delayedRead) {
        await pendingRead;
        if (scenario === 'new-move') await go(4);
      } else expect((await (await reload).json()).own.revision).toBe(latest.revision);
      release();
      await acknowledged;
      releaseRead();
      expect((await (await reload).json()).own.revision).toBe(latest.revision);
      const query = new URLSearchParams({ clientId: clientId! });
      const current = async () => (await (await request.get(`${path}?${query}`)).json()).own;
      if (scenario === 'new-move') {
        await expect.poll(current).toMatchObject({
          revision: latest.revision + 1,
          target: { sourceId: detail.sources[3].id },
        });
        expect(targets).toEqual([detail.sources[1].id, detail.sources[3].id]);
      } else {
        await expect
          .poll(
            async () =>
              (await positionRequests.list()).find((item) => item.method === 'PUT')
                ?.continuationsRan
          )
          .toBe(true);
        expect(await positionRequests.count('PUT')).toBe(1);
        expect(await current()).toMatchObject({
          revision: latest.revision,
          target: { sourceId: detail.sources[0].id },
        });
        expect(targets).toEqual([detail.sources[1].id]);
      }
    } finally {
      release();
      releaseRead();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

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
  await expect(page.getByText('요청 기록을 저장하지 못해 보내지 않았어요.')).toBeVisible();
  await expect(draft).toHaveValue('저장 실패에도 남을 초안');
  expect(submissions).toBe(0);
});
