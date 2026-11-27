import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { openChatSettings } from './ui-navigation.js';
import { setCurrentModels } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';
import { nativeProse, waitForNativeLayout } from './fixtures/native-message.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import {
  selectSettingsSection,
  createPromptChoice,
  navigationAction,
  selectStartPrompt,
  selectChatSettingsSection,
  sourceAction,
  openChatMenu,
  openMoreSourceActions,
} from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type Page, type APIRequestContext } from './fixtures/browser-test.js';
import { createHash } from 'node:crypto';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Content } from '../core/product.js';

async function data(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function seed(
  request: APIRequestContext,
  title: string,
  prompt: string,
  count = 1,
  botId?: string
) {
  const response = botId
    ? await request.post('/api/chats', { data: { title, botId } })
    : await postFixtureChat(request, { data: { title } });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  for (let index = 0; index < count; index++) {
    const before = await data(request, chat.id);
    const response = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: prompt,
        expectedRevision: before.chat.headRevision,
        expectedSettingsRevision: before.chat.settingsRevision,
        expectedProfileRevision: before.profile!.revision,
        idempotencyKey: `ui-${chat.id}-${index}`,
      },
    });
    expect(response.ok()).toBeTruthy();
    const run = (await response.json()) as Run;
    await expect
      .poll(
        async () => (await data(request, chat.id)).runs.find((item) => item.id === run.id)?.status
      )
      .toBe('completed');
  }
  return chat;
}
async function prepareTranslations(request: APIRequestContext, chatId: string) {
  for (const source of (await data(request, chatId)).sources) {
    const response = await request.post('/api/sources/' + source.id + '/translation', { data: {} });
    expect(response.ok()).toBeTruthy();
  }
  await expect
    .poll(async () => (await data(request, chatId)).jobs.every((job) => job.status === 'completed'))
    .toBe(true);
}
async function close(page: Page) {
  if (await page.getByRole('dialog').filter({ visible: true }).count())
    await page.keyboard.press('Escape');
}
let navigationBotTitle = '';
async function nav(page: Page, name: string) {
  await navigationAction(page, name, navigationBotTitle);
}
const longPrompt =
  'SYNTHETIC_UI_LONG\n\n# 황혼의 부두\n\n> 조용한 약속을 기다려요.\n\n**미라**와 여행자는 편지를 열지 않았다.\n\n' +
  '바닷바람은 서서히 잦아들고 등대의 불빛이 어두운 수면을 건넜다. 두 사람은 오늘의 선택을 서두르지 않았다.\n\n'.repeat(
    35
  );

test.afterEach(async ({ request }) => {
  for (const barrier of ['run', 'translation']) {
    const response = await request.post('/api/test/control', {
      data: { action: 'release', barrier },
    });
    expect(response.ok()).toBeTruthy();
  }
});
test.beforeEach(async ({ request }) => {
  navigationBotTitle = `UI navigation bot ${crypto.randomUUID()}`;
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title: navigationBotTitle,
      description: 'Synthetic navigation fixture',
      text: 'Synthetic keeper.',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok()).toBeTruthy();
});

