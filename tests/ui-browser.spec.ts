import { selectCurrentSettingsSection } from './ui-navigation.js';
import { setCurrentModels } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import {
  selectSettingsSection,
  startProviderConnection,
  editLibraryContent,
  openNewStoryOptions,
  createPromptChoice,
  navigationAction,
  selectStartPrompt,
  selectChatSettingsSection,
  openSourceActions,
  openChatMenu,
  openPromptBlocks,
} from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Content } from '../core/product.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';

async function promptBody(editor: Locator) {
  await openPromptBlocks(editor);
  const block = editor.locator('#prompt-block-instructions');
  const body = block.getByLabel('지침 본문', { exact: true });
  if (!(await body.isVisible())) await block.locator('summary').first().click();
  return body;
}

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
  botId?: string,
  automaticStatus = false
) {
  const response = botId
    ? await request.post('/api/chats', { data: { title, botId } })
    : await postFixtureChat(request, { data: { title } });
  expect(response.ok()).toBeTruthy();
  let chat = (await response.json()) as Chat;
  if (automaticStatus) {
    const selected = await request.patch(`/api/chats/${chat.id}/settings`, {
      data: { ...chat.settings, status: true, expectedSettingsRevision: chat.settingsRevision },
    });
    expect(selected.ok()).toBe(true);
    chat = (await selected.json()) as Chat;
  }
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
async function nav(page: Page, name: string) {
  await navigationAction(page, name);
}
const longPrompt =
  'SYNTHETIC_UI_LONG\n\n# 황혼의 부두\n\n> 조용한 약속을 기다려요.\n\n**미라**와 여행자는 편지를 열지 않았다.\n\n' +
  '바닷바람은 서서히 잦아들고 등대의 불빛이 어두운 수면을 건넜다. 두 사람은 오늘의 선택을 서두르지 않았다.\n\n'.repeat(
    35
  );

test.afterEach(async ({ request }) => {
  for (const barrier of ['run', 'translation', 'status']) {
    const response = await request.post('/api/test/control', {
      data: { action: 'release', barrier },
    });
    expect(response.ok()).toBeTruthy();
  }
});
test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title: `UI navigation bot ${Date.now()}`,
      description: 'Synthetic navigation fixture',
      text: 'Synthetic keeper.',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok()).toBeTruthy();
});

test('UI01 UI02 UI04 UI05 UI09 long real sources keep composer accessible, safe prose and zero-call view changes', async ({
  page,
  request,
}, info) => {
  const malicious =
    '\n\n<script>globalThis.__uimoriExecuted=true</script>\n\n<img src=x onerror="globalThis.__uimoriExecuted=true">\n\n<ruby>物語<rt>이야기</rt></ruby>\n\n`asset:synthetic_fixed`\n\n[unsafe](javascript:alert(1))';
  const chat = await seed(request, `합성 UI reader ${Date.now()}`, longPrompt + malicious, 3);
  await prepareTranslations(request, chat.id); // This case measures cached view changes, not initial demand.
  await expect
    .poll(async () =>
      (await data(request, chat.id)).jobs.every((job) => job.status === 'completed')
    )
    .toBe(true);
  const before = await data(request, chat.id);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const viewport of visualReview
    ? [
        { width: 360, height: 800 },
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: 1440, height: 1000 },
      ]
    : [
        { width: 390, height: 844 },
        { width: 1440, height: 1000 },
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
    if ([390, 1440].includes(viewport.width))
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`reader-${viewport.width}.png`) });
    await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
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
  await source.getByRole('button', { name: '원문 보기', exact: true }).click();
  const prose = source.getByTestId('source-text');
  await expect(prose.getByRole('heading', { name: '황혼의 부두', exact: true })).toBeVisible();
  await expect(prose.locator('strong').first()).toHaveText('미라');
  await expect(prose.locator('blockquote').first()).toContainText('조용한 약속');
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { __uimoriExecuted?: boolean }).__uimoriExecuted
    )
  ).toBeUndefined();
  await expect(prose.locator('script, img, iframe, a[href^="javascript:"]')).toHaveCount(0);
  await expect(prose.locator('ruby rt')).toHaveText('이야기');
  const anchors = await prose
    .locator('[data-block-anchor]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-block-anchor'))
    );
  expect(anchors).toEqual(before.sources[0].blocks!.map((block) => block.anchor));
  await source.getByRole('button', { name: '번역 보기', exact: true }).click();
  const translated = source.getByTestId('translation-text');
  await expect(translated).toBeVisible();
  await expect(translated).toContainText('황혼의 부두');
  const translation = before.jobs.find(
    (job) => job.sourceRevision === before.sources[0].id && job.kind === 'translation'
  )!;
  const translationBlocks = translation.translationLayout!.blocks;
  await expect(translated.locator('.source-block')).toHaveCount(translationBlocks.length);
  expect(
    await translated
      .locator('[data-block-anchor]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-block-anchor'))
      )
  ).toEqual(translationBlocks.map((block) => block.anchor));
  await source.getByRole('button', { name: '원문 보기', exact: true }).click();
  await openSourceActions(source);
  await source.getByRole('button', { name: '원문 연결 정보', exact: true }).click();
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
  await nav(page, '서재');
  await page.getByRole('button', { name: `${title} 새 채팅`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('시작할 봇 찾기')).toHaveCount(0);
  await expect(dialog.getByRole('group', { name: '시작할 봇', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('채팅의 봇')).toContainText(title);
  await selectStartPrompt(page, choice);
  await expect(dialog.getByText('이전 창작 제어', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('새 채팅 이름')).toHaveValue('');
  await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('하나만 만들었어요');
  await dialog.getByRole('button', { name: '설정 저장 다시 시도', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const chats = (await (await request.get('/api/chats')).json()) as Chat[];
  const addedChats = chats.filter((chat) => !priorChats.some((item) => item.id === chat.id));
  expect(addedChats).toHaveLength(1);
  const detail = await data(request, addedChats[0].id);
  expect(detail.chat.title).toBe(`${title}의 채팅`);
  expect(detail.profile!.attachments).toEqual([{ id: bot.id, revision: 1 }]);
  expect(await (await request.get('/api/prompt-workspace')).json()).toMatchObject({
    main: { values: choice.combination.values },
  });
  expect(detail.runs).toHaveLength(0);
  expect(writes.filter((item) => /\/api\/chats$/.test(item.url))).toHaveLength(1);
  await page.getByLabel('다음 장면 요청').fill('합성 첫 장면');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect.poll(async () => (await data(request, addedChats[0].id)).runs.length).toBe(1);
  const run = (await data(request, addedChats[0].id)).runs[0];
  expect(run.snapshot.profile!.attachments).toEqual(detail.profile!.attachments);
  expect(run.snapshot.profile!.promptPresets?.main?.values).toEqual(choice.combination.values);
  const runIndex = writes.findIndex((item) => /\/runs$/.test(item.url));
  expect(runIndex).toBeGreaterThan(writes.findLastIndex((item) => /\/profile$/.test(item.url)));
});

test('UI08 UI12 native dialog focus, composition, URL and draft selection stay local', async ({
  page,
  context,
  request,
}) => {
  const chat = await seed(request, `합성 UI keyboard ${Date.now()}`, 'Synthetic quiet harbor.');
  await page.goto(`/?chat=${chat.id}`);
  const settings = page.getByRole('button', { name: '채팅 설정', exact: true });
  await settings.focus();
  await settings.press('Enter');
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await expect(dialog).toBeVisible();
  // Common-dialog coverage owns focus wrapping; this case owns IME and caret persistence.
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
  const input = page.getByLabel('다음 장면 요청');
  await input.fill('합성 IME 입력 초안');
  await input.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.setSelectionRange(3, 7, 'forward');
    input.dispatchEvent(new Event('select', { bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '한' }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Enter',
        code: 'Enter',
        ctrlKey: true,
        isComposing: true,
      })
    );
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }));
  });
  expect((await data(request, chat.id)).runs).toHaveLength(1);
  const second = await context.newPage();
  await second.goto(`/?chat=${chat.id}`);
  await second.getByLabel('다음 장면 요청').fill('독립 탭 초안');
  await page.reload();
  await expect(input).toHaveValue('합성 IME 입력 초안');
  await input.focus();
  expect(
    await input.evaluate((element) => [
      (element as HTMLTextAreaElement).selectionStart,
      (element as HTMLTextAreaElement).selectionEnd,
    ])
  ).toEqual([3, 7]);
  await expect(second.getByLabel('다음 장면 요청')).toHaveValue('독립 탭 초안');
  await second.close();
});

