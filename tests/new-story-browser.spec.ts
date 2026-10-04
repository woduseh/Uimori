import {
  MOBILE_WIDTH,
  MOBILE_HEIGHT,
  DESKTOP_WIDTH,
  DESKTOP_HEIGHT,
} from './fixtures/browser-viewports.js';
import { setCurrentModels } from './ui-navigation.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { visualReview } from './fixtures/visual-review.js';
import { test, expect } from '@playwright/test';
import type { Chat, ChatDetail } from '../core/types.js';
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
    await dialog.getByLabel('새 채팅 이름', { exact: true }).fill(customTitle);
    await options.locator('summary').click();
    await expect(dialog.getByLabel('새 채팅 이름', { exact: true })).not.toBeVisible();
    await options.locator('summary').click();
    await expect(dialog.getByLabel('새 채팅 이름', { exact: true })).toHaveValue(customTitle);
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
    await expect(personaChoice.locator('.content-picker-meta')).toHaveCount(0);
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
    await page
      .getByRole('navigation', { name: '장면 탐색', exact: true })
      .getByRole('button', { name: '장면 목록 열기', exact: true })
      .click();
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
