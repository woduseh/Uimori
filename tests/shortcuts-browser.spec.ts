import { expect, test, type Locator } from '@playwright/test';
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { visualReview } from './fixtures/visual-review.js';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.addInitScript(() => localStorage.setItem('uimori:reading-language', 'original'));
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
  const query = palette.getByRole('combobox', { name: '채팅, 서재 자료, 설정, 명령 찾기' });
  const active = palette.locator('[role="option"][aria-selected="true"]');
  const expectActive = async (option: Locator) => {
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await expect(active).toHaveCount(1);
    await expect(query).toHaveAttribute(
      'aria-activedescendant',
      (await option.getAttribute('id'))!
    );
    await expect(query).toBeFocused();
  };
  await composer.click();

  await page.keyboard.press('Control+K');
  await expect(palette).toBeVisible();
  await expect(query).toBeFocused();
  await expect(query).toHaveValue('');
  await page.keyboard.type(other.title);
  const activeLabel = () => active.locator('.command-palette-label').textContent();
  for (let step = 0; step < 6 && (await activeLabel()) !== other.title; step++)
    await page.keyboard.press('ArrowDown');
  expect(await activeLabel()).toBe(other.title);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.locator('.header-title h1')).toHaveText(other.title);

  await page.keyboard.press('Control+K');
  await page.keyboard.type('데이터 관리');
  await expectActive(palette.getByRole('option', { name: '데이터 관리', exact: true }));
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('tab', { name: '데이터 관리', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await page.keyboard.press('Control+K');
  await page.keyboard.type('보라색 우산');
  await page.keyboard.press('End');
  await expectActive(
    palette.getByRole('option', { name: '원고에서 “보라색 우산” 찾기', exact: true })
  );
  await page.keyboard.press('Enter');
  const search = page.getByRole('dialog', { name: '전체 채팅 검색', exact: true });
  await expect(search.getByRole('searchbox', { name: '전체 채팅 검색', exact: true })).toHaveValue(
    '보라색 우산'
  );
  await expect(search.getByRole('heading', { name: '본문 검색 결과', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
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
  if (visualReview)
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
