import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { get_encoding } from 'tiktoken';
import type { Content } from '../core/product.js';
import type { PackageImage } from '../core/package-images.js';
import type { ChatDetail } from '../core/types.js';
import { BUILTIN_PALETTES } from '../core/theme-palettes.js';
import { nativeContent } from './fixtures/native-content.js';
import { navigationAction, openChatMenu, selectSettingsSection } from './ui-navigation.js';

const layouts = ['cinematic', 'letter', 'scrapbook', 'classic-frame'] as const;
type Layout = (typeof layouts)[number];
const requestText = '비가 그친 아침, 두 사람이 숲길을 따라 걸어가는 장면을 이어줘.';
const endMarker = '마지막 문장. 두 사람은 마침내 함께 문을 나섰다.';
const passage =
  '창문 너머로 스며드는 햇살이 책장 끝에 닿았다. 밤새 내리던 비는 어느새 그쳐 있었다. 젖은 돌길 위로 바람이 지나갈 때마다 나뭇잎에 남아 있던 물방울이 작은 별처럼 반짝였다.\n\n“오늘은 조금 천천히 걸어도 괜찮겠지요.”\n\n그녀는 책갈피를 끼우고 고개를 들었다. 맞은편에 앉은 여행자는 대답 대신 따뜻한 찻잔을 내밀었다. 말하지 않은 이야기는 많았지만 지금 이 순간만큼은 침묵도 나쁘지 않았다.\n\n';
const encoder = get_encoding('o200k_base');
let longText = '# 비가 그친 아침에\n\n';
while (encoder.encode(longText).length < 10500) longText += passage;
longText += endMarker;
const tokenCount = encoder.encode(longText).length;
encoder.free();
const translationText =
  '# After the rain\n\nMorning light reached the bookshelf.\n\n“Let us take our time today.”\n\nThey finally stepped outside together.';
const readingPreferences = {
  'uimori:reading-language': 'original',
  'uimori:reading-width': '760',
  'uimori:readability': JSON.stringify({ emphasis: 'subtle', dialogueBreaks: true }),
};

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
      ...('paletteId' in choice ? { dimension: 'palette' } : {}),
      expectedRevision: catalog.preferences.revision,
    },
  });
  expect(selection.ok(), await selection.text()).toBe(true);
}

async function makeContent(
  request: APIRequestContext,
  kind: 'bot' | 'persona',
  shape: 'tall' | 'square' | 'missing'
): Promise<Content> {
  const title = kind === 'bot' ? '린 메이화' : '여행자';
  const height = shape === 'tall' ? 600 : 400;
  let image: { hash: string; mime: PackageImage['mime'] } | undefined;
  if (shape !== 'missing') {
    // Opaque synthetic art is stored through the real asset API, never an external provider.
    // The outer border makes unintended cover-cropping visible in review screenshots.
    const directory = process.env.UIMORI_NARRATIVE_DEMO_DIR;
    const bytes = directory
      ? await readFile(join(directory, shape === 'tall' ? 'bot.webp' : 'persona.webp'))
      : await sharp(
          Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${height}">
        <rect width="400" height="${height}" fill="#384560"/>
        <rect x="8" y="8" width="384" height="${height - 16}" fill="#b5c6c8"/>
        <circle cx="295" cy="80" r="42" fill="#efd597"/>
        <path d="M8 ${height * 0.7} L125 140 L392 ${height * 0.8} V${height - 8} H8Z" fill="#788d87"/>
        <path d="M65 ${height - 8} Q200 ${height * 0.25} 335 ${height - 8}" fill="#676080"/>
        <circle cx="200" cy="${height * 0.43}" r="52" fill="#e4c3ad"/>
        <rect x="20" y="${height - 40}" width="360" height="15" fill="#384560"/>
      </svg>`)
        )
          .png()
          .toBuffer();
    const response = await request.post('/api/package-image-blobs', {
      data: { base64: bytes.toString('base64') },
    });
    expect(response.ok(), await response.text()).toBe(true);
    image = await response.json();
  }
  const response = await request.post('/api/content', {
    data: {
      kind,
      title,
      description: 'Synthetic narrative layout browser fixture',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: nativeContent(
        { name: title, description: 'A quiet morning after the rain.' },
        {
          id: randomUUID(),
          ...(image
            ? {
                portraitImageId: 'cover',
                images: [
                  {
                    id: 'cover',
                    title,
                    description: 'Opaque synthetic portrait',
                    blobHash: image.hash,
                    mime: image.mime,
                    allowedUse: 'profile',
                  },
                ],
              }
            : {}),
        },
        kind
      ),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(
  request: APIRequestContext,
  layout: Layout,
  options: { squareBot?: boolean; missing?: boolean; noPersona?: boolean; long?: boolean } = {}
) {
  const bot = await makeContent(
    request,
    'bot',
    options.missing ? 'missing' : options.squareBot ? 'square' : 'tall'
  );
  const persona = await makeContent(
    request,
    'persona',
    options.missing ? 'missing' : options.squareBot ? 'tall' : 'square'
  );
  const text = options.long === false ? `${passage}${endMarker}` : longText;
  const response = await request.post('/api/chats/import-transcript', {
    data: {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: `Narrative ${layout} synthetic story`,
        packageAttachments: [
          { id: bot.id, revision: bot.revision, role: 'bot' },
          ...(options.noPersona
            ? []
            : [{ id: persona.id, revision: persona.revision, role: 'persona' }]),
        ],
        notes: [],
        entries: [
          { request: requestText, text, translation: translationText },
          {
            request: '산책을 마친 두 사람의 다음 장면.',
            text: `# 두 번째 장면\n\n${passage}SECOND_SCENE_END`,
            translation: null,
          },
        ],
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = (await response.json()).chat;
  await select(request, { themeId: `builtin:${layout}`, targetId: chat.id });
  await select(request, { paletteId: 'theme' });
  const before = await detail(request, chat.id);
  const source = before.sources.find((item) => item.text === text)!;
  const second = before.sources.find((item) => item.text.includes('SECOND_SCENE_END'))!;
  expect(source).toBeTruthy();
  expect(second).toBeTruthy();
  return { chatId: chat.id, sourceId: source.id, secondId: second.id, text, before };
}

