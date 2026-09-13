import { test, expect, type APIRequestContext } from '@playwright/test';
import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { createPanelPackage } from './fixtures/panel-package.js';
import {
  createLibraryContent,
  navigationAction,
  openChatSettings,
  revealLibraryEditor,
  selectChatSettingsSection,
  selectPackageSection,
} from './ui-navigation.js';
import { waitForContentDraftSave } from './fixtures/edit-draft-save.js';

test('PROGTOOLUI01 creators enable model and response code hooks without a user button', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await page.goto('/');
  await navigationAction(page, '서재');
  const library = page.getByTestId('library-panel');
  await createLibraryContent(page);
  await revealLibraryEditor(page);
  await library.getByLabel('자료 이름', { exact: true }).fill('Synthetic model code creator');
  await library.getByLabel('자료 본문', { exact: true }).fill('Synthetic only.');
  await selectPackageSection(page, '상태와 행동');
  const fields = library.getByRole('region', { name: '패키지 구성', exact: true });
  await fields.getByRole('button', { name: '코드 계산 예제 넣기', exact: true }).click();
  const methods = fields.getByRole('group', { name: '중복 없는 항목 세기 호출 방법', exact: true });
  await expect(methods.getByRole('checkbox', { name: /^생성 전 자동 실행/ })).toBeEnabled();
  await methods.getByRole('checkbox', { name: /^모델이 필요할 때 요청/ }).check();
  await methods.getByRole('checkbox', { name: /^사용자 버튼/ }).uncheck();
  await methods.getByRole('checkbox', { name: /^생성 후 자동 실행/ }).check();
  await fields
    .getByLabel('중복 없는 항목 세기 자동 실행 입력 JSON', { exact: true })
    .fill('{"text":"synthetic response hook input"}');
  await fields.getByRole('checkbox', { name: /^자기 자료 읽기/ }).check();
  await fields.getByRole('checkbox', { name: /^추가 모델 호출/ }).check();
  await fields.getByRole('checkbox', { name: /^방금 생성한 원문 읽기/ }).check();
  await fields.getByRole('button', { name: '동작 검증 후 적용', exact: true }).click();
  const saving = waitForContentDraftSave(page);
  await library.getByRole('button', { name: '자료 등록', exact: true }).click();
  const content = await saving;
  expect(content.package!.behavior!.actions[0]).toMatchObject({
    triggers: expect.arrayContaining(['model', 'after-turn']),
    automaticInput: { text: 'synthetic response hook input' },
    program: {
      api: 'uimori-state-action-v1',
      capabilities: ['materials.read.self', 'model.generate', 'response.read.current'],
    },
  });
  expect(content.package!.behavior!.actions[0].triggers).toHaveLength(2);
  const created = await request.post('/api/chats', {
    data: { title: 'Synthetic model code', botId: content.id },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = await created.json();
  await page.goto(`/?chat=${chat.id}`);
  const panel = page.getByRole('region', { name: '채팅 상태와 행동', exact: true });
  await expect(panel.getByText('모델 요청', { exact: true })).toBeVisible();
  await expect(panel.getByText('응답 후 자동', { exact: true })).toBeVisible();
  await expect(panel.getByText('코드 계산', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '중복 없는 항목 세기', exact: true })).toHaveCount(
    0
  );
  await openChatSettings(page);
  await selectChatSettingsSection(page, '봇·페르소나·모듈');
  const settings = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  const attachment = settings
    .locator('.package-attachment')
    .filter({ has: page.getByRole('heading', { name: content.title, exact: true }) });
  const grant = attachment.getByRole('switch', {
    name: `${content.title} 추가 모델 호출 허용`,
    exact: true,
  });
  await expect(grant).toBeVisible();
  await expect(attachment.getByText(/전역 설정에서 확장 호출 모델을 선택/)).toBeVisible();
  await grant.check();
  await settings.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
  await expect(settings.getByText('채팅 설정을 저장했어요.', { exact: true })).toBeVisible();
  const savedChat = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(savedChat.profile.extensionGrants).toEqual({
    [`${content.id}:bot`]: {
      packageRevision: content.revision,
      capabilities: ['model.generate'],
    },
  });
  const detail = await (await request.get(`/api/chats/${chat.id}/package-behaviors`)).json();
  expect(detail.instances[0].stateRevision).toBe(0);
});

