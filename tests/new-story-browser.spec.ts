import { visualReview } from './fixtures/visual-review.js';
import { test, expect } from '@playwright/test';
import type { Chat, ChatDetail } from '../core/types.js';
import type { Connection, Content, Library, ModelPreset } from '../core/product.js';
import { navigationAction } from './ui-navigation.js';

test('NSUI01 a sole usable model reaches an empty chat on mobile and optional choices survive collapsing', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `Quick start ${crypto.randomUUID()}`;
  const savedBot = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: 'Synthetic quick-start fixture.',
      text: 'A synthetic harbor guide.',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(savedBot.ok()).toBe(true);
  const bot = (await savedBot.json()) as Content;
  const savedConnection = await request.post('/api/connections', {
    data: {
      title: `${title} connection`,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/no-provider',
      enabled: true,
    },
  });
  expect(savedConnection.ok()).toBe(true);
  const connection = (await savedConnection.json()) as Connection;
  const savedModel = await request.post('/api/model-presets', {
    data: {
      title: '합성 본문 모델',
      connectionId: connection.id,
      modelId: 'synthetic-quick-start',
      maxOutputTokens: 1000,
      temperature: null,
    },
  });
  expect(savedModel.ok()).toBe(true);
  const model = (await savedModel.json()) as ModelPreset;
  // Other suites may already have saved models; this page deliberately sees one usable choice.
  await page.route(/\/api\/library(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const current = (await response.json()) as Library;
    await route.fulfill({
      response,
      json: {
        ...current,
        models: current.models.filter((item) => item.id === model.id),
        connections: current.connections.filter((item) => item.id === connection.id),
      },
    });
  });
  const executionRequests: string[] = [];
  page.on('request', (item) => {
    if (
      item.method() === 'POST' &&
      /\/(?:runs|candidate|translation|package-start)$/.test(item.url())
    )
      executionRequests.push(item.url());
  });
  await page.goto('/');
  await navigationAction(page, '새 채팅', bot.title);
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  const options = dialog.locator('.new-story-options');
  await expect(dialog.getByLabel('시작 본문 모델', { exact: true })).toHaveValue(model.id);
  await expect(dialog.getByText('사용 가능한 모델이 하나여서 미리 선택했어요.')).toBeVisible();
  await expect(options).not.toHaveAttribute('open');
  await expect(dialog.getByLabel('시작 번역 모델', { exact: true })).not.toBeVisible();
  await expect(dialog.getByLabel('새 채팅 이름', { exact: true })).not.toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '시작 페르소나', exact: true })
  ).not.toBeVisible();
  const create = dialog.getByRole('button', { name: '채팅 만들기', exact: true });
  await expect(create).toBeEnabled();
  const bounds = await create.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview) await page.screenshot({ path: info.outputPath('new-story-simple-mobile.png') });
  const created = page.waitForResponse(
    (response) => /\/api\/chats$/.test(response.url()) && response.request().method() === 'POST'
  );
  await create.click();
  const chat = (await (await created).json()) as Chat;
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeVisible();
  const detailResponse = await request.get(`/api/chats/${chat.id}`);
  expect(detailResponse.ok()).toBe(true);
  const detail = (await detailResponse.json()) as ChatDetail;
  expect(detail.chat.title).toBe(`${bot.title}의 채팅`);
  expect(detail.profile!.routes.main).toEqual({ id: model.id });
  expect(detail.profile!.routes.translation).toBeNull();
  expect(detail.runs).toHaveLength(0);
  expect(detail.attempts).toHaveLength(0);

  await navigationAction(page, '새 채팅', bot.title);
  await expect(dialog.getByLabel('시작 본문 모델', { exact: true })).toHaveValue(model.id);
  await expect(dialog.getByText('최근 새 채팅에서 선택한 모델이에요.')).toBeVisible();
  await options.locator('summary').click();
  const customTitle = '추가 설정에 남긴 합성 제목';
  await dialog.getByLabel('새 채팅 이름', { exact: true }).fill(customTitle);
  await dialog.getByLabel('시작 본문 모델', { exact: true }).selectOption('');
  await options.locator('summary').click();
  await expect(dialog.getByLabel('새 채팅 이름', { exact: true })).not.toBeVisible();
  await expect(dialog.getByLabel('시작 본문 모델', { exact: true })).toHaveValue('');
  await options.locator('summary').click();
  await expect(dialog.getByLabel('새 채팅 이름', { exact: true })).toHaveValue(customTitle);
  await expect(dialog.getByLabel('시작 번역 모델', { exact: true })).toHaveValue('');
  expect(executionRequests).toEqual([]);
});
