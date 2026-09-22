import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { HelperConversation, HelperMessage } from '../core/helper.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import type { HelperArtifactView } from '../web/HelperArtifactCard.js';
import type { HelperTaskView } from '../web/useHelperConversation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { visualReview } from './fixtures/visual-review.js';
import { waitForNativeLayout } from './fixtures/native-message.js';
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
async function clipboard(page: Page) {
  const copied: string[] = [];
  await page.exposeFunction('recordReadingClipboard', (text: string) => copied.push(text));
  await page.addInitScript(() => {
    // Host preferences and clipboard mocks must not run inside opaque Risu card frames.
    if (window !== window.top) return;
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

test('READUI01 native source and translation keep text and copies while shared reading settings persist', async ({
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
    const prose = source.getByTestId('source-text').locator('.risu-message-content');
    await expect(prose).toContainText('정말 괜찮아');
    const authored = prose.locator('.risu-chat-text');
    const textBefore = await authored.textContent();
    await waitForNativeLayout(source.getByTestId('source-text'));
    const copy = source.getByRole('button', { name: '본문 복사', exact: true });
    await copy.scrollIntoViewIfNeeded();
    await expect(copy).toBeInViewport();
    await copy.click();
    await expect.poll(() => copied.at(-1)).toBe(sourceText);

    let settings = await readingDialog(page);
    await settings.getByLabel('읽기 스타일', { exact: true }).selectOption({ label: '여유롭게' });
    const slider = settings.getByRole('slider', { name: '본문 크기' });
    await slider.focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveValue('28');
    await fits(page, settings);
    await closeDialog(page, settings);
    await expect(prose).toHaveCSS('font-size', '28px');
    await expect
      .poll(() =>
        prose.evaluate((node) => {
          const style = getComputedStyle(node);
          return Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize);
        })
      )
      .toBeCloseTo(2.2);
    expect(await authored.textContent()).toBe(textBefore);
    await expect(authored.locator('p[data-uimori-prose]').first()).toHaveCSS(
      'margin-bottom',
      '42px'
    );
    settings = await readingDialog(page);
    await settings.getByLabel('읽기 스타일', { exact: true }).selectOption('dialogue');
    await closeDialog(page, settings);
    await expect(authored.locator('.reading-quote-break-before').first()).toBeAttached();
    await expect(authored.locator('[data-quote-role="dialogue"]').first()).toHaveAttribute(
      'data-emphasis',
      'subtle'
    );
    expect(await authored.textContent()).toBe(textBefore);
    settings = await readingDialog(page);
    await settings.getByLabel('읽기 스타일', { exact: true }).selectOption('relaxed');
    await closeDialog(page, settings);

    await page.reload();
    settings = await readingDialog(page, true);
    await expect(settings.getByRole('slider', { name: '본문 크기' })).toHaveValue('28');
    await expect(settings.getByLabel('줄 간격', { exact: true })).toHaveValue('2.2');
    await closeDialog(page, settings);
    await expect(prose).toHaveCSS('font-size', '28px');
    await source.getByRole('button', { name: '번역 보기', exact: true }).click();
    const translated = source.getByTestId('translation-text').locator('.risu-message-content');
    await expect(translated).toContainText('번역된 장면이다.');
    await expect(translated).toHaveCSS('font-size', '28px');
    await waitForNativeLayout(source.getByTestId('translation-text'));
    await copy.scrollIntoViewIfNeeded();
    await expect(copy).toBeInViewport();
    await copy.click();
    await expect.poll(() => copied.at(-1)).toBe(translatedText);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`reading-translation-${width}.png`) });

    await source.getByRole('button', { name: '원문 보기', exact: true }).click();
    await expect(prose).toContainText('정말 괜찮아');
    await waitForNativeLayout(source.getByTestId('source-text'));
    const edit = source.locator('.scene-action[aria-label="원문 수정"]');
    await edit.scrollIntoViewIfNeeded();
    await expect(edit).toBeInViewport();
    await edit.click();
    await expect(source.getByLabel('원문 수정 내용', { exact: true })).toHaveValue(sourceText);
    await source.getByRole('button', { name: '수정 취소', exact: true }).click();
    expect(await authored.textContent()).toBe(textBefore);
    settings = await readingDialog(page);
    await settings.getByRole('button', { name: '읽기 스타일 초기화', exact: true }).click();
    await settings.getByRole('slider', { name: '본문 크기' }).focus();
    for (let step = 28; step > 18; step--) await page.keyboard.press('ArrowLeft');
    await expect(settings.getByRole('slider', { name: '본문 크기' })).toHaveValue('18');
    await closeDialog(page, settings);
    await expect(prose).toHaveCSS('font-size', '18px');
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
      if (path === `/api/helper/conversations/${conversation.id}/view`)
        return route.fulfill({ json: { conversation, messages, tasks, eventCursor: 0 } });
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
