import { visualReview } from './fixtures/visual-review.js';
import { test, expect, type APIRequestContext, type Page, type Locator } from '@playwright/test';
import type { Content, Library } from '../core/product.js';
import type { LibraryOrganization, LibraryFolder } from '../core/library-organization.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { navigationAction, selectContent } from './ui-navigation.js';

async function createContent(
  request: APIRequestContext,
  title: string,
  kind: Content['kind'] = 'bot'
) {
  const response = await request.post('/api/content', {
    data: {
      kind,
      title,
      description: '함께 이야기할 합성 캐릭터와 세계',
      text: 'Synthetic common body',
      loading: 'pinned',
      relatedIds: [],
      package: {
        version: 1,
        id: 'library-fixture',
        revision: 1,
        title,
        description: 'Synthetic',
        body: 'Synthetic common body',
        lore: [],
        instructions: [],
        controls: [],
        transforms: [],
      },
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Content>;
}
async function organization(request: APIRequestContext) {
  const response = await request.get('/api/library/organization');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<LibraryOrganization>;
}
async function createFolder(page: Page, panel: Locator, title: string) {
  await revealFolderActions(panel);
  await panel.getByRole('button', { name: '새 폴더', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 폴더', exact: true });
  await dialog.getByLabel('폴더 이름', { exact: true }).fill(title);
  await dialog.getByRole('button', { name: '폴더 만들기', exact: true }).click();
  await expect(dialog).toBeHidden();
  return (await organization(page.request)).folders.find((folder) => folder.title === title)!;
}
async function revealFolderActions(panel: Locator) {
  await expect(panel.locator('.library-folders')).toBeVisible();
  const summary = panel.getByLabel('폴더 관리', { exact: true });
  if (
    (await summary.isVisible()) &&
    !(await summary.evaluate((node) => (node.parentElement as HTMLDetailsElement).open))
  )
    await summary.click();
}
async function revealListOptions(panel: Locator) {
  const summary = panel.locator('.library-list-options > summary');
  if (!(await summary.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await summary.click();
}
async function chooseFolder(panel: Locator, title: string) {
  if ((await panel.getAttribute('data-testid')) === 'library-panel') {
    await panel
      .getByRole('navigation', { name: '서재 위치', exact: true })
      .getByRole('button', { name: '전체', exact: true })
      .click();
    if (title !== '전체')
      await panel.getByRole('button', { name: `${title} 폴더 열기`, exact: true }).click();
    return;
  }
  const mobile = panel.getByRole('combobox', { name: '폴더 선택', exact: true });
  await expect(panel.locator('.library-folder-mobile select')).toBeAttached();
  if (await mobile.isVisible()) {
    const options = await mobile.locator('option').allTextContents();
    const label = options.find((value) => value.startsWith(`${title} (`))!;
    await mobile.selectOption({ label });
  } else
    await panel
      .locator('.library-folder-choice')
      .filter({ has: panel.page().locator('span', { hasText: new RegExp(`^${title}$`) }) })
      .click();
}
async function moveItems(
  page: Page,
  panel: Locator,
  titles: string[],
  category: string,
  folder: LibraryFolder | null
) {
  await revealListOptions(panel);
  await panel.getByRole('button', { name: '선택', exact: true }).click();
  for (const title of titles)
    await panel.getByRole('checkbox', { name: `${title} 선택`, exact: true }).check();
  await panel.getByRole('button', { name: '선택한 자료 이동', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '자료 이동', exact: true });
  await dialog.getByLabel('이동할 분류', { exact: true }).selectOption(category);
  await dialog.getByLabel('이동할 폴더', { exact: true }).selectOption(folder?.id ?? '');
  await dialog.getByRole('button', { name: '이동', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('LIBUI01 library folders move and classify without changing revisions or owned chats', async ({
  page,
  request,
}, info) => {
  const prefix = `LIBUI01 ${Date.now()}`;
  const a = await createContent(request, `${prefix} Alpha`),
    b = await createContent(request, `${prefix} Beta`);
  const chat = await (
    await request.post('/api/chats', { data: { title: `${prefix} saved chat`, botId: a.id } })
  ).json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  await expect(panel.getByRole('tab')).toHaveText(['봇', '페르소나', '모듈']);
  const folder = await createFolder(page, panel, `${prefix} Adventure`);
  const otherFolder = await createFolder(page, panel, `${prefix} Draft`);
  // Folder actions live in the manage menu next to the dropdown and apply to the chosen folder.
  await chooseFolder(panel, otherFolder.title);
  await revealFolderActions(panel);
  await panel.getByRole('button', { name: '위로', exact: true }).click();
  await expect
    .poll(async () =>
      (await organization(request)).folders
        .filter((item) => item.category === 'bot')
        .sort((a, b) => a.sortPosition - b.sortPosition)
        .map((item) => item.id)
        .indexOf(otherFolder.id)
    )
    .toBeLessThan(
      (await organization(request)).folders.filter((item) => item.category === 'bot').length
    );
  const ordered = (await organization(request)).folders
    .filter((item) => item.category === 'bot')
    .sort((a, b) => a.sortPosition - b.sortPosition);
  expect(ordered.findIndex((item) => item.id === otherFolder.id)).toBeLessThan(
    ordered.findIndex((item) => item.id === folder.id)
  );
  await chooseFolder(panel, '전체');
  await panel.getByLabel('서재 검색', { exact: true }).fill(prefix);
  await moveItems(page, panel, [a.title, b.title], 'bot', folder);
  await chooseFolder(panel, folder.title);
  await expect(panel.locator('.library-open-content')).toHaveCount(2);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('library-bot-cards-desktop.png') });
  await panel.getByRole('tab', { name: '페르소나', exact: true }).click();
  const personas = await createFolder(page, panel, `${prefix} People`);
  await panel.getByRole('tab', { name: '봇', exact: true }).click();
  await chooseFolder(panel, folder.title);
  await moveItems(page, panel, [a.title], 'persona', personas);
  const revision = await (await request.get(`/api/revisions/content/${a.id}/${a.revision}`)).json();
  expect(revision).toEqual(a);
  const currentChat = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(currentChat.chat.botId).toBe(a.id);
  await panel.getByRole('tab', { name: '페르소나', exact: true }).click();
  await chooseFolder(panel, personas.title);
  await expect(
    panel.getByRole('button', { name: `${a.title} 상세 보기`, exact: true })
  ).toBeVisible();
  await expect(panel.locator('.library-list-item')).toHaveCount(1);
  await revealListOptions(panel);
  await panel.getByRole('button', { name: '카드', exact: true }).click();
  await page.reload();
  await page
    .getByTestId('library-panel')
    .getByRole('tab', { name: '페르소나', exact: true })
    .click();
  await revealListOptions(panel);
  await expect(panel.getByRole('button', { name: '카드', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await chooseFolder(panel, personas.title);
  await expect(
    panel.getByRole('button', { name: `${a.title} 상세 보기`, exact: true })
  ).toBeVisible();
});

test('LIBUI02 mobile folder deletion refreshes another page and stale moves require review', async ({
  page,
  request,
  context,
}, info) => {
  const prefix = `LIBUI02 ${Date.now()}`;
  const item = await createContent(request, `${prefix} Character`);
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  const folder = await createFolder(page, panel, `${prefix} Folder`);
  await chooseFolder(panel, '전체');
  await panel.getByLabel('서재 검색', { exact: true }).fill(prefix);
  await moveItems(page, panel, [item.title], 'bot', folder);
  await chooseFolder(panel, folder.title);
  const other = await context.newPage();
  await other.goto('/');
  const otherPanel = other.getByTestId('library-panel');
  await chooseFolder(otherPanel, folder.title);
  await revealListOptions(otherPanel);
  await otherPanel.getByRole('button', { name: '선택', exact: true }).click();
  await otherPanel.getByRole('checkbox', { name: `${item.title} 선택`, exact: true }).check();
  await page.bringToFront();
  if (visualReview) await page.screenshot({ path: info.outputPath('library-folders-mobile.png') });
  await revealFolderActions(panel);
  await panel.getByRole('button', { name: `${folder.title} 폴더 삭제`, exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
  await expect(confirm).toContainText('미분류');
  await confirm.getByRole('button', { name: '영구 삭제', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(otherPanel.getByRole('checkbox', { name: `${item.title} 선택` })).toHaveCount(1);
  await expect(
    otherPanel.getByRole('button', { name: `${item.title} 선택`, exact: true })
  ).toBeVisible();
  expect(
    (await organization(request)).items.find((entry) => entry.id === item.id)?.folderId
  ).toBeNull();
  await expect(
    panel.getByRole('button', { name: `${item.title} 상세 보기`, exact: true })
  ).toBeVisible();
  await panel.getByLabel(`${item.title} 메뉴`, { exact: true }).click();
  await panel.getByRole('button', { name: '분류·폴더 이동', exact: true }).click();
  const move = page.getByRole('dialog', { name: '자료 이동', exact: true });
  await move.getByLabel('이동할 분류').selectOption('module');
  const before = await organization(request);
  expect(
    (
      await request.post('/api/library/folders', {
        data: {
          expectedRevision: before.revision,
          category: 'module',
          title: `${prefix} Concurrent`,
        },
      })
    ).ok()
  ).toBe(true);
  await move.getByRole('button', { name: '이동', exact: true }).click();
  await expect(move.getByRole('button', { name: '최신 상태 확인', exact: true })).toBeVisible();
  expect((await organization(request)).items.find((entry) => entry.id === item.id)?.category).toBe(
    'bot'
  );
  await move.getByRole('button', { name: '최신 상태 확인', exact: true }).click();
  await move.getByRole('button', { name: '이동', exact: true }).click();
  await expect(move).toBeHidden();
  await expect(
    otherPanel.getByRole('checkbox', { name: `${item.title} 선택`, exact: true })
  ).toHaveCount(0);
  await other.close();
});

test('LIBUI03 prompts have independent folders and unsaved edits survive a cancelled navigation', async ({
  page,
  request,
}, info) => {
  const prefix = `LIBUI03 ${Date.now()}`;
  const prompt = await (
    await request.post('/api/prompt-presets', {
      data: {
        title: prefix,
        role: 'main',
        program: createDefaultPromptProgram('Synthetic instructions', 'main'),
      },
    })
  ).json();
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const panel = page.getByTestId('prompt-library');
  await expect(page.getByTestId('library-panel')).toHaveCount(0);
  const folder = await createFolder(page, panel, `${prefix} Presets`);
  await chooseFolder(panel, '전체');
  await panel.getByLabel('프롬프트 검색', { exact: true }).fill(prefix);
  await panel.getByLabel(`${prefix} 메뉴`, { exact: true }).click();
  await panel.getByRole('button', { name: '폴더 이동', exact: true }).click();
  const move = page.getByRole('dialog', { name: '자료 이동', exact: true });
  await expect(move.getByLabel('이동할 분류')).toBeDisabled();
  await move.getByLabel('이동할 폴더').selectOption(folder.id);
  await move.getByRole('button', { name: '이동', exact: true }).click();
  await expect(move).toBeHidden();
  await chooseFolder(panel, folder.title);
  await panel.getByRole('button', { name: `${prefix} 프롬프트 편집`, exact: true }).click();
  await panel.getByLabel('프롬프트 이름', { exact: true }).fill(`${prefix} Unsaved`);
  await navigationAction(page, '서재');
  const guard = page.getByRole('dialog', { name: '편집 중인 자료', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeHidden();
  await expect(panel.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(`${prefix} Unsaved`);
  await panel.getByRole('button', { name: '저장', exact: true }).click();
  await expect
    .poll(
      async () =>
        ((await (await request.get('/api/library')).json()) as Library).promptPresets?.find(
          (item) => item.id === prompt.id
        )?.revision
    )
    .toBe(2);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-management-mobile.png') });
  expect((await organization(request)).items.find((item) => item.id === prompt.id)?.folderId).toBe(
    folder.id
  );
  await panel.getByLabel('프롬프트 이름', { exact: true }).fill(`${prefix} Discard this draft`);
  await navigationAction(page, '서재');
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '초안 버리고 이동', exact: true }).click();
  await expect(page.getByTestId('library-panel')).toBeVisible();
  expect(
    await (await request.get(`/api/edit-drafts?editorKey=prompt-preset:${prompt.id}`)).json()
  ).toEqual([]);
  await navigationAction(page, '프롬프트');
  await panel.getByRole('button', { name: `${prefix} Unsaved 프롬프트 편집`, exact: true }).click();
  await expect(panel.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(`${prefix} Unsaved`);
});

test('LIBUI04 role selection creates a chat with the selected persona and module without reclassifying them', async ({
  page,
  request,
}) => {
  const prefix = `LIBUI04 ${Date.now()}`;
  const bot = await createContent(request, `${prefix} Host`);
  const persona = await createContent(request, `${prefix} Player`, 'module');
  const module = await createContent(request, `${prefix} World`, 'persona');
  await page.goto('/');
  await page.getByTestId('library-panel').getByRole('tab', { name: '모듈', exact: true }).click();
  await page
    .getByTestId('library-panel')
    .getByRole('button', { name: `${persona.title} 상세 보기`, exact: true })
    .click();
  // Other roles live in the detail's ⋯ menu; the primary action is the item's own category.
  await page
    .getByTestId('library-panel')
    .getByLabel(`${persona.title} 메뉴`, { exact: true })
    .click();
  await page
    .getByTestId('library-panel')
    .getByRole('button', { name: '페르소나로 사용', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await dialog.locator('.new-story-options > summary').click();
  await selectContent(page, '시작할 봇', bot.title);
  await expect(dialog.getByRole('button', { name: '시작 페르소나', exact: true })).toContainText(
    persona.title
  );
  await selectContent(page, '추가할 시작 모듈', module.title);
  await dialog.getByLabel('새 채팅 이름', { exact: true }).fill(prefix);
  await expect(dialog.getByText('시작 자료를 불러오는 중이에요…', { exact: true })).toBeHidden();
  const created = page.waitForResponse(
    (response) => /\/api\/chats$/.test(response.url()) && response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  const chat = await (await created).json();
  await expect(dialog).toBeHidden();
  const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(detail.profile.packageAttachments).toEqual(
    expect.arrayContaining([
      { id: bot.id, revision: 1, role: 'bot' },
      { id: persona.id, revision: 1, role: 'persona' },
      { id: module.id, revision: 1, role: 'module' },
    ])
  );
  expect(detail.runs).toHaveLength(0);
  expect((await (await request.get(`/api/revisions/content/${persona.id}/1`)).json()).kind).toBe(
    'module'
  );
  expect((await (await request.get(`/api/revisions/content/${module.id}/1`)).json()).kind).toBe(
    'persona'
  );
});

test('LIBUI05 accepted folder creation closes even when the summary refresh fails', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  await revealFolderActions(panel);
  await expect(panel.getByRole('button', { name: '새 폴더', exact: true })).toBeEnabled();
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/library/folders')) writes++;
  });
  await page.route('**/api/library?view=summary', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'synthetic summary failure' }),
    })
  );
  const title = `LIBUI05 ${Date.now()}`;
  await createFolder(page, panel, title);
  await expect(page.getByRole('dialog', { name: '새 폴더', exact: true })).toBeHidden();
  await expect(page.getByText(/변경은 저장됐어요/)).toBeVisible();
  expect(writes).toBe(1);
  expect(
    (await organization(request)).folders.filter((folder) => folder.title === title)
  ).toHaveLength(1);
});

for (const width of [390, 1440]) {
  test(`LIBUI06 folder overview and scoped selection at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const prefix = `LIBUI06 ${width} ${Date.now()}`;
    const loose = await createContent(request, `${prefix} Loose`);
    const filed = await createContent(request, `${prefix} Filed`);
    const before = await organization(request);
    const created = await request.post('/api/library/folders', {
      data: { expectedRevision: before.revision, category: 'bot', title: `${prefix} Folder` },
    });
    expect(created.ok()).toBe(true);
    const folders = (await created.json()) as LibraryOrganization;
    const folder = folders.folders.find((entry) => entry.title === `${prefix} Folder`)!;
    const moved = await request.post('/api/library/organization/move', {
      data: {
        expectedRevision: folders.revision,
        items: [{ kind: 'content', id: filed.id }],
        category: 'bot',
        folderId: folder.id,
      },
    });
    expect(moved.ok()).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const panel = page.getByTestId('library-panel');
    const search = panel.getByRole('searchbox', { name: '서재 검색', exact: true });
    await expect(
      panel.getByRole('button', { name: `${folder.title} 폴더 열기`, exact: true })
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: `${loose.title} 상세 보기`, exact: true })
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: `${filed.title} 상세 보기`, exact: true })
    ).toHaveCount(0);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`library-overview-${width}.png`) });
    await search.fill(prefix);
    await expect(
      panel.getByRole('button', { name: `${filed.title} 상세 보기`, exact: true })
    ).toBeVisible();
    await expect(
      panel.locator('.library-list-item').filter({ hasText: filed.title })
    ).toContainText(folder.title);
    await revealListOptions(panel);
    await panel.getByRole('button', { name: '카드', exact: true }).click();
    await panel.getByRole('button', { name: '선택', exact: true }).click();
    const card = panel.getByRole('button', { name: `${filed.title} 선택`, exact: true });
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(
      panel.getByRole('checkbox', { name: `${filed.title} 선택`, exact: true })
    ).toBeChecked();
    await panel.getByRole('button', { name: '표시된 자료 전체 선택', exact: true }).click();
    await expect(panel.getByRole('group', { name: '자료 선택 작업', exact: true })).toContainText(
      '2개 선택'
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    ).toBeLessThanOrEqual(1);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`library-selection-${width}.png`) });
    await panel.getByRole('button', { name: '완료', exact: true }).click();
    await expect(search).toHaveValue(prefix);
    await search.fill('');
    await panel.getByLabel(`${folder.title} 폴더 메뉴`, { exact: true }).click();
    await panel.getByRole('button', { name: `${folder.title} 폴더 삭제`, exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
    await expect(confirm).toContainText('미분류');
    await confirm.getByRole('button', { name: '영구 삭제', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(
      panel.getByRole('button', { name: `${filed.title} 상세 보기`, exact: true })
    ).toBeVisible();
    expect(
      (await organization(request)).items.find((entry) => entry.id === filed.id)?.folderId
    ).toBeNull();
  });
}
