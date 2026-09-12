import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { HelperConversation, HelperMessage } from '../core/helper.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import type { HelperArtifactView } from '../web/HelperArtifactCard.js';
import type { HelperTaskView } from '../web/useHelperConversation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { visualReview } from './fixtures/visual-review.js';
import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import {
  navigationAction,
  openChatMenu,
  openHelper,
  selectSettingsSection,
} from './ui-navigation.js';

test.setTimeout(90000);

const sourceText =
  '그녀는 문 앞에서 돌아섰다. “정말 **괜찮아**?” 나는 고개를 끄덕였다. ‘이번에는 기다리겠어.’\n\n' +
  '"함께 가자." 그는 \'약속을 지키자.\'고 생각했다. 「문이 열렸어.」 책에는 『별의 기록』이라고 적혀 있었다.\n\n' +
  '`“코드 안 인용”`과 [문서](https://example.com/reading)는 그대로 읽는다.' +
  '\n\n“첫째 줄”\n“둘째 줄”\n마지막 줄.' +
  '\n\n바닷바람은 서서히 잦아들고 등대의 불빛이 수면을 건넜다. 두 사람은 오늘의 선택을 서두르지 않았다.'.repeat(
    16
  );
const translatedText =
  '번역된 장면이다. “함께 걸어가자.” 그는 고개를 들었다. ‘아직 늦지 않았어.’\n\n' +
  '「도착했어.」 문 앞에 『여행의 끝』이 놓여 있었다.';
const helperAnswer = '“문을 열어 주세요.”\n“다시 한 번 확인해요.”\n‘마음속 약속’도 있어요.';
const artifactText = '그녀가 돌아섰다. 「다시 만나요.」 그는 ‘꼭 돌아오겠어.’라고 생각했다.';
const streamText = '장면을 살펴보고 있어요. “이 장면의 선택”을 설명할게요.';
const helperRequest = '“이 요청은 그대로” 읽으며 확인해 주세요.';
const helperPersona = '“설정 지침도 그대로” 보관해요.';

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext) {
  const response = await postFixtureChat(request, {
    data: { title: `읽기 설정 합성 ${randomUUID()}` },
  });
  expect(response.ok()).toBe(true);
  const chat = (await response.json()) as Chat;
  const before = await detail(request, chat.id);
  const generated = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '“본문 요청도 그대로” 보관할 합성 장면.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      expectedProfileRevision: before.profile!.revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(generated.ok(), await generated.text()).toBe(true);
  const run = (await generated.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  const source = (await detail(request, chat.id)).sources[0];
  const edited = await request.put(`/api/sources/${source.id}/text`, {
    data: { text: sourceText, expectedRevision: source.editRevision ?? 0 },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  const currentSource = (await detail(request, chat.id)).sources[0];
  const translated = await request.put(`/api/sources/${source.id}/translation`, {
    data: {
      text: translatedText,
      expectedRevision: currentSource.translationRevision ?? 0,
      expectedSourceHash: currentSource.hash,
    },
  });
  expect(translated.ok(), await translated.text()).toBe(true);
  return detail(request, chat.id);
}

async function readingDialog(page: Page, global = false) {
  if (global) {
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
  } else {
    const menu = await openChatMenu(page);
    await menu.getByRole('button', { name: '읽기 설정', exact: true }).click();
  }
  const dialog = page.getByRole('dialog', { name: global ? '설정' : '읽기 설정', exact: true });
  await expect(dialog.getByLabel('읽기 스타일', { exact: true })).toBeVisible();
  return dialog;
}

async function closeDialog(page: Page, dialog: Locator) {
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

async function fits(page: Page, region: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  expect(await region.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true
  );
}

const quotes = (region: Locator, role: 'dialogue' | 'thought' | 'quote') =>
  region.locator(`.reading-quote[data-quote-role="${role}"]`);
const anchors = (region: Locator) =>
  region
    .locator('[data-block-anchor]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-block-anchor'))
    );

async function clipboard(page: Page) {
  const copied: string[] = [];
  await page.exposeFunction('recordReadingClipboard', (text: string) => copied.push(text));
  await page.addInitScript(() => {
    localStorage.setItem('uimori:reading-language', 'original');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) =>
          (
            window as unknown as { recordReadingClipboard: (value: string) => Promise<void> }
          ).recordReadingClipboard(text),
      },
    });
  });
  return copied;
}

