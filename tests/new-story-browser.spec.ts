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
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
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
          version: 1,
          id: 'quick-start-template',
          revision: 1,
          title,
          description: '',
          body: '',
          lore: [],
          instructions: [],
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
    await expect(dialog.locator('iframe')).toHaveCount(0);
    await expect(dialog.locator('.new-story-opening-excerpt')).toContainText('Harbor greets');
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
    await picker
      .getByRole('button')
      .filter({ has: page.getByText(personaTitle, { exact: true }) })
      .click();
    await dialog.getByText('전체 미리보기', { exact: true }).click();
    const frame = dialog.frameLocator('iframe[title="봇 메시지"]');
    await expect(frame.locator('body')).toContainText(`Harbor greets ${personaTitle}.`);
    await expect(frame.locator('img')).toBeVisible();
    await dialog.getByLabel('첫 메시지 선택').selectOption('start-1');
    await expect(dialog.locator('iframe')).toHaveCount(0);
    await dialog.getByText('전체 미리보기', { exact: true }).click();
    await expect(frame.locator('body')).toContainText('Night watch begins.');
    await dialog.getByLabel('첫 메시지 선택').selectOption('start-0');
    await expect(dialog.locator('iframe')).toHaveCount(0);
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
    const reader = page.getByTestId('source-text').frameLocator('iframe[title="봇 메시지"]');
    await expect(reader.locator('body')).toContainText(`Harbor greets ${personaTitle}.`);
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
        version: 1,
        id: 'native-editor',
        revision: 1,
        title,
        description: '',
        body: '',
        lore: [],
        instructions: [],
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
  await expect(save).toBeDisabled();
  await expect
    .poll(async () => {
      const drafts = await (
        await request.get(`/api/edit-drafts?editorKey=content:${saved.id}`)
      ).json();
      return drafts[0]?.unappliedFields;
    })
    .toContain('package.native.source');
  await library
    .getByLabel('Risu 원문 JSON')
    .fill('[{"name":"New lore","content":"Lore {{char}}","constant":true,"custom":42}]');
  await library.getByRole('button', { name: 'JSON 적용', exact: true }).click();
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
  await dialog.getByText('전체 미리보기', { exact: true }).click();
  const frame = dialog.frameLocator('iframe[title="봇 메시지"]');
  await expect(frame.getByRole('button', { name: `${title} route`, exact: true })).toBeVisible();
  await expect(frame.locator('body')).toHaveAttribute('data-risu-disabled', 'true');
  await expect(frame.getByRole('button', { name: `${title} route`, exact: true })).toHaveCSS(
    'pointer-events',
    'none'
  );
  await expect(frame.locator('body')).toContainText('Edited');
  await page.screenshot({ path: info.outputPath('native-default-preview.png') });
  await dialog.getByLabel('첫 메시지 선택').selectOption('start-1');
  await expect(dialog.locator('iframe')).toHaveCount(0);
  await dialog.getByText('전체 미리보기', { exact: true }).click();
  await expect(dialog.getByLabel('첫 메시지 선택')).toHaveValue('start-1');
  await expect(dialog.frameLocator('iframe[title="봇 메시지"]').locator('body')).toContainText(
    'Other greeting'
  );
  await dialog.getByLabel('첫 메시지 선택').selectOption('');
  await expect(dialog.getByLabel('첫 메시지 선택')).toHaveValue('');
});
