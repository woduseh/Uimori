import { expect, test } from '@playwright/test';
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
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'markdown-it'] },
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

test('HCODE01 helper copies each complete code block without changing manuscript prose', async ({
  page,
}, info) => {
  await page.goto(origin);
  const blocks = [
    '<section>“한글” & {{value}}</section>\n  들여쓰기\n',
    '{"key":"값", "count":2}\n',
  ];
  const text = `답변 본문\n\n\`\`\`html\n${blocks[0]}\`\`\`\n\n중간 설명\n\n~~~json\n${blocks[1]}~~~`;
  await page.evaluate(async (value) => {
    const path = '/tests/fixtures/helper-message-prose.tsx';
    const fixture = await import(path);
    const controls = fixture.mountHelperProse(document.getElementById('mount'), value);
    Object.assign(window, { helperProseFixture: controls, copiedBlocks: [] });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (copy: string) => {
          (window as unknown as { copiedBlocks: string[] }).copiedBlocks.push(copy);
        },
      },
    });
  }, text);
  const helper = page.getByTestId('helper');
  await expect(helper.locator('pre > code')).toHaveText(blocks);
  await expect(page.getByTestId('manuscript').locator('button')).toHaveCount(0);
  for (let index = 0; index < blocks.length; index++)
    await helper.getByRole('button', { name: `코드 블록 ${index + 1} 복사`, exact: true }).click();
  expect(
    await page.evaluate(() => (window as unknown as { copiedBlocks: string[] }).copiedBlocks)
  ).toEqual(blocks);
  await page.screenshot({ path: info.outputPath('helper-code-copy.png') });
  await page.evaluate(() =>
    (
      window as unknown as { helperProseFixture: { render: (text: string) => void } }
    ).helperProseFixture.render('새 답변\n\n```txt\n새 코드\n```')
  );
  await expect(helper.locator('.helper-code-toolbar')).toHaveCount(1);
  await helper.getByRole('button', { name: '코드 블록 1 복사', exact: true }).click();
  expect(
    await page.evaluate(() => (window as unknown as { copiedBlocks: string[] }).copiedBlocks.at(-1))
  ).toBe('새 코드\n');
});

test('HCODE02 clipboard failure stays visible and the same block can be copied again', async ({
  page,
}) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/helper-message-prose.tsx';
    const fixture = await import(path);
    fixture.mountHelperProse(document.getElementById('mount'), '```txt\n보존할 코드\n```');
    let attempts = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          if (++attempts === 1) throw new Error('Synthetic clipboard denial');
        },
      },
    });
  });
  const helper = page.getByTestId('helper');
  await helper.getByRole('button', { name: '코드 블록 1 복사', exact: true }).click();
  await expect(helper.getByRole('alert')).toBeVisible();
  await expect(helper.locator('pre > code')).toHaveText('보존할 코드\n');
  await helper.getByRole('button', { name: '코드 블록 1 복사', exact: true }).click();
  await expect(helper.getByRole('alert')).toHaveCount(0);
  await expect(helper.getByRole('status')).not.toHaveText('');
});
