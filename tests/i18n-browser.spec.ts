import { expect, test, type Page } from '@playwright/test';
import type { ChatDetail } from '../core/types.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import {
  navigationAction,
  openChatSettings,
  selectChatSettingsSection,
  selectSettingsSection,
} from './ui-navigation.js';

test('I18N11 failed illustration-reference saves keep their error identity across language changes', async ({
  page,
  request,
}, info) => {
  const { chat } = await createReadingChat(request, '삽화 참조 저장 오류 언어 전환 fixture', 1);
  let writes = 0;
  await page.route(`**/api/chats/${chat.id}/illustration-references`, async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          revision: 1,
          references: [],
          candidates: [
            {
              ref: 'fixture-reference',
              title: '원본 이름 / reference 日本語 中文',
              url: '/icons/app-192.png',
              mime: 'image/png',
              role: null,
            },
          ],
        },
      });
    writes++;
    return route.fulfill({ status: 503, json: { error: 'Synthetic save failure' } });
  });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source')).toBeVisible();
  await openChatSettings(page);
  await selectChatSettingsSection(page, '이미지·삽화 참조');
  const references = page.getByTestId('illustration-references');
  const role = references.getByRole('combobox');
  await role.selectOption('character');
  await switchFromAnotherTab(page, 'en');
  await references.getByRole('button').click();
  const error = page.locator('.chat-settings-dialog').getByRole('alert');
  await expect(error).toHaveText('The server could not complete the operation. (503)');
  await switchFromAnotherTab(page, 'ja');
  await expect(error).toHaveText('サーバーの処理を完了できませんでした。(503)');
  await expect(role).toHaveValue('character');
  await page.screenshot({ path: info.outputPath('i18n-retained-action-error.png') });
  await switchFromAnotherTab(page, 'ko');
  await expect(error).toHaveText('서버 작업을 완료하지 못했어요. (503)');
  expect(writes).toBe(1);
});

test('I18N09 saving an author note keeps completion expiry and saved content across language changes', async ({
  page,
  request,
}) => {
  const { chat, detail } = await createReadingChat(request, '알림 수명 언어 전환 fixture', 1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clockStart = new Date('2026-01-02T03:04:05Z');
  await page.clock.install({ time: clockStart });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source')).toHaveCount(1);
  await openChatSettings(page);
  await selectChatSettingsSection(page, '프롬프트·모델·번역');
  const note = page.getByLabel('Risu 작가 노트', { exact: true });
  const value = '저장한 작가 노트 / author note 日本語 中文';
  await note.fill(value);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await page.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
  await expect
    .poll(
      async () =>
        ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail).profile
          ?.authorNote
    )
    .toBe(value);
  const notice = page.locator('.transient-notice');
  await expect(notice).toHaveText('채팅 설정을 저장했어요.');
  await page.clock.fastForward(3000);
  await switchFromAnotherTab(page, 'en');
  await expect(notice).toHaveText('Chat settings saved.');
  await switchFromAnotherTab(page, 'ja');
  await expect(notice).toHaveText('チャット設定を保存しました。');
  await page.clock.fastForward(1100);
  await expect(notice).toHaveCount(0);
  const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.profile?.authorNote).toBe(value);
  expect(after.sources).toEqual(detail.sources);
  expect(after.jobs).toEqual(detail.jobs);
  await expect(page.getByLabel('Risu作家ノート', { exact: true })).toHaveValue(value);
});

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
  try {
    await protocol.send('ServiceWorker.enable');
    await expect.poll(() => registrationId).not.toBe('');
    await protocol.send('ServiceWorker.stopAllWorkers');
    await protocol.send('ServiceWorker.deliverPushMessage', {
      origin: new URL(page.url()).origin,
      registrationId,
      data: JSON.stringify({ version: 1, kind: 'test', tag: 'i18n-restarted-worker' }),
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          return (await registration.getNotifications({ tag: 'i18n-restarted-worker' })).map(
            (entry) => ({ title: entry.title, body: entry.body })
          );
        })
      )
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
    await scene.getByRole('button', { name: '수정 취소', exact: true }).click();
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

