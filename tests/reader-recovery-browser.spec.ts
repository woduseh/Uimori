import { expect, test } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';

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

for (const alternate of [false, true])
  test(`READERREC pending request survives reload with ${alternate ? 'implicit alternate default' : 'explicit main'} branch`, async ({
    page,
    request,
  }) => {
    const chat = await (
      await postFixtureChat(request, { data: { title: 'Pending recovery' } })
    ).json();
    let branch = (await (await request.get(`/api/chats/${chat.id}`)).json()).branches[0];
    if (alternate) {
      const target = await (
        await request.post(`/api/chats/${chat.id}/branches`, {
          data: { title: 'Alternate', fromRevision: null },
        })
      ).json();
      const changed = await request.put(`/api/chats/${chat.id}/branches/${target.id}/default`, {
        data: {
          expectedRevision: target.revision,
          expectedDefaultBranchId: branch.id,
          expectedDefaultBranchRevision: branch.revision,
        },
      });
      expect(changed.ok()).toBe(true);
      branch = await changed.json();
    }
    const commandKey = `command:${chat.id}${alternate ? `:${branch.id}` : ''}`;
    await page.addInitScript(
      ({ commandKey, chat, branch }) => {
        sessionStorage.setItem(
          commandKey,
          JSON.stringify({
            id: 'pending-synthetic-command',
            payload: JSON.stringify({
              request: '보존된 이전 요청',
              branchId: branch.id,
              expectedRevision: null,
              expectedSettingsRevision: chat.settingsRevision,
            }),
          })
        );
      },
      { commandKey, chat, branch }
    );
    const payloads: unknown[] = [];
    await page.route(`**/api/chats/${chat.id}/runs`, async (route) => {
      payloads.push(route.request().postDataJSON());
      await route.abort('failed');
    });
    await page.goto(
      `/?chat=${chat.id}${alternate ? '' : `&branch=${encodeURIComponent(branch.id)}`}`
    );
    await expect(page.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(1);
    expect(payloads[0]).toMatchObject({
      request: '보존된 이전 요청',
      branchId: branch.id,
      idempotencyKey: 'pending-synthetic-command',
    });
    expect(await page.evaluate((key) => sessionStorage.getItem(key), commandKey)).not.toBeNull();
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
  expect(writerRequests).toBe(0);
});