async function seed(request: APIRequestContext, hostile = false, program = false) {
  const pkg = createPanelPackage();
  if (program) {
    const note = pkg.behavior!.actions.find((action) => action.id === 'note')!;
    note.effects = [];
    note.program = {
      api: 'uimori-state-action-v1',
      capabilities: ['materials.read.self'],
      source:
        'const listed = await api.host.call("materials.list", {}); const body = listed.items.find(item => item.id.endsWith(":body")); const own = await api.host.call("materials.read", {id: body.id}); const words = [...new Set(api.input.note.trim().split(/\\s+/).filter(Boolean))].sort(); return {state: {...api.state, note: own.text + "|" + words.join(" ")}, result: {count: words.length, materialHash: own.contentHash}};',
    };
    const again = pkg.behavior!.actions.find((action) => action.id === 'again')!;
    again.effects = [];
    again.program = {
      api: 'uimori-state-action-v1',
      source: 'throw Error("guest private content");',
    };
  }
  if (hostile) {
    pkg.panels![0].template.unshift({
      kind: 'text',
      text: '<script>parent.document.body.dataset.panelEscape="yes"</script><img src="https://panel-probe.invalid/image"><iframe src="https://panel-probe.invalid/frame"></iframe><a href="https://panel-probe.invalid/link">외부 이동</a><p onclick="parent.document.body.dataset.panelEscape=\'yes\'">표시 내용</p>',
    });
    pkg.panels![0].css +=
      ' @import url("https://panel-probe.invalid/style"); body{background-image:url("https://panel-probe.invalid/bg")}';
  }
  const saved = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title: pkg.title,
      description: '',
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const content = await saved.json();
  const created = await request.post('/api/chats', {
    data: { title: 'Synthetic panel UI', botId: content.id },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()) as { id: string };
}
test('PROGPREPUI01 a user can skip pending automatic code preparation and continue the same chat request', async ({
  page,
  request,
}) => {
  const pkg = createPanelPackage();
  pkg.behavior!.actions.push({
    id: 'prepare',
    triggers: ['before-turn'],
    automaticInput: {},
    inputSchema: { type: 'record', properties: {} },
    effects: [],
    program: {
      api: 'uimori-state-action-v1',
      source: 'return {state:{...api.state,note:"prepared"},result:null};',
    },
  });
  const added = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title: 'Synthetic automatic panel',
      description: '',
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(added.ok(), await added.text()).toBe(true);
  const content = await added.json();
  const created = await request.post('/api/chats', {
    data: { title: 'Synthetic preparation skip', botId: content.id },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = await created.json();
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
  try {
    const admitted = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: 'Write a quiet arrival.',
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const run = await admitted.json();
    await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await page
      .getByTestId('pending-run')
      .getByTestId('turn-activity')
      .locator(':scope > summary')
      .click();
    const skip = page.getByRole('button', { name: '자료 자동 준비 건너뛰기', exact: true });
    await expect(skip).toBeVisible();
    await skip.click();
    await expect(
      page.getByText('자료의 자동 행동 준비를 건너뛰었어요.', { exact: false })
    ).toBeVisible();
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
    await expect
      .poll(async () => (await (await request.get(`/api/runs/${run.id}`)).json()).status)
      .toBe('completed');
    const detail = await (await request.get(`/api/chats/${chat.id}/package-behaviors`)).json();
    expect(detail.instances[0].state.note).toBe('');
    const finished = await (await request.get(`/api/runs/${run.id}`)).json();
    expect(finished.request).toBe('Write a quiet arrival.');
    await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeEnabled();
  } finally {
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
  }
});
test('PROGPOSTUI01 response processing skip sends the owned command and shows settlement status', async ({
  page,
  request,
}) => {
  const chat = await seed(request);
  const current = (await (await request.get(`/api/chats/${chat.id}`)).json()).chat;
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
  let runId: string | undefined;
  try {
    const admitted = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: 'Synthetic response processing UI.',
        expectedRevision: null,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const run = await admitted.json();
    runId = run.id;
    // UI wiring uses a bounded phase projection; the actual provider/settlement path is covered
    // by after-response-model-app.test.ts with the real API and a controlled HTTP peer.
    let skipped = false;
    let command: Record<string, unknown> | undefined;
    await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.runs = body.runs.map((item: { id: string }) =>
        item.id === run.id
          ? {
              ...item,
              packageAfterResponse: {
                status: skipped ? 'skipped' : 'running',
                completed: 0,
                total: 1,
                failed: 0,
              },
            }
          : item
      );
      await route.fulfill({ response, json: body });
    });
    await page.route(`**/api/runs/${run.id}/skip-package-after-response`, async (route) => {
      command = route.request().postDataJSON();
      skipped = true;
      await route.fulfill({
        json: { skipped: true, afterResponse: { status: 'skipped', completed: 0, total: 1 } },
      });
    });
    await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await page
      .getByTestId('pending-run')
      .getByTestId('turn-activity')
      .locator(':scope > summary')
      .click();
    await page.getByRole('button', { name: '응답 후 처리 건너뛰기', exact: true }).click();
    expect(command).toEqual({
      chatId: chat.id,
      branchId: run.snapshot.branchId,
      expectedRevision: run.parentRevision,
      idempotencyKey: expect.any(String),
    });
    await expect(
      page.getByText('응답 후 처리를 건너뛰어 해당 상태 결과를 적용하지 않았어요.', {
        exact: false,
      })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '응답 후 처리 건너뛰기', exact: true })
    ).toHaveCount(0);
  } finally {
    if (runId) await request.post(`/api/runs/${runId}/cancel`);
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
  }
});

