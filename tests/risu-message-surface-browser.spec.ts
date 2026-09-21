import { test, expect } from '@playwright/test';
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
    optimizeDeps: {
      noDiscovery: true,
      include: ['react', 'react-dom', 'react-dom/client', 'dompurify'],
    },
    server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/output/**'] } },
  });
  server.middlewares.use(async (request, response, next) => {
    if (request.url !== '/') return next();
    response.setHeader('Content-Type', 'text/html');
    response.end(
      await server.transformIndexHtml(
        '/',
        '<!doctype html><html><head><meta charset="utf-8"></head><body><main id="mount"></main></body></html>'
      )
    );
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => {
  await server?.close();
});

for (const width of [390, 1440]) {
  test(`RSURFACE ${width}px reading, author widgets, selection and action lifecycle`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    const passed = await page.evaluate(async () => {
      const path = '/tests/fixtures/risu-surface-regression.ts';
      const { runSurfaceRegressions } = await import(path);
      return runSurfaceRegressions(document.getElementById('mount')!);
    });
    expect(passed).toHaveLength(13);
    expect(errors).toEqual([]);
    await info.attach('surface-scenarios', {
      body: JSON.stringify({ width, passed, errors }, null, 2),
      contentType: 'application/json',
    });
  });
}

for (const width of [390, 1440]) {
  test(`RSURFACE CLEANUP ${width}px modern selection and selective fixed layout`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    const passed = await page.evaluate(async () => {
      const path = '/tests/fixtures/risu-surface-cleanup-regression.ts';
      const { runSurfaceCleanupRegressions } = await import(path);
      return runSurfaceCleanupRegressions(document.getElementById('mount')!);
    });
    expect(passed).toHaveLength(10);
    expect(errors).toEqual([]);
    await info.attach('cleanup-scenarios', {
      body: JSON.stringify({ width, passed, errors }, null, 2),
      contentType: 'application/json',
    });
  });
}

test('RSURFACE CLEANUP responsive fixed layout follows real viewport changes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/risu-surface-cleanup-regression.ts';
    const { mountResponsiveLayoutRegression } = await import(path);
    mountResponsiveLayoutRegression(document.getElementById('mount')!);
  });
  const floor = () =>
    page.locator('.risu-message-surface').evaluate((host) => host.style.minHeight);
  await expect.poll(floor).toBe('');
  await page.setViewportSize({ width: 390, height: 900 });
  await expect.poll(floor).toBe('115px');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(floor).toBe('');
  expect(errors).toEqual([]);
});
