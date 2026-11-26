import { expect, test, type Page } from '@playwright/test';
import { startFixtureVite, type FixtureVite } from './fixtures/fixture-vite.js';
import { postFixtureChat } from './fixtures/chat.js';

let vite: FixtureVite;
let origin: string;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  vite = await startFixtureVite(
    ['react', 'react-dom/client', 'dompurify'],
    ['/tests/fixtures/reader-navigation.tsx']
  );
  origin = vite.origin;
});
test.afterAll(async () => {
  await vite?.close();
});

async function mount(page: Page) {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/reader-navigation.tsx';
    const { mount } = await import(path);
    mount();
  });
  await expect
    .poll(() => page.locator('.risu-message-surface').evaluate((node) => node.clientHeight))
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

test('late native message growth follows end navigation and composed keys release it', async ({
  page,
}) => {
  await mount(page);
  const native = page.locator('.risu-message-surface');
  await page.getByRole('button', { name: 'Go to end', exact: true }).click();
  await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
  await native.locator('#end').evaluate((node) => {
    node.style.marginTop = '1300px';
  });
  await expect
    .poll(() => page.locator('.risu-message-surface').evaluate((node) => node.clientHeight))
    .toBeGreaterThan(1300);
  await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
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

test('CHATREC03 compact scene list follows source IDs and keeps the opening outside scene counts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/reader-navigation.tsx';
    const { mountMiniNavigator } = await import(path);
    mountMiniNavigator();
  });
  const selected = page.getByLabel('Selected source', { exact: true });
  const list = page.getByRole('button', { name: '장면 목록 열기', exact: true });
  const dialog = page.getByRole('dialog', { name: '장면 목록', exact: true });
  const latest = page.getByRole('button', { name: '본문 맨 아래로', exact: true });
  await expect(page.getByRole('button', { name: '이전 장면', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '다음 장면', exact: true })).toHaveCount(0);
  await expect(list).toHaveText('첫 메시지');
  await list.click();
  await dialog.getByRole('button', { name: '1번째 장면, Scene one', exact: true }).click();
  await expect(selected).toHaveText('source:nonsequential:a');
  await expect(list).toHaveText('1 / 2');
  await expect(latest).toBeVisible();
  const before = await page.locator('.reader-scrollport').evaluate((node) => node.scrollTop);
  await list.click();
  await page.keyboard.press('Escape');
  await expect(list).toBeFocused();
  expect(await page.locator('.reader-scrollport').evaluate((node) => node.scrollTop)).toBe(before);
  await page.getByRole('button', { name: 'Append scene', exact: true }).click();
  await expect(list).toHaveText('1 / 3');
  expect(await page.locator('.reader-scrollport').evaluate((node) => node.scrollTop)).toBe(before);
  await latest.click();
  await expect(list).toHaveText('3 / 3');
  await expect(latest).toBeHidden();
  await list.click();
  await dialog.getByRole('button', { name: 'Opening', exact: true }).click();
  await expect(selected).toHaveText('opening:id');
  await expect(list).toHaveText('첫 메시지');
});

for (const action of ['A-B-A'] as const) {
  test(`READERNAV initial loading recovers after ${action} navigation`, async ({
    page,
    request,
  }) => {
    const chat = await (
      await postFixtureChat(request, { data: { title: `Initial navigation ${action}` } })
    ).json();
    const other = await (
      await postFixtureChat(request, { data: { title: 'Initial navigation other chat' } })
    ).json();
    const staleTitle = 'READERNAV superseded initial response';
    let reads = 0;
    let recovering = false;
    let captured = false;
    let released = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
      reads++;
      if (recovering) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.chat.title = staleTitle;
      captured = true;
      await gate;
      await route.fulfill({ response, json: body });
      released++;
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/?chat=${chat.id}`);
      await expect.poll(() => captured).toBe(true);
      const loading = page.getByRole('status').filter({ hasText: '본문을 불러오는 중이에요…' });
      await expect(loading).toBeVisible();
      const initialReads = reads;
      recovering = true;
      await page.evaluate(
        ({ first, second }) => {
          for (const id of [second, first]) {
            history.pushState(null, '', `/?chat=${id}`);
            dispatchEvent(new PopStateEvent('popstate'));
          }
        },
        { first: chat.id, second: other.id }
      );
      const title = page.locator('.workspace-header').getByText(chat.title, { exact: true });
      await expect(title).toBeVisible();
      await expect.poll(() => reads).toBeGreaterThan(initialReads);
      await expect(loading).toHaveCount(0);
      release();
      await expect.poll(() => released).toBe(initialReads);
      await expect(title).toBeVisible();
      await expect(page.getByText(staleTitle, { exact: true })).toHaveCount(0);
    } finally {
      release();
    }
  });
}
