import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectSettingsSection, visibleNavigation } from './ui-navigation.js';
import { DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { createReadingChat } from './fixtures/personal-workspace.js';

test.setTimeout(60000);
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
    const search = dialog.getByRole('searchbox', { name: '전체 채팅 검색', exact: true });
    const scope = dialog.getByRole('combobox', { name: '검색 범위' });
    await expect(scope).toHaveValue('workspace');
    const inputBox = (await search.boundingBox())!;
    const buttonBox = (await dialog
      .getByRole('button', { name: '검색', exact: true })
      .boundingBox())!;
    expect(Math.abs(inputBox.height - buttonBox.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(inputBox.y - buttonBox.y)).toBeLessThanOrEqual(2);
    for (const name of ['원문', '번역', '요청']) {
      const filter = dialog.getByRole('button', { name, exact: true });
      await expect(filter).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    await dialog.getByRole('button', { name: '번역', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '번역', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await dialog.getByLabel('전체 채팅 검색', { exact: true }).fill('미카');
    await dialog.getByRole('button', { name: '검색', exact: true }).click();
    await expect(dialog.getByText('일치하는 원고가 없어요.', { exact: true })).toBeVisible();
    await expect(search).toHaveValue('미카');
    await dialog.getByRole('button', { name: '번역', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(dialog.getByRole('button', { name: '번역', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await dialog.getByRole('button', { name: '검색', exact: true }).click();
    const result = dialog
      .locator('.manuscript-search-results article')
      .filter({ hasText: chat.title })
      .first();
    await expect(result).toContainText('보라색 우산');
    await expect(
      dialog.getByRole('heading', { name: '본문 검색 결과', exact: true })
    ).toBeVisible();
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
  const initial = (await (await request.get('/api/backups')).json()).settings;
  expect(
    (
      await request.put('/api/backups/settings', {
        data: { expectedRevision: initial.revision, enabled: false, hour: 3, minute: 0, retain: 5 },
      })
    ).ok()
  ).toBe(true);
  await panel.getByLabel('성공본 보관 개수').fill('6');
  await panel.getByRole('button', { name: '백업 설정 저장', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('바뀌었어요');
  const confirmation = page.getByRole('alertdialog', {
    name: '백업 설정 변경 버리기',
    exact: true,
  });
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 900 });
    for (const dismissal of ['continue', 'Escape', 'backdrop'] as const) {
      await panel.getByRole('button', { name: '다시 확인', exact: true }).click();
      await expect(confirmation).toBeVisible();
      const bounds = (await confirmation.boundingBox())!;
      expect(Math.abs(bounds.x + bounds.width / 2 - width / 2)).toBeLessThanOrEqual(1);
      expect(bounds.x).toBeGreaterThanOrEqual(width === MOBILE_WIDTH ? 16 : 24);
      if (dismissal === 'continue')
        await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
      else if (dismissal === 'Escape') await page.keyboard.press('Escape');
      else await page.mouse.click(8, 8);
      await expect(confirmation).toBeHidden();
      await expect(panel.getByLabel('성공본 보관 개수')).toHaveValue('6');
    }
    await panel.getByRole('button', { name: '다시 확인', exact: true }).click();
    await page.screenshot({ path: info.outputPath(`backup-discard-${width}.png`) });
    await confirmation.getByRole('button', { name: '초안 버리고 불러오기', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(panel.getByLabel('성공본 보관 개수')).toHaveValue('5');
    if (width === DESKTOP_WIDTH) {
      const current = (await (await request.get('/api/backups')).json()).settings;
      const changed = await request.put('/api/backups/settings', {
        data: { expectedRevision: current.revision, enabled: false, hour: 4, minute: 0, retain: 5 },
      });
      expect(changed.ok(), await changed.text()).toBe(true);
      await panel.getByLabel('성공본 보관 개수').fill('6');
      await panel.getByRole('button', { name: '백업 설정 저장', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('바뀌었어요');
    }
  }
  await panel.getByLabel('성공본 보관 개수').fill('2');
  await panel.getByRole('button', { name: '백업 설정 저장', exact: true }).click();
  await expect(panel.getByRole('button', { name: '백업 설정 저장', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '지금 백업', exact: true }).click();
  await expect(panel.locator('.backup-status')).toContainText('· 성공', { timeout: 30000 });
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

test('PWUI03 real scene navigation syncs to another device without gating its manuscript or moving its open page; bookmarks save in one action', async ({
  page,
  request,
  browser,
}, info) => {
  const { chat, detail } = await createReadingChat(request, `이어 읽기 검증 ${Date.now()}`, 8);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.locator('[data-testid="source"]').first()).toBeVisible();
  await page
    .getByRole('button', { name: '장면 목록 열기', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page
    .getByRole('dialog', { name: '장면 목록', exact: true })
    .getByRole('button', { name: /^6번째 장면 ·/ })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('source'))
    .toBe(detail.sources[5].id);
  const clientId = await page.evaluate(() => localStorage.getItem('uimori:reading-client'));
  const path = `/api/chats/${chat.id}/reading-position?${new URLSearchParams({ clientId: clientId! })}`;
  // Observe a real UI write; never seed the checkpoint with a preparatory PUT.
  await expect
    .poll(async () => (await (await request.get(path)).json()).own?.target.sourceId)
    .toBe(detail.sources[5].id);
  const second = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: { width: MOBILE_WIDTH, height: 900 },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await second.route(/\/reading-position\?/, async (route) => {
      await held;
      await route.continue();
    });
    const phone = await second.newPage();
    await phone.goto(`/?chat=${chat.id}`);
    // A deliberately unresolved position API cannot prevent source loading.
    await expect(phone.locator('[data-testid="source"]').first()).toBeVisible();
    const before = phone.url();
    release();
    const resume = phone.getByRole('button', { name: '다른 기기에서 이어 읽기', exact: true });
    await expect(resume).toBeVisible();
    expect(phone.url()).toBe(before);
    await phone.screenshot({
      path: info.outputPath('reading-position-banner.png'),
      animations: 'disabled',
    });
    await phone.getByRole('button', { name: '읽기 위치 안내 닫기', exact: true }).click();
    const refreshPosition = async () => {
      const refreshed = phone.waitForResponse(
        (response) =>
          response.url().includes('/reading-position?') && response.request().method() === 'GET'
      );
      await phone.evaluate(() => window.dispatchEvent(new Event('online')));
      await refreshed;
    };
    await refreshPosition();
    await expect(resume).toBeHidden();
    const previous = (await (await request.get(path)).json()).own;
    const repeated = await request.put(`/api/chats/${chat.id}/reading-position`, {
      data: { clientId, expectedRevision: previous.revision, target: previous.target },
    });
    expect(repeated.ok()).toBe(true);
    await refreshPosition();
    await expect(resume).toBeHidden();
    const advanced = await request.put(`/api/chats/${chat.id}/reading-position`, {
      data: {
        clientId,
        expectedRevision: (await repeated.json()).revision,
        target: {
          chatId: chat.id,
          sourceId: detail.sources[6].id,
          representation: 'original',
          contentHash: detail.sources[6].hash,
        },
      },
    });
    expect(advanced.ok()).toBe(true);
    await refreshPosition();
    await expect(resume).toBeVisible();
    await resume.click();
    await expect
      .poll(() => new URL(phone.url()).searchParams.get('source'))
      .toBe(detail.sources[6].id);
    await expect(phone.locator(`[data-source-id="${detail.sources[6].id}"]`)).toBeVisible();
    await refreshPosition();
    await expect(resume).toBeHidden();
    await expect(phone.getByRole('status', { name: '읽기 위치 동기화', exact: true })).toBeHidden();
    await phone.screenshot({ path: info.outputPath('real-cross-device-resume.png') });
  } finally {
    release();
    await second.close();
  }
  const scene = page.locator(`[data-source-id="${detail.sources[5].id}"]`);
  await scene.getByRole('button', { name: '책갈피 추가', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get(`/api/chats/${chat.id}/bookmarks`)).json()).length)
    .toBe(1);
  await scene.getByRole('button', { name: '책갈피 추가됨 · 메모 편집', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '책갈피 편집', exact: true });
  await edit.getByLabel('책갈피 이름').fill('비 오는 장면');
  await edit.getByLabel('책갈피 메모').fill('이 대목에서 다시 이어 쓸 것');
  await edit.getByRole('button', { name: '책갈피 변경 저장', exact: true }).click();
  await expect(edit).not.toBeVisible();
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
  await page.screenshot({ path: info.outputPath('bookmarks-desktop.png') });
  await list.getByRole('button', { name: '비 오는 장면', exact: true }).click();
  await expect(list).not.toBeVisible();
  expect(new URL(page.url()).searchParams.get('source')).toBe(detail.sources[5].id);
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
    await panel.locator('summary').filter({ hasText: '모델별 상세' }).click();
    const row = panel.getByRole('row').filter({ hasText: 'personal-usage-fixture' });
    await expect(row).toContainText('1,000');
    await expect(row).toContainText('0.25');
    await expect(row).toContainText('미확인');
    await panel.locator('summary').filter({ hasText: '일별·용도별 상세' }).click();
    await expect(panel.getByRole('row').filter({ hasText: '연결 테스트' })).toBeVisible();
    await panel.locator('summary[aria-label="CSV 내보내기"]').click();
    const csvPath = await panel
      .getByRole('link', { name: '모델별 CSV', exact: true })
      .getAttribute('href');
    const csv = await request.get(csvPath!);
    expect(csv.ok()).toBe(true);
    expect(await csv.text()).toContain('personal-usage-fixture');
    expect(await csv.text()).not.toContain('Synthetic connection response');
    await panel.locator('summary[aria-label="CSV 내보내기"]').press('Escape');
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

test('PWUI08 title matches report all saved chats and the next page remains selectable', async ({
  page,
  request,
}) => {
  const owner = await postFixtureChat(request, { data: { title: '제목 검색 자료' } });
  const botId = (await owner.json()).botId;
  const prefix = `제목검증-${Date.now()}`;
  let last = '';
  for (let index = 0; index < 35; index++) {
    const response = await request.post('/api/chats', {
      data: { title: `${prefix}-${String(index).padStart(2, '0')}`, botId },
    });
    expect(response.ok()).toBe(true);
    last = (await response.json()).id;
  }
  await page.goto('/');
  await visibleNavigation(page);
  await page
    .getByRole('button', { name: '전체 채팅 검색', exact: true })
    .filter({ visible: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '전체 채팅 검색', exact: true });
  await dialog.getByRole('searchbox', { name: '전체 채팅 검색', exact: true }).fill(prefix);
  await expect(dialog.locator('summary').filter({ hasText: '제목 일치' })).toHaveText(
    '제목 일치 35개'
  );
  await expect(dialog.locator('[data-chat-id]')).toHaveCount(5);
  for (let remaining = 30; remaining > 0; remaining -= 5) {
    await dialog
      .getByRole('button', { name: `채팅 제목 더 보기 · ${remaining}개 남음`, exact: true })
      .click();
  }
  await expect(dialog.locator('[data-chat-id]')).toHaveCount(35);
  await dialog.locator(`[data-chat-id="${last}"]`).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(last);
});
