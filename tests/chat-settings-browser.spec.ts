import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Chat, ChatDetail } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { openChatMenu, selectChatSettingsSection } from './ui-navigation.js';

const sections = [
  '봇·페르소나·모듈',
  '프롬프트·창작 프리셋',
  '모델',
  '상태와 기억',
  '이미지',
  '자동 후속 작업',
];

async function prepare(page: Page, request: APIRequestContext, title: string) {
  const response = await postFixtureChat(request, { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = (await response.json()) as Chat;
  const before = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (entry) => {
    const path = new URL(entry.url()).pathname;
    // Package resolution projects selected references without saving or calling a model.
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
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
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

async function expectTouchTarget(control: Locator) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
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

test('CSUI01 chat settings list and seven details fit six widths with accessible navigation and no writes', async ({
  page,
  request,
}, info) => {
  test.setTimeout(90000);
  const { before, writes, errors } = await prepare(page, request, `CSUI01 ${Date.now()}`);
  for (const width of [320, 360, 390, 412, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dialog = await openSettings(page);
    const nav = dialog.locator('.chat-settings-panel > .section-navigation');
    const compact = width <= 760;
    await expect(nav).toBeVisible();
    const actions = nav.getByRole(compact ? 'button' : 'tab');
    await expect(actions).toHaveCount(sections.length);
    for (const name of sections) {
      const action = nav.getByRole(compact ? 'button' : 'tab', { name, exact: true });
      await expectTouchTarget(action);
    }
    if (compact) {
      await expect(nav).toHaveAttribute('role', 'navigation');
      await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
    } else {
      await expect(nav).toHaveAttribute('aria-orientation', 'vertical');
      await expect(nav.locator('[tabindex="0"]')).toHaveCount(1);
      const navBox = await nav.boundingBox();
      const panelBox = await dialog.locator('.settings-pages').boundingBox();
      expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(panelBox!.x);
    }
    await expectNoOverflow(page, dialog);
    if (width === 390)
      await page.screenshot({ path: info.outputPath('chat-settings-list-390.png') });
    for (const name of sections) {
      await selectChatSettingsSection(page, name);
      await expect(dialog.getByRole('tabpanel')).toHaveCount(1);
      if (compact) {
        await expect(nav).toBeHidden();
        await expectTouchTarget(
          dialog.getByRole('button', { name: '채팅 설정 목록으로', exact: true })
        );
        await expect(dialog.getByRole('heading', { name, exact: true })).toHaveCount(1);
      } else {
        await expect(nav).toBeVisible();
        await expect(nav.getByRole('tab', { name, exact: true })).toHaveAttribute(
          'aria-selected',
          'true'
        );
      }
      await expectNoOverflow(page, dialog);
      if (name === '모델' && (width === 390 || width === 1440))
        await page.screenshot({
          path: info.outputPath(
            width === 390 ? 'chat-settings-detail-390.png' : 'chat-settings-desktop-1440.png'
          ),
        });
    }
    await expectTouchTarget(dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }));
    await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await expectUnchanged(request, before, writes, errors);
});

test('CSUI02 section changes, browser Back and resizing preserve chat setting drafts until explicit discard', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { chat, before, writes, errors } = await prepare(page, request, `CSUI02 ${Date.now()}`);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('채팅 설정을 닫아도 유지할 미전송 요청');
  const dialog = await openSettings(page);
  const nav = dialog.locator('.chat-settings-panel > .section-navigation');
  const confirm = page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true });
  await selectChatSettingsSection(page, sections[0]);
  const persona = dialog.getByRole('checkbox', { name: '본문에서 페르소나 참조', exact: true });
  const originalPersona = await persona.isChecked();
  await persona.setChecked(!originalPersona);
  await selectChatSettingsSection(page, '모델');
  const image = dialog.getByRole('checkbox', { name: '보조 이미지 표시', exact: true });
  const originalImage = await image.isChecked();
  await image.setChecked(!originalImage);
  await selectChatSettingsSection(page, '자동 후속 작업');
  const chunk = dialog.getByLabel('번역 구간 기준 글자 수', { exact: true });
  const originalChunk = await chunk.inputValue();
  await chunk.fill('1234');
  await page.evaluate(() => history.back());
  await expect(nav).toBeVisible();
  await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
  await expect(confirm).toBeHidden();
  await page.evaluate(() => history.back());
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`));
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await selectChatSettingsSection(page, sections[0]);
  await expect(persona).toBeChecked({ checked: !originalPersona });
  await selectChatSettingsSection(page, '모델');
  await expect(image).toBeChecked({ checked: !originalImage });
  await selectChatSettingsSection(page, '자동 후속 작업');
  await expect(chunk).toHaveValue('1234');
  await chunk.focus();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(chunk).toBeFocused();
  await selectChatSettingsSection(page, '모델');
  await expect(image).toBeChecked({ checked: !originalImage });
  await selectChatSettingsSection(page, '자동 후속 작업');
  await expect(chunk).toHaveValue('1234');
  await chunk.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chunk).toBeVisible();
  await expect(chunk).toBeFocused();
  await expectNoOverflow(page, dialog);
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await expect(confirm).toBeVisible();
  await page.screenshot({ path: info.outputPath('chat-settings-dirty-390.png') });
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(chunk).toHaveValue('1234');
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue('채팅 설정을 닫아도 유지할 미전송 요청');
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`));
  await openSettings(page);
  await selectChatSettingsSection(page, sections[0]);
  await expect(persona).toBeChecked({ checked: originalPersona });
  await selectChatSettingsSection(page, '모델');
  await expect(image).toBeChecked({ checked: originalImage });
  await selectChatSettingsSection(page, '자동 후속 작업');
  await expect(chunk).toHaveValue(originalChunk);
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(confirm).toBeHidden();
  await expectUnchanged(request, before, writes, errors);
});

