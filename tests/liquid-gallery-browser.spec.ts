import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { get_encoding } from 'tiktoken';
import type { Content } from '../core/product.js';
import type { ChatDetail, Run } from '../core/types.js';
import { nativeContent } from './fixtures/native-content.js';
import { openChatMenu, openHelper } from './ui-navigation.js';

const passage = `창문 너머로 스며드는 햇살이 책장 끝에 닿았다. 밤새 내리던 비는 어느새 그쳐 있었다. 젖은 돌길 위로 바람이 지나갈 때마다, 나뭇잎에 남아 있던 물방울이 작은 별처럼 반짝였다.

“오늘은 조금 천천히 걸어도 괜찮겠지요.”

그녀는 책갈피를 끼우고 고개를 들었다. 서두르지 않아도 되는 아침이라는 사실이 아직은 낯설었다. 맞은편에 앉은 여행자는 대답 대신 따뜻한 찻잔을 내밀었다. 말하지 않은 이야기들은 여전히 많았지만, 지금 이 순간만큼은 침묵도 나쁘지 않았다.`;
const encoder = get_encoding('o200k_base');
let longText = '# 비가 그친 아침에\n\n';
while (encoder.encode(longText).length < 10500) longText += `${passage}\n\n`;
longText += '마지막 문장. 두 사람은 마침내 함께 문을 나섰다.';
const tokenCount = encoder.encode(longText).length;
encoder.free();
const requestText =
  '다음 날 아침으로 이어줘. 두 사람이 어젯밤의 일을 의식하지만 먼저 말하지 못하는 분위기로, 풍경과 감정선을 충분히 보여줘.';
