import { expect, test, type Page } from './fixtures/browser-test.js';
import { emptyTheme } from '../core/themes.js';
import type { ThemeCatalog } from '../core/themes.js';
import type { Chat } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { restoreGlobalThemeSelection } from './fixtures/theme-selection.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

type WriteLog = Window & { settingWrites: string[] };

const presentationKeys = [
  'uimori:theme',
  'uimori:font',
  'uimori:font-size',
  'uimori:reading-width',
  'uimori:readability',
  'uimori:reading-language',
  'uimori:response-display',
  'uimori:enter-send',
  'uimori:sidebar-width',
  'uimori:sidebar-collapsed',
  'uimori:scene-navigator',
  'uimori:illustrations-collapsed',
  'uimori:panel-width',
];
const settingEndpoints =
  /^\/api\/(?:themes\/(?:selection|background)|font-preferences|fonts|palettes|illustration-presets\/selection|resources\/save)/u;

async function recordSettingWrites(page: Page) {
  const requests: string[] = [];
  page.on('request', (entry) => {
    const path = new URL(entry.url()).pathname;
    if (entry.method() !== 'GET' && settingEndpoints.test(path))
      requests.push(`${entry.method()} ${path}`);
  });
  await page.addInitScript((keys) => {
    const log = window as unknown as WriteLog;
    log.settingWrites = [];
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.localStorage && keys.includes(key)) log.settingWrites.push(key);
      return write.call(this, key, value);
    };
  }, presentationKeys);
  return {
    requests,
    storage: () => page.evaluate(() => (window as unknown as WriteLog).settingWrites),
  };
}

async function openSettings(page: Page, section: string) {
  await navigationAction(page, '설정');
  await selectSettingsSection(page, section);
}

test('SETSYNC01 opening a tab writes no settings, and per-browser reading choices follow in other tabs', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await openSettings(page, '일반');
  const mode = page.getByLabel('앱 화면 테마', { exact: true });
  const font = page.getByLabel('본문 글꼴', { exact: true });
  await mode.selectOption('dark');
  await font.selectOption('serif');
  await page.evaluate(() => localStorage.setItem('uimori:font-size', '99'));

  const other = await context.newPage();
  try {
    const writes = await recordSettingWrites(other);
    await other.goto('/');
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(other.locator('html')).toHaveAttribute('data-reading-font', 'serif');
    await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', /.+/u);
    expect(await writes.storage()).toEqual([]);
    expect(writes.requests).toEqual([]);
    expect(await other.evaluate(() => localStorage.getItem('uimori:font-size'))).toBe('99');

    await mode.selectOption('light');
    await font.selectOption('sans');
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(other.locator('html')).toHaveAttribute('data-reading-font', 'sans');
    await openSettings(other, '일반');
    await expect(other.getByLabel('앱 화면 테마', { exact: true })).toHaveValue('light');
    await expect(other.getByLabel('본문 글꼴', { exact: true })).toHaveValue('sans');
    expect(await writes.storage()).toEqual([]);
    expect(writes.requests).toEqual([]);
  } finally {
    await other.close();
    await mode.selectOption('system');
    await page.evaluate(() => localStorage.removeItem('uimori:font-size'));
  }
});

test('SETSYNC02 theme and font changes reach another open tab through the live stream and keep its unsaved theme draft', async ({
  page,
  context,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const baseline = ((await (await request.get('/api/themes')).json()) as ThemeCatalog).preferences;
  const other = await context.newPage();
  await other.setViewportSize({ width: 1440, height: 1000 });
  try {
    await page.goto('/');
    await openSettings(page, '테마와 색상');
    await page.getByRole('button', { name: '기본 테마 적용', exact: true }).click();

    await other.goto('/');
    await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:forest');
    await openSettings(other, '테마와 색상');
    const advanced = other.locator('.theme-advanced:not([open]) > summary');
    if (await advanced.isVisible()) await advanced.click();
    await other.getByRole('button', { name: '복제해서 꾸미기', exact: true }).first().click();
    const draftName = other.getByLabel('테마 이름', { exact: true });
    await draftName.fill('다른 탭의 미저장 초안');

    await page.getByRole('button', { name: '편지지 테마 적용', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
    await expect(other.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:letter');
    await expect(draftName).toHaveValue('다른 탭의 미저장 초안');

    const title = `Synced elsewhere ${Date.now()}`;
    const saved = await request.post('/api/resources/save', {
      data: { kind: 'theme', model: emptyTheme(title) },
    });
    expect(saved.ok()).toBe(true);
    await expect(
      other.getByRole('button', { name: `${title} 테마 적용`, exact: true })
    ).toBeVisible();
    await expect(draftName).toHaveValue('다른 탭의 미저장 초안');
    const theme = (await saved.json()).saved;
    await request.delete(`/api/themes/${theme.id}`, {
      data: { expectedRevision: theme.revision },
    });

    const fontRead = other.waitForRequest(
      (entry) => entry.method() === 'GET' && new URL(entry.url()).pathname === '/api/fonts'
    );
    const { preferences } = await (await request.get('/api/fonts')).json();
    const selected = await request.put('/api/font-preferences', {
      data: {
        expectedRevision: preferences.revision,
        appFontId: preferences.appFontId,
        readerFontId: preferences.readerFontId,
      },
    });
    expect(selected.ok()).toBe(true);
    await fontRead;
  } finally {
    await other.close();
    await restoreGlobalThemeSelection(request, baseline);
  }
});

test('SETSYNC03 a chat deleted outside this tab leaves its chat list through the live stream', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const kept = (await (
    await postFixtureChat(request, { data: { title: `남는 채팅 ${stamp}` } })
  ).json()) as Chat;
  const doomed = (await (
    await request.post('/api/chats', {
      data: { title: `바깥에서 지운 채팅 ${stamp}`, botId: kept.botId },
    })
  ).json()) as Chat;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${kept.id}`);
  await expect(page.getByText(doomed.title, { exact: true }).first()).toBeVisible();

  const listRead = page.waitForRequest(
    (entry) => entry.method() === 'GET' && new URL(entry.url()).pathname === '/api/chats'
  );
  expect((await request.delete(`/api/chats/${doomed.id}`)).ok()).toBe(true);
  await listRead;
  await expect(page.getByText(doomed.title, { exact: true })).toHaveCount(0);
  await expect(page.getByText(kept.title, { exact: true }).first()).toBeVisible();
});
