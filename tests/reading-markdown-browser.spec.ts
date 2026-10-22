import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { splitSource } from '../core/auxiliary.js';
import type { Asset } from '../core/product.js';
import type { Job } from '../core/types.js';

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    plugins: [react()],
    optimizeDeps: {
      noDiscovery: true,
      include: ['react', 'react-dom/client', 'dompurify', 'markdown-it'],
    },
    server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/output/**'] } },
  });
  server.middlewares.use(async (request, response, next) => {
    if (request.url !== '/') return next();
    response.setHeader('Content-Type', 'text/html');
    response.end(
      await server.transformIndexHtml(
        '/',
        '<!doctype html><html><body><main id="mount"></main></body></html>'
      )
    );
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => {
  await server?.close();
});

test('shared prose and native compiler-to-surface reading regressions', async ({ page }) => {
  await page.goto(origin);
  const passed = await page.evaluate(async () => {
    const path = '/tests/fixtures/reading-markdown.tsx';
    const fixture = await import(path);
    return fixture.runReadingRegressions(document.getElementById('mount'));
  });
  expect(passed).toHaveLength(4);
});

test('nested tight-list geometry includes the parent text before its child list', async ({
  page,
}) => {
  const text = '- parent\n  - child\n\nAfter';
  const value = {
    id: 'nested-list-source',
    runId: 'run',
    chatId: 'chat',
    parentRevision: null,
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  await page.goto(origin);
  await page.evaluate(
    async (source) => {
      const path = '/tests/fixtures/reading-markdown.tsx';
      const fixture = await import(path);
      await fixture.mountSource(document.getElementById('mount'), source);
    },
    { ...value, blocks: splitSource(value) }
  );
  const geometry = await page.locator('[data-testid="source-text"]').evaluate((source) => {
    const parent = [...source.querySelectorAll('[data-uimori-prose]')].find(
      (element) => element.textContent === 'parent'
    )!;
    const child = [...source.querySelectorAll('[data-uimori-prose]')].find(
      (element) => element.textContent === 'child'
    )!;
    return {
      markerTop: source.querySelector('[data-block-anchor]')!.getBoundingClientRect().top,
      parentTop: parent.getBoundingClientRect().top,
      childTop: child.getBoundingClientRect().top,
    };
  });
  expect(geometry.markerTop).toBeCloseTo(geometry.parentTop, 1);
  expect(geometry.markerTop).toBeLessThan(geometry.childTop);
});

test('mounted SourceReader places approved original and translation images only for the current owner and target', async ({
  page,
}) => {
  // Six isolated mounts include Vite module transforms and asset loading.
  test.setTimeout(90_000);
  const text = 'First.\n\nSecond.';
  const value = {
    id: 'image-source',
    chatId: 'chat',
    runId: 'run',
    parentRevision: null,
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  const source = { ...value, blocks: splitSource(value) };
  const asset: Asset = {
    id: 'asset',
    chatId: 'chat',
    revision: 1,
    hash: 'bytes',
    title: 'Scene',
    description: '',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'inline',
    mime: 'image/png',
    url: '/api/assets/asset',
  };
  const image = {
    id: 'image',
    kind: 'image',
    status: 'completed',
    revision: 1,
    sourceRevision: source.id,
    sourceHash: source.hash,
    imageTarget: { mode: 'original', textHash: source.hash },
    result: {
      sourceRevision: source.id,
      sourceHash: source.hash,
      imageTarget: { mode: 'original', textHash: source.hash },
      annotations: [
        {
          blockAnchor: source.blocks[0].anchor,
          assetRef: asset.id,
          assetRevision: 1,
          assetHash: asset.hash,
          presentationIntent: 'inline',
        },
      ],
    },
  } as Job;
  const translatedSource = {
    ...source,
    text: '합친 번역.',
    hash: createHash('sha256').update('합친 번역.').digest('hex'),
  };
  const translation = {
    id: 'translation',
    kind: 'translation',
    status: 'completed',
    revision: 1,
    sourceRevision: source.id,
    sourceHash: source.hash,
    result: { sourceRevision: source.id, sourceHash: source.hash, text: translatedSource.text },
  } as Job;
  const translatedTarget = {
    mode: 'translation' as const,
    textHash: translatedSource.hash,
    translationJobId: translation.id,
    translationRevision: 1,
  };
  const translationImage = {
    ...image,
    id: 'translated-image',
    imageTarget: translatedTarget,
    result: {
      ...image.result!,
      imageTarget: translatedTarget,
      annotations: [
        { ...image.result!.annotations![0], blockAnchor: splitSource(translatedSource)[0].anchor },
      ],
    },
  } as Job;
  await page.route('**/api/assets/asset', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9n8AAAAASUVORK5CYII=',
        'base64'
      ),
    })
  );
  await page.route(`**/api/chats/${source.chatId}/sources/${source.id}/presentation?*`, (route) =>
    route.fulfill({
      json: {
        sourceRevision: source.id,
        sourceHash: source.hash,
        format: 'risu-html',
        original: {
          text: source.text,
          html: '<p>Retained native original.</p>',
          changed: false,
          applied: [],
        },
        translationId: null,
        translationRevision: null,
        issues: [],
      },
    })
  );
  const cases = [
    { imageOwner: true, jobs: [image], expected: 1 },
    { imageOwner: false, jobs: [image], expected: 0 },
    {
      imageOwner: true,
      jobs: [
        image,
        { ...image, id: 'new-image', revision: 2, status: 'queued', result: null } as Job,
      ],
      expected: 0,
    },
    { imageOwner: true, jobs: [image, translation], expected: 0 },
    {
      imageOwner: true,
      jobs: [
        image,
        {
          ...translation,
          translationLayout: {
            textHash: translatedSource.hash,
            blocks: splitSource(translatedSource),
          },
        },
        translationImage,
      ],
      expected: 1,
    },
    {
      imageOwner: true,
      hasPackages: true,
      jobs: [
        image,
        {
          ...translation,
          translationLayout: {
            textHash: translatedSource.hash,
            blocks: splitSource(translatedSource),
          },
        },
        translationImage,
      ],
      expected: 1,
    },
  ];
  for (const scenario of cases) {
    await page.goto(origin);
    await page.evaluate(
      async ({ source, asset, scenario }) => {
        sessionStorage.clear();
        const path = '/tests/fixtures/reading-markdown.tsx';
        const fixture = await import(path);
        await fixture.mountSource(document.getElementById('mount'), source, {
          imageOwner: scenario.imageOwner,
          hasPackages: scenario.hasPackages,
          jobs: scenario.jobs,
          assets: [asset],
        });
      },
      { source, asset, scenario }
    );
    const images = page.locator('.inline-asset img[src="/api/assets/asset"]');
    await expect(images).toHaveCount(scenario.expected);
    if (scenario.expected)
      await expect
        .poll(() =>
          images.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
        )
        .toBe(true);
    if (scenario.jobs.some((job) => job.kind === 'translation'))
      await expect(page.locator('[data-testid="translation-text"]')).toContainText('합친 번역.');
  }
});

