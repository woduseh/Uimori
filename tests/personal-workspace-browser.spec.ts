import { legacyChatBackupWithBot } from './fixtures/legacy-backup.js';
import { expect, test, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import { navigationAction, selectSettingsSection, discardEdits } from './ui-navigation.js';

async function createBot(request: APIRequestContext, title: string): Promise<Content> {
  const pkg = nativeContent({ name: title, description: 'Synthetic story source.' });
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: '',
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function openEditor(page: Page, title: string) {
  await page.goto('/');
  await navigationAction(page, '서재');
  await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(title);
  await page.getByRole('button', { name: `${title} 편집`, exact: true }).click();
  await expect(page.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toBeVisible();
}
async function save(page: Page): Promise<Content> {
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/resources/save') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  return (await result.json()).saved;
}

test('PERSONAL chat backup rejects malformed previews then imports independent continuing copies', async ({
  page,
  request,
}) => {
  const bot = await createBot(request, `Backup ${randomUUID()}`);
  const created = await request.post('/api/chats/import-transcript', {
    data: {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: `Story ${randomUUID()}`,
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: [{ request: 'Write', text: 'Preserved source.', translation: '보존된 번역' }],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const original = (await created.json()).chat;
  const retired = await request.get(`/api/chats/${original.id}/backup`);
  expect(retired.status()).toBe(404);
  const backup = Buffer.from(
    JSON.stringify(
      legacyChatBackupWithBot(bot, original.settings, {
        title: original.title,
        text: 'Preserved source.',
        translation: '보존된 번역',
      })
    )
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '설정');
  await page.getByRole('tab', { name: '데이터 관리', exact: true }).click();
  const input = page.getByLabel('백업 파일 선택', { exact: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const invalid of [
    { chats: [{}] },
    { chats: [null] },
    { chats: [{ transcript: { entries: { length: 1 } } }] },
    { title: { invalid: true }, chats: [{ transcript: { entries: [] } }] },
  ]) {
    await input.setInputFiles({
      name: 'invalid-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'uimori-personal-chat',
          version: 1,
          title: 'Malformed',
          resources: {},
          ...invalid,
        })
      ),
    });
    await expect(page.getByRole('alert')).toContainText(
      '채팅 백업의 제목 또는 본문 목록이 올바르지 않아요.'
    );
    await expect(
      page.getByRole('button', { name: '새 채팅으로 가져오기', exact: true })
    ).toBeHidden();
    await expect(input).toBeEnabled();
  }
  expect(errors).toEqual([]);
  await input.setInputFiles({ name: 'story.json', mimeType: 'application/json', buffer: backup });
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/chats/import-backup') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '새 채팅으로 가져오기', exact: true }).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  const imported = (await result.json()).chat;
  expect(imported.id).not.toBe(original.id);
  const detail = await (await request.get(`/api/chats/${imported.id}`)).json();
  expect(detail.sources[0].text).toBe('Preserved source.');
  expect(detail.profile.packageAttachments[0].id).not.toBe(bot.id);
  expect(errors).toEqual([]);
});

test('PERSONAL saving one tab preserves another tab recovery through reload', async ({
  page,
  context,
  request,
}) => {
  const original = await createBot(request, `Shared recovery ${randomUUID()}`);
  const other = await context.newPage();
  const recoveredTitle = `Latest unsaved ${randomUUID()}`;
  const savedTitle = `Earlier saved ${randomUUID()}`;
  async function storedTitle() {
    return page.evaluate(async (key) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('uimori-editor-recovery', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<string | undefined>((resolve, reject) => {
          const request = db.transaction('buffers').objectStore('buffers').get(key);
          request.onsuccess = () => resolve(request.result?.model.title);
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    }, `content:${original.id}`);
  }
  try {
    await openEditor(page, original.title);
    await openEditor(other, original.title);
    await other.getByLabel(/^(봇|페르소나|모듈) 이름$/u).fill(savedTitle);
    await expect.poll(storedTitle).toBe(savedTitle);
    await page.getByLabel(/^(봇|페르소나|모듈) 이름$/u).fill(recoveredTitle);
    await expect.poll(storedTitle).toBe(recoveredTitle);
    await save(other);
    await expect(
      page.getByRole('alert').filter({
        hasText: '저장된 자료가 변경됐어요. 현재 입력은 유지돼요.',
      })
    ).toBeVisible();
    expect(await storedTitle()).toBe(recoveredTitle);
    await page.reload();
    if (!(await page.getByLabel(/^(봇|페르소나|모듈) 이름$/u).isVisible()))
      await openEditor(page, savedTitle);
    await expect(page.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toHaveValue(recoveredTitle);
    await discardEdits(page);
    await expect(page.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toHaveValue(savedTitle);
    await expect.poll(storedTitle).toBeUndefined();
  } finally {
    await other.close();
  }
});

test('PERSONAL binary resource backup downloads and imports through the archive UI', async ({
  page,
  request,
}) => {
  const title = `Binary archive ${randomUUID()}`;
  await createBot(request, title);
  await openEditor(page, title);
  await page.getByLabel('자료 메뉴', { exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '자료 백업', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/\.uimori$/);
  const path = await file.path();
  expect(path).toBeTruthy();
  await page.getByRole('button', { name: '서재 목록', exact: true }).click();
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '데이터 관리');
  await page.getByLabel('백업 파일 선택', { exact: true }).setInputFiles({
    name: 'resource.uimori',
    mimeType: 'application/zip',
    buffer: await (await import('node:fs/promises')).readFile(path!),
  });
  await expect(
    page.getByText('자료 백업: 자료 1개, 프리셋 0개, 이미지 0개', { exact: true })
  ).toBeVisible();
  const applied = page.waitForResponse((response) =>
    response.url().endsWith('/api/native-transfers/apply-archive')
  );
  await page.getByRole('button', { name: '새 자료로 가져오기', exact: true }).click();
  const response = await applied;
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  const content = await (
    await request.get(
      `/api/content/${result.items.find((item: { root: boolean }) => item.root).id}`
    )
  ).json();
  expect(content.title).toBe(title);
  expect(content.package.nativeRisu.card.description).toBe('Synthetic story source.');
});