const translationText =
  '# After the rain\n\nThe morning light reached the bookshelf.\n\n“Let us take our time today.”';

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function portrait(role: 'bot' | 'persona') {
  // Optional, explicitly supplied local artwork is for private visual review only.
  const directory = process.env.UIMORI_GALLERY_DEMO_DIR;
  if (directory) return readFile(join(directory, `${role}.webp`));
  const width = 400;
  const height = role === 'bot' ? 600 : 400;
  // Fully opaque synthetic cards, including a contrasting outer frame to expose cropping.
  return sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#394565"/>
    <rect x="8" y="8" width="384" height="${height - 16}" fill="#abb9c9"/>
    <path d="M8 ${height * 0.7} L150 100 L392 ${height * 0.8} V${height - 8} H8Z" fill="#778888"/>
    <circle cx="285" cy="95" r="46" fill="#f0dca3"/>
    <path d="M80 ${height - 8} Q200 ${height * 0.27} 320 ${height - 8}" fill="#5d5574"/>
    <circle cx="200" cy="${height * 0.43}" r="55" fill="#e5c7b1"/>
    <rect x="20" y="${height - 40}" width="360" height="15" fill="#394565"/>
  </svg>`)
  )
    .png()
    .toBuffer();
}

async function makeContent(
  request: APIRequestContext,
  kind: 'bot' | 'persona',
  artworkRole = kind
) {
  const image = await request.post('/api/package-image-blobs', {
    data: { base64: (await portrait(artworkRole)).toString('base64') },
  });
  expect(image.ok(), await image.text()).toBe(true);
  const blob = await image.json();
  const title = kind === 'bot' ? '린 메이화' : '여행자';
  const model = {
    kind,
    title,
    description: 'Liquid Gallery visual fixture',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: nativeContent(
      { name: title, description: 'An unhurried morning.' },
      {
        id: randomUUID(),
        portraitImageId: 'cover',
        images: [
          {
            id: 'cover',
            title,
            description: 'Opaque portrait',
            blobHash: blob.hash,
            mime: blob.mime,
            allowedUse: 'profile',
          },
        ],
      },
      kind
    ),
  };
  const response = await request.post('/api/content', { data: model });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Content;
}

async function seed(request: APIRequestContext, squareBot = false) {
  const bot = await makeContent(request, 'bot', squareBot ? 'persona' : 'bot');
  const persona = await makeContent(request, 'persona', squareBot ? 'bot' : 'persona');
  const response = await request.post('/api/chats', {
    data: { title: '비가 그친 아침에', botId: bot.id },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = await response.json();
  let current = await detail(request, chat.id);
  const profile = await request.put(`/api/chats/${chat.id}/profile`, {
    data: {
      expectedRevision: current.profile!.revision,
      packageAttachments: [
        { id: bot.id, revision: bot.revision, role: 'bot' },
        { id: persona.id, revision: persona.revision, role: 'persona' },
      ],
      image: false,
    },
  });
  expect(profile.ok(), await profile.text()).toBe(true);
  const settings = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...chat.settings,
      status: false,
      translation: false,
      expectedSettingsRevision: chat.settingsRevision,
    },
  });
  expect(settings.ok(), await settings.text()).toBe(true);
  // Three real stored outputs; each is above 10,000 o200k_base tokens, not a fake CSS height.
  for (let index = 0; index < 3; index++) {
    current = await detail(request, chat.id);
    const started = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: requestText,
        expectedRevision: current.chat.headRevision,
        expectedSettingsRevision: current.chat.settingsRevision,
        expectedProfileRevision: current.profile!.revision,
        idempotencyKey: randomUUID(),
      },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const run = (await started.json()) as Run;
    await expect
      .poll(async () => (await detail(request, chat.id)).runs.find((r) => r.id === run.id)?.status)
      .toBe('completed');
    current = await detail(request, chat.id);
    const source = current.sources.find((s) => s.runId === run.id)!;
    const changed = await request.put(`/api/sources/${source.id}/text`, {
      data: { text: longText, expectedRevision: source.editRevision ?? 0 },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
  }
  current = await detail(request, chat.id);
  const source = current.sources[0];
  const translated = await request.put(`/api/sources/${source.id}/translation`, {
    data: {
      text: translationText,
      expectedRevision: source.translationRevision ?? 0,
      expectedSourceHash: source.hash,
    },
  });
  expect(translated.ok(), await translated.text()).toBe(true);
  const catalog = await (await request.get('/api/themes')).json();
  const selection = await request.post('/api/themes/selection', {
    data: {
      scope: 'chat',
      targetId: chat.id,
      themeId: 'builtin:liquid-gallery',
      expectedRevision: catalog.preferences.revision,
    },
  });
  expect(selection.ok(), await selection.text()).toBe(true);
  return { chatId: chat.id, bot, persona, sourceId: source.id };
}

for (const width of [1440, 412]) {
  for (const mode of ['dark', 'light'] as const) {
    test(`GALLERY ${width} ${mode}: opaque portraits, long prose, real controls and recovery`, async ({
      page,
      request,
    }, info) => {
      test.setTimeout(90000);
      page.setDefaultTimeout(10000);
      const data = await seed(request);
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 915 });
      await page.addInitScript((mode) => {
        localStorage.setItem('uimori:theme', mode);
        localStorage.setItem('uimori:reading-language', 'original');
        localStorage.setItem('uimori:reading-width', '760');
      }, mode);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`/?chat=${data.chatId}`);
      await expect(page.locator('html')).toHaveAttribute(
        'data-uimori-theme',
        'builtin:liquid-gallery'
      );
      const gallery = page.getByRole('complementary', { name: '등장인물 갤러리' });
      await expect(gallery).toHaveCount(1);
      await expect(gallery).toBeVisible();
      const bot = gallery.locator('[data-uimori-part="bot-portrait"] img');
      const persona = gallery.locator('[data-uimori-part="persona-portrait"] img');
      await expect
        .poll(() => bot.evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      await expect
        .poll(() => persona.evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      expect(await bot.evaluate((node) => getComputedStyle(node).objectFit)).toBe('contain');
      expect(await persona.evaluate((node) => getComputedStyle(node).objectFit)).toBe('contain');
      expect(
        await bot.evaluate(
          (node) =>
            (node as HTMLImageElement).naturalWidth / (node as HTMLImageElement).naturalHeight
        )
      ).toBeCloseTo(2 / 3, 1);
      expect(
        await persona.evaluate(
          (node) =>
            (node as HTMLImageElement).naturalWidth / (node as HTMLImageElement).naturalHeight
        )
      ).toBe(1);
      const reader = page.locator('[data-reader-scrollport]');
      const scene = page.locator(`[data-source-id="${data.sourceId}"]`);
      const source = scene.getByTestId('source-text');
      await expect(source).toContainText('마지막 문장. 두 사람은 마침내 함께 문을 나섰다.');
      const scroll = async (top: number) =>
        reader.evaluate((node, top) => {
          node.scrollTop = top;
        }, top);
      await scroll(0);
      expect(tokenCount).toBeGreaterThan(10000);
      const metrics = await reader.evaluate((node) => ({
        height: node.clientHeight,
        fullHeight: node.scrollHeight,
        background: getComputedStyle(node).backgroundColor,
      }));
      expect(metrics.fullHeight).toBeGreaterThan(metrics.height * 10);
      expect(metrics.background).toBe(mode === 'dark' ? 'rgb(26, 29, 42)' : 'rgb(251, 250, 248)');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
      ).toBe(true);
      expect(await source.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`liquid-gallery-${mode}-${width}.png`) });
      await info.attach('long-reader-measurements', {
        body: JSON.stringify({
          tokensPerOutput: tokenCount,
          outputCount: 3,
          width,
          mode,
          ...metrics,
        }),
        contentType: 'application/json',
      });
      // Full artwork can be viewed from the fixed gallery without changing reading position.
      await scroll(900);
      const before = await reader.evaluate((node) => node.scrollTop);
      const enlarge = gallery.getByRole('button', {
        name: '린 메이화 대표 이미지 확대',
        exact: true,
      });
      await enlarge.click();
      const dialog = page.getByRole('dialog', { name: '린 메이화 대표 이미지', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('img')).toHaveAttribute(
        'src',
        (await bot.getAttribute('src')) as string
      );
      await page.screenshot({ path: info.outputPath(`portrait-${mode}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(enlarge).toBeFocused();
      expect(Math.abs((await reader.evaluate((node) => node.scrollTop)) - before)).toBeLessThan(3);
      // Theme slots move the existing copy/edit controls to the top, not clones.
      await scroll(0);
      const copy = scene.getByRole('button', { name: '본문 복사', exact: true });
      await expect(copy).toBeVisible();
      expect((await copy.boundingBox())!.y).toBeLessThan((await reader.boundingBox())!.y + 400);
      const clipboard: string[] = [];
      await page.exposeFunction('galleryCopy', (value: string) => clipboard.push(value));
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (value: string) =>
              (window as unknown as { galleryCopy: (value: string) => Promise<void> }).galleryCopy(
                value
              ),
          },
        })
      );
      await copy.click();
      await expect.poll(() => clipboard.length).toBe(1);
      expect(clipboard[0]).toContain('마지막 문장.');
      await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
      const editor = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
      await expect(editor).toBeFocused();
      await expect(editor).toHaveValue(longText);
      await page.keyboard.press('Escape');
      await expect(editor).toHaveCount(0);
      const toggle = scene.getByRole('group', { name: '원문과 번역 보기' });
      await toggle.getByRole('button', { name: '번역 보기', exact: true }).click();
      await expect(scene.getByTestId('translation-text')).toContainText('After the rain');
      await toggle.getByRole('button', { name: '원문 보기', exact: true }).click();
      await expect(source).toContainText('마지막 문장.');
      const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
      await composer.fill('이 다음 장면에서는 두 사람이 함께 산책하도록 이어줘.');
      await page.keyboard.press('Control+Period');
      await expect(gallery).toBeHidden();
      await expect(composer).toHaveValue('이 다음 장면에서는 두 사람이 함께 산책하도록 이어줘.');
      await page.keyboard.press('Control+Period');
      await expect(gallery).toHaveCount(1);
      await expect(gallery).toBeVisible();
      if (width === 1440) {
        await openHelper(page);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
        ).toBe(true);
        expect((await gallery.boundingBox())!.height).toBeLessThan(100);
      }
      expect(errors).toEqual([]);
    });
  }
}

