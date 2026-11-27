import { expect, test, type Page } from '@playwright/test';
import { startFixtureVite, type FixtureVite } from './fixtures/fixture-vite.js';

let vite: FixtureVite;
let origin: string;
test.beforeAll(async () => {
  vite = await startFixtureVite(['react', 'react-dom/client']);
  origin = vite.origin;
});
test.afterAll(async () => {
  await vite?.close();
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

async function capture(page: Page, sourceId?: string) {
  return page.evaluate(async (sourceId) => {
    const path = '/tests/fixtures/theme-body-scroll.tsx';
    const fixture = await import(path);
    return fixture.capture(sourceId);
  }, sourceId);
}

const scrollTop = (page: Page, selector: string) =>
  page.locator(selector).evaluate((node) => node.scrollTop);

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