async function openStory(
  page: Page,
  data: Awaited<ReturnType<typeof seed>>,
  layout: Layout | 'forest',
  width: number,
  mode: 'light' | 'dark'
) {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 915 });
  await page.addInitScript(
    ({ mode, preferences }) => {
      localStorage.setItem('uimori:theme', mode);
      for (const [key, value] of Object.entries(preferences)) localStorage.setItem(key, value);
    },
    { mode, preferences: readingPreferences }
  );
  await page.goto(`/?chat=${data.chatId}&source=${data.sourceId}`);
  await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', `builtin:${layout}`);
  const scene = page.locator(`[data-source-id="${data.sourceId}"]`);
  await expect(scene.getByTestId('source-text')).toContainText(endMarker);
  return {
    scene,
    reader: page.locator('[data-reader-scrollport]'),
    gallery: scene.locator('[data-uimori-part="scene-portraits"] .scene-portraits'),
    bodyScroll: scene.locator('[slot="body"][data-uimori-body-scroll]'),
    requestPersona: scene.locator('[data-uimori-part="request-persona"]'),
  };
}

async function noHorizontalOverflow(page: Page, scene: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  // Decorative tape/bookmarks may intentionally overdraw a frame. Check the actual
  // scrollport and prose, not the decoration's local paint bounds.
  const metrics = await scene.evaluate((node) => {
    const scrollport = node.closest<HTMLElement>('[data-reader-scrollport]');
    const body = node.querySelector<HTMLElement>('[slot="body"]');
    return {
      scrollport: scrollport ? scrollport.scrollWidth - scrollport.clientWidth : 0,
      body: body ? body.scrollWidth - body.clientWidth : 0,
    };
  });
  expect(metrics.scrollport).toBeLessThanOrEqual(1);
  expect(metrics.body).toBeLessThanOrEqual(1);
}

async function imageLoaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
}

