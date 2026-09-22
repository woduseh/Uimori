import { nativeContent } from './fixtures/native-content.js';
import { waitForContentSave } from './fixtures/resource-save.js';
import { selectCurrentSettingsSection } from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';
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
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Connection, Content, Library, ModelPreset } from '../core/product.js';

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
  await selectCurrentSettingsSection(page, '현재 프롬프트');
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
  await selectChatSettingsSection(page, '대화 구성');
  return profileInfo(page);
}

test('P01 packages use latest settings and prompt-owned creative choices replace prior values', {
  tag: '@smoke',
}, async ({ page, request }) => {
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
      package: nativeContent({ name: `Mira ${unique}`, description: firstBody }, {}, 'module'),
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
      values: { detail: '1', coNarration: '0' },
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
  ).toHaveText(['대화 구성', '프롬프트·모델', '기억·로어', '이미지', '자동 작업']);
  await selectChatSettingsSection(page, '대화 구성');
  await page.getByText('함께 사용하는 모듈 · 자료 추가', { exact: true }).click();
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
    .getByLabel('캐릭터 설정', { exact: true })
    .fill('Mira is a synthetic harbor keeper. Her compass is silver in this revision.');
  const savedContent = waitForContentSave(page, added.id);
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  expect((await savedContent).package?.nativeRisu.card.description).toBe(
    'Mira is a synthetic harbor keeper. Her compass is silver in this revision.'
  );
  // Compact editors hide global navigation until the user returns to the library list.
  await library.getByRole('button', { name: '서재 목록', exact: true }).click();
  await expect(library.getByLabel('서재 검색', { exact: true })).toBeVisible();
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
  await expect(composer.getByRole('combobox', { name: '합성 공동 서술', exact: true })).toHaveValue(
    JSON.stringify('0')
  );
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
  expect(
    saved.snapshot.profile?.packages?.find((pkg) => pkg.id === added.id)?.nativeRisu.card
      .description
  ).toBe('Mira is a synthetic harbor keeper. Her compass is silver in this revision.');
  expect(saved.snapshot.profile?.packageAttachments).toEqual([
    owner,
    { id: added.id, revision: 2, role: 'module' },
  ]);
  expect(saved.snapshot.profile?.promptPresets?.main?.values).toEqual({
    detail: '1',
    coNarration: '0',
  });
  // Completed runs retain the selected prompt values in the frozen profile, while the
  // full compiler payload is intentionally retired from durable execution snapshots.
  expect(saved.snapshot.promptCompilation).toBeUndefined();
  expect(saved.inputs).toEqual([]);
});

test('P04 manual model IDs and distinct main/translation routing preserve connection authority after catalog failure', async ({
  page,
  request,
}) => {
  const unique = `P04-${Date.now()}`;
  const chat = await createChat(page, `합성 ${unique}`);
  await navigation(page, '설정');
  await selectSettingsSection(page, '프로바이더·모델');
  const library = page.getByTestId('connection-editor');
  await startProviderConnection(page);
  await library.getByText('개발·검사용 프로바이더', { exact: true }).click();
  await library.getByRole('button', { name: '로컬 fixture로 설정', exact: true }).click();
  await page.getByLabel('프로바이더 이름', { exact: true }).fill(`격리 연결 ${unique}`);
  await page.getByLabel('로컬 endpoint').fill('http://127.0.0.1:9/turn');
  await page.getByLabel('API 키').fill('UIMORI_PROVIDER_SYNTHETIC');
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
    credentialRef: connection.credentialRef,
  });
  expect((await request.get(`/api/revisions/connection/${connection.id}/1`)).ok()).toBe(false);
  await openDetails(page, 'profile-editor');
  await selectCurrentSettingsSection(page, '역할별 모델');
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
  await selectSettingsSection(page, '프로바이더·모델');
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
    credentialRef: connection.credentialRef,
  });
  // Activating the current connection makes its existing model IDs selectable immediately.
  const activatedModels = (await getLibrary(request)).models;
  for (const model of modelRefs)
    expect(activatedModels.find((item) => item.id === model.id)).toEqual(model);
  await openDetails(page, 'profile-editor');
  await selectCurrentSettingsSection(page, '역할별 모델');
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
        .some((value) => String(value).includes('UIMORI_PROVIDER_SYNTHETIC'))
    )
  ).toBe(false);
});

test('P09 copying a scene creates an independent chat and keeps each tab draft', async ({
  page,
  context,
  request,
}) => {
  const chat = await createChat(page, `합성 P09-${Date.now()}`);
  const first = await send(
    page,
    'SYNTHETIC first scene.\n\n' + 'A quiet harbor remains open to every choice.\n\n'.repeat(50)
  );
  await expect
    .poll(
      async () =>
        (await getDetail(request, chat.id)).runs.find((run) => run.id === first.id)?.status
    )
    .toBe('completed');
  const source = (await getDetail(request, chat.id)).sources[0];
  expect(source.text.length).toBeGreaterThan(1000);
  const later = await send(page, 'SYNTHETIC later original scene, excluded from the earlier copy.');
  await expect
    .poll(
      async () =>
        (await getDetail(request, chat.id)).runs.find((run) => run.id === later.id)?.status
    )
    .toBe('completed');
  await expect(page.getByTestId('source')).toHaveCount(2);
  await page.getByLabel('다음 장면 요청').fill('SYNTHETIC original draft');
  const before = await getDetail(request, chat.id);
  const other = await context.newPage();
  try {
    await other.goto(`/?chat=${chat.id}`);
    await expect(other.getByTestId('source')).toHaveCount(2);
    await other.getByLabel('다음 장면 요청').fill('SYNTHETIC other-tab draft');
    const copiedResponse = page.waitForResponse(
      (reply) =>
        reply.url().endsWith(`/api/chats/${chat.id}/fork`) && reply.request().method() === 'POST'
    );
    const firstArticle = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
    await openSourceActions(firstArticle);
    await firstArticle
      .getByRole('button', { name: '이 장면까지 새 채팅으로 복사', exact: true })
      .click();
    const response = await copiedResponse;
    expect(response.ok(), await response.text()).toBe(true);
    const fork = (await response.json()) as Chat;
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(fork.id);
    await expect(page.getByTestId('source')).toHaveCount(1);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('');
    const copied = await getDetail(request, fork.id);
    expect(copied.sources).toHaveLength(1);
    expect(copied.sources[0]).toMatchObject({
      text: source.text,
      hash: source.hash,
      chatId: fork.id,
    });
    expect(copied.sources[0].id).not.toBe(source.id);
    expect(copied.attempts).toHaveLength(0);
    await page.getByLabel('다음 장면 요청').fill('SYNTHETIC fork draft');
    await page.reload();
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('SYNTHETIC fork draft');
    await expect(other.getByLabel('다음 장면 요청')).toHaveValue('SYNTHETIC other-tab draft');
    await expect(other.getByTestId('source')).toHaveCount(2);
    await selectStoredChat(page, chat);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('SYNTHETIC original draft');
    const unchanged = await getDetail(request, chat.id);
    expect(unchanged.sources).toEqual(before.sources);
    expect(unchanged.runs.map((run) => run.id)).toEqual(before.runs.map((run) => run.id));
    expect(unchanged.profile).toEqual(before.profile);
  } finally {
    await other.close();
  }
});
