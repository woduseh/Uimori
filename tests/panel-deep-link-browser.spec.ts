import { expect, test, type APIRequestContext } from '@playwright/test';
import { fixtureBotInput } from './fixtures/chat.js';
import { measureScreen } from './fixtures/ui-metrics.js';

// Test-mode deep links let captures and specs open a screen without its click path.
async function seedChat(request: APIRequestContext, stamp: string) {
  const bot = await request.post('/api/content', { data: fixtureBotInput(`${stamp} bot`) });
  expect(bot.ok(), await bot.text()).toBe(true);
  const chat = await request.post('/api/chats', {
    data: { botId: ((await bot.json()) as { id: string }).id, title: `${stamp} chat` },
  });
  expect(chat.ok(), await chat.text()).toBe(true);
  return chat.json() as Promise<{ id: string }>;
}
const params = (page: { url(): string }) => new URL(page.url()).searchParams;

test('DLUI01 ?panel=settings&section=connections opens that settings section and leaves the address clean', async ({
  page,
}) => {
  await page.goto('/?panel=settings&section=connections');
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('connection-settings')).toBeVisible();
  await expect.poll(() => params(page).has('panel')).toBe(false);
  expect(params(page).has('section')).toBe(false);
});

test('DLUI02 ?chat=…&panel=story&section=models waits for the chat and opens its model section', async ({
  page,
  request,
}) => {
  const chat = await seedChat(request, `DLUI02 ${Date.now()}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?chat=${chat.id}&panel=story&section=models`);
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator('.section-navigation').getByRole('tab', { name: '모델', exact: true })
  ).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => params(page).has('panel')).toBe(false);
  expect(params(page).get('chat')).toBe(chat.id);
});

test('DLUI03 ?destination=library&tab=persona shows the library on that tab and the screen measures clean', async ({
  page,
}) => {
  await page.goto('/?destination=library&tab=persona');
  const library = page.getByTestId('library-panel');
  await expect(library).toBeVisible();
  await expect(library.getByRole('tab', { name: '페르소나', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect.poll(() => params(page).has('destination')).toBe(false);
  const [overflow] = await measureScreen(page, ['overflow']);
  expect(overflow).toMatchObject({ metric: 'overflow', pass: true });
});
