import { expect, test } from '@playwright/test';
import { startFixtureVite, type FixtureVite } from './fixtures/fixture-vite.js';
import { createHash } from 'node:crypto';
import { splitSource } from '../core/auxiliary.js';

let vite: FixtureVite;
let origin: string;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  vite = await startFixtureVite(
    ['react', 'react-dom/client', 'dompurify', 'markdown-it', '@a2ui/react', '@a2ui/web_core'],
    ['/tests/fixtures/reading-markdown.tsx']
  );
  origin = vite.origin;
});
test.afterAll(async () => {
  await vite?.close();
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