for (const layout of layouts) {
  for (const width of [1440, 412]) {
    for (const mode of ['light', 'dark'] as const) {
      test(`NARRATIVE ${layout} ${width} ${mode}: long prose, real portraits and controls`, async ({
        page,
        request,
      }, info) => {
        test.setTimeout(90000);
        const data = await seed(request, layout);
        const errors: string[] = [];
        const generationRequests: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (value) => {
          if (
            value.method() === 'POST' &&
            /\/(?:runs|translation|retranslate|retry|rejudge|risu-action)(?:\?|$)/u.test(
              value.url()
            )
          )
            generationRequests.push(new URL(value.url()).pathname);
        });
        const { scene, reader, gallery, bodyScroll, requestPersona } = await openStory(
          page,
          data,
          layout,
          width,
          mode
        );
        const source = scene.getByTestId('source-text');
        await expect(gallery).toHaveCount(1);
        await expect(gallery).toBeVisible();
        await expect(page.locator('[data-uimori-part="gallery"]')).toBeHidden();
        await expect(
          page.locator('[data-uimori-part="scene-portraits"] .scene-portraits')
        ).toHaveCount(2);
        const bot = gallery.locator('[data-uimori-part="bot-portrait"] img');
        await imageLoaded(bot);
        expect(
          await bot.evaluate(
            (node) =>
              (node as HTMLImageElement).naturalWidth / (node as HTMLImageElement).naturalHeight
          )
        ).toBeCloseTo(2 / 3, 2);
        const persona = requestPersona.locator('[data-uimori-part="persona-portrait"] img');
        await imageLoaded(persona);
        expect(
          await persona.evaluate(
            (node) =>
              (node as HTMLImageElement).naturalWidth / (node as HTMLImageElement).naturalHeight
          )
        ).toBe(1);
        const portraitSource = await bot.getAttribute('src');
        expect(portraitSource).toMatch(/^\/api\//u);
        await reader.evaluate((node) => {
          node.scrollTop = 0;
        });
        await expect(bodyScroll).toHaveCount(1);
        await expect(bodyScroll).toBeVisible();
        const metrics = await bodyScroll.evaluate((node) => ({
          height: node.clientHeight,
          fullHeight: node.scrollHeight,
          overflow: getComputedStyle(node).overflowY,
        }));
        expect(tokenCount).toBeGreaterThan(10000);
        expect(metrics.fullHeight).toBeGreaterThan(metrics.height * 5);
        expect(metrics.height).toBeGreaterThan(100);
        expect(metrics.height).toBeLessThan(width === 1440 ? 1000 : 915);
        expect(['auto', 'scroll']).toContain(metrics.overflow);
        await expect(gallery.locator('[data-uimori-part="persona-portrait"]')).toBeHidden();
        await expect(gallery.locator('figcaption small').filter({ visible: true })).toHaveCount(0);
        await expect(
          requestPersona.locator('figcaption small').filter({ visible: true })
        ).toHaveCount(0);
        const requestBox = await scene.locator('[data-uimori-part="request"]').boundingBox();
        const personaBox = await requestPersona.boundingBox();
        if (width === 412) {
          expect(personaBox!.y + personaBox!.height).toBeLessThanOrEqual(requestBox!.y + 1);
        } else {
          expect(personaBox!.x).toBeGreaterThanOrEqual(requestBox!.x + requestBox!.width - 1);
        }
        await noHorizontalOverflow(page, scene);
        if (layout === 'classic-frame') {
          const botButton = gallery.locator('[data-uimori-part="bot-portrait"] button');
          await expect(botButton).toHaveCSS('border-radius', '0px');
          await expect(botButton).toHaveCSS('mask-image', 'none');
          await expect(bot).toHaveCSS('mask-image', 'none');
          const portraitBox = (await bot.boundingBox())!;
          const bodyBox = (await bodyScroll.boundingBox())!;
          if (width === 1440) {
            await expect(bot).toHaveCSS('object-fit', 'contain');
            expect(portraitBox.x + portraitBox.width).toBeLessThanOrEqual(bodyBox.x);
            expect(portraitBox.height).toBeGreaterThan(portraitBox.width);
          } else {
            expect(portraitBox.width).toBeGreaterThan(portraitBox.height);
            expect(portraitBox.y + portraitBox.height).toBeLessThanOrEqual(bodyBox.y);
          }
        }
        // The projected body stays intact; the theme-owned wrapper owns the inner scroll.
        expect(
          await source.evaluate(
            (node) => node.scrollHeight <= (node as HTMLElement).clientHeight + 1
          )
        ).toBe(true);
        if (width === 1440) {
          const manuscript = await scene.locator('.manuscript').boundingBox();
          const composer = await page.locator('.composer-dock').boundingBox();
          expect(manuscript!.y + manuscript!.height).toBeLessThanOrEqual(composer!.y + 1);
          // Expanded receipts use the outer reader without hiding the scene actions.
          const activityDisclosure = scene.getByTestId('turn-activity').locator(':scope > summary');
          await activityDisclosure.click();
          const usage = scene.getByTestId('scene-usage');
          const disclosure = usage.locator('summary').first();
          await disclosure.click();
          await expect(usage).toHaveAttribute('open', '');
          const actions = scene.locator('[data-uimori-part="actions"]');
          await actions.scrollIntoViewIfNeeded();
          await expect(actions).toBeInViewport();
          const actionsBox = (await actions.boundingBox())!;
          expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(composer!.y + 1);
          await page.screenshot({ path: info.outputPath(`${layout}-${mode}-usage-expanded.png`) });
          await disclosure.click();
          await expect(usage).not.toHaveAttribute('open', '');
          await activityDisclosure.click();
          await reader.evaluate((node) => {
            node.scrollTop = 0;
          });
        }
        await page.screenshot({ path: info.outputPath(`${layout}-${mode}-${width}.png`) });
        await info.attach('narrative-reader-measurements', {
          contentType: 'application/json',
          body: JSON.stringify({ layout, width, mode, tokens: tokenCount, scenes: 2, ...metrics }),
        });

        const enlarge = gallery.getByRole('button', {
          name: '린 메이화 대표 이미지 확대',
          exact: true,
        });
        await enlarge.scrollIntoViewIfNeeded();
        const beforeZoom = await reader.evaluate((node) => node.scrollTop);
        const target = await enlarge.boundingBox();
        expect(target!.width).toBeGreaterThanOrEqual(44);
        expect(target!.height).toBeGreaterThanOrEqual(44);
        await enlarge.click();
        const dialog = page.getByRole('dialog', { name: '린 메이화 대표 이미지', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('img')).toHaveAttribute('src', portraitSource!);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(enlarge).toBeFocused();
        expect(
          Math.abs((await reader.evaluate((node) => node.scrollTop)) - beforeZoom)
        ).toBeLessThan(3);

        const enlargePersona = requestPersona.getByRole('button', {
          name: '여행자 대표 이미지 확대',
          exact: true,
        });
        await enlargePersona.click();
        const personaDialog = page.getByRole('dialog', { name: '여행자 대표 이미지', exact: true });
        await expect(personaDialog).toBeVisible();
        await expect(personaDialog.locator('img')).toHaveAttribute(
          'src',
          (await persona.getAttribute('src'))!
        );
        await page.keyboard.press('Escape');
        await expect(personaDialog).toBeHidden();
        await expect(enlargePersona).toBeFocused();

        const clipboard: string[] = [];
        await page.exposeFunction('captureNarrativeCopy', (value: string) => clipboard.push(value));
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: (value: string) =>
                (
                  window as unknown as {
                    captureNarrativeCopy: (value: string) => Promise<void>;
                  }
                ).captureNarrativeCopy(value),
            },
          });
        });
        const copy = scene.getByRole('button', { name: '본문 복사', exact: true });
        await expect(copy).toHaveCount(1);
        await expect(
          bodyScroll.getByRole('button', { name: '본문 복사', exact: true })
        ).toHaveCount(0);
        await expect(
          bodyScroll.getByRole('button', { name: '원문 수정', exact: true })
        ).toHaveCount(0);
        await copy.click();
        await expect.poll(() => clipboard.at(-1)).toBe(data.text);
        const edit = scene.getByRole('button', { name: '원문 수정', exact: true });
        await expect(edit).toHaveCount(1);
        await bodyScroll.evaluate((node) => {
          node.scrollTop = 400;
        });
        const beforeEdit = await bodyScroll.evaluate((node) => node.scrollTop);
        await edit.click();
        const editor = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
        await expect(editor).toBeFocused();
        await expect(editor).toBeInViewport();
        await expect(editor).toHaveValue(data.text);
        await editor.fill('Unsaved narrative edit');
        await page.keyboard.press('Escape');
        await expect(editor).toHaveCount(0);
        await expect(source).toContainText(endMarker);
        await expect
          .poll(async () =>
            Math.abs((await bodyScroll.evaluate((node) => node.scrollTop)) - beforeEdit)
          )
          .toBeLessThan(3);

        const language = scene.getByRole('group', { name: '원문과 번역 보기' });
        await language.getByRole('button', { name: '번역 보기', exact: true }).click();
        await expect(scene.getByTestId('translation-text')).toContainText('After the rain');
        await language.getByRole('button', { name: '원문 보기', exact: true }).click();
        await expect(source).toContainText(endMarker);

        // Wheel scrolling stays inside the scene body while its portrait and actions stay put.
        await reader.evaluate((node) => {
          node.scrollTop = 0;
        });
        await bodyScroll.evaluate((node) => {
          node.scrollTop = 0;
        });
        await bodyScroll.scrollIntoViewIfNeeded();
        const outerPosition = await reader.evaluate((node) => node.scrollTop);
        const portraitPosition = (await bot.boundingBox())!.y;
        const actionPosition = (await copy.boundingBox())!.y;
        const bounds = await bodyScroll.boundingBox();
        await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
        await page.mouse.wheel(0, 700);
        await expect.poll(() => bodyScroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
        expect(
          Math.abs((await reader.evaluate((node) => node.scrollTop)) - outerPosition)
        ).toBeLessThan(3);
        expect(Math.abs((await bot.boundingBox())!.y - portraitPosition)).toBeLessThan(3);
        await expect(bot).toBeInViewport();
        expect(Math.abs((await copy.boundingBox())!.y - actionPosition)).toBeLessThan(3);
        await bodyScroll.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        await expect(source.getByText(endMarker, { exact: true })).toBeInViewport();
        await copy.click();
        await expect.poll(() => clipboard.at(-1)).toBe(data.text);
        const second = page.locator(`[data-source-id="${data.secondId}"]`);
        await second.getByTestId('source-text').scrollIntoViewIfNeeded();
        await expect(second.getByTestId('source-text')).toContainText('SECOND_SCENE_END');
        await second.getByRole('button', { name: '본문 복사', exact: true }).click();
        await expect.poll(() => clipboard.at(-1)).toContain('SECOND_SCENE_END');
        await noHorizontalOverflow(page, second);

        const after = await detail(request, data.chatId);
        expect(after.sources).toEqual(data.before.sources);
        expect(after.runs).toEqual(data.before.runs);
        expect(after.jobs).toEqual(data.before.jobs);
        expect(after.attempts).toEqual(data.before.attempts);
        expect(generationRequests).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  }

  test(`NARRATIVE ${layout}: every palette preserves layout nodes, text and reading state`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(90000);
    const data = await seed(request, layout, { squareBot: true });
    const { scene, reader, gallery, bodyScroll, requestPersona } = await openStory(
      page,
      data,
      layout,
      1440,
      'light'
    );
    const source = scene.getByTestId('source-text');
    const frame = scene.locator('[data-uimori-part="scene-frame"]');
    await source.evaluate((node) => node.setAttribute('data-stable-body', 'preserved'));
    await frame.evaluate((node) => {
      node
        .shadowRoot!.querySelector('slot[name="body"]')!
        .setAttribute('data-stable-layout', 'yes');
    });
    const bot = gallery.locator('[data-uimori-part="bot-portrait"] img');
    await imageLoaded(bot);
    expect(
      await bot.evaluate(
        (node) => (node as HTMLImageElement).naturalWidth / (node as HTMLImageElement).naturalHeight
      )
    ).toBe(1);
    const persona = requestPersona.locator('[data-uimori-part="persona-portrait"] img');
    await imageLoaded(persona);
    expect(
      await persona.evaluate(
        (node) => (node as HTMLImageElement).naturalWidth / (node as HTMLImageElement).naturalHeight
      )
    ).toBeCloseTo(2 / 3, 2);
    const quote = source.locator('[data-quote-role="dialogue"]').first();
    await expect(quote).toHaveAttribute('data-emphasis', 'subtle');
    const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
    await composer.fill('Keep this composer draft while I try colors.');
    const sourceText = await source.textContent();
    await bodyScroll.evaluate((node) => {
      node.scrollTop = 500;
    });
    const innerPosition = await bodyScroll.evaluate((node) => node.scrollTop);
    expect(innerPosition).toBeGreaterThan(100);
    const position = await reader.evaluate((node) => node.scrollTop);
    const settings = await page.evaluate((keys) => {
      return Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]));
    }, Object.keys(readingPreferences));
    for (const palette of BUILTIN_PALETTES) {
      await select(request, { paletteId: palette.id });
      await page.evaluate(() => window.dispatchEvent(new Event('uimori-themes-changed')));
      await expect
        .poll(() =>
          page
            .locator('html')
            .evaluate((node) => getComputedStyle(node).getPropertyValue('--bg').trim())
        )
        .toBe(palette.colors.light.bg);
      await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', `builtin:${layout}`);
      await expect(source).toHaveAttribute('data-stable-body', 'preserved');
      expect(
        await frame.evaluate((node) =>
          node.shadowRoot!.querySelector('slot[name="body"]')!.getAttribute('data-stable-layout')
        )
      ).toBe('yes');
      expect(await source.textContent()).toBe(sourceText);
      await expect(source).toContainText(endMarker);
      await expect(quote).toHaveAttribute('data-emphasis', 'subtle');
      await expect(composer).toHaveValue('Keep this composer draft while I try colors.');
      expect(
        await page.evaluate(
          (keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
          Object.keys(readingPreferences)
        )
      ).toEqual(settings);
      expect(Math.abs((await reader.evaluate((node) => node.scrollTop)) - position)).toBeLessThan(
        3
      );
      expect(
        Math.abs((await bodyScroll.evaluate((node) => node.scrollTop)) - innerPosition)
      ).toBeLessThan(3);
      await noHorizontalOverflow(page, scene);
    }
    await page.screenshot({ path: info.outputPath(`${layout}-sage-square-portrait.png`) });
    await select(request, { paletteId: 'theme' });
    await page.evaluate(() => window.dispatchEvent(new Event('uimori-themes-changed')));
    await expect(source).toHaveAttribute('data-stable-body', 'preserved');
    expect((await detail(request, data.chatId)).sources).toEqual(data.before.sources);
  });

  test(`NARRATIVE ${layout}: missing and failed portrait fallbacks stay readable`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(90000);
    const missing = await seed(request, layout, { missing: true, noPersona: true, long: false });
    const missingStory = await openStory(page, missing, layout, 412, 'light');
    const fallback = missingStory.gallery.locator(
      '[data-uimori-part="bot-portrait"] .reader-portrait-empty'
    );
    await expect(fallback).toBeVisible();
    await expect(missingStory.requestPersona.locator('button')).toHaveCount(0);
    await expect(missingStory.gallery.locator('[data-uimori-part="persona-portrait"]')).toHaveCount(
      0
    );
    await expect(
      missingStory.gallery.getByRole('button', { name: '린 메이화 대표 이미지 확대', exact: true })
    ).toBeDisabled();
    await noHorizontalOverflow(page, missingStory.scene);
    await page.screenshot({ path: info.outputPath(`${layout}-missing-portrait-412.png`) });

    const stored = await seed(request, layout, { long: false });
    const storedStory = await openStory(page, stored, layout, 1440, 'dark');
    const bot = storedStory.gallery.locator('[data-uimori-part="bot-portrait"] img');
    await imageLoaded(bot);
    const src = await bot.getAttribute('src');
    await page.route(`**${src}`, (route) =>
      route.fulfill({ status: 404, body: 'Unavailable synthetic portrait' })
    );
    await page.reload();
    await expect(
      storedStory.gallery.locator('[data-uimori-part="bot-portrait"] .reader-portrait-empty')
    ).toBeVisible();
    await expect(storedStory.scene.getByTestId('source-text')).toContainText(endMarker);
    await noHorizontalOverflow(page, storedStory.scene);
    await page.screenshot({ path: info.outputPath(`${layout}-failed-portrait-1440.png`) });
  });
}

