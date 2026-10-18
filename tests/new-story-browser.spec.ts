import {
  MOBILE_WIDTH,
  MOBILE_HEIGHT,
  DESKTOP_WIDTH,
  DESKTOP_HEIGHT,
} from './fixtures/browser-viewports.js';
import { setCurrentModels } from './ui-navigation.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { visualReview } from './fixtures/visual-review.js';
import { nativeContent } from './fixtures/native-content.js';
import { test, expect } from '@playwright/test';
import type { Chat, ChatDetail, ReaderDetail } from '../core/types.js';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import { navigationAction } from './ui-navigation.js';
import { visibleNavigation } from './ui-navigation.js';

test('NSUI08 bot default persona is saved from its menu and explicit none wins when creating a chat', async ({
  page,
  request,
}) => {
  const make = async (kind: 'bot' | 'persona') => {
    const response = await request.post('/api/content', {
      data: {
        kind,
        title: `${kind} defaults ${crypto.randomUUID()}`,
        description: '',
        text: 'Synthetic',
        loading: 'pinned',
        relatedIds: [],
      },
    });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<Content>;
  };
  const bot = await make('bot'),
    persona = await make('persona');
  await page.goto('/');
  const nav = await visibleNavigation(page);
  const section = nav.getByRole('button', { name: '봇', exact: true });
  if ((await section.getAttribute('aria-expanded')) === 'false') await section.click();
  const branch = nav.locator(`[data-bot-id="${bot.id}"]`);
  await branch.hover();
  await branch.getByLabel(`${bot.title} 관리`, { exact: true }).click();
  await branch.getByRole('button', { name: '기본 페르소나', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '봇 기본 페르소나', exact: true });
  await settings.getByLabel('봇 기본 페르소나 방식').selectOption('persona');
  await settings.getByRole('button', { name: '봇의 기본 페르소나 선택', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '봇의 기본 페르소나 선택', exact: true });
  await picker.getByRole('searchbox').fill(persona.title);
  await picker
    .getByRole('button')
    .filter({ has: page.getByText(persona.title, { exact: true }) })
    .click();
  await settings.getByRole('button', { name: '기본 페르소나 저장', exact: true }).click();
  await expect(settings).toBeHidden();
  expect(await (await request.get(`/api/bots/${bot.id}/defaults`)).json()).toMatchObject({
    persona: { mode: 'persona', persona: { id: persona.id } },
  });
  await branch.hover();
  await branch.getByRole('button', { name: `${bot.title} 새 채팅`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await expect(dialog.getByRole('button', { name: '시작 페르소나', exact: true })).toContainText(
    persona.title
  );
  await dialog.getByRole('button', { name: '시작 페르소나', exact: true }).click();
  const choice = page.getByRole('dialog', { name: '시작 페르소나', exact: true });
  await choice.getByRole('button', { name: '페르소나 없음', exact: true }).click();
  const created = page.waitForResponse(
    (response) => /\/api\/chats$/.test(response.url()) && response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const chat = (await response.json()) as Chat;
  await expect(dialog).toBeHidden();
  const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  expect(detail.profile!.packageAttachments).toEqual([
    { id: bot.id, revision: bot.revision, role: 'bot' },
  ]);
});

test('NSUI09 a deleted default discovered after library refresh requires an explicit persona choice', async ({
  page,
  request,
}) => {
  const make = async (kind: 'bot' | 'persona') => {
    const response = await request.post('/api/content', {
      data: {
        kind,
        title: `${kind} refresh ${crypto.randomUUID()}`,
        description: '',
        text: 'Synthetic',
        loading: 'pinned',
        relatedIds: [],
      },
    });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<Content>;
  };
  const bot = await make('bot'),
    persona = await make('persona');
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
  await page.goto('/');
  await navigationAction(page, '새 채팅', bot.title);
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  const submit = dialog.getByRole('button', { name: '채팅 만들기', exact: true });
  await expect(dialog.getByRole('button', { name: '시작 페르소나', exact: true })).toContainText(
    persona.title
  );
  await expect(submit).toBeEnabled();
  expect(
    (
      await request.delete(`/api/content/${persona.id}`, {
        data: { expectedRevision: persona.revision },
      })
    ).ok()
  ).toBe(true);
  // APIRequestContext does not notify the page; focus uses the actual library refresh path.
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith(`/api/bots/${bot.id}/defaults`)
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(dialog.getByRole('alert')).toContainText('기본 페르소나가 삭제됐어요');
  await expect(dialog.getByText('시작 자료를 불러오는 중이에요…', { exact: true })).toBeHidden();
  await expect(submit).toBeDisabled();

  await dialog.getByRole('button', { name: '시작 페르소나', exact: true }).click();
  await page
    .getByRole('dialog', { name: '시작 페르소나', exact: true })
    .getByRole('button', { name: '페르소나 없음', exact: true })
    .click();
  await expect(submit).toBeEnabled();
  const created = page.waitForResponse(
    (response) => /\/api\/chats$/.test(response.url()) && response.request().method() === 'POST'
  );
  await submit.click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const chat = (await response.json()) as Chat;
  await expect(dialog).toBeHidden();
  const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  expect(detail.profile!.packageAttachments).toEqual([
    { id: bot.id, revision: bot.revision, role: 'bot' },
  ]);
});

for (const [viewportName, viewport] of [
  ['mobile', { width: MOBILE_WIDTH, height: MOBILE_HEIGHT }],
  ['desktop', { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT }],
] as const) {
  test(`NSUI01 ${viewportName} creation retains title and persona, then opens a native authored greeting without generation`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
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
    await navigationAction(page, '새 채팅', bot.title);
    const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
    await expect(dialog.getByLabel('첫 메시지 선택')).toHaveValue('start-0');
    await expect(dialog.getByRole('button', { name: '채팅 만들기', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(dialog.locator('.risu-message-surface')).toHaveCount(0);
    await expect(dialog.getByText('Harbor greets', { exact: false })).toHaveCount(0);
    await expect(dialog.getByText('미리보기', { exact: true })).toBeVisible();
    const centered = async () => {
      const box = (await dialog.boundingBox())!;
      const size = page.viewportSize()!;
      const gap = viewportName === 'mobile' ? 16 : 24;
      expect(box.x).toBeGreaterThanOrEqual(gap);
      expect(box.y).toBeGreaterThanOrEqual(gap);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width - gap);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height - gap);
      expect(Math.abs(box.x + box.width / 2 - size.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.y + box.height / 2 - size.height / 2)).toBeLessThanOrEqual(1);
    };
    await centered();
    if (viewportName === 'desktop') expect((await dialog.boundingBox())!.width).toBe(680);
    await dialog.getByLabel('첫 메시지 선택').selectOption('');
    await expect(dialog.getByRole('button', { name: '전역 모델 설정', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('시작 본문 모델', { exact: true })).toHaveCount(0);
    const options = dialog.locator('.new-story-options');
    await expect(options).not.toHaveAttribute('open');
    await options.locator('summary').click();
    await expect(dialog.getByRole('button', { name: '채팅 만들기', exact: true })).toBeInViewport({
      ratio: 1,
    });
    if (viewportName === 'mobile') {
      await page.setViewportSize({ width: viewport.width, height: 480 });
      await centered();
      const header = dialog.locator(':scope > .dialog-header');
      const submit = dialog.getByRole('button', { name: '채팅 만들기', exact: true });
      const fields = dialog.locator('.new-story-fields');
      const headerBox = (await header.boundingBox())!;
      const submitBox = (await submit.boundingBox())!;
      const closeBox = (await dialog
        .getByRole('button', { name: '새 채팅 닫기', exact: true })
        .boundingBox())!;
      expect(submitBox.height).toBeGreaterThanOrEqual(44);
      expect(closeBox.width).toBeGreaterThanOrEqual(44);
      expect(closeBox.height).toBeGreaterThanOrEqual(44);
      await fields.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      expect(await fields.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      expect((await header.boundingBox())!.y).toBe(headerBox.y);
      expect((await submit.boundingBox())!.y).toBe(submitBox.y);
      await expect(submit).toBeInViewport({ ratio: 1 });
      if (visualReview)
        await page.screenshot({ path: info.outputPath('new-story-centered-mobile-short.png') });
      await page.setViewportSize(viewport);
      await centered();
    }
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
    await navigationAction(page, '새 채팅', bot.title);
    await dialog.getByRole('button', { name: '시작 페르소나', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '시작 페르소나', exact: true });
    await picker.getByRole('searchbox').fill(personaTitle);
    const personaChoice = picker
      .getByRole('button')
      .filter({ has: page.getByText(personaTitle, { exact: true }) });
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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
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
    if (viewportName === 'desktop') expect((await scenes.boundingBox())!.width).toBe(640);
    expect(
      await scenes.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`scene-list-opening-${viewportName}.png`) });
    await firstMessage.click();
    await expect(scenes).toBeHidden();
  });
}

preservePromptWorkspace();

for (const width of [412, 1440]) {
  test(`AUDIT2 bot default persona recovers an initial read and retains a rejected save ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post('/api/content', {
      data: {
        kind: 'bot',
        title: `AUDIT2 defaults ${width} ${crypto.randomUUID()}`,
        description: '',
        text: 'Synthetic default-persona recovery fixture.',
        loading: 'pinned',
        relatedIds: [],
      },
    });
    expect(created.ok()).toBe(true);
    const bot = (await created.json()) as Content;
    let failRead = true;
    let failSave = true;
    await page.route(`**/api/bots/${bot.id}/defaults`, async (route) => {
      if (route.request().method() === 'GET' && failRead) {
        failRead = false;
        await route.fulfill({ status: 503, json: { error: 'AUDIT2_DEFAULT_READ_FAILED' } });
      } else if (route.request().method() === 'PATCH' && failSave) {
        failSave = false;
        await route.fulfill({ status: 409, json: { error: 'AUDIT2_DEFAULT_SAVE_REJECTED' } });
      } else await route.continue();
    });
    await page.goto('/');
    const nav = await visibleNavigation(page);
    const section = nav.getByRole('button', { name: '봇', exact: true });
    if ((await section.getAttribute('aria-expanded')) === 'false') await section.click();
    const branch = nav.locator(`[data-bot-id="${bot.id}"]`);
    await branch.hover();
    await branch.getByLabel(`${bot.title} 관리`, { exact: true }).click();
    await branch.getByRole('button', { name: '기본 페르소나', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '봇 기본 페르소나', exact: true });
    await expect(settings.getByRole('alert')).toContainText('503');
    if (visualReview)
      await page.screenshot({
        path: info.outputPath(`audit2-default-persona-read-failed-${width}.png`),
      });
    await settings.getByRole('button', { name: '다시 불러오기', exact: true }).click();
    const mode = settings.getByLabel('봇 기본 페르소나 방식', { exact: true });
    await expect(mode).toBeEnabled();
    await mode.selectOption('none');
    await settings.getByRole('button', { name: '기본 페르소나 저장', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('409');
    await expect(mode).toHaveValue('none');
    if (visualReview)
      await page.screenshot({
        path: info.outputPath(`audit2-default-persona-save-rejected-${width}.png`),
      });
    await settings.getByRole('button', { name: '기본 페르소나 저장', exact: true }).click();
    await expect(settings).toBeHidden();
    expect(await (await request.get(`/api/bots/${bot.id}/defaults`)).json()).toMatchObject({
      persona: { mode: 'none' },
    });
  });

  test(`AUDIT2 new chat distinguishes workspace read failure and preserves choices on retry ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const botTitle = `AUDIT2 workspace ${width} ${crypto.randomUUID()}`;
    const created = await request.post('/api/content', {
      data: {
        kind: 'bot',
        title: botTitle,
        description: '',
        text: 'Synthetic workspace recovery fixture.',
        loading: 'pinned',
        relatedIds: [],
        package: nativeContent({ name: botTitle, first_mes: 'Synthetic first message.' }),
      },
    });
    expect(created.ok()).toBe(true);
    const bot = (await created.json()) as Content;
    let failRead = true;
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    await page.goto('/');
    await page.route('**/api/prompt-workspace', async (route) => {
      if (route.request().method() !== 'GET' || !failRead) return route.continue();
      failRead = false;
      readStarted();
      await heldRead;
      await route.fulfill({ status: 503, json: { error: 'AUDIT2_WORKSPACE_READ_FAILED' } });
    });
    try {
      await navigationAction(page, '새 채팅', bot.title);
      const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
      await reading;
      await dialog.getByRole('button', { name: '시작 페르소나', exact: true }).click();
      await page
        .getByRole('dialog', { name: '시작 페르소나', exact: true })
        .getByRole('button', { name: '페르소나 없음', exact: true })
        .click();
      const options = dialog.locator('.new-story-options');
      await options.locator('summary').click();
      const title = dialog.getByLabel('새 채팅 제목', { exact: true });
      const draft = `입력 유지 ${width}`;
      await title.fill(draft);
      await dialog.getByLabel('첫 메시지 선택', { exact: true }).selectOption('');
      const failed = page.waitForResponse(
        (response) => response.url().endsWith('/api/prompt-workspace') && response.status() === 503
      );
      releaseRead();
      await failed;
      const settings = dialog.getByLabel('새 채팅에 사용할 전역 설정', { exact: true });
      if (visualReview)
        await page.screenshot({
          path: info.outputPath(`audit2-new-chat-workspace-failed-${width}.png`),
        });
      await expect(settings.getByRole('alert')).toContainText('503');
      await expect(settings).not.toContainText('확인 중…');
      await expect(settings).not.toContainText('본문 생성 전에 사용 가능한');
      await settings.getByRole('button', { name: '다시 불러오기', exact: true }).click();
      await expect(settings.locator('.new-story-settings-summary')).toBeVisible();
      await expect(settings.getByRole('alert')).toHaveCount(0);
      await expect(title).toHaveValue(draft);
      await expect(
        dialog.getByRole('button', { name: '시작 페르소나', exact: true })
      ).toContainText('페르소나 없음');
      await expect(dialog.getByLabel('첫 메시지 선택', { exact: true })).toHaveValue('');
      await expect(dialog.getByRole('button', { name: '채팅 만들기', exact: true })).toBeEnabled();
      if (visualReview)
        await page.screenshot({
          path: info.outputPath(`audit2-new-chat-workspace-recovered-${width}.png`),
        });
    } finally {
      releaseRead();
    }
  });
}

test('NSUI02 native authoring preserves raw drafts and starts with the rendered default greeting', async ({
  page,
  request,
}, info) => {
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
  await page.getByRole('button', { name: `${title} 상세 보기`, exact: true }).click();
  await page
    .getByRole('region', { name: '자료 상세', exact: true })
    .getByRole('button', { name: '편집', exact: true })
    .first()
    .click();
  const library = page.getByTestId('library-panel');
  await expect(library.getByLabel('Risu 자료 이름')).toHaveValue(title);
  await expect(library.getByTestId('package-fields')).toHaveCount(0);
  await library.getByRole('tab', { name: '첫 메시지', exact: true }).click();
  await library.getByLabel('기본 시작문', { exact: true }).fill('<selector> Edited');
  await library.getByRole('tab', { name: '고급 설정', exact: true }).click();
  await library.getByRole('button', { name: '원문', exact: true }).click();
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
  await expect(frame.getByRole('button', { name: `${title} route`, exact: true })).toBeVisible();
  await expect(frame.locator('.risu-message-content')).toHaveAttribute(
    'data-risu-disabled',
    'true'
  );
  await expect(frame.getByRole('button', { name: `${title} route`, exact: true })).toHaveCSS(
    'pointer-events',
    'none'
  );
  await expect(frame.locator('.risu-message-content')).toContainText('Edited');
  await page.screenshot({ path: info.outputPath('native-default-preview.png') });
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
}, info) => {
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
  // The browser harness supplies its deterministic writer when no provider is selected.
  await setCurrentModels(request, { main: null, translation: null });
  const mainRequests: string[] = [];
  page.on('request', (item) => {
    if (item.method() === 'POST' && /\/(?:runs|candidate)$/.test(item.url()))
      mainRequests.push(item.url());
  });
  await page.goto('/');
  await navigationAction(page, '새 채팅', bot.title);
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
  await expect(source).not.toContainText('실행과 실제 입력 확인');
  const draft = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await draft.fill('시작문을 바꿔도 남겨 둘 다음 장면 초안');
  await source.getByLabel('장면 작업 메뉴', { exact: true }).click();
  await source.getByRole('button', { name: '시작문 바꾸기', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '시작문 바꾸기', exact: true });
  await expect(picker.getByLabel('첫 메시지 선택')).toHaveValue('start-0');
  await picker.getByLabel('첫 메시지 선택').selectOption('start-1');
  await picker.getByText('미리보기', { exact: true }).click();
  await expect(picker.getByRole('heading', { name: '새벽의 정원' })).toBeVisible();
  for (const viewport of [
    { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
    { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
  ]) {
    await page.setViewportSize(viewport);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
      await expect(
        picker.getByRole('button', { name: '시작문 바꾸기', exact: true })
      ).toBeInViewport({
        ratio: 1,
      });
      expect(
        await picker.evaluate((node) => node.scrollWidth - node.clientWidth)
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: info.outputPath(`opening-picker-${viewport.width}-${colorScheme}.png`),
      });
    }
  }
  const changed = page.waitForResponse(
    (response) => /\/package-start$/.test(response.url()) && response.request().method() === 'POST'
  );
  await picker.getByRole('button', { name: '시작문 바꾸기', exact: true }).click();
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
  await page.screenshot({ path: info.outputPath('opening-switched-mobile-dark.png') });
  await page.reload();
  await expect(source.getByRole('heading', { name: '새벽의 정원' })).toBeVisible();
  await expect(draft).toHaveValue('시작문을 바꿔도 남겨 둘 다음 장면 초안');
  await expect(source.getByTestId('turn-activity')).toHaveCount(0);
  await source.getByLabel('장면 작업 메뉴', { exact: true }).click();
  await source.getByRole('button', { name: '시작문 바꾸기', exact: true }).click();
  await expect(picker.getByLabel('첫 메시지 선택')).toHaveValue('start-1');
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(source.getByLabel('장면 작업 메뉴', { exact: true })).toBeFocused();
  await source.getByLabel('장면 작업 메뉴', { exact: true }).click();
  await source.getByRole('button', { name: '번역 수정', exact: true }).click();
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
  await expect(activity).not.toContainText('실행과 실제 입력 확인');
  expect((await read()).attempts).toHaveLength(0);
  expect(mainRequests).toEqual([]);
  await page.screenshot({ path: info.outputPath('opening-manual-translation-mobile-dark.png') });
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect.poll(async () => (await readActive()).reader.total).toBe(2);
  await source.getByLabel('장면 작업 메뉴', { exact: true }).click();
  await expect(source.getByRole('button', { name: '시작문 바꾸기', exact: true })).toHaveCount(0);
});