test('UI05 UI10 late auxiliary completion and retry preserve source and current reader position', async ({
  page,
  request,
}) => {
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'status' } });
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'translation' } });
  try {
    const chat = await seed(
      request,
      `합성 UI arrivals ${Date.now()}`,
      longPrompt,
      1,
      undefined,
      true
    );
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.getByTestId('source')).toHaveCount(1);
    await page.getByRole('button', { name: '번역 보기', exact: true }).click();
    await page.getByRole('button', { name: '원문 보기', exact: true }).click();
    const reader = page.locator('[data-reader-scrollport]');
    await reader.evaluate((element) => {
      element.scrollTop = 400;
    });
    const top = await reader.evaluate((element) => element.scrollTop);
    const before = await data(request, chat.id);
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'status' } });
    await request.post('/api/test/control', {
      data: { action: 'release', barrier: 'translation' },
    });
    await expect
      .poll(async () =>
        (await data(request, chat.id)).jobs.every((job) => job.status === 'completed')
      )
      .toBe(true);
    await expect(page.getByRole('button', { name: '원문 보기', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(Math.abs((await reader.evaluate((element) => element.scrollTop)) - top)).toBeLessThan(3);
    expect((await data(request, chat.id)).sources).toEqual(before.sources);
    await request.post('/api/test/control', {
      data: { action: 'fail-next', point: 'translation' },
    });
    const retried = await request.post(`/api/sources/${before.sources[0].id}/retranslate`, {
      data: {},
    });
    expect(retried.ok()).toBeTruthy();
    const turnActivity = page
      .locator(`[data-testid="source"][data-source-id="${before.sources[0].id}"]`)
      .getByTestId('turn-activity');
    await expect(turnActivity.locator(':scope > summary')).toContainText('번역 실패');
    const failed = (await data(request, chat.id)).jobs.findLast(
      (job) => job.kind === 'translation'
    )!;
    if ((await turnActivity.getAttribute('open')) === null)
      await turnActivity.locator(':scope > summary').click();
    await turnActivity
      .locator(`[data-testid="job-translation"][data-job-id="${failed.id}"]`)
      .getByRole('button', { name: '현재 설정으로 번역 재시도', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await data(request, chat.id)).jobs
            .filter((job) => job.kind === 'translation' && job.id !== failed.id)
            .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0]?.status
      )
      .toBe('completed');
    const after = await data(request, chat.id);
    expect(after.sources).toEqual(
      before.sources.map((source) => ({
        ...source,
        translationRevision: after.jobs.find(
          (job) => job.kind === 'translation' && job.sourceRevision === source.id
        )!.revision,
      }))
    );
    expect(after.runs).toEqual(before.runs);
  } finally {
    for (const barrier of ['status', 'translation'])
      await request.post('/api/test/control', { data: { action: 'release', barrier } });
  }
});

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
  await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect((await data(request, chat.id)).runs).toHaveLength(1);
  expect((await data(request, chat.id)).sources).toHaveLength(1);
  await expect(page.getByLabel('다음 장면 요청')).toHaveValue('합성 새 초안은 원래 요청과 달라요');
  expect(await page.evaluate((id) => sessionStorage.getItem(`command:${id}`), chat.id)).toBeNull();
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
  await openChatMenu(page);
  await expect(page.getByRole('button', { name: '보관된 전개', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '다른 응답', exact: true })).toHaveCount(0);
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
  const forkButton = page.getByRole('button', { name: '채팅 포크', exact: true });
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

