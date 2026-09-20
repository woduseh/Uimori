import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { postFixtureChat } from './fixtures/chat.js';

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'dompurify'] },
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

async function mount(page: Page) {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/reader-navigation.tsx';
    const { mount } = await import(path);
    mount();
  });
  await expect
    .poll(() => page.locator('iframe').evaluate((node) => node.clientHeight))
    .toBeGreaterThan(700);
}
const targetOffset = (page: Page) =>
  page
    .locator('#target')
    .evaluate(
      (node) =>
        node.getBoundingClientRect().top -
        document.getElementById('reader')!.getBoundingClientRect().top
    );
const distanceToEnd = (page: Page) =>
  page
    .locator('#reader')
    .evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
async function settleLayout(page: Page) {
  // ResizeObserver, the navigation RAF, then its scroll event all get a rendering cycle.
  await page.evaluate(async () => {
    for (let index = 0; index < 3; index++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

test('explicit source navigation follows late geometry until wheel reading takes over', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Go to source', exact: true }).click();
  await expect.poll(() => targetOffset(page)).toBe(0);
  await page.locator('#before').evaluate((node) => {
    node.style.height = '960px';
  });
  await expect.poll(() => targetOffset(page)).toBe(0);
  await page.locator('#before').evaluate((node) => {
    node.style.height = '360px';
  });
  await expect.poll(() => targetOffset(page)).toBe(0);
  // Actual wheel input outside the opaque frame cancels even if no further scrolling is possible.
  await page.getByRole('button', { name: 'Go to source', exact: true }).hover();
  await page.mouse.wheel(0, -80);
  const before = await page.locator('#reader').evaluate((node) => node.scrollTop);
  await page.locator('#before').evaluate((node) => {
    node.style.height = '760px';
  });
  await settleLayout(page);
  expect(await page.locator('#reader').evaluate((node) => node.scrollTop)).toBe(before);
  expect(await targetOffset(page)).toBe(400);
});

test('late native frame growth follows end navigation and trusted iframe keys release it', async ({
  page,
}) => {
  await mount(page);
  const native = page.frameLocator('iframe');
  await page.getByRole('button', { name: 'Go to end', exact: true }).click();
  await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
  // An unverified host message cannot release navigation ownership.
  await page.evaluate(() =>
    postMessage({ channel: 'uimori-risu-message-v1', token: 'wrong', kind: 'interaction' }, '*')
  );
  await native.locator('#end').evaluate((node) => {
    node.style.marginTop = '1300px';
  });
  await expect
    .poll(() => page.locator('iframe').evaluate((node) => node.clientHeight))
    .toBeGreaterThan(1300);
  await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
  // Focus without pointer input or parent scrolling, then produce a real iframe key event.
  await native
    .locator('#native-focus-button')
    .evaluate((node) => (node as HTMLElement).focus({ preventScroll: true }));
  await page.keyboard.press('ArrowDown');
  await settleLayout(page);
  const before = await page.locator('#reader').evaluate((node) => node.scrollTop);
  await page.locator('#tail').evaluate((node) => {
    node.style.height = '400px';
  });
  await settleLayout(page);
  expect(await page.locator('#reader').evaluate((node) => node.scrollTop)).toBe(before);
  expect(await distanceToEnd(page)).toBeGreaterThanOrEqual(399);
});

test('a queued resize from a stale navigation epoch cannot move the new reading position', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Go to end', exact: true }).click();
  await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
  // Programmatic click avoids the input-cancellation path: the epoch guard must stand alone.
  await page
    .getByRole('button', { name: 'Change navigation epoch', exact: true })
    .evaluate((node) => (node as HTMLButtonElement).click());
  const before = await page.locator('#reader').evaluate((node) => node.scrollTop);
  await page.locator('#tail').evaluate((node) => {
    node.style.height = '500px';
  });
  await settleLayout(page);
  expect(await page.locator('#reader').evaluate((node) => node.scrollTop)).toBe(before);
  expect(await distanceToEnd(page)).toBeGreaterThanOrEqual(499);
});

test('direct reading scroll wins over a queued geometry update before its scroll event', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Go to end', exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    document.getElementById('reader')!.scrollTop = 80;
  });
  await settleLayout(page);
  expect(await page.locator('#reader').evaluate((node) => node.scrollTop)).toBe(80);
  await page.getByRole('button', { name: 'Go to end', exact: true }).click();
  await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
  await page.locator('#reader').evaluate((node) => {
    document.getElementById('tail')!.style.height = '350px';
    node.scrollTop = 80;
  });
  await settleLayout(page);
  expect(await page.locator('#reader').evaluate((node) => node.scrollTop)).toBe(80);
  await page.locator('#tail').evaluate((node) => {
    node.style.height = '700px';
  });
  await settleLayout(page);
  expect(await page.locator('#reader').evaluate((node) => node.scrollTop)).toBe(80);
});

