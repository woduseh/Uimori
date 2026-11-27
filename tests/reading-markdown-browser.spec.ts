import { expect, test } from './fixtures/browser-test.js';
import { startFixtureVite, type FixtureVite } from './fixtures/fixture-vite.js';

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