test('UI07 UI12 late accepted fork cannot navigate after A B A or replace the current draft', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const chat = await seed(request, `UI late fork A ${Date.now()}`, 'Synthetic fork boundary.');
  const other = await seed(
    request,
    `UI late fork B ${Date.now()}`,
    'Synthetic independent story.',
    1,
    chat.botId
  );
  await expect
    .poll(async () =>
      (await data(request, chat.id)).jobs.every((job) => job.status === 'completed')
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await data(request, other.id)).jobs.every((job) => job.status === 'completed')
    )
    .toBe(true);
  const original = await data(request, chat.id);
  const otherBefore = await data(request, other.id);
  const source = original.sources[0];
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source')).toHaveCount(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accepted!: (chat: Chat) => void;
  const acceptedChat = new Promise<Chat>((resolve) => {
    accepted = resolve;
  });
  const modelOrCancelRequests: string[] = [];
  page.on('request', (event) => {
    if (
      event.method() === 'POST' &&
      /\/(?:runs|candidate|retranslate|retry|cancel)(?:\?|$)/u.test(event.url())
    )
      modelOrCancelRequests.push(event.url());
  });
  await page.route(`**/api/chats/${chat.id}/fork`, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    accepted((await response.json()) as Chat);
    await gate;
    await route.fulfill({ response });
  });
  try {
    await openSourceActions(page.getByTestId('source'));
    await page.getByRole('button', { name: '여기서 새 이야기로 이어가기', exact: true }).click();
    const fork = await acceptedChat;
    const list = page.getByRole('navigation', { name: '봇의 채팅 목록' });
    await list.getByRole('button').filter({ hasText: other.title }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(other.id);
    await list.getByRole('button').filter({ hasText: chat.title }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
    await page.getByLabel('다음 장면 요청').fill('돌아온 원본에 새로 작성한 초안');
    const selectedUrl = page.url();
    const response = page.waitForResponse((event) =>
      event.url().endsWith(`/api/chats/${chat.id}/fork`)
    );
    release();
    await (await response).finished();
    await expect(list.getByRole('button').filter({ hasText: fork.title })).toBeVisible();
    await openChatMenu(page);
    await expect(page.getByRole('button', { name: '채팅 포크', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(selectedUrl);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('돌아온 원본에 새로 작성한 초안');
    await expect(page.getByTestId('source')).toHaveAttribute('data-source-id', source.id);
    const copy = await data(request, fork.id);
    expect(copy.sources.map((item) => item.text)).toEqual([source.text]);
    expect(copy.attempts).toHaveLength(0);
    expect(await data(request, chat.id)).toEqual(original);
    expect(await data(request, other.id)).toEqual(otherBefore);
    expect(modelOrCancelRequests).toEqual([]);
  } finally {
    release();
  }
});

test('UI12 late failed SSE refresh from another story never publishes its error into the current story', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const chatA = await seed(request, `UI stale refresh A ${Date.now()}`, 'Synthetic old story.');
  const chatB = await seed(request, `UI stale refresh B ${Date.now()}`, '', 0, chatA.botId);
  await page.goto(`/?chat=${chatA.id}`);
  await expect(page.getByTestId('source')).toHaveCount(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted!: () => void;
  const held = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  let first = true;
  await page.route(`**/api/chats/${chatA.id}/reader?*`, async (route) => {
    if (!first) return route.continue();
    first = false;
    intercepted();
    await gate;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'SYNTHETIC_OLD_STORY_REFRESH' }),
    });
  });
  try {
    const profile = (await data(request, chatA.id)).profile!;
    const update = await request.put(`/api/chats/${chatA.id}/profile`, {
      data: {
        expectedRevision: profile.revision,
        attachments: profile.attachments,

        image: profile.image,
      },
    });
    expect(update.ok()).toBeTruthy();
    await held;
    await page
      .getByRole('navigation', { name: '봇의 채팅 목록', exact: true })
      .getByRole('button')
      .filter({ hasText: chatB.title })
      .click();
    await expect(page.getByRole('heading', { name: chatB.title, exact: true })).toBeVisible();
    await page.getByLabel('다음 장면 요청').fill('현재 이야기의 초안');
    const failed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/chats/${chatA.id}/reader` &&
        response.status() === 500
    );
    release();
    await (await failed).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('현재 이야기의 초안');
    await expect(page).toHaveURL(new RegExp(`chat=${chatB.id}`));
    expect((await data(request, chatB.id)).runs).toHaveLength(0);
  } finally {
    release();
  }
});

test('UI03 UI12 new story retry retains selections, uses current content and locks its pending creation', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const title = `UI frozen start ${Date.now()}`;
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: 'Original synthetic bot.',
      text: 'Synthetic first revision.',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok()).toBeTruthy();
  const bot = (await response.json()) as Content;
  const choice = await createPromptChoice(request, title);
  const beforeChats = (await (await request.get('/api/chats')).json()) as Chat[];
  await page.goto('/');
  await nav(page, '서재');
  await editLibraryContent(page, `${title}`);
  let releaseLibrary!: () => void;
  const libraryGate = new Promise<void>((resolve) => {
    releaseLibrary = resolve;
  });
  let libraryHeld!: () => void;
  const libraryWaiting = new Promise<void>((resolve) => {
    libraryHeld = resolve;
  });
  await page.route('**/api/library?view=summary', async (route) => {
    const response = await route.fetch();
    libraryHeld();
    await libraryGate;
    await route.fulfill({ response });
  });
  let releaseChat!: () => void;
  const chatGate = new Promise<void>((resolve) => {
    releaseChat = resolve;
  });
  let chatAccepted!: (chat: Chat) => void;
  const chatWaiting = new Promise<Chat>((resolve) => {
    chatAccepted = resolve;
  });
  let chatPosts = 0;
  await page.route('**/api/chats', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    chatPosts++;
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    chatAccepted((await response.json()) as Chat);
    await chatGate;
    await route.fulfill({ response });
  });
  const savedProfiles: Record<string, unknown>[] = [];
  let reject = true;
  await page.route('**/api/chats/*/profile', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    savedProfiles.push(route.request().postDataJSON());
    if (reject) {
      reject = false;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'SYNTHETIC_PROFILE_CONFLICT' }),
      });
    }
    await route.continue();
  });
  try {
    const newerPrompt = await request.put(`/api/prompt-presets/${choice.prompt.id}`, {
      data: {
        expectedRevision: 1,
        title: choice.prompt.title,
        role: 'main',
        text: '',
        program: choice.prompt.program,
      },
    });
    expect(newerPrompt.ok()).toBeTruthy();
    await page.getByLabel('자료 본문').fill('Synthetic updated second revision.');
    await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await libraryWaiting;
    await navigationAction(page, '새 채팅', title);
    const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('채팅의 봇')).toContainText(title);
    await selectStartPrompt(page, choice);
    await page.getByLabel('새 채팅 이름').fill(`${title} story`);
    await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
    const chat = await chatWaiting;
    await expect(dialog.getByRole('button', { name: /준비하는 중/ })).toBeVisible();
    await expect(dialog.getByRole('group', { name: '시작할 봇', exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('채팅의 봇')).toContainText(title);
    expect
      .soft(await page.getByRole('button', { name: '시작 페르소나', exact: true }).isDisabled())
      .toBe(true);
    await expect(page.getByLabel('시작 프롬프트')).toHaveCount(0);
    await expect(page.getByLabel('시작 옵션 조합')).toHaveCount(0);
    expect.soft(await page.getByLabel('새 채팅 이름').isDisabled()).toBe(true);
    releaseChat();
    await expect(dialog.getByRole('alert')).toContainText('하나만 만들었어요');
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/library' &&
        new URL(response.url()).searchParams.get('view') === 'summary'
    );
    releaseLibrary();
    const latestLibrary = (await (await refreshed).json()) as { contents: Content[] };
    expect(latestLibrary.contents.find((item) => item.id === bot.id)?.revision).toBe(2);
    await dialog.getByRole('button', { name: '설정 저장 다시 시도', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const detail = await data(request, chat.id);
    expect(detail.profile!.attachments).toEqual([{ id: bot.id, revision: 2 }]);
    expect(await (await request.get('/api/prompt-workspace')).json()).toMatchObject({
      main: { values: choice.combination.values },
    });
    expect(detail.runs).toHaveLength(0);
    expect(chatPosts).toBe(1);
    expect(savedProfiles).toHaveLength(2);
    expect(savedProfiles[1]).toEqual(savedProfiles[0]);
    const afterChats = (await (await request.get('/api/chats')).json()) as Chat[];
    expect(
      afterChats.filter((item) => !beforeChats.some((before) => before.id === item.id))
    ).toHaveLength(1);
    expect(
      await page.evaluate((id) => sessionStorage.getItem(`pending-profile:${id}`), chat.id)
    ).toBeNull();
  } finally {
    releaseChat();
    releaseLibrary();
  }
});

test('UI03 UI12 failed starting profile read survives reload and recovers frozen prompt choices with current routes', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const title = `UI pending profile ${Date.now()}`;
  const botResponse = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: 'Synthetic pending recovery.',
      text: 'Synthetic original start.',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(botResponse.ok()).toBeTruthy();
  const bot = (await botResponse.json()) as Content;
  const choice = await createPromptChoice(request, title);
  // An enabled synthetic connection permits a new role selection; this recovery test never starts a Run.
  const connectionResponse = await request.post('/api/connections', {
    data: {
      title: `${title} synthetic fixture`,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/no-network',
      enabled: true,
    },
  });
  expect(connectionResponse.ok()).toBeTruthy();
  const connection = (await connectionResponse.json()) as { id: string; revision: number };
  const modelResponse = await request.post('/api/model-presets', {
    data: {
      title: `${title} saved route`,
      connectionId: connection.id,
      modelId: 'synthetic-not-called',
      maxOutputTokens: 500,
      temperature: null,
    },
  });
  expect(modelResponse.ok()).toBeTruthy();
  const model = (await modelResponse.json()) as { id: string; revision: number };
  const priorChats = (await (await request.get('/api/chats')).json()) as Chat[];
  let chatPosts = 0;
  page.on('request', (item) => {
    if (item.method() === 'POST' && /\/api\/chats$/.test(item.url())) chatPosts++;
  });
  await page.goto('/');
  await nav(page, '서재');
  await page.getByRole('button', { name: `${title} 새 채팅`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await selectStartPrompt(page, choice);
  let rejectRead = true;
  await page.route('**/api/chats/*/profile', async (route) => {
    if (route.request().method() === 'GET' && rejectRead) {
      rejectRead = false;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'SYNTHETIC_FIRST_PROFILE_READ' }),
      });
    }
    await route.continue();
  });
  const accepted = page.waitForResponse(
    (response) => /\/api\/chats$/.test(response.url()) && response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  const chat = (await (await accepted).json()) as Chat;
  await expect(dialog.getByRole('alert')).toContainText('(500)');
  expect(
    await page.evaluate((id) => sessionStorage.getItem(`pending-profile:${id}`), chat.id)
  ).not.toBeNull();
  await close(page);
  const original = (await data(request, chat.id)).profile!;
  const currentModels = await setCurrentModels(request, { main: { id: model.id } });
  // Competing updates preserve permanent bot ownership while changing unrelated settings.
  const update = await request.put(`/api/chats/${chat.id}/profile`, {
    data: {
      expectedRevision: original.revision,
      attachments: original.attachments,
      ...(original.packageAttachments ? { packageAttachments: original.packageAttachments } : {}),
      image: true,
    },
  });
  expect(update.ok()).toBeTruthy();
  await page.goto(`/?chat=${chat.id}`);
  await page.getByLabel('다음 장면 요청').fill('복구 전에는 보내지 않는 합성 초안');
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '시작 설정 다시 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '시작 설정 다시 저장', exact: true })).toHaveCount(
    0
  );
  const restored = await data(request, chat.id);
  expect(restored.profile!.attachments).toEqual([{ id: bot.id, revision: 1 }]);
  expect(await (await request.get('/api/prompt-workspace')).json()).toMatchObject({
    main: { values: choice.combination.values },
  });
  expect(restored.profile!.routes).toEqual(currentModels.routes);
  expect(restored.profile!.image).toBe(true);
  expect(restored.profile!.revision).toBe(original.revision + 2);
  expect(restored.runs).toHaveLength(0);
  expect(restored.attempts).toHaveLength(0);
  expect(chatPosts).toBe(1);
  expect(
    await page.evaluate((id) => sessionStorage.getItem(`pending-profile:${id}`), chat.id)
  ).toBeNull();
  const afterChats = (await (await request.get('/api/chats')).json()) as Chat[];
  expect(
    afterChats.filter((item) => !priorChats.some((before) => before.id === item.id))
  ).toHaveLength(1);
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

test('UI03 starting without a model explains setup and creates a chat without execution', async ({
  page,
  request,
}) => {
  const title = `UI no starting model ${Date.now()}`;
  await setCurrentModels(request, { main: null, translation: null, status: null, image: null });
  await page.route('**/api/health', async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    await route.fulfill({ response, json: { ...health, testMode: false } });
  });
  // Keep this empty-model UI fixture independent of models saved by earlier browser cases.
  await page.route(/\/api\/library(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const library = await response.json();
    await route.fulfill({ response, json: { ...library, models: [] } });
  });
  const writes: string[] = [];
  page.on('request', (item) => {
    if (item.method() === 'POST') writes.push(item.url());
  });
  await page.goto('/');
  await nav(page, '새 이야기');
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await expect(dialog.getByLabel('시작 본문 모델')).toHaveCount(0);
  await dialog.getByRole('button', { name: '전역 모델 설정', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '설정', exact: true })).toBeVisible();
  await expect(page.getByLabel('원문 모델', { exact: true })).toBeVisible();
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  const connectionTab = settings.getByRole('tab', { name: '현재 모델', exact: true });
  if (await connectionTab.isVisible())
    await expect(connectionTab).toHaveAttribute('aria-selected', 'true');
  else {
    await expect(settings.getByRole('heading', { name: '현재 모델', exact: true })).toBeVisible();
    await expect(
      settings.getByRole('button', { name: '설정 목록으로', exact: true })
    ).toBeVisible();
  }
  await nav(page, '새 이야기');
  await openNewStoryOptions(page);
  await dialog.getByLabel('새 채팅 이름').fill(title);
  const accepted = page.waitForResponse(
    (item) => /\/api\/chats$/.test(item.url()) && item.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  const chat = (await (await accepted).json()) as Chat;
  await expect(dialog).not.toBeVisible();
  const detail = await data(request, chat.id);
  expect(detail.profile!.routes.main).toBeNull();
  expect(detail.runs).toHaveLength(0);
  expect(detail.attempts).toHaveLength(0);
  expect(writes.filter((url) => /\/(?:runs|candidate)$/.test(url))).toEqual([]);
  await page.getByLabel('다음 장면 요청').fill('모델 선택 전 합성 요청');
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeDisabled();
});

test('UI03 UI12 global model choices survive chat creation and disabled connections stay explicit', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `UI global models ${Date.now()}`;
  const { connection, models } = await startingModels(request, title);
  const workspace = await setCurrentModels(request, { main: models[0], translation: models[1] });
  // Exercise normal admission UI while retaining the local synthetic server.
  await page.route('**/api/health', async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    await route.fulfill({ response, json: { ...health, testMode: false } });
  });
  await page.goto('/');
  await nav(page, '새 이야기');
  await expect(page.getByLabel('시작 본문 모델')).toHaveCount(0);
  await openNewStoryOptions(page);
  await page.getByLabel('새 채팅 이름').fill(title);
  const response = page.waitForResponse(
    (item) => /\/api\/chats$/.test(item.url()) && item.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  const chat = (await (await response).json()) as Chat;
  await expect(page.getByRole('dialog', { name: '새 채팅', exact: true })).not.toBeVisible();
  const detail = await data(request, chat.id);
  expect(detail.profile!.routes).toEqual(workspace.routes);
  expect(detail.runs).toHaveLength(0);
  expect(detail.attempts).toHaveLength(0);
  await page.getByRole('button', { name: /^현재 본문 모델/ }).click();
  await expect(page.getByLabel('원문 모델', { exact: true })).toHaveValue(models[0].id);
  await expect(page.getByLabel('번역 모델', { exact: true })).toHaveValue(models[1].id);
  if (visualReview) await page.screenshot({ path: info.outputPath('starting-models-mobile.png') });
  const disabled = await request.put(`/api/connections/${connection.id}`, {
    data: {
      expectedRevision: connection.revision,
      title,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/no-provider',
      enabled: false,
    },
  });
  expect(disabled.ok()).toBeTruthy();
  await page.goto(`/?chat=${chat.id}`);
  await page.getByLabel('다음 장면 요청').fill('비활성 연결로 보내지 않는 요청');
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeDisabled();
  expect((await (await request.get('/api/model-workspace')).json()).routes).toEqual(
    workspace.routes
  );
  expect((await data(request, chat.id)).attempts).toHaveLength(0);
});

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

test('UI02 UI04 UI12 sending a long request collapses the empty composer and preserves a later long draft on return', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await seed(request, `UI composer height ${Date.now()}`, '', 0);
  await page.goto(`/?chat=${chat.id}`);
  const input = page.getByLabel('다음 장면 요청');
  await expect(input).toBeVisible();
  const initial = (await input.boundingBox())!.height;
  await input.fill(
    '(OOC: 장면의 소리와 인물의 선택을 지키며 고요한 장문으로 이어줘.)\n'.repeat(16)
  );
  const expanded = (await input.boundingBox())!.height;
  expect(expanded).toBeGreaterThan(initial + 50);
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeLessThanOrEqual(initial + 1);
  await expect(page.getByTestId('source')).toHaveCount(1);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('collapsed-composer-mobile.png') });
  const draft = '다음 장면은 전송하지 않은 긴 합성 초안이에요.\n'.repeat(12);
  await input.fill(draft);
  const draftHeight = (await input.boundingBox())!.height;
  await nav(page, '서재');
  await nav(page, '새 이야기');
  await close(page);
  await page.goto(`/?chat=${chat.id}`);
  await expect(input).toHaveValue(draft);
  await expect.poll(async () => (await input.boundingBox())!.height).toBe(draftHeight);
  expect((await data(request, chat.id)).runs).toHaveLength(1);
});

test('UI07 UI09 legacy branches use one mobile selection and preserve reading without generation', async ({
  page,
  request,
}, info) => {
  const chat = await seed(
    request,
    `UI legacy branch reader ${Date.now()}`,
    '(OOC: 비가 그친 항구에서 마지막 배를 기다리는 미라의 장면.)'
  );
  const original = (await data(request, chat.id)).runs[0];
  const candidates: Run[] = [];
  for (let index = 0; index < 2; index++) {
    const result = await request.post(`/api/runs/${original.id}/candidate`, {
      data: { idempotencyKey: `ui-legacy-${chat.id}-${index}` },
    });
    expect(result.ok()).toBeTruthy();
    const run = (await result.json()) as Run;
    candidates.push(run);
    await expect
      .poll(
        async () => (await data(request, chat.id)).runs.find((item) => item.id === run.id)?.status
      )
      .toBe('completed');
  }
  await expect
    .poll(async () =>
      (await data(request, chat.id)).jobs.every((job) => job.status === 'completed')
    )
    .toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  await openChatMenu(page);
  await page.getByRole('button', { name: '보관된 전개', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '보관된 전개', exact: true });
  await expect
    .poll(() => dialog.locator('.branch-choice strong').allTextContents())
    .toEqual(expect.arrayContaining(['기본 전개', '다른 응답 1', '다른 응답 2']));
  await expect(dialog.locator('.branch-preview')).toHaveCount(3);
  await expect(dialog.locator('select, input')).toHaveCount(0);
  expect(
    await dialog
      .locator(':scope > .dialog-body')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  if (visualReview) await page.screenshot({ path: info.outputPath('legacy-branches-mobile.png') });
  const before = await data(request, chat.id);
  await dialog
    .locator('.branch-choice')
    .filter({ has: page.locator('strong', { hasText: '다른 응답 1' }) })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('branch'))
    .toBe(candidates[0].snapshot.branchId!);
  await expect(page.getByTestId('source')).toHaveAttribute(
    'data-source-id',
    before.sources.find((source) => source.runId === candidates[0].id)!.id
  );
  await expect(page.getByRole('button', { name: '다른 응답', exact: true })).toHaveCount(0);
  expect(await data(request, chat.id)).toEqual(before);
});

test('UI17 full writing and empty translation prompts import, save and apply without model execution', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, {
    data: { title: `UI17 prompt settings ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const chat = (await created.json()) as Chat;
  const initialProfile = (await data(request, chat.id)).profile!;
  const configured = await request.put(`/api/chats/${chat.id}/profile`, {
    data: {
      expectedRevision: initialProfile.revision,
      attachments: initialProfile.attachments,

      image: initialProfile.image,
    },
  });
  expect(configured.ok()).toBeTruthy();
  const before = await data(request, chat.id);
  const writes: string[] = [];
  page.on('request', (event) => {
    if (['POST', 'PUT'].includes(event.method())) writes.push(event.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  await nav(page, '프롬프트');
  await page.getByRole('button', { name: '새 프롬프트', exact: true }).click();
  const editor = page.getByTestId('prompt-library').getByTestId('prompt-editor');
  await expect(await promptBody(editor)).not.toHaveValue('');
  const literal =
    '  FULL_PROMPT_UI17\n{{user}} {{#if exact}}literal CBS{{/if}}\n<script>globalThis.__promptExecuted=true</script>\n' +
    'Preserve this complete authored prompt and all tool data separately.\n'.repeat(90) +
    '\n  ';
  await editor.getByLabel('지침 본문 파일 불러오기', { exact: true }).setInputFiles({
    name: 'UI17-full-main.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(literal),
  });
  await expect(await promptBody(editor)).toHaveValue(literal);
  await editor.getByLabel('프롬프트 이름', { exact: true }).fill('UI17-full-main');
  await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption('translation');
  await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption('main');
  await expect(await promptBody(editor)).toHaveValue(literal);
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true
  );
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  await expect(editor.getByText('프롬프트를 저장했어요.', { exact: true })).toBeVisible();
  if (visualReview) await page.screenshot({ path: info.outputPath('full-prompt-mobile.png') });
  await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption('translation');
  await editor.getByLabel('프롬프트 이름', { exact: true }).fill('UI17 empty translation');
  await (await promptBody(editor)).fill('');
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  await expect
    .poll(async () =>
      (await (await request.get('/api/library')).json()).promptPresets.some(
        (item: { title: string }) => item.title === 'UI17 empty translation'
      )
    )
    .toBe(true);
  await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption('main');
  await expect(await promptBody(editor)).toHaveValue(literal);
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (visualReview) await page.screenshot({ path: info.outputPath('full-prompt-desktop.png') });
  await page.getByRole('button', { name: '← 프롬프트 목록', exact: true }).click();
  await page.getByRole('button', { name: '현재 프롬프트 설정', exact: true }).click();
  const settings = page.getByRole('region', { name: '현재 프롬프트 설정' });
  const library = await (await request.get('/api/library')).json();
  for (const [role, title, text] of [
    ['main', 'UI17-full-main', literal],
    ['translation', 'UI17 empty translation', ''],
  ] as const) {
    const preset = library.promptPresets.find((item: { title: string }) => item.title === title);
    await settings.getByLabel('현재 프롬프트 역할').selectOption(role);
    await settings.getByLabel('현재 프롬프트 프리셋').selectOption(preset.id);
    await expect
      .poll(async () => (await (await request.get('/api/prompt-workspace')).json())[role].title)
      .toBe(title);
    expect((await (await request.get('/api/prompt-workspace')).json())[role].program).toEqual(
      createDefaultPromptProgram(text, role)
    );
  }
  const after = await data(request, chat.id);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.sources).toEqual(before.sources);
  expect(after.profile!.attachments).toEqual(before.profile!.attachments);
  expect(after.profile!.routes).toEqual(before.profile!.routes);
  expect(writes.some((url) => /\/(?:runs|candidate|retranslate|retry)(?:\?|$)/u.test(url))).toBe(
    false
  );
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { __promptExecuted?: boolean }).__promptExecuted
    )
  ).toBeUndefined();
});