test('CHATREC03 mobile mini navigator follows source IDs and keeps the opening outside scene counts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/reader-navigation.tsx';
    const { mountMiniNavigator } = await import(path);
    mountMiniNavigator();
  });
  const nav = page.getByRole('navigation', { name: '장면 탐색', exact: true });
  const selected = page.getByLabel('Selected source', { exact: true });
  const previous = nav.getByRole('button', { name: '이전 장면', exact: true });
  const next = nav.getByRole('button', { name: '다음 장면', exact: true });
  const list = nav.getByRole('button', { name: '장면 목록 열기', exact: true });
  await expect(previous).toBeDisabled();
  await expect(list).toHaveText('첫 메시지');
  await next.click();
  await expect(selected).toHaveText('source:nonsequential:a');
  await expect(list).toHaveText('1 / 2');
  await next.click();
  await expect(selected).toHaveText('source:nonsequential:z');
  await expect(list).toHaveText('2 / 2');
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(list).toHaveText('1 / 2');
  const before = await page.locator('.reader-scrollport').evaluate((node) => node.scrollTop);
  await page.getByRole('button', { name: 'Append scene', exact: true }).click();
  await expect(list).toHaveText('1 / 3');
  expect(await page.locator('.reader-scrollport').evaluate((node) => node.scrollTop)).toBe(before);
  await list.click();
  const dialog = page.getByRole('dialog', { name: '장면 목록', exact: true });
  await dialog.getByRole('button', { name: '첫 메시지', exact: true }).click();
  await expect(selected).toHaveText('opening:id');
  await expect(previous).toBeDisabled();
  const reader = await page.locator('.reader-scrollport').boundingBox();
  const bar = await nav.boundingBox();
  expect(bar!.y).toBeGreaterThanOrEqual(reader!.y + reader!.height - 1);
});

// One JS task reproduces A -> B -> A before React can commit a different query.
// The reader must reject the old response by intent, not by comparing URL fields alone.
test('READERNAV a late reader response cannot acknowledge a newer A-B-A navigation', async ({
  page,
  request,
}) => {
  const chat = await (await postFixtureChat(request, { data: { title: 'Navigation A' } })).json();
  const other = await (await postFixtureChat(request, { data: { title: 'Navigation B' } })).json();
  const initial = await (await request.get(`/api/chats/${chat.id}/reader`)).json();
  const staleTitle = 'READERNAV stale response must not be applied';
  let holdNext = false;
  let captured = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    if (!holdNext) return route.continue();
    holdNext = false;
    const response = await route.fetch();
    const body = await response.json();
    body.chat.title = staleTitle;
    captured = true;
    await gate;
    await route.fulfill({ response, json: body });
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.getByRole('textbox', { name: '다음 장면 요청' })).toBeVisible();
    holdNext = true;
    const changed = await request.patch(`/api/chats/${chat.id}/title`, {
      data: {
        title: 'Navigation current title',
        expectedTitleRevision: initial.chat.titleRevision,
      },
    });
    expect(changed.ok()).toBe(true);
    await expect.poll(() => captured).toBe(true);
    await page.evaluate(
      ({ first, second }) => {
        for (const id of [second, first]) {
          history.pushState(null, '', `/?chat=${id}`);
          dispatchEvent(new PopStateEvent('popstate'));
        }
      },
      { first: chat.id, second: other.id }
    );
    release();
    await expect(page.getByText('Navigation current title', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(staleTitle, { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`[?&]chat=${chat.id}(?:&|$)`));
  } finally {
    release();
  }
});
