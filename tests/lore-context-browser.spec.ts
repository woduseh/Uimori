import { navigationAction } from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';
import { waitForContentDraftSave } from './fixtures/edit-draft-save.js';
import { visualReview } from './fixtures/visual-review.js';
import {
  editLibraryContent,
  selectChatSettingsSection,
  selectPackageSection,
  openChatMenu,
} from './ui-navigation.js';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import type { ContentPackage } from '../core/content-package.js';
import type { Content } from '../core/product.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';

async function seed(request: APIRequestContext, title: string, part: Partial<ContentPackage> = {}) {
  const pkg: ContentPackage = {
    version: 1,
    id: 'synthetic_lore_ui',
    revision: 1,
    title,
    description: 'Synthetic lore context UI',
    body: 'Synthetic harbor keeper.',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    ...part,
  };
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: pkg.description,
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Content>;
}
async function createChat(request: APIRequestContext, bot: Content) {
  const response = await request.post('/api/chats', { data: { title: bot.title, botId: bot.id } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Chat>;
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function evidence(page: Page, target: Locator, info: TestInfo, name: string) {
  for (const [suffix, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await target.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    const dialog = page.getByRole('dialog').filter({ visible: true });
    if (await dialog.count())
      expect(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true);
    if (visualReview) await page.screenshot({ path: info.outputPath(`${name}-${suffix}.png`) });
  }
}

test('LCUI01 lore placement and invalid order drafts stay independent from folders and loading', async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const original = await seed(request, `합성 로어 제작 ${Date.now()}`, {
    loreFolders: [{ id: 'folder_one', name: '편집용 폴더' }],
    lore: [
      {
        id: 'first',
        title: '첫 로어',
        description: '',
        text: 'A😀B',
        loading: 'discoverable',
        folderId: 'folder_one',
      },
      {
        id: 'second',
        title: '둘째 로어',
        description: '',
        text: 'Untouched lore.',
        loading: 'pinned',
      },
    ],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '서재');
  const library = page.getByTestId('library-panel');
  await editLibraryContent(page, `${original.title}`);
  const fields = library.getByRole('region', { name: '패키지 구성', exact: true }),
    save = library.getByRole('button', { name: '변경사항 저장', exact: true });
  await fields.getByLabel('사용 방법', { exact: true }).selectOption('pinned');
  await fields.getByLabel('로어 1 배치', { exact: true }).selectOption('scene');
  await fields.getByLabel('로어 1 배치 묶음', { exact: true }).fill('장면 인물');
  await fields.getByLabel('로어 1 배치 순서', { exact: true }).fill('1.5');
  await expect(save).toBeDisabled();
  await selectPackageSection(page, '옵션');
  await selectPackageSection(page, '로어');
  await expect(fields.getByLabel('로어 1 배치 순서', { exact: true })).toHaveValue('1.5');
  await expect(fields.getByLabel('로어 소속 폴더', { exact: true })).toHaveValue('folder_one');
  await fields.getByLabel('로어 1 배치 순서', { exact: true }).fill('-2');
  await fields.getByLabel('사용 방법', { exact: true }).selectOption('discoverable');
  await expect(fields.getByLabel('로어 1 배치', { exact: true })).toHaveCount(0);
  await fields.getByLabel('사용 방법', { exact: true }).selectOption('pinned');
  await expect(fields.getByLabel('로어 1 배치', { exact: true })).toHaveValue('scene');
  await expect(fields.getByLabel('로어 1 배치 묶음', { exact: true })).toHaveValue('장면 인물');
  await expect(fields.getByLabel('로어 1 배치 순서', { exact: true })).toHaveValue('-2');
  await fields.getByLabel('사용 방법', { exact: true }).selectOption('discoverable');
  await expect(fields.getByRole('region', { name: '선택한 로어 편집', exact: true })).toContainText(
    'UTF-16 4자'
  );
  await expect(save).toBeEnabled();
  const saved = waitForContentDraftSave(page, original.id);
  await save.click();
  const changed = await saved;
  expect(changed.package!.lore[0]).toMatchObject({
    loading: 'discoverable',
    folderId: 'folder_one',
    loreContext: { placement: 'scene', group: '장면 인물', order: -2 },
  });
  expect(changed.package!.lore[1]).toEqual(original.package!.lore[1]);
  expect(changed.package!.loreFolders).toEqual(original.package!.loreFolders);
  expect(
    (await (await request.get(`/api/revisions/content/${original.id}/1`)).json()).package
  ).toEqual(original.package);
  await evidence(page, fields.getByLabel('로어 1 본문', { exact: true }), info, 'lore-placement');
  expect(errors).toEqual([]);
});

test('LCUI02 policy drafts survive tabs and preview reflects the unsaved policy without writing or calling models', async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bot = await seed(request, `합성 로어 정책 ${Date.now()}`, {
      lore: [
        {
          id: 'fixed',
          title: '고정 배경',
          description: '',
          text: 'Synthetic fixed lighthouse.',
          loading: 'pinned',
          loreContext: { placement: 'background' },
        },
      ],
    }),
    chat = await createChat(request, bot);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByLabel('다음 장면 요청', { exact: true }).fill('합성 다음 장면');
  await page.getByRole('button', { name: '입력창 더보기' }).click();
  await page.getByRole('switch', { name: '다음 생성에서 조회 로어 제외' }).click();
  await openChatSettings(page);
  await selectChatSettingsSection(page, '봇·페르소나·모듈');
  const editor = page.getByTestId('profile-editor'),
    policy = editor.getByRole('region', { name: '로어 문맥 정책', exact: true }),
    save = editor.getByRole('button', { name: '채팅 설정 저장', exact: true });
  await expect(policy.getByLabel('조회 로어 문자 한도', { exact: true })).toHaveValue('48000');
  await expect(policy.getByLabel('고정 자료 문자 한도', { exact: true })).toHaveValue('200000');
  await policy.getByLabel('조회 로어 구간 한도', { exact: true }).fill('257');
  await expect(save).toBeDisabled();
  await selectChatSettingsSection(page, '모델');
  await expect(save).toBeDisabled();
  await selectChatSettingsSection(page, '봇·페르소나·모듈');
  await expect(policy.getByLabel('조회 로어 구간 한도', { exact: true })).toHaveValue('257');
  await policy.getByLabel('조회 로어 구간 한도', { exact: true }).fill('8');
  await policy.getByLabel('조회 로어 문자 한도', { exact: true }).fill('1234');
  await policy.getByLabel('고정 자료 문자 한도', { exact: true }).fill('5000');
  const before = await detail(request, chat.id);
  await policy.getByText('다음 생성의 로어 미리보기', { exact: true }).click();
  const previewResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chats/${chat.id}/prompt-preview`) &&
      response.request().method() === 'POST'
  );
  await policy.getByRole('button', { name: '로어 미리보기 갱신', exact: true }).click();
  const preview = await previewResponse;
  expect(preview.ok(), await preview.text()).toBe(true);
  const expected = {
    enabled: true,
    maxRetainedChars: 1234,
    maxRetainedEntries: 8,
    maxPinnedChars: 5000,
  };
  expect(preview.request().postDataJSON()).toMatchObject({
    request: '합성 다음 장면',
    role: 'main',
    loreContext: expected,
    loreContextReset: true,
  });
  expect(preview.request().postDataJSON().program).toBeUndefined();
  const compiled = await preview.json();
  expect(compiled.loreContext.policy).toEqual(expected);
  expect(compiled.loreContext.stats.reasons).toContain('new-scene');
  expect(JSON.stringify(compiled.compilation.messages)).toContain('Synthetic fixed lighthouse.');
  const result = policy.getByRole('region', { name: '미리보기의 조회 로어', exact: true });
  await expect(result).toContainText('새 장면 요청으로 조회 로어 정리');
  await expect(result).toContainText('5,000자');
  const after = await detail(request, chat.id);
  expect(after.profile).toEqual(before.profile);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.sources).toEqual(before.sources);
  await evidence(page, result, info, 'lore-policy-preview');
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chats/${chat.id}/profile`) &&
      response.request().method() === 'PUT'
  );
  await save.click();
  expect((await saved).ok()).toBe(true);
  expect((await detail(request, chat.id)).profile!.loreContext).toEqual(expected);
  expect(errors).toEqual([]);
});

test('LCUI03 a lost response freezes the one-shot reset through retry and exposes the accepted run diagnostics', async ({
  page,
  request,
}, info) => {
  const bot = await seed(request, `합성 로어 재확인 ${Date.now()}`),
    chat = await createChat(request, bot),
    commands: Record<string, unknown>[] = [];
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await page.route(`**/api/chats/${chat.id}/runs`, async (route) => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  const reset = page.getByRole('button', { name: '조회 로어 제외 해제' });
  await page.getByLabel('다음 장면 요청', { exact: true }).fill('합성 처음 요청');
  await page.getByRole('button', { name: '입력창 더보기' }).click();
  await page.getByRole('switch', { name: '다음 생성에서 조회 로어 제외' }).click();
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect.poll(async () => (await detail(request, chat.id)).runs[0]?.status).toBe('completed');
  await expect(page.getByTestId('source')).toHaveCount(1);
  await expect(reset).toBeVisible();
  await expect(reset).toBeDisabled();
  expect(commands[0].loreContextReset).toBe(true);
  expect(
    await page.evaluate(
      (id) =>
        JSON.parse(JSON.parse(sessionStorage.getItem(`command:${id}`)!).payload).loreContextReset,
      chat.id
    )
  ).toBe(true);
  await page.getByLabel('다음 장면 요청', { exact: true }).fill('합성 나중 초안');
  await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeVisible();
  await expect(reset).toHaveCount(0);
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toHaveValue('합성 나중 초안');
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  const state = await detail(request, chat.id);
  expect(state.runs).toHaveLength(1);
  expect(state.sources).toHaveLength(1);
  expect(
    await page.evaluate((id) => sessionStorage.getItem(`lore-reset:draft:${id}`), chat.id)
  ).toBeNull();
  const full = (await (await request.get(`/api/runs/${state.runs[0].id}`)).json()) as Run;
  expect(full.snapshot.loreContextReset).toBe(true);
  expect(full.snapshot.loreContext!.stats.reasons).toContain('new-scene');
  await openChatMenu(page);
  await page.getByRole('button', { name: '작업 현황', exact: true }).click();
  await page.getByText('실행과 실제 입력 확인', { exact: true }).click();
  const result = page.getByRole('region', { name: '조회 로어 유지 결과', exact: true });
  await expect(result).toContainText('이 요청에서 새 장면 정리를 선택했어요.');
  await expect(result).toContainText('새 장면 요청으로 조회 로어 정리');
  await evidence(page, result, info, 'lore-run-diagnostics');
});

test('LCUI04 rare request option stays hidden until selected and supports dismissal', async ({
  page,
  request,
}, info) => {
  const bot = await seed(request, `Synthetic composer ${Date.now()}`),
    chat = await createChat(request, bot);
  await page.goto(`/?chat=${chat.id}`);
  const more = page.getByRole('button', { name: '입력창 더보기' }),
    choice = page.getByRole('switch', { name: '다음 생성에서 조회 로어 제외' }),
    chip = page.getByRole('button', { name: '조회 로어 제외 해제' });
  await expect(chip).toHaveCount(0);
  await expect(choice).toHaveCount(0);
  await more.click();
  await expect(choice).toBeVisible();
  await expect(
    page.getByRole('group', { name: '이번 요청 옵션', exact: true }).locator(':focus')
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await expect(choice).toHaveCount(0);
  await more.click();
  await page.locator('.header-title').click();
  await expect(choice).toHaveCount(0);
  await more.click();
  await evidence(page, choice, info, 'composer-more-open');
  await choice.click();
  await expect(chip).toBeVisible();
  await expect(choice).toHaveCount(0);
  await evidence(page, chip, info, 'composer-more-selected');
  await chip.click();
  await expect(chip).toHaveCount(0);
  await more.click();
  await choice.click();
  await page.getByRole('textbox', { name: '다음 장면 요청' }).fill('Synthetic scene');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect(chip).toHaveCount(0);
  await expect.poll(async () => (await detail(request, chat.id)).runs.length).toBe(1);
});
