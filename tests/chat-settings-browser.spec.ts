import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Chat, ChatDetail } from '../core/types.js';
import type { StoryDetail } from '../core/story.js';
import type { StoryGuideDetail } from '../core/story-guide.js';
import { nativeContent } from './fixtures/native-content.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { postFixtureChat } from './fixtures/chat.js';
import {
  navigationAction,
  openChatMenu,
  selectChatSettingsSection,
  selectSettingsSection,
} from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';

const sections = ['사용 자료', '생성 설정', '작품 및 원작 참고', '기억과 메모', '이미지'];

async function prepare(
  page: Page,
  request: APIRequestContext,
  title: string,
  program?: ReturnType<typeof nativePrompt>
) {
  const response = await postFixtureChat(request, { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = (await response.json()) as Chat;
  if (program) {
    const created = await request.post('/api/prompt-presets', {
      data: { title: `${title} prompt`, role: 'main', program },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const preset = (await created.json()) as { id: string };
    const profile = ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail)
      .profile!;
    const pinned = await request.put(`/api/chats/${chat.id}/profile`, {
      data: {
        expectedRevision: profile.revision,
        image: profile.image,
        packageAttachments: profile.packageAttachments,
        pinned: { ...profile.pinned, mainPromptPresetId: preset.id },
      },
    });
    expect(pinned.ok(), await pinned.text()).toBe(true);
  }
  const before = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (entry) => {
    const path = new URL(entry.url()).pathname;
    if (
      path.startsWith('/api/') &&
      !(entry.method() === 'POST' && path === '/api/packages/resolve') &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(entry.method())
    )
      writes.push(`${entry.method()} ${path}`);
  });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeVisible();
  return { chat, before, writes, errors };
}

async function openSettings(page: Page) {
  await openChatSettings(page);
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectNoOverflow(page: Page, dialog: Locator) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  ).toBeLessThanOrEqual(1);
  for (const surface of [dialog, dialog.locator('.chat-settings-panel')])
    expect(
      await surface.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
  const pane = dialog.getByRole('tabpanel');
  if (await pane.count())
    expect(await pane.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
      1
    );
}

async function expectUnchanged(
  request: APIRequestContext,
  before: ChatDetail,
  writes: string[],
  errors: string[]
) {
  const response = await request.get(`/api/chats/${before.chat.id}`);
  expect(response.ok()).toBe(true);
  const after = (await response.json()) as ChatDetail;
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  expect(after.profile).toEqual(before.profile);
  expect(after.chat.settings).toEqual(before.chat.settings);
  expect(after.chat.settingsRevision).toBe(before.chat.settingsRevision);
  expect(after.runs).toHaveLength(0);
  expect(after.jobs).toHaveLength(0);
  expect(after.attempts ?? []).toHaveLength(0);
}

test('SETTINGSLOCATION mobile opens the remembered available section and explicit destinations win', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  const { before, writes, errors } = await prepare(
    page,
    request,
    `설정 위치 복원 ${Date.now()}`,
    nativePrompt('No variable defaults.')
  );
  await page.evaluate(() => {
    localStorage.setItem('uimori:chat-settings-section', 'packages');
    localStorage.setItem('uimori:app-settings-section', 'lore');
  });
  let dialog = await openSettings(page);
  const selector = dialog.getByRole('combobox', { name: '설정 영역 선택', exact: true });
  await expect(selector).toHaveValue('characters');
  await expect(dialog.getByRole('heading', { name: '사용 자료', exact: true })).toBeVisible();
  await selector.selectOption('prompts');
  await expect(dialog.getByLabel('작가 노트', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  dialog = await openSettings(page);
  await expect(dialog.getByRole('combobox', { name: '설정 영역 선택', exact: true })).toHaveValue(
    'prompts'
  );
  await expect(dialog.getByRole('heading', { name: '생성 설정', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '역할별 모델', exact: true }).click();
  const global = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(global.getByRole('combobox', { name: '설정 영역 선택', exact: true })).toHaveValue(
    'models'
  );
  await global.getByRole('combobox', { name: '설정 영역 선택', exact: true }).selectOption('lore');
  await global.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await navigationAction(page, '설정');
  await expect(global.getByRole('combobox', { name: '설정 영역 선택', exact: true })).toHaveValue(
    'lore'
  );
  await global.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expectUnchanged(request, before, writes, errors);
});

test('CSUI02 section changes, browser Back and resizing preserve chat setting drafts until explicit discard', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const { chat, before, writes, errors } = await prepare(page, request, `CSUI02 ${Date.now()}`);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('채팅 설정을 닫아도 유지할 미전송 요청');
  const dialog = await openSettings(page);
  const nav = dialog.locator('.section-navigation');
  const confirm = page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true });
  await selectChatSettingsSection(page, '이미지');
  await expect(
    dialog.getByRole('checkbox', { name: '본문에서 페르소나 참조', exact: true })
  ).toHaveCount(0);
  await selectChatSettingsSection(page, '생성 설정');
  await expect(dialog.getByRole('button', { name: '역할별 모델', exact: true })).toBeVisible();
  await selectChatSettingsSection(page, '이미지');
  const image = dialog.getByRole('combobox', { name: '이미지 배치 담당', exact: true });
  await expect(dialog.getByLabel('번역 이미지 자동 배치', { exact: true })).toHaveCount(0);
  const originalImage = await image.inputValue();
  const draftImage = originalImage === 'jev' ? 'writer' : 'jev';
  await image.selectOption(draftImage);
  await selectChatSettingsSection(page, '생성 설정');
  await expect(dialog.getByLabel('장면 해설 자동 생성', { exact: true })).toHaveCount(0);
  const calls = dialog.getByLabel('작업당 모델 호출 한도', { exact: true });
  await expect(calls).toBeHidden();
  await dialog.getByText('고급 실행 설정', { exact: true }).click();
  const originalCalls = await calls.inputValue();
  const draftCalls = originalCalls === '6' ? '7' : '6';
  await calls.fill(draftCalls);
  await page.evaluate(() => history.back());
  await expect(nav).toBeVisible();
  await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
  await expect(confirm).toBeHidden();
  await page.evaluate(() => history.back());
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`));
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await selectChatSettingsSection(page, '이미지');
  await selectChatSettingsSection(page, '이미지');
  await expect(image).toHaveValue(draftImage);
  await selectChatSettingsSection(page, '생성 설정');
  await expect(calls).toHaveValue(draftCalls);
  await calls.focus();
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await expect(calls).toBeFocused();
  await selectChatSettingsSection(page, '이미지');
  await expect(image).toHaveValue(draftImage);
  await selectChatSettingsSection(page, '생성 설정');
  await expect(calls).toHaveValue(draftCalls);
  await calls.focus();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await expect(calls).toBeVisible();
  await expect(calls).toBeFocused();
  await expectNoOverflow(page, dialog);
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await expect(confirm).toBeVisible();
  if (visualReview)
    await page.screenshot({ path: info.outputPath(`chat-settings-dirty-${MOBILE_WIDTH}.png`) });
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(calls).toHaveValue(draftCalls);
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue('채팅 설정을 닫아도 유지할 미전송 요청');
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`));
  await openSettings(page);
  await selectChatSettingsSection(page, '이미지');
  await selectChatSettingsSection(page, '이미지');
  await expect(image).toHaveValue(originalImage);
  await selectChatSettingsSection(page, '생성 설정');
  await expect(calls).toBeHidden();
  await dialog.getByText('고급 실행 설정', { exact: true }).click();
  await expect(calls).toHaveValue(originalCalls);
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(confirm).toBeHidden();
  await expectUnchanged(request, before, writes, errors);
});

