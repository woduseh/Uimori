import { test, expect, type APIRequestContext } from './fixtures/browser-test.js';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fixtureBotInput } from './fixtures/chat.js';
import type { ChatDetail } from '../core/types.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

const endMarker = '마지막 문장. 두 사람은 마침내 함께 문을 나섰다.';
const text = `창문 너머로 스며드는 햇살이 책장 끝에 닿았다. 밤새 내리던 비는 어느새 그쳐 있었다.\n\n${endMarker}`;

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function select(
  request: APIRequestContext,
  choice: { themeId: string; targetId: string } | { paletteId: string }
) {
  const response = await request.get('/api/themes');
  expect(response.ok(), await response.text()).toBe(true);
  const catalog = await response.json();
  const selection = await request.post('/api/themes/selection', {
    data: {
      ...choice,
      scope: 'themeId' in choice ? 'chat' : 'global',
      dimension: 'paletteId' in choice ? 'palette' : 'theme',
      expectedRevision: catalog.preferences.revision,
    },
  });
  expect(selection.ok(), await selection.text()).toBe(true);
}

async function seed(request: APIRequestContext) {
  const created = await request.post('/api/content', { data: fixtureBotInput() });
  expect(created.ok(), await created.text()).toBe(true);
  const bot = await created.json();
  const response = await request.post('/api/chats/import-transcript', {
    data: {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: 'Background synthetic story',
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: [{ request: '비가 그친 아침의 장면을 이어줘.', text, translation: null }],
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = (await response.json()).chat;
  await select(request, { themeId: 'builtin:classic-frame', targetId: chat.id });
  await select(request, { paletteId: 'theme' });
  const source = (await detail(request, chat.id)).sources.find((item) => item.text === text)!;
  expect(source).toBeTruthy();
  return { chatId: chat.id, sourceId: source.id };
}

test('BACKGROUND upload, independent scopes, overlays, clear and reload', async ({
  page,
  request,
}) => {
  const data = await seed(request);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('uimori:theme', 'light');
    localStorage.setItem('uimori:reading-language', 'original');
  });
  await page.goto(`/?chat=${data.chatId}&source=${data.sourceId}`);
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', 'builtin:classic-frame');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마와 색상');
  {
    const advanced = page.locator('.theme-advanced:not([open]) > summary');
    if (await advanced.isVisible()) await advanced.click();
  }
  const bytes = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#73a7ab"/><circle cx="680" cy="140" r="90" fill="#ffd181"/><path d="M0 600V450L240 180L500 430L700 300L900 500V600Z" fill="#456253"/></svg>'
    )
  )
    .png()
    .toBuffer();
  const saveBackground = page.getByRole('button', { name: '배경 저장', exact: true });
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route('**/api/package-image-blobs', async (route) => {
    await uploadGate;
    await route.continue();
  });
  const uploading = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/package-image-blobs')
  );
  try {
    await page
      .getByLabel('배경 이미지 선택', { exact: true })
      .setInputFiles({ name: 'landscape.png', mimeType: 'image/png', buffer: bytes });
    await uploading;
    await expect(saveBackground).toBeDisabled();
    await expect(saveBackground).toHaveAttribute('aria-busy', 'false');
  } finally {
    releaseUpload();
  }
  await expect(saveBackground).toBeEnabled();
  await page.unroute('**/api/package-image-blobs');
  await page.getByLabel('배경 흐림', { exact: true }).fill('7');
  await page.getByLabel('밝은 모드 배경 오버레이', { exact: true }).fill('25');
  await page.getByLabel('어두운 모드 배경 오버레이', { exact: true }).fill('55');
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route('**/api/themes/background', async (route) => {
    await saveGate;
    await route.continue();
  });
  try {
    await saveBackground.click();
    await expect(saveBackground).toBeDisabled();
    await expect(saveBackground).toHaveAttribute('aria-busy', 'true');
  } finally {
    releaseSave();
  }
  await expect(saveBackground).toHaveAttribute('aria-busy', 'false');
  await expect(saveBackground).toBeDisabled();
  await page.unroute('**/api/themes/background');
  const catalog = await (await request.get('/api/themes')).json();
  expect(catalog.preferences.defaultBackground).toMatchObject({
    blur: 7,
    lightOverlay: 25,
    darkOverlay: 55,
  });
  expect(catalog.preferences.chatThemes[data.chatId]).toBe('builtin:classic-frame');
  await page.goto(`/?chat=${data.chatId}&source=${data.sourceId}`);
  const background = page.locator('.reader-stage > .theme-background');
  await expect(background).toBeVisible();
  expect(await background.evaluate((node) => getComputedStyle(node, '::before').filter)).toBe(
    'blur(7px)'
  );
  expect(
    await background.evaluate((node) => getComputedStyle(node, '::after').backgroundColor)
  ).toBe('rgba(255, 255, 255, 0.25)');
  expect(
    await page
      .locator('[data-reader-scrollport]')
      .evaluate((node) => getComputedStyle(node).backgroundColor)
  ).toBe('rgba(0, 0, 0, 0)');
  const body = page.locator(`[data-source-id="${data.sourceId}"] [data-uimori-part="body"]`);
  expect(await body.evaluate((node) => getComputedStyle(node).filter)).toBe('none');
  expect(await body.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
    'rgba(0, 0, 0, 0)'
  );
  await expect(
    page.locator(`[data-source-id="${data.sourceId}"]`).getByTestId('source-text')
  ).toContainText(endMarker);
  await page.reload();
  await expect(background).toBeVisible();
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마와 색상');
  {
    const advanced = page.locator('.theme-advanced:not([open]) > summary');
    if (await advanced.isVisible()) await advanced.click();
  }
  await selectSettingsSection(page, '일반');
  await page.getByRole('combobox', { name: '앱 화면 테마', exact: true }).selectOption('dark');
  await selectSettingsSection(page, '테마와 색상');
  {
    const advanced = page.locator('.theme-advanced:not([open]) > summary');
    if (await advanced.isVisible()) await advanced.click();
  }
  await page.getByLabel('테마 적용 범위', { exact: true }).selectOption('chat');
  await page.getByRole('button', { name: '배경 초기화', exact: true }).click();
  await page.getByRole('button', { name: '배경 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '배경 저장', exact: true })).toBeDisabled();
  await expect(background).toHaveCount(0);
  await page.getByRole('button', { name: '배경 상위 설정 따르기', exact: true }).click();
  await expect(background).toBeVisible();
  expect(
    await background.evaluate((node) => getComputedStyle(node, '::after').backgroundColor)
  ).toBe('rgba(0, 0, 0, 0.55)');
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(background).toBeVisible();
  await expect(
    page.locator(`[data-source-id="${data.sourceId}"]`).getByTestId('source-text')
  ).toContainText(endMarker);
  const final = await (await request.get('/api/themes')).json();
  expect(
    (
      await request.post('/api/themes/background', {
        data: { scope: 'global', background: null, expectedRevision: final.preferences.revision },
      })
    ).ok()
  ).toBe(true);
});
