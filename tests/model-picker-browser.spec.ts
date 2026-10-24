import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail } from '../core/types.js';
import type { ModelPreset, ModelWorkspace, PromptPreset } from '../core/product.js';
import { postFixtureChat } from './fixtures/chat.js';
import { nativePrompt } from './fixtures/native-prompt.js';

async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function prepare(page: Page, request: APIRequestContext, label: string) {
  const created = await postFixtureChat(request, { data: { title: label } });
  expect(created.ok()).toBe(true);
  const chat = (await created.json()) as Chat;
  const providerResponse = await request.post('/api/connections', {
    data: {
      title: `${label} 프로바이더`,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/not-called',
      enabled: true,
    },
  });
  expect(providerResponse.ok()).toBe(true);
  const provider = (await providerResponse.json()) as { id: string };
  const models: ModelPreset[] = [];
  for (const suffix of ['A', 'B']) {
    const response = await request.post('/api/model-presets', {
      data: {
        title: `${label} 모델 ${suffix}`,
        connectionId: provider.id,
        modelId: `picker-synthetic-${suffix}`,
        maxOutputTokens: 1000,
        temperature: null,
      },
    });
    expect(response.ok()).toBe(true);
    models.push((await response.json()) as ModelPreset);
  }
  const promptResponse = await request.post('/api/prompt-presets', {
    data: { title: `${label} 프롬프트`, role: 'main', program: nativePrompt() },
  });
  expect(promptResponse.ok()).toBe(true);
  const prompt = (await promptResponse.json()) as PromptPreset;
  const original = (await detail(request, chat.id)).profile!;
  const pinned = await request.put(`/api/chats/${chat.id}/profile`, {
    data: {
      expectedRevision: original.revision,
      image: original.image,
      pinned: { mainPromptPresetId: prompt.id },
      authorNote: '이 메모와 연결한 봇, 입력 초안을 보존해요.',
    },
  });
  expect(pinned.ok(), await pinned.text()).toBe(true);
  const before = await detail(request, chat.id);
  const global = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await expect(composer).toBeVisible();
  await composer.fill('모델을 바꿔도 이 집필 요청은 그대로 남아요.');
  const trigger = page.getByRole('button', { name: /^현재 본문 모델:/ });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '이 채팅의 본문 모델', exact: true });
  await expect(picker).toBeVisible();
  return { chat, models, before, global, composer, trigger, picker };
}

for (const width of [390, 1440]) {
  test(`MP01 ${width} model selection applies immediately to this chat and inheritance preserves prompt, profile and composer`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { chat, models, before, global, composer, trigger, picker } = await prepare(
      page,
      request,
      `MP01 ${width} ${Date.now()}`
    );
    const writes: string[] = [];
    page.on('request', (entry) => {
      if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(entry.method()))
        writes.push(`${entry.method()} ${new URL(entry.url()).pathname}`);
    });
    await picker.getByRole('searchbox', { name: '모델 검색' }).fill(models[1].title);
    await expect(picker.locator('[data-model-choice]')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath(`model-picker-${width}.png`) });
    expect(
      await picker.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    await picker.getByRole('button', { name: `${models[1].title} MP01`, exact: false }).click();
    await expect(picker).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(composer).toHaveValue('모델을 바꿔도 이 집필 요청은 그대로 남아요.');
    const selected = (await detail(request, chat.id)).profile!;
    expect(selected.pinned?.mainModel).toEqual({ id: models[1].id });
    expect(selected.pinned?.mainPromptPresetId).toBe(before.profile!.pinned?.mainPromptPresetId);
    expect(selected.authorNote).toBe(before.profile!.authorNote);
    expect(selected.packageAttachments).toEqual(before.profile!.packageAttachments);
    expect(selected.image).toBe(before.profile!.image);
    expect(selected.loreContext).toEqual(before.profile!.loreContext);
    expect(await (await request.get('/api/model-workspace')).json()).toEqual(global);
    expect(writes).toEqual([`PUT /api/chats/${chat.id}/profile`]);
    await trigger.click();
    const selectedChoice = picker.getByRole('button', { name: `${models[1].title} MP01` });
    await expect(selectedChoice).toHaveAttribute('aria-pressed', 'true');
    await expect(selectedChoice.locator('svg')).toHaveCount(1);
    await picker.getByRole('button', { name: /^기본값 사용/ }).click();
    await expect(picker).toBeHidden();
    const inherited = (await detail(request, chat.id)).profile!;
    expect(inherited.pinned?.mainModel).toBeUndefined();
    expect(inherited.pinned?.mainPromptPresetId).toBe(before.profile!.pinned?.mainPromptPresetId);
    expect(inherited.authorNote).toBe(before.profile!.authorNote);
    expect(inherited.packageAttachments).toEqual(before.profile!.packageAttachments);
    expect(await (await request.get('/api/model-workspace')).json()).toEqual(global);
    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(composer).toHaveValue('모델을 바꿔도 이 집필 요청은 그대로 남아요.');
  });
}

