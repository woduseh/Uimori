import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { reviewWidths, visualReview } from './fixtures/visual-review.js';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Bookmark } from '../core/reading-state.js';
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
    await oldScene.getByRole('button', { name: '다시 쓰기', exact: true }).last().click();
  };
  await reopen();
  const dialog = page.getByRole('dialog', { name: '다시 쓰기', exact: true });
  await expect(dialog.getByRole('textbox', { name: '다시 쓸 요청' })).toHaveValue('마지막 장면');
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
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
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
  await replacedScene.getByRole('button', { name: '다시 쓰기', exact: true }).last().click();
  await dialog.getByRole('button', { name: '새 채팅에서 다시 요청', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(before.chat.id);
  const copiedChatId = new URL(page.url()).searchParams.get('chat')!;
  await expect.poll(async () => (await detail(request, copiedChatId)).sources.length).toBe(2);
  expect(modes.at(-1)).toBe('copy');
  expect((await detail(request, before.chat.id)).chat.headRevision).toBe(replaced.id);
  await page.goto(`/?chat=${before.chat.id}`);

  // Earlier scenes use the same review flow, with replacement unavailable.
  const first = page.locator(`[data-testid="source"][data-source-id="${before.sources[0].id}"]`);
  await openSourceActions(first);
  await first.getByRole('button', { name: '다시 쓰기', exact: true }).last().click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '기존 응답 교체', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '새 채팅에서 다시 요청', exact: true }).click();
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
      '다시 쓰기',
      '이 장면까지 새 채팅으로 복사',
      '번역 수정',
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

test('RACOM05 earlier scenes keep bookmark and menu visible while copy, editing and saved representations remain available', async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  const before = await seed(request, '지난 장면 작업 합성 채팅', [
    '등대지기가 편지를 펼치는 첫 장면이에요.',
    '최신 장면에서는 다음 항해를 준비해요.',
  ]);
  const source = before.sources[0];
  let translatedText = '바닷바람이 편지의 모서리를 흔들었다. 등대지기는 조용히 답장을 준비했다.';
  const translated = await request.put(`/api/sources/${source.id}/translation`, {
    data: {
      text: translatedText,
      expectedRevision: source.translationRevision ?? 0,
      expectedSourceHash: source.hash,
    },
  });
  expect(translated.ok(), await translated.text()).toBe(true);
  const copied: string[] = [];
  await page.exposeFunction('recordSceneClipboard', (value: string) => copied.push(value));
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('uimori:reading-language', 'original');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) =>
          (
            window as unknown as { recordSceneClipboard: (value: string) => Promise<void> }
          ).recordSceneClipboard(value),
      },
    });
  });
  const generationRequests: string[] = [];
  page.on('request', (event) => {
    if (event.method() === 'POST' && /\/(?:translation|retranslate)$/.test(event.url()))
      generationRequests.push(event.url());
  });
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/?chat=${before.chat.id}`);
    const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
    const latest = page.locator(
      `[data-testid="source"][data-source-id="${before.sources.at(-1)!.id}"]`
    );
    await expect(latest.locator('.source-actions > button')).toHaveCount(3);
    await expect(latest.getByRole('button', { name: '원문 수정', exact: true })).toBeVisible();
    await expect(latest.getByRole('button', { name: '번역 생성', exact: true })).toBeVisible();
    await expect(scene.locator('.scene-header button')).toHaveCount(0);
    await expect(scene.getByTestId('scene-representation')).toHaveText('원문');
    const footer = scene.locator('.source-actions');
    await expect(footer.locator(':scope > button')).toHaveCount(1);
    await expect(footer.getByRole('button', { name: '책갈피 추가', exact: true })).toBeVisible();
    await expect(scene.getByRole('button', { name: '본문 복사', exact: true })).toBeHidden();
    const opener = await openSourceActions(scene);
    const menu = opener.locator('..');
    await expect(scene.getByRole('button', { name: '원문 보기', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await scene.getByRole('button', { name: '본문 복사', exact: true }).click();
    await expect.poll(() => copied.at(-1)).toBe(source.text);
    await openSourceActions(scene);
    await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
    const original = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
    await expect(original).toBeFocused();
    await expect(original).toHaveValue(source.text);
    await original.fill('취소할 원문 수정');
    await page.keyboard.press('Escape');
    await expect(original).toHaveCount(0);
    await expect(opener).toBeFocused();
    await openSourceActions(scene);
    const translationChoice = scene.getByRole('button', { name: '번역 보기', exact: true });
    await translationChoice.click();
    await expect(scene.getByTestId('translation-text')).toContainText(translatedText);
    await expect(scene.getByTestId('scene-representation')).toHaveText('번역');
    await expect(translationChoice).toHaveAttribute('aria-pressed', 'true');
    await expect(translationChoice.locator('svg')).toHaveClass(/lucide-check/);
    await page.screenshot({ path: info.outputPath(`past-scene-menu-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
    await openSourceActions(scene);
    await scene.getByRole('button', { name: '본문 복사', exact: true }).click();
    await expect.poll(() => copied.at(-1)).toBe(translatedText);
    await openSourceActions(scene);
    await scene.getByRole('button', { name: '번역 수정', exact: true }).click();
    const translationField = scene.getByRole('textbox', { name: '번역 수정 내용', exact: true });
    await expect(translationField).toBeFocused();
    await expect(translationField).toHaveValue(translatedText);
    translatedText = `${translatedText}\n\n${width} 화면에서 다듬은 번역이에요.`;
    await translationField.fill(translatedText);
    await scene.getByRole('button', { name: '번역 저장', exact: true }).click();
    await expect(translationField).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(scene.getByTestId('translation-text')).toContainText(
      `${width} 화면에서 다듬은 번역`
    );
    await openSourceActions(scene);
    await scene.getByRole('button', { name: '원문 보기', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveJSProperty('open', false);
    await page.screenshot({ path: info.outputPath(`past-scene-actions-${width}.png`) });
    await noHorizontalOverflow(page, scene);
    await page.reload();
    await expect(scene.getByTestId('scene-representation')).toHaveText('원문');
  }
  const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  // The standing bookmark still captures the selected original passage and scene identity.
  const bookmark = scene.getByRole('button', { name: '책갈피 추가', exact: true });
  await bookmark.scrollIntoViewIfNeeded();
  const quote = await scene
    .getByTestId('source-text')
    .locator('.risu-message-content')
    .evaluate((node) => {
      const paragraph = node.querySelector('[data-uimori-prose]') ?? node;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString().trim().slice(0, 300);
    });
  expect(quote.length).toBeGreaterThan(0);
  await bookmark.click();
  await expect(
    scene.getByRole('button', { name: '책갈피 추가됨, 메모 편집', exact: true })
  ).toBeVisible();
  const bookmarks = (await (
    await request.get(`/api/chats/${before.chat.id}/bookmarks`)
  ).json()) as Bookmark[];
  expect(bookmarks.at(-1)).toMatchObject({
    quote,
    target: { sourceId: source.id, representation: 'original' },
  });
  const after = await detail(request, before.chat.id);
  expect(after.sources).toEqual(
    before.sources.map((item) =>
      item.id === source.id
        ? { ...item, translationRevision: (source.translationRevision ?? 0) + 3 }
        : item
    )
  );
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(
    after.jobs
      .filter((job) => job.kind === 'translation')
      .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0]?.result?.text
  ).toBe(translatedText);
  expect(generationRequests).toEqual([]);
});