const chatListName = /의 채팅 목록$/;
test('UI01 UI02 UI04 UI05 UI09 long real sources keep composer accessible, safe prose and zero-call view changes', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const malicious =
    '\n\n<script>globalThis.__uimoriExecuted=true</script>\n\n<img src=x onerror="globalThis.__uimoriExecuted=true">\n\n<ruby>物語<rt>이야기</rt></ruby>\n\n`asset:synthetic_fixed`\n\n[unsafe](javascript:alert(1))';
  const chat = await seed(request, `합성 UI reader ${Date.now()}`, longPrompt + malicious, 3);
  await prepareTranslations(request, chat.id);
  const before = await data(request, chat.id);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const viewport of visualReview
    ? [
        { width: 360, height: 800 },
        { width: MOBILE_WIDTH, height: 844 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: DESKTOP_WIDTH, height: 1000 },
      ]
    : [
        { width: MOBILE_WIDTH, height: 844 },
        { width: DESKTOP_WIDTH, height: 1000 },
      ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.getByTestId('source')).toHaveCount(3);
    await expect(page.getByTestId('library-panel')).not.toBeVisible();
    await expect(page.getByTestId('profile-editor')).not.toBeVisible();
    const reader = page.locator('[data-reader-scrollport]');
    await expect(reader).toBeVisible();
    for (const position of [0, 0.5, 1]) {
      await reader.evaluate((element, fraction) => {
        element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction;
      }, position);
      await page.getByLabel('다음 장면 요청').fill(`합성 초안 ${position}`);
      const box = await page.getByLabel('다음 장면 요청').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight + 1
        )
      ).toBe(true);
    }
    if (DEFAULT_WIDTHS.includes(viewport.width))
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`reader-${viewport.width}.png`) });
    await openChatSettings(page);
    const settingsDialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    expect(
      await settingsDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    const settingsBox = await settingsDialog.boundingBox();
    expect(settingsBox!.x).toBeGreaterThanOrEqual(0);
    expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual(viewport.width);
    await close(page);
    await nav(page, '서재');
    await expect(page.getByTestId('library-panel')).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight + 1
      )
    ).toBe(true);
    await nav(page, '설정');
    await selectSettingsSection(page, '프로바이더와 모델');
    const connectionDialog = page.getByRole('dialog', { name: '설정', exact: true });
    expect(
      await connectionDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    await close(page);
  }
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source')).toHaveCount(3);
  const source = page.getByTestId('source').first();
  if ((await source.getAttribute('data-representation')) === 'translation')
    await sourceAction(source, '원문 보기');
  const prose = nativeProse(source.getByTestId('source-text'));
  await expect(prose.getByRole('heading', { name: '황혼의 부두', exact: true })).toBeVisible();
  await expect(prose.locator('strong').first()).toHaveText('미라');
  await expect(prose.locator('blockquote').first()).toContainText('조용한 약속');
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { __uimoriExecuted?: boolean }).__uimoriExecuted
    )
  ).toBeUndefined();
  expect(
    await prose.evaluate(
      () => (globalThis as typeof globalThis & { __uimoriExecuted?: boolean }).__uimoriExecuted
    )
  ).toBeUndefined();
  await expect(prose.locator('script, iframe, [onerror], a[href^="javascript:"]')).toHaveCount(0);
  await expect(prose.locator('ruby rt')).toHaveText('이야기');
  await sourceAction(source, '번역 보기');
  const translated = nativeProse(source.getByTestId('translation-text'));
  await expect(translated).toBeVisible();
  await expect(translated).toContainText('황혼의 부두');
  await sourceAction(source, '원문 보기');
  await sourceAction(source, '원문 연결 정보');
  const sourceInfo = page.getByRole('dialog', { name: '원문 연결 정보', exact: true });
  await sourceInfo.getByText('현재 원문', { exact: true }).click();
  await expect(sourceInfo.getByTestId('source-raw')).toHaveText(before.sources[0].text);
  await sourceInfo.getByRole('button', { name: '원문 연결 정보 닫기' }).click();
  const after = await data(request, chat.id);
  expect(after.sources).toEqual(before.sources);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.sources[0].hash).toBe(
    createHash('sha256').update(after.sources[0].text).digest('hex')
  );
  expect(errors).toEqual([]);
});

test('UI03 bot-first retry saves one story and complete profile before any generation', async ({
  page,
  request,
}) => {
  const title = `UI03-${Date.now()}`;
  const added = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: '합성 봇 시작 검사',
      text: 'Synthetic harbor keeper.',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(added.ok()).toBeTruthy();
  const bot = (await added.json()) as Content;
  const choice = await createPromptChoice(request, title);
  const priorChats = (await (await request.get('/api/chats')).json()) as Chat[];
  const writes: { url: string; method: string }[] = [];
  page.on('request', (request) => {
    if (['POST', 'PUT'].includes(request.method()))
      writes.push({ url: request.url(), method: request.method() });
  });
  let rejected = false;
  await page.route('**/api/chats/*/profile', async (route) => {
    if (route.request().method() === 'PUT' && !rejected) {
      rejected = true;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'PROFILE_REVISION_CONFLICT' }),
      });
    } else await route.continue();
  });
  await page.goto('/');
  await navigationAction(page, '새 채팅', title);
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('채팅의 봇')).toContainText(title);
  await selectStartPrompt(page, choice);
  await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('하나만 만들었어요');
  await dialog.getByRole('button', { name: '설정 저장 다시 시도', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const chats = (await (await request.get('/api/chats')).json()) as Chat[];
  const addedChats = chats.filter((chat) => !priorChats.some((item) => item.id === chat.id));
  expect(addedChats).toHaveLength(1);
  const detail = await data(request, addedChats[0].id);
  expect(detail.chat.title).toBe(`${title}의 채팅`);
  expect(detail.profile!.packageAttachments).toEqual([{ id: bot.id, revision: 1, role: 'bot' }]);
  expect(await (await request.get('/api/prompt-workspace')).json()).toMatchObject({
    main: { values: choice.combination.values },
  });
  expect(detail.runs).toHaveLength(0);
  expect(writes.filter((item) => /\/api\/chats$/.test(item.url))).toHaveLength(1);
  await page.getByLabel('다음 장면 요청').fill('합성 첫 장면');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect.poll(async () => (await data(request, addedChats[0].id)).runs.length).toBe(1);
  const run = (await data(request, addedChats[0].id)).runs[0];
  expect(run.snapshot.profile!.packageAttachments).toEqual(detail.profile!.packageAttachments);
  expect(run.snapshot.profile!.promptPresets?.main?.values).toEqual(choice.combination.values);
  const runIndex = writes.findIndex((item) => /\/runs$/.test(item.url));
  expect(runIndex).toBeGreaterThan(writes.findLastIndex((item) => /\/profile$/.test(item.url)));
});

