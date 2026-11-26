import { nativePrompt } from './fixtures/native-prompt.js';
import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { PromptPreset, SavedPromptCombination } from '../core/product.js';

export async function visibleNavigation(page: Page) {
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  const opener = page.getByRole('button', { name: '탐색 메뉴', exact: true });
  await expect(nav.or(opener).first()).toBeVisible();
  if (!(await nav.isVisible())) await opener.click();
  await expect(nav).toBeVisible();
  return nav;
}
export async function navigationAction(page: Page, name: string, botTitle?: string) {
  const dialog = page.getByRole('dialog').filter({ visible: true });
  if (await dialog.count()) await page.keyboard.press('Escape');
  if (name === '작업 현황') {
    await openChatMenu(page);
    await page.getByRole('button', { name: '작업 현황', exact: true }).click();
    return;
  }
  const nav = await visibleNavigation(page);
  if (name === '새 채팅' || name === '새 이야기' || name === '설정 후 새 채팅') {
    if (!botTitle)
      throw new Error(
        `navigationAction(page, '${name}') needs the bot title: the first library bot depends on files that ran earlier on the same server.`
      );
    await navigationAction(page, '서재');
    const library = page.getByTestId('library-panel');
    await library.getByRole('tab', { name: '봇', exact: true }).click();
    await library.getByLabel('서재 검색', { exact: true }).fill(botTitle);
    const item = library
      .locator('.library-list-item, .library-card')
      .filter({
        has: page.getByRole('button', { name: `${botTitle} 새 채팅`, exact: true }),
      })
      .first();
    await item.getByLabel(/ 메뉴$/).click();
    await item.getByRole('button', { name: '설정 후 새 채팅', exact: true }).click();
    return;
  }
  const libraryTab = ['봇', '페르소나', '모듈'].includes(name);
  await nav.getByRole('button', { name: libraryTab ? '서재' : name, exact: true }).click();
  if (libraryTab)
    await page.getByTestId('library-panel').getByRole('tab', { name, exact: true }).click();
}
export async function selectSettingsSection(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(dialog).toBeVisible();
  const selector = dialog.getByRole('combobox', { name: '설정 영역 선택', exact: true });
  const navigation = dialog.locator('.settings-navigation').filter({ visible: true });
  await expect(selector.or(navigation).filter({ visible: true }).first()).toBeVisible();
  if (await selector.isVisible()) {
    await selector.selectOption({ label: name });
    return;
  }
  await expect(navigation).toBeVisible();
  const tab = navigation.getByRole('tab', { name, exact: true });
  if (await tab.isVisible()) await tab.click();
  else await navigation.getByRole('button', { name, exact: true }).click();
}
export async function selectChatSettingsSection(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.chat-settings-panel')).toBeVisible();
  const selector = dialog.getByRole('combobox', { name: '설정 영역 선택', exact: true });
  const navigation = dialog.locator('.section-navigation').filter({ visible: true });
  await expect(selector.or(navigation).filter({ visible: true }).first()).toBeVisible();
  if (await selector.isVisible()) {
    await selector.selectOption({ label: name });
    return;
  }
  await expect(navigation).toBeVisible();
  const tab = navigation.getByRole('tab', { name, exact: true });
  if (await tab.isVisible()) await tab.click();
  else await navigation.getByRole('button', { name, exact: true }).click();
}
function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function sectionName(name: string) {
  return new RegExp(`^${escapeRegExp(name)}( \\d+개)?$`, 'u');
}
export function editorTab(scope: Page | Locator, name: string) {
  return scope.getByRole('tab', { name: sectionName(name) });
}
export function editorSectionPicker(scope: Page | Locator) {
  return scope.getByLabel('편집 영역 선택', { exact: true });
}

export async function discardEdits(scope: Page | Locator) {
  const page = 'viewportSize' in scope ? scope : scope.page();
  if (!compactLayout(page)) {
    await scope.getByRole('button', { name: '편집 취소', exact: true }).click();
    return;
  }
  await editorChanges(scope).click();
  await page
    .getByRole('dialog', { name: '변경 검토', exact: true })
    .getByRole('button', { name: '모든 편집 취소', exact: true })
    .click();
}

export function editorChanges(scope: Page | Locator) {
  return scope.getByRole('button', { name: /^바뀐 영역 \d+곳$/u });
}

export async function expectEditorSection(scope: Page | Locator, name: string) {
  const tab = editorTab(scope, name);
  const picker = editorSectionPicker(scope);
  await expect(tab.or(picker).first()).toBeVisible();
  if (await tab.isVisible()) await expect(tab).toHaveAttribute('aria-selected', 'true');
  else
    await expect(picker.locator('.editor-studio-picker-current')).toHaveText(
      new RegExp(`^${escapeRegExp(name)}[\\d,]*$`, 'u')
    );
}

async function editorSectionPlacement(scope: Page | Locator) {
  const studio = scope.locator('.editor-studio').first();
  await expect(studio).toBeVisible();
  return studio.evaluate((node) => {
    const placement = { shown: [] as string[], more: [] as string[] };
    for (const button of node.querySelectorAll<HTMLButtonElement>('button[id$="-tab"]'))
      placement[button.closest('.editor-studio-more') ? 'more' : 'shown'].push(
        (button.getAttribute('aria-label') ?? '').replace(/ [\d,]+개$/u, '')
      );
    return placement;
  });
}

export async function editorSectionNames(scope: Page | Locator) {
  const { shown, more } = await editorSectionPlacement(scope);
  return [...shown, ...more];
}