test('UI17 prompts use latest settings and concurrent edits preserve unsaved text', async ({
  page,
  request,
}) => {
  const originalText = 'Original full writing prompt.\n{{source}} remains literal.';
  const saved = await request.post('/api/prompt-presets', {
    data: {
      title: `UI17 archived ${Date.now()}`,
      role: 'main',
      program: createDefaultPromptProgram(originalText, 'main'),
    },
  });
  expect(saved.ok()).toBeTruthy();
  const first = await saved.json();
  const created = await postFixtureChat(request, {
    data: { title: `UI17 archived story ${Date.now()}` },
  });
  const chat = (await created.json()) as Chat;
  const profile = (await data(request, chat.id)).profile!;
  const initialWorkspace = await (await request.get('/api/prompt-workspace')).json();
  expect(
    (
      await request.post('/api/prompt-workspace/apply', {
        data: { expectedRevision: initialWorkspace.revision, role: 'main', presetId: first.id },
      })
    ).ok()
  ).toBeTruthy();
  const latest = await request.put(`/api/prompt-presets/${first.id}`, {
    data: {
      expectedRevision: 1,
      title: first.title,
      role: 'main',
      program: createDefaultPromptProgram('Latest library writing prompt.', 'main'),
    },
  });
  expect(latest.ok()).toBeTruthy();
  await page.goto(`/?chat=${chat.id}`);
  await selectCurrentSettingsSection(page, '프롬프트·창작 프리셋');
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  const editor = dialog.getByRole('region', { name: '현재 프롬프트 설정' });
  expect((await (await request.get('/api/prompt-workspace')).json()).main.program).toEqual(
    createDefaultPromptProgram(originalText, 'main')
  );
  await editor.getByRole('button', { name: '최신 버전 적용', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.program)
    .toEqual(createDefaultPromptProgram('Latest library writing prompt.', 'main'));
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await nav(page, '프롬프트');
  await page.getByRole('button', { name: `${first.title} 프롬프트 편집`, exact: true }).click();
  const libraryEditor = page.getByTestId('prompt-library').getByTestId('prompt-editor');
  const edited = 'Unsaved custom full prompt.\n' + 'Keep my edited text intact.\n'.repeat(30);
  await (await promptBody(libraryEditor)).fill(edited);
  const current = await (await request.get('/api/prompt-workspace')).json();
  const concurrent = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: current.revision,
      main: {
        ...current.main,
        program: createDefaultPromptProgram('Concurrent current prompt.', 'main'),
      },
    },
  });
  expect(concurrent.ok()).toBeTruthy();
  await expect(await promptBody(libraryEditor)).toHaveValue(edited);
  await libraryEditor.getByRole('button', { name: '저장', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/library')).json()).promptPresets.find(
          (item: { id: string }) => item.id === first.id
        ).revision
    )
    .toBe(3);
  const stored = await (await request.get(`/api/prompt-presets/${first.id}`)).json();
  expect(stored.program).toEqual(createDefaultPromptProgram(edited, 'main'));
  expect((await (await request.get('/api/prompt-workspace')).json()).main.program).toEqual(
    createDefaultPromptProgram('Concurrent current prompt.', 'main')
  );
  const after = await data(request, chat.id);
  expect(after.profile).toEqual(profile);
  expect(after.runs).toHaveLength(0);
  expect(after.attempts).toHaveLength(0);
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
  await page.setViewportSize({ width: 1440, height: 1000 });
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
    .getByRole('navigation', { name: '봇의 채팅 목록' })
    .getByRole('button')
    .filter({ hasText: other.title })
    .click();
  await expect(page.getByTestId('source-text')).toBeVisible();
  await page
    .getByRole('navigation', { name: '봇의 채팅 목록' })
    .getByRole('button')
    .filter({ hasText: chat.title })
    .click();
  await expect(page.getByTestId('source-text')).toBeVisible();
  // A real settings event exercises SSE refresh, including legacy translation=false.
  const before = await data(request, chat.id);
  const changed = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...before.chat.settings,
      translation: false,
      expectedSettingsRevision: before.chat.settingsRevision,
    },
  });
  expect(changed.ok()).toBeTruthy();
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await selectChatSettingsSection(page, '자동 후속 작업');
  await expect(
    page.getByText('저장한 설정은 다음 실행부터 적용해요.', { exact: true })
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
  await page.getByRole('button', { name: '번역 보기', exact: true }).click();
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

test('UI18 source and translation edits preserve past snapshots and feed only future generation with one latest translation', async ({
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  await openSourceActions(scene);
  await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
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
  await expect(scene.getByTestId('source-text')).toContainText('SYNTHETIC_EDITED_SOURCE');
  const changed = await data(request, chat.id);
  expect(changed.sources.find((item) => item.id === source.id)!.text).toBe(edited);
  expect(changed.runs).toEqual(original.runs);
  expect(changed.attempts).toEqual(original.attempts);
  expect(
    changed.jobs.filter((job) => job.kind === 'translation' && job.sourceRevision === source.id)
  ).toHaveLength(0);
  // Editing a translation immediately after a source edit uses the hidden slot's CAS value.
  await openSourceActions(scene);
  await scene.getByRole('button', { name: '번역 수정', exact: true }).click();
  const manual = '  직접 고친 번역 {{literal_user}}\n\n사용자가 선택한 문장.\n  ';
  await scene.getByLabel('번역 수정 내용').fill(manual);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('translation-editor-mobile.png') });
  await scene.getByRole('button', { name: '번역 저장', exact: true }).click();
  await expect(scene.getByTestId('translation-text')).toContainText('직접 고친 번역');
  await expect(scene.getByText('직접 수정한 번역', { exact: true })).toBeVisible();
  const authored = await data(request, chat.id);
  const manualJob = authored.jobs.find(
    (job) => job.kind === 'translation' && job.sourceRevision === source.id
  )!;
  expect(manualJob.id).not.toBe(oldJob.id);
  expect(manualJob.result!.text).toBe(manual);
  expect(manualJob.result!.manual).toBe(true);
  expect(authored.attempts).toEqual(original.attempts);
  await openSourceActions(scene);
  await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
  const finalText = edited + '\nFinal authored source.';
  await scene.getByLabel('원문 수정 내용').fill(finalText);
  await scene.getByRole('button', { name: '원문 저장', exact: true }).click();
  await expect(scene.getByTestId('source-text')).toContainText('Final authored source.');
  await scene.getByRole('button', { name: '번역 보기', exact: true }).click();
  await expect(scene.getByTestId('translation-text')).toBeVisible();
  const regenerated = await data(request, chat.id);
  const currentJobs = regenerated.jobs.filter(
    (job) => job.kind === 'translation' && job.sourceRevision === source.id
  );
  expect(currentJobs).toHaveLength(1);
  expect(currentJobs[0].id).not.toBe(oldJob.id);
  expect(currentJobs[0].result!.manual).not.toBe(true);
  expect(currentJobs[0].sourceHash).toBe(createHash('sha256').update(finalText).digest('hex'));
  await expect(scene.getByRole('combobox')).toHaveCount(0);
  await expect(scene.getByText('번역 버전', { exact: true })).toHaveCount(0);
  await expect(scene.getByRole('button', { name: '다시 번역', exact: true })).toHaveCount(0);
  await page.getByLabel('다음 장면 요청').fill('SYNTHETIC_FUTURE_AFTER_EDIT');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect(page.getByTestId('source')).toHaveCount(3);
  const future = await data(request, chat.id);
  const next = future.runs.find(
    (run) => !original.runs.some((previous) => previous.id === run.id)
  )!;
  expect(next.snapshot.history.find((item) => item.revision === source.id)?.text).toBe(finalText);
  expect(
    future.runs.filter((run) => original.runs.some((previous) => previous.id === run.id))
  ).toEqual(original.runs);
  expect(original.runs[1].snapshot.history[0].text).toBe(source.text);
});

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
    for (const tab of [page, second]) {
      await openSourceActions(tab.getByTestId('source'));
      await tab.getByRole('button', { name: '원문 수정', exact: true }).click();
    }
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
    await expect(page.getByLabel('원문 수정 내용')).toHaveValue(draft);
    await expect(page.getByText(/다른 요청이 먼저 반영됐어요/)).toBeVisible();
    await page.reload();
    await openSourceActions(page.getByTestId('source'));
    await page.getByRole('button', { name: '원문 수정', exact: true }).click();
    await expect(page.getByLabel('원문 수정 내용')).toHaveValue(draft);
    await expect(page.getByRole('button', { name: '원문 저장', exact: true })).toBeDisabled();
    expect((await data(request, chat.id)).sources[0].text).toBe(winner);
    await page.getByRole('button', { name: '수정 취소', exact: true }).click();
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
    await page.getByRole('button', { name: '번역 보기', exact: true }).click();
    await translationAccepted;
    await expect
      .poll(
        async () =>
          (await data(request, chat.id)).jobs.find((job) => job.kind === 'translation')?.status
      )
      .toBe('running');
    // Refreshing the second tab receives the active slot before opening its editor.
    await second.reload();
    await openSourceActions(second.getByTestId('source'));
    await second.getByRole('button', { name: '번역 수정', exact: true }).click();
    const manual = 'MANUAL_WINS_AFTER_LATE_RESPONSE\n직접 저장한 번역.';
    await second.getByLabel('번역 수정 내용').fill(manual);
    await second.getByRole('button', { name: '번역 저장', exact: true }).click();
    await expect(second.getByTestId('translation-text')).toContainText(
      'MANUAL_WINS_AFTER_LATE_RESPONSE'
    );
    const saved = await data(request, chat.id);
    const savedJob = saved.jobs.find((job) => job.kind === 'translation')!;
    expect(savedJob.result!.manual).toBe(true);
    deliverTranslation();
    await request.post('/api/test/control', {
      data: { action: 'release', barrier: 'translation' },
    });
    await expect(page.getByTestId('translation-text')).toContainText(
      'MANUAL_WINS_AFTER_LATE_RESPONSE'
    );
    await expect(page.getByRole('button', { name: '번역 보기', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByTestId('translation-text')).toContainText(
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

test('UI settings categories retain drafts and support keyboard navigation', async ({
  page,
}, info) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await nav(page, '설정');
    const dialog = page.getByRole('dialog', { name: '설정', exact: true });
    const tabs = dialog.getByRole('tablist', { name: '설정 항목' });
    if (viewport.width === 390) {
      await expect(dialog.locator('.settings-navigation').filter({ visible: true })).toBeVisible();
      await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
      await expect(dialog.getByLabel('앱 화면 테마')).toBeHidden();
      await selectSettingsSection(page, '일반');
    }
    await expect(dialog.getByRole('tabpanel')).toHaveCount(1);
    await expect(dialog.getByLabel('앱 화면 테마')).toBeVisible();
    await expect(dialog.getByTestId('connection-editor')).not.toBeVisible();
    await selectSettingsSection(page, '프로바이더와 모델');
    await startProviderConnection(page);
    await dialog
      .getByRole('region', { name: '제공자 선택', exact: true })
      .getByRole('button', { name: /OpenAI · Responses/ })
      .click();
    await dialog
      .getByLabel('프로바이더 이름', { exact: true })
      .fill('SYNTHETIC unsaved connection');
    await selectSettingsSection(page, '데이터 관리');
    await expect(dialog.getByRole('button', { name: 'JSON 내보내기', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('프로바이더 이름', { exact: true })).not.toBeVisible();
    await selectSettingsSection(page, '접근 보안');
    await expect(dialog.getByRole('button', { name: '접속 해제', exact: true })).toBeVisible();
    if (viewport.width === 1440) {
      await tabs.getByRole('tab', { name: '접근 보안', exact: true }).press('Home');
      await expect(tabs.getByRole('tab', { name: '일반', exact: true })).toBeFocused();
      for (const section of ['현재 모델', '현재 프롬프트', '프로바이더와 모델']) {
        await page.keyboard.press('ArrowDown');
        await expect(tabs.getByRole('tab', { name: section, exact: true })).toBeFocused();
      }
    } else {
      await dialog.getByRole('button', { name: '설정 목록으로', exact: true }).click();
      const connection = dialog
        .locator('.settings-navigation')
        .getByRole('button', { name: '프로바이더와 모델', exact: true });
      await connection.focus();
      await page.keyboard.press('Enter');
      await expect(dialog.locator('.settings-navigation').filter({ visible: true })).toHaveCount(0);
    }
    await expect(dialog.getByLabel('프로바이더 이름', { exact: true })).toHaveValue(
      'SYNTHETIC unsaved connection'
    );
    const closeButton = dialog.getByRole('button', { name: '설정 닫기', exact: true });
    await closeButton.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(closeButton).not.toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
    await expect(dialog.getByRole('tabpanel')).toHaveCount(1);
    expect(
      await dialog
        .getByRole('tabpanel')
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
    ).toBe(true);
    await selectSettingsSection(page, '일반');
    await dialog.getByLabel('앱 화면 테마').selectOption('dark');
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`settings-categories-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    const discard = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
});

test('UI common dialogs center on desktop and fill mobile without changing dismissal or focus', async ({
  page,
  request,
}, info) => {
  const chat = await seed(request, `합성 common dialog ${Date.now()}`, '', 0);
  for (const width of [1440, 390]) {
    const height = width === 390 ? 844 : 1000;
    await page.setViewportSize({ width, height });
    await page.goto(`/?chat=${chat.id}`);
    for (const title of ['채팅 설정', '작업 현황']) {
      const opener = page.getByRole('button', { name: title, exact: true });
      if (title === '작업 현황') await nav(page, title);
      else await opener.click();
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await expect(dialog).toBeVisible();
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      if (visualReview && width === 390) {
        expect(box.x).toBe(0);
        expect(box.y).toBe(0);
        expect(box.width).toBe(width);
        expect(box.height).toBe(height);
      } else if (visualReview) {
        expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
        if (visualReview)
          expect(Math.abs(box.y + box.height / 2 - height / 2)).toBeLessThanOrEqual(1);
        expect(box.x).toBeGreaterThan(24);
        expect(box.y).toBeGreaterThanOrEqual(32);
      }
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await dialog.getByRole('button', { name: title + ' 닫기', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Tab');
      await expect(
        dialog.getByRole('button', { name: title + ' 닫기', exact: true })
      ).toBeFocused();
      if (visualReview)
        await page.screenshot({
          path: info.outputPath(
            `common-dialog-${title === '작업 현황' ? 'tasks' : 'story'}-${width}.png`
          ),
        });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      // Tasks open from the chat ⋯ menu, so focus returns to the menu button afterwards.
      if (title === '작업 현황') {
        if (width === 1440) await expect(page.locator('.chat-menu > summary')).toBeFocused();
      } else await expect(opener).toBeFocused();
    }
    if (width === 1440) {
      await openChatMenu(page);
      const opener = page.getByRole('button', { name: '읽기 설정', exact: true });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: '읽기 설정', exact: true });
      const box = (await dialog.boundingBox())!;
      if (visualReview) expect(box.width).toBe(560);
      if (visualReview) expect(box.height).toBeLessThan(880);
      if (visualReview)
        expect(Math.abs(box.y + box.height / 2 - height / 2)).toBeLessThanOrEqual(1);
      await page.mouse.click(8, 8);
      await expect(dialog).not.toBeVisible();
      // The opener lives in the closed ⋯ menu, so focus returns to the menu button.
      await expect(page.locator('.chat-menu > summary')).toBeFocused();
    } else {
      const opener = page.getByRole('button', { name: '탐색 메뉴', exact: true });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: '탐색', exact: true });
      const box = (await dialog.boundingBox())!;
      if (visualReview) expect(box).toEqual({ x: 0, y: 0, width, height });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
    }
  }
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await selectChatSettingsSection(page, '자동 후속 작업');
  await expect(page.getByLabel('번역 구간 기준 글자 수', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('번역 구간 무제한', { exact: true })).toHaveCount(0);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('translation-whole-source-settings-390.png') });
  await close(page);
  const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  await scene.getByRole('button', { name: '번역 보기', exact: true }).click();
  const latest = async () =>
    (await data(request, chat.id)).jobs
      .filter((job) => job.kind === 'translation')
      .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
  await expect.poll(async () => (await latest())?.status).toBe('completed');
  const first = await latest();
  expect(first).not.toHaveProperty('chunks');
  expect(first).not.toHaveProperty('translationPlan');
  await expect(scene.getByTestId('translation-text')).toBeVisible();
  const firstText = await scene.getByTestId('translation-text').innerText();
  expect(
    (
      await request.post('/api/test/control', { data: { action: 'hold', barrier: 'translation' } })
    ).ok()
  ).toBeTruthy();
  await openSourceActions(scene);
  page.once('dialog', (dialog) => dialog.accept());
  await scene.getByRole('button', { name: '현재 설정으로 새 번역', exact: true }).click();
  await expect.poll(async () => (await latest()).status).toBe('running');
  const pending = await latest();
  expect(pending.id).not.toBe(first.id);
  expect(pending.previousResult?.jobId).toBe(first.id);
  await expect(scene.getByTestId('translation-text')).toHaveText(firstText);
  expect((await request.post(`/api/jobs/${pending.id}/cancel`, { data: {} })).ok()).toBeTruthy();
  expect(
    (
      await request.post('/api/test/control', {
        data: { action: 'release', barrier: 'translation' },
      })
    ).ok()
  ).toBeTruthy();
  await expect.poll(async () => (await latest()).status).toBe('cancelled');
  await expect(scene.getByTestId('translation-text')).toHaveText(firstText);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('translation-previous-cancelled-390.png') });
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
      .getByRole('button', { name: '현재 설정으로 번역 재시도', exact: true })
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
    expect((await (await request.get(`/api/jobs/${first.id}`)).json()).result).toEqual(
      first.result
    );
    if (visualReview)
      await page.screenshot({
        path: info.outputPath(`translation-whole-source-${terminal}-retry-390.png`),
      });
  }
});

test('UI chat settings close right after saving does not warn while the refresh is pending', async ({
  page,
  request,
}) => {
  const chat = await seed(request, `저장 직후 닫기 ${Date.now()}`, 'Synthetic close after save.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await selectChatSettingsSection(page, '자동 후속 작업');
  const runtime = dialog.locator('section.settings');
  const statusEnabled = !(await data(request, chat.id)).chat.settings.status;
  await runtime.getByLabel('장면 상태 자동 실행', { exact: true }).setChecked(statusEnabled);
  // Hold the post-save reader refresh so the close arrives while it is still in flight.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = /\/api\/chats\/[^/]+\/reader/;
  await page.route(reader, async (route) => {
    await held;
    await route.continue();
  });
  await runtime.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect(runtime.getByRole('status')).toContainText('후속 작업 설정을 저장했어요.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인' })).toHaveCount(0);
  release();
  await expect
    .poll(async () => (await data(request, chat.id)).chat.settings.status)
    .toBe(statusEnabled);
});

preservePromptWorkspace();