for (const width of [1440, 412]) {
  test(`NARRATIVE ${width}: frames without portrait content use the full manuscript`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '테마·색상');
    await page.getByText('현재 테마로 예문 보기', { exact: true }).click();
    const sample = page.locator('.theme-sample');
    const frame = sample.locator('[data-uimori-part="scene-frame"]');
    for (const [layout, title] of [
      ['cinematic', '시네마틱'],
      ['letter', '편지지'],
      ['scrapbook', '스크랩북'],
      ['classic-frame', '클래식 프레임'],
    ] as const) {
      await page.getByRole('button', { name: `${title} 테마 적용`, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-uimori-theme', `builtin:${layout}`);
      await expect(frame.locator('[data-uimori-part="scene-portraits"]')).toHaveCount(0);
      await expect(frame.locator('.portrait')).toBeHidden();
      await expect(frame.locator('.manuscript')).toHaveCSS('display', 'block');
      await expect(sample.getByText('첫 번째 장면', { exact: true })).toBeVisible();
      const body = frame.locator('[slot="body"]');
      expect((await body.boundingBox())!.width).toBeGreaterThan(100);
      await noHorizontalOverflow(page, frame);
      await sample.scrollIntoViewIfNeeded();
      await sample.screenshot({ path: info.outputPath(`${layout}-no-portrait-${width}.png`) });
    }
  });
}