test('UI05 UI10 late translation completion preserves the source surface and current reader position', async ({
  page,
  request,
}) => {
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'translation' } });
  let releasePresentation = () => {};
  const presentationGate = new Promise<void>((resolve) => {
    releasePresentation = resolve;
  });
  try {
    const chat = await seed(request, `합성 UI arrivals ${Date.now()}`, longPrompt, 1);
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.getByTestId('source')).toHaveCount(1);
    await page.getByRole('button', { name: '번역 생성', exact: true }).click();
    await page.getByRole('button', { name: '원문 보기', exact: true }).click();
    await waitForNativeLayout(page.getByTestId('source-text'));
    const reader = page.locator('[data-reader-scrollport]');
    await reader.evaluate((element) => {
      element.scrollTop = 0;
    });
    const readerBounds = (await reader.boundingBox())!;
    await page.mouse.move(readerBounds.x + readerBounds.width / 2, readerBounds.y + 100);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const top = await reader.evaluate((element) => element.scrollTop);
    const before = await data(request, chat.id);
    const original = nativeProse(page.getByTestId('source-text'));
    const originalBody = page.getByTestId('source-text').locator('.risu-message-content');
    await original.evaluate((node) => {
      node.setAttribute('data-presentation-probe', 'original-kept');
    });
    let holdingCompletedPresentation = false;
    await page.route(
      `**/api/chats/${chat.id}/sources/${before.sources[0].id}/presentation*`,
      async (route) => {
        const response = await route.fetch();
        expect(response.ok()).toBeTruthy();
        const presentation = await response.json();
        if (presentation.translationId) {
          holdingCompletedPresentation = true;
          await presentationGate;
        }
        await route.fulfill({ response });
      }
    );
    await request.post('/api/test/control', {
      data: { action: 'release', barrier: 'translation' },
    });
    await expect
      .poll(async () =>
        (await data(request, chat.id)).jobs.every((job) => job.status === 'completed')
      )
      .toBe(true);
    await expect.poll(() => holdingCompletedPresentation).toBe(true);
    await expect(originalBody).toHaveAttribute('data-risu-disabled', 'true');
    await expect(original).toHaveAttribute('data-presentation-probe', 'original-kept');
    await expect(page.getByRole('button', { name: '원문 보기', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(Math.abs((await reader.evaluate((element) => element.scrollTop)) - top)).toBeLessThan(3);
    releasePresentation();
    await expect(originalBody).toHaveAttribute('data-risu-disabled', 'false');
    await expect(original).toHaveAttribute('data-presentation-probe', 'original-kept');
    expect(Math.abs((await reader.evaluate((element) => element.scrollTop)) - top)).toBeLessThan(3);
    expect((await data(request, chat.id)).sources).toEqual(before.sources);
  } finally {
    releasePresentation();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const barrier of ['status', 'translation'])
      await request.post('/api/test/control', { data: { action: 'release', barrier } });
  }
});

