import { test, expect, type APIRequestContext, type Locator } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
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
      const portraitTarget = await enlarge.boundingBox();
      expect(portraitTarget!.width).toBeGreaterThanOrEqual(44);
      expect(portraitTarget!.height).toBeGreaterThanOrEqual(44);
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
      // A compact director memo keeps its real copy action reachable at desktop and phone widths.
      await scene.getByTestId('source-request').click();
      await scene.getByRole('button', { name: '요청 복사', exact: true }).click();
      await expect.poll(() => clipboard.at(-1)).toBe(requestText);
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
  // Intermediate sizes must collapse the gallery before squeezing the manuscript.
  for (const width of [768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await gallery.boundingBox())!.height).toBeLessThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
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

// Opt-in measurements extend the existing synthetic browser runner, without timing gates.
if (process.env.UIMORI_BENCHMARK === '1')
  for (const sceneCount of [8, 30]) {
    test(`PERF ${sceneCount} long manuscript reentry, past pages and saved translation switches`, async ({
      page,
      request,
    }, info) => {
      test.setTimeout(240000);
      await page.setViewportSize({ width: 1440, height: 1000 });
      const imageResponse = await request.post('/api/package-image-blobs', {
        data: {
          base64: (
            await sharp({ create: { width: 24, height: 24, channels: 4, background: '#618472' } })
              .png()
              .toBuffer()
          ).toString('base64'),
        },
      });
      expect(imageResponse.ok(), await imageResponse.text()).toBe(true);
      const blob = await imageResponse.json();
      const widget = `<style>.perf-panel{border:2px solid rgb(30, 80, 120);padding:8px}.perf-panel img{width:24px;height:24px}</style>
<div class="perf-panel"><img src="${blob.url}" alt="Synthetic local tile"><button risu-trigger="perfChoice">Author choice</button><details><summary>Author notes</summary><input aria-label="Author draft" value="Preserved widget"></details></div>`;
      const encoding = get_encoding('o200k_base');
      const repeated = (unit: string, tokens: number) => {
        let text = unit.repeat(Math.ceil(tokens / encoding.encode(unit).length));
        while (encoding.encode(text).length < tokens) text += unit;
        return text;
      };
      const original = `${widget}\n\n${repeated(`${passage}\n\n`, 7500)}\n\n그녀는 찻잔을 놓았다. “오늘은 여기서 기다릴게요.” 여행자는 창밖을 바라보았다.`;
      const translated = `${widget}\n\n${repeated(
        'The morning light reached the end of the bookshelf. Rain had stopped during the night. Whenever the breeze crossed the wet stone path, the drops left on the leaves shone like small stars.\n\n“Let us take our time today.” She closed the book and looked toward the open window. Her companion offered a warm cup of tea. Many stories remained untold, but neither of them needed to hurry.\n\n',
        7500
      )}`;
      const entries = Array.from({ length: sceneCount }, (_, index) => ({
        request: `Performance scene ${index + 1}`,
        text: `${original}\n\nPERF_ORIGINAL_END_${index + 1}`,
        translation: `${translated}\n\nPERF_TRANSLATION_END_${index + 1}`,
      }));
      const sizes = entries.map((entry) =>
        Object.fromEntries(
          (['text', 'translation'] as const).map((kind) => [
            kind,
            {
              language: kind === 'text' ? 'ko' : 'en',
              tokenizer: 'o200k_base',
              utf16Chars: entry[kind].length,
              utf8Bytes: Buffer.byteLength(entry[kind], 'utf8'),
              tokens: encoding.encode(entry[kind]).length,
              sha256: createHash('sha256').update(entry[kind]).digest('hex'),
            },
          ])
        )
      );
      encoding.free();
      const botResponse = await request.post('/api/content', {
        data: {
          kind: 'bot',
          title: 'Synthetic reader performance',
          description: '',
          text: '',
          loading: 'pinned',
          relatedIds: [],
          package: nativeContent(
            {
              name: 'Synthetic reader performance',
              description: 'Synthetic measured story.',
              extensions: {
                risuai: {
                  triggerscript: [
                    {
                      type: 'start',
                      effect: [
                        {
                          type: 'triggerlua',
                          code: "function perfChoice(id) setChatVar(id, 'choice', 'selected') end",
                        },
                      ],
                    },
                  ],
                },
              },
            },
            {
              images: [
                {
                  id: 'tile',
                  title: 'Synthetic local tile',
                  description: '',
                  blobHash: blob.hash,
                  mime: blob.mime,
                  allowedUse: 'inline',
                },
              ],
            }
          ),
        },
      });
      expect(botResponse.ok(), await botResponse.text()).toBe(true);
      const bot = await botResponse.json();
      const imported = await request.post('/api/chats/import-transcript', {
        data: {
          idempotencyKey: randomUUID(),
          transcript: {
            format: 'uimori-chat-transcript',
            version: 2,
            exportedAt: new Date().toISOString(),
            title: 'Measured long story',
            packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
            notes: [],
            entries,
          },
        },
      });
      expect(imported.ok(), await imported.text()).toBe(true);
      const chat = (await imported.json()).chat;
      const awayResponse = await request.post('/api/chats', {
        data: { title: 'Away from measured story', botId: bot.id },
      });
      expect(awayResponse.ok(), await awayResponse.text()).toBe(true);
      const away = await awayResponse.json();
      const lastIndex = sceneCount - 1;
      const latestStart = Math.floor(lastIndex / 5) * 5;
      const pastStart = latestStart - 5;
      const indexes = (start: number, end: number) =>
        Array.from({ length: end - start }, (_, i) => start + i);
      const before = await detail(request, chat.id);
      const sources = entries.map(
        (entry) => before.sources.find((source) => source.text === entry.text)!
      );
      expect(sources.every(Boolean)).toBe(true);
      const variables = await (await request.get(`/api/chats/${chat.id}/variables`)).json();
      const generationRequests: string[] = [],
        errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (value) => {
        if (
          value.method() === 'POST' &&
          /\/(?:runs|translation|retranslate|retry|rejudge|risu-action)(?:\?|$)/u.test(value.url())
        )
          generationRequests.push(new URL(value.url()).pathname);
      });
      await page.addInitScript(() => {
        localStorage.setItem('uimori:reading-language', 'original');
        localStorage.setItem(
          'uimori:readability',
          JSON.stringify({ emphasis: 'subtle', dialogueBreaks: true })
        );
      });
      await page.goto(`/?chat=${chat.id}&source=${sources[lastIndex].id}`);
      await expect(
        page.locator(`[data-source-id="${sources[lastIndex].id}"]`).getByTestId('source-text')
      ).toContainText(`PERF_ORIGINAL_END_${sceneCount}`);
      const sample = async (
        action: Locator,
        indexes: number[],
        mode: 'original' | 'translation'
      ) => {
        await expect(action).toBeVisible();
        await expect(action).toBeEnabled();
        return action.evaluate(
          (node, target) =>
            new Promise<{
              clickToReadyMs: number;
              resources: {
                path: string;
                duration: number;
                requestToFirstByteMs: number;
                responseBodyMs: number;
                transferBytes: number;
                decodedBytes: number;
              }[];
              longTasks: { start: number; duration: number }[];
              longTasksSupported: boolean;
            }>((resolve, reject) => {
              performance.clearResourceTimings();
              const tasks: { start: number; duration: number }[] = [];
              const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
              const collect = (values: PerformanceEntry[]) => {
                for (const value of values)
                  tasks.push({ start: value.startTime, duration: value.duration });
              };
              const observer = supported
                ? new PerformanceObserver((list) => collect(list.getEntries()))
                : undefined;
              observer?.observe({ type: 'longtask' });
              const start = performance.now();
              let frame = 0;
              const timeout = setTimeout(() => {
                cancelAnimationFrame(frame);
                observer?.disconnect();
                reject(new Error('Measured manuscript did not become ready'));
              }, 30000);
              const check = () => {
                const ready = target.sources.every(({ id, marker }) => {
                  const scene = document.querySelector(`[data-source-id="${id}"]`);
                  const surface = scene?.querySelector(
                    `[data-testid="${target.mode === 'original' ? 'source' : 'translation'}-text"] .risu-message-surface`
                  );
                  const content = surface?.shadowRoot?.querySelector('.risu-message-content');
                  const image = content?.querySelector<HTMLImageElement>('.perf-panel img');
                  const bounds = image?.getBoundingClientRect();
                  const onScreen = bounds && bounds.bottom > 0 && bounds.top < innerHeight;
                  return (
                    content?.textContent?.includes(marker) &&
                    image &&
                    (!onScreen || (image.complete && image.naturalWidth > 0))
                  );
                });
                if (!ready) {
                  frame = requestAnimationFrame(check);
                  return;
                }
                frame = requestAnimationFrame(() => {
                  frame = requestAnimationFrame(() => {
                    const end = performance.now();
                    clearTimeout(timeout);
                    if (observer) {
                      collect(observer.takeRecords());
                      observer.disconnect();
                    }
                    resolve({
                      clickToReadyMs: end - start,
                      longTasksSupported: supported,
                      longTasks: tasks
                        .filter((task) => task.start < end && task.start + task.duration > start)
                        .map((task) => ({ start: task.start - start, duration: task.duration })),
                      resources: performance
                        .getEntriesByType('resource')
                        .filter(
                          (entry) =>
                            entry.startTime >= start &&
                            new URL(entry.name).pathname.startsWith('/api/')
                        )
                        .map((entry) => {
                          const value = entry as PerformanceResourceTiming;
                          return {
                            path: new URL(value.name).pathname,
                            duration: value.duration,
                            requestToFirstByteMs: value.responseStart - value.requestStart,
                            responseBodyMs: value.responseEnd - value.responseStart,
                            transferBytes: value.transferSize,
                            decodedBytes: value.decodedBodySize,
                          };
                        }),
                    });
                  });
                });
              };
              (node as HTMLElement).click();
              frame = requestAnimationFrame(check);
            }),
          {
            mode,
            sources: indexes.map((index) => ({
              id: sources[index].id,
              marker: `PERF_${mode === 'original' ? 'ORIGINAL' : 'TRANSLATION'}_END_${index + 1}`,
            })),
          }
        );
      };
      const samples: {
        iteration: number;
        warmup: boolean;
        actions: Record<string, Awaited<ReturnType<typeof sample>>>;
      }[] = [];
      for (let iteration = 0; iteration < 6; iteration++) {
        await page.locator(`[data-chat-id="${away.id}"] .chat-link`).click();
        await expect(page.getByTestId('source')).toHaveCount(0);
        const reentry = await sample(
          page.locator(`[data-chat-id="${chat.id}"] .chat-link`),
          indexes(latestStart, sceneCount),
          'original'
        );
        const past = await sample(
          page
            .getByRole('navigation', { name: '원고 구간', exact: true })
            .getByRole('button', { name: '이전 원고', exact: true }),
          indexes(pastStart, latestStart),
          'original'
        );
        const scene = page.locator(`[data-source-id="${sources[pastStart].id}"]`);
        const translation = await sample(
          scene.getByRole('button', { name: '번역 보기', exact: true }),
          [pastStart],
          'translation'
        );
        const originalView = await sample(
          scene.getByRole('button', { name: '원문 보기', exact: true }),
          [pastStart],
          'original'
        );
        const authored = scene.locator('.risu-message-content');
        await expect(authored.locator('.perf-panel')).toHaveCSS('border-top-width', '2px');
        await expect(
          authored.getByRole('button', { name: 'Author choice', exact: true })
        ).toHaveCount(1);
        await expect(authored.getByLabel('Author draft', { exact: true })).toHaveValue(
          'Preserved widget'
        );
        await expect(authored.locator('.reading-quote-break-before').first()).toBeAttached();
        await expect(authored.locator('[data-quote-role="dialogue"]').first()).toHaveAttribute(
          'data-emphasis',
          'subtle'
        );
        samples.push({
          iteration,
          warmup: iteration === 0,
          actions: { reentry, past, translation, original: originalView },
        });
        await page
          .getByRole('navigation', { name: '원고 구간', exact: true })
          .getByRole('button', { name: '최근 원고', exact: true })
          .click();
        await expect(
          page.locator(`[data-source-id="${sources[lastIndex].id}"]`).getByTestId('source-text')
        ).toContainText(`PERF_ORIGINAL_END_${sceneCount}`);
      }
      const after = await detail(request, chat.id);
      expect(after.sources).toEqual(before.sources);
      expect(after.jobs).toEqual(before.jobs);
      expect(after.runs).toEqual(before.runs);
      expect(after.attempts).toEqual(before.attempts);
      expect(await (await request.get(`/api/chats/${chat.id}/variables`)).json()).toEqual(
        variables
      );
      expect(generationRequests).toEqual([]);
      expect(errors).toEqual([]);
      await info.attach('long-reader-performance', {
        contentType: 'application/json',
        body: JSON.stringify(
          {
            method: {
              warmups: 1,
              measuredRepeats: 5,
              tokenizer: 'o200k_base',
              sceneCount,
              clock:
                'Browser performance.now; DOM click through two rendering opportunities after all target text and visible local images are ready',
              timingGate: false,
              limitations: [
                'Synthetic transcript HTTP import and real app/browser/SQLite; no provider calls or private materials.',
                'Resource Timing includes local queue/transport; request-to-first-byte is not isolated server CPU.',
                'Long tasks are main-thread tasks of at least 50ms; zero entries does not mean zero work.',
                'Frame checks inspect target text and add measurement overhead; this is not a compositor paint measurement.',
                'Warm browser and OS caches; no physical mobile device, cold boot, remote network or retained-heap claim.',
              ],
            },
            environment: {
              node: process.version,
              platform: process.platform,
              arch: process.arch,
              browser: await page.evaluate(() => ({
                userAgent: navigator.userAgent,
                hardwareConcurrency: navigator.hardwareConcurrency,
                viewport: [innerWidth, innerHeight],
                devicePixelRatio,
              })),
            },
            content: sizes,
            samples,
            invariants: {
              unchangedSourcesTranslationsRunsAttemptsVariables: true,
              newGenerationRequests: 0,
              nativeHtmlCssLocalImageButtonAndReadingQuotesPreserved: true,
            },
          },
          null,
          2
        ),
      });
    });
  }
