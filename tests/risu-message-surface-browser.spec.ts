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
  test(`RSURFACE ${width}px authored forms submit safely with native keyboard behavior`, async ({
    page,
  }) => {
    const externalRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://example.invalid/'))
        externalRequests.push(request.url());
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await page.evaluate(async () => {
      const path = '/tests/fixtures/risu-form-surface.ts';
      const { mount } = await import(path);
      mount();
    });
    const native = page.locator('.risu-message-surface');
    const name = native.locator('input[name="name"]');
    const submit = native.locator('button[type="submit"][name="submit"]');
    const file = native.locator('input[type="file"][name="attachment"]');
    const calls = () =>
      page
        .locator('#calls')
        .textContent()
        .then((value) => JSON.parse(value!));
    const initialUrl = page.url();

    await name.press('Enter');
    expect(await calls()).toEqual([]);
    await name.fill('재연');
    await page.locator('#preview').click();
    await name.press('Enter');
    expect(await calls()).toEqual([]);
    await page.locator('#preview').click();
    await name.press('Enter');
    await expect.poll(calls).toEqual([
      {
        kind: 'form',
        name: '설문',
        data: JSON.parse(
          '{"name":"재연","tags":["독서","산책"],"__proto__":"안전","submit":"확인"}'
        ),
      },
    ]);
    await name.press('Enter');
    expect(await calls()).toHaveLength(1);
    expect(page.url()).toBe(initialUrl);
    expect(
      await native
        .locator('form')
        .first()
        .evaluate((form) => Element.prototype.hasAttribute.call(form, 'action'))
    ).toBe(false);
    await expect(submit).not.toHaveAttribute('formaction');
    await expect(native.locator('script,iframe')).toHaveCount(0);

    await page.locator('#revision').click();
    await file.setInputFiles({
      name: '선택.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('file is never uploaded'),
    });
    await submit.click();
    await expect(page.locator('#state')).toContainText('파일을 보낼 수 없어요');
    expect(await calls()).toHaveLength(1);
    await file.setInputFiles([]);
    await submit.click();
    await expect.poll(async () => (await calls()).length).toBe(2);
    await expect(page.locator('#state')).toBeEmpty();

    await page.locator('#revision').click();
    await page.locator('#fail').click();
    await submit.click();
    await expect(page.locator('#state')).toContainText('다시 시도');
    await submit.click();
    await expect.poll(async () => (await calls()).length).toBe(4);

    await page.locator('#revision').click();
    await native.locator('[risu-trigger="choose"]').click();
    await expect
      .poll(async () => (await calls()).at(-1))
      .toEqual({
        kind: 'trigger',
        name: 'choose',
        triggerId: '선택-하나',
      });
    expect(await calls()).toHaveLength(5);
    await page.locator('#revision').click();
    await native.locator('[risu-btn="press"]').click();
    await expect
      .poll(async () => (await calls()).at(-1))
      .toEqual({ kind: 'button', name: 'press' });
    expect(await calls()).toHaveLength(6);
    await page.locator('#revision').click();
    await native.locator('[risu-trigger="choose-empty"]').click();
    await expect
      .poll(async () => (await calls()).at(-1))
      .toEqual({ kind: 'trigger', name: 'choose-empty' });
    expect(await calls()).toHaveLength(7);
    await native.locator('form:not([risu-form]) button').click();
    expect(await calls()).toHaveLength(7);
    await page.locator('#revision').click();
    // Playwright's actionability checks call form.getAttribute directly, so add
    // this deliberately clobbering field after the real keyboard/click steps.
    await native.locator('form[risu-form]').evaluate((form) => {
      const field = Element.prototype.querySelector.call(form, '[data-test-clobber]')!;
      const submitter = Element.prototype.querySelector.call(
        form,
        'button[type="submit"][name="submit"]'
      )! as HTMLButtonElement;
      Element.prototype.setAttribute.call(field, 'name', 'getAttribute');
      HTMLFormElement.prototype.requestSubmit.call(form as HTMLFormElement, submitter);
    });
    await expect
      .poll(async () => (await calls()).at(-1))
      .toEqual({
        kind: 'form',
        name: '설문',
        data: JSON.parse(
          '{"name":"재연","tags":["독서","산책"],"__proto__":"안전","getAttribute":"함수 이름도 입력값","submit":"확인"}'
        ),
      });
    expect(await calls()).toHaveLength(8);
    expect(page.url()).toBe(initialUrl);
    expect(externalRequests).toEqual([]);
  });
}

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
    expect(passed).toHaveLength(14);
    expect(errors).toEqual([]);
    await info.attach('surface-scenarios', {
      body: JSON.stringify({ width, passed, errors }, null, 2),
      contentType: 'application/json',
    });
  });
}

for (const width of [390, 1440]) {
  test(`RSURFACE CLEANUP ${width}px modern selection stays in the owning reader`, async ({
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
    expect(passed).toHaveLength(1);
    expect(errors).toEqual([]);
    await info.attach('cleanup-scenarios', {
      body: JSON.stringify({ width, passed, errors }, null, 2),
      contentType: 'application/json',
    });
  });
}