test('whole SourceReader keeps monotone canonical geometry through loose lists, code, width and reading changes', async ({
  page,
}) => {
  const text =
    '- 첫 항목 “함께 읽자.” '.repeat(8) +
    '\n\n- 둘째 항목 ‘오래 기다렸다.’ '.repeat(12) +
    '\n\n```text\nfirst\n```notclose\n\ninside\n```\n\n[참고][story]\n\n[story]: https://example.com/story\n\n' +
    '마지막 서술. '.repeat(100);
  const value = {
    id: 'geometry-source',
    runId: 'run',
    chatId: 'chat',
    parentRevision: null,
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  const source = { ...value, blocks: splitSource(value) };
  await page.goto(origin);
  await page.evaluate(async (source) => {
    const path = '/tests/fixtures/reading-markdown.tsx';
    const fixture = await import(path);
    (window as any).readingFixture = await fixture.mountSource(
      document.getElementById('mount'),
      source
    );
  }, source);
  await expect(page.locator('[data-testid="source-text"] ul')).toHaveCount(1);
  await expect(page.locator('[data-testid="source-text"] pre')).toHaveCount(1);
  await expect(page.locator('[data-testid="source-text"] a')).toHaveAttribute(
    'href',
    'https://example.com/story'
  );
  for (const width of [360, 900]) {
    await page.locator('#reader').evaluate((reader, width) => {
      reader.style.width = `${width}px`;
    }, width);
    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    });
    const boxes = await page.locator('[data-block-anchor]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        anchor: (node as HTMLElement).dataset.blockAnchor,
        top: node.getBoundingClientRect().top,
        bottom: node.getBoundingClientRect().bottom,
      }))
    );
    expect(boxes.map((box) => box.anchor)).toEqual(source.blocks.map((block) => block.anchor));
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].bottom).toBeGreaterThan(boxes[i].top);
      if (i) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom - 1);
    }
    const second = page.locator('[data-block-anchor]').nth(1);
    await second.evaluate((marker) => {
      const reader = document.getElementById('reader')!;
      const rect = marker.getBoundingClientRect();
      reader.scrollTop += rect.top - reader.getBoundingClientRect().top + rect.height * 0.3 - 12;
    });
    const captured = await page.evaluate(() => (window as any).readingFixture.capture());
    expect(captured.blockAnchor).toBe(source.blocks[1].anchor);
    expect(captured.offsetRatio).toBeCloseTo(0.3, 1);
  }
  await page.evaluate(() => (window as any).readingFixture.setReading());
  await expect(page.locator('.reading-quote').first()).toBeAttached();
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
  });
  expect(
    await page
      .locator('[data-block-anchor]')
      .nth(1)
      .evaluate((node) => node.getBoundingClientRect().height)
  ).toBeGreaterThan(1);
});