test('GALLERY square bot, tall persona, focus reading and failed image fallback', async ({
  page,
  request,
}, info) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(10000);
  const data = await seed(request, true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${data.chatId}`);
  const gallery = page.getByRole('complementary', { name: '등장인물 갤러리' });
  await expect(gallery).toHaveCount(1);
  const bot = gallery.locator('[data-uimori-part="bot-portrait"] img');
  await expect
    .poll(() => bot.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(
    await bot.evaluate(
      (node) => (node as HTMLImageElement).naturalWidth / (node as HTMLImageElement).naturalHeight
    )
  ).toBe(1);
  expect(await bot.evaluate((node) => node.clientWidth / node.clientHeight)).toBeCloseTo(1, 1);
  const persona = gallery.locator('[data-uimori-part="persona-portrait"] img');
  await expect
    .poll(() => persona.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(
    await persona.evaluate(
      (node) => (node as HTMLImageElement).naturalWidth / (node as HTMLImageElement).naturalHeight
    )
  ).toBeCloseTo(2 / 3, 1);
  await page.locator('[data-reader-scrollport]').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: info.outputPath('liquid-gallery-square-bot.png') });
  const menu = await openChatMenu(page);
  await menu.getByRole('button', { name: '집중 읽기', exact: true }).click();
  await expect(gallery).toBeHidden();
  await page.getByRole('button', { name: '집중 읽기 종료', exact: true }).click();
  await expect(gallery).toBeVisible();
  const src = await bot.getAttribute('src');
  await page.route(`**${src}`, (route) =>
    route.fulfill({ status: 404, body: 'Unavailable test image' })
  );
  await page.reload();
  await expect(
    gallery.locator('[data-uimori-part="bot-portrait"] .reader-portrait-empty')
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
});
