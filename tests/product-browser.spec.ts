import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { selectCurrentSettingsSection } from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import {
  selectSettingsSection,
  startProviderConnection,
  editLibraryContent,
  selectContent,
  createPromptChoice,
  navigationAction,
  visibleNavigation,
  openProviderMenu,
  selectChatSettingsSection,
  openSourceActions,
} from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Asset, Connection, Content, Library, ModelPreset } from '../core/product.js';

preservePromptWorkspace();

async function getDetail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function getLibrary(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function createChat(page: Page, title: string): Promise<Chat> {
  // The API fixture keeps this test focused on settings; UI03 covers bot-first creation.
  const response = await postFixtureChat(page.request, { data: { title } });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return chat;
}
async function closeDialog(page: Page) {
  if (await page.getByRole('dialog').filter({ visible: true }).count())
    await page.keyboard.press('Escape');
}
async function navigation(page: Page, name: string) {
  await navigationAction(page, name);
}
async function selectStoredChat(page: Page, chat: Chat) {
  const navigation = await visibleNavigation(page);
  const branch = navigation.locator(`[data-bot-id="${chat.botId}"]`);
  const toggle = branch.locator('.bot-branch-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await branch.locator(`[data-chat-id="${chat.id}"] .chat-link`).click();
}
async function storySettings(page: Page) {
  await closeDialog(page);
  if (!(await page.locator('.workspace-header .chat-menu').isVisible())) {
    const chatId = new URL(page.url()).searchParams.get('chat')!;
    const detail = await getDetail(page.request, chatId);
    await selectStoredChat(page, detail.chat);
  }
  await openChatSettings(page);
  return page.getByRole('dialog', { name: '채팅 설정', exact: true });
}
async function profileInfo(page: Page) {
  return page.getByTestId('profile-editor');
}
async function promptTab(page: Page) {
  await selectCurrentSettingsSection(page, '프롬프트·창작 프리셋');
  return page.getByRole('region', { name: '현재 프롬프트 설정' });
}
async function send(page: Page, text: string): Promise<Run> {
  await closeDialog(page);
  await page.getByLabel('다음 장면 요청').fill(text);
  const response = page.waitForResponse(
    (response) =>
      /\/api\/chats\/[^/]+\/runs$/.test(response.url()) && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  const created = await response;
  expect(created.ok()).toBeTruthy();
  return created.json();
}
async function openDetails(page: Page, testId: string) {
  if (testId === 'library-panel') {
    await navigation(page, '서재');
    return page.getByTestId(testId);
  }
  await storySettings(page);
  await selectChatSettingsSection(page, '봇·페르소나·모듈');
  return profileInfo(page);
}

test('P01 packages use latest settings and prompt-owned creative choices replace prior values', async ({
  page,
  request,
}) => {
  const unique = `P01-${Date.now()}`;
  const chat = await createChat(page, `합성 ${unique}`);
  const owner = { id: chat.botId, revision: 1, role: 'bot' };
  const firstBody = 'Mira is a synthetic harbor keeper. Her compass is brass.';
  const addedResponse = await request.post('/api/content', {
    data: {
      kind: 'module',
      title: `Mira ${unique}`,
      description: 'Synthetic harbor setting.',
      text: firstBody,
      loading: 'pinned',
      relatedIds: [],
      package: {
        version: 1,
        id: 'synthetic-harbor',
        revision: 1,
        title: `Mira ${unique}`,
        description: 'Synthetic harbor setting.',
        body: firstBody,
        lore: [],
        instructions: [],
        controls: [],
        transforms: [],
      },
    },
  });
  expect(addedResponse.ok()).toBeTruthy();
  const added = (await addedResponse.json()) as Content;
  const choice = await createPromptChoice(request, unique);
  const secondResponse = await request.post('/api/prompt-combinations', {
    data: {
      title: `Brief ${unique}`,
      role: 'main',
      owner: { kind: 'preset', id: choice.prompt.id },
      expectedRevision: choice.prompt.revision,
      values: { detail: 1, coNarration: false },
    },
  });
  expect(secondResponse.ok()).toBeTruthy();
  const second = await secondResponse.json();
  await page.reload();
  const profile = await openDetails(page, 'profile-editor');
  const chatSettings = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  const backToCategories = chatSettings.getByRole('button', {
    name: '채팅 설정 목록으로',
    exact: true,
  });
  if (await backToCategories.isVisible()) await backToCategories.click();
  await expect(
    chatSettings
      .locator('.section-navigation')
      .filter({ visible: true })
      .locator('button .section-navigation-title')
  ).toHaveText([
    '봇·페르소나·모듈',
    '프롬프트·창작 프리셋',
    '이 채팅의 모델',
    '상태와 문맥',
    '이미지',
    '자동 후속 작업',
  ]);
  await selectChatSettingsSection(page, '봇·페르소나·모듈');
  await selectContent(page, '추가할 패키지', added.title);
  await page.getByRole('button', { name: '패키지 장착', exact: true }).click();
  await page.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
  await expect
    .poll(async () => (await getDetail(request, chat.id)).profile?.packageAttachments)
    .toEqual([owner, { id: added.id, revision: 1, role: 'module' }]);
  await expect(profile.getByRole('status')).toContainText('채팅 설정을 저장했어요.');
  const library = await openDetails(page, 'library-panel');
  await library.getByRole('tab', { name: '모듈', exact: true }).click();
  await editLibraryContent(page, `Mira ${unique}`);
  await page
    .getByLabel('자료 본문', { exact: true })
    .fill('Mira is a synthetic harbor keeper. Her compass is silver in this revision.');
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await expect(library.locator('.library-savebar [role="status"]')).toContainText(
    '저장됨 · 다음 실행부터 사용해요.'
  );
  // The library has its own URL, so return through the chat navigation before its settings.
  await selectStoredChat(page, chat);
  await expect(page.getByRole('textbox', { name: '다음 장면 요청', exact: true })).toBeVisible();
  await openDetails(page, 'profile-editor');
  await expect(
    profile
      .locator('.package-attachment')
      .filter({ has: page.getByRole('heading', { name: added.title, exact: true }) })
  ).not.toContainText('v1');
  const editor = await promptTab(page);
  await editor.getByLabel('현재 프롬프트 프리셋', { exact: true }).selectOption(choice.prompt.id);
  await editor.getByText('창작 옵션', { exact: true }).click();
  const composer = editor;
  for (const combination of [choice.combination, second]) {
    await composer.getByLabel('옵션 조합', { exact: true }).selectOption(combination.id);
    await expect
      .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.values)
      .toEqual(combination.values);
    await expect(editor.getByText('변경사항을 자동 저장했어요.', { exact: true })).toBeVisible();
  }
  await expect(
    composer.getByRole('switch', { name: '합성 공동 서술', exact: true })
  ).not.toBeChecked();
  await expect(composer.getByLabel('합성 상세도', { exact: true })).toHaveValue('1');
  await expect(editor.getByLabel('현재 프롬프트 프리셋', { exact: true })).toBeEnabled();
  const run = await send(page, '(OOC: Continue the harbor scene.) SYNTHETIC_P01');
  await expect
    .poll(
      async () =>
        (await getDetail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  const saved = (await getDetail(request, chat.id)).runs.find((item) => item.id === run.id)!;
  expect(saved.snapshot.profile?.packages?.find((pkg) => pkg.id === added.id)?.body).toBe(
    'Mira is a synthetic harbor keeper. Her compass is silver in this revision.'
  );
  expect(saved.snapshot.profile?.packageAttachments).toEqual([
    owner,
    { id: added.id, revision: 2, role: 'module' },
  ]);
  expect(saved.snapshot.profile?.promptPresets?.main?.values).toEqual({
    detail: 1,
    coNarration: false,
  });
  expect(saved.snapshot.promptCompilation?.values).toEqual({ detail: 1, coNarration: false });
  expect(saved.inputs[0].task).toBe('(OOC: Continue the harbor scene.) SYNTHETIC_P01');
});

test('P04 manual model IDs and distinct main/translation routing preserve connection authority after catalog failure', async ({
  page,
  request,
}) => {
  const unique = `P04-${Date.now()}`;
  const chat = await createChat(page, `합성 ${unique}`);
  await navigation(page, '설정');
  await selectSettingsSection(page, '프로바이더·모델 등록');
  const library = page.getByTestId('connection-editor');
  await startProviderConnection(page);
  await library.getByText('개발·검사용 프로바이더', { exact: true }).click();
  await library.getByRole('button', { name: '로컬 fixture로 설정', exact: true }).click();
  await page.getByLabel('프로바이더 이름', { exact: true }).fill(`격리 연결 ${unique}`);
  await page.getByLabel('로컬 endpoint').fill('http://127.0.0.1:9/turn');
  await page.getByLabel('서버 환경변수 이름').fill('NARRATIVE_PROVIDER_SYNTHETIC');
  const connectionResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/connections') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  const connection = (await (await connectionResponse).json()) as Connection;
  expect(connection.enabled).toBe(false);
  const modelRefs: ModelPreset[] = [];
  for (const role of ['main', 'translation']) {
    await library.getByRole('button', { name: '모델 프리셋', exact: true }).click();
    await library.getByRole('button', { name: '새 모델 입력', exact: true }).click();
    await page.getByLabel('모델 프리셋 이름', { exact: true }).fill(`${role} ${unique}`);
    await page.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
    await page.getByLabel('모델 ID', { exact: true }).fill(`synthetic-${role}-unlisted`);
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/model-presets') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
    modelRefs.push((await (await response).json()) as ModelPreset);
  }
  await library.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  const connectionCard = library.getByRole('article', {
    name: `${connection.title} 프로바이더`,
    exact: true,
  });
  await openProviderMenu(page, '프로바이더', connection.title);
  await connectionCard
    .getByRole('button', { name: `${connection.title} 모델 목록 새로고침`, exact: true })
    .click();
  await expect(connectionCard).toContainText('모델 목록 조회 실패');
  const after = (await getLibrary(request)).connections.find((item) => item.id === connection.id)!;
  expect(after).toMatchObject({
    endpoint: connection.endpoint,
    enabled: false,
    credentialEnv: 'NARRATIVE_PROVIDER_SYNTHETIC',
  });
  expect((await request.get(`/api/revisions/connection/${connection.id}/1`)).ok()).toBe(false);
  await openDetails(page, 'profile-editor');
  await selectCurrentSettingsSection(page, '모델');
  // A model saved against a disabled connection is excluded from a new role selection.
  for (const roleLabel of ['원문 모델', '번역 모델'])
    for (const model of modelRefs) {
      await expect(
        page.getByLabel(roleLabel, { exact: true }).locator(`option[value="${model.id}"]`)
      ).toHaveCount(0);
    }
  expect((await getDetail(request, chat.id)).profile!.routes).toMatchObject({
    main: null,
    translation: null,
  });
  await navigation(page, '설정');
  await selectSettingsSection(page, '프로바이더·모델 등록');
  await library.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  const enabledResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/connections/${connection.id}`) &&
      response.request().method() === 'PUT'
  );
  await openProviderMenu(page, '프로바이더', connection.title);
  await library
    .getByRole('button', { name: `${connection.title} 프로바이더 활성화`, exact: true })
    .click();
  const enabledReply = await enabledResponse;
  expect(enabledReply.ok()).toBe(true);
  const enabled = (await enabledReply.json()) as Connection;
  expect(enabled).toMatchObject({
    id: connection.id,
    endpoint: connection.endpoint,
    enabled: true,
    credentialEnv: connection.credentialEnv,
  });
  // Activating the current connection makes its existing model IDs selectable immediately.
  const activatedModels = (await getLibrary(request)).models;
  for (const model of modelRefs)
    expect(activatedModels.find((item) => item.id === model.id)).toEqual(model);
  await openDetails(page, 'profile-editor');
  await selectCurrentSettingsSection(page, '모델');
  await page.getByLabel('원문 모델', { exact: true }).selectOption(`${modelRefs[0].id}`);
  await page.getByLabel('번역 모델', { exact: true }).selectOption(`${modelRefs[1].id}`);
  await page.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/model-workspace')).json()).routes.main)
    .toEqual({ id: modelRefs[0].id });
  const profile = (await getDetail(request, chat.id)).profile!;
  expect(profile.routes.main).toEqual({ id: modelRefs[0].id });
  expect(profile.routes.translation).toEqual({ id: modelRefs[1].id });
  const unchanged = await getDetail(request, chat.id);
  expect(unchanged.runs).toHaveLength(0);
  expect(unchanged.sources).toHaveLength(0);
  expect(unchanged.attempts).toHaveLength(0);
  expect(
    await page.evaluate(() =>
      Object.values(localStorage)
        .concat(Object.values(sessionStorage))
        .some((value) => String(value).includes('NARRATIVE_PROVIDER_SYNTHETIC'))
    )
  ).toBe(false);
});

test('P09 P10 P13 fork from a completed scene preserves long prose and annotations with independent settings tabs and descendants', async ({
  page,
  context,
  request,
}, testInfo) => {
  const initial = await createChat(page, `합성 P09-${Date.now()}`);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const settingsResponse = await request.patch(`/api/chats/${initial.id}/settings`, {
    data: {
      expectedSettingsRevision: initial.settingsRevision,
      ...initial.settings,
      status: true,
    },
  });
  expect(settingsResponse.ok(), await settingsResponse.text()).toBe(true);
  const chat = (await settingsResponse.json()) as Chat;
  await page.reload();
  await storySettings(page);
  await selectChatSettingsSection(page, '이미지');
  const imagePanel = page.getByRole('region', { name: '이 이야기의 이미지', exact: true });
  await expect(imagePanel.getByLabel('PNG 또는 JPEG 이미지', { exact: true })).toBeVisible();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9n8AAAAASUVORK5CYII=',
    'base64'
  );
  await page
    .getByLabel('PNG 또는 JPEG 이미지')
    .setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
  await page.getByLabel('이미지 이름', { exact: true }).fill('Synthetic harbor pixel');
  await page
    .getByLabel('이미지 설명', { exact: true })
    .fill('Synthetic test pixel representing the harbor.');
  await page.getByLabel('이미지 장소', { exact: true }).fill('pier');
  const upload = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chats/${chat.id}/assets`) &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '이미지 등록', exact: true }).click();
  const uploaded = (await (await upload).json()) as Asset;
  await expect(imagePanel.getByRole('status')).toContainText('이미지를 등록했어요');
  expect(uploaded.hash).toBe(createHash('sha256').update(png).digest('hex'));
  const endpoint = process.env.NR_PROVIDER_FIXTURE_URL;
  if (!endpoint) throw new Error('Dedicated image-selection loopback fixture is required');
  const connectionReply = await request.post('/api/connections', {
    data: {
      title: `P09 image ${chat.id}`,
      protocol: 'fixture-sse-v1',
      endpoint: new URL('presentation', endpoint).href,
      enabled: true,
    },
  });
  expect(connectionReply.ok(), await connectionReply.text()).toBeTruthy();
  const connection = (await connectionReply.json()) as Connection;
  const modelReply = await request.post('/api/model-presets', {
    data: {
      title: `P09 image ${chat.id}`,
      connectionId: connection.id,
      modelId: 'synthetic-image-selector',
      maxOutputTokens: 512,
      temperature: null,
    },
  });
  expect(modelReply.ok(), await modelReply.text()).toBeTruthy();
  const imageModel = (await modelReply.json()) as ModelPreset;
  await page.reload();
  await openDetails(page, 'profile-editor');
  await selectCurrentSettingsSection(page, '모델');
  await page.locator('summary').filter({ hasText: '기타 자동 작업 모델' }).click();
  await page.getByLabel('이미지 배치 모델', { exact: true }).selectOption(imageModel.id);
  await page.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/model-workspace')).json()).routes.image)
    .toEqual({ id: imageModel.id });
  await expect(
    page.getByRole('region', { name: '역할별 모델 설정', exact: true }).getByRole('status')
  ).toContainText('역할별 모델 설정을 저장했어요.');
  await openDetails(page, 'profile-editor');
  await selectChatSettingsSection(page, '봇·페르소나·모듈');
  await page.getByLabel('원문 이미지 자동 배치', { exact: true }).check();
  await page.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
  await expect.poll(async () => (await getDetail(request, chat.id)).profile?.revision).toBe(2);
  // Close only after the panel has acknowledged the write; an in-flight save is still protected.
  await expect(page.getByTestId('profile-editor').getByRole('status')).toContainText(
    '채팅 설정을 저장했어요.'
  );
  const first = await send(
    page,
    'SYNTHETIC_FORK: Mira waits at the pier.\n\n' +
      'The harbor bell is silent, the letter is sealed, and the traveler chooses their own next action.\n\n'.repeat(
        24
      )
  );
  await expect
    .poll(
      async () =>
        (await getDetail(request, chat.id)).runs.find((run) => run.id === first.id)?.status
    )
    .toBe('completed');
  await page.getByRole('button', { name: '번역 보기', exact: true }).click();
  await expect.poll(async () => (await getDetail(request, chat.id)).jobs.length).toBe(4);
  await expect
    .poll(async () =>
      (await getDetail(request, chat.id)).jobs.every((job) => job.status === 'completed')
    )
    .toBe(true);
  const firstDetail = await getDetail(request, chat.id);
  const source = firstDetail.sources[0];
  expect(
    firstDetail.jobs.find((job) => job.kind === 'image' && job.imageTarget?.mode === 'original')!
      .result
  ).toMatchObject({
    mock: true,
    sourceRevision: source.id,
    sourceHash: source.hash,
    annotations: [
      {
        blockAnchor: source.blocks![0].anchor,
        assetRef: uploaded.id,
        assetRevision: uploaded.revision,
        assetHash: uploaded.hash,
        presentationIntent: 'inline',
      },
    ],
  });
  expect(source.text.length).toBeGreaterThan(2000);
  await expect(page.getByTestId('profile-asset')).toBeVisible();
  await page.getByRole('button', { name: '원문 보기', exact: true }).click();
  await expect(page.getByTestId('inline-annotation').first()).toBeVisible();
  const anchors = await page
    .getByTestId('source-text')
    .locator('[data-block-anchor]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-block-anchor'))
    );
  expect(anchors).toEqual(source.blocks!.map((block) => block.anchor));
  await page.getByRole('button', { name: '번역 보기', exact: true }).click();
  const savedTranslation = firstDetail.jobs.find((job) => job.kind === 'translation')!;
  await expect(page.getByTestId('translation-text').locator('.source-block')).toHaveText(
    savedTranslation.translationLayout!.blocks.map((block, index, blocks) =>
      savedTranslation.result!.text!.slice(block.start, blocks[index + 1]?.start)
    )
  );
  await expect(page.getByTestId('translation-text').locator('[data-block-anchor]')).toHaveCount(
    savedTranslation.translationLayout!.blocks.length
  );
  await expect(
    page.getByTestId('translation-text').getByTestId('inline-annotation').first()
  ).toBeVisible();
  const laterOriginal = await send(
    page,
    'SYNTHETIC_ORIGINAL_ONLY: this later scene must not enter a fork from the first scene.'
  );
  await expect
    .poll(
      async () =>
        (await getDetail(request, chat.id)).runs.find((run) => run.id === laterOriginal.id)?.status
    )
    .toBe('completed');
  await expect(page.getByTestId('source')).toHaveCount(2);
  await page
    .getByTestId('source')
    .last()
    .getByRole('button', { name: '번역 보기', exact: true })
    .click();
  await expect.poll(async () => (await getDetail(request, chat.id)).jobs.length).toBe(8);
  await expect
    .poll(async () =>
      (await getDetail(request, chat.id)).jobs.every((job) => job.status === 'completed')
    )
    .toBe(true);
  const before = await getDetail(request, chat.id);
  await expect(page.getByTestId('source')).toHaveCount(2);
  await page.getByLabel('다음 장면 요청').fill('SYNTHETIC retained original draft');
  const otherTab = await context.newPage();
  try {
    await otherTab.goto(`/?chat=${chat.id}`);
    await expect(otherTab.getByTestId('source')).toHaveCount(2);
    await otherTab.getByLabel('다음 장면 요청').fill('SYNTHETIC independent other-tab draft');
    const forkResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/chats/${chat.id}/fork`) &&
        response.request().method() === 'POST'
    );
    await openSourceActions(page.locator(`[data-testid="source"][data-source-id="${source.id}"]`));
    await page
      .locator(`[data-testid="source"][data-source-id="${source.id}"]`)
      .getByRole('button', { name: '이 장면까지 새 채팅으로 복사', exact: true })
      .click();
    const forkReply = await forkResponse;
    expect(forkReply.ok()).toBeTruthy();
    expect(forkReply.request().postDataJSON().fromRevision).toBe(source.id);
    const fork = (await forkReply.json()) as Chat;
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(fork.id);
    await expect(page.getByTestId('source')).toHaveCount(1);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('');
    const copied = await getDetail(request, fork.id);
    const forkSource = copied.sources[0];
    expect(forkSource.id).not.toBe(source.id);
    expect(forkSource.chatId).toBe(fork.id);
    expect(forkSource.parentRevision).toBeNull();
    expect(forkSource.text).toBe(source.text);
    expect(forkSource.hash).toBe(source.hash);
    expect(
      forkSource.blocks!.map(({ index, text, start, end }) => ({ index, text, start, end }))
    ).toEqual(source.blocks!.map(({ index, text, start, end }) => ({ index, text, start, end })));
    expect(copied.sources).toHaveLength(1);
    expect(copied.runs).toHaveLength(1);
    expect(copied.attempts).toHaveLength(0);
    expect(copied.jobs).toHaveLength(4);
    expect(
      copied.jobs.every(
        (job) =>
          job.status === 'completed' &&
          job.sourceRevision === forkSource.id &&
          job.result?.sourceRevision === forkSource.id &&
          job.result?.sourceHash === source.hash
      )
    ).toBe(true);
    const oldTranslation = firstDetail.jobs.find((job) => job.kind === 'translation')!.result!;
    const newTranslation = copied.jobs.find((job) => job.kind === 'translation')!.result!;
    expect(newTranslation.segments?.map((segment) => segment.text)).toEqual(
      oldTranslation.segments?.map((segment) => segment.text)
    );
    expect(newTranslation.text).toBe(oldTranslation.text);
    await expect(page.getByTestId('profile-asset')).toBeVisible();
    await page.getByRole('button', { name: '원문 보기', exact: true }).click();
    await expect(page.getByTestId('inline-annotation').first()).toBeVisible();
    await page.getByRole('button', { name: '번역 보기', exact: true }).click();
    const copiedTranslation = copied.jobs.find((job) => job.kind === 'translation')!;
    await expect(page.getByTestId('translation-text').locator('.source-block')).toHaveText(
      copiedTranslation.translationLayout!.blocks.map((block, index, blocks) =>
        newTranslation.text!.slice(block.start, blocks[index + 1]?.start)
      )
    );
    await expect(
      page.getByTestId('translation-text').getByTestId('inline-annotation').first()
    ).toBeVisible();
    await expect(otherTab.getByTestId('source')).toHaveCount(2);
    await expect(otherTab.getByLabel('다음 장면 요청')).toHaveValue(
      'SYNTHETIC independent other-tab draft'
    );
    expect(await getDetail(request, chat.id)).toEqual(before);
    const forkPrompt = await request.post('/api/prompt-presets', {
      data: {
        title: 'Synthetic fork-only prompt',
        role: 'main',
        program: createDefaultPromptProgram('Synthetic vivid narration for this fork.', 'main'),
      },
    });
    expect(forkPrompt.ok()).toBeTruthy();
    const forkPreset = await forkPrompt.json();
    await page.reload();
    await storySettings(page);
    const forkEditor = await promptTab(page);
    await forkEditor
      .getByLabel('현재 프롬프트 프리셋', { exact: true })
      .selectOption(forkPreset.id);
    await expect
      .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.title)
      .toBe('Synthetic fork-only prompt');
    await expect(forkEditor.getByLabel('현재 프롬프트 프리셋', { exact: true })).toBeEnabled();
    expect((await getDetail(request, chat.id)).profile).toEqual(before.profile);
    const next = await send(
      page,
      'SYNTHETIC fork-only descendant.\n\n' +
        'Only the fork follows this long path along the pier.\n\n'.repeat(30)
    );
    await expect
      .poll(
        async () =>
          (await getDetail(request, fork.id)).runs.find((run) => run.id === next.id)?.status
      )
      .toBe('completed');
    await expect
      .poll(async () =>
        (await getDetail(request, fork.id)).jobs.every((job) => job.status === 'completed')
      )
      .toBe(true);
    await expect(page.getByTestId('source')).toHaveCount(2);
    const final = await getDetail(request, fork.id);
    const descendant = final.sources.find((item) => item.runId === next.id)!;
    expect(descendant.parentRevision).toBe(forkSource.id);
    expect(descendant.text.length).toBeGreaterThan(1500);
    expect(
      final.runs.find((item) => item.id === next.id)?.snapshot.history.map((item) => item.revision)
    ).toEqual([forkSource.id]);
    expect(
      final.runs.find((item) => item.id === next.id)?.snapshot.history.map((item) => item.text)
    ).toEqual([source.text]);
    await page.getByLabel('다음 장면 요청').fill('SYNTHETIC independent fork draft');
    const forkUrl = page.url();
    await selectStoredChat(page, chat);
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue(
      'SYNTHETIC retained original draft'
    );
    await selectStoredChat(page, fork);
    await expect(page).toHaveURL(forkUrl);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('SYNTHETIC independent fork draft');
    await page.reload();
    await expect(page).toHaveURL(forkUrl);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('SYNTHETIC independent fork draft');
    await expect(otherTab.getByTestId('source')).toHaveCount(2);
    await expect(otherTab.getByLabel('다음 장면 요청')).toHaveValue(
      'SYNTHETIC independent other-tab draft'
    );
    expect(await getDetail(request, chat.id)).toEqual(before);
    expect(final.sources.find((item) => item.id === forkSource.id)).toEqual(forkSource);
    expect(source.hash).toBe(createHash('sha256').update(source.text).digest('hex'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    if (visualReview)
      await page.screenshot({
        path: testInfo.outputPath('m1-mobile-fork-reader.png'),
        fullPage: true,
      });
    expect(errors).toEqual([]);
  } finally {
    await otherTab.close();
  }
});

test('P06 P11 export/backup downloads preserve source and reject restore into an occupied DB', async ({
  page,
  request,
}) => {
  const chat = await createChat(page, `합성 P11-${Date.now()}`);
  const run = await send(page, 'SYNTHETIC_ARCHIVE: The letter is still sealed.');
  await expect
    .poll(
      async () =>
        (await getDetail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  const source = (await getDetail(request, chat.id)).sources[0];
  const activity = page.locator(`[data-testid="turn-activity"][data-run-id="${run.id}"]`);
  await activity.locator(':scope > summary').click();
  await expect(activity.getByText('요청 충실성 기록', { exact: true })).toHaveCount(0);
  const after = await getDetail(request, chat.id);
  expect(after.sources[0]).toEqual(source);
  await navigation(page, '설정');
  await selectSettingsSection(page, '데이터 관리');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  const download = await downloadPromise;
  const filename = await download.path();
  expect(filename).not.toBeNull();
  const bytes = await readFile(filename!);
  const archive = JSON.parse(bytes.toString('utf8'));
  expect(archive.format).toBe('narrative-archive');
  expect(
    archive.tables.sources.some(
      (item: { id: string; hash: string }) => item.id === source.id && item.hash === source.hash
    )
  ).toBe(true);
  const backupPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SQLite 백업 다운로드', exact: true }).click();
  const backup = await backupPromise;
  const dbBytes = await readFile((await backup.path())!);
  expect(dbBytes.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000');
  await page
    .getByLabel('가져올 JSON 파일')
    .setInputFiles({ name: 'synthetic-export.json', mimeType: 'application/json', buffer: bytes });
  await expect(page.getByRole('button', { name: '빈 DB에 가져오기', exact: true })).toBeDisabled();
  await expect(
    page
      .getByTestId('archive-panel')
      .getByRole('status')
      .filter({ hasText: '현재 DB에 자료가 있어 가져올 수 없어요.' })
  ).toBeVisible();
  const rejected = await request.post('/api/import', { data: { archive } });
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toEqual({ error: 'Restore requires an empty database' });
  expect((await getDetail(request, chat.id)).sources[0]).toEqual(source);
});

test('P04 Vertex settings use service-account references and persist distinct main and translation presets without execution', async ({
  page,
  request,
}, testInfo) => {
  const unique = `Vertex-${Date.now()}`;
  const chat = await createChat(page, `합성 ${unique}`);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await navigation(page, '설정');
  await selectSettingsSection(page, '프로바이더·모델 등록');
  const editor = page.getByTestId('connection-editor');
  await startProviderConnection(page);
  await editor
    .getByRole('region', { name: '제공자 선택', exact: true })
    .getByRole('button', { name: /Google Agent Platform/ })
    .click();
  await page.getByLabel('프로바이더 프로토콜', { exact: true }).selectOption('vertex-gemini-v1');
  await page.getByLabel('프로바이더 이름', { exact: true }).fill(unique);
  await page
    .getByLabel('Google Agent Platform endpoint', { exact: true })
    .fill(
      'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models'
    );
  await page.getByLabel('이 프로바이더 사용', { exact: true }).check();
  await expect(page.getByLabel('서버 환경변수 이름', { exact: true })).toHaveValue('');
  const connectionResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/connections') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
  const connection = (await (await connectionResponse).json()) as Connection;
  expect(connection).toMatchObject({ protocol: 'vertex-gemini-v1', enabled: true });
  expect(connection).not.toHaveProperty('credentialEnv');
  await editor.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await openProviderMenu(page, '프로바이더', unique);
  await editor
    .getByRole('article', { name: `${unique} 프로바이더`, exact: true })
    .getByRole('button', { name: `${unique} 로컬 지원 모델 확인`, exact: true })
    .click();
  await expect(editor.getByRole('status')).toContainText('공급자 조회 없음');
  const latest = (await getLibrary(request)).connections.find((item) => item.id === connection.id)!;
  const models: ModelPreset[] = [];
  for (const role of ['main', 'translation']) {
    await editor.getByRole('button', { name: '모델 프리셋', exact: true }).click();
    await editor.getByRole('button', { name: '새 모델 입력', exact: true }).click();
    await page.getByLabel('모델 프리셋 이름', { exact: true }).fill(`${unique}-${role}`);
    await page.getByLabel('프로바이더', { exact: true }).selectOption(`${latest.id}`);
    await page.getByLabel('모델 ID', { exact: true }).fill('gemini-3.8-flash');
    await expect(page.getByLabel('모델 ID', { exact: true })).toBeEditable();
    await expect(page.getByLabel('Temperature', { exact: true })).toBeHidden();
    await page
      .getByLabel('사고 강도', { exact: true })
      .selectOption(role === 'main' ? 'MEDIUM' : 'LOW');
    await editor.getByRole('button', { name: '고급', exact: true }).click();
    await page
      .getByLabel('응답 제한 시간 (초)', { exact: true })
      .fill(role === 'main' ? '300' : '180');
    const modelResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/model-presets') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
    models.push((await (await modelResponse).json()) as ModelPreset);
  }
  expect(models[0]).toMatchObject({
    temperature: null,
    thinkingLevel: 'MEDIUM',
    timeoutMs: 300000,
  });
  expect(models[1]).toMatchObject({ temperature: null, thinkingLevel: 'LOW', timeoutMs: 180000 });
  if (visualReview)
    await page.screenshot({
      path: testInfo.outputPath('vertex-settings-mobile.png'),
      fullPage: true,
    });
  await openDetails(page, 'profile-editor');
  await selectCurrentSettingsSection(page, '모델');
  await page.getByLabel('원문 모델', { exact: true }).selectOption(`${models[0].id}`);
  await page.getByLabel('번역 모델', { exact: true }).selectOption(`${models[1].id}`);
  await page.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/model-workspace')).json()).routes.main)
    .toEqual({ id: models[0].id });
  const detail = await getDetail(request, chat.id);
  expect(detail.profile?.routes).toMatchObject({
    main: { id: models[0].id },
    translation: { id: models[1].id },
  });
  expect(detail.runs).toHaveLength(0);
  expect(detail.sources).toHaveLength(0);
  expect(detail.attempts).toHaveLength(0);
  expect(pageErrors).toEqual([]);
});

test('P04 named and custom providers save native options from mobile settings without model execution', async ({
  page,
  request,
}, testInfo) => {
  const chat = await createChat(page, `공급자 설정 ${Date.now()}`);
  await navigation(page, '설정');
  await selectSettingsSection(page, '프로바이더·모델 등록');
  const cases = [
    {
      protocol: 'openai-responses-v1',
      endpoint: 'https://api.openai.com/v1',
      credential: 'OPENAI_API_KEY',
      modelId: 'gpt-5.6-sol',
    },
    {
      protocol: 'anthropic-messages-v1',
      endpoint: 'https://api.anthropic.com/v1',
      credential: 'ANTHROPIC_API_KEY',
      modelId: 'claude-opus-5',
    },
    {
      protocol: 'vercel-chat-v1',
      endpoint: 'https://ai-gateway.vercel.sh/v1',
      credential: 'VERCEL_API_KEY',
      modelId: 'synthetic/model',
    },
    {
      protocol: 'openai-chat-v1',
      endpoint: 'https://synthetic.example/v1',
      credential: 'PROVIDER_API_KEY',
      modelId: 'synthetic-chat',
    },
  ];
  for (const item of cases) {
    await startProviderConnection(page);
    await page
      .getByRole('region', { name: '제공자 선택', exact: true })
      .getByRole('button', { name: /OpenAI · Responses/ })
      .click();
    await page.getByLabel('프로바이더 프로토콜', { exact: true }).selectOption(item.protocol);
    await page.getByLabel('프로바이더 이름', { exact: true }).fill(item.protocol);
    const endpoint = page.getByLabel('API 기본 주소', { exact: true });
    if (item.protocol === 'openai-chat-v1') await endpoint.fill(item.endpoint);
    else await expect(endpoint).toHaveValue(item.endpoint);
    await expect(page.getByLabel('서버 환경변수 이름', { exact: true })).toHaveValue(
      item.credential
    );
    await page.getByLabel('이 프로바이더 사용', { exact: true }).check();
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/connections') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: '프로바이더 등록', exact: true }).click();
    const connection = (await (await saved).json()) as Connection;
    expect(connection).toMatchObject({
      protocol: item.protocol,
      endpoint: item.endpoint,
      credentialEnv: item.credential,
      enabled: true,
    });
    await expect(page.getByRole('form', { name: '모델 편집 양식' })).toBeVisible();
    await page.getByLabel('프로바이더', { exact: true }).selectOption(`${connection.id}`);
    await page.getByLabel('모델 프리셋 이름', { exact: true }).fill(item.modelId);
    await page.getByLabel('모델 ID', { exact: true }).fill(item.modelId);
    await page.getByLabel('사고 강도', { exact: true }).selectOption('high');
    await page.getByRole('button', { name: '고급', exact: true }).click();
    await page.getByLabel('응답 제한 시간 (초)', { exact: true }).fill('900');
    if (item.protocol === 'anthropic-messages-v1')
      await page.getByLabel('사고 모드', { exact: true }).selectOption('adaptive');
    await page.getByLabel('번역 구조화 출력', { exact: true }).selectOption('on');
    const savedModel = page.waitForResponse(
      (r) => r.url().endsWith('/api/model-presets') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
    const model = (await (await savedModel).json()) as ModelPreset;
    expect(model).toMatchObject({
      connectionId: connection.id,
      modelId: item.modelId,
      temperature: null,
      timeoutMs: 900000,
      structuredOutput: true,
      ...(item.protocol === 'anthropic-messages-v1'
        ? { outputEffort: 'high' }
        : { reasoningEffort: 'high' }),
    });
    if (item.protocol === 'anthropic-messages-v1')
      expect(model).not.toHaveProperty('reasoningEffort');
    expect(model.thinkingMode).toBe(
      item.protocol === 'anthropic-messages-v1' ? 'adaptive' : undefined
    );
  }
  const detail = await getDetail(request, chat.id);
  expect(detail.attempts).toHaveLength(0);
  expect(detail.runs).toHaveLength(0);
  expect(detail.sources).toHaveLength(0);
  if (visualReview)
    await page.screenshot({ path: testInfo.outputPath('provider-settings.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