test('PROGCOPYUI01 a cancelled response can be read and copied without publishing it', async ({
  page,
  request,
}) => {
  const chat = await seed(request);
  const current = (await (await request.get(`/api/chats/${chat.id}`)).json()).chat;
  const preserved = 'Synthetic received prose.\n\nKeep the exact line breaks and <literal> text.';
  const copied: string[] = [];
  await page.exposeFunction('recordPendingClipboard', (text: string) => copied.push(text));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) =>
          (
            window as unknown as {
              recordPendingClipboard: (value: string) => Promise<void>;
            }
          ).recordPendingClipboard(text),
      },
    });
  });
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
  let runId: string | undefined;
  try {
    const admitted = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: 'Synthetic received output UI.',
        expectedRevision: null,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const run = await admitted.json();
    runId = run.id;
    const cancelled = await request.post(`/api/runs/${run.id}/cancel`);
    expect(cancelled.ok(), await cancelled.text()).toBe(true);
    // Only UI copying is projected here. Real cancellation/restart preservation is covered
    // by after-response-model-app.test.ts against the app and a controlled HTTP peer.
    await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.runs = body.runs.map((item: { id: string }) =>
        item.id === run.id ? { ...item, partialText: preserved } : item
      );
      await route.fulfill({ response, json: body });
    });
    await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await page.getByTestId('turn-activity').first().locator(':scope > summary').click();
    await page.getByText('보존된 출력 · 확정 원문에 합류하지 않음', { exact: true }).click();
    await expect(page.locator('.partial-result pre')).toHaveText(preserved);
    await page.getByRole('button', { name: '출력 복사', exact: true }).click();
    await expect(page.getByRole('button', { name: '출력 복사됨', exact: true })).toBeVisible();
    expect(copied).toEqual([preserved]);
    const finished = await (await request.get(`/api/runs/${run.id}`)).json();
    expect(finished.status).toBe('cancelled');
    expect(finished.sourceRevision).toBeNull();
  } finally {
    if (runId) await request.post(`/api/runs/${runId}/cancel`);
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
  }
});