test('I18N02 reader loading failure retry changes presentation and preserves identical saved data and draft', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, '언어 전환 보존 fixture', 3);
  await page.setViewportSize({ width: 1000, height: 600 });
  const before: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failed = true;
  await page.addInitScript((id) => {
    if (sessionStorage.getItem(`draft:${id}`) === null)
      sessionStorage.setItem(`draft:${id}`, '편집 중인 한국어 초안 / English / 日本語 / 中文');
    localStorage.setItem('uimori:reading-language', 'original');
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    });
  }, chat.id);
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    if (!failed) return route.continue();
    await gate;
    return route.fulfill({ status: 503, json: { error: 'Synthetic reader unavailable' } });
  });
  const mutations: string[] = [];
  page.on('request', (entry) => {
    if (
      entry.method() !== 'GET' &&
      /\/(runs|translation|settings|cancel)(?:\?|$)/u.test(new URL(entry.url()).pathname)
    )
      mutations.push(entry.url());
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.locator('.reader-awaiting')).toHaveAttribute('aria-busy', 'true');
    await expect(
      page.getByRole('status').filter({ hasText: '본문을 불러오는 중이에요…' })
    ).toBeVisible();
    await switchFromAnotherTab(page, 'en');
    await expect(
      page.getByRole('status').filter({ hasText: '본문을 불러오는 중이에요…' })
    ).toHaveCount(0);
    release();
    const alert = page.locator('.reader-awaiting [role="alert"]');
    await expect(alert).toBeVisible();
    const englishFailure = await alert.innerText();
    expect(englishFailure).not.toMatch(/[\uac00-\ud7a3]/u);
    expect(englishFailure).toContain('Could not load the text.');
    expect(englishFailure).not.toContain('\u001fui:');
    await switchFromAnotherTab(page, 'ja');
    await expect(alert).not.toHaveText(englishFailure);
    await expect(alert).toContainText('本文を読み込めませんでした。');
    failed = false;
    const retry = page
      .locator('.reader-awaiting')
      .getByRole('button', { name: '本文を再読み込み', exact: true });
    await expect(retry).toHaveAccessibleName('本文を再読み込み');
    await retry.click();
    await expect(page.getByTestId('source')).toHaveCount(3);
    const draft = page.locator('[data-uimori-part="composer-input"]');
    await expect(draft).toHaveValue('편집 중인 한국어 초안 / English / 日本語 / 中文');
    await draft.fill('지금 쓰는 초안은 언어 전환 중에도 보존돼요.');
    const handle = await draft.elementHandle();
    const scrollport = page.locator('[data-reader-scrollport]');
    await scrollport.evaluate((element) => {
      element.scrollTop = 120;
    });
    const position = await scrollport.evaluate((element) => element.scrollTop);
    expect(position).toBeGreaterThan(0);
    await switchFromAnotherTab(page, 'zh');
    expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(draft).toHaveValue('지금 쓰는 초안은 언어 전환 중에도 보존돼요.');
    expect(await scrollport.evaluate((element) => element.scrollTop)).toBe(position);
    await page.reload();
    await expect(draft).toHaveValue('지금 쓰는 초안은 언어 전환 중에도 보존돼요.');
    const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(after.sources).toEqual(before.sources);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.runs).toEqual(before.runs);
    expect(after.chat.settings).toEqual(before.chat.settings);
    expect(after.profile).toEqual(before.profile);
    expect(mutations).toEqual([]);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('I18N03 four mobile languages keep UI controls named and within the viewport', async ({
  page,
  request,
}, info) => {
  const { chat } = await createReadingChat(request, 'Mobile locale fixture', 1);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source')).toHaveCount(1);
  for (const [locale, composerName] of [
    ['en', 'Request next scene'],
    ['ja', '次のシーンを依頼'],
    ['zh', '请求下一个场景'],
    ['ko', '다음 장면 요청'],
  ]) {
    await switchFromAnotherTab(page, locale);
    const composer = page.locator('.composer:has([data-uimori-part="composer-input"])');
    await expect(composer.locator('textarea')).toHaveAccessibleName(composerName);
    const scene = page.getByTestId('source');
    const badge = scene.locator('.scene-badge');
    const toggle = scene.locator('.scene-header-tools');
    await expect(badge).toBeVisible();
    await expect(toggle).toBeVisible();
    await expect
      .poll(
        async () => {
          const [label, controls] = await Promise.all([badge.boundingBox(), toggle.boundingBox()]);
          if (!label || !controls) return false;
          return (
            label.x + label.width <= controls.x + 0.5 ||
            controls.x + controls.width <= label.x + 0.5 ||
            label.y + label.height <= controls.y + 0.5 ||
            controls.y + controls.height <= label.y + 0.5
          );
        },
        { message: `${locale}: manual-translation badge and view toggle must not overlap` }
      )
      .toBe(true);
    const badgeBounds = (await badge.boundingBox())!;
    expect(badgeBounds.x).toBeGreaterThanOrEqual(0);
    expect(badgeBounds.x + badgeBounds.width).toBeLessThanOrEqual(361);
    const renderedMessages = await page.evaluate(() =>
      [
        document.body.innerText,
        ...Array.from(document.querySelectorAll('[aria-label], [title], [placeholder]')).flatMap(
          (element) =>
            ['aria-label', 'title', 'placeholder'].map(
              (attribute) => element.getAttribute(attribute) ?? ''
            )
        ),
      ].join('\n')
    );
    expect(renderedMessages).not.toContain('\u001fui:');
    expect(renderedMessages).not.toContain('\\u001fui:');
    expect(renderedMessages).not.toMatch(/\b(?:reader|main|shared|common)\.[A-Za-z][\w.]*/u);
    const bounds = await composer.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      361
    );
    await page.screenshot({ path: info.outputPath(`i18n-mobile-${locale}.png`) });
  }
});

