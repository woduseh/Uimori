import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client'] },
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

async function mount(page: Page, nested = true) {
  await page.goto(origin);
  await page.evaluate(async (nested) => {
    const path = '/tests/fixtures/theme-body-scroll.tsx';
    const fixture = await import(path);
    fixture.mount(nested);
  }, nested);
  await expect(page.locator('#last-block-11')).toBeAttached();
}

async function navigateSource(page: Page, anchor?: string, ratio = 0) {
  await page.evaluate(
    async ({ anchor, ratio }) => {
      const path = '/tests/fixtures/theme-body-scroll.tsx';
      const fixture = await import(path);
      fixture.navigateSource(anchor, ratio);
    },
    { anchor, ratio }
  );
}

async function navigateEnd(page: Page) {
  await page.evaluate(async () => {
    const path = '/tests/fixtures/theme-body-scroll.tsx';
    const fixture = await import(path);
    fixture.navigateEnd();
  });
}

async function capture(page: Page, sourceId?: string) {
  return page.evaluate(async (sourceId) => {
    const path = '/tests/fixtures/theme-body-scroll.tsx';
    const fixture = await import(path);
    return fixture.capture(sourceId);
  }, sourceId);
}

const scrollTop = (page: Page, selector: string) =>
  page.locator(selector).evaluate((node) => node.scrollTop);

const distanceToEnd = (page: Page, selector: string) =>
  page.locator(selector).evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);

test('narrative body anchor navigation moves outer and slotted inner scrollports', async ({
  page,
}) => {
  await mount(page);
  await navigateSource(page, 'target-block-7');
  await expect.poll(() => scrollTop(page, '#reader')).toBeGreaterThan(0);
  await expect.poll(() => scrollTop(page, '#target-body')).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.locator('#target-block-7').evaluate((node) => {
        const block = node.getBoundingClientRect();
        const body = document.getElementById('target-body')!.getBoundingClientRect();
        const reader = document.getElementById('reader')!.getBoundingClientRect();
        return (
          block.top >= Math.max(body.top, reader.top) - 1 &&
          block.bottom <= Math.min(body.bottom, reader.bottom) + 1
        );
      })
    )
    .toBe(true);
  expect(await scrollTop(page, '#previous-body')).toBe(0);
  expect(await scrollTop(page, '#last-body')).toBe(0);
});

test('reading capture uses the visible inner anchor instead of clipped earlier paragraphs', async ({
  page,
}) => {
  await mount(page);
  await page.locator('#reader').evaluate((node) => {
    node.scrollTop =
      document.getElementById('target')!.getBoundingClientRect().top -
      node.getBoundingClientRect().top;
    document.getElementById('target-body')!.scrollTop = 320;
  });
  // The earlier block still has geometry inside the reader but is clipped by the body.
  const clipped = await page.locator('#target-block-2').evaluate((node) => ({
    blockBottom: node.getBoundingClientRect().bottom,
    readerTop: document.getElementById('reader')!.getBoundingClientRect().top,
    bodyTop: document.getElementById('target-body')!.getBoundingClientRect().top,
  }));
  expect(clipped.blockBottom).toBeGreaterThan(clipped.readerTop + 12);
  expect(clipped.blockBottom).toBeLessThan(clipped.bodyTop);
  for (const sourceId of [undefined, 'target']) {
    const location = await capture(page, sourceId);
    expect(location).toMatchObject({
      chatId: 'fixture-chat',
      sourceId: 'target',
      representation: 'original',
      contentHash: 'hash-target',
      blockAnchor: 'target-block-4',
    });
    expect(location.offsetRatio).toBeGreaterThanOrEqual(0);
    expect(location.offsetRatio).toBeLessThan(1);
  }
  // Explicit action/edit capture must retain this scene's passage even when only its footer is visible.
  await page.locator('#reader').evaluate((reader) => {
    reader.scrollTop +=
      document.getElementById('target-action')!.getBoundingClientRect().top -
      reader.getBoundingClientRect().top;
  });
  expect(
    await page
      .locator('#target-body')
      .evaluate(
        (node) =>
          node.getBoundingClientRect().bottom <=
          document.getElementById('reader')!.getBoundingClientRect().top
      )
  ).toBe(true);
  expect(await capture(page, 'target')).toMatchObject({
    sourceId: 'target',
    blockAnchor: 'target-block-4',
  });
});

test('explicit reader end navigation reaches the last narrative body end', async ({ page }) => {
  await mount(page);
  await navigateEnd(page);
  await expect.poll(() => distanceToEnd(page, '#reader')).toBeLessThanOrEqual(1);
  await expect.poll(() => distanceToEnd(page, '#last-body')).toBeLessThanOrEqual(1);
  expect(await scrollTop(page, '#previous-body')).toBe(0);
  expect(await scrollTop(page, '#target-body')).toBe(0);
});