for (const [width, mode] of [
  [1440, 'dark'],
  [412, 'light'],
] as const) {
  test(`NARRATIVE default ${width} ${mode}: equal circular portraits and reusable full-image dialogs`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(90000);
    const data = await seed(request, 'cinematic');
    await select(request, { themeId: 'builtin:forest', targetId: data.chatId });
    const { scene, reader, bodyScroll, requestPersona } = await openStory(
      page,
      data,
      'forest',
      width,
      mode
    );
    await reader.evaluate((node) => {
      node.scrollTop = 0;
    });
    const context = page.locator('.story-context');
    await expect(context).toBeVisible();
    const bot = context.locator('.reader-bot-avatar img');
    await imageLoaded(bot);
    const avatar = context.locator('.reader-bot-avatar');
    await expect(avatar).toHaveRole('button');
    await expect(avatar).toHaveAccessibleName('린 메이화 대표 이미지 확대');
    const botName = context.getByText('린 메이화', { exact: true });
    await expect(botName).toBeVisible();
    await expect(bodyScroll).toHaveCount(0);
    await expect(scene.locator('[data-uimori-part="scene-portraits"]')).toHaveCount(0);
    await expect(page.locator('[data-uimori-part="gallery"]')).toBeHidden();
    const persona = requestPersona.locator('[data-uimori-part="persona-portrait"] img');
    await imageLoaded(persona);
    const personaButton = requestPersona.getByRole('button', {
      name: '여행자 대표 이미지 확대',
      exact: true,
    });
    const portraitSize = width === 1440 ? 72 : 60;
    const personaName = requestPersona.locator('figcaption strong');
    await expect(personaName).toHaveText('여행자');
    for (const [button, name] of [
      [avatar, botName],
      [personaButton, personaName],
    ]) {
      const box = (await button.boundingBox())!;
      const nameBox = (await name.boundingBox())!;
      expect(box.width).toBeCloseTo(portraitSize, 0);
      expect(box.height).toBeCloseTo(portraitSize, 0);
      await expect(button).toHaveCSS('border-radius', '50%');
      expect(nameBox.x).toBeGreaterThanOrEqual(box.x + box.width);
      expect(nameBox.y).toBeLessThan(box.y + box.height);
      expect(nameBox.y + nameBox.height).toBeGreaterThan(box.y);
    }
    const requestBox = await scene.locator('[data-uimori-part="request"]').boundingBox();
    const personaBox = await requestPersona.boundingBox();
    if (width === 412) {
      expect(personaBox!.y + personaBox!.height).toBeLessThanOrEqual(requestBox!.y + 1);
    } else {
      expect(personaBox!.x).toBeGreaterThanOrEqual(requestBox!.x + requestBox!.width - 1);
    }
    await expect(requestPersona.locator('figcaption small').filter({ visible: true })).toHaveCount(
      0
    );
    await noHorizontalOverflow(page, scene);
    await page.screenshot({ path: info.outputPath(`default-${mode}-${width}.png`) });
    for (const [button, thumbnail, title, ratio] of [
      [avatar, bot, '린 메이화', 2 / 3],
      [personaButton, persona, '여행자', 1],
    ] as const) {
      const sourceUrl = (await thumbnail.getAttribute('src'))!;
      const scrollTop = await reader.evaluate((node) => node.scrollTop);
      for (const dismissal of ['Escape', 'close', 'backdrop'] as const) {
        await button.click();
        const dialog = page.getByRole('dialog', { name: `${title} 대표 이미지`, exact: true });
        await expect(dialog).toBeVisible();
        const original = dialog.locator('img');
        await imageLoaded(original);
        await expect(original).toHaveAttribute('src', sourceUrl);
        await expect(original).toHaveCSS('object-fit', 'contain');
        expect(
          await original.evaluate(
            (node) =>
              (node as HTMLImageElement).naturalWidth / (node as HTMLImageElement).naturalHeight
          )
        ).toBeCloseTo(ratio, 2);
        const viewport = page.viewportSize()!;
        const box = (await dialog.boundingBox())!;
        const gap = width === 412 ? 16 : 24;
        expect(box.x).toBeGreaterThanOrEqual(gap);
        expect(box.y).toBeGreaterThanOrEqual(gap);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - gap);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - gap);
        expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(1);
        await expect(original).toBeInViewport({ ratio: 1 });
        const imageBox = (await original.boundingBox())!;
        expect(imageBox.width / imageBox.height).toBeCloseTo(ratio, 2);
        const close = dialog.getByRole('button', {
          name: `${title} 대표 이미지 닫기`,
          exact: true,
        });
        await expect(close).toBeInViewport({ ratio: 1 });
        const closeBox = (await close.boundingBox())!;
        expect(closeBox.width).toBeGreaterThanOrEqual(44);
        expect(closeBox.height).toBeGreaterThanOrEqual(44);
        if (dismissal === 'Escape') {
          await page.screenshot({ path: info.outputPath(`portrait-dialog-${title}-${width}.png`) });
          await page.keyboard.press('Escape');
        } else if (dismissal === 'backdrop') await page.mouse.click(8, 8);
        else
          await dialog
            .getByRole('button', { name: `${title} 대표 이미지 닫기`, exact: true })
            .click();
        await expect(dialog).toBeHidden();
        await expect(button).toBeFocused();
        expect(
          Math.abs((await reader.evaluate((node) => node.scrollTop)) - scrollTop)
        ).toBeLessThan(3);
      }
    }
    expect((await detail(request, data.chatId)).sources).toEqual(data.before.sources);
  });
}