test('I18N04 changing UI language preserves an admitted run and its frozen model input', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, '진행 중 모델 입력 보존 fixture', 1);
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
  try {
    const before: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
    const admitted = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: '다음 장면의 요청 / original multilingual request 日本語 中文',
        expectedRevision: before.chat.headRevision,
        expectedSettingsRevision: before.chat.settingsRevision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const run = await admitted.json();
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.getByTestId('pending-run')).toBeVisible();
    const frozen: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
    const input = frozen.runs.find((item) => item.id === run.id)!;
    expect(input.request).toBe('다음 장면의 요청 / original multilingual request 日本語 中文');
    expect(input.snapshot.history.length).toBeGreaterThan(0);
    for (const locale of ['en', 'ja', 'zh', 'ko']) {
      await switchFromAnotherTab(page, locale);
      await expect(page.getByTestId('pending-run')).toBeVisible();
      const current: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
      const ongoing = current.runs.find((item) => item.id === run.id)!;
      expect(ongoing.snapshot).toEqual(input.snapshot);
      expect(ongoing.request).toBe(input.request);
      expect(['queued', 'running']).toContain(ongoing.status);
      expect(current.sources).toEqual(frozen.sources);
      expect(current.jobs).toEqual(frozen.jobs);
    }
  } finally {
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
  }
});