function watch(page: Page) {
  const writes: string[] = [],
    errors: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return { writes, errors };
}

test('READUI01 browser reading styles preserve source and translation text, anchors and copies at the default phone and desktop widths', async ({
  page,
  request,
}, info) => {
  const before = await seed(request);
  const copied = await clipboard(page);
  const observed = watch(page);
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/?chat=${before.chat.id}`);
    const source = page.getByTestId('source');
    await source.getByRole('button', { name: '원문 보기', exact: true }).click();
    const prose = source.getByTestId('source-text');
    await expect(prose).toContainText('정말 괜찮아');
    const textBefore = await prose.textContent();
    const anchorsBefore = await anchors(prose);
    const existingLines = prose.locator('p').filter({ hasText: '첫째 줄' });
    const existingLineHeight = (await existingLines.boundingBox())!.height;
    await expect(prose.locator('.reading-quote-break')).toHaveCount(0);
    const positionBlock = prose.locator('[data-block-anchor]').nth(8);
    const positionBefore = await positionBlock.evaluate((element) => {
      const scrollport = element.closest('[data-reader-scrollport]')!;
      scrollport.scrollTop +=
        element.getBoundingClientRect().top - scrollport.getBoundingClientRect().top + 3;
      return element.getBoundingClientRect().top;
    });

    let settings = await readingDialog(page);
    await expect(settings.getByLabel('인용 강조', { exact: true })).toHaveValue('off');
    await expect(
      settings.getByRole('switch', { name: '대사 줄바꿈', exact: true })
    ).not.toBeChecked();
    await settings.getByLabel('읽기 스타일', { exact: true }).selectOption({ label: '여유롭게' });
    await expect(settings.getByLabel('줄 간격', { exact: true })).not.toHaveValue('default');
    await settings.getByRole('button', { name: '읽기 스타일 초기화', exact: true }).click();
    await expect(settings.getByLabel('줄 간격', { exact: true })).toHaveValue('default');
    await settings.getByLabel('읽기 스타일', { exact: true }).selectOption({ label: '대사 중심' });
    await expect(settings.getByLabel('인용 강조', { exact: true })).toHaveValue('subtle');
    await expect(settings.getByRole('switch', { name: '대사 줄바꿈', exact: true })).toBeChecked();
    await expect(
      settings.getByRole('switch', { name: '생각 줄바꿈', exact: true })
    ).not.toBeChecked();
    await expect(
      settings.getByTestId('reading-preview').locator('.reading-quote-break').first()
    ).toBeVisible();
    await fits(page, settings);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`reading-settings-${width}.png`) });
    await closeDialog(page, settings);
    await expect
      .poll(async () => Math.abs((await positionBlock.boundingBox())!.y - positionBefore))
      .toBeLessThanOrEqual(3);

    const dialogue = quotes(prose, 'dialogue').filter({ hasText: '정말 괜찮아' });
    await expect(dialogue).toHaveAttribute('data-emphasis', 'subtle');
    await expect(dialogue).toHaveClass(/reading-quote-break/u);
    await expect(dialogue.locator('strong')).toHaveText('괜찮아');
    expect(Math.abs((await existingLines.boundingBox())!.height - existingLineHeight)).toBeLessThan(
      1
    );
    await expect(quotes(prose, 'thought').first()).not.toHaveClass(/reading-quote-break/u);
    await expect(quotes(prose, 'quote')).toHaveText('『별의 기록』');
    await expect(prose.locator('code .reading-quote')).toHaveCount(0);
    expect(await prose.textContent()).toBe(textBefore);
    expect(await anchors(prose)).toEqual(anchorsBefore);
    await expect(page.getByTestId('source-request').locator('.reading-quote')).toHaveCount(0);
    await source.getByRole('button', { name: '본문 복사', exact: true }).click();
    expect(copied.at(-1)).toBe(sourceText);

    await source.getByRole('button', { name: '번역 보기', exact: true }).click();
    const translated = source.getByTestId('translation-text');
    await expect(quotes(translated, 'dialogue').first()).toHaveClass(/reading-quote-break/u);
    const translation = before.jobs.find((job) => job.kind === 'translation')!;
    expect(await anchors(translated)).toEqual(
      translation.translationLayout!.blocks.map((block) => block.anchor)
    );
    await source.getByRole('button', { name: '본문 복사', exact: true }).click();
    expect(copied.at(-1)).toBe(translatedText);
    if (visualReview) {
      await page.screenshot({ path: info.outputPath(`reading-translation-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ path: info.outputPath(`reading-translation-dark-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'light' });
    }

    settings = await readingDialog(page, true);
    await expect(settings.getByLabel('인용 강조', { exact: true })).toHaveValue('subtle');
    await settings.getByLabel('인용 강조', { exact: true }).selectOption('strong');
    await settings.getByRole('switch', { name: '대사 줄바꿈', exact: true }).uncheck();
    await settings.getByRole('switch', { name: '생각 줄바꿈', exact: true }).check();
    await settings.getByLabel('줄 간격', { exact: true }).selectOption('2.2');
    await settings.getByLabel('문단 간격', { exact: true }).selectOption('2');
    await settings.getByText('표기별 스타일', { exact: true }).click();
    await settings.getByLabel('『겹낫표』 스타일', { exact: true }).selectOption('thought');
    await fits(page, settings);
    await closeDialog(page, settings);
    await expect(quotes(translated, 'dialogue').first()).not.toHaveClass(/reading-quote-break/u);
    await expect(quotes(translated, 'thought').filter({ hasText: '『여행의 끝』' })).toHaveClass(
      /reading-quote-break/u
    );

    await page.reload();
    settings = await readingDialog(page);
    await expect(settings.getByLabel('인용 강조', { exact: true })).toHaveValue('strong');
    await expect(
      settings.getByRole('switch', { name: '대사 줄바꿈', exact: true })
    ).not.toBeChecked();
    await expect(settings.getByRole('switch', { name: '생각 줄바꿈', exact: true })).toBeChecked();
    await expect(settings.getByLabel('줄 간격', { exact: true })).toHaveValue('2.2');
    await expect(settings.getByLabel('문단 간격', { exact: true })).toHaveValue('2');
    await settings.getByText('표기별 스타일', { exact: true }).click();
    await expect(settings.getByLabel('『겹낫표』 스타일', { exact: true })).toHaveValue('thought');
    await settings.getByRole('button', { name: '읽기 스타일 초기화', exact: true }).click();
    await expect(settings.getByLabel('인용 강조', { exact: true })).toHaveValue('off');
    await expect(settings.getByLabel('『겹낫표』 스타일', { exact: true })).toHaveValue('quote');
    await closeDialog(page, settings);
    await source.getByRole('button', { name: '원문 보기', exact: true }).click();
    await expect(prose.locator('.reading-quote-break')).toHaveCount(0);
    expect(await prose.textContent()).toBe(textBefore);
    expect(await anchors(prose)).toEqual(anchorsBefore);
    await source.getByRole('button', { name: '원문 수정', exact: true }).click();
    await expect(source.getByLabel('원문 수정 내용', { exact: true })).toHaveValue(sourceText);
    await source.getByRole('button', { name: '수정 취소', exact: true }).click();
    for (const size of [9, 28]) {
      settings = await readingDialog(page);
      const slider = settings.getByRole('slider', { name: '본문 크기' });
      await expect(slider).toHaveAttribute('min', '9');
      await expect(slider).toHaveAttribute('max', '28');
      await slider.focus();
      await page.keyboard.press(size === 9 ? 'Home' : 'End');
      await expect(slider).toHaveValue(String(size));
      await closeDialog(page, settings);
      await expect(prose).toHaveCSS('font-size', `${size}px`);
      await fits(page, prose);
      await page.reload();
      settings = await readingDialog(page, true);
      await expect(settings.getByRole('slider', { name: '본문 크기' })).toHaveValue(String(size));
      await closeDialog(page, settings);
    }
    settings = await readingDialog(page);
    await settings.getByRole('slider', { name: '본문 크기' }).focus();
    for (let step = 28; step > 18; step--) await page.keyboard.press('ArrowLeft');
    await expect(settings.getByRole('slider', { name: '본문 크기' })).toHaveValue('18');
    await closeDialog(page, settings);
  }
  const other = await page.context().newPage();
  try {
    await other.goto(`/?chat=${before.chat.id}`);
    const otherSettings = await readingDialog(other);
    await expect(otherSettings.getByRole('slider', { name: '본문 크기' })).toHaveValue('18');
    const settings = await readingDialog(page);
    const size = settings.getByRole('slider', { name: '본문 크기' });
    await size.focus();
    await page.keyboard.press('End');
    await expect(size).toHaveValue('28');
    await settings.getByLabel('본문 글꼴', { exact: true }).selectOption('serif');
    await settings.getByLabel('본문 폭', { exact: true }).selectOption('1040');
    await settings.getByLabel('인용 강조', { exact: true }).selectOption('subtle');
    await expect(otherSettings.getByLabel('인용 강조', { exact: true })).toHaveValue('subtle');
    // Receiving the shared style must not persist this tab's older layout selections.
    await otherSettings.getByRole('switch', { name: '생각 줄바꿈', exact: true }).check();
    await expect(settings.getByRole('switch', { name: '생각 줄바꿈', exact: true })).toBeChecked();
    expect(
      await page.evaluate(() => [
        localStorage.getItem('uimori:font-size'),
        localStorage.getItem('uimori:font'),
        localStorage.getItem('uimori:reading-width'),
      ])
    ).toEqual(['28', 'serif', '1040']);
    await closeDialog(page, settings);
  } finally {
    await other.close();
  }
  const after = await detail(request, before.chat.id);
  expect(after.sources).toEqual(before.sources);
  expect(after.jobs).toEqual(before.jobs);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.profile).toEqual(before.profile);
  expect(observed).toEqual({ writes: [], errors: [] });
});

/** Read-only helper projections: no model, helper mutation or shared global fixture is involved. */
async function helperFixture(page: Page, before: ChatDetail) {
  const time = new Date().toISOString();
  const conversation: HelperConversation = {
    id: randomUUID(),
    scope: { kind: 'chat', chatId: before.chat.id, branchId: before.branches![0].id },
    title: '합성 읽기 도우미',
    revision: 1,
    persona: helperPersona,
    limits: { totalCalls: 24, helperCalls: 12, artifacts: 1 },
    createdAt: time,
    updatedAt: time,
  };
  const usage = { modelCalls: 1, inputTokens: 10, outputTokens: 10, costUsd: null };
  const tasks: HelperTaskView[] = ['running', 'completed'].map((status) => ({
    id: randomUUID(),
    conversationId: conversation.id,
    request: helperRequest,
    status: status as HelperTaskView['status'],
    modelTitle: '“상태 카드의 모델 이름”',
    generation: 1,
    error: null,
    usage,
    createdAt: time,
    startedAt: time,
    updatedAt: time,
  }));
  const artifact: HelperArtifactView = {
    id: randomUUID(),
    conversationId: conversation.id,
    taskId: tasks[1].id,
    revision: 1,
    origin: 'model',
    request: helperRequest,
    text: artifactText,
    usage,
    createdAt: time,
  };
  const message = (
    task: HelperTaskView,
    role: HelperMessage['role'],
    text: string
  ): HelperMessage => ({
    id: randomUUID(),
    conversationId: conversation.id,
    taskId: task.id,
    role,
    text,
    artifacts: role === 'assistant' ? [{ id: artifact.id, revision: 1 }] : [],
    createdAt: time,
  });
  const messages = [
    message(tasks[1], 'user', helperRequest),
    message(tasks[1], 'assistant', helperAnswer),
    message(tasks[0], 'user', helperRequest),
  ];
  const streams: ResponseStreamPage = {
    taskKind: 'helper',
    taskId: tasks[0].id,
    status: 'running',
    chunks: [
      {
        seq: 1,
        attemptId: 'reading-attempt',
        segment: 0,
        text: streamText,
        offset: streamText.length,
      },
    ],
    cursor: 1,
    hasMore: false,
  };
  const unexpected: string[] = [];
  await page.route('**/api/helper/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      if (path === '/api/helper/conversations')
        return route.fulfill({
          json: [{ ...conversation, activity: { running: 1, queued: 0 }, latestEventSeq: 0 }],
        });
      if (path === `/api/helper/conversations/${conversation.id}`)
        return route.fulfill({ json: conversation });
      if (path === `/api/helper/conversations/${conversation.id}/messages`)
        return route.fulfill({ json: messages });
      if (path === `/api/helper/conversations/${conversation.id}/tasks`)
        return route.fulfill({ json: tasks });
      if (path === `/api/helper/conversations/${conversation.id}/events`)
        return route.fulfill({ json: [] });
      if (path === `/api/helper/artifacts/${artifact.id}`) return route.fulfill({ json: artifact });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 400,
      json: { error: 'Unexpected readability fixture request' },
    });
  });
  await page.route(`**/api/response-streams/helper/${tasks[0].id}?*`, async (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
    return route.fulfill({
      json: { ...streams, chunks: streams.chunks.filter((chunk) => chunk.seq > after) },
    });
  });
  return { unexpected };
}

test('READUI02 helper answers, independent scenes and public streams share reading styles while requests and diagnostics stay literal', async ({
  page,
  request,
}, info) => {
  const before = await seed(request);
  const copied = await clipboard(page);
  const fixture = await helperFixture(page, before);
  const observed = watch(page);
  try {
    for (const width of DEFAULT_WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/?chat=${before.chat.id}`);
      await openHelper(page);
      const panel = page.locator('#helper-panel');
      const answer = panel.locator('.helper-message.assistant > .helper-prose');
      const card = panel.getByRole('region', { name: '독립 가정 장면', exact: true });
      const stream = panel.locator('.streaming-text');
      await expect(answer).toHaveText(helperAnswer);
      const answerHeight = (await answer.boundingBox())!.height;
      await expect(card.locator('.helper-prose')).toHaveText(artifactText);
      await expect(stream).toHaveText(streamText);
      await expect(panel.locator('.reading-quote-break')).toHaveCount(0);
      await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
      await expect(panel).toBeHidden();
      let settings = await readingDialog(page);
      await settings
        .getByLabel('읽기 스타일', { exact: true })
        .selectOption({ label: '대사 중심' });
      await closeDialog(page, settings);
      await openHelper(page);
      for (const text of [answer, card.locator('.helper-prose'), stream]) {
        await expect(quotes(text, 'dialogue').first()).toHaveClass(/reading-quote-break/u);
        await expect(quotes(text, 'dialogue').first()).toHaveAttribute('data-emphasis', 'subtle');
      }
      expect(await answer.textContent()).toBe(helperAnswer);
      expect(Math.abs((await answer.boundingBox())!.height - answerHeight)).toBeLessThan(1);
      expect(await card.locator('.helper-prose').textContent()).toBe(artifactText);
      expect(await stream.textContent()).toBe(streamText);
      await expect(panel.getByTestId('source-request')).toHaveCount(2);
      await expect(panel.getByTestId('source-request').locator('.reading-quote')).toHaveCount(0);
      const status = panel.getByTestId('helper-task-activity');
      await status.locator('summary').click();
      await expect(status).toContainText('“상태 카드의 모델 이름”');
      await expect(status.locator('.reading-quote')).toHaveCount(0);
      await status.locator('summary').click();
      await panel.getByRole('button', { name: '도우미 말투 설정', exact: true }).click();
      await expect(panel.getByRole('textbox', { name: '도우미 말투', exact: true })).toHaveValue(
        helperPersona
      );
      await expect(panel.locator('.helper-settings .reading-quote')).toHaveCount(0);
      await panel.getByRole('button', { name: '도우미 말투 설정', exact: true }).click();
      await card.getByRole('button', { name: '가정 장면 복사', exact: true }).click();
      expect(copied.at(-1)).toBe(artifactText);
      await card.getByRole('button', { name: '직접 편집', exact: true }).click();
      await expect(
        card.getByRole('textbox', { name: '가정 장면 직접 편집', exact: true })
      ).toHaveValue(artifactText);
      await card.getByRole('button', { name: '장면 편집 취소', exact: true }).click();
      await fits(page, panel);
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`reading-helper-${width}.png`) });
      await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
      await expect(panel).toBeHidden();
      await page.reload();
      await openHelper(page);
      await expect(quotes(answer, 'dialogue').first()).toHaveAttribute('data-emphasis', 'subtle');
      await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
      await expect(panel).toBeHidden();
      settings = await readingDialog(page);
      await settings.getByRole('button', { name: '읽기 스타일 초기화', exact: true }).click();
      await closeDialog(page, settings);
      await openHelper(page);
      await expect(panel.locator('.reading-quote-break')).toHaveCount(0);
      await expect(answer).toHaveText(helperAnswer);
      await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
    }
    const after = await detail(request, before.chat.id);
    expect(after.sources).toEqual(before.sources);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.runs).toEqual(before.runs);
    expect(after.attempts).toEqual(before.attempts);
    expect(observed).toEqual({ writes: [], errors: [] });
    expect(fixture.unexpected).toEqual([]);
  } finally {
    // Stop polling before draining handlers; route completion must not race context disposal.
    await page.goto('about:blank');
    await page.unrouteAll({ behavior: 'wait' });
  }
});
