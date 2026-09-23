import http from 'node:http';
import { existsSync } from 'node:fs';
import { browserPath } from './browser-path.mjs';

/** Exercise the configured executable, its shared libraries and basic text layout.
 * The synthetic page is not proof of complete font coverage or application rendering.
 */
export async function assertBrowserRuntime({
  executablePath = browserPath(),
  url,
  screenshot,
  viewport = { width: 390, height: 844 },
  launch,
} = {}) {
  let server, browser;
  let failure, result;
  try {
    if (!executablePath || !existsSync(executablePath))
      throw new Error('Local test browser unavailable: Browser executable missing');
    if (!url) {
      server = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><body><h1>로컬 실행 확인</h1></body></html>');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      url = `http://127.0.0.1:${server.address().port}`;
    }
    launch ??= (options) =>
      import('@playwright/test').then(({ chromium }) => chromium.launch(options));
    browser = await launch({
      executablePath,
      headless: true,
      args: ['--no-proxy-server'],
      timeout: 10_000,
    });
    const page = await browser.newPage({ viewport });
    await page.goto(url, { timeout: 10_000 });
    const heading = page.locator('h1');
    if ((await heading.innerText({ timeout: 5000 })) !== '로컬 실행 확인')
      throw new Error('Browser localhost page mismatch');
    const bounds = await heading.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const { width, height } = range.getBoundingClientRect();
      return { width, height };
    });
    if (!(bounds.width > 0 && bounds.height > 0))
      throw new Error('Browser text has no layout; check fonts/fontconfig');
    if (screenshot) await page.screenshot({ path: screenshot, timeout: 5000 });
    result = {
      name: 'chromium',
      version: browser.version(),
      executablePath,
      viewport,
      textLayout: bounds,
    };
  } catch (error) {
    failure = Object.assign(
      new Error(
        `Browser runtime unavailable. Check browser dependencies/fonts and UIMORI_BROWSER_PATH. ${error.message}`,
        { cause: error }
      ),
      { code: 'BROWSER_RUNTIME_UNAVAILABLE' }
    );
  } finally {
    const cleanupErrors = [];
    try {
      await browser?.close();
    } catch (error) {
      cleanupErrors.push(error.message);
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (cleanupErrors.length) {
      if (failure) failure.message += `; cleanup: ${cleanupErrors.join('; ')}`;
      else failure = new Error(`Browser probe cleanup failed: ${cleanupErrors.join('; ')}`);
    }
  }
  if (failure) throw failure;
  return result;
}
