import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { PromptPreset, SavedPromptCombination } from '../core/product.js';
import type { PromptProgram } from '../core/prompt-program.js';

export async function visibleNavigation(page: Page) {
  let nav = page.getByTestId('bot-navigation').filter({ visible: true });
  if (!(await nav.count())) {
    await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    nav = page.getByTestId('bot-navigation').filter({ visible: true });
  }
  await expect(nav).toBeVisible();
  return nav;
}
export async function navigationAction(page: Page, name: string, botTitle?: string) {
  const dialog = page.getByRole('dialog').filter({ visible: true });
  if (await dialog.count()) await page.keyboard.press('Escape');
  if (name === '작업 현황') {
    // The sidebar shows tasks only while something runs; the chat ⋯ menu always has the panel.
    await openChatMenu(page);
    await page.getByRole('button', { name: '작업 현황', exact: true }).click();
    return;
  }
  const nav = await visibleNavigation(page);
  if (name === '새 채팅' || name === '새 이야기') {
    // Bots without chats intentionally live only in the library. Use that shared entry point.
    await navigationAction(page, '서재');
    const library = page.getByTestId('library-panel');
    await library.getByRole('tab', { name: '봇', exact: true }).click();
    if (botTitle) await library.getByLabel('서재 검색', { exact: true }).fill(botTitle);
    const start = botTitle
      ? library.getByRole('button', { name: `${botTitle} 새 채팅`, exact: true })
      : library
          .locator('.library-list-item')
          .getByRole('button', { name: / 새 채팅$/ })
          .first();
    await start.click();
    return;
  }
  const libraryTab = ['봇', '페르소나', '모듈'].includes(name);
  if (libraryTab || name === '서재' || name === '프롬프트') {
    const menu = nav.locator('.sidebar-app-menu');
    if ((await menu.getAttribute('open')) === null)
      await menu.getByLabel('앱 메뉴', { exact: true }).click();
  }
  await nav.getByRole('button', { name: libraryTab ? '서재' : name, exact: true }).click();
  if (libraryTab)
    await page.getByTestId('library-panel').getByRole('tab', { name, exact: true }).click();
}
export async function selectSettingsSection(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(dialog).toBeVisible();
  const back = dialog.getByRole('button', { name: '설정 목록으로', exact: true });
  if (await back.isVisible()) await back.click();
  const navigation = dialog.locator('.settings-navigation').filter({ visible: true });
  await expect(navigation).toBeVisible();
  const tab = navigation.getByRole('tab', { name, exact: true });
  if (await tab.isVisible()) await tab.click();
  else await navigation.getByRole('button', { name, exact: true }).click();
}
export async function selectChatSettingsSection(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.chat-settings-panel')).toBeVisible();
  const back = dialog.getByRole('button', { name: '채팅 설정 목록으로', exact: true });
  if (await back.isVisible()) await back.click();
  const navigation = dialog.locator('.section-navigation').filter({ visible: true });
  await expect(navigation).toBeVisible();
  const tab = navigation.getByRole('tab', { name, exact: true });
  if (await tab.isVisible()) await tab.click();
  else await navigation.getByRole('button', { name, exact: true }).click();
}
export async function selectPackageSection(page: Page, name: string) {
  const fields = page.getByTestId('package-fields');
  await expect(fields).toBeVisible();
  // The list/detail split follows a media query, so right after a resize the previous layout is
  // still mounted. Reading the back button then races React and clicks an element about to go.
  await expect(fields.locator('.package-editor-layout')).toHaveAttribute(
    'data-compact',
    String((page.viewportSize()?.width ?? 0) <= 760)
  );
  const back = fields.getByRole('button', { name: '패키지 분야 목록', exact: true });
  if (await back.isVisible()) await back.click();
  const tab = fields.getByRole('tab', { name, exact: true });
  if (await tab.isVisible()) await tab.click();
  else await fields.getByRole('button', { name, exact: true }).click();
}
/** Opens the chat header's ⋯ menu (fork, reading settings, tasks, archived branches). */
export async function openChatMenu(page: Page) {
  const menu = page.locator('.chat-menu');
  if ((await menu.getAttribute('open')) === null) await menu.getByLabel('채팅 메뉴').click();
  return menu.locator('.action-menu-body');
}
export async function openSourceActions(source: Locator) {
  const menu = source.getByLabel('장면 작업 메뉴', { exact: true });
  await expect(menu).toBeVisible();
  if (!(await menu.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await menu.click();
  return menu;
}
export async function openPromptActions(editor: Locator) {
  const menu = editor.getByLabel('프롬프트 관리', { exact: true });
  await expect(menu).toBeVisible();
  if (!(await menu.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await menu.click();
}
export async function openPromptTools(editor: Locator) {
  const menu = editor.getByLabel('프롬프트 구성 도구', { exact: true });
  await expect(menu).toBeVisible();
  if (!(await menu.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await menu.click();
}
export async function openPromptBlocks(editor: Locator) {
  const fold = editor.getByLabel('프롬프트 블록 접기/펼치기', { exact: true });
  await expect(fold).toBeVisible();
  if (!(await fold.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await fold.click();
}
export async function startProviderConnection(page: Page) {
  const editor = page.getByTestId('connection-editor');
  await expect(editor).toBeVisible();
  const start = editor.getByRole('button', { name: '프로바이더 추가', exact: true });
  if (await start.isVisible()) await start.click();
  else {
    await editor.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
    await editor.getByRole('button', { name: '새 프로바이더 입력', exact: true }).click();
  }
  await expect(editor.getByRole('region', { name: '제공자 선택', exact: true })).toBeVisible();
}
export async function openProviderMenu(page: Page, kind: '모델' | '프로바이더', title: string) {
  const menu = page
    .getByTestId('connection-editor')
    .getByLabel(`${title} ${kind} 메뉴`, { exact: true });
  await expect(menu).toBeVisible();
  if (!(await menu.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await menu.click();
}
export async function revealProviderDiagnostics(page: Page, title: string) {
  const card = page.getByRole('article', { name: `${title} 모델`, exact: true });
  await expect(card.getByText('진단과 상세', { exact: true })).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: `${title} 응답 테스트`, exact: true })
  ).toBeVisible();
}
export async function editLibraryContent(page: Page, title: string) {
  await page.getByRole('button', { name: `${title} 상세 보기`, exact: true }).click();
  await page
    .getByRole('region', { name: '자료 상세', exact: true })
    .getByRole('button', { name: '편집', exact: true })
    .first()
    .click();
  await revealLibraryEditor(page);
}
export async function createLibraryContent(page: Page) {
  await page
    .getByTestId('library-panel')
    .getByRole('button', { name: /^(새로 만들기|봇 만들기|페르소나 만들기|모듈 만들기)$/ })
    .click();
}
export async function revealLibraryEditor(page: Page) {
  const library = page.getByTestId('library-panel');
  await expect(library.getByLabel('자료 이름', { exact: true })).toBeVisible();
  const sections = library.locator('summary').filter({
    hasText: /^(대표 이미지 · 선택|고급 패키지 설정|분류·읽기 설정)$/,
  });
  for (const section of await sections.all()) {
    if (!(await section.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
      await section.click();
  }
  // Plain content has no package fields until the author explicitly expands its structure.
  if (await library.getByTestId('package-fields').count()) await selectPackageSection(page, '로어');
}
export async function selectContent(page: Page, label: string, title: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const picker = page.getByRole('dialog', { name: label, exact: true });
  const all = picker.getByRole('button', { name: '모든 자료', exact: true });
  if (await all.count()) await all.click();
  await picker.getByRole('searchbox', { name: `${label} 검색`, exact: true }).fill(title);
  await picker
    .locator('[data-content-choice]')
    .filter({ has: page.locator('strong').filter({ hasText: title }) })
    .first()
    .click();
}
export async function createPromptChoice(request: APIRequestContext, title: string) {
  const program: PromptProgram = {
    version: 1,
    controls: [
      { id: 'detail', label: '합성 상세도', type: 'number', default: 1, min: 0, max: 3 },
      { id: 'coNarration', label: '합성 공동 서술', type: 'boolean', default: false },
    ],
    blocks: [
      {
        id: 'instructions',
        title: '합성 지침',
        kind: 'message',
        role: 'system',
        template: [
          { kind: 'text', text: 'Synthetic detail ' },
          { kind: 'value', expression: { control: 'detail' } },
          { kind: 'text', text: '; shared narration ' },
          { kind: 'value', expression: { control: 'coNarration' } },
        ],
      },
      { id: 'history', title: '대화', kind: 'history', from: 0, to: 'end' },
    ],
  };
  const saved = await request.post('/api/prompt-presets', {
    data: { title: `${title} prompt`, role: 'main', text: '', program },
  });
  expect(saved.ok()).toBeTruthy();
  const prompt = (await saved.json()) as PromptPreset;
  const workspace = await (await request.get('/api/prompt-workspace')).json();
  expect(
    (
      await request.post('/api/prompt-workspace/apply', {
        data: { expectedRevision: workspace.revision, role: 'main', presetId: prompt.id },
      })
    ).ok()
  ).toBeTruthy();
  const response = await request.post('/api/prompt-combinations', {
    data: {
      title: `${title} choices`,
      role: 'main',
      owner: { kind: 'preset', id: prompt.id },
      expectedRevision: prompt.revision,
      values: { detail: 3, coNarration: true },
    },
  });
  expect(response.ok()).toBeTruthy();
  const combination = (await response.json()) as SavedPromptCombination;
  return { prompt, combination };
}
export async function selectStartPrompt(
  page: Page,
  choice: Awaited<ReturnType<typeof createPromptChoice>>
) {
  await openNewStoryOptions(page);
  await expect(page.getByLabel('시작 프롬프트', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('시작 옵션 조합', { exact: true })).toHaveCount(0);
  const workspace = await (await page.request.get('/api/prompt-workspace')).json();
  expect(
    (
      await page.request.post('/api/prompt-workspace/apply-options', {
        data: {
          expectedRevision: workspace.revision,
          role: 'main',
          combinationId: choice.combination.id,
        },
      })
    ).ok()
  ).toBeTruthy();
}

export async function openNewStoryOptions(page: Page) {
  const options = page
    .getByRole('dialog', { name: '새 채팅', exact: true })
    .locator('.new-story-options');
  if (!(await options.evaluate((node) => (node as HTMLDetailsElement).open)))
    await options.locator('summary').click();
}

export async function setCurrentModels(
  request: APIRequestContext,
  routes: Record<string, { id: string } | null>
) {
  const current = await (await request.get('/api/model-workspace')).json();
  const response = await request.put('/api/model-workspace', {
    data: {
      expectedRevision: current.revision,
      routes: { ...current.routes, ...routes },
      translationPolicy: current.translationPolicy,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

export async function selectCurrentSettingsSection(
  page: Page,
  name: '모델' | '프롬프트·창작 프리셋'
) {
  await navigationAction(page, '설정');
  await selectSettingsSection(page, name === '모델' ? '역할별 모델' : '현재 프롬프트');
}
/** Chat settings: a header button on wide widths, the first chat ⋯ item on compact widths. */
export async function openChatSettings(page: Page) {
  // Decided by the viewport like `useCompactLayout` (760px), so a just-resized page does not
  // race the header re-render; the click itself waits for the chosen control to appear.
  if (compactLayout(page)) {
    const menu = await openChatMenu(page);
    await menu.getByRole('button', { name: '채팅 설정', exact: true }).click();
    return;
  }
  await page
    .locator('.workspace-header')
    .getByRole('button', { name: '채팅 설정', exact: true })
    .click();
}
function compactLayout(page: Page) {
  return (page.viewportSize()?.width ?? 390) <= 760;
}
/** The helper: a header button on wide widths, a chat ⋯ item on compact widths. */
export async function openHelper(page: Page) {
  const header = page
    .locator('.workspace-header')
    .getByRole('button', { name: '도우미 열기', exact: true });
  // Compact chat screens keep the helper in the chat ⋯ menu; every other screen has the header icon.
  if (compactLayout(page) && (await page.locator('.workspace-header .chat-menu').count())) {
    const menu = await openChatMenu(page);
    await menu.getByRole('button', { name: '도우미 열기', exact: true }).click();
    return;
  }
  await header.click();
}