test('CSUI03 keyboard navigation and clean browser Back keep immediate reading preferences without model calls', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const { before, writes, errors } = await prepare(
    page,
    request,
    `CSUI03 ${Date.now()}`,
    nativePrompt('Synthetic navigation fixture without prompt variables.')
  );
  const dialog = await openSettings(page);
  const nav = dialog.getByRole('tablist', { name: '채팅 설정 분류', exact: true });
  const first = nav.getByRole('tab', { name: sections[0], exact: true });
  await first.focus();
  await first.press('ArrowDown');
  const prompts = nav.getByRole('tab', { name: sections[1], exact: true });
  await expect(prompts).toBeFocused();
  await expect(prompts).toHaveAttribute('aria-selected', 'true');
  await prompts.press('End');
  const last = nav.getByRole('tab', { name: sections[sections.length - 1], exact: true });
  await expect(last).toBeFocused();
  await expect(nav.locator('[tabindex="0"]')).toHaveCount(1);
  await expect(dialog.getByLabel('새 원고의 기본 보기', { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole('combobox', { name: '이미지 배치 담당', exact: true })
  ).toBeVisible();
  await expect(dialog.getByLabel('번역 이미지 자동 배치', { exact: true })).toHaveCount(0);
  await last.focus();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await expect(dialog.getByRole('tabpanel')).toBeFocused();
  await expect(
    dialog.getByRole('combobox', { name: '이미지 배치 담당', exact: true })
  ).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(
    dialog.getByRole('navigation', { name: '채팅 설정 분류', exact: true })
  ).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await openSettings(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.chat-menu > summary')).toBeFocused();
  await openChatMenu(page);
  await page.getByRole('button', { name: '읽기 설정', exact: true }).click();
  const reading = page.getByRole('dialog', { name: '읽기 설정', exact: true });
  const focusStart = reading.getByRole('button', { name: '집중 읽기 시작', exact: true });
  await expect(focusStart).toBeVisible();
  await reading.getByLabel('새 원고의 기본 보기', { exact: true }).selectOption('original');
  await reading.getByLabel('본문 글꼴', { exact: true }).selectOption('serif');
  const navigatorToggle = reading.getByRole('switch', {
    name: '장면 내비게이터 표시',
    exact: true,
  });
  await expect(navigatorToggle).toBeChecked();
  await navigatorToggle.click();
  await expect(navigatorToggle).not.toBeChecked();
  await expect(reading.getByLabel('화면 테마', { exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => [
        localStorage.getItem('uimori:reading-language'),
        localStorage.getItem('uimori:font'),
        localStorage.getItem('uimori:scene-navigator'),
      ])
    )
    .toEqual(['original', 'serif', 'false']);
  await page.keyboard.press('Escape');
  await expect(reading).toBeHidden();
  await openChatMenu(page);
  await page.getByRole('button', { name: '읽기 설정', exact: true }).click();
  await expect(reading.getByLabel('새 원고의 기본 보기', { exact: true })).toHaveValue('original');
  await expect(reading.getByLabel('본문 글꼴', { exact: true })).toHaveValue('serif');
  await expect(
    reading.getByRole('switch', { name: '장면 내비게이터 표시', exact: true })
  ).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(reading).toBeHidden();
  await expectUnchanged(request, before, writes, errors);
});

test('CSUI04 quick persona and chat settings share persisted attachments and none preserves the composer', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const title = `CSUI04 persona ${Date.now()}`;
  const seeded = await request.post('/api/content', {
    data: {
      kind: 'persona',
      title,
      description: 'Synthetic persona',
      text: 'CSUI04_PERSONA',
      loading: 'pinned',
      relatedIds: [],
      package: nativeContent(
        {
          name: title,
          description: 'CSUI04_PERSONA',
          character_book: {
            entries: [
              {
                id: 'identity',
                comment: '오래된 항구의 안내인',
                content: 'CSUI04_IDENTITY',
                constant: true,
                enabled: true,
              },
              {
                id: 'harbor',
                comment: '안개가 짙은 날의 항구',
                content: 'CSUI04_HARBOR',
                constant: false,
                enabled: true,
                keys: ['harbor'],
              },
            ],
          },
        },
        {},
        'persona'
      ),
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  const persona = await seeded.json();
  const { chat, errors } = await prepare(page, request, title);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('페르소나를 바꿔도 보존할 요청 초안');
  const quick = page.getByRole('button', { name: '빠른 페르소나', exact: true });
  const picker = page.getByRole('dialog', { name: '빠른 페르소나', exact: true });
  const read = async () =>
    (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const selected = async () =>
    (await read()).profile!.packageAttachments?.filter((ref) => ref.role === 'persona') ?? [];
  async function choosePersona(none = false) {
    if (!(await quick.isVisible()))
      await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await quick.click();
    if (none) await picker.getByRole('button', { name: '페르소나 없음', exact: true }).click();
    else {
      await picker.getByRole('searchbox').fill(title);
      await picker
        .getByRole('button')
        .filter({ has: page.getByText(title, { exact: true }) })
        .click();
    }
    await expect(picker).toBeHidden();
    await expect
      .poll(selected)
      .toEqual(none ? [] : [{ id: persona.id, revision: persona.revision, role: 'persona' }]);
    await expect(composer).toHaveValue('페르소나를 바꿔도 보존할 요청 초안');
  }
  await choosePersona();
  const dialog = await openSettings(page);
  await selectChatSettingsSection(page, sections[0]);
  await expect(
    dialog.getByRole('checkbox', { name: '본문에서 페르소나 참조', exact: true })
  ).toHaveCount(0);
  const attached = dialog
    .locator('.package-attachment')
    .filter({ has: page.getByRole('button', { name: '페르소나', exact: true }) });
  await expect(attached).toBeVisible();
  await expect(attached.getByText(title, { exact: true })).toHaveCount(1);
  await expect(attached.getByRole('button', { name: '페르소나', exact: true })).toContainText(
    title
  );
  await expect(attached.locator('summary')).toHaveText('로어 2개');
  await attached.locator('summary').click();
  await expect(attached.getByText('오래된 항구의 안내인', { exact: true })).toBeVisible();
  await expect(attached.getByText('항상 포함', { exact: true })).toBeVisible();
  await expect(attached.getByText('안개가 짙은 날의 항구', { exact: true })).toBeVisible();
  await expect(attached.getByText('필요할 때 읽기', { exact: true })).toBeVisible();
  await attached.getByRole('button', { name: `${title} 선택 해제`, exact: true }).click();
  await dialog.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
  const completion = page
    .locator('.transient-notice')
    .filter({ hasText: '채팅 설정을 저장했어요.' });
  await expect(completion).toBeVisible();
  await expect(completion.getByRole('button')).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('saved-settings-notice.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await expect(completion).toBeVisible();
  await expect(completion).toHaveCount(0, { timeout: 6000 });
  await expect.poll(selected).toEqual([]);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await expect(quick).toContainText('페르소나 없음');
  await choosePersona();
  await choosePersona(true);
  await page.reload();
  await expect(composer).toBeVisible();
  const reopened = await openSettings(page);
  await selectChatSettingsSection(page, sections[0]);
  await expect(reopened.getByRole('button', { name: '페르소나', exact: true })).toContainText(
    '선택 안 함'
  );
  await expect(reopened.getByText(title, { exact: true })).toHaveCount(0);
  expect(await selected()).toEqual([]);
  const after = await read();
  expect(after.runs).toHaveLength(0);
  expect(after.attempts ?? []).toHaveLength(0);
  expect(errors).toEqual([]);
});

{
  const mainId = 'missing-model';
  test(`CSUI06 unavailable model offers a visible resolution and guards chat drafts`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
    await page.route('**/api/prompt-workspace', async (route) => {
      const response = await route.fetch();
      const workspace = await response.json();
      await route.fulfill({
        response,
        json: {
          ...workspace,
          modelRoutes: { ...workspace.modelRoutes, main: { id: mainId } },
        },
      });
    });
    const { before, writes, errors } = await prepare(page, request, `CSUI06 ${Date.now()}`);
    const composer = page.getByLabel('다음 장면 요청', { exact: true });
    await composer.fill('모델 설정으로 이동해도 남길 요청 초안');
    const dialog = await openSettings(page);
    await selectChatSettingsSection(page, '생성 설정');
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('선택한 본문 모델을 사용할 수 없어');
    const repair = dialog.getByRole('button', { name: '역할별 모델', exact: true });
    await repair.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await expect(repair).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('model-resolution.png') });

    await selectChatSettingsSection(page, '이미지');
    const image = dialog.getByRole('combobox', { name: '이미지 배치 담당', exact: true });
    const original = await image.inputValue();
    const draft = original === 'jev' ? 'writer' : 'jev';
    await image.selectOption(draft);
    await selectChatSettingsSection(page, '생성 설정');
    await repair.click();
    const guard = page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true });
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(repair).toBeFocused();
    await selectChatSettingsSection(page, '이미지');
    await expect(image).toHaveValue(draft);
    await selectChatSettingsSection(page, '생성 설정');
    await repair.click();
    await guard.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
    await expect(dialog).toBeHidden();
    const global = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(global.getByLabel('본문 모델', { exact: true })).toBeVisible();
    await expect
      .poll(() => global.evaluate((node) => node.contains(document.activeElement)))
      .toBe(true);
    await global.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await expect(composer).toHaveValue('모델 설정으로 이동해도 남길 요청 초안');
    await expectUnchanged(request, before, writes, errors);
  });
}

test('CSUI05 save and close persists a valid user note and keeps an invalid note draft open', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1440 });
  const { chat, errors } = await prepare(page, request, `CSUI05 ${Date.now()}`);
  const noteText = `저장하고 닫기 메모 ${Date.now()}`;
  const readStory = async () => {
    const response = await request.get(`/api/chats/${chat.id}/story`);
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()) as StoryDetail;
  };
  const confirm = page.getByRole('alertdialog', {
    name: '미저장 채팅 설정 확인',
    exact: true,
  });

  let dialog = await openSettings(page);
  await selectChatSettingsSection(page, '기억과 메모');
  let notes = dialog.getByTestId('context-notes');
  await expect(notes).toBeVisible();
  await notes.locator(':scope > summary').click();
  await notes.getByRole('button', { name: '메모 추가', exact: true }).click();
  await notes.getByLabel('메모와 정정 내용', { exact: true }).fill(noteText);
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => (await readStory()).notes.map((note) => note.text))
    .toEqual([noteText]);

  dialog = await openSettings(page);
  await selectChatSettingsSection(page, '기억과 메모');
  notes = dialog.getByTestId('context-notes');
  await expect(notes).toBeVisible();
  await notes.locator(':scope > summary').click();
  await notes.getByRole('button', { name: '메모 추가', exact: true }).click();
  await notes.getByLabel('메모와 정정 내용', { exact: true }).fill('   ');
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(confirm.getByRole('alert')).toContainText('저장하지 못했어요');
  await expect(confirm).toBeVisible();
  expect((await readStory()).notes.map((note) => note.text)).toEqual([noteText]);
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '메모와 정정 내용', exact: true })).toHaveValue(
    '   '
  );
  await notes.getByRole('button', { name: '편집 취소', exact: true }).click();
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test('CSUI08 automatic translation toggle persists per chat and reopens without starting a job', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const { chat, errors } = await prepare(page, request, 'CSUI08 ' + Date.now());
  let dialog = await openSettings(page);
  await selectChatSettingsSection(page, '생성 설정');
  const globalDefault = (await (await request.get('/api/auto-translation-defaults')).json()) as {
    autoTranslate: boolean;
  };
  let choice = dialog.getByRole('combobox', { name: '본문 생성 후 자동 번역', exact: true });
  await expect(choice.locator('option[value="inherit"]')).toHaveText(
    `기본값 따르기: ${globalDefault.autoTranslate ? '켜짐' : '꺼짐'}`
  );
  await expect(choice).toHaveValue('inherit');
  await choice.selectOption('on');
  await dialog.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
  const read = async () =>
    (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  await expect.poll(async () => (await read()).chat.settings.autoTranslate).toBe(true);
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  dialog = await openSettings(page);
  await selectChatSettingsSection(page, '생성 설정');
  choice = dialog.getByRole('combobox', { name: '본문 생성 후 자동 번역', exact: true });
  await expect(choice).toHaveValue('on');
  await choice.selectOption('off');
  await dialog.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
  await expect.poll(async () => (await read()).chat.settings.autoTranslate).toBe(false);
  await choice.selectOption('inherit');
  await dialog.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
  await expect.poll(async () => (await read()).chat.settings.autoTranslate).toBeUndefined();
  expect((await read()).jobs).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('CSUI10 original-work reference preserves optional settings, last brief and authored corrections', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const { chat, errors } = await prepare(page, request, `CSUI10 ${Date.now()}`);
  const base = `/api/chats/${chat.id}/story-guide`;
  const lastBrief = '지난 집필에서는 두 인물의 불신을 참고했어요.';
  await page.route(`**${base}`, async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as StoryGuideDetail;
    await route.fulfill({
      response,
      json: {
        ...data,
        brief: {
          fingerprint: 'ui-fixture',
          text: lastBrief,
          createdAt: '2026-01-01T12:00:00.000Z',
          parentRevision: null,
          configRevision: 0,
          modelTitle: '이전 집필 모델',
          webSearch: {
            performed: true,
            sources: [{ url: 'https://example.com/canon', title: '원작 공식 자료' }],
            searchEntryPoint: '<a href="https://example.com/search">검색 제안</a>',
          },
        },
      },
    });
  });
  await page.getByLabel('다음 장면 요청', { exact: true }).fill('두 사람이 다시 만나는 장면');
  const menu = await openChatMenu(page);
  await menu.getByRole('button', { name: '원작 참고', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await expect(
    dialog.getByRole('heading', { name: '작품 및 원작 참고', exact: true })
  ).toBeVisible();
  await expect(dialog.getByRole('switch', { name: '집필 전에 원작 참고' })).not.toBeChecked();
  await expect(dialog.locator('.story-guide-settings')).toHaveAttribute('open', '');
  await dialog.getByRole('switch', { name: '집필 전에 원작 참고' }).check();
  const search = dialog.getByRole('checkbox', { name: '원작 정보를 웹에서 확인' });
  await expect(search).not.toBeChecked();
  await expect(
    dialog.getByText('검색 비용이 추가될 수 있고, 기준 시점 이후의 내용이 포함될 수 있어요.')
  ).toHaveCount(0);
  await search.check();
  await dialog.getByLabel('작품, 판본, 세계관', { exact: true }).fill('가상의 항구 이야기');
  await dialog.getByLabel('기준 시점과 스포일러 범위', { exact: true }).fill('2권 끝까지');
  await selectChatSettingsSection(page, '이미지');
  await selectChatSettingsSection(page, '작품 및 원작 참고');
  await expect(dialog.getByLabel('작품, 판본, 세계관', { exact: true })).toHaveValue(
    '가상의 항구 이야기'
  );
  await expect(search).toBeChecked();
  await page.screenshot({ path: info.outputPath('story-guide-search-mobile.png') });
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  const discard = page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = (await (await request.get(base)).json()) as StoryGuideDetail;
  expect(saved.config).toMatchObject({
    enabled: true,
    work: '가상의 항구 이야기',
    position: '2권 끝까지',
    followCanon: false,
    webSearch: true,
  });

  await (await openChatMenu(page)).getByRole('button', { name: '원작 참고', exact: true }).click();
  await expect(dialog.locator('.story-guide-settings')).not.toHaveAttribute('open');
  await expect(dialog.getByLabel('작품, 판본, 세계관', { exact: true })).toBeHidden();
  await expect(dialog.getByRole('button', { name: '미리보기 만들기', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: '원작·인물 질문', exact: true })).toHaveCount(0);
  await dialog.locator('.story-guide-last-brief > summary').click();
  await expect(dialog.getByLabel('마지막 집필 참고문 내용', { exact: true })).toContainText(
    lastBrief
  );
  await expect(dialog.getByText(/이전 설정으로 만든 참고문/)).toBeVisible();
  await expect(dialog.getByRole('link', { name: '원작 공식 자료' })).toHaveAttribute(
    'href',
    'https://example.com/canon'
  );
  await expect(dialog.locator('iframe')).toHaveCount(0);
  await selectChatSettingsSection(page, '기억과 메모');
  const notes = dialog.getByTestId('context-notes');
  if ((await notes.evaluate((node) => node.tagName)) === 'DETAILS')
    await notes.locator(':scope > summary').click();
  await notes.getByRole('button', { name: '메모 추가', exact: true }).click();
  await notes
    .getByLabel('메모와 정정 내용', { exact: true })
    .fill('이 이야기에서는 두 사람이 화해했다.');
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await discard.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  const story = (await (await request.get(`/api/chats/${chat.id}/story`)).json()) as StoryDetail;
  expect(story.notes).toHaveLength(1);
  expect(story.notes[0]).toMatchObject({
    kind: 'author-note',
    text: '이 이야기에서는 두 사람이 화해했다.',
  });
  await (await openChatMenu(page)).getByRole('button', { name: '원작 참고', exact: true }).click();
  await expect(dialog.getByLabel('가이드 미리보기', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('원작 질문 답변', { exact: true })).toHaveCount(0);
  await expectNoOverflow(page, dialog);
  if (visualReview) {
    await page.screenshot({ path: info.outputPath('story-guide-mobile.png') });
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await expectNoOverflow(page, dialog);
    await page.screenshot({ path: info.outputPath('story-guide-desktop.png') });
  }
  expect(errors).toEqual([]);
});

test('CSUI11 the translation result language saves from general settings at phone and desktop widths', async ({
  page,
  request,
}, info) => {
  const stored = async () =>
    (
      (await (await request.get('/api/auto-translation-defaults')).json()) as {
        translationLanguage: string | null;
      }
    ).translationLanguage;
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
    const language = page.getByRole('combobox', { name: '번역 결과 언어', exact: true });
    await expect(language).toHaveValue('ko');
    await language.selectOption('zh');
    await expect.poll(stored).toBe('zh');
    await language.selectOption({ label: '항상 번역' });
    await expect.poll(stored).toBeNull();
    await expect(language).toBeEnabled();
    await language.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`translation-language-${width}.png`) });
    await language.selectOption('ko');
    await expect.poll(stored).toBe('ko');
    await expect(language).toBeEnabled();
  }
});