test('EXTPANELUI01 code action updates its panel and a failed action preserves chat input', async ({
  page,
  request,
}) => {
  const chat = await seed(request, false, true);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const custom = page.getByRole('region', { name: '탐험 준비', exact: true });
  const iframe = page.frameLocator('iframe[title="탐험 준비 패키지 패널"]');
  await expect(custom).toHaveAttribute('aria-busy', 'false');
  await iframe.getByRole('textbox', { name: '준비 메모', exact: true }).fill('pear apple pear');
  await iframe.getByRole('button', { name: '메모 반영', exact: true }).click();
  await expect(iframe.getByRole('textbox', { name: '준비 메모', exact: true })).toHaveValue(
    'Synthetic adult explorers.|apple pear'
  );
  await page.reload();
  await expect(iframe.getByRole('textbox', { name: '준비 메모', exact: true })).toHaveValue(
    'Synthetic adult explorers.|apple pear'
  );
  await iframe.getByRole('button', { name: '경로 선택', exact: true }).click();
  await expect(iframe.locator('#route')).toHaveText('harbor');
  await iframe.getByRole('button', { name: '다시 선택', exact: true }).click();
  await expect(custom.getByRole('alert')).toBeVisible();
  await expect(iframe.locator('#route')).toHaveText('harbor');
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeEnabled();
  await expect(page.getByText('guest private content', { exact: false })).toHaveCount(0);
  const detail = await (await request.get(`/api/chats/${chat.id}/package-behaviors`)).json();
  expect(detail.instances[0].stateRevision).toBe(2);
  const current = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(current.runs).toHaveLength(0);
  expect(current.attempts).toHaveLength(0);
});
for (const width of [MOBILE_WIDTH, DESKTOP_WIDTH])
  test(`PANELUI01 current-state selection, form draft and fallback at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const chat = await seed(request);
    const endpoint = `/api/chats/${chat.id}/package-behaviors`;
    const detail = async () => await (await request.get(endpoint)).json();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    const owner = page.getByRole('region', { name: '채팅 상태와 행동', exact: true });
    const custom = page.getByRole('region', { name: '탐험 준비', exact: true });
    const iframe = page.frameLocator('iframe[title="탐험 준비 패키지 패널"]');
    await expect(custom).toHaveAttribute('aria-busy', 'false');
    const note = 'Keep this draft <literal> & safe.';
    await iframe.getByRole('textbox', { name: '준비 메모', exact: true }).fill(note);
    await iframe.getByRole('combobox', { name: '출발 경로', exact: true }).selectOption('harbor');
    const prior = await detail();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await page.route(
      `**${endpoint}`,
      async (route) => {
        await readGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(prior),
        });
      },
      { times: 1 }
    );
    await owner.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(owner).toHaveAttribute('aria-busy', 'true');
    await iframe.getByRole('button', { name: '경로 선택', exact: true }).click();
    await expect(iframe.locator('#route')).toHaveText('harbor');
    releaseRead();
    await expect.poll(async () => (await detail()).instances[0].state.route).toBe('harbor');
    await expect(iframe.getByRole('textbox', { name: '준비 메모', exact: true })).toHaveValue(note);
    await owner.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(owner).toHaveAttribute('aria-busy', 'false');
    await expect(iframe.getByRole('textbox', { name: '준비 메모', exact: true })).toHaveValue(note);
    const failurePattern = `**/api/chats/${chat.id}/package-behaviors/*/actions`;
    await page.route(failurePattern, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Synthetic panel action failure' }),
      })
    );
    await iframe.getByRole('button', { name: '메모 반영', exact: true }).click();
    await expect(custom.getByRole('alert')).toContainText('반영하지 못했어요');
    await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeEnabled();
    await expect(iframe.getByRole('textbox', { name: '준비 메모', exact: true })).toHaveValue(note);
    await page.unroute(failurePattern);
    await iframe.getByRole('button', { name: '메모 반영', exact: true }).click();
    await expect.poll(async () => (await detail()).instances[0].state.note).toBe(note);
    await expect(iframe.getByRole('textbox', { name: '준비 메모', exact: true })).toHaveValue(note);
    await page.reload();
    await expect(iframe.locator('#route')).toHaveText('harbor');
    await expect(iframe.getByRole('textbox', { name: '준비 메모', exact: true })).toHaveValue(note);
    await owner.getByText('기본 상태와 행동', { exact: true }).click();
    await expect(owner.getByRole('button', { name: '경로 다시 선택', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    const chatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(chatDetail.runs).toHaveLength(0);
    expect(chatDetail.sources).toHaveLength(0);
    expect(chatDetail.attempts).toHaveLength(0);
    if (width === MOBILE_WIDTH)
      await custom.screenshot({ path: info.outputPath('package-panel-mobile.png') });
  });

test('PANELUI02 markup cannot access app DOM, navigate, fetch remote resources or forge host actions', async ({
  page,
  request,
}) => {
  const chat = await seed(request, true);
  const externalRequests: string[] = [];
  page.on('request', (item) => {
    if (item.url().startsWith('https://panel-probe.invalid/')) externalRequests.push(item.url());
  });
  await page.route('https://panel-probe.invalid/**', (route) => route.abort());
  await page.goto(`/?chat=${chat.id}`);
  const custom = page.getByRole('region', { name: '탐험 준비', exact: true });
  await expect(custom).toHaveAttribute('aria-busy', 'false');
  const frame = (await (await custom.locator('iframe').elementHandle())!.contentFrame())!;
  expect(frame).toBeTruthy();
  expect(await frame.locator('img,iframe,a,script:not([nonce])').count()).toBe(0);
  const authority = await frame.evaluate(() => {
    let parentReadable = false,
      storageReadable = false;
    try {
      parentReadable = !!parent.document.body;
    } catch {
      /* Expected opaque origin. */
    }
    try {
      storageReadable = !!localStorage;
    } catch {
      /* Expected opaque origin. */
    }
    return { parentReadable, storageReadable };
  });
  expect(authority).toEqual({ parentReadable: false, storageReadable: false });
  expect(await page.evaluate(() => document.body.dataset.panelEscape)).toBeUndefined();
  const before = await (await request.get(`/api/chats/${chat.id}/package-behaviors`)).json();
  // Test-only attempted message from the wrong origin/window; author code is never enabled.
  await page.evaluate(() =>
    window.postMessage(
      {
        channel: 'uimori-package-panel-v1',
        token: 'wrong',
        kind: 'action',
        actionId: 'choose',
        input: { route: 'ridge' },
      },
      '*'
    )
  );
  await frame.evaluate(() =>
    parent.postMessage(
      {
        channel: 'uimori-package-panel-v1',
        token: 'wrong',
        kind: 'action',
        actionId: 'choose',
        input: { route: 'ridge' },
      },
      '*'
    )
  );
  await frame.getByText('표시 내용', { exact: true }).click();
  const after = await (await request.get(`/api/chats/${chat.id}/package-behaviors`)).json();
  expect(after.instances[0].stateRevision).toBe(before.instances[0].stateRevision);
  expect(after.instances[0].state).toEqual(before.instances[0].state);
  expect(externalRequests).toEqual([]);
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeEnabled();
});