test('RACOM06 earlier-scene translation generation stays explicit and pending or failed work keeps visible recovery', async ({
  page,
  request,
}, info) => {
  const before = await seed(request, '지난 장면 번역 복구 합성 채팅', [
    '편지를 읽어요.',
    '답장을 써요.',
  ]);
  const source = before.sources[0];
  await page.setViewportSize({ width: 360, height: 1000 });
  const fail = await request.post('/api/test/control', {
    data: { action: 'fail-next', point: 'translation' },
  });
  expect(fail.ok()).toBe(true);
  let submissions = 0;
  let release = () => {};
  let admission = Promise.resolve();
  await page.route(`**/api/sources/${source.id}/translation`, async (route) => {
    submissions++;
    await admission;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await page.goto(`/?chat=${before.chat.id}`);
    const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
    const draft = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
    await draft.fill('지난 장면의 번역이 실패해도 남길 초안');
    await expect(scene.getByRole('button', { name: '번역 생성', exact: true })).toBeHidden();
    const opener = await openSourceActions(scene);
    const generate = scene.getByRole('button', { name: '번역 생성', exact: true });
    await expect(generate).toBeVisible();
    await expect(scene.getByRole('button', { name: '번역 보기', exact: true })).toHaveCount(0);
    expect(submissions).toBe(0);
    await generate.click();
    const retry = scene.locator('.scene-header').getByRole('button', {
      name: '번역 다시 시도',
      exact: true,
    });
    await expect(retry).toBeVisible();
    await expect(scene.locator('.translation-placeholder')).toContainText('원문은 보존돼요.');
    expect(submissions).toBe(1);
    await page.screenshot({ path: info.outputPath('past-scene-translation-failed.png') });
    admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await retry.click();
    await expect(retry).toBeDisabled();
    await expect(scene.locator('.translation-placeholder .loading-state')).toBeVisible();
    await retry.dispatchEvent('click');
    expect(submissions).toBe(2);
    release();
    await expect(scene.getByTestId('translation-text')).toBeVisible();
    await expect(scene.getByTestId('scene-representation')).toHaveText('번역');
    await expect(retry).toHaveCount(0);
    await openSourceActions(scene);
    await scene.getByRole('button', { name: '원문 보기', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
    await expect(scene.getByTestId('source-text')).toBeVisible();
    await expect(draft).toHaveValue('지난 장면의 번역이 실패해도 남길 초안');
    expect(submissions).toBe(2);
    const after = await detail(request, before.chat.id);
    expect(after.sources[0]).toEqual({ ...source, translationRevision: 2 });
    expect(after.sources[1]).toEqual(before.sources[1]);
    expect(after.runs).toEqual(before.runs);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
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
    const rawRecord = diagnostics.locator('..').locator('.run-raw-record');
    await rawRecord.locator(':scope > summary').click();
    await expect(rawRecord.locator(':scope > pre')).toBeVisible();
    await expect(rawRecord.locator(':scope > pre')).toHaveText(
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
    await expect(usage.getByRole('rowheader')).toHaveText(['원문']);
    await expect(usage.getByRole('rowheader', { name: '채팅 제목', exact: true })).toHaveCount(0);
    await expect(usage.getByText(new RegExp(`^전송 시도 ${attempts.length}회`))).toBeVisible();
    await expect(panel.getByRole('status').filter({ hasText: /불러오는 중/ })).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await noHorizontalOverflow(page, dialog);
    await panel.getByTestId('run').first().scrollIntoViewIfNeeded();
    if (visualReview) await page.screenshot({ path: info.outputPath(`tasks-loaded-${width}.png`) });
  }
  const after = await detail(request, before.chat.id);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.jobs).toEqual(before.jobs);
  expect(pageErrors).toEqual([]);
});
