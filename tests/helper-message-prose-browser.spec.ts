import { expect, test } from '@playwright/test';
import { startFixtureVite, type FixtureVite } from './fixtures/fixture-vite.js';

let vite: FixtureVite;
let origin: string;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  vite = await startFixtureVite(
    ['react', 'react-dom/client', 'markdown-it'],
    ['/tests/fixtures/helper-message-prose.tsx']
  );
  origin = vite.origin;
});
test.afterAll(async () => {
  await vite?.close();
});

test('HCODE01 helper copies each complete code block without changing manuscript prose', async ({
  page,
}) => {
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
