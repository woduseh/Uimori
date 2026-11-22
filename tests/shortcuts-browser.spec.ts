import { expect, test } from '@playwright/test';
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { isResourceSaveRequest } from './fixtures/resource-save.js';
import { navigationAction } from './ui-navigation.js';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.addInitScript(() => localStorage.setItem('uimori:reading-language', 'original'));
});

test('SHORTCUT01 default bindings move between the sidebar, helper, settings and search', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, `단축키 이동 ${Date.now()}`, 1);
  await page.goto(`/?chat=${chat.id}`);
  const shell = page.locator('.app-shell');
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.click();

  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Control+B');
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Control+B');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);

  const helper = page.locator('#helper-panel');
  await page.keyboard.press('Control+Backslash');
  await expect(helper).toBeVisible();
  await composer.click();
  await page.keyboard.press('Control+Backslash');
  await expect(helper).toBeHidden();

  await composer.click();
  await page.keyboard.press('Control+Comma');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(settings).toBeVisible();
  await page.keyboard.press('Control+B');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await composer.click();
  await page.keyboard.press('Control+F');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('dialog', { name: '전체 채팅 검색', exact: true });
  await expect(search).toBeVisible();
  await expect(
    search.getByRole('searchbox', { name: '전체 채팅 검색', exact: true })
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
});

test('SHORTCUT02 typing and Korean composition in the composer and editors stay untouched', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, `단축키 입력 ${Date.now()}`, 1);
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.fill('한글 조합');
  for (const code of ['KeyK', 'KeyB', 'Backslash', 'Comma', 'KeyS', 'Period'])
    await composer.dispatchEvent('keydown', {
      key: code,
      code,
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
  await page.keyboard.type(' 중 kbs,');
  await expect(composer).toHaveValue('한글 조합 중 kbs,');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('#helper-panel')).toBeHidden();

  const scene = page.getByTestId('source');
  await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
  const editor = scene.locator('.source-text-editor textarea');
  await expect(editor).toBeFocused();
  await editor.press('Control+End');
  await page.keyboard.type(' 끝');
  await editor.dispatchEvent('keydown', {
    key: 's',
    code: 'KeyS',
    ctrlKey: true,
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });
  await expect(editor).toHaveValue(/ 끝$/);
  await expect(editor).toBeVisible();
});

test('SHORTCUT03 Ctrl+S saves the focused source editor and nothing else', async ({
  page,
  request,
}) => {
  const { chat, detail } = await createReadingChat(request, `단축키 저장 ${Date.now()}`, 1);
  await page.goto(`/?chat=${chat.id}`);
  const saves: string[] = [];
  page.on('request', (event) => {
    if (event.method() === 'PUT') saves.push(new URL(event.url()).pathname);
  });
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.click();
  await page.keyboard.press('Control+S');
  await expect(composer).toBeFocused();

  const scene = page.getByTestId('source');
  await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
  const editor = scene.locator('.source-text-editor textarea');
  await editor.fill('');
  await page.keyboard.press('Control+S');
  await expect(editor).toBeVisible();
  await editor.fill('단축키로 저장한 원문.');
  await page.keyboard.press('Control+S');
  await expect(editor).toHaveCount(0);
  await expect(scene).toContainText('단축키로 저장한 원문.');
  expect(saves).toEqual([`/api/sources/${detail.sources[0].id}/text`]);
  const saved = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(saved.sources[0].text).toBe('단축키로 저장한 원문.');
});

test('SHORTCUT04 Escape twice cancels the running generation and a lone or post-dialog Escape does not', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, `단축키 중단 ${Date.now()}`, 1);
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
  let cancels = 0;
  await page.route('**/api/runs/*/cancel', async (route) => {
    cancels++;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
    await composer.fill('멈출 장면 요청');
    await page.getByRole('button', { name: '원문 생성', exact: true }).click();
    const cancel = page.getByRole('button', { name: '원문 생성 취소', exact: true });
    await expect(cancel).toBeVisible();
    const notice = page.locator('.transient-notice', {
      hasText: 'Esc 키를 한 번 더 누르면 원문 생성을 취소해요.',
    });

    await composer.click();
    await page.keyboard.press('Escape');
    await expect(notice).toBeVisible();
    await page.waitForTimeout(2100);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(cancels).toBe(0);
    await expect(cancel).toBeVisible();
    await page.waitForTimeout(2100);

    await page.keyboard.press('Control+Comma');
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(settings).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(cancels).toBe(0);

    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect.poll(() => cancels).toBe(1);
  } finally {
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
  }
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeVisible();
});