test('I18N05 long pseudo translation exercises real message rendering and mobile settings layout', async ({
  page,
}, info) => {
  const expanded = '［Īñţēŕƒåçē ļåñĝūåĝē · Long presentation label for narrow screens］'.repeat(3);
  let replacements = 0;
  await page.route('**/assets/*.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    if (!source.includes('Interface language')) return route.fulfill({ response });
    replacements++;
    await route.fulfill({ response, body: source.replaceAll('Interface language', expanded) });
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '일반');
  const selector = page.locator('.ui-language-setting select');
  await selector.selectOption('en');
  expect(replacements).toBeGreaterThan(0);
  await expect(selector).toHaveAccessibleName(expanded);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(361);
  const bounds = (await selector.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(361);
  await page.screenshot({ path: info.outputPath('i18n-expanded-mobile-settings.png') });
});

test('I18N06 manifest follows UI language while saved reading language stays independent', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => localStorage.setItem('uimori:reading-language', 'original'));
  await page.goto('/');
  for (const locale of ['en', 'ja', 'zh', 'ko']) {
    await switchFromAnotherTab(page, locale);
    const manifest = page.locator('link[rel="manifest"]');
    await expect(manifest).toHaveAttribute(
      'href',
      locale === 'ko' ? '/manifest.webmanifest' : `/manifest.${locale}.webmanifest`
    );
    const value = await (await request.get((await manifest.getAttribute('href'))!)).json();
    expect(value.lang).toMatch(new RegExp(`^${locale}(?:-|$)`));
    expect(value).toMatchObject({ display: 'standalone', start_url: '/', id: '/' });
    expect(await page.evaluate(() => localStorage.getItem('uimori:reading-language'))).toBe(
      'original'
    );
  }
});