test('MP02 a rejected model save stays open without retrying and a lost response preserves the acknowledged server state', async ({
  page,
  request,
}) => {
  const { chat, models, before, picker, composer } = await prepare(
    page,
    request,
    `MP02 ${Date.now()}`
  );
  let writes = 0;
  const profileUrl = `**/api/chats/${chat.id}/profile`;
  await page.route(profileUrl, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes += 1;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Profile revision conflict' }),
    });
  });
  await picker.getByRole('button', { name: `${models[0].title} MP02` }).click();
  await expect(picker.getByRole('alert')).toBeVisible();
  await expect(picker).toBeVisible();
  expect(writes).toBe(1);
  expect((await detail(request, chat.id)).profile).toEqual(before.profile);
  await page.unroute(profileUrl);
  await page.route(profileUrl, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes += 1;
    const saved = await route.fetch();
    expect(saved.ok()).toBe(true);
    await route.abort('failed');
  });
  await picker.getByRole('button', { name: `${models[1].title} MP02` }).click();
  await expect(picker.getByRole('alert')).toContainText('모델 저장 응답을 받지 못했어요.');
  await expect(picker.getByRole('button', { name: `${models[1].title} MP02` })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(writes).toBe(2);
  const after = (await detail(request, chat.id)).profile!;
  expect(after.pinned?.mainModel?.id).toBe(models[1].id);
  expect(after.pinned?.mainPromptPresetId).toBe(before.profile!.pinned?.mainPromptPresetId);
  expect(after.authorNote).toBe(before.profile!.authorNote);
  await page.keyboard.press('Escape');
  await expect(composer).toHaveValue('모델을 바꿔도 이 집필 요청은 그대로 남아요.');
});

test('MP03 unavailable current models stay visible as a warning and search offers recovery and management', async ({
  page,
  request,
}) => {
  const { chat, models, trigger, picker } = await prepare(page, request, `MP03 ${Date.now()}`);
  await picker.getByRole('button', { name: `${models[0].title} MP03` }).click();
  await expect(picker).toBeHidden();
  const disabled = await request.put(`/api/model-presets/${models[0].id}`, {
    data: {
      title: models[0].title,
      connectionId: models[0].connectionId,
      modelId: models[0].modelId,
      maxOutputTokens: models[0].maxOutputTokens,
      temperature: models[0].temperature,
      expectedRevision: models[0].revision,
      enabled: false,
    },
  });
  expect(disabled.ok(), await disabled.text()).toBe(true);
  await page.goto(`/?chat=${chat.id}`);
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(picker.getByRole('status')).toContainText(`현재 모델 ${models[0].title}`);
  await expect(picker.getByRole('button', { name: `${models[0].title} MP03` })).toHaveCount(0);
  await picker.getByRole('searchbox').fill('일치하지 않는 모델 검색 ㅁㄴㅇㄹ');
  await expect(picker.getByText('검색 결과가 없어요.', { exact: true })).toBeVisible();
  await picker.getByRole('button', { name: '검색 지우기', exact: true }).click();
  await expect(picker.getByRole('searchbox')).toHaveValue('');
  await expect(picker.getByRole('button', { name: `${models[1].title} MP03` })).toBeVisible();
  await picker.getByRole('button', { name: '프로바이더와 모델 관리', exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole('dialog', { name: '설정', exact: true })).toBeVisible();
});