test('SHORTCUT05 turning shortcuts off keeps only the Escape behaviour that existed before', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, `단축키 끄기 ${Date.now()}`, 1);
  await page.goto(`/?chat=${chat.id}`);
  const shell = page.locator('.app-shell');
  await page.getByRole('textbox', { name: '다음 장면 요청', exact: true }).click();
  await page.keyboard.press('Control+Comma');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  const toggle = settings.getByRole('switch', { name: '키보드 단축키', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  expect(await page.evaluate(() => localStorage.getItem('uimori:shortcuts'))).toBe('false');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
  let cancels = 0;
  await page.route('**/api/runs/*/cancel', async (route) => {
    cancels++;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await page.reload();
    const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
    await composer.fill('끈 상태의 요청');
    await page.getByRole('button', { name: '원문 생성', exact: true }).click();
    await expect(page.getByRole('button', { name: '원문 생성 취소', exact: true })).toBeVisible();
    await composer.click();
    for (const key of ['Control+B', 'Control+K', 'Control+Backslash', 'Control+Shift+F'])
      await page.keyboard.press(key);
    await expect(shell).not.toHaveClass(/sidebar-collapsed/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(cancels).toBe(0);
    await expect(page.locator('.transient-notice')).toHaveCount(0);

    const scene = page.getByTestId('source').first();
    await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
    const editor = scene.locator('.source-text-editor textarea');
    await editor.fill('버릴지 물어야 하는 초안');
    await page.keyboard.press('Escape');
    const discard = page.getByRole('alertdialog');
    await expect(discard).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(discard).toBeHidden();
    await expect(editor).toHaveValue('버릴지 물어야 하는 초안');

    const safeMode = () => page.evaluate(() => sessionStorage.getItem('uimori:theme-disabled'));
    await page.keyboard.press('Control+Period');
    await expect.poll(safeMode).toBe('1');
    await page.keyboard.press('Control+Period');
    await expect.poll(safeMode).toBe('0');
  } finally {
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
  }
});

test('SHORTCUT06 the command palette opens a chat, a settings section and manuscript search by keyboard', async ({
  page,
  request,
}) => {
  const suffix = Date.now();
  const { chat } = await createReadingChat(request, `팔레트 출발 ${suffix}`, 1);
  const { chat: other } = await createReadingChat(request, `팔레트 도착 ${suffix}`, 1);
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  const palette = page.getByRole('dialog', { name: '명령 팔레트', exact: true });
  const query = palette.getByRole('textbox', { name: '채팅, 서재 자료, 설정, 명령 찾기' });
  await composer.click();

  await page.keyboard.press('Control+K');
  await expect(palette).toBeVisible();
  await expect(query).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('palette.png') });
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(composer).toBeFocused();

  await page.keyboard.press('Control+K');
  await page.keyboard.type(other.title);
  const focusedChoice = () =>
    page.evaluate(() => document.activeElement?.querySelector('span')?.textContent);
  for (let step = 0; step < 6 && (await focusedChoice()) !== other.title; step++)
    await page.keyboard.press('ArrowDown');
  expect(await focusedChoice()).toBe(other.title);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.locator('.header-title h1')).toHaveText(other.title);
  await expect(composer).toBeFocused();

  await page.keyboard.press('Control+K');
  await page.keyboard.type('데이터 관리');
  await page.keyboard.press('ArrowDown');
  await expect(palette.getByRole('button', { name: '데이터 관리', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('tab', { name: '데이터 관리', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(composer).toBeFocused();

  await page.keyboard.press('Control+K');
  await page.keyboard.type('보라색 우산');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await expect(
    palette.getByRole('button', { name: '원고에서 “보라색 우산” 찾기', exact: true })
  ).toBeFocused();
  await page.keyboard.press('Enter');
  const search = page.getByRole('dialog', { name: '전체 채팅 검색', exact: true });
  await expect(search.getByRole('searchbox', { name: '전체 채팅 검색', exact: true })).toHaveValue(
    '보라색 우산'
  );
  await expect(search.getByRole('heading', { name: '본문 검색 결과', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await expect(composer).toBeFocused();
});

test('SHORTCUT07 Ctrl+S in the prompt editor shows what clicking save shows while another role has a draft', async ({
  page,
}) => {
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: '새 프롬프트', exact: true }).first().click();
  const editor = page.getByTestId('prompt-editor');
  const title = editor.getByLabel('프롬프트 이름', { exact: true });
  const role = editor.getByLabel('프롬프트 역할', { exact: true });
  const suffix = Date.now();
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  await title.fill(`단축키 집필 ${suffix}`);
  await role.selectOption('translation');
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  await title.fill(`단축키 번역 ${suffix}`);
  const saves: string[] = [];
  page.on('request', (value) => {
    if (isResourceSaveRequest(value)) saves.push(value.url());
  });
  const saved = page.locator('.transient-notice', { hasText: '프롬프트를 저장했어요.' });

  await title.click();
  await page.keyboard.press('Control+S');
  await expect(saved).toBeVisible();
  await expect.poll(() => saves.length).toBe(1);

  await role.selectOption('main');
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  await expect(title).toHaveValue(`단축키 집필 ${suffix}`);
  await expect(saved).toBeHidden();
  await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
  await expect(saved).toBeVisible();
  await expect.poll(() => saves.length).toBe(2);
});

test('SHORTCUT08 shortcuts can be rebound, validated, persisted in browser storage and reset', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, `단축키 재바인딩 ${Date.now()}`, 1);
  await page.goto(`/?chat=${chat.id}`);
  const shell = page.locator('.app-shell');
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.click();

  await page.keyboard.press('Control+Comma');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole('tab', { name: '일반', exact: true }).click();
  const displaySection = settings.locator('[id$="-general-display"]');
  await displaySection.getByRole('button', { name: '변경', exact: true }).click();

  const detail = settings.locator('[data-settings-detail]:not([hidden])');
  await expect(detail).toBeVisible();
  await expect(detail.getByText('안전 복구용이라 바꿀 수 없어요.')).toBeVisible();

  await detail.getByRole('button', { name: '왼쪽 사이드바 접기와 펼치기 단축키 변경' }).click();
  await expect(detail.getByText('키를 눌러 주세요…')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detail).toBeVisible();
  await expect(detail.getByText('키를 눌러 주세요…')).toHaveCount(0);

  await detail.getByRole('button', { name: '왼쪽 사이드바 접기와 펼치기 단축키 변경' }).click();
  await page.keyboard.press('Control+F');
  await expect(detail.getByRole('alert')).toContainText('브라우저가 먼저 쓰는 조합');

  await page.keyboard.press('Control+K');
  await expect(detail.getByRole('alert')).toContainText('“명령 팔레트 열기” 단축키와 겹쳐요.');

  await page.keyboard.press('Alt+B');
  await expect(detail.getByRole('alert')).toHaveCount(0);
  await expect(
    detail
      .locator('.shortcut-settings-row', { hasText: '왼쪽 사이드바 접기와 펼치기' })
      .locator('kbd')
  ).toHaveText('Alt+B');
  await page.screenshot({ path: test.info().outputPath('shortcut-settings.png') });

  await detail.getByRole('button', { name: '목록으로', exact: true }).click();
  await expect(displaySection).toContainText('1개 변경됨');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await composer.click();
  await page.keyboard.press('Control+B');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Alt+B');
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Alt+B');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);

  await page.reload();
  await composer.click();
  await page.keyboard.press('Alt+B');
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Alt+B');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);

  await page.keyboard.press('Control+Comma');
  await expect(settings).toBeVisible();
  await settings.getByRole('tab', { name: '일반', exact: true }).click();
  await displaySection.getByRole('button', { name: '변경', exact: true }).click();
  await detail.getByRole('button', { name: '모두 기본값으로 복원', exact: true }).click();
  await expect(
    detail
      .locator('.shortcut-settings-row', { hasText: '왼쪽 사이드바 접기와 펼치기' })
      .locator('kbd')
  ).toHaveText('Ctrl+B');
  expect(await page.evaluate(() => localStorage.getItem('uimori:shortcut-bindings'))).toBeNull();
});