test('CSUI03 keyboard navigation and clean browser Back keep immediate reading preferences without model calls', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { before, writes, errors } = await prepare(page, request, `CSUI03 ${Date.now()}`);
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
  // Reading settings are no longer a chat settings section; the last section keeps its panel.
  await expect(dialog.getByLabel('새 원고의 기본 보기', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('번역 구간 무제한', { exact: true })).toBeVisible();
  await last.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('tabpanel')).toBeFocused();
  await expect(dialog.getByLabel('번역 구간 무제한', { exact: true })).toBeVisible();
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
  await expect(page.getByRole('button', { name: '채팅 설정', exact: true })).toBeFocused();
  // Reading settings: the dialog from the chat ⋯ menu keeps view and font; the theme is in 설정 → 일반 only.
  await openChatMenu(page);
  await page.getByRole('button', { name: '읽기 설정', exact: true }).click();
  const reading = page.getByRole('dialog', { name: '읽기 설정', exact: true });
  await reading.getByLabel('새 원고의 기본 보기', { exact: true }).selectOption('original');
  await reading.getByLabel('본문 글꼴', { exact: true }).selectOption('serif');
  await expect(reading.getByLabel('화면 테마', { exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        ['reading-language', 'font'].map((key) => localStorage.getItem(`uimori:${key}`))
      )
    )
    .toEqual(['original', 'serif']);
  await page.keyboard.press('Escape');
  await expect(reading).toBeHidden();
  await openChatMenu(page);
  await page.getByRole('button', { name: '읽기 설정', exact: true }).click();
  await expect(reading.getByLabel('새 원고의 기본 보기', { exact: true })).toHaveValue('original');
  await expect(reading.getByLabel('본문 글꼴', { exact: true })).toHaveValue('serif');
  await page.keyboard.press('Escape');
  await expect(reading).toBeHidden();
  await expectUnchanged(request, before, writes, errors);
});
