import { expect, test, type Page } from './fixtures/browser-test.js';
import type { ChatDetail } from '../core/types.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

test('I18N07 a restarted service worker reads persisted UI locale for a synthetic push', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications']);
  await page.goto('/');
  await switchFromAnotherTab(page, 'en');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        if (!(await indexedDB.databases()).some((entry) => entry.name === 'uimori-presentation'))
          return null;
        return new Promise((resolve, reject) => {
          const open = indexedDB.open('uimori-presentation', 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const transaction = db.transaction('settings', 'readonly');
            const request = transaction.objectStore('settings').get('ui-language');
            transaction.oncomplete = () => {
              db.close();
              resolve(request.result);
            };
            transaction.onerror = () => {
              db.close();
              reject(transaction.error);
            };
          };
        });
      })
    )
    .toBe('en');
  const protocol = await context.newCDPSession(page);
  let registrationId = '';
  protocol.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    registrationId =
      registrations.find((entry) => entry.scopeURL === new URL('/', page.url()).href)
        ?.registrationId ?? registrationId;
  });
  const displayed: { title?: string; body?: string }[] = [];
  protocol.on('BackgroundService.backgroundServiceEventReceived', ({ backgroundServiceEvent }) => {
    if (
      backgroundServiceEvent.eventName !== 'Notification displayed' ||
      backgroundServiceEvent.instanceId !== 'i18n-restarted-worker'
    )
      return;
    const field = (key: string) =>
      backgroundServiceEvent.eventMetadata.find((entry) => entry.key === key)?.value;
    displayed.push({ title: field('Title'), body: field('Body') });
  });
  try {
    await protocol.send('BackgroundService.setRecording', {
      shouldRecord: true,
      service: 'notifications',
    });
    await protocol.send('BackgroundService.startObserving', { service: 'notifications' });
    await protocol.send('ServiceWorker.enable');
    await expect.poll(() => registrationId).not.toBe('');
    await protocol.send('ServiceWorker.stopAllWorkers');
    await protocol.send('ServiceWorker.deliverPushMessage', {
      origin: new URL(page.url()).origin,
      registrationId,
      data: JSON.stringify({ version: 1, kind: 'test', tag: 'i18n-restarted-worker' }),
    });
    await expect
      .poll(() => displayed)
      .toEqual([
        {
          title: 'Uimori · Test notification',
          body: 'This is a test notification for this device.',
        },
      ]);
  } finally {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      for (const notification of await registration.getNotifications()) notification.close();
    });
    await protocol.detach();
  }
});

async function switchFromAnotherTab(page: Page, locale: string) {
  await page.evaluate((value) => {
    localStorage.setItem('uimori:ui-language', value);
    dispatchEvent(new StorageEvent('storage', { key: 'uimori:ui-language', newValue: value }));
  }, locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

test('I18N09 duplicating built-in layouts and palettes copies the shown language, not Korean', async ({
  page,
}) => {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '테마와 색상');
  const advanced = page.locator('.theme-advanced:not([open]) > summary');
  if (await advanced.isVisible()) await advanced.click();
  await switchFromAnotherTab(page, 'en');
  const layout = page
    .locator('.theme-card')
    .filter({ has: page.getByRole('button', { name: 'Apply Cinematic theme', exact: true }) });
  await layout.getByRole('button', { name: 'Duplicate and customize', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Custom theme editor', exact: true });
  await expect(editor.getByLabel('Theme name', { exact: true })).toHaveValue('Cinematic copy');
  await expect(editor.getByLabel('Theme description', { exact: true })).toHaveValue(
    /^A scene for long stories/u
  );
  await editor.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes and close', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByLabel('Manage Forest', { exact: true }).click();
  await page.getByRole('button', { name: 'Clone Forest', exact: true }).click();
  const palette = page.locator('.palette-editor');
  await expect(palette.getByLabel('Name', { exact: true })).toHaveValue('Forest copy');
  await expect(palette.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(
    'The familiar calm green of Uimori'
  );
});

test('I18N08 source and saved translation editors preserve unsaved text, selection and DOM identity', async ({
  page,
  request,
}) => {
  const { chat, detail } = await createReadingChat(request, '실제 원고 편집 언어 전환 fixture', 1);
  await page.addInitScript(() => localStorage.setItem('uimori:reading-language', 'original'));
  await page.goto(`/?chat=${chat.id}`);
  const scene = page.getByTestId('source');
  await expect(scene).toBeVisible();
  for (const kind of ['원문', '번역']) {
    if (kind === '번역')
      await scene.getByRole('button', { name: '번역 보기', exact: true }).click();
    await scene.getByRole('button', { name: `${kind} 수정`, exact: true }).click();
    const editor = scene.locator('.source-text-editor textarea');
    const text = `${kind}의 저장하지 않은 편집 / keep 日本語 中文`;
    await editor.fill(text);
    await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 8));
    const handle = await editor.elementHandle();
    for (const locale of ['en', 'ja', 'zh', 'ko']) {
      await switchFromAnotherTab(page, locale);
      await expect(editor).toHaveValue(text);
      await expect(editor).toHaveAccessibleName(/.+/u);
      expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
      expect(
        await editor.evaluate((element: HTMLTextAreaElement) => [
          element.selectionStart,
          element.selectionEnd,
        ])
      ).toEqual([3, 8]);
    }
    await scene.getByRole('button', { name: '편집 취소', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: '편집 취소', exact: true })
      .getByRole('button', { name: '초안 버리고 닫기', exact: true })
      .click();
  }
  const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.sources).toEqual(detail.sources);
  expect(after.jobs).toEqual(detail.jobs);
});

test('I18N01 explicit language selection persists across reentry with accessible localized names', async ({
  page,
}) => {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '일반');
  const selector = page.locator('.ui-language-setting select');
  await expect(selector).toHaveAccessibleName('화면 언어');
  for (const [locale, name] of [
    ['en', 'Interface language'],
    ['ja', '表示言語'],
    ['zh', '界面语言'],
    ['ko', '화면 언어'],
  ]) {
    await selector.selectOption(locale);
    await expect(selector).toHaveAccessibleName(name);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    expect(await page.evaluate(() => localStorage.getItem('uimori:ui-language'))).toBe(locale);
  }
  await selector.selectOption('ja');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
});