async function openDisclosure(summary: Locator) {
  if (!(await summary.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await summary.click();
}

export async function selectEditorSection(scope: Page | Locator, name: string) {
  const tab = editorTab(scope, name);
  const picker = editorSectionPicker(scope);
  const more = scope.locator('.editor-studio-rail .editor-studio-more > summary');
  await expect(tab.or(picker).or(more).first()).toBeVisible();
  if (await tab.isVisible()) {
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    return;
  }
  if (!(await picker.isVisible())) {
    await openDisclosure(more);
    await more
      .locator('..')
      .getByRole('button', { name: sectionName(name) })
      .click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    return;
  }
  await picker.click();
  const menu = picker.locator('..');
  const option = menu.getByRole('button', { name: sectionName(name) });
  if (!(await option.isVisible()))
    await openDisclosure(menu.locator('.editor-studio-more > summary'));
  await option.click();
  await expect(option).toBeHidden();
}

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
export async function openMoreSourceActions(source: Locator) {
  const menu = await openSourceActions(source);
  const more = menu
    .locator('..')
    .locator(':scope > .action-menu-body')
    .getByRole('button', { name: '더 보기', exact: true });
  if (await more.isVisible()) await more.click();
  await expect(
    menu
      .locator('..')
      .locator(':scope > .action-menu-body')
      .getByRole('button', { name: '접기', exact: true })
  ).toHaveAttribute('aria-expanded', 'true');
  return menu;
}
export async function sourceAction(source: Locator, name: string) {
  const button = source.getByRole('button', { name, exact: true });
  if (!(await button.isVisible())) await openSourceActions(source);
  if (!(await button.isVisible())) await openMoreSourceActions(source);
  await button.click();
}
export async function openPromptActions(editor: Locator) {
  const menu = editor.getByLabel('프롬프트 관리', { exact: true });
  await expect(menu).toBeVisible();
  if (!(await menu.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await menu.click();
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
  await expect(editor.getByRole('region', { name: '프로바이더 선택', exact: true })).toBeVisible();
}
export async function revealProviderModel(page: Page, title: string) {
  const card = page.getByRole('article', {
    name: `${title} 모델`,
    exact: true,
    includeHidden: true,
  });
  const group = page.locator('.provider-model-group').filter({ has: card });
  await expect(group).toHaveCount(1);
  if (!(await group.evaluate((node) => (node as HTMLDetailsElement).open)))
    await group.locator(':scope > summary').click();
  await expect(card).toBeVisible();
}
export async function openProviderModel(page: Page, title: string) {
  await revealProviderModel(page, title);
  await page.getByRole('button', { name: title + ' 모델 수정', exact: true }).click();
}
export async function openProviderMenu(page: Page, kind: '모델' | '프로바이더', title: string) {
  if (kind === '모델') await revealProviderModel(page, title);
  const menu = page
    .getByTestId('connection-editor')
    .getByLabel(`${title} ${kind} 메뉴`, { exact: true });
  await expect(menu).toBeVisible();
  if (!(await menu.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await menu.click();
}
export async function revealProviderDiagnostics(page: Page, title: string) {
  await openProviderMenu(page, '모델', title);
  const card = page.getByRole('article', { name: `${title} 모델`, exact: true });
  await expect(card.getByText('진단과 상세', { exact: true })).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: `${title} 응답 테스트`, exact: true })
  ).toBeVisible();
}
export async function editLibraryContent(page: Page, title: string) {
  await page.getByRole('button', { name: `${title} 편집`, exact: true }).click();
  await revealLibraryEditor(page);
}
export async function createLibraryContent(page: Page) {
  await page
    .getByTestId('library-panel')
    .getByRole('button', { name: /^(새 봇|새 페르소나|새 모듈)$/ })
    .click();
}
export async function revealLibraryEditor(page: Page) {
  const library = page.getByTestId('library-panel');
  await expect(library.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toBeVisible();
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
  const program = nativePrompt(
    'Synthetic detail {{getglobalvar::toggle_detail}}; shared narration {{getglobalvar::toggle_coNarration}}',
    {
      customPromptTemplateToggle:
        'detail=합성 상세도=text\ncoNarration=합성 공동 서술=select=Off,On',
    }
  );
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
      values: { detail: '3', coNarration: '1' },
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
  await expect(page.getByLabel('시작 옵션 프리셋', { exact: true })).toHaveCount(0);
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
  name: '역할별 모델' | '기본 프롬프트'
) {
  await navigationAction(page, '설정');
  await selectSettingsSection(page, name);
}
export async function openChatSettings(page: Page) {
  if (compactLayout(page)) {
    const menu = await openChatMenu(page);
    await menu.getByRole('button', { name: '채팅 설정', exact: true }).click();
  } else {
    await page
      .locator('.workspace-header')
      .getByRole('button', { name: '채팅 설정', exact: true })
      .click();
  }
  await expect(
    page
      .getByRole('dialog', { name: '채팅 설정', exact: true })
      .getByRole('region', { name: '채팅 설정 내용', exact: true })
  ).toBeVisible();
}
function compactLayout(page: Page) {
  return (page.viewportSize()?.width ?? MOBILE_WIDTH) <= 760;
}
export async function openHelper(page: Page) {
  const opener = page
    .locator('.workspace-header, .library-heading')
    .getByRole('button', { name: /^도우미( 열기)?$/u });
  await expect
    .poll(
      async () =>
        (await page.locator('.workspace-header .chat-menu').count()) + (await opener.count())
    )
    .toBeGreaterThan(0);
  if ((await opener.count()) && (await opener.first().getAttribute('aria-pressed')) === 'true')
    return;
  if (compactLayout(page) && (await page.locator('.workspace-header .chat-menu').count())) {
    const menu = await openChatMenu(page);
    await menu.getByRole('button', { name: '도우미 열기', exact: true }).click();
    return;
  }
  await opener.first().click();
}
