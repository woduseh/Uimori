import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { reviewWidths, visualReview } from './fixtures/visual-review.js';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, openSourceActions } from './ui-navigation.js';

async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext, title: string, requests: string[]) {
  const created = await postFixtureChat(request, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = (await created.json()) as Chat;
  const configured = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...chat.settings,
      status: false,
      expectedSettingsRevision: chat.settingsRevision,
    },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  for (const [index, text] of requests.entries()) {
    const before = await detail(request, chat.id);
    const started = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: text,
        expectedRevision: before.chat.headRevision,
        expectedSettingsRevision: before.chat.settingsRevision,
        expectedProfileRevision: before.profile!.revision,
        idempotencyKey: `response-actions-${chat.id}-${index}`,
      },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const run = (await started.json()) as Run;
    await expect
      .poll(
        async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
      )
      .toBe('completed');
  }
  return detail(request, chat.id);
}

async function noHorizontalOverflow(page: Page, region: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  expect(await region.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

test('RACOM04 last response retry chooses replacement or copy and preserves the response until success', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  const before = await seed(request, '재요청 방식 합성 채팅', ['첫 장면', '마지막 장면']);
  const old = before.sources.at(-1)!;
  const modes: string[] = [];
  page.on('request', (event) => {
    if (event.method() === 'POST' && event.url().endsWith('/retry'))
      modes.push(event.postDataJSON().mode);
  });
  const control = async (action: string, extra: Record<string, string>) => {
    const response = await request.post('/api/test/control', { data: { action, ...extra } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await page.goto(`/?chat=${before.chat.id}`);
  const oldScene = page.locator(`[data-testid="source"][data-source-id="${old.id}"]`);
  const reopen = async () => {
    await openSourceActions(oldScene);
    await oldScene.getByRole('button', { name: '현재 설정으로 다시 요청', exact: true }).click();
  };
  await reopen();
  const dialog = page.getByRole('dialog', { name: '현재 설정으로 다시 요청', exact: true });
  await expect(
    dialog.getByRole('button', { name: '새 채팅에서 다시 요청', exact: true })
  ).toBeVisible();
  for (const width of [412, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page, dialog);
    await page.screenshot({
      path: info.outputPath(`retry-choice-${width}.png`),
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 412, height: 900 });
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect(modes).toHaveLength(0);
  await expect(oldScene).toBeVisible();

  // An admitted replacement that fails before source commit leaves the original readable.
  await control('fail-next', { point: 'source-transaction' });
  await reopen();
  await dialog.getByRole('button', { name: '기존 응답 교체', exact: true }).click();
  await expect
    .poll(async () =>
      (await detail(request, before.chat.id)).runs.some(
        (run) => run.snapshot.replacement?.sourceRevision === old.id && run.status === 'failed'
      )
    )
    .toBe(true);
  await expect(oldScene).toBeVisible();
  expect((await detail(request, before.chat.id)).chat.headRevision).toBe(old.id);

  await control('hold', { barrier: 'run' });
  try {
    await reopen();
    await dialog.getByRole('button', { name: '기존 응답 교체', exact: true }).click();
    await expect(page.getByRole('button', { name: '원문 생성 취소', exact: true })).toBeVisible();
    await expect(oldScene).toBeVisible();
    await page.getByRole('button', { name: '원문 생성 취소', exact: true }).click();
    await expect
      .poll(async () =>
        (await detail(request, before.chat.id)).runs.some(
          (run) => run.snapshot.replacement?.sourceRevision === old.id && run.status === 'cancelled'
        )
      )
      .toBe(true);
    expect((await detail(request, before.chat.id)).chat.headRevision).toBe(old.id);
    await expect(oldScene).toBeVisible();
  } finally {
    await control('release', { barrier: 'run' });
  }

  await control('hold', { barrier: 'run' });
  try {
    await reopen();
    await dialog.getByRole('button', { name: '기존 응답 교체', exact: true }).click();
    await expect(page.getByRole('button', { name: '원문 생성 취소', exact: true })).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await expect(oldScene).toBeVisible();
    expect((await detail(request, before.chat.id)).chat.headRevision).toBe(old.id);
  } finally {
    await control('release', { barrier: 'run' });
  }
  await expect
    .poll(async () => (await detail(request, before.chat.id)).chat.headRevision)
    .not.toBe(old.id);
  await expect(oldScene).toHaveCount(0);
  await expect(page.getByTestId('source')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get('chat')).toBe(before.chat.id);
  expect(modes).toEqual(['replace', 'replace', 'replace']);

  const replaced = (await detail(request, before.chat.id)).sources.at(-1)!;
  const replacedScene = page.locator(`[data-testid="source"][data-source-id="${replaced.id}"]`);
  await openSourceActions(replacedScene);
  await replacedScene.getByRole('button', { name: '현재 설정으로 다시 요청', exact: true }).click();
  await dialog.getByRole('button', { name: '새 채팅에서 다시 요청', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(before.chat.id);
  const copiedChatId = new URL(page.url()).searchParams.get('chat')!;
  await expect.poll(async () => (await detail(request, copiedChatId)).sources.length).toBe(2);
  expect(modes.at(-1)).toBe('copy');
  expect((await detail(request, before.chat.id)).chat.headRevision).toBe(replaced.id);
  await page.goto(`/?chat=${before.chat.id}`);

  // Earlier scenes still take the existing copy path without offering destructive replacement.
  const first = page.locator(`[data-testid="source"][data-source-id="${before.sources[0].id}"]`);
  await openSourceActions(first);
  await first.getByRole('button', { name: '현재 설정으로 다시 요청', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(before.chat.id);
  const earlierCopyChatId = new URL(page.url()).searchParams.get('chat')!;
  await expect.poll(async () => (await detail(request, earlierCopyChatId)).sources.length).toBe(1);
});

test('RACOM01 source footer stays compact and its menu supports touch, keyboard and dismissal at representative widths with optional six-width review', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  const sceneRequest =
    '합성 화면 검사: 등대지기는 항구에서 돌아온 편지를 펼쳤다.\n\n' +
    '바닷바람이 창문을 두드렸고 두 사람은 다음 항해를 이야기했다. '.repeat(35);
  const before = await seed(request, '응답 작업 메뉴 합성 채팅', [sceneRequest]);
  const source = before.sources[0];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  for (const width of reviewWidths([320, 360, 390, 412, 768, 1440])) {
    await page.setViewportSize({ width, height: width >= 768 ? 1000 : 844 });
    await page.goto(`/?chat=${before.chat.id}`);
    const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
    const footer = scene.locator('.source-actions');
    const trigger = footer.getByLabel('장면 작업 메뉴', { exact: true });
    const menu = trigger.locator('..');
    await expect(scene.getByTestId('source-text')).toBeVisible();
    await page.getByLabel('다음 장면 요청', { exact: true }).fill('메뉴를 닫아도 남는 합성 초안');
    await trigger.scrollIntoViewIfNeeded();
    await expect(menu).toHaveJSProperty('open', false);
    // Primary reader actions stay on the row; detail and cost disclosures live in the menu.
    // The footer stays compact while each first-class reader action remains reachable.
    // Do not freeze the exact action count: optional user-facing actions such as bookmarks
    // can be added without changing the overflow-menu contract.
    await expect(footer.getByRole('button', { name: '본문 복사', exact: true })).toBeVisible();
    await expect(footer.getByRole('button', { name: '원문 수정', exact: true })).toBeVisible();
    await expect(footer.getByRole('button', { name: /책갈피 추가/ })).toBeVisible();
    await expect(trigger).toBeVisible();
    for (const control of await footer.locator('button, summary').filter({ visible: true }).all()) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // Narrow phones may wrap the disclosures under the icon row; wider screens keep one row.
    if (visualReview)
      expect((await footer.boundingBox())!.height).toBeLessThanOrEqual(width < 400 ? 100 : 52);
    await noHorizontalOverflow(page, scene);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`response-actions-${width}.png`) });

    await trigger.focus();
    await trigger.press('Enter');
    await expect(menu).toHaveJSProperty('open', true);
    const actions = menu.locator('.action-menu-body');
    // The row already edits the current view, so the menu offers the other editor only.
    await expect(actions.getByRole('button')).toHaveText([
      '도우미에게 물어보기',
      '현재 설정으로 다시 요청',
      '이 장면까지 새 채팅으로 복사',
      '번역 수정',
      '이미지 자동 배치',
      '삽화 생성',
      '원문 연결 정보',
      ...(before.attempts?.some((attempt) => attempt.runId === source.runId)
        ? ['본문 추정 비용']
        : []),
    ]);
    const openTriggerBox = (await trigger.boundingBox())!;
    const menuBox = (await actions.boundingBox())!;
    const height = page.viewportSize()!.height;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(height);
    // Up to 600px the menu is a bottom sheet (every row inside the viewport, resting on the
    // bottom edge); wider screens keep the popover that opens above its trigger.
    if (width <= 600) {
      expect(menuBox.y + menuBox.height).toBeGreaterThanOrEqual(height - 24);
      for (const item of await actions.getByRole('button').all()) {
        const box = (await item.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
      }
    } else expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(openTriggerBox.y + 1);
    if (width === MOBILE_WIDTH || width === DESKTOP_WIDTH)
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`response-menu-${width}.png`) });
    await page.keyboard.press('Tab');
    await expect(actions.getByRole('button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveJSProperty('open', false);
    await expect(trigger).toBeFocused();

    await openSourceActions(scene);
    const composer = page.getByLabel('다음 장면 요청', { exact: true });
    if (width <= 600) {
      // The sheet covers the composer; a tap on the scrim above it dismisses the menu first.
      const sheet = (await actions.boundingBox())!;
      await page.mouse.click(width / 2, Math.max(8, sheet.y - 30));
      await expect(menu).toHaveJSProperty('open', false);
    }
    await composer.click();
    await expect(menu).toHaveJSProperty('open', false);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('메뉴를 닫아도 남는 합성 초안');
    await expect(footer.getByRole('button', { name: '본문 복사', exact: true })).toBeVisible();
    await expect(footer.getByRole('button', { name: '원문 수정', exact: true })).toBeVisible();
    await expect(footer.getByRole('button', { name: /책갈피 추가/ })).toBeVisible();
    await expect(trigger).toBeVisible();
  }
  const after = await detail(request, before.chat.id);
  expect(after.sources).toEqual(before.sources);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.jobs).toEqual(before.jobs);
  expect(pageErrors).toEqual([]);
});

test('TSKUI01 task overview screenshots wait for real run, job and attempt data on mobile and desktop', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  const before = await seed(request, '작업 현황 합성 채팅', [
    '항구에 도착한 등대지기가 편지를 확인하는 장면을 이어 써요.',
    '편지의 답장을 준비하며 다음 항해의 계획을 이야기해요.',
  ]);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: width === MOBILE_WIDTH ? 844 : 1000 });
    await page.goto(`/?chat=${before.chat.id}`);
    await expect(page.getByTestId('source')).toHaveCount(before.sources.length);
    const jobsLoaded = page.waitForResponse((response) =>
      response.url().endsWith(`/api/chats/${before.chat.id}/jobs`)
    );
    await navigationAction(page, '작업 현황');
    expect((await jobsLoaded).ok()).toBe(true);
    const dialog = page.getByRole('dialog', { name: '작업 현황', exact: true });
    const panel = dialog.getByRole('region', { name: '실행 기록', exact: true });
    await expect(panel.getByTestId('run')).toHaveCount(before.runs.length);
    for (const run of before.runs) {
      const card = panel.locator(`[data-testid="run"][data-run-id="${run.id}"]`);
      await expect(card.locator('.task-request')).toHaveText(run.request);
      await expect(card.locator('.task-heading > strong')).toHaveText('원문 완료');
    }
    const current = before.runs.at(-1)!;
    const card = panel.locator(`[data-testid="run"][data-run-id="${current.id}"]`);
    const diagnostics = card.getByText('실행과 실제 입력 확인', { exact: true });
    const fullLoaded = page.waitForResponse((response) =>
      response.url().endsWith(`/api/runs/${current.id}`)
    );
    await diagnostics.click();
    const fullResponse = await fullLoaded;
    expect(fullResponse.ok()).toBe(true);
    const full = (await fullResponse.json()) as Run;
    await expect(diagnostics.locator('..').locator(':scope > pre')).toHaveText(
      JSON.stringify(
        { snapshot: full.snapshot, inputs: full.inputs, toolEvents: full.toolEvents },
        null,
        2
      )
    );
    await diagnostics.click();
    const usage = panel.getByTestId('usage-inspector');
    const attemptsLoaded = page.waitForResponse((response) =>
      response.url().endsWith(`/api/chats/${before.chat.id}/attempts`)
    );
    await usage.locator(':scope > details > summary').click();
    const attemptsResponse = await attemptsLoaded;
    expect(attemptsResponse.ok()).toBe(true);
    const attempts = (await attemptsResponse.json()) as unknown[];
    await expect(usage.getByRole('table')).toBeVisible();
    await expect(usage.getByRole('rowheader')).toHaveText([
      '원문',
      '번역',
      '장면 해설',
      '이미지 배치',
      '카드 스크립트',
      '컨텍스트 압축',
      '도우미',
      '채팅 제목',
      '삽화',
    ]);
    await expect(usage.getByRole('rowheader', { name: '채팅 제목', exact: true })).toBeVisible();
    await expect(usage.getByText(new RegExp(`^전송 시도 ${attempts.length}회`))).toBeVisible();
    await expect(panel.getByRole('status').filter({ hasText: /불러오는 중/ })).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await noHorizontalOverflow(page, dialog);
    await panel.locator('.panel-intro').scrollIntoViewIfNeeded();
    if (visualReview) await page.screenshot({ path: info.outputPath(`tasks-loaded-${width}.png`) });
  }
  const after = await detail(request, before.chat.id);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.jobs).toEqual(before.jobs);
  expect(pageErrors).toEqual([]);
});