test('default reader keeps ordinary source anchor, capture and end navigation', async ({
  page,
}) => {
  await mount(page, false);
  await navigateSource(page, 'target-block-7', 0.25);
  await expect
    .poll(() =>
      page.locator('#target-block-7').evaluate((node) => {
        const block = node.getBoundingClientRect();
        const reader = document.getElementById('reader')!.getBoundingClientRect();
        return Math.abs(block.top + block.height * 0.25 - reader.top);
      })
    )
    .toBeLessThanOrEqual(1);
  expect(await scrollTop(page, '#target-body')).toBe(0);
  expect(await capture(page)).toMatchObject({
    sourceId: 'target',
    blockAnchor: 'target-block-7',
    offsetRatio: 0.4,
  });
  await navigateEnd(page);
  await expect.poll(() => distanceToEnd(page, '#reader')).toBeLessThanOrEqual(1);
  expect(await scrollTop(page, '#last-body')).toBe(0);
});

async function settleLayout(page: Page) {
  // ResizeObserver, queued navigation and captured scroll events each get a rendering cycle.
  await page.evaluate(async () => {
    for (let index = 0; index < 3; index++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

const bodyAnchorOffset = (page: Page, anchor: string) =>
  page
    .locator(`#${anchor}`)
    .evaluate(
      (node) =>
        node.getBoundingClientRect().top -
        document.getElementById('target-body')!.getBoundingClientRect().top
    );

test('local nested anchor restore preserves outerTop and the inner anchor offset', async ({
  page,
}) => {
  await mount(page);
  const saved = await page.locator('#reader').evaluate((reader) => {
    const source = document.getElementById('target')!;
    const body = document.getElementById('target-body')!;
    reader.scrollTop = source.getBoundingClientRect().top - reader.getBoundingClientRect().top + 80;
    body.scrollTop = 340;
    return {
      outerTop: reader.scrollTop,
      bodyTop: body.scrollTop,
      offset:
        document.getElementById('target-block-4')!.getBoundingClientRect().top -
        body.getBoundingClientRect().top,
    };
  });
  await page.evaluate(async ({ outerTop, offset }) => {
    document.getElementById('reader')!.scrollTop = 0;
    document.getElementById('target-body')!.scrollTop = 0;
    const path = '/tests/fixtures/theme-body-scroll.tsx';
    const fixture = await import(path);
    fixture.restoreAnchor('target-block-4', outerTop, offset);
  }, saved);
  await expect.poll(() => scrollTop(page, '#reader')).toBe(saved.outerTop);
  await expect.poll(() => scrollTop(page, '#target-body')).toBe(saved.bodyTop);
  expect(await bodyAnchorOffset(page, 'target-block-4')).toBe(saved.offset);

  await page.locator('#target-block-0').evaluate((node) => {
    node.style.height = '160px';
  });
  await expect.poll(() => scrollTop(page, '#target-body')).toBe(saved.bodyTop + 80);
  expect(await scrollTop(page, '#reader')).toBe(saved.outerTop);
  expect(await bodyAnchorOffset(page, 'target-block-4')).toBe(saved.offset);
});

test('action restoration retains bodyTop after late growth and yields to direct inner scrolling', async ({
  page,
}) => {
  await mount(page);
  // The editor can return before the full passage has regained its projected height.
  await page.locator('#target-body > p').evaluateAll((nodes) => {
    for (const node of nodes) (node as HTMLElement).style.height = '20px';
  });
  await page.evaluate(async () => {
    const path = '/tests/fixtures/theme-body-scroll.tsx';
    const fixture = await import(path);
    fixture.restoreAction(430, 200);
  });
  await settleLayout(page);
  expect(await scrollTop(page, '#target-body')).toBeLessThan(430);
  expect(await distanceToEnd(page, '#target-body')).toBeLessThanOrEqual(1);
  await page.locator('#target-body > p').evaluateAll((nodes) => {
    for (const node of nodes) (node as HTMLElement).style.height = '80px';
  });
  await expect.poll(() => scrollTop(page, '#target-body')).toBe(430);
  const restoredOuter = await scrollTop(page, '#reader');
  const actionOffset = await page
    .locator('#target-action')
    .evaluate(
      (node) =>
        node.getBoundingClientRect().top -
        document.getElementById('reader')!.getBoundingClientRect().top
    );
  expect(actionOffset).toBe(200);

  // Change the geometry and direct reading position in one task, before its scroll event fires.
  await page.locator('#target-body').evaluate((node) => {
    document.getElementById('target-block-0')!.style.height = '160px';
    node.scrollTop = 160;
  });
  await settleLayout(page);
  expect(await scrollTop(page, '#target-body')).toBe(160);
  expect(await scrollTop(page, '#reader')).toBe(restoredOuter);
  await page.locator('#target-block-0').evaluate((node) => {
    node.style.height = '240px';
  });
  await settleLayout(page);
  expect(await scrollTop(page, '#target-body')).toBe(160);
});