test('UI07 UI12 lost fork response reuses one new story and Back Forward preserves independent drafts without model calls', async ({
  page,
  request,
}) => {
  const chat = await seed(
    request,
    `합성 UI fork history ${Date.now()}`,
    'Synthetic first harbor scene.',
    2
  );
  await expect
    .poll(async () =>
      (await data(request, chat.id)).jobs.every((job) => job.status === 'completed')
    )
    .toBe(true);
  const original = await data(request, chat.id);
  const priorChats = (await (await request.get('/api/chats')).json()) as Chat[];
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source')).toHaveCount(2);
  await page.getByLabel('다음 장면 요청').fill('원본 이야기의 합성 초안');
  let accepted!: (chat: Chat) => void;
  const acceptedChat = new Promise<Chat>((resolve) => {
    accepted = resolve;
  });
  const payloads: { fromRevision: string; idempotencyKey: string }[] = [];
  await page.route(`**/api/chats/${chat.id}/fork`, async (route) => {
    payloads.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    if (payloads.length === 1) {
      accepted((await response.json()) as Chat);
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  const failed = page.waitForEvent('requestfailed', (event) =>
    event.url().endsWith(`/api/chats/${chat.id}/fork`)
  );
  const forkButton = page.getByRole('button', { name: '새 채팅으로 분기', exact: true });
  await openChatMenu(page);
  await forkButton.click();
  const fork = await acceptedChat;
  await failed;
  await openChatMenu(page);
  await expect(forkButton).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
  await page.getByLabel('다음 장면 요청').fill('수락 확인 전에 새로 적은 원본 초안');
  await openChatMenu(page);
  await forkButton.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(fork.id);
  const copied = await data(request, fork.id);
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
  expect(payloads[0].fromRevision).toBe(original.chat.headRevision);
  expect(
    ((await (await request.get('/api/chats')).json()) as Chat[])
      .filter((item) => !priorChats.some((prior) => prior.id === item.id))
      .map((item) => item.id)
  ).toEqual([fork.id]);
  expect(copied.sources).toHaveLength(2);
  expect(copied.attempts).toHaveLength(0);
  expect(copied.jobs.every((job) => job.status === 'completed')).toBe(true);
  expect(copied.sources.map((source) => source.hash).sort()).toEqual(
    original.sources.map((source) => source.hash).sort()
  );
  expect(
    copied.sources.every(
      (source) =>
        source.chatId === fork.id && !original.sources.some((prior) => prior.id === source.id)
    )
  ).toBe(true);
  await expect(page.getByTestId('source')).toHaveCount(2);
  await expect(page.getByLabel('다음 장면 요청')).toHaveValue('');
  await page.getByLabel('다음 장면 요청').fill('포크 이야기의 독립 초안');
  const forkUrl = page.url();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
  await expect(page.getByLabel('다음 장면 요청')).toHaveValue('수락 확인 전에 새로 적은 원본 초안');
  await page.goForward();
  await expect(page).toHaveURL(forkUrl);
  await expect(page.getByLabel('다음 장면 요청')).toHaveValue('포크 이야기의 독립 초안');
  await page.reload();
  await expect(page).toHaveURL(forkUrl);
  await expect(page.getByLabel('다음 장면 요청')).toHaveValue('포크 이야기의 독립 초안');
  expect(await data(request, chat.id)).toEqual(original);
  expect(await data(request, fork.id)).toEqual(copied);
});

async function startingModels(request: APIRequestContext, title: string) {
  const connectionResponse = await request.post('/api/connections', {
    data: {
      title: `${title} fixture`,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/no-provider',
      enabled: true,
    },
  });
  expect(connectionResponse.ok()).toBeTruthy();
  const connection = (await connectionResponse.json()) as { id: string; revision: number };
  const models: { id: string }[] = [];
  for (const role of ['main', 'translation']) {
    const response = await request.post('/api/model-presets', {
      data: {
        title: `${title} ${role}`,
        connectionId: connection.id,
        modelId: `synthetic-${role}`,
        maxOutputTokens: 500,
        temperature: null,
      },
    });
    expect(response.ok()).toBeTruthy();
    const model = (await response.json()) as { id: string; revision: number };
    models.push({ id: model.id });
  }
  return { connection, models };
}

test('UI03 UI12 creating a chat never overwrites newer global model choices', async ({
  page,
  request,
}) => {
  const { models } = await startingModels(request, `UI concurrent models ${Date.now()}`);
  await setCurrentModels(request, { main: models[0], translation: models[1] });
  await page.goto('/');
  await nav(page, '새 이야기');
  const changed = await setCurrentModels(request, { main: models[1], translation: null });
  const accepted = page.waitForResponse(
    (response) => /\/api\/chats$/.test(response.url()) && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  const chat = (await (await accepted).json()) as Chat;
  await expect(page.getByRole('dialog', { name: '새 채팅', exact: true })).not.toBeVisible();
  const restored = await data(request, chat.id);
  expect(restored.profile!.routes).toEqual(changed.routes);
  expect(restored.runs).toHaveLength(0);
  expect(restored.attempts).toHaveLength(0);
  expect(
    await page.evaluate((id) => sessionStorage.getItem(`pending-profile:${id}`), chat.id)
  ).toBeNull();
});

test('UI18 translation is requested only by first view click, never by restore, SSE, language or story changes', async ({
  page,
  request,
}) => {
  const chat = await seed(request, `UI18 lazy ${Date.now()}`, 'Synthetic lazy translation source.');
  const other = await seed(
    request,
    `UI18 lazy other ${Date.now()}`,
    'Synthetic second story source.',
    1,
    chat.botId
  );
  await expect
    .poll(async () =>
      (await data(request, chat.id)).jobs.every((job) => job.status === 'completed')
    )
    .toBe(true);
  const posts: string[] = [];
  page.on('request', (item) => {
    if (item.method() === 'POST' && /\/sources\/[^/]+\/translation$/.test(item.url()))
      posts.push(item.url());
  });
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source-text')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('source-text')).toBeVisible();
  await openChatMenu(page);
  await page.getByRole('button', { name: '읽기 설정', exact: true }).click();
  await page.getByLabel('새 원고의 기본 보기').selectOption('original');
  await page.getByLabel('새 원고의 기본 보기').selectOption('translation');
  await close(page);
  await page
    .getByRole('navigation', { name: chatListName })
    .getByRole('button')
    .filter({ hasText: other.title })
    .click();
  await expect(page.getByTestId('source-text')).toBeVisible();
  await page
    .getByRole('navigation', { name: chatListName })
    .getByRole('button')
    .filter({ hasText: chat.title })
    .click();
  await expect(page.getByTestId('source-text')).toBeVisible();
  const before = await data(request, chat.id);
  const changed = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...before.chat.settings,
      expectedSettingsRevision: before.chat.settingsRevision,
    },
  });
  expect(changed.ok()).toBeTruthy();
  await openChatSettings(page);
  await selectChatSettingsSection(page, '생성 설정');
  await expect(
    page.getByRole('combobox', { name: '본문 생성 후 자동 번역', exact: true })
  ).toBeVisible();
  await close(page);
  expect(posts).toEqual([]);
  expect(
    (await data(request, chat.id)).jobs.filter((job) => job.kind === 'translation')
  ).toHaveLength(0);
  expect(
    (await data(request, other.id)).jobs.filter((job) => job.kind === 'translation')
  ).toHaveLength(0);
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'translation' } });
  await page.getByRole('button', { name: '번역 생성', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await data(request, chat.id)).jobs.filter((job) => job.kind === 'translation').length
    )
    .toBe(1);
  await expect(page.getByRole('button', { name: '번역 보기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '번역 보기', exact: true }).click();
  expect(posts).toHaveLength(1);
  const active = (await data(request, chat.id)).jobs.find((job) => job.kind === 'translation')!;
  await request.post('/api/test/control', { data: { action: 'release', barrier: 'translation' } });
  await expect(page.getByTestId('translation-text')).toBeVisible();
  const completed = await data(request, chat.id);
  await page.getByRole('button', { name: '원문 보기', exact: true }).click();
  await page.getByRole('button', { name: '번역 보기', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('translation-text')).toBeVisible();
  expect(posts).toHaveLength(1);
  const after = await data(request, chat.id);
  expect(after.jobs.filter((job) => job.kind === 'translation')).toHaveLength(1);
  expect(after.jobs.find((job) => job.kind === 'translation')!.id).toBe(active.id);
  expect(after.attempts).toEqual(completed.attempts);
});

test('UI18 source and translation edits keep the current manuscript and feed future generation with one displayed translation', async ({
  page,
  request,
}, info) => {
  const chat = await seed(
    request,
    `UI18 edited history ${Date.now()}`,
    'Synthetic original scene.',
    2
  );
  await prepareTranslations(request, chat.id);
  const original = await data(request, chat.id);
  const source = original.sources[0];
  const oldJob = original.jobs.find(
    (job) => job.kind === 'translation' && job.sourceRevision === source.id
  )!;
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  await sourceAction(scene, '원문 수정');
  const edited = '  SYNTHETIC_EDITED_SOURCE\n\n직접 수정한 원문과 여백.\n  ';
  await scene.getByLabel('원문 수정 내용').fill(edited);
  expect(
    await scene
      .locator('.source-text-editor')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  if (visualReview) await page.screenshot({ path: info.outputPath('source-editor-mobile.png') });
  await scene.getByRole('button', { name: '원문 저장', exact: true }).click();
  await expect(scene.getByLabel('원문 수정 내용')).toHaveCount(0);
  const changed = await data(request, chat.id);
  expect(changed.sources.find((item) => item.id === source.id)!.text).toBe(edited);
  await expect(nativeProse(scene.getByTestId('source-text'))).toContainText(
    'SYNTHETIC_EDITED_SOURCE'
  );
  expect(changed.runs.map((run) => run.id)).toEqual(original.runs.map((run) => run.id));
  expect(changed.attempts).toEqual(original.attempts);
  expect(
    changed.jobs.filter((job) => job.kind === 'translation' && job.sourceRevision === source.id)
  ).toHaveLength(0);
  await sourceAction(scene, '번역 수정');
  const manual = '  직접 고친 번역 {{literal_user}}\n\n사용자가 선택한 문장.\n  ';
  await scene.getByLabel('번역 수정 내용').fill(manual);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('translation-editor-mobile.png') });
  await scene.getByRole('button', { name: '번역 저장', exact: true }).click();
  await expect(nativeProse(scene.getByTestId('translation-text'))).toContainText('직접 고친 번역');
  await expect(scene.getByText('직접 수정한 번역', { exact: true })).toBeVisible();
  const authored = await data(request, chat.id);
  const manualJob = authored.jobs.find(
    (job) => job.kind === 'translation' && job.sourceRevision === source.id
  )!;
  expect(manualJob.id).not.toBe(oldJob.id);
  expect(manualJob.result!.text).toBe(manual);
  expect(manualJob.result!.manual).toBe(true);
  expect(authored.attempts).toEqual(original.attempts);
  await sourceAction(scene, '원문 수정');
  const finalText = edited + '\nFinal authored source.';
  await scene.getByLabel('원문 수정 내용').fill(finalText);
  await scene.getByRole('button', { name: '원문 저장', exact: true }).click();
  await expect(nativeProse(scene.getByTestId('source-text'))).toContainText(
    'Final authored source.'
  );
  await sourceAction(scene, '번역 생성');
  await expect(scene.getByTestId('translation-text')).toBeVisible();
  const regenerated = await data(request, chat.id);
  const currentJobs = regenerated.jobs.filter(
    (job) => job.kind === 'translation' && job.sourceRevision === source.id
  );
  expect(currentJobs).toHaveLength(1);
  expect(currentJobs[0].id).not.toBe(oldJob.id);
  expect(currentJobs[0].result!.manual).not.toBe(true);
  expect(currentJobs[0].sourceHash).toBe(createHash('sha256').update(finalText).digest('hex'));
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
  try {
    await page.getByLabel('다음 장면 요청').fill('SYNTHETIC_FUTURE_AFTER_EDIT');
    await page.getByRole('button', { name: '원문 생성', exact: true }).click();
    await expect
      .poll(async () => {
        const pending = await data(request, chat.id);
        return pending.runs
          .find((run) => !original.runs.some((previous) => previous.id === run.id))
          ?.snapshot.history.find((item) => item.revision === source.id)?.contentHash;
      })
      .toBe(createHash('sha256').update(finalText).digest('hex'));
  } finally {
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
  }
  await expect(page.getByTestId('source')).toHaveCount(3);
  const future = await data(request, chat.id);
  expect(
    future.runs
      .filter((run) => original.runs.some((previous) => previous.id === run.id))
      .map((run) => run.id)
  ).toEqual(original.runs.map((run) => run.id));
});

async function openSourceEditor(tab: Page) {
  const source = tab.getByTestId('source');
  await waitForNativeLayout(source.getByTestId('source-text'));
  const edit = source.locator('.scene-action[aria-label="원문 수정"]');
  await expect(edit).toBeVisible();
  await edit.click();
  await expect(source.getByLabel('원문 수정 내용', { exact: true })).toBeVisible();
}
test('UI18 two-tab conflicts preserve reloadable drafts and manual translation survives held work and a late response', async ({
  page,
  context,
  request,
}) => {
  const chat = await seed(request, `UI18 conflict ${Date.now()}`, 'Synthetic concurrent source.');
  await expect
    .poll(async () =>
      (await data(request, chat.id)).jobs.every((job) => job.status === 'completed')
    )
    .toBe(true);
  const source = (await data(request, chat.id)).sources[0];
  const second = await context.newPage();
  let sendEdit!: () => void;
  const editGate = new Promise<void>((resolve) => {
    sendEdit = resolve;
  });
  let sawEdit!: () => void;
  const editStarted = new Promise<void>((resolve) => {
    sawEdit = resolve;
  });
  let deliverTranslation!: () => void;
  const translationGate = new Promise<void>((resolve) => {
    deliverTranslation = resolve;
  });
  let sawTranslation!: () => void;
  const translationAccepted = new Promise<void>((resolve) => {
    sawTranslation = resolve;
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    await second.goto(`/?chat=${chat.id}`);
    for (const tab of [page, second]) await openSourceEditor(tab);
    const draft = 'UNSAVED_TAB_ONE\n원문 충돌 뒤에도 남는 초안.';
    await page.getByLabel('원문 수정 내용').fill(draft);
    await page.route(`**/api/sources/${source.id}/text`, async (route) => {
      if (route.request().method() === 'PUT') {
        sawEdit();
        await editGate;
      }
      await route.continue();
    });
    const conflicted = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/sources/${source.id}/text`) && response.status() === 409
    );
    await page.getByRole('button', { name: '원문 저장', exact: true }).click();
    await editStarted;
    const winner = 'SAVED_TAB_TWO\n먼저 저장된 원문.';
    await second.getByLabel('원문 수정 내용').fill(winner);
    await second.getByRole('button', { name: '원문 저장', exact: true }).click();
    await expect(second.getByLabel('원문 수정 내용')).toHaveCount(0);
    sendEdit();
    await conflicted;
    await expect(
      page.getByRole('alertdialog', { name: '원문 저장 충돌', exact: true })
    ).toBeVisible();
    await page
      .getByRole('alertdialog', { name: '원문 저장 충돌', exact: true })
      .getByRole('button', { name: '현재 입력 유지', exact: true })
      .click();
    await expect(page.getByLabel('원문 수정 내용')).toHaveValue(draft);
    await expect(page.getByText(/다른 요청이 먼저 반영됐어요/)).toBeVisible();
    await page.reload();
    await openSourceEditor(page);
    await expect(page.getByLabel('원문 수정 내용')).toHaveValue(draft);
    await page.getByRole('button', { name: '원문 저장', exact: true }).click();
    await expect(
      page.getByRole('alertdialog', { name: '원문 저장 충돌', exact: true })
    ).toBeVisible();
    await page
      .getByRole('alertdialog', { name: '원문 저장 충돌', exact: true })
      .getByRole('button', { name: '현재 입력 유지', exact: true })
      .click();
    expect((await data(request, chat.id)).sources[0].text).toBe(winner);
    await page.getByRole('button', { name: '편집 취소', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: '편집 취소', exact: true })
      .getByRole('button', { name: '초안 버리고 닫기', exact: true })
      .click();
    expect(
      await page.evaluate(
        (id) => sessionStorage.getItem(`uimori:text-draft:${id}:original`),
        source.id
      )
    ).toBeNull();
    await request.post('/api/test/control', { data: { action: 'hold', barrier: 'translation' } });
    await page.route(`**/api/sources/${source.id}/translation`, async (route) => {
      if (route.request().method() === 'POST') {
        const response = await route.fetch();
        expect(response.ok()).toBeTruthy();
        sawTranslation();
        await translationGate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '번역 생성', exact: true }).click();
    await translationAccepted;
    await expect
      .poll(
        async () =>
          (await data(request, chat.id)).jobs.find((job) => job.kind === 'translation')?.status
      )
      .toBe('running');
    await second.reload();
    await sourceAction(second.getByTestId('source'), '번역 수정');
    const manual = 'MANUAL_WINS_AFTER_LATE_RESPONSE\n직접 저장한 번역.';
    await second.getByLabel('번역 수정 내용').fill(manual);
    await second.getByRole('button', { name: '번역 저장', exact: true }).click();
    await expect(nativeProse(second.getByTestId('translation-text'))).toContainText(
      'MANUAL_WINS_AFTER_LATE_RESPONSE'
    );
    const saved = await data(request, chat.id);
    const savedJob = saved.jobs.find((job) => job.kind === 'translation')!;
    expect(savedJob.result!.manual).toBe(true);
    deliverTranslation();
    await request.post('/api/test/control', {
      data: { action: 'release', barrier: 'translation' },
    });
    await expect(nativeProse(page.getByTestId('translation-text'))).toContainText(
      'MANUAL_WINS_AFTER_LATE_RESPONSE'
    );
    await expect(page.getByRole('button', { name: '번역 보기', exact: true })).toBeEnabled();
    await page.reload();
    await expect(nativeProse(page.getByTestId('translation-text'))).toContainText(
      'MANUAL_WINS_AFTER_LATE_RESPONSE'
    );
    const final = await data(request, chat.id);
    expect(final.jobs.filter((job) => job.kind === 'translation')).toEqual([savedJob]);
    expect(final.sources[0].text).toBe(winner);
  } finally {
    sendEdit();
    deliverTranslation();
    await second.close();
  }
});

preservePromptWorkspace();

test('UI12 lost response reconfirms the original command and preserves a newer draft', async ({
  page,
  request,
}) => {
  const response = await postFixtureChat(request, {
    data: { title: `합성 UI lost response ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('heading', { name: chat.title, exact: true })).toBeVisible();
  const commands: Record<string, unknown>[] = [];
  let lose = true;
  await page.route(`**/api/chats/${chat.id}/runs`, async (route) => {
    commands.push(route.request().postDataJSON());
    if (lose) {
      lose = false;
      const received = await route.fetch();
      expect(received.ok()).toBeTruthy();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByLabel('다음 장면 요청').fill('합성 최초 요청');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect.poll(async () => (await data(request, chat.id)).runs[0]?.status).toBe('completed');
  await expect(page.getByTestId('source')).toHaveCount(1);
  await page.getByLabel('다음 장면 요청').fill('합성 새 초안은 원래 요청과 달라요');
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  const notification = page.getByRole('dialog', { name: '작업 알림', exact: true });
  await expect(notification.getByRole('button', { name: '접수 확인', exact: true })).toBeVisible();
  await expect(notification).toContainText('다시 확인하면 접수되지 않은 요청이 실행될 수 있어요.');
  await expect(notification).toContainText('접수 여부를 확인하지 못했어요.');
  expect(commands).toHaveLength(1);
  await notification.getByRole('button', { name: '접수 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect((await data(request, chat.id)).runs).toHaveLength(1);
  expect((await data(request, chat.id)).sources).toHaveLength(1);
  await expect(page.getByLabel('다음 장면 요청')).toHaveValue('합성 새 초안은 원래 요청과 달라요');
  expect(await page.evaluate((id) => sessionStorage.getItem(`command:${id}`), chat.id)).toBeNull();
});

test('UI whole-source translation retains completed results across retry and cancellation', async ({
  page,
  request,
}, info) => {
  const chat = await seed(
    request,
    `전체 번역 ${Date.now()}`,
    'Synthetic whole source translation.'
  );
  const before = await data(request, chat.id);
  const source = before.sources[0];
  const original = ['A'.repeat(150), 'B'.repeat(150)].join('\n\n');
  expect(
    (
      await request.put(`/api/sources/${source.id}/text`, {
        data: { text: original, expectedRevision: source.editRevision ?? 0 },
      })
    ).ok()
  ).toBeTruthy();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  await openChatSettings(page);
  await selectChatSettingsSection(page, '생성 설정');
  await expect(page.getByLabel('번역 구간 기준 글자 수', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('번역 구간 무제한', { exact: true })).toHaveCount(0);
  if (visualReview)
    await page.screenshot({
      path: info.outputPath(`translation-whole-source-settings-${MOBILE_WIDTH}.png`),
    });
  await close(page);
  const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  await scene.getByRole('button', { name: '번역 생성', exact: true }).click();
  const latest = async () =>
    (await data(request, chat.id)).jobs
      .filter((job) => job.kind === 'translation')
      .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
  await expect.poll(async () => (await latest())?.status).toBe('completed');
  const first = await latest();
  expect(first).not.toHaveProperty('chunks');
  expect(first).not.toHaveProperty('translationPlan');
  const translated = nativeProse(scene.getByTestId('translation-text'));
  await expect(translated).toContainText('A'.repeat(150));
  const firstText = await translated.innerText();
  expect(
    (
      await request.post('/api/test/control', { data: { action: 'hold', barrier: 'translation' } })
    ).ok()
  ).toBeTruthy();
  await openMoreSourceActions(scene);
  page.once('dialog', (dialog) => dialog.accept());
  await scene.getByRole('button', { name: '현재 설정으로 새 번역', exact: true }).click();
  await expect.poll(async () => (await latest()).status).toBe('running');
  const pending = await latest();
  expect(pending.id).not.toBe(first.id);
  expect(pending.previousResult?.jobId).toBe(first.id);
  await expect(translated).toHaveText(firstText);
  expect((await request.post(`/api/jobs/${pending.id}/cancel`, { data: {} })).ok()).toBeTruthy();
  expect(
    (
      await request.post('/api/test/control', {
        data: { action: 'release', barrier: 'translation' },
      })
    ).ok()
  ).toBeTruthy();
  await expect.poll(async () => (await latest()).status).toBe('cancelled');
  await expect(translated).toHaveText(firstText);
  if (visualReview)
    await page.screenshot({
      path: info.outputPath(`translation-previous-cancelled-${MOBILE_WIDTH}.png`),
    });
  let previousSuccess = first;
  for (const terminal of ['cancelled', 'failed'] as const) {
    if (terminal === 'failed') {
      expect(
        (
          await request.post('/api/test/control', {
            data: { action: 'fail-next', point: 'translation' },
          })
        ).ok()
      ).toBeTruthy();
      expect(
        (await request.post(`/api/sources/${source.id}/retranslate`, { data: {} })).ok()
      ).toBeTruthy();
      await expect.poll(async () => (await latest()).status).toBe('failed');
    }
    const stopped = await latest();
    await expect(scene.getByTestId('translation-text')).toBeVisible();
    const activity = scene.getByTestId('turn-activity');
    if ((await activity.getAttribute('open')) === null)
      await activity.locator(':scope > summary').click();
    const retry = scene
      .getByRole('button', { name: '현재 설정으로 번역 다시 시도', exact: true })
      .filter({ visible: true })
      .first();
    await expect(retry).toBeVisible();
    await retry.click();
    await expect
      .poll(async () => {
        const value = await latest();
        return value.id !== stopped.id && value.status === 'completed';
      })
      .toBe(true);
    const retried = await latest();
    expect(retried.sourceHash).toBe(first.sourceHash);
    expect((await data(request, chat.id)).sources[0].text).toBe(original);
    expect((await (await request.get(`/api/jobs/${previousSuccess.id}`)).json()).result).toEqual(
      previousSuccess.result
    );
    previousSuccess = retried;
    if (visualReview)
      await page.screenshot({
        path: info.outputPath(`translation-whole-source-${terminal}-retry-${MOBILE_WIDTH}.png`),
      });
  }
});