test('BACKGROUND upload, independent scopes, overlays, clear and reload', async ({
  page,
  request,
}, info) => {
  const data = await seed(request, 'classic-frame', { long: false });
  await openStory(page, data, 'classic-frame', 1440, 'light');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마·색상');
  const bytes = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#73a7ab"/><circle cx="680" cy="140" r="90" fill="#ffd181"/><path d="M0 600V450L240 180L500 430L700 300L900 500V600Z" fill="#456253"/></svg>'
    )
  )
    .png()
    .toBuffer();
  await page
    .getByLabel('배경 이미지 선택', { exact: true })
    .setInputFiles({ name: 'landscape.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.getByRole('button', { name: '배경 저장', exact: true })).toBeEnabled();
  await page.getByLabel('배경 흐림', { exact: true }).fill('7');
  await page.getByLabel('밝은 모드 배경 덮개', { exact: true }).fill('25');
  await page.getByLabel('어두운 모드 배경 덮개', { exact: true }).fill('55');
  await page.getByRole('button', { name: '배경 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '배경 저장', exact: true })).toBeDisabled();
  await page.screenshot({
    path: info.outputPath('background-settings-desktop.png'),
    fullPage: true,
  });
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
  await page.screenshot({
    path: info.outputPath('background-classic-light-desktop.png'),
    fullPage: true,
  });
  await page.reload();
  await expect(background).toBeVisible();
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마·색상');
  await page.getByLabel('테마 화면 모드', { exact: true }).selectOption('dark');
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
  await page.screenshot({
    path: info.outputPath('background-classic-dark-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 412, height: 915 });
  await page.screenshot({
    path: info.outputPath('background-classic-dark-mobile.png'),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  // Restore workspace defaults for unrelated browser scenarios in the same fixture server.
  const final = await (await request.get('/api/themes')).json();
  expect(
    (
      await request.post('/api/themes/background', {
        data: { scope: 'global', background: null, expectedRevision: final.preferences.revision },
      })
    ).ok()
  ).toBe(true);
});

test('BACKGROUND pending upload discard and dirty save-close preserve scope ownership', async ({
  page,
  request,
}) => {
  const data = await seed(request, 'classic-frame', { long: false });
  await openStory(page, data, 'classic-frame', 1440, 'light');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마·색상');
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/package-image-blobs', async (route) => {
    started();
    await delayed;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hash: 'b'.repeat(64), mime: 'image/webp' }),
      })
      .catch(() => {});
  });
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#669988' } })
    .png()
    .toBuffer();
  await page
    .getByLabel('배경 이미지 선택', { exact: true })
    .setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: image });
  await startedPromise;
  await expect(page.getByLabel('테마 적용 범위', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await page.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  release();
  await page.unroute('**/api/package-image-blobs');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마·색상');
  await expect(page.getByRole('button', { name: '배경 저장', exact: true })).toBeDisabled();
  await page.getByLabel('배경 흐림', { exact: true }).fill('9');
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await page.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(page.getByRole('button', { name: '설정 닫기', exact: true })).toHaveCount(0);
  const catalog = await (await request.get('/api/themes')).json();
  expect(catalog.preferences.defaultBackground).toMatchObject({ imageHash: null, blur: 9 });
  expect(
    (
      await request.post('/api/themes/background', {
        data: { scope: 'global', background: null, expectedRevision: catalog.preferences.revision },
      })
    ).ok()
  ).toBe(true);
});

for (const layout of layouts) {
  test(`NARRATIVE HEIGHT ${layout}: reader space, composer and navigator clearance`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(90000);
    const data = await seed(request, layout);
    const { scene, reader, gallery, bodyScroll } = await openStory(page, data, layout, 412, 'dark');
    const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
    const measurements: object[] = [];
    for (const width of [360, 412]) {
      let previous = 0;
      for (const height of [600, 700, 800, 915]) {
        await page.setViewportSize({ width, height });
        await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height);
        const bodyHeight = await bodyScroll.evaluate((node) => node.clientHeight);
        const readerHeight = await reader.evaluate((node) => node.clientHeight);
        expect(readerHeight).toBeGreaterThan(300);
        expect(bodyHeight).toBeGreaterThan(230);
        expect(bodyHeight).toBeLessThan(readerHeight - 80);
        if (previous) expect(bodyHeight).toBeGreaterThan(previous + 40);
        previous = bodyHeight;
        measurements.push({ width, height, bodyHeight, readerHeight });
        await noHorizontalOverflow(page, scene);
      }
    }
    await page.setViewportSize({ width: 412, height: 700 });
    // A short translation uses its content height, rather than stretching to the cap.
    const language = scene.getByRole('group', { name: '원문과 번역 보기' });
    const originalHeight = await bodyScroll.evaluate((node) => node.clientHeight);
    await language.getByRole('button', { name: '번역 보기', exact: true }).click();
    await expect(scene.getByTestId('translation-text')).toContainText('After the rain');
    expect(await bodyScroll.evaluate((node) => node.clientHeight)).toBeLessThan(originalHeight);
    await language.getByRole('button', { name: '원문 보기', exact: true }).click();
    await expect(scene.getByTestId('source-text')).toContainText(endMarker);

    await page.setViewportSize({ width: 360, height: 600 });
    const compactBody = await bodyScroll.evaluate((node) => node.clientHeight);
    const compactReader = await reader.evaluate((node) => node.clientHeight);
    await composer.fill('작성 중인 여러 줄 요청\n'.repeat(12));
    await expect(page.locator('.composer-dock > .composer')).toHaveClass(/grown/u);
    await expect
      .poll(() => reader.evaluate((node) => node.clientHeight))
      .toBeLessThan(compactReader - 40);
    const expandedBody = await bodyScroll.evaluate((node) => node.clientHeight);
    expect(expandedBody).toBeGreaterThanOrEqual(200);
    expect(expandedBody).toBeLessThan(compactBody - 20);
    await noHorizontalOverflow(page, scene);
    // Even in the smallest reader, page scrolling still reaches portrait, title and actions.
    const portrait = gallery.getByRole('button', {
      name: '린 메이화 대표 이미지 확대',
      exact: true,
    });
    await portrait.scrollIntoViewIfNeeded();
    await expect(portrait).toBeInViewport();
    const copy = scene.getByRole('button', { name: '본문 복사', exact: true });
    await copy.scrollIntoViewIfNeeded();
    await expect(copy).toBeInViewport();
    await bodyScroll.focus();
    await expect(bodyScroll).toBeFocused();
    await bodyScroll.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => bodyScroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath(`${layout}-360x600-expanded.png`) });
    await composer.fill('');

    for (const enabled of [true, false]) {
      await page.evaluate(
        (enabled) => localStorage.setItem('uimori:scene-navigator', String(enabled)),
        enabled
      );
      await page.reload();
      await expect(scene.getByTestId('source-text')).toContainText(endMarker);
      await expect(page.locator('.scene-mini-navigator')).toHaveCount(enabled ? 1 : 0);
      await page.setViewportSize({ width: 412, height: 700 });
      await reader.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const lastActions = page.locator('[data-uimori-part="actions"]').last();
      await expect(lastActions).toBeInViewport();
      const actionsBox = (await lastActions.boundingBox())!;
      const composerBox = (await page.locator('.composer-dock').boundingBox())!;
      expect(actionsBox.y + actionsBox.height).toBeLessThan(composerBox.y);
      if (enabled) {
        const navigatorBox = (await page.locator('.scene-mini-navigator').boundingBox())!;
        expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(navigatorBox.y);
      } else {
        const padding = await page
          .locator('.reader')
          .evaluate((node) => parseFloat(getComputedStyle(node).paddingBottom));
        expect(padding).toBeLessThanOrEqual(32);
      }
      await page.screenshot({
        path: info.outputPath(`${layout}-412x700-navigator-${enabled}.png`),
      });
    }
    await openChatMenu(page);
    await page.getByRole('button', { name: '집중 읽기', exact: true }).click();
    await expect(gallery).toBeHidden();
    await expect(page.locator('.scene-mini-navigator')).toHaveCount(0);
    await expect(bodyScroll).toBeVisible();
    await noHorizontalOverflow(page, scene);
    await page.getByRole('button', { name: '집중 읽기 종료', exact: true }).click();
    await expect(gallery).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 800 });
    await noHorizontalOverflow(page, scene);
    expect(await reader.evaluate((node) => node.clientWidth)).toBeGreaterThan(500);
    await page.setViewportSize({ width: 1440, height: 900 });
    await noHorizontalOverflow(page, scene);
    expect(await bodyScroll.evaluate((node) => node.clientHeight)).toBeLessThanOrEqual(450);
    await expect(page.locator('.reader')).toHaveCSS('padding-bottom', '48px');
    await bodyScroll.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${layout}-1440x900.png`) });

    // The same height/containment rules do not leak into the plain-page layout.
    await select(request, { themeId: 'builtin:forest', targetId: data.chatId });
    await page.reload();
    await expect(page.locator('[data-uimori-body-scroll]')).toHaveCount(0);
    await expect(reader).toHaveCSS('container-type', 'normal');
    await info.attach('responsive-reader-heights', {
      contentType: 'application/json',
      body: JSON.stringify({ layout, measurements, compactBody, expandedBody }),
    });
  });
}