test('I18N10 saved conflict reviews re-render field statuses and React content from one snapshot without changing drafts', async ({
  page,
  request,
}) => {
  const { nativePrompt } = await import('./fixtures/native-prompt.js');
  const before = await (await request.get('/api/model-workspace')).json();
  const workspaceBody = (value: typeof before, maxRetries: number) => ({
    expectedRevision: value.revision,
    routes: value.routes,
    mainJudgmentEnabled: value.mainJudgmentEnabled,
    mainJudgmentThreshold: value.mainJudgmentThreshold,
    titleModel: value.titleModel,
    helperModel: value.helperModel,
    contextModel: value.contextModel,
    scriptModel: value.scriptModel,
    translationPolicy: { ...value.translationPolicy, maxRetries },
  });
  try {
    await test.step('field labels and saved On/Off status follow locale without another read', async () => {
      await page.goto('/');
      await navigationAction(page, '설정');
      await selectSettingsSection(page, '역할별 모델');
      const editor = page.getByRole('region', { name: '역할별 모델 설정', exact: true });
      await editor
        .locator('summary')
        .filter({ hasText: /^작업 동작/ })
        .click();
      const retries = editor.getByLabel('번역 자동 재요청 횟수', { exact: true });
      const local = before.translationPolicy.maxRetries === 1 ? 2 : 1;
      const saved = before.translationPolicy.maxRetries === 3 ? 2 : 3;
      await retries.fill(String(local));
      const field = await retries.elementHandle();
      const updated = await request.put('/api/model-workspace', {
        data: workspaceBody(before, saved),
      });
      expect(updated.ok(), await updated.text()).toBe(true);
      await editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
      await switchFromAnotherTab(page, 'en');
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toHaveAccessibleName('Review saved role model settings');
      let reads = 0;
      page.on('request', (entry) => {
        if (entry.method() === 'GET' && new URL(entry.url()).pathname === '/api/model-workspace')
          reads++;
      });
      await dialog.getByRole('button', { name: 'Review saved version', exact: true }).click();
      const review = dialog.locator('.saved-version-review');
      await expect(
        review.locator('.settings-row').filter({ hasText: 'Translation automatic retry count' })
      ).toContainText(String(saved));
      await expect(
        review.locator('.settings-row').filter({ hasText: 'Response review' })
      ).toContainText(before.mainJudgmentEnabled ? 'On' : 'Off');
      expect(reads).toBe(1);
      await switchFromAnotherTab(page, 'ja');
      await expect(review).toHaveAccessibleName('現在の保存済み内容');
      await expect(
        review.locator('.settings-row').filter({ hasText: '翻訳の自動再リクエスト回数' })
      ).toContainText(String(saved));
      await expect(
        review.locator('.settings-row').filter({ hasText: '応答の再検討' })
      ).toContainText(before.mainJudgmentEnabled ? 'オン' : 'オフ');
      await expect(review).not.toContainText('Response review');
      expect(reads).toBe(1);
      await switchFromAnotherTab(page, 'zh');
      await expect(review).toHaveAccessibleName('当前已保存版本');
      await expect(dialog.getByRole('button', { name: '保留当前输入', exact: true })).toBeVisible();
      await switchFromAnotherTab(page, 'ja');
      await dialog.getByRole('button', { name: '現在の入力を保持', exact: true }).click();
      expect(await field!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await field!.evaluate((element: HTMLInputElement) => element.value)).toBe(
        String(local)
      );
    });

    await test.step('saved React content re-renders while authored text and editor draft stay literal', async () => {
      const view = await page.context().newPage();
      const title = `Saved review locale ${crypto.randomUUID()}`;
      const created = await request.post('/api/prompt-presets', {
        data: {
          title,
          role: 'main',
          program: nativePrompt('Original saved instructions'),
          values: {},
        },
      });
      expect(created.ok(), await created.text()).toBe(true);
      const preset = await created.json();
      await switchFromAnotherTab(page, 'ko');
      await view.goto('/');
      await navigationAction(view, '프롬프트');
      await view.getByLabel('프롬프트 검색', { exact: true }).fill(title);
      await view.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
      const editor = view.getByTestId('prompt-editor');
      const body = editor.getByLabel('1번 프롬프트 본문', { exact: true });
      const draft = 'Keep my unsaved instructions / 保存する前の下書き';
      await body.fill(draft);
      const field = await body.elementHandle();
      const changed = await request.post('/api/resources/save', {
        data: {
          kind: 'prompt-preset',
          id: preset.id,
          expectedRevision: preset.revision,
          model: {
            title,
            role: 'main',
            program: nativePrompt('Changed elsewhere / 保存済み本文'),
            values: {},
          },
        },
      });
      expect(changed.ok(), await changed.text()).toBe(true);
      await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
      await switchFromAnotherTab(view, 'en');
      const dialog = view.getByRole('alertdialog');
      await expect(dialog).toHaveAccessibleName('Review changed saved version');
      let reads = 0;
      view.on('request', (entry) => {
        if (
          entry.method() === 'GET' &&
          new URL(entry.url()).pathname === `/api/resources/prompt-preset/${preset.id}`
        )
          reads++;
      });
      await dialog.getByRole('button', { name: 'Review saved version', exact: true }).click();
      const review = dialog.locator('.saved-version-review');
      await expect(review).toContainText('Changed elsewhere / 保存済み本文');
      await expect(review).toContainText('Copy your input first if you want to keep it.');
      await expect(review).toContainText('Review the title and main text.');
      expect(reads).toBe(1);
      await switchFromAnotherTab(view, 'ja');
      await expect(review).toContainText('入力を残すには先にコピーしてください。');
      await expect(review).toContainText('タイトルと主な本文を確認できます。');
      await expect(review).toContainText('Changed elsewhere / 保存済み本文');
      await expect(review).not.toContainText('Copy your input first');
      await expect(review).not.toContainText(draft);
      expect(reads).toBe(1);
      await dialog.getByRole('button', { name: '現在の入力を保持', exact: true }).click();
      expect(await field!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await field!.evaluate((element: HTMLTextAreaElement) => element.value)).toBe(draft);
      const persisted = await (await request.get(`/api/prompt-presets/${preset.id}`)).json();
      expect(JSON.stringify(persisted.program)).toContain('Changed elsewhere / 保存済み本文');
      expect(JSON.stringify(persisted.program)).not.toContain(draft);
      await view.close();
    });
  } finally {
    const latest = await (await request.get('/api/model-workspace')).json();
    const restored = await request.put('/api/model-workspace', {
      data: {
        ...workspaceBody(before, before.translationPolicy.maxRetries),
        expectedRevision: latest.revision,
      },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
  }
});
