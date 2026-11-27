import { setCurrentModels, selectEditorSection } from './ui-navigation.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { visualReview } from './fixtures/visual-review.js';
import { nativeContent } from './fixtures/native-content.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, ReaderDetail } from '../core/types.js';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import { navigationAction, openMoreSourceActions, sourceAction } from './ui-navigation.js';

{
  const viewportName = 'mobile';
  test(`NSUI01 ${viewportName} creation retains title and persona, then opens a native authored greeting without generation`, async ({
    page,
    request,
  }, info) => {
    const title = `Quick start ${crypto.randomUUID()}`;
    const imageResponse = await request.post('/api/package-image-blobs', {
      data: {
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQCej5D8IMMAYAP7QHvSBXvZYAAAAASUVORK5CYII=',
      },
    });
    expect(imageResponse.ok()).toBe(true);
    const image = await imageResponse.json();
    const savedBot = await request.post('/api/content', {
      data: {
        kind: 'bot',
        title,
        description: 'Synthetic quick-start fixture.',
        text: '',
        loading: 'pinned',
        relatedIds: [],
        package: {
          version: 2,
          id: 'quick-start-template',
          revision: 1,
          title,
          description: '',
          body: '',
          lore: [],
          images: [
            {
              id: 'opening-image',
              title: '등록된 시작 이미지',
              description: '',
              blobHash: image.hash,
              mime: image.mime,
              allowedUse: 'inline',
            },
          ],
          nativeRisu: {
            version: 1,
            assets: [{ name: 'opening', uri: 'opening', imageId: 'opening-image' }],
            sourceHash: 'a'.repeat(64),
            card: {
              name: title,
              description: 'A synthetic harbor guide.',
              first_mes: 'Harbor greets {{user}}.\n\n{{img::opening}}',
              alternate_greetings: ['Night watch begins.'],
              extensions: { risuai: {} },
            },
          },
        },
      },
    });
    expect(savedBot.ok()).toBe(true);
    const bot = (await savedBot.json()) as Content;
    const personaTitle = `Mira ${viewportName} ${crypto.randomUUID().slice(0, 8)}`;
    expect(
      (
        await request.post('/api/content', {
          data: {
            kind: 'persona',
            title: personaTitle,
            description: '',
            text: 'Synthetic traveler.',
            loading: 'pinned',
            relatedIds: [],
          },
        })
      ).ok()
    ).toBe(true);
    const connection = (await (
      await request.post('/api/connections', {
        data: {
          title: `${title} connection`,
          protocol: 'fixture-sse-v1',
          endpoint: 'http://127.0.0.1:9/no-provider',
          enabled: true,
        },
      })
    ).json()) as Connection;
    const model = (await (
      await request.post('/api/model-presets', {
        data: {
          title: '합성 본문 모델',
          connectionId: connection.id,
          modelId: 'synthetic-quick-start',
          maxOutputTokens: 1000,
          temperature: null,
        },
      })
    ).json()) as ModelPreset;
    await setCurrentModels(request, { main: { id: model.id }, translation: null });
    const executionRequests: string[] = [];
    page.on('request', (item) => {
      if (item.method() === 'POST' && /\/(?:runs|candidate|translation)$/.test(item.url()))
        executionRequests.push(item.url());
    });
    await page.goto('/');
    await navigationAction(page, '설정 후 새 채팅', bot.title);
    const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
    await expect(dialog.getByLabel('첫 메시지 선택')).toHaveValue('start-0');
    await expect(dialog.getByRole('button', { name: '채팅 만들기', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(dialog.locator('.risu-message-surface')).toHaveCount(0);
    await expect(dialog.getByText('Harbor greets', { exact: false })).toHaveCount(0);
    await expect(dialog.getByText('미리보기', { exact: true })).toBeVisible();
    await dialog.getByLabel('첫 메시지 선택').selectOption('');
    await expect(dialog.getByRole('button', { name: '역할별 모델', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('시작 본문 모델', { exact: true })).toHaveCount(0);
    const options = dialog.locator('.new-story-options');
    await expect(options).not.toHaveAttribute('open');
    await options.locator('summary').click();
    await expect(dialog.getByRole('button', { name: '채팅 만들기', exact: true })).toBeInViewport({
      ratio: 1,
    });
    const customTitle = '추가 설정에 남긴 합성 제목';
    await dialog.getByLabel('새 채팅 제목', { exact: true }).fill(customTitle);
    await options.locator('summary').click();
    await expect(dialog.getByLabel('새 채팅 제목', { exact: true })).not.toBeVisible();
    await options.locator('summary').click();
    await expect(dialog.getByLabel('새 채팅 제목', { exact: true })).toHaveValue(customTitle);
    await options.locator('summary').click();
    const created = page.waitForResponse(
      (response) => /\/api\/chats$/.test(response.url()) && response.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
    const chat = (await (await created).json()) as Chat;
    await expect(dialog).toBeHidden();
    const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
    expect(detail.chat.title).toBe(customTitle);
    expect(detail.profile!.routes.main).toEqual({ id: model.id });
    expect(detail.runs).toHaveLength(0);
    expect(detail.attempts).toHaveLength(0);
    await navigationAction(page, '설정 후 새 채팅', bot.title);
    await dialog.getByRole('button', { name: '시작 페르소나', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '시작 페르소나', exact: true });
    await picker.getByRole('searchbox').fill(personaTitle);
    const personaChoice = picker
      .getByRole('button')
      .filter({ has: page.getByText(personaTitle, { exact: true }) });
    await expect(picker.getByRole('button', { name: '페르소나', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(personaChoice.locator('.content-picker-meta')).toHaveCount(0);
    await picker.getByRole('button', { name: '모든 자료', exact: true }).click();
    await expect(personaChoice.locator('.content-picker-meta')).toHaveText('페르소나');
    await personaChoice.click();
    await dialog.getByText('미리보기', { exact: true }).click();
    const frame = dialog.locator('.risu-message-surface');
    await expect(frame.locator('.risu-message-content')).toContainText(
      `Harbor greets ${personaTitle}.`
    );
    await expect(frame.locator('img')).toBeVisible();
    await dialog.getByLabel('첫 메시지 선택').selectOption('start-1');
    await expect(dialog.locator('.risu-message-surface')).toHaveCount(0);
    await dialog.getByText('미리보기', { exact: true }).click();
    await expect(frame.locator('.risu-message-content')).toContainText('Night watch begins.');
    await dialog.getByLabel('첫 메시지 선택').selectOption('start-0');
    await expect(dialog.locator('.risu-message-surface')).toHaveCount(0);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`new-story-native-${viewportName}.png`) });
    const confirmed = page.waitForResponse(
      (response) =>
        /\/package-start$/.test(response.url()) && response.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
    const opening = await (await confirmed).json();
    expect(opening.run.usage.modelCalls).toBe(0);
    await expect(dialog).toBeHidden();
    const reader = page.getByTestId('source-text').locator('.risu-message-surface');
    await expect(reader.locator('.risu-message-content')).toContainText(
      `Harbor greets ${personaTitle}.`
    );
    await expect(reader.locator('img')).toBeVisible();
    expect(executionRequests).toEqual([]);
    await page.getByRole('button', { name: '장면 목록 열기', exact: true }).click();
    const scenes = page.getByRole('dialog', { name: '장면 목록', exact: true });
    const firstMessage = scenes.getByRole('button', { name: '첫 메시지', exact: true });
    await expect(firstMessage).toBeVisible();
    await expect(scenes.getByText('첫 메시지', { exact: true })).toHaveCount(1);
    await expect(scenes).not.toContainText('0개 장면');
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`scene-list-opening-${viewportName}.png`) });
    await firstMessage.click();
    await expect(scenes).toBeHidden();
  });
}

preservePromptWorkspace();

async function quickChatFixture(request: APIRequestContext, greetings: number) {
  const title = `바로 시작 ${greetings} ${crypto.randomUUID()}`;
  const botResponse = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: '',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: nativeContent({
        name: title,
        first_mes: greetings ? '안녕하세요 {{user}}.' : '',
        alternate_greetings: greetings > 1 ? ['다른 시작이에요.'] : [],
      }),
    },
  });
  expect(botResponse.ok()).toBe(true);
  const bot = (await botResponse.json()) as Content;
  const personaResponse = await request.post('/api/content', {
    data: {
      kind: 'persona',
      title: `방문자 ${crypto.randomUUID()}`,
      description: '',
      text: 'Synthetic persona',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(personaResponse.ok()).toBe(true);
  const persona = (await personaResponse.json()) as Content;
  expect(
    (
      await request.patch(`/api/bots/${bot.id}/defaults`, {
        data: {
          expectedRevision: 1,
          persona: { mode: 'persona', persona: { id: persona.id, revision: persona.revision } },
        },
      })
    ).ok()
  ).toBe(true);
  const connectionResponse = await request.post('/api/connections', {
    data: {
      title: `직접 시작 검증 ${crypto.randomUUID()}`,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/no-provider',
      enabled: true,
    },
  });
  expect(connectionResponse.ok()).toBe(true);
  const connection = (await connectionResponse.json()) as Connection;
  const modelResponse = await request.post('/api/model-presets', {
    data: {
      title: '합성 바로 시작 모델',
      connectionId: connection.id,
      modelId: 'synthetic-quick-start',
      maxOutputTokens: 1000,
      temperature: null,
    },
  });
  expect(modelResponse.ok()).toBe(true);
  const model = (await modelResponse.json()) as ModelPreset;
  await setCurrentModels(request, { main: { id: model.id }, translation: null });
  return { bot, persona, model };
}

async function openQuickChat(page: Page, bot: Content) {
  await navigationAction(page, '서재');
  const library = page.getByTestId('library-panel');
  await library.getByRole('tab', { name: '봇', exact: true }).click();
  await library.getByLabel('서재 검색', { exact: true }).fill(bot.title);
  await library.getByRole('button', { name: `${bot.title} 새 채팅`, exact: true }).click();
}

test('NSQ03 closing while defaults load cancels unstarted admission; failed defaults retry through the form', async ({
  page,
  request,
}) => {
  const { bot } = await quickChatFixture(request, 1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route(`**/api/bots/${bot.id}/defaults`, async (route) => {
    if (first) {
      first = false;
      await held;
      return route.fulfill({ status: 503, json: { error: 'QUICK_DEFAULTS_READ_FAILED' } });
    }
    return route.continue();
  });
  const admissions: string[] = [];
  page.on('request', (item) => {
    if (item.method() === 'POST' && /\/api\/chats$/.test(item.url())) admissions.push(item.url());
  });
  try {
    await page.goto('/');
    await openQuickChat(page, bot);
    const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
    await expect(dialog.getByText('새 채팅을 여는 중이에요…', { exact: true })).toBeVisible();
    const failed = page.waitForResponse(
      (response) => response.url().endsWith(`/bots/${bot.id}/defaults`) && response.status() === 503
    );
    await dialog.getByRole('button', { name: '새 채팅 닫기', exact: true }).click();
    release();
    await failed;
    await expect(dialog).toBeHidden();
    expect(admissions).toEqual([]);
    await page.route(`**/api/bots/${bot.id}/defaults`, (route) =>
      route.fulfill({ status: 503, json: { error: 'QUICK_DEFAULTS_READ_FAILED' } })
    );
    await openQuickChat(page, bot);
    await expect(dialog.getByRole('alert')).toContainText('503');
    await expect(dialog.getByRole('button', { name: '시작 페르소나', exact: true })).toBeVisible();
    await page.unroute(`**/api/bots/${bot.id}/defaults`);
    await dialog.getByRole('button', { name: '다시 불러오기', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '채팅 만들기', exact: true })).toBeEnabled();
    expect(admissions).toEqual([]);
  } finally {
    release();
  }
});

test('NSQ05 an uncertain chat admission stops automatic and manual resubmission', async ({
  page,
  request,
}) => {
  const { bot } = await quickChatFixture(request, 1);
  let admissions = 0;
  await page.route('**/api/chats', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    admissions++;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort('failed');
  });
  await page.goto('/');
  await openQuickChat(page, bot);
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('채팅 생성 응답을 확인하지 못했어요');
  await expect(dialog.getByRole('alert')).toContainText(
    '목록을 새로 확인한 뒤 이어서 설정해 주세요'
  );
  await expect(dialog.getByRole('button', { name: '채팅 만들기', exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog.getByRole('button', { name: '시작 페르소나', exact: true })).toBeDisabled();
  expect(admissions).toBe(1);
});

test('NSUI02 native authoring preserves raw drafts and starts with the rendered default greeting', async ({
  page,
  request,
}) => {
  const title = `Native editor ${crypto.randomUUID()}`;
  const card = {
    name: title,
    description: 'Native configuration',
    first_mes: '<selector>',
    alternate_greetings: ['Other greeting'],
    unknown: { preserve: true },
    extensions: {
      risuai: {
        customScripts: [
          {
            in: '<selector>',
            out: '<button risu-trigger="choose">{{char}} route</button>',
            type: 'editdisplay',
            flag: 'g',
            ableFlag: true,
          },
        ],
      },
    },
  };
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: '',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: {
        version: 2,
        id: 'native-editor',
        revision: 1,
        title,
        description: '',
        body: '',
        lore: [],
        nativeRisu: { version: 1, card, assets: [], sourceHash: 'a'.repeat(64) },
      },
    },
  });
  expect(response.ok()).toBe(true);
  const saved = (await response.json()) as Content;
  await page.goto('/');
  await page.getByRole('button', { name: `${title} 편집`, exact: true }).click();
  const library = page.getByTestId('library-panel');
  await expect(library.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toHaveValue(title);
  await selectEditorSection(library, '첫 메시지');
  await library.getByLabel('기본 첫 메시지', { exact: true }).fill('<selector> Edited');
  await selectEditorSection(library, 'JSON 소스');
  await library.getByLabel('Risu 원문 JSON').fill('[{"unfinished":');
  const save = library.getByRole('button', { name: '변경사항 저장', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  expect((await (await request.get(`/api/content/${saved.id}`)).json()).revision).toBe(
    saved.revision
  );
  await library
    .getByLabel('Risu 원문 JSON')
    .fill('[{"name":"New lore","content":"Lore {{char}}","constant":true,"custom":42}]');
  await save.click();
  await expect
    .poll(async () => (await (await request.get(`/api/content/${saved.id}`)).json()).revision)
    .toBe(2);
  const updated = (await (await request.get(`/api/content/${saved.id}`)).json()) as Content;
  expect(updated.package!.nativeRisu!.card.unknown).toEqual({ preserve: true });
  expect(updated.package!.nativeRisu!.card.first_mes).toBe('<selector> Edited');
  expect(updated.package!.starts![0].text).toBe('<selector> Edited');
  expect(updated.package!.lore[0].text).toBe('Lore {{char}}');
  await library.getByRole('button', { name: '채팅 시작', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await expect(dialog.getByLabel('첫 메시지 선택')).toHaveValue('start-0');
  await dialog.getByText('미리보기', { exact: true }).click();
  const frame = dialog.locator('.risu-message-surface');
  await expect(frame.locator('.risu-message-content')).toContainText('Edited');
  await dialog.getByLabel('첫 메시지 선택').selectOption('start-1');
  await expect(dialog.locator('.risu-message-surface')).toHaveCount(0);
  await dialog.getByText('미리보기', { exact: true }).click();
  await expect(dialog.getByLabel('첫 메시지 선택')).toHaveValue('start-1');
  await expect(dialog.locator('.risu-message-surface .risu-message-content')).toContainText(
    'Other greeting'
  );
  await dialog.getByLabel('첫 메시지 선택').selectOption('');
  await expect(dialog.getByLabel('첫 메시지 선택')).toHaveValue('');
});

test('NSUI10 authored opening switches in the same chat, retains the draft, and hides empty generation details', async ({
  page,
  request,
}) => {
  const title = `시작문 선택 검증 ${crypto.randomUUID()}`;
  const saved = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: '',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: nativeContent({
        name: title,
        first_mes:
          '<section><h2>비 오는 도서관</h2><p>서가 사이로 젖은 바람이 들어왔다.</p></section>',
        alternate_greetings: [
          '<section><h2>새벽의 정원</h2><p>이슬 맺힌 잎사귀 너머로 누군가 손을 흔들었다.</p></section>',
          '<section><h2>노을 지는 역</h2><p>마지막 열차를 알리는 종이 울렸다.</p></section>',
        ],
      }),
    },
  });
  expect(saved.ok()).toBe(true);
  const bot = (await saved.json()) as Content;
  await setCurrentModels(request, { main: null, translation: null });
  const mainRequests: string[] = [];
  page.on('request', (item) => {
    if (item.method() === 'POST' && /\/(?:runs|candidate)$/.test(item.url()))
      mainRequests.push(item.url());
  });
  await page.goto('/');
  await navigationAction(page, '설정 후 새 채팅', bot.title);
  const create = page.getByRole('dialog', { name: '새 채팅', exact: true });
  const started = page.waitForResponse(
    (response) => /\/package-start$/.test(response.url()) && response.request().method() === 'POST'
  );
  await create.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  const openingResponse = await started;
  expect(openingResponse.ok()).toBe(true);
  const opening = await openingResponse.json();
  const chatId = opening.run.chatId as string;
  const read = async () => (await (await request.get(`/api/chats/${chatId}`)).json()) as ChatDetail;
  await expect(create).toBeHidden();
  const source = page.getByTestId('source').first();
  await expect(source.getByRole('heading', { name: '비 오는 도서관' })).toBeVisible();
  await source.locator('.folio').click();
  await expect(source.getByTestId('turn-activity')).toHaveCount(0);
  await expect(source).not.toContainText('이번 생성');
  await expect(source).not.toContainText('실행 확인');
  const draft = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await draft.fill('시작문을 바꿔도 남겨 둘 다음 장면 초안');
  await sourceAction(source, '첫 메시지 바꾸기');
  const picker = page.getByRole('dialog', { name: '첫 메시지 바꾸기', exact: true });
  await expect(picker.getByLabel('첫 메시지 선택')).toHaveValue('start-0');
  await picker.getByLabel('첫 메시지 선택').selectOption('start-1');
  await picker.getByText('미리보기', { exact: true }).click();
  await expect(picker.getByRole('heading', { name: '새벽의 정원' })).toBeVisible();
  const changed = page.waitForResponse(
    (response) => /\/package-start$/.test(response.url()) && response.request().method() === 'POST'
  );
  await picker.getByRole('button', { name: '첫 메시지 바꾸기', exact: true }).click();
  const switched = await changed;
  expect(switched.ok()).toBe(true);
  await expect(picker).toBeHidden();
  await expect(source.getByRole('heading', { name: '새벽의 정원' })).toBeVisible();
  await expect(draft).toHaveValue('시작문을 바꿔도 남겨 둘 다음 장면 초안');
  expect(new URL(page.url()).searchParams.get('chat')).toBe(chatId);
  const after = await read();
  expect(after.chat.id).toBe(chatId);
  const readActive = async () =>
    (await (await request.get(`/api/chats/${chatId}/reader`)).json()) as ReaderDetail;
  const active = await readActive();
  expect(active.reader.order).toHaveLength(1);
  expect(active.sources.find((item) => item.id === active.reader.order[0])?.text).toContain(
    '새벽의 정원'
  );
  expect(after.sources).toHaveLength(2);
  expect(after.sources.some((item) => item.text.includes('비 오는 도서관'))).toBe(true);
  expect(after.runs.every((run) => run.usage.modelCalls === 0)).toBe(true);
  expect(after.attempts).toHaveLength(0);
  expect(mainRequests).toEqual([]);
  await page.reload();
  await expect(source.getByRole('heading', { name: '새벽의 정원' })).toBeVisible();
  await expect(draft).toHaveValue('시작문을 바꿔도 남겨 둘 다음 장면 초안');
  await expect(source.getByTestId('turn-activity')).toHaveCount(0);
  await sourceAction(source, '첫 메시지 바꾸기');
  await expect(picker.getByLabel('첫 메시지 선택')).toHaveValue('start-1');
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(source.getByLabel('장면 작업 메뉴', { exact: true })).toBeFocused();
  await sourceAction(source, '번역 수정');
  await page.getByLabel('번역 수정 내용').fill('The garden stirred in the dawn light.');
  await page.getByRole('button', { name: '번역 저장', exact: true }).click();
  await expect(source.getByTestId('translation-text')).toContainText(
    'The garden stirred in the dawn light.'
  );
  const activity = source.getByTestId('turn-activity');
  await expect(activity).toBeVisible();
  await activity.locator(':scope > summary').click();
  await expect(activity).toContainText('번역');
  await expect(activity).not.toContainText('이번 생성');
  await expect(activity).not.toContainText('실행 확인');
  expect((await read()).attempts).toHaveLength(0);
  expect(mainRequests).toEqual([]);
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect.poll(async () => (await readActive()).reader.total).toBe(2);
  await openMoreSourceActions(source);
  await expect(source.getByRole('button', { name: '첫 메시지 바꾸기', exact: true })).toHaveCount(
    0
  );
});

{
  const greetings = 1;
  test(`NSQ01 quick chat opens with ${greetings} authored greetings and saved defaults without generation`, async ({
    page,
    request,
  }, info) => {
    const { bot, persona, model } = await quickChatFixture(request, greetings);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/bots/${bot.id}/defaults`, async (route) => {
      await held;
      await route.continue();
    });
    const admissions: string[] = [],
      executions: string[] = [];
    page.on('request', (item) => {
      if (item.method() !== 'POST') return;
      if (/\/api\/chats$/.test(item.url())) admissions.push(item.url());
      if (/\/(?:runs|candidate|translation)$/.test(item.url())) executions.push(item.url());
    });
    try {
      await page.goto('/');
      await openQuickChat(page, bot);
      const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
      await expect(dialog.getByRole('button', { name: '시작 페르소나', exact: true })).toHaveCount(
        0
      );
      await expect(dialog.getByText('새 채팅을 여는 중이에요…', { exact: true })).toBeVisible();
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`quick-chat-loading-${greetings}.png`) });
      const admitted = page.waitForResponse(
        (response) => /\/api\/chats$/.test(response.url()) && response.request().method() === 'POST'
      );
      release();
      const response = await admitted;
      expect(response.ok()).toBe(true);
      const chat = (await response.json()) as Chat;
      await expect(dialog).toBeHidden();
      const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
      expect(detail.profile!.packageAttachments).toEqual([
        { id: bot.id, revision: bot.revision, role: 'bot' },
        { id: persona.id, revision: persona.revision, role: 'persona' },
      ]);
      expect(detail.profile!.routes.main).toEqual({ id: model.id });
      await expect(page.getByTestId('source-text')).toContainText(`안녕하세요 ${persona.title}.`);
      expect(admissions).toHaveLength(1);
      expect(executions).toEqual([]);
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`quick-chat-open-${greetings}.png`) });
    } finally {
      release();
    }
  });
}
